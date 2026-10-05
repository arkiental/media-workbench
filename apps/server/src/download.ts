import path from 'node:path';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import type { DownloadRequest, ExecutionContext, Policy, ToolPaths } from '../../../packages/contracts/src/index.ts';
import { runProcess } from '../../../packages/media/src/process.ts';
import { createEgressProxy, validateDestination } from './network.ts';
export type DownloadContext = ExecutionContext & { policy:Policy; testOrigin?:string; cookieFile?:string; browserCookie?:{browser:string;profile?:string} };
const INSPECTION_LIMIT=100;
function args(tools:ToolPaths,proxy:string,ctx:DownloadContext,selection='1'){return ['--ignore-config','--no-plugin-dirs','--no-playlist','--playlist-items',selection,'--lazy-playlist','--no-check-formats','--no-progress','--no-remote-components','--proxy',proxy,'--socket-timeout','20','--retries','2','--fragment-retries','2','--restrict-filenames','--no-cache-dir','--js-runtimes',`node:${tools.node||process.execPath}`,...(tools.ffmpeg===path.basename(tools.ffmpeg)?[]:['--ffmpeg-location',path.resolve(tools.ffmpeg)]),...(ctx.cookieFile?['--cookies',ctx.cookieFile]:[]),...(ctx.browserCookie?['--cookies-from-browser',ctx.browserCookie.browser+(ctx.browserCookie.profile?':'+ctx.browserCookie.profile:'')]:[])];}
async function metadata(request:DownloadRequest,tools:ToolPaths,ctx:DownloadContext,proxy:string,selection:string){
 const result=await runProcess(tools.ytdlp,[...args(tools,proxy,ctx,selection),'--dump-single-json','--skip-download','--',request.url],ctx,{maxStdoutBytes:8*1024*1024});
 return JSON.parse(result.stdout.toString());
}
const THUMBNAIL_LIMIT=1500000,thumbnailTypes:Record<string,string>={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
// Best effort: fetched by yt-dlp through the same egress proxy, then inlined so the page's img-src policy stays local-only.
async function fetchThumbnail(request:DownloadRequest,tools:ToolPaths,ctx:DownloadContext,proxy:string){
 try{
  await runProcess(tools.ytdlp,[...args(tools,proxy,ctx),'--skip-download','--write-thumbnail','-o',path.join(ctx.workDir,'thumb.%(ext)s'),'--',request.url],ctx,{maxStdoutBytes:1024*1024});
  const file=(await readdir(ctx.workDir)).find(name=>name.startsWith('thumb.')&&thumbnailTypes[path.extname(name).toLowerCase()]);
  if(!file)return undefined;const full=path.join(ctx.workDir,file);if((await stat(full)).size>THUMBNAIL_LIMIT)return undefined;
  return `data:${thumbnailTypes[path.extname(file).toLowerCase()]};base64,${(await readFile(full)).toString('base64')}`;
 }catch{return undefined;}
}
export async function inspectDownload(request:DownloadRequest,tools:ToolPaths,ctx:DownloadContext){
 await validateDestination(request.url,ctx.policy.allowedSites,ctx.testOrigin);
 const proxy=await createEgressProxy(Math.min(ctx.policy.maxInputBytes,ctx.policy.maxTransferBytes,10000000),ctx.signal,ctx.testOrigin,ctx.policy.bandwidthBytesPerSecond);
 try{
  const data=await metadata(request,tools,ctx,proxy.url,`1:${INSPECTION_LIMIT}`);const entries=(Array.isArray(data.entries)?data.entries:[data]).filter(Boolean);
  const thumbnail=await fetchThumbnail(request,tools,ctx,proxy.url);
  const text=(value:unknown,max:number)=>typeof value==='string'&&value?value.slice(0,max):undefined;
  return {title:String(data.title||'Media').slice(0,300),duration:data.duration??null,uploader:text(data.uploader||data.channel,200),viewCount:Number.isFinite(data.view_count)?data.view_count:undefined,uploadDate:/^\d{8}$/.test(String(data.upload_date))?String(data.upload_date):undefined,description:text(data.description,400),site:text(data.extractor_key||data.extractor,60),thumbnail,authentication:'unknown',playlistLimited:true,collection:Array.isArray(data.entries),inspectionLimit:INSPECTION_LIMIT,limitReached:entries.length>=INSPECTION_LIMIT,entries:entries.slice(0,INSPECTION_LIMIT).map((e:any,i:number)=>({
   itemIndex:Number.isInteger(e.playlist_index)&&e.playlist_index>=1&&e.playlist_index<=INSPECTION_LIMIT?e.playlist_index:i+1,id:String(e.id||''),title:String(e.title||'').slice(0,300),duration:e.duration??null,
   formats:(e.formats||[]).slice(0,300).map((f:any)=>({id:String(f.format_id),ext:f.ext,width:f.width,height:f.height,vcodec:f.vcodec,acodec:f.acodec,tbr:f.tbr,fps:f.fps,bytes:f.filesize||f.filesize_approx||null}))
  }))};
 }catch(e){throw Error(redactError(e));}finally{proxy.close();}
}
export async function downloadMedia(request:DownloadRequest,tools:ToolPaths,ctx:DownloadContext){
 await validateDestination(request.url,ctx.policy.allowedSites,ctx.testOrigin);
 const proxy=await createEgressProxy(Math.min(ctx.policy.maxInputBytes+2000000,ctx.policy.maxTransferBytes),ctx.signal,ctx.testOrigin,ctx.policy.bandwidthBytesPerSecond);
 const format=request.format||(request.preference==='audio'?'bestaudio/best':request.preference==='compatible'?'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best':'bestvideo+bestaudio/best');
 try{
  const itemIndex=request.itemIndex??1;
  if(!Number.isInteger(itemIndex)||itemIndex<1||itemIndex>INSPECTION_LIMIT)throw Error('Media item index must be between 1 and 100');
  // A direct-video URL ignores --playlist-items. Confirm a nondefault collection
  // selection exists before allowing it to download an unintended direct video.
  if(itemIndex>1){const data=await metadata(request,tools,ctx,proxy.url,String(itemIndex));if(!Array.isArray(data.entries)||data.entries.filter(Boolean).length!==1||data.entries[0].playlist_index!==itemIndex)throw Error('Selected media item is unavailable; inspect the post again');}
  ctx.onStage?.('downloading');ctx.onProgress?.(0,'Connecting and checking available media');
  const streams=new Map<string,{downloaded:number;total:number}>();let lastProgress=0;
  const onOutputLine=(line:string)=>{
   if(line.startsWith('MW_DOWNLOAD:')){
    const [id,downloadedText,totalText,estimateText,status]=line.slice('MW_DOWNLOAD:'.length).split('|');const downloaded=Number(downloadedText),known=Number(totalText),estimated=Number(estimateText),total=Number.isFinite(known)&&known>0?known:Number.isFinite(estimated)&&estimated>0?estimated:0;
    if(!id||!Number.isFinite(downloaded)||downloaded<0||!['downloading','finished'].includes(status))return;
    streams.set(id,{downloaded,total:status==='finished'?downloaded:total});const received=[...streams.values()].reduce((sum,item)=>sum+item.downloaded,0),expected=[...streams.values()].reduce((sum,item)=>sum+item.total,0);
    lastProgress=expected>0?Math.min(.98,received/expected):0;
    ctx.onProgress?.(lastProgress,status==='finished'?'Download stream received; preparing the file':`Downloading: ${(received/1024**2).toFixed(1)} MB received${total?totalText==='NA'?' (estimated size)':'':''}`);
   }else if(line.startsWith('MW_POSTPROCESS:')){ctx.onStage?.('processing');ctx.onProgress?.(lastProgress,'Preparing the downloaded file');}
  };
  const download=(mergeFormat:string)=>runProcess(tools.ytdlp,[...args(tools,proxy.url,ctx,String(itemIndex)),'--progress','--newline','--progress-delta','0.25','--progress-template','download:MW_DOWNLOAD:%(info.format_id)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.status)s','--progress-template','postprocess:MW_POSTPROCESS:%(progress.status)s','--max-filesize',String(ctx.policy.maxInputBytes),'--concurrent-fragments','8','--downloader','native','--hls-prefer-native','--merge-output-format',mergeFormat,'-f',format,'-o',path.join(ctx.workDir,'download.%(ext)s'),'--',request.url],ctx,{onOutputLine});
  // Some streams (e.g. YouTube HLS video with timestamp-less packets) cannot be copied into Matroska but mux fine into MP4.
  // The downloaded parts stay in the work directory, so the retry only repeats the merge.
  let toolResult;
  try{toolResult=await download('mkv');}catch(error){
   if(!/Postprocessing|Conversion failed/i.test(String(error))||ctx.signal.aborted)throw error;
   for(const name of await readdir(ctx.workDir))if(/^download..*temp./.test(name))await rm(path.join(ctx.workDir,name),{force:true});
   ctx.onProgress?.(lastProgress,'Retrying the merge in a compatible container');toolResult=await download('mp4');
  }
  if(proxy.violation)throw Error(proxy.violation);
  const files=(await readdir(ctx.workDir)).filter(f=>/^download\.[a-zA-Z0-9]{1,8}$/.test(f));if(files.length!==1){
   const diagnostics=(toolResult.stderr+'\n'+toolResult.stdout.toString()).split(/\r?\n/).filter(line=>line.trim()&&!line.startsWith('MW_')).slice(-8).join('\n');
   if(/larger than|bigger than|max.file.?size|size.*limit/i.test(diagnostics))throw Error('Download was skipped because the selected media exceeds the file size limit. Choose a smaller format.');
   throw Error('Downloader did not produce a single complete media file.'+(diagnostics?' '+redactError(diagnostics):' Inspect the selected format and try again.'));
  }
  const result=path.join(ctx.workDir,files[0]);if((await stat(result)).size>ctx.policy.maxInputBytes)throw Error('Downloaded file exceeds policy');return {path:result,name:files[0]};
 }catch(e){throw Error(redactError(e));}finally{proxy.close();}
}
export function redactError(error:unknown){const message=String(error instanceof Error?error.message:error);const status=/^Native tool failed \((-?\d+|null)\):\s*/.exec(message)?.[0]||'';return status+message.slice(status.length).replace(/https?:\/\/[^\s"']+/gi,'[redacted URL]').replace(/(?:[A-Za-z]:\\|\/home\/|\/tmp\/)[^\r\n"']+/g,'[local path]').replace(/(cookie|authorization|token|password)[^\r\n]*/gi,'[credential detail redacted]').slice(-(1800-status.length));}
