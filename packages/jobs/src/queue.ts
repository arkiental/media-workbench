import { mkdir, rm, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import type { Artifact, Source, ToolPaths, EncoderCapability, ExecutionContext, Job, MediaInfo } from '../../contracts/src/index.ts';
import { Store } from './store.ts';
import { enforceJob, enforceMedia } from '../../core/src/policy.ts';
import { createProxy, exportMedia, validateMedia } from '../../media/src/index.ts';
import { downloadMedia, redactError } from '../../../apps/server/src/download.ts';
import { managedPath, overlayPath, publish, registerSource } from '../../../apps/server/src/storage.ts';
import { withCookies } from '../../../apps/server/src/credentials.ts';
import { WORKER_SCRATCH_OVERHEAD_BYTES, type IsolatedWorker } from '../../../apps/server/src/worker.ts';
export class Queue {
 private active=new Map<string,AbortController>();private stopped=false;private timer:NodeJS.Timeout;private running=new Set<Promise<void>>();
 constructor(readonly store:Store,readonly tools:ToolPaths,readonly encoders:EncoderCapability[],readonly testOrigin?:string,readonly worker?:IsolatedWorker,readonly versions:Record<string,string>={}){
  for(const job of store.jobs())if(['preparing','downloading','processing','validating','cancelling'].includes(job.state))store.updateJob(job.id,{state:'interrupted',message:'Service interrupted. Retry restarts this step; partial encodes are not resumed.'});
  this.timer=setInterval(()=>this.tick(),250);this.timer.unref();
 }
 tick(){if(this.stopped)return;const concurrency=this.store.setting('concurrency',1);
  for(const job of this.store.jobs().filter(j=>j.state==='queued')){
   if(this.active.size>=concurrency)break;const user=this.store.user(job.ownerId);if(!user)continue;
   if([...this.active.keys()].filter(id=>this.store.job(id)?.ownerId===job.ownerId).length>=user.policy.concurrency)continue;
   const controller=new AbortController();this.active.set(job.id,controller);const p=this.execute(job,controller).finally(()=>{this.active.delete(job.id);this.running.delete(p);});this.running.add(p);
  }
 }
 cancel(id:string,owner:string){const job=this.store.job(id,owner);if(!job)throw Error('Job not found');if(['completed','failed','cancelled','interrupted'].includes(job.state))return job;
  if(this.active.has(id)){this.store.updateJob(id,{state:'cancelling'});this.active.get(id)!.abort();return this.store.job(id)!;}
  return this.store.updateJob(id,{state:'cancelled',message:'Cancelled before execution'});
 }
 retry(id:string,owner:string){const job=this.store.job(id,owner);if(!job)throw Error('Job not found');if(!['failed','cancelled','interrupted'].includes(job.state))throw Error('Only failed, cancelled or interrupted jobs can retry');
  const updated=this.store.updateJob(id,{state:'queued',progress:0,error:undefined,message:'Restarting the operation from its source',attempt:job.attempt+1});this.tick();return updated;
 }
 async stop(){this.stopped=true;clearInterval(this.timer);for(const c of this.active.values())c.abort();await Promise.allSettled([...this.running]);}
 private async execute(job:Job,controller:AbortController){
  const workDir=path.join(this.store.dataDir,'work',job.id);let artifact:Artifact|undefined;const reservation=this.store.reserve(job.ownerId);
  const started=Date.now();let timedOut=false;const deadline=setTimeout(()=>{timedOut=true;controller.abort();},(this.store.user(job.ownerId)?.policy.maxRuntimeSeconds||600)*1000);
  try{
   this.store.updateJob(job.id,{state:'preparing',message:undefined,toolVersions:this.versions});
   if((await lstat(path.dirname(workDir))).isSymbolicLink())throw Error('Unsafe work directory');
   if(path.dirname(path.resolve(workDir))!==path.resolve(this.store.dataDir,'work'))throw Error('Unsafe job directory');
   await rm(workDir,{recursive:true,force:true});await mkdir(workDir,{recursive:false,mode:0o700});
   const user=this.store.user(job.ownerId)!;const request=job.request;enforceJob(request,user.policy);
   const copyScratch=request.type==='export'&&request.options.cut!=='exact'&&request.recipe.segments.length>1?2:1;
   const available=this.store.availableBytes(user.id),remaining=this.worker?Math.floor(available/3)-WORKER_SCRATCH_OVERHEAD_BYTES:Math.floor(available/copyScratch);if(remaining<=0)throw Error('Insufficient storage for bounded worker scratch');
   let ctx:ExecutionContext={signal:controller.signal,workDir,maxRuntimeSeconds:user.policy.maxRuntimeSeconds,maxBytes:Math.min(request.type==='download'?user.policy.maxInputBytes:user.policy.maxOutputBytes,remaining),allowedEncoders:user.policy.allowedEncoders,maxCpuCores:!this.worker&&user.role==='owner'?availableParallelism():user.policy.maxCpuCores,maxMemoryMiB:user.policy.maxMemoryMiB,bandwidthBytesPerSecond:user.policy.bandwidthBytesPerSecond,maxTransferBytes:user.policy.maxTransferBytes,onPlan:plan=>this.store.updateJob(job.id,{plan}),onProgress:(progress,message)=>{if(!controller.signal.aborted)this.store.updateJob(job.id,{progress,message});},onStage:state=>{if(!controller.signal.aborted)this.store.updateJob(job.id,{state});}};
   reservation.add(this.worker?3*(ctx.maxBytes!+WORKER_SCRATCH_OVERHEAD_BYTES):copyScratch*ctx.maxBytes!);
   const overlayImages:Record<string,string>={};if(request.type==='export')for(const o of request.recipe.overlays){if(!this.store.get('overlay',o.imageId,user.id))throw Error('Overlay image not found');overlayImages[o.imageId]=await overlayPath(this.store,o.imageId);}
   if(this.worker){const ids=request.type==='export'?[request.recipe.sourceId,request.recipe.audio.sourceId]:request.type==='proxy'?[request.sourceId]:[];const inputs=[];for(const id of ids){if(!id)continue;const s=this.store.get<Source>('source',id,user.id);if(!s)throw Error('Source not found');inputs.push(await managedPath(this.store,s.artifactId));}inputs.push(...Object.values(overlayImages));ctx=await this.worker.context(ctx,inputs);}
   let staged:string,name:string,kind:Artifact['kind'],sourceId:string|undefined,verifiedMedia:MediaInfo|undefined;
   if(request.type==='download'){
    const result=await withCookies(this.store,user.id,request.download.cookieId,workDir,opts=>downloadMedia(request.download,this.tools,{...ctx,...opts,policy:{...user.policy,maxInputBytes:Math.min(user.policy.maxInputBytes,remaining)},testOrigin:this.testOrigin}));staged=result.path;name=result.name;kind='download';
   } else {
    const sid=request.type==='export'?request.recipe.sourceId:request.sourceId;const source=this.store.get<Source>('source',sid,user.id);if(!source)throw Error('Source not found');const original=this.store.get<Artifact>('artifact',source.artifactId,user.id);if(!original)throw Error('Original artifact not found');
    const input=await managedPath(this.store,original.id);enforceMedia(original.media,user.policy);this.store.lease(original.id,(user.policy.maxRuntimeSeconds+60)*1000);sourceId=source.id;
    staged=path.join(workDir,request.type==='export'?'output.'+request.options.container:'proxy.mp4');name=request.type==='export'?'clip.'+request.options.container:'preview.mp4';kind=request.type==='export'?'export':'proxy';
    this.store.updateJob(job.id,{state:'processing'});
    if(request.type==='proxy')verifiedMedia=await createProxy(input,staged,this.tools,ctx);
    else {let extraAudio:string|undefined;if(request.recipe.audio.sourceId){const audio=this.store.get<Source>('source',request.recipe.audio.sourceId,user.id);if(!audio)throw Error('Audio source not found');extraAudio=await managedPath(this.store,audio.artifactId);this.store.lease(audio.artifactId,(user.policy.maxRuntimeSeconds+60)*1000);}
     const result=await exportMedia(input,staged,request.recipe,request.options,this.tools,ctx,extraAudio,overlayImages);verifiedMedia=result.media;this.store.updateJob(job.id,{plan:result.plan});
    }
   }
   if(controller.signal.aborted)throw Error('Operation cancelled');this.store.updateJob(job.id,{state:'validating'});
   const media=verifiedMedia??await validateMedia(staged,this.tools,ctx);enforceMedia(media,{...user.policy,allowedInputCodecs:request.type==='download'?user.policy.allowedInputCodecs:user.policy.allowedOutputCodecs,maxInputBytes:request.type==='download'?user.policy.maxInputBytes:user.policy.maxOutputBytes});
   if(media.size>remaining)throw Error('Storage quota exceeded');if(controller.signal.aborted)throw Error('Operation cancelled');
   artifact=await publish(this.store,staged,user.id,name,media,kind,job.id,sourceId,reservation);artifact.expiresAt=new Date(Date.now()+user.policy.retentionHours*3600000).toISOString();this.store.put('artifact',artifact.id,user.id,artifact);
   if(request.type==='download')sourceId=registerSource(this.store,artifact,request.download.url).id;
   this.store.updateJob(job.id,{state:'completed',artifactId:artifact.id,sourceId,progress:1,message:'Output validated and published'});
  }catch(error){this.store.updateJob(job.id,{state:timedOut?'failed':controller.signal.aborted?'cancelled':'failed',error:timedOut?'Job exceeded total runtime policy':controller.signal.aborted?undefined:redactError(error),message:controller.signal.aborted?'Owned tools stopped; no partial artifact published':undefined});}
  finally{clearTimeout(deadline);this.store.updateJob(job.id,{resourceUsage:{elapsedMs:Date.now()-started}});const root=path.resolve(this.store.dataDir,'work');const target=path.resolve(workDir);if(path.dirname(target)===root)await rm(target,{recursive:true,force:true}).catch(()=>{});reservation.release();}
 }
}
