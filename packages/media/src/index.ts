import { access, stat, mkdir, writeFile, readFile, unlink, link, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, join, extname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import type { ToolPaths, ExecutionContext, MediaInfo, EncoderCapability, Recipe, ExportOptions, Plan } from '../../contracts/src/index.ts';
import { RecipeSchema, ExportSchema } from '../../contracts/src/index.ts';
import { runProcess } from './process.ts';
import { captionLayout } from '../../contracts/src/caption.ts';
export { runProcess } from './process.ts';

const INPUT_POLICY=['-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,h264,hevc,av1,mp3,aac,flac,wav,ogg,asf,flv,image2,png_pipe,jpeg_pipe,gif'];
const BASE=['-hide_banner','-nostdin','-loglevel','error'];
const num=(x:unknown,fallback=0)=>Number.isFinite(Number(x))?Number(x):fallback;
const safePath=(path:string)=>resolve(path);
const exists=async(path:string)=>access(path).then(()=>true,()=>false);
export const mediaThreads=(ctx?:ExecutionContext)=>Math.max(1,Math.min(availableParallelism(),Math.floor(ctx?.maxCpuCores??availableParallelism())));
export async function findFont(family?:string):Promise<string>{
  if(family==='Playfair Display'){
    for(const file of [resolve('dist/web/fonts/PlayfairDisplay-Bold.ttf'),resolve('apps/web/assets/fonts/PlayfairDisplay-Bold.ttf')])if(await exists(file))return file;
    throw new Error('The bundled Playfair Display font is missing. Rebuild the application.');
  }
  const candidates=[...(process.env.MW_FONT?[resolve(process.env.MW_FONT)]:[]),...(process.platform==='win32'?[join(process.env.WINDIR??'C:\\Windows','Fonts','arial.ttf')]:['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'])];for(const file of candidates)if(await exists(file))return file;throw new Error('Text rendering requires Arial or DejaVu Sans installed on the service host, or an explicit MW_FONT');
}
export async function discoverTools():Promise<ToolPaths>{
  const locate=async(name:string,env:string)=>{if(process.env[env])return resolve(process.env[env]!);const local=resolve('.tools',name+(process.platform==='win32'?'.exe':''));if(await exists(local))return local;return name;};
  return {ffmpeg:await locate('ffmpeg','MW_FFMPEG'),ffprobe:await locate('ffprobe','MW_FFPROBE'),ytdlp:await locate('yt-dlp','MW_YTDLP'),node:process.execPath};
}
export async function toolVersions(tools:ToolPaths,ctx?:ExecutionContext):Promise<Record<string,string>>{
  const entries=await Promise.all(Object.entries(tools).map(async([name,path])=>{try{const r=await runProcess(path,[name==='ytdlp'||name==='node'?'--version':'-version'],ctx,{maxStdoutBytes:1024*1024});return [name,r.stdout.toString().split(/\r?\n/)[0]];}catch{return [name,'unavailable'];}}));return Object.fromEntries(entries);
}
export async function probe(path:string,tools:ToolPaths,ctx?:ExecutionContext):Promise<MediaInfo>{
  const data=JSON.parse((await runProcess(tools.ffprobe,['-v','error',...INPUT_POLICY,'-show_format','-show_streams','-of','json',safePath(path)],ctx)).stdout.toString());
  const file=await stat(path);const format=data.format??{};
  const streams=(data.streams??[]).map((s:any)=>({index:s.index,type:s.codec_type,codec:s.codec_name??'unknown',width:s.width,height:s.height,sampleRate:s.sample_rate?num(s.sample_rate):undefined,channels:s.channels,duration:s.duration?num(s.duration):undefined,startTime:s.start_time?num(s.start_time):undefined,timeBase:s.time_base,frameRate:s.avg_frame_rate,rotation:num(s.side_data_list?.find((x:any)=>x.rotation!==undefined)?.rotation??s.tags?.rotate),colorTransfer:s.color_transfer}));
  const startTime=num(format.start_time);let duration=num(format.duration);
  // Matroska's duration may include a positive timestamp offset; stream durations are durations.
  const streamDuration=Math.max(0,...streams.map((s:any)=>s.duration??0));
  if(streamDuration>0&&Math.abs(duration-(streamDuration+startTime))<.25)duration=streamDuration;
  else if(startTime>0&&String(format.format_name).includes('matroska'))duration=Math.max(0,duration-startTime);
  if(!streams.some((s:any)=>s.type==='video'||s.type==='audio')||duration<=0)throw new Error('Input has no playable finite-duration media');
  return {duration,startTime,size:file.size,format:format.format_name??'unknown',streams,hdr:streams.some((s:any)=>['smpte2084','arib-std-b67'].includes(s.colorTransfer))};
}
export async function probeImage(path:string,tools:ToolPaths,ctx?:ExecutionContext):Promise<{width:number;height:number}>{
  const data=JSON.parse((await runProcess(tools.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-f','png_pipe','-i',safePath(path),'-show_streams','-of','json'],ctx,{maxStdoutBytes:1024*1024})).stdout.toString());
  const streams=data.streams??[],image=streams[0];
  if(streams.length!==1||image?.codec_type!=='video'||image.codec_name!=='png'||!(image.width>0)||!(image.height>0))throw new Error('Overlay must be a single PNG image');
  return {width:image.width,height:image.height};
}
export async function validateMedia(path:string,tools:ToolPaths,ctx?:ExecutionContext):Promise<MediaInfo>{
  const media=await probe(path,tools,ctx);
  ctx?.onProgress?.(0,'Checking the completed file');
  const checking=ctx?{...ctx,onProgress:(progress:number)=>ctx.onProgress?.(progress,`Checking the completed file: ${Math.floor(progress*100)}%`)}:undefined;
  await runProcess(tools.ffmpeg,[...BASE,'-progress','pipe:2','-xerror',...INPUT_POLICY,'-i',safePath(path),'-map','0:v?','-map','0:a?','-f','null','-'],checking,{maxStdoutBytes:1024,duration:media.duration});
  return media;
}
const encoderCache=new Map<string,EncoderCapability[]>();
export async function testEncoders(tools:ToolPaths,workDir:string,ctx?:ExecutionContext,codec?:ExportOptions['codec']):Promise<EncoderCapability[]>{
  if(ctx?.signal.aborted)throw new Error('Operation cancelled');
  const version=(await runProcess(tools.ffmpeg,['-version'],ctx)).stdout.toString().split(/\r?\n/)[0];
  // Software smoke results are process-local; hardware is rechecked for every job.
  const key=createHash('sha256').update(JSON.stringify({ffmpeg:tools.ffmpeg,version,platform:process.platform,test:'320x180-yuv420p-12frames-v2'})).digest('hex');
  const cachedSoftware=new Map((encoderCache.get(key)??[]).map(capability=>[capability.name,capability]));
  const pending=(async()=>{await mkdir(workDir,{recursive:true});const listing=(await runProcess(tools.ffmpeg,['-hide_banner','-encoders'],ctx)).stdout.toString();
    const candidates:[string,EncoderCapability['codec'],boolean][]=[['libx264','h264',false],['libx265','hevc',false],['libsvtav1','av1',false],['libaom-av1','av1',false],['h264_nvenc','h264',true],['hevc_nvenc','hevc',true],['av1_nvenc','av1',true],['h264_qsv','h264',true],['hevc_qsv','hevc',true],['av1_qsv','av1',true],['h264_amf','h264',true],['hevc_amf','hevc',true],['av1_amf','av1',true],['h264_vaapi','h264',true],['hevc_vaapi','hevc',true],['av1_vaapi','av1',true]];
    const results:EncoderCapability[]=[];
    for(const [name,candidateCodec,hardware]of candidates){if(codec&&candidateCodec!==codec)continue;if(!hardware&&cachedSoftware.has(name)){results.push(cachedSoftware.get(name)!);continue;}const c:EncoderCapability={name,codec:candidateCodec,hardware,available:false,testedAt:new Date().toISOString()};if(!listing.includes(` ${name} `)){c.reason='Encoder absent from this FFmpeg build';results.push(c);continue;}
      const output=join(workDir,`encoder-${randomUUID()}.mkv`);const smokeCtx={...ctx,signal:ctx?.signal??new AbortController().signal,workDir,maxRuntimeSeconds:Math.min(30,ctx?.maxRuntimeSeconds??30)};try{const extras=name==='libaom-av1'?['-cpu-used','8']:name==='libsvtav1'?['-preset','12']:[];await runProcess(tools.ffmpeg,[...BASE,'-f','lavfi','-i','testsrc2=size=320x180:rate=24','-frames:v','12','-an','-c:v',name,...extras,'-threads','2','-pix_fmt','yuv420p',output],smokeCtx);await validateMedia(output,tools,smokeCtx);c.available=true;}catch(e){if(ctx?.signal.aborted)throw new Error('Operation cancelled');c.reason=String((e as Error).message).replaceAll(workDir,'[work]').replace(/ @ [a-f0-9]+/gi,'').slice(0,700);}finally{await unlink(output).catch(()=>{});}results.push(c);
    }return results;})();const results=await pending;encoderCache.set(key,results.filter(capability=>!capability.hardware));return results;
}

type Frame={pts:number;keyframe:boolean};
const timeBaseSeconds=(value?:string)=>{const [n,d]=(value??'1/1000000').split('/').map(Number);return n>0&&d>0?n/d:1e-6;};
const frameCache=new Map<string,Frame[]>();
const frameImages=new Map<string,Buffer>();let frameImageBytes=0;
export async function frameIndex(path:string,tools:ToolPaths,around=0,ctx?:ExecutionContext):Promise<Frame[]>{
  if(!Number.isFinite(around)||around<0)throw new Error('Invalid frame window');
  const file=await stat(path),media=await probe(path,tools,ctx);const begin=Math.max(0,around-5),end=Math.min(media.duration,around+5+(around===0?5:0));const key=`${resolve(path)}:${file.size}:${file.mtimeMs}:${begin}:${end}`;
  if(frameCache.has(key))return frameCache.get(key)!;
  const interval=`${Math.max(media.startTime,begin+media.startTime)}%${end+media.startTime}`;
  const data=JSON.parse((await runProcess(tools.ffprobe,['-v','error',...INPUT_POLICY,'-select_streams','v:0','-read_intervals',interval,'-show_frames','-show_entries','frame=best_effort_timestamp,best_effort_timestamp_time,key_frame','-of','json',safePath(path)],ctx,{maxStdoutBytes:8*1024*1024})).stdout.toString());
  const tb=timeBaseSeconds(media.streams.find(s=>s.type==='video')?.timeBase),originTicks=Math.round(media.startTime/tb);
  const frames:Frame[]=(data.frames??[]).filter((f:any)=>f.best_effort_timestamp!==undefined).map((f:any)=>({pts:(num(f.best_effort_timestamp)-originTicks)*tb,keyframe:f.key_frame===1})).filter((f:Frame)=>f.pts>=begin-1e-6&&f.pts<=end+1e-6);
  if(frameCache.size>100)frameCache.delete(frameCache.keys().next().value!);frameCache.set(key,frames);return frames;
}
export async function extractFrame(path:string,outputPath:string,pts:number,tools:ToolPaths,ctx?:ExecutionContext):Promise<void>{
  if(ctx?.signal.aborted)throw new Error('Operation cancelled');if(!Number.isFinite(pts)||pts<0)throw new Error('Invalid frame timestamp');await mkdir(dirname(outputPath),{recursive:true});
  const file=await stat(path),cacheKey=`${resolve(path)}:${file.size}:${file.mtimeMs}:${pts.toPrecision(17)}:${extname(outputPath).toLowerCase()}`;const cached=frameImages.get(cacheKey);if(cached){await writeFile(outputPath,cached,{flag:'wx'});return;}
  // Accurate input seeking decodes from the preceding seek point; select applies the
  // remaining timestamp offset to preserve exact VFR/B-frame decisions.
  const media=await probe(path,tools,ctx),tb=timeBaseSeconds(media.streams.find(s=>s.type==='video')?.timeBase);const seekTicks=Math.max(0,Math.floor((pts-1)/tb)),seek=seekTicks*tb,selectedTick=Math.ceil(pts/tb-1e-7)-seekTicks;
  await runProcess(tools.ffmpeg,[...BASE,...INPUT_POLICY,'-ss',seek.toFixed(9),'-i',safePath(path),'-vf',`select=gte(pts\\,${selectedTick})`,'-frames:v','1','-fps_mode','vfr','-update','1','-n',safePath(outputPath)],ctx,{outputPath});
  const imageSize=(await stat(outputPath)).size;if(imageSize===0)throw new Error('Frame extraction produced no image');if(imageSize<=8*1024*1024){const bytes=await readFile(outputPath);while(frameImages.size>=24||frameImageBytes+bytes.length>32*1024*1024){const oldest=frameImages.keys().next().value;if(!oldest)break;frameImageBytes-=frameImages.get(oldest)!.length;frameImages.delete(oldest);}frameImages.set(cacheKey,bytes);frameImageBytes+=bytes.length;}
}
export async function extractThumbnail(file:string,outputPath:string,seconds:number,tools:ToolPaths,ctx:ExecutionContext):Promise<void>{
  if(!Number.isFinite(seconds)||seconds<0)throw new Error('Invalid thumbnail timestamp');
  await runProcess(tools.ffmpeg,[...BASE,...INPUT_POLICY,'-ss',String(seconds),'-i',safePath(file),'-map','0:v:0','-vf','scale=480:270:force_original_aspect_ratio=decrease','-frames:v','1','-q:v','4','-update','1','-n',safePath(outputPath)],ctx,{outputPath});
  if((await stat(outputPath)).size===0)throw new Error('Thumbnail extraction produced no image');
}
export type WaveformWindow={start?:number;duration?:number;points?:number;track?:number};
export type WaveformResult={duration:number;peaks:number[];sampleRate:number;start:number;end:number;complete:boolean};
const waveformCache=new Map<string,WaveformResult>();
export async function waveform(path:string,tools:ToolPaths,ctx?:ExecutionContext,window:WaveformWindow={}):Promise<WaveformResult>{
  if(ctx?.signal.aborted)throw new Error('Operation cancelled');const start=window.start??0,length=window.duration??30,points=window.points??300,track=window.track??0;
  if(!Number.isFinite(start)||start<0||!Number.isFinite(length)||length<=0||length>60||!Number.isInteger(points)||points<1||points>2000||!Number.isInteger(track)||track<0||track>32)throw new Error('Invalid waveform window: duration must be at most 60 seconds and points at most 2000');
  const file=await stat(path),key=`${resolve(path)}:${file.size}:${file.mtimeMs}:${start}:${length}:${points}:${track}`;if(waveformCache.has(key))return waveformCache.get(key)!;
  const media=await probe(path,tools,ctx);const end=Math.min(media.duration,start+length),duration=Math.max(0,end-start),base={duration:media.duration,start:Math.min(start,media.duration),end,complete:end>=media.duration};if(!media.streams.some(s=>s.type==='audio')||duration===0)return {...base,peaks:[],sampleRate:10};if(!media.streams.filter(s=>s.type==='audio')[track])throw new Error('Selected waveform audio track does not exist');
  // Compute envelope before reducing temporal resolution so high audio frequencies remain visible.
  const raw=(await runProcess(tools.ffmpeg,[...BASE,'-progress','pipe:2',...INPUT_POLICY,'-ss',String(start),'-i',safePath(path),'-map',`0:a:${track}`,'-af',`aresample=48000:async=1:first_pts=0,apad,atrim=duration=${duration},asetnsamples=n=4800:p=1,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-`,'-t',String(duration),'-f','null','-'],ctx,{maxStdoutBytes:1024*1024,duration})).stdout.toString();
  const values=[...raw.matchAll(/lavfi\.astats\.Overall\.Peak_level=([^\r\n]+)/g)].map(m=>Number.isFinite(Number(m[1]))?Math.min(1,Math.pow(10,Number(m[1])/20)):0);const bin=Math.max(1,Math.ceil(values.length/points)),peaks:number[]=[];for(let i=0;i<values.length;i+=bin)peaks.push(Math.max(...values.slice(i,i+bin)));const result={...base,peaks,sampleRate:10/bin};if(waveformCache.size>=128)waveformCache.delete(waveformCache.keys().next().value!);waveformCache.set(key,result);return result;
}

function compatibleCopy(recipe:Recipe,options:ExportOptions,media:MediaInfo):boolean {
  if(options.container==='mkv')return true;
  const video=media.streams.find(s=>s.type==='video'),audio=media.streams.filter(s=>s.type==='audio')[recipe.audio.track];
  return (!video||['h264','hevc','av1','vp9','mpeg4','mpeg2video','mjpeg'].includes(video.codec))&&(recipe.audio.mode==='mute'||!audio||['aac','mp3','ac3','eac3','alac','opus'].includes(audio.codec));
}
function canCopy(recipe:Recipe,options:ExportOptions,media:MediaInfo):boolean {
  return options.cut==='copy'||options.cut==='auto'&&!hasFilters(recipe,options)&&options.mode==='auto'&&compatibleCopy(recipe,options,media);
}
function hasFilters(recipe:Recipe,options:ExportOptions):boolean {
  return !!(recipe.crop||recipe.resize||recipe.rotate||recipe.caption?.text.trim()||recipe.text.length||recipe.captions.length||recipe.overlays.length||options.frameRate||recipe.audio.volume!==1||recipe.audio.fadeIn||recipe.audio.fadeOut||recipe.audio.normalize||['mix','replace'].includes(recipe.audio.mode));
}
export function planExport(recipeInput:Recipe,optionsInput:ExportOptions,media:MediaInfo,encoders:EncoderCapability[]):Plan{
  const recipe=RecipeSchema.parse(recipeInput),options=ExportSchema.parse(optionsInput);const video=media.streams.find(s=>s.type==='video');const audio=media.streams.filter(s=>s.type==='audio');
  for(const segment of recipe.segments)if(segment.out>media.duration+.08)throw new Error('Segment exceeds source duration');
  if(recipe.audio.mode==='keep'&&audio.length&&recipe.audio.track>=audio.length)throw new Error('Selected audio track does not exist');
  if(recipe.crop&&video&&(recipe.crop.x+recipe.crop.width>video.width!||recipe.crop.y+recipe.crop.height>video.height!))throw new Error('Crop exceeds unrotated source pixel coordinates');
  if(!video&&(recipe.crop||recipe.resize||recipe.rotate||recipe.caption?.text.trim()||recipe.text.length||recipe.captions.length||recipe.overlays.length))throw new Error('Video edits require a video stream');
  const filtered=hasFilters(recipe,options),copy=canCopy(recipe,options,media);
  if(copy&&filtered)throw new Error('Stream copy cannot apply requested filters; choose exact cut');
  if(copy&&options.mode==='size')throw new Error('Strict target-size requires encoding; choose exact or automatic');
  if(!video&&recipe.audio.mode==='mute')throw new Error('No media streams remain after removing audio');
  if(media.hdr&&!copy)throw new Error('HDR encoding is blocked: an explicit verified color transform is not yet available. Stream copy preserves HDR.');
  const reasons:string[]=[],warnings:string[]=[];let encoder='copy',hardware=false;
  if(copy){reasons.push('Eligible streams are copied without reencoding. Cut boundaries are resolved to usable keyframes before execution.');warnings.push('Lossless cuts may include extra frames at the edges. Choose Exact for precise cut positions.');if(options.cut==='copy'&&options.mode!=='auto')warnings.push('Compression preferences do not apply to explicit stream copy.');}
  else if(video){const all=encoders.filter(e=>e.codec===options.codec&&e.available);let chosen=options.encoder==='software'?all.find(e=>!e.hardware):all.find(e=>e.hardware);if(!chosen&&options.encoder!=='software'&&options.allowSoftwareFallback){chosen=all.find(e=>!e.hardware);warnings.push('Requested hardware encoder unavailable; permitted software fallback selected.');}if(!chosen)throw new Error(`No operational ${options.encoder} ${options.codec} encoder available under fallback policy`);encoder=chosen.name;hardware=chosen.hardware;reasons.push(filtered?'Edits require decoded frames and encoding.':'Timestamp-accurate cut uses decoded presentation timestamps.');}
  const duration=recipe.segments.reduce((sum,s)=>sum+s.out-s.in,0);if(duration<=0)throw new Error('Empty edited duration');
  return {strategy:copy?'copy':'exact',encoder,hardware,duration,reasons,warnings,segments:recipe.segments.map(s=>({...s})),attempts:options.mode==='size'?options.maxAttempts:1,video:video?(copy?'copy':`encode ${options.codec} with ${encoder}`):'absent',audio:recipe.audio.mode==='mute'?'discard':copy?'copy selected audio':`encode ${recipe.audio.mode} audio as AAC`,timestampOrigin:media.startTime,operationOrder:'source encoded pixels → crop → source orientation → recipe rotation → resize → image overlays → text/captions → encode; captions and overlays use source time before cuts',audioPolicy:'Replacement starts at output zero, trims if longer and pads silence if shorter. Mix retains source timing; source audio gaps become silence.'};
}

export function mapCues(cues:Recipe['captions'],segments:Recipe['segments']):Recipe['captions']{const result:Recipe['captions']=[];let offset=0;for(const s of segments){for(const c of cues){const begin=Math.max(s.in,c.in),end=Math.min(s.out,c.out);if(end>begin)result.push({...c,in:offset+begin-s.in,out:offset+end-s.in});}offset+=s.out-s.in;}return result.sort((a,b)=>a.in-b.in);}
export function serializeSrt(cues:Recipe['captions']):string{const time=(s:number)=>{const ms=Math.round(s*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};return cues.map((c,i)=>`${i+1}\n${time(c.in)} --> ${time(c.out)}\n${c.text.replace(/\r/g,'')}\n`).join('\n');}
function rotationFilter(angle:number):string[]{const r=((angle%360)+360)%360;return r===90?['transpose=clock']:r===180?['hflip','vflip']:r===270?['transpose=cclock']:[];}
function wrapText(text:string,columns:number):string{const lines:string[]=[];for(const paragraph of text.split(/\r?\n/)){let line='';for(const word of paragraph.split(/\s+/)){if(line&&[...line,...word].length+1>columns){lines.push(line);line='';}const chars=[...word];while(chars.length>columns){if(line){lines.push(line);line='';}lines.push(chars.splice(0,columns).join(''));}line+=(line?' ':'')+chars.join('');}lines.push(line);}return lines.join('\n');}
async function makeFilters(recipe:Recipe,media:MediaInfo,workDir:string,extraAudio:boolean,frameRate?:number):Promise<{graph:string;video:boolean;audio:boolean;files:string[]}>{
  const video=media.streams.find(s=>s.type==='video'),sourceAudio=media.streams.filter(s=>s.type==='audio')[recipe.audio.track];const hasAudio=recipe.audio.mode!=='mute'&&(!!sourceAudio||extraAudio);const parts:string[]=[],files:string[]=[];
  const count=recipe.segments.length;
  if(video&&count>1)parts.push(`[0:v:0]split=${count}${recipe.segments.map((_,i)=>`[vi${i}]`).join('')}`);
  if(sourceAudio&&hasAudio&&recipe.audio.mode!=='replace'&&count>1)parts.push(`[0:a:${recipe.audio.track}]asplit=${count}${recipe.segments.map((_,i)=>`[ai${i}]`).join('')}`);
  for(const [i,s]of recipe.segments.entries()){
    const dur=s.out-s.in;if(video){const tb=timeBaseSeconds(video.timeBase),firstTick=Math.ceil(s.in/tb-1e-7),endTick=Math.ceil(s.out/tb-1e-7);parts.push(`${count>1?`[vi${i}]`:'[0:v:0]'}trim=start_pts=${firstTick}:end_pts=${endTick},setpts=expr=PTS-${s.in}/TB:strip_fps=0[v${i}]`);}
    if(sourceAudio&&hasAudio&&recipe.audio.mode!=='replace')parts.push(`${count>1?`[ai${i}]`:`[0:a:${recipe.audio.track}]`}atrim=start=${s.in}:end=${s.out},asetpts=PTS-${s.in}/TB,aresample=async=1:first_pts=0,apad,atrim=duration=${dur}[a${i}]`);
  }
  if(video)parts.push(`${recipe.segments.map((_,i)=>`[v${i}]`).join('')}concat=n=${count}:v=1:a=0[vjoined]`);
  if(sourceAudio&&hasAudio&&recipe.audio.mode!=='replace')parts.push(`${recipe.segments.map((_,i)=>`[a${i}]`).join('')}concat=n=${count}:v=0:a=1[ajoined]`);
  const duration=recipe.segments.reduce((sum,s)=>sum+s.out-s.in,0);
  if(video){const filters:string[]=[];if(recipe.crop)filters.push(`crop=${recipe.crop.width}:${recipe.crop.height}:${recipe.crop.x}:${recipe.crop.y}`);filters.push(...rotationFilter(-(video.rotation??0)),...rotationFilter(recipe.rotate));if(recipe.resize)filters.push(`scale=${recipe.resize.width}:${recipe.resize.height}:flags=lanczos`);else filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    const texts=[...mapCues(recipe.text,recipe.segments).map(c=>({...c,caption:false})),...(recipe.subtitleMode==='burn'?mapCues(recipe.captions,recipe.segments).map(c=>({...c,caption:true})):[])];
    const fonts=new Map<string,string>();
    let width=recipe.crop?.width??video.width!,height=recipe.crop?.height??video.height!;if(Math.abs((video.rotation??0)-recipe.rotate)%180===90)[width,height]=[height,width];if(recipe.resize){width=recipe.resize.width;height=recipe.resize.height;}
    const header=captionLayout(recipe.caption,width);
    // Image overlays composite onto the picture before the caption header, so their geometry ignores it.
    let picture='vjoined';
    const overlayBase=1+(extraAudio?1:0)+(recipe.subtitleMode==='soft'&&recipe.captions.length?1:0);
    for(const [i,o]of recipe.overlays.entries()){
      const shown=mapCues([{in:o.in,out:o.out,text:''}],recipe.segments);if(!shown.length)continue;
      if(picture==='vjoined'){parts.push(`[vjoined]${filters.join(',')}[vpicture]`);filters.length=0;picture='vpicture';}
      parts.push(`[${overlayBase+i}:v:0]format=rgba,scale=${Math.max(1,Math.round(o.width*width))}:-1${o.opacity<1?`,colorchannelmixer=aa=${o.opacity}`:''}[ovimage${i}]`);
      parts.push(`[${picture}][ovimage${i}]overlay=x=W*(${o.x})-w/2:y=H*(${o.y})-h/2:eof_action=repeat:enable='${shown.map(r=>`gte(t,${r.in})*lt(t,${r.out})`).join('+')}'[voverlay${i}]`);
      picture=`voverlay${i}`;
    }
    if(header.height){
      if(header.height+height>10000||header.text.split('\n').length>100)throw new Error('Caption is too tall; shorten it or reduce text size and padding');
      const fontName=`font-${randomUUID()}.ttf`,name=`caption-${randomUUID()}.txt`;
      await copyFile(await findFont('Arial'),join(workDir,fontName));await writeFile(join(workDir,name),header.text,'utf8');files.push(join(workDir,fontName),join(workDir,name));
      filters.push(`pad=iw:ih+${header.height}:0:${header.height}:color=black`);
      filters.push(`drawtext=textfile=${name}:expansion=none:fontfile=${fontName}:fontsize=${header.size}:line_spacing=${header.lineHeight-header.size}:fontcolor=white:x=(w-tw)/2:y=${header.padding}:text_align=C`);
    }
    for(const [i,c]of texts.entries()){
      const style=c.style,family=style?.font||'Arial';
      let fontName=fonts.get(family);if(!fontName){fontName=`font-${randomUUID()}.ttf`;await copyFile(await findFont(family),join(workDir,fontName));files.push(join(workDir,fontName));fonts.set(family,fontName);}
      const size=style?style.size:Math.max(10,Math.min(c.caption?20:24,Math.floor(width/20),Math.floor(height/10)));
      const wrapped=style?c.text:wrapText(c.text,Math.max(1,Math.floor((width-24)/(size*.7))));
      if(!style&&wrapped.split('\n').length*(size+4)>height-32)throw new Error('Text/caption does not fit the output dimensions; shorten the cue or enlarge the output');
      const name=`text-${randomUUID()}-${i}.txt`;await writeFile(join(workDir,name),wrapped,'utf8');files.push(join(workDir,name));
      const x=style?`w*${style.x}-tw*${style.align==='left'?0:style.align==='right'?1:.5}`:'(w-tw)/2';
      const y=style?`h*${style.y}-th/2`:c.caption?'h-th-12':'12';
      filters.push(`drawtext=textfile=${name}:expansion=none:fontfile=${fontName}:fontsize=${size}:line_spacing=4:fontcolor=${style?style.color.replace('#','0x'):'white'}:box=${style?0:1}:boxcolor=black@0.65:boxborderw=5:x=${x}:y=${y}:text_align=${style?.align==='left'?'L':style?.align==='right'?'R':'C'}:enable='gte(t,${c.in})*lt(t,${c.out})'`);
    }
    if(frameRate)filters.push(`fps=${frameRate}`);filters.push('setsar=1','format=yuv420p');parts.push(`[${picture}]${filters.join(',')}[vout]`);
  }
  if(hasAudio){let source='ajoined';if(extraAudio){parts.push(`[1:a:0]asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0,apad,atrim=duration=${duration}[replacement]`);if(recipe.audio.mode==='mix'&&sourceAudio){parts.push('[ajoined][replacement]amix=inputs=2:duration=longest:normalize=0[amixed]');source='amixed';}else source='replacement';}
    const filters=[`volume=${recipe.audio.volume}`];if(recipe.audio.normalize)filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');if(recipe.audio.fadeIn)filters.push(`afade=t=in:st=0:d=${recipe.audio.fadeIn}`);if(recipe.audio.fadeOut)filters.push(`afade=t=out:st=${Math.max(0,duration-recipe.audio.fadeOut)}:d=${recipe.audio.fadeOut}`);filters.push('apad',`atrim=duration=${duration}`);parts.push(`[${source}]${filters.join(',')}[aout]`);
  }return {graph:parts.join(';'),video:!!video,audio:hasAudio,files};
}

async function publish(temp:string,output:string){try{await link(temp,output);}catch(e){if((e as NodeJS.ErrnoException).code!=='EXDEV')throw e;await copyFile(temp,output,constants.COPYFILE_EXCL);}await unlink(temp);}
const keyframeCache=new Map<string,number[]>();
const boundaryCache=new Map<string,number[]>();
// Seek through container indexes and inspect compressed packets only near each cut.
// Growing the window accommodates long GOPs without decoding/scanning the whole source.
async function boundaryKeyframes(path:string,tools:ToolPaths,ctx:ExecutionContext,media:MediaInfo,at:number,forward:boolean):Promise<number[]> {
  if(ctx.signal.aborted)throw new Error('Operation cancelled');
  const file=await stat(path),key=`${resolve(path)}:${file.size}:${file.mtimeMs}:${file.ctimeMs}:${tools.ffprobe}:${at}:${forward}`;
  const cached=boundaryCache.get(key);if(cached)return cached;
  const tb=timeBaseSeconds(media.streams.find(s=>s.type==='video')?.timeBase),origin=Math.round(media.startTime/tb);
  for(let window=4;;window*=4){
    const end=Math.min(media.duration,at+window);
    const data=JSON.parse((await runProcess(tools.ffprobe,['-v','error',...INPUT_POLICY,'-select_streams','v:0','-read_intervals',`${Math.max(media.startTime,media.startTime+at)}%${media.startTime+end}`,'-show_packets','-show_entries','packet=pts,flags','-of','json',safePath(path)],ctx,{maxStdoutBytes:16*1024*1024})).stdout.toString());
    const keys:number[]=(data.packets??[]).filter((p:any)=>p.pts!==undefined&&String(p.flags).includes('K')).map((p:any)=>(num(p.pts)-origin)*tb).filter((p:number)=>p>=-1e-6&&p<media.duration).sort((a:number,b:number)=>a-b);
    if(!forward||keys.some(p=>p>=at-1e-6)||end>=media.duration){
      if(boundaryCache.size>=256)boundaryCache.delete(boundaryCache.keys().next().value!);
      boundaryCache.set(key,keys);return keys;
    }
  }
}
async function validateCopy(path:string,source:MediaInfo,recipe:Recipe,tools:ToolPaths,ctx:ExecutionContext):Promise<MediaInfo> {
  const media=await probe(path,tools,ctx),video=source.streams.find(s=>s.type==='video'),audio=source.streams.filter(s=>s.type==='audio')[recipe.audio.track];
  const copiedVideo=media.streams.find(s=>s.type==='video'),copiedAudio=media.streams.find(s=>s.type==='audio');
  if(video&&(!copiedVideo||copiedVideo.codec!==video.codec||copiedVideo.width!==video.width||copiedVideo.height!==video.height))throw new Error('Copied video stream does not match the source');
  if(recipe.audio.mode!=='mute'&&audio&&(!copiedAudio||copiedAudio.codec!==audio.codec))throw new Error('Copied audio stream does not match the selected source track');
  ctx.onProgress?.(0,'Checking copied file and cut edges');
  // Bounded decode catches unusable cut boundaries. Full interior verification is opt-in.
  for(const at of new Set([0,Math.max(0,media.duration-.5)]))await runProcess(tools.ffmpeg,[...BASE,'-xerror',...INPUT_POLICY,'-ss',String(at),'-i',safePath(path),'-t','0.5','-map','0:v?','-map','0:a?','-f','null','-'],ctx,{maxStdoutBytes:1024});
  return media;
}
async function keyframes(path:string,tools:ToolPaths,ctx:ExecutionContext,media:MediaInfo):Promise<number[]>{
 if(ctx.signal.aborted)throw new Error('Operation cancelled');const file=await stat(path);const key=`${resolve(path)}:${file.size}:${file.mtimeMs}:${file.ctimeMs}:${tools.ffprobe}:${media.startTime}`;const cached=keyframeCache.get(key);if(cached)return cached;
 const d=JSON.parse((await runProcess(tools.ffprobe,['-v','error',...INPUT_POLICY,'-select_streams','v:0','-skip_frame','nokey','-show_frames','-show_entries','frame=best_effort_timestamp','-of','json',safePath(path)],ctx,{maxStdoutBytes:16*1024*1024})).stdout.toString());const tb=timeBaseSeconds(media.streams.find(s=>s.type==='video')?.timeBase),origin=Math.round(media.startTime/tb);const result=(d.frames??[]).map((f:any)=>(num(f.best_effort_timestamp)-origin)*tb);
 if(keyframeCache.size>=64)keyframeCache.delete(keyframeCache.keys().next().value!);keyframeCache.set(key,result);return result;
}
export async function exportMedia(inputPath:string,outputPath:string,recipeInput:Recipe,optionsInput:ExportOptions,tools:ToolPaths,ctx:ExecutionContext,extraAudioPath?:string,overlayImages:Record<string,string>={}):Promise<{media:MediaInfo;plan:Plan}>{
  const recipe=RecipeSchema.parse(recipeInput),options=ExportSchema.parse(optionsInput);
  const overlayPaths=recipe.overlays.map(o=>{const path=overlayImages[o.imageId];if(!path)throw new Error('An overlay image is missing; remove the overlay or add the image again');return path;});const source=await probe(inputPath,tools,ctx);const encoders=(canCopy(recipe,options,source)?[]:await testEncoders(tools,ctx.workDir,ctx,options.codec)).filter(e=>!ctx.allowedEncoders?.length||ctx.allowedEncoders.includes(e.name));const plan=planExport(recipe,options,source,encoders);ctx.onPlan?.(plan);
  if(['mix','replace'].includes(recipe.audio.mode)&&!extraAudioPath)throw new Error('Replacement/mixed audio source is required');
  if(extraAudioPath&&!(await probe(extraAudioPath,tools,ctx)).streams.some(s=>s.type==='audio'))throw new Error('Replacement source has no audio');
  await mkdir(dirname(outputPath),{recursive:true});await mkdir(ctx.workDir,{recursive:true});if(await exists(outputPath))throw new Error('Output already exists; refusing overwrite');
  const temp=join(dirname(outputPath),`.partial-${randomUUID()}.${options.container}`);const cleanup:string[]=[temp];let observed:MediaInfo|undefined;
  try{if(plan.strategy==='copy'){
      const video=source.streams.some(s=>s.type==='video'),full=options.copyValidation==='full';
      const allKeys=video&&full?await keyframes(inputPath,tools,ctx,source):undefined;
      plan.segments=[];plan.requestedSegments=recipe.segments;
      // Coalesce adjacent splits so they do not duplicate GOPs at a shared boundary.
      const requestedSegments:Recipe['segments']=[];
      for(const segment of recipe.segments){const last=requestedSegments.at(-1);if(last&&Math.abs(last.out-segment.in)<1e-7)last.out=segment.out;else requestedSegments.push({...segment});}
      const parts:string[]=[];let partBytes=0;
      for(const requested of requestedSegments){
      const startKeys=video&&requested.in>0?(allKeys??await boundaryKeyframes(inputPath,tools,ctx,source,requested.in,false)):[];
      const endKeys=video&&requested.out<source.duration?(allKeys??await boundaryKeyframes(inputPath,tools,ctx,source,requested.out,true)):[];
      const start=video?(startKeys.findLast(p=>p<=requested.in+1e-6)??0):requested.in;
      // End snaps forward so output is a complete group of pictures and preserves decoding dependencies.
      const end=video?(endKeys.find(p=>p>=requested.out-1e-6)??source.duration):requested.out;plan.segments.push({in:start,out:end});plan.warnings.push(`Keyframe copy uses ${start.toFixed(6)}–${end.toFixed(6)} seconds; requested ${requested.in.toFixed(6)}–${requested.out.toFixed(6)}.`);
      const part=requestedSegments.length===1?temp:join(dirname(temp),`cut-${randomUUID()}.${options.container}`);if(part!==temp)cleanup.push(part);parts.push(part);
      const args=[...BASE,'-progress','pipe:2',...INPUT_POLICY,'-ss',String(start),'-i',safePath(inputPath),'-t',String(end-start),'-map','0:v:0?'];if(recipe.audio.mode!=='mute')args.push('-map',`0:a:${recipe.audio.track}?`);args.push('-c','copy');if(video)args.push('-bsf:v',`noise=amount=0:drop='gte(pts*tb,${end-start})'`);args.push('-map_metadata','0','-avoid_negative_ts','disabled','-n',safePath(part));ctx.onStage?.('processing');await runProcess(tools.ffmpeg,args,ctx,{outputPath:part,duration:end-start});
      partBytes+=(await stat(part)).size;if(ctx.maxBytes&&partBytes>ctx.maxBytes)throw new Error('Copied sections exceeded resource byte limit');
      if(video&&full){
       ctx.onStage?.('validating');
       const hash=async(file:string,original=false)=>{
        const label=original?'Checking original frames':'Checking copied frames';ctx.onProgress?.(0,label);
        const checking={...ctx,onProgress:(progress:number)=>ctx.onProgress?.(progress,`${label}: ${Math.floor(progress*100)}%`)};
        const tb=timeBaseSeconds(source.streams.find(s=>s.type==='video')?.timeBase);
        const seek=original?['-copyts','-start_at_zero','-ss',String(start),'-t',String(end-start+1)]:[];
        const trim=original?['-vf',`trim=start_pts=${Math.ceil(start/tb-1e-7)}:end_pts=${Math.ceil(end/tb-1e-7)}`]:[];
        return (await runProcess(tools.ffmpeg,[...BASE,'-progress','pipe:2','-xerror',...INPUT_POLICY,...seek,'-i',safePath(file),'-map','0:v:0','-an',...trim,'-c:v','rawvideo','-fps_mode','vfr','-f','hash','-hash','sha256','-'],checking,{duration:end-start,progressOffset:original?start:0})).stdout.toString().trim();
       };
       const expected=await hash(inputPath,true),actual=await hash(part);if(expected!==actual)throw new Error('Stream copy did not preserve the selected decoded frames; use exact encoding for this codec/GOP boundary');plan.framePreservation='Decoded source/output SHA-256 match';
      }
      if(!full&&parts.length>0&&requestedSegments.length>1)await validateCopy(part,source,recipe,tools,ctx);
      }
      plan.duration=plan.segments.reduce((sum,s)=>sum+s.out-s.in,0);
      if(parts.length>1){
        const list=join(dirname(temp),`concat-${randomUUID()}.txt`);cleanup.push(list);
        await writeFile(list,parts.map((part,i)=>`file '${basename(part)}'\nduration ${plan.segments[i].out-plan.segments[i].in}`).join('\n'));
        ctx.onStage?.('processing');await runProcess(tools.ffmpeg,[...BASE,'-progress','pipe:2','-copyts','-protocol_whitelist','file,pipe','-f','concat','-safe','1','-i',list,'-map','0','-c','copy','-avoid_negative_ts','disabled','-n',temp],ctx,{outputPath:temp,duration:plan.duration});
      }
      if(!full){ctx.onStage?.('validating');observed=await validateCopy(temp,source,recipe,tools,ctx);plan.validation='Container, stream identity, duration and bounded cut-edge decode; full interior decode was not run.';}
      else plan.validation='Full output decode and decoded-frame SHA-256 comparison for each copied section.';
      ctx.onPlan?.(plan);
    }else{
      const filters=await makeFilters(recipe,source,ctx.workDir,!!extraAudioPath,options.frameRate);cleanup.push(...filters.files);const graphPath=join(ctx.workDir,`filter-${randomUUID()}.txt`);await writeFile(graphPath,filters.graph);cleanup.push(graphPath);let subtitlePath:string|undefined;if(recipe.subtitleMode==='soft'&&recipe.captions.length){subtitlePath=join(ctx.workDir,`captions-${randomUUID()}.srt`);await writeFile(subtitlePath,serializeSrt(mapCues(recipe.captions,recipe.segments)));cleanup.push(subtitlePath);}
      const duration=plan.duration,audioBitrate=filters.audio?options.audioBitrate:0;
      // Reserve muxing, AAC padding/variation and a short VBV burst before allocating video.
      // This is a complete-duration budget, never a file-size cutoff that truncates the clip.
      const overhead=Math.max(4096,Math.ceil((options.maxBytes??0)*.035))+(subtitlePath?(await stat(subtitlePath)).size:0);
      const audioBytes=Math.ceil(audioBitrate*(duration+.1)/8*1.05),bufferSeconds=Math.min(.5,duration/4);
      let bitrate=options.mode==='size'?Math.floor(((options.maxBytes??0)-overhead-audioBytes)*8/(duration+bufferSeconds)*.95):options.bitrate;
      if(options.mode==='size'&&(filters.video?bitrate<10000:options.maxBytes!<overhead+audioBytes))throw new Error('Byte limit is infeasible for required duration, audio bitrate, and container overhead. Increase limit or explicitly reduce audio/duration.');
      plan.reservedOverheadBytes=overhead;plan.measuredAttempts=[];
      for(let attempt=1;attempt<=plan.attempts;attempt++){
        plan.rateControl=options.mode==='size'?'Single-pass bitrate budget with bounded correction':options.mode;
        ctx.onStage?.('processing');const common=[...BASE,'-filter_complex_threads',String(mediaThreads(ctx)),'-threads',String(mediaThreads(ctx)),'-progress','pipe:2',...INPUT_POLICY,'-noautorotate',...(filters.video?['-display_rotation:v:0','0']:[]),'-i',safePath(inputPath)];if(extraAudioPath)common.push(...INPUT_POLICY,'-i',safePath(extraAudioPath));if(subtitlePath)common.push('-protocol_whitelist','file,pipe','-f','srt','-i',safePath(subtitlePath));for(const image of overlayPaths)common.push('-protocol_whitelist','file,pipe','-f','png_pipe','-i',safePath(image));common.push('-/filter_complex',safePath(graphPath));if(filters.video)common.push('-map','[vout]');if(filters.audio)common.push('-map','[aout]');if(subtitlePath)common.push('-map',`${extraAudioPath?2:1}:s:0`,'-c:s',options.container==='mp4'?'mov_text':'srt');
        const encoding:string[]=[];if(filters.video){encoding.push('-c:v',plan.encoder,'-threads',String(plan.encoder==='libx265'?Math.min(4,mediaThreads(ctx)):mediaThreads(ctx)),'-fps_mode','vfr','-pix_fmt','yuv420p');if(plan.encoder==='libx264'||plan.encoder==='libx265')encoding.push('-preset',options.speed==='fast'?'veryfast':options.speed==='quality'?'slow':'medium');else if(plan.encoder==='libsvtav1')encoding.push('-preset',options.speed==='fast'?'12':options.speed==='quality'?'6':'9');else if(plan.encoder==='libaom-av1')encoding.push('-cpu-used',options.speed==='quality'?'4':'8');
          if(plan.encoder==='libx265')encoding.push('-x265-params',`pools=${mediaThreads(ctx)}`);
          if(plan.encoder==='libsvtav1')encoding.push('-svtav1-params',`lp=${mediaThreads(ctx)}`);
          if(plan.encoder.endsWith('_nvenc'))encoding.push('-preset',options.speed==='fast'?'p1':options.speed==='quality'?'p7':'p4','-multipass','disabled');
          if(plan.encoder.endsWith('_amf'))encoding.push('-quality',options.speed==='fast'?'speed':options.speed==='quality'?'quality':'balanced');
          if(plan.encoder.endsWith('_qsv'))encoding.push('-preset',options.speed==='fast'?'veryfast':options.speed==='quality'?'veryslow':'medium');
          if(options.mode==='size'||options.mode==='bitrate'){encoding.push('-b:v',String(bitrate));if(plan.encoder.endsWith('_nvenc'))encoding.push('-rc','vbr');}else if(plan.hardware){if(plan.encoder.endsWith('_nvenc'))encoding.push('-rc','vbr','-cq',String(options.quality),'-b:v','0');else if(plan.encoder.endsWith('_qsv'))encoding.push('-global_quality',String(options.quality));else encoding.push('-b:v',String(options.bitrate));}else encoding.push('-crf',String(options.quality));
          if(options.mode==='size'&&(plan.encoder==='libx264'||plan.encoder==='libx265'||plan.encoder.endsWith('_nvenc')))encoding.push('-maxrate:v',String(bitrate),'-bufsize:v',String(Math.max(1000,Math.floor(bitrate*bufferSeconds))));
        }if(filters.audio)encoding.push('-c:a','aac','-b:a',String(audioBitrate));encoding.push('-t',String(duration),'-map_metadata','-1');if(filters.video)encoding.push('-metadata:s:v:0','rotate=0');if(options.container==='mp4')encoding.push('-movflags','+faststart');
        plan.cpuThreads=mediaThreads(ctx);plan.acceleration=plan.hardware?'GPU encoding; CPU filters and decoding':'CPU encoding, filters and decoding';ctx.onPlan?.(plan);
        try{await runProcess(tools.ffmpeg,[...common,...encoding,'-n',safePath(temp)],ctx,{outputPath:temp,duration});}
        catch(error){
          // A native encoding-process error permits one software retry, without asserting its
          // cause was the device. Known resource/timeout failures retain their original errors.
          const software=encoders.find(e=>e.codec===options.codec&&e.available&&!e.hardware);
          const message=(error as Error).message,exit=/^Native tool failed \((-?\d+)\):/.exec(message);
          const resourceFailure=/no space left|disk (?:is )?full|quota|out of memory|cannot allocate memory|runtime limit|timed? ?out|permission denied|read-only file system|access is denied/i.test(message)||!!exit&&[124,125,126,127,137,143].includes(Number(exit[1]));
          if(!plan.hardware||!options.allowSoftwareFallback||ctx.signal.aborted||!exit||resourceFailure||!software)throw error;
          if(options.mode==='size'&&attempt>=plan.attempts)throw new Error('Hardware encoding failed and exhausted the strict attempt budget; output was not published');
          (plan.measuredAttempts as unknown[]).push({attempt,encoder:plan.encoder,outcome:'encoder-failed'});
          plan.warnings.push(`${plan.encoder} passed its smoke test but its encoding process failed during this export; permitted software retry uses ${software.name}.`);
          plan.encoder=software.name;plan.hardware=false;plan.video=`encode ${options.codec} with ${software.name}`;plan.reasons.push('The native hardware encoding process failed; the explicitly permitted software retry succeeded.');if(options.mode!=='size')plan.attempts=attempt+1;
          await unlink(temp).catch(()=>{});continue;
        }
        const bytes=(await stat(temp)).size;
        (plan.measuredAttempts as unknown[]).push({attempt,encoder:plan.encoder,bytes,videoBitrate:filters.video?bitrate:0,duration});
        if(options.mode!=='size'||bytes<=options.maxBytes!){ctx.onStage?.('validating');observed=await validateMedia(temp,tools,ctx);break;}
        if(attempt===plan.attempts||!filters.video)throw new Error(`Cannot meet ${options.maxBytes} byte maximum in ${attempt} attempts; measured ${bytes} bytes. Output was not published.`);
        // Reject oversized candidates before decoding them. Only video can shrink here;
        // subtract the fixed audio/mux budget instead of repeatedly scaling the whole file.
        bitrate=Math.floor(bitrate*(options.maxBytes!-overhead-audioBytes)/Math.max(1,bytes-overhead-audioBytes)*.90);if(bitrate<10000)throw new Error('Byte limit infeasible without weakening required output constraints');await unlink(temp);
      }
    }
    ctx.onStage?.('validating');observed??=await validateMedia(temp,tools,ctx);if(options.mode==='size'&&observed.size>options.maxBytes!)throw new Error('Validated output exceeds strict byte limit');
    const tolerance=plan.strategy==='copy'?.6:.15;if(observed.duration<plan.duration-tolerance||observed.duration>plan.duration+tolerance)throw new Error(`Output duration ${observed.duration} differs from planned complete duration ${plan.duration}`);
    if(ctx.signal.aborted)throw new Error('Operation cancelled');await publish(temp,safePath(outputPath));ctx.onProgress?.(1,plan.strategy==='copy'&&options.copyValidation!=='full'?'Copied file and cut edges checked':'Output decoded and validated');return {media:observed,plan};
  }finally{for(const path of cleanup)await unlink(path).catch(()=>{});}
}
export async function createProxy(inputPath:string,outputPath:string,tools:ToolPaths,ctx:ExecutionContext):Promise<MediaInfo>{
  const media=await probe(inputPath,tools,ctx);if(media.hdr)throw new Error('HDR proxy disabled until color transform is verified');const temp=join(dirname(outputPath),`.proxy-${randomUUID()}.mp4`);await mkdir(dirname(outputPath),{recursive:true});try{await runProcess(tools.ffmpeg,[...BASE,...INPUT_POLICY,'-i',safePath(inputPath),'-map','0:v:0?','-map','0:a:0?','-vf','scale=min(960\\,iw):-2','-c:v','libx264','-preset','veryfast','-crf','28','-pix_fmt','yuv420p','-fps_mode','vfr','-c:a','aac','-b:a','96000','-map_metadata','-1','-movflags','+faststart','-n',safePath(temp)],ctx,{outputPath:temp,duration:media.duration});const output=await validateMedia(temp,tools,ctx);if(Math.abs(output.duration-media.duration)>.15)throw new Error('Proxy timestamp mapping failed duration validation');await publish(temp,safePath(outputPath));return output;}finally{await unlink(temp).catch(()=>{});}
}
