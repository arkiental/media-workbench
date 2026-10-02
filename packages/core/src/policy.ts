import type { Policy, Role, JobRequest, MediaInfo } from '../../contracts/src/index.ts';
export function defaultPolicy(role:Role):Policy {return {upload:true,download:true,process:role!=='restricted-guest',expensiveFilters:role!=='restricted-guest',maxInputBytes:1024**3,maxOutputBytes:1024**3,maxDuration:7200,maxPixels:3840*2160,maxQueued:50,concurrency:1,maxRuntimeSeconds:1800,diskBytes:10*1024**3,retentionHours:168,allowedSites:[],allowedInputCodecs:[],allowedOutputCodecs:[],allowedEncoders:[],maxCpuCores:2,maxMemoryMiB:1024,bandwidthBytesPerSecond:50*1024**2,maxTransferBytes:2*1024**3};}
export function enforceMedia(media:MediaInfo,policy:Policy){
 if(!Number.isFinite(media.duration)||media.duration<=0||media.duration>policy.maxDuration)throw Error('Media duration exceeds policy or is invalid');
 if(media.size>policy.maxInputBytes)throw Error('Media bytes exceed policy');
 if(media.streams.some(s=>(s.width||0)*(s.height||0)>policy.maxPixels))throw Error('Media resolution exceeds policy');
 if(policy.allowedInputCodecs?.length&&media.streams.some(s=>['video','audio'].includes(s.type)&&!policy.allowedInputCodecs.includes(s.codec)))throw Error('Input codec is not allowed by policy');
}
export function enforceJob(request:JobRequest,policy:Policy){
 if(request.type==='download'){if(!policy.download)throw Error('Download permission required');return;}
 if(!policy.process)throw Error('Processing permission required');
 if(request.type==='proxy'&&!policy.expensiveFilters)throw Error('Preview proxy encoding is not permitted');
 if(request.type==='export'){
  const {recipe:r,options:o}=request;
  if(policy.allowedOutputCodecs?.length&&o.cut!=='copy'&&!policy.allowedOutputCodecs.includes(o.codec))throw Error('Output codec is not allowed by policy');
  if(!policy.expensiveFilters&&(r.crop||r.resize||r.rotate||r.caption?.text.trim()||r.text.length||r.captions.length||r.overlays.length||r.audio.normalize||r.audio.volume!==1||r.audio.fadeIn||r.audio.fadeOut||r.audio.mode==='replace'||r.audio.mode==='mix'||o.cut!=='copy'))throw Error('Expensive processing is not permitted');
  if(o.maxBytes&&o.maxBytes>policy.maxOutputBytes)throw Error('Output limit exceeds policy');
  if(r.resize&&r.resize.width*r.resize.height>policy.maxPixels)throw Error('Output resolution exceeds policy');
  if(r.segments.reduce((sum,s)=>sum+s.out-s.in,0)>policy.maxDuration)throw Error('Output duration exceeds policy');
 }
}
