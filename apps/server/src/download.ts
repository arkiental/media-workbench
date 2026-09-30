import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { DownloadRequest, ExecutionContext, Policy, ToolPaths } from '../../../packages/contracts/src/index.ts';
import { runProcess } from '../../../packages/media/src/process.ts';
import { createEgressProxy, validateDestination } from './network.ts';
export type DownloadContext = ExecutionContext & { policy:Policy; testOrigin?:string; cookieFile?:string; browserCookie?:{browser:string;profile?:string} };
const INSPECTION_LIMIT=100;
function args(tools:ToolPaths,proxy:string,ctx:DownloadContext,selection='1'){return ['--ignore-config','--no-plugin-dirs','--no-playlist','--playlist-items',selection,'--lazy-playlist','--no-warnings','--no-check-formats','--no-call-home','--no-progress','--no-remote-components','--proxy',proxy,'--socket-timeout','20','--retries','2','--fragment-retries','2','--restrict-filenames','--no-cache-dir','--js-runtimes',`node:${tools.node||process.execPath}`,'--ffmpeg-location',path.dirname(tools.ffmpeg),...(ctx.cookieFile?['--cookies',ctx.cookieFile]:[]),...(ctx.browserCookie?['--cookies-from-browser',ctx.browserCookie.browser+(ctx.browserCookie.profile?':'+ctx.browserCookie.profile:'')]:[])];}
async function metadata(request:DownloadRequest,tools:ToolPaths,ctx:DownloadContext,proxy:string,selection:string){
 const result=await runProcess(tools.ytdlp,[...args(tools,proxy,ctx,selection),'--dump-single-json','--skip-download','--',request.url],ctx,{maxStdoutBytes:8*1024*1024});
 return JSON.parse(result.stdout.toString());
}
export async function inspectDownload(request:DownloadRequest,tools:ToolPaths,ctx:DownloadContext){
 await validateDestination(request.url,ctx.policy.allowedSites,ctx.testOrigin);
 const proxy=await createEgressProxy(Math.min(ctx.policy.maxInputBytes,ctx.policy.maxTransferBytes,10000000),ctx.signal,ctx.testOrigin,ctx.policy.bandwidthBytesPerSecond);
 try{
  const data=await metadata(request,tools,ctx,proxy.url,`1:${INSPECTION_LIMIT}`);const entries=(Array.isArray(data.entries)?data.entries:[data]).filter(Boolean);
  return {title:String(data.title||'Media').slice(0,300),duration:data.duration??null,authentication:'unknown',playlistLimited:true,collection:Array.isArray(data.entries),inspectionLimit:INSPECTION_LIMIT,limitReached:entries.length>=INSPECTION_LIMIT,entries:entries.slice(0,INSPECTION_LIMIT).map((e:any,i:number)=>({
   itemIndex:Number.isInteger(e.playlist_index)&&e.playlist_index>=1&&e.playlist_index<=INSPECTION_LIMIT?e.playlist_index:i+1,id:String(e.id||''),title:String(e.title||'').slice(0,300),duration:e.duration??null,
   formats:(e.formats||[]).slice(0,300).map((f:any)=>({id:String(f.format_id),ext:f.ext,width:f.width,height:f.height,vcodec:f.vcodec,acodec:f.acodec,bytes:f.filesize||f.filesize_approx||null}))
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
  ctx.onStage?.('downloading');
  await runProcess(tools.ytdlp,[...args(tools,proxy.url,ctx,String(itemIndex)),'--max-filesize',String(ctx.policy.maxInputBytes),'--downloader','native','--hls-prefer-native','--merge-output-format','mkv','-f',format,'-o',path.join(ctx.workDir,'download.%(ext)s'),'--',request.url],ctx);
  if(proxy.violation)throw Error(proxy.violation);
  const files=(await readdir(ctx.workDir)).filter(f=>/^download\.[a-zA-Z0-9]{1,8}$/.test(f));if(files.length!==1)throw Error('Downloader did not produce a single complete media file; inspect formats or authentication');
  const result=path.join(ctx.workDir,files[0]);if((await stat(result)).size>ctx.policy.maxInputBytes)throw Error('Downloaded file exceeds policy');return {path:result,name:files[0]};
 }catch(e){throw Error(redactError(e));}finally{proxy.close();}
}
export function redactError(error:unknown){const message=String(error instanceof Error?error.message:error);const status=/^Native tool failed \((-?\d+|null)\):\s*/.exec(message)?.[0]||'';return status+message.slice(status.length).replace(/https?:\/\/[^\s"']+/gi,'[redacted URL]').replace(/(?:[A-Za-z]:\\|\/home\/|\/tmp\/)[^\r\n"']+/g,'[local path]').replace(/(cookie|authorization|token|password)[^\r\n]*/gi,'[credential detail redacted]').slice(-(1800-status.length));}
