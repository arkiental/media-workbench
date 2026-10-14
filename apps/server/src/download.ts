import path from 'node:path';
import { readdir, readFile, rm, stat, rename } from 'node:fs/promises';
import type { DownloadRequest, ExecutionContext, Policy, ToolPaths } from '../../../packages/contracts/src/index.ts';
import { runProcess } from '../../../packages/media/src/process.ts';
import { createEgressProxy, validateDestination } from './network.ts';
export type DownloadContext = ExecutionContext & { policy:Policy; testOrigin?:string; cookieFile?:string; browserCookie?:{browser:string;profile?:string} };
const INSPECTION_LIMIT=100;
const LOCAL_INPUT=['-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,h264,hevc,av1,mp3,aac,flac,wav,ogg,asf,flv,image2,png_pipe,jpeg_pipe,gif'];
function args(tools:ToolPaths,proxy:string,ctx:DownloadContext,selection='1'){return ['--ignore-config','--no-plugin-dirs','--no-playlist','--playlist-items',selection,'--lazy-playlist','--no-check-formats','--no-progress','--no-remote-components','--proxy',proxy,'--socket-timeout','20','--retries','2','--fragment-retries','2','--restrict-filenames','--no-cache-dir','--js-runtimes',`node:${tools.node||process.execPath}`,...(tools.ffmpeg===path.basename(tools.ffmpeg)?[]:['--ffmpeg-location',path.resolve(tools.ffmpeg)]),...(ctx.cookieFile?['--cookies',ctx.cookieFile]:[]),...(ctx.browserCookie?['--cookies-from-browser',ctx.browserCookie.browser+(ctx.browserCookie.profile?':'+ctx.browserCookie.profile:'')]:[])];}
async function metadata(request:DownloadRequest,tools:ToolPaths,ctx:DownloadContext,proxy:string,selection:string,thumbnail=false){
 const result=await runProcess(tools.ytdlp,[...args(tools,proxy,ctx,selection),'--dump-single-json','--skip-download',...(thumbnail?['--no-simulate','--write-thumbnail','-o',path.join(ctx.workDir,'thumb.%(ext)s')]:[]),'--',request.url],ctx,{maxStdoutBytes:8*1024*1024});
 if(ctx.signal.aborted)throw Error('Operation cancelled');
 let data:unknown;
 try{data=JSON.parse(result.stdout.toString());}catch{throw Error('The downloader returned incomplete media details. Inspect the link again.');}
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('The downloader returned invalid media metadata. Inspect the link again.');
 if('entries' in data&&!Array.isArray(data.entries))throw Error('The downloader returned invalid media metadata. Inspect the link again.');
 return data as Record<string,any>;
}
const THUMBNAIL_LIMIT=1500000,thumbnailTypes:Record<string,string>={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
// Read the thumbnail from the same extraction, keeping the page's img-src local-only.
async function readThumbnail(ctx:DownloadContext){
 try{
  const file=(await readdir(ctx.workDir)).find(name=>name.startsWith('thumb.')&&thumbnailTypes[path.extname(name).toLowerCase()]);
  if(!file)return undefined;const full=path.join(ctx.workDir,file);if((await stat(full)).size>THUMBNAIL_LIMIT)return undefined;
  return `data:${thumbnailTypes[path.extname(file).toLowerCase()]};base64,${(await readFile(full)).toString('base64')}`;
 }catch{if(ctx.signal.aborted)throw Error('Operation cancelled');return undefined;}
}
export async function inspectDownload(request:DownloadRequest,tools:ToolPaths,ctx:DownloadContext){
 await validateDestination(request.url,ctx.policy.allowedSites,ctx.testOrigin,ctx.signal);
 const proxy=await createEgressProxy(Math.min(ctx.policy.maxInputBytes,ctx.policy.maxTransferBytes,10000000),ctx.signal,ctx.testOrigin,ctx.policy.bandwidthBytesPerSecond);
 try{
  const data=await metadata(request,tools,ctx,proxy.url,`1:${INSPECTION_LIMIT}`,true);const entries=(Array.isArray(data.entries)?data.entries:[data]).filter((entry:unknown)=>entry&&typeof entry==='object'&&!Array.isArray(entry));
  if(!entries.length)throw Error('No downloadable media was found. Check that the link points to a supported video or audio file.');
  const thumbnail=await readThumbnail(ctx);
  if(ctx.signal.aborted)throw Error('Operation cancelled');
  if(proxy.violation)throw Error(proxy.violation);
  const text=(value:unknown,max:number)=>typeof value==='string'&&value?value.slice(0,max):undefined;
  const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined;
  const identifier=(value:unknown)=>text(value,200)||(typeof value==='number'&&Number.isFinite(value)?String(value):'');
  return {title:text(data.title,300)||'Media',duration:number(data.duration)??null,uploader:text(data.uploader||data.channel,200),viewCount:number(data.view_count),uploadDate:/^\d{8}$/.test(String(data.upload_date))?String(data.upload_date):undefined,description:text(data.description,400),site:text(data.extractor_key||data.extractor,60),thumbnail,authentication:'unknown',playlistLimited:true,collection:Array.isArray(data.entries),inspectionLimit:INSPECTION_LIMIT,limitReached:entries.length>=INSPECTION_LIMIT,entries:entries.slice(0,INSPECTION_LIMIT).map((e:any,i:number)=>({
   itemIndex:Number.isInteger(e.playlist_index)&&e.playlist_index>=1&&e.playlist_index<=INSPECTION_LIMIT?e.playlist_index:i+1,id:identifier(e.id),title:text(e.title,300)||'Media',duration:number(e.duration)??null,
   formats:(Array.isArray(e.formats)?e.formats:[]).filter((f:unknown)=>f&&typeof f==='object'&&!Array.isArray(f)).slice(0,300).map((f:any)=>({id:identifier(f.format_id??f.id),ext:text(f.ext,30),width:number(f.width),height:number(f.height),vcodec:text(f.vcodec,100),acodec:text(f.acodec,100),tbr:number(f.tbr),fps:number(f.fps),bytes:number(f.filesize)||number(f.filesize_approx)||null})).filter((f:{id:string})=>f.id)
  }))};
 }catch(e){throw Error(redactError(ctx.signal.aborted?'Operation cancelled':proxy.violation||e));}finally{proxy.close();}
}
export async function downloadMedia(request:DownloadRequest,tools:ToolPaths,ctx:DownloadContext){
 await validateDestination(request.url,ctx.policy.allowedSites,ctx.testOrigin,ctx.signal);
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
  // Prefer MP4 immediately. An unsupported stream may need an intermediate container
  // before the bounded conversion below; that intermediate is never published.
  let toolResult;
  try{toolResult=await download('mp4');}catch(error){
   if(!/Postprocessing|Conversion failed/i.test(String(error))||ctx.signal.aborted||proxy.violation)throw error;
   for(const name of await readdir(ctx.workDir))if(/^download..*temp./.test(name))await rm(path.join(ctx.workDir,name),{force:true});
   await rm(path.join(ctx.workDir,'download.mp4'),{force:true});
   ctx.onProgress?.(lastProgress,'Preparing streams for MP4 conversion');toolResult=await download('mkv');
  }
  if(ctx.signal.aborted)throw Error('Operation cancelled');
  if(proxy.violation)throw Error(proxy.violation);
  const files=(await readdir(ctx.workDir)).filter(f=>/^download\.[a-zA-Z0-9]{1,8}$/.test(f));if(files.length!==1){
   const diagnostics=(toolResult.stderr+'\n'+toolResult.stdout.toString()).split(/\r?\n/).filter(line=>line.trim()&&!line.startsWith('MW_')).slice(-8).join('\n');
   if(/larger than|bigger than|max.file.?size|size.*limit/i.test(diagnostics))throw Error('Download was skipped because the selected media exceeds the file size limit. Choose a smaller format.');
   throw Error('Downloader did not produce a single complete media file.'+(diagnostics?' '+redactError(diagnostics):' Inspect the selected format and try again.'));
  }
  let result=path.join(ctx.workDir,files[0]);let size=(await stat(result)).size;if(!size)throw Error('Downloaded file is empty. Inspect the link and try again.');if(size>ctx.policy.maxInputBytes)throw Error('Downloaded file exceeds policy');
  if(request.preference!=='audio'&&path.extname(result).toLowerCase()!=='.mp4'){
   const probe=await runProcess(tools.ffprobe,['-v','error',...LOCAL_INPUT,'-show_entries','stream=codec_type','-of','json',result],ctx,{maxStdoutBytes:1024*1024});
   if(JSON.parse(probe.stdout.toString()).streams?.some((stream:{codec_type:string})=>stream.codec_type==='video')){
    ctx.onStage?.('processing');ctx.onProgress?.(lastProgress,'Converting download to MP4');
    const output=path.join(ctx.workDir,'converted.mp4'),limit=Math.min(ctx.policy.maxInputBytes,ctx.maxBytes??ctx.policy.maxInputBytes),threads=String(Math.max(1,Math.floor(ctx.maxCpuCores??2)));
    const convert=(codecs:string[])=>runProcess(tools.ffmpeg,['-hide_banner','-nostdin','-v','error',...LOCAL_INPUT,'-i',result,'-map','0:v:0','-map','0:a?','-sn','-dn',...codecs,'-threads',threads,'-fs',String(limit+1),'-movflags','+faststart','-n',output],ctx,{outputPath:output});
    try{await convert(['-c','copy']);}catch(error){
     if(ctx.signal.aborted||!/not supported|could not find tag|not currently supported|unsupported codec|incorrect codec|invalid argument/i.test(String(error)))throw error;
     await rm(output,{force:true});ctx.onProgress?.(lastProgress,'Encoding a compatible MP4');await convert(['-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k']);
    }
    size=(await stat(output)).size;if(!size||size>limit)throw Error('Converted MP4 is empty or exceeds the file size limit');
    const original=result;result=path.join(ctx.workDir,'download.mp4');await rename(output,result);await rm(original,{force:true});
   }
  }
  return {path:result,name:path.basename(result)};
 }catch(e){throw Error(redactError(ctx.signal.aborted?'Operation cancelled':proxy.violation||e));}finally{proxy.close();}
}
export function redactError(error:unknown){const message=String(error instanceof Error?error.message:error);const status=/^Native tool failed \((-?\d+|null)\):\s*/.exec(message)?.[0]||'';return status+message.slice(status.length).replace(/https?:\/\/[^\s"']+/gi,'[redacted URL]').replace(/(?:[A-Za-z]:\\|\/home\/|\/tmp\/)[^\r\n"']+/g,'[local path]').replace(/(cookie|authorization|token|password)[^\r\n]*/gi,'[credential detail redacted]').slice(-(1800-status.length));}
