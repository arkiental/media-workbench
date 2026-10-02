import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { Store } from '../../../packages/jobs/src/store.ts';
import { Queue } from '../../../packages/jobs/src/queue.ts';
import { defaultPolicy, enforceJob, enforceMedia } from '../../../packages/core/src/policy.ts';
import { defaultPreset, effectiveOptions, migratePreset } from '../../../packages/core/src/presets.ts';
import { Id, JobRequestSchema, DownloadSchema, RecipeSchema, ExportSchema, type OverlayImage, type Recipe, type Artifact, type Source, type JobRequest, type ToolPaths, type User, type Policy, type Preset, type Project, type EncoderCapability, type Capabilities } from '../../../packages/contracts/src/index.ts';
import { discoverTools, toolVersions, testEncoders, validateMedia, probeImage, frameIndex, extractFrame, extractThumbnail, waveform, planExport } from '../../../packages/media/src/index.ts';
import { inspectDownload, redactError } from './download.ts';
import { importCookies, registerBrowser, forgetCookies, withCookies } from './credentials.ts';
import { managedPath, overlayPath, publish, registerSource, retention, nativeCopy, deleteArtifact, artifactContentType } from './storage.ts';
import { IsolatedWorker, WORKER_SCRATCH_OVERHEAD_BYTES, type WorkerConfig } from './worker.ts';
import type { ExecutionContext } from '../../../packages/contracts/src/index.ts';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { PolicySchema } from '../../../packages/contracts/src/index.ts';
import { buildOpenAPI } from './openapi.ts';
import { BandwidthLimiter } from './bandwidth.ts';
import { captionLayout } from '../../../packages/contracts/src/caption.ts';

export type ServerOptions={dataDir:string;ownerToken?:string;tools?:ToolPaths;encoders?:EncoderCapability[];host?:string;shared?:boolean;publicOrigin?:string;desktopSecret?:string;testOrigin?:string;startQueue?:boolean;workerConfig?:WorkerConfig;tunnelPrototype?:boolean};
type Auth={user:User;scopes:string[];id:string};
declare module 'fastify' { interface FastifyInstance { store:Store; queue:Queue; tools:ToolPaths; encoders:EncoderCapability[]; } }
const OVERLAY_BYTES=20*1024*1024;
function bad(message:string,statusCode=400){return Object.assign(Error(message),{statusCode});}
const safeEqual=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function createServer(options:ServerOptions){
 const exposed=options.host&&!['127.0.0.1','::1','localhost'].includes(options.host);
 if((options.shared||exposed)&&(!options.shared||!options.workerConfig||!options.ownerToken||!options.publicOrigin?.startsWith('https://')||options.testOrigin))throw Error('Shared hosting is disabled: require isolated workers, explicit owner credential and HTTPS public origin');
 if(options.shared&&(!options.workerConfig?.proxyPath||!options.workerConfig.relayPath||options.workerConfig.proxyVolume))throw Error('Shared hosting is disabled: per-operation mandatory proxy is required');
 if(options.shared){const publicUrl=new URL(options.publicOrigin!);if(publicUrl.protocol!=='https:'||publicUrl.username||publicUrl.password||publicUrl.pathname!=='/'||publicUrl.search||publicUrl.hash)throw Error('Shared public origin must be a bare HTTPS origin');}
 const store=new Store(options.dataDir);const tools=options.tools||await discoverTools();
 const worker=options.workerConfig?new IsolatedWorker({...options.workerConfig,ownerLabel:createHash('sha256').update(store.dataDir).digest('hex').slice(0,24)}):undefined;if(worker)await worker.recover();
 const owner=store.users().find(u=>u.role==='owner')||store.createUser('Local owner','owner');
 // Prototype only: a temporary Cloudflare quick tunnel serves visitors as a limited member, never the owner.
 const tunnelGuest=options.tunnelPrototype?(store.users().find(u=>u.name==='Tunnel guest')||store.createUser('Tunnel guest','member')):undefined;
 if(options.ownerToken){if(!store.auth(options.ownerToken))store.token(owner.id,'Local owner',['read','submit','manage'],options.ownerToken);}
 else if(!store.tokens(owner.id).length){const token=store.token(owner.id,'Local owner');await writeFile(path.join(store.dataDir,'owner-token'),token.token,{mode:0o600});}
 const startupCtx=worker?await worker.context({signal:new AbortController().signal,workDir:path.join(store.dataDir,'cache'),maxRuntimeSeconds:120,maxBytes:200000000}):undefined;
 const versions=await toolVersions(tools,startupCtx);const encoders=options.encoders??await testEncoders(tools,path.join(store.dataDir,'cache'),startupCtx);
 const queue=new Queue(store,tools,encoders,options.testOrigin,worker,versions);if(options.startQueue===false)await queue.stop();
 const app=Fastify({logger:false,bodyLimit:3*1024*1024,requestTimeout:120000,connectionTimeout:30000,forceCloseConnections:true});
 const routes:{method:string;url:string}[]=[];app.addHook('onRoute',route=>{for(const method of Array.isArray(route.method)?route.method:[route.method])if(route.url.startsWith('/api/v1/'))routes.push({method,url:route.url});});
 const bandwidth=new BandwidthLimiter();
 const sessions=new Map<string,{count:number;until:number}>();const activeTransfers=new Map<string,number>();const auxiliary=new Map<string,number>();const responses=new WeakMap<FastifyRequest,FastifyReply>();
 await app.register(cookie);
 app.decorateRequest('auth',null);
 app.setErrorHandler((error,req,reply)=>{const code=error instanceof z.ZodError?400:(error as any).statusCode||400;reply.code(code).send({error:error instanceof z.ZodError?'Invalid request: '+error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ').slice(0,1000):redactError(error)});});
 app.addHook('onRequest',async(req,reply)=>{
  responses.set(req,reply);
  const host=req.headers.host||'';let hostname='';try{hostname=new URL('http://'+host).hostname;}catch{}
  if(!['127.0.0.1','localhost','[::1]',...(options.shared?[new URL(options.publicOrigin!).hostname]:[])].includes(hostname)&&!(options.tunnelPrototype&&/^[a-z0-9-]+\.trycloudflare\.com$/.test(hostname)))throw bad('Host is not permitted',403);
  const origin=req.headers.origin;if(origin&&(options.shared?origin!==options.publicOrigin:origin!==`http://${host}`&&origin!==options.publicOrigin&&!(options.tunnelPrototype&&origin===`https://${host}`)))throw bad('Origin is not permitted',403);
  reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if(!req.url.startsWith('/api/v1/')||req.url==='/api/v1/session')return;
  const bearer=req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];const auth=store.auth(bearer||req.cookies.mw_session||'')||(tunnelGuest&&{user:tunnelGuest,scopes:['read','submit','manage'],id:'tunnel-guest'} as Auth);if(!auth)throw bad('Pairing credential required',401);
  (req as any).auth=auth;reply.header('Cache-Control','no-store');
  const scope=req.method==='GET'?'read':/^\/api\/v1\/(jobs|batches|uploads|overlays|sources\/(?:inspect|from-artifact)|export\/plan)/.test(req.url)?'submit':'manage';if(!auth.scopes.includes(scope))throw bad(`Credential requires ${scope} scope`,403);
 });
 const auth=(r:FastifyRequest)=>(r as any).auth as Auth;
 const ownerOnly=(r:FastifyRequest)=>{if(auth(r).user.role!=='owner')throw bad('Local owner permission required',403);};
 const localOwner=(r:FastifyRequest)=>{ownerOnly(r);if(options.shared||options.tunnelPrototype)throw bad('Local credential and native actions are unavailable in shared hosting',403);};
 const owned=<T>(kind:string,id:string,req:FastifyRequest):T=>{Id.parse(id);if(kind==='artifact'&&store.deletingArtifact(id))throw bad('Artifact deletion is in progress',409);const item=store.get<T>(kind,id,auth(req).user.id);if(!item)throw bad('Not found',404);return item;};
 const sourcePath=async(id:string,req:FastifyRequest)=>{const source=owned<Source>('source',id,req);owned<Artifact>('artifact',source.artifactId,req);return managedPath(store,source.artifactId);};
 const assertSource=(id:string,user:User)=>{const s=store.get<Source>('source',id,user.id);if(!s)throw bad('Source not found',404);const a=store.get<Artifact>('artifact',s.artifactId,user.id);if(!a)throw bad('Original media no longer available',404);if(store.deletingArtifact(a.id))throw bad('Artifact deletion is in progress',409);enforceMedia(a.media,user.policy);return a;};
 const assertOverlays=(recipe:Recipe,user:User)=>{for(const o of recipe.overlays)if(!store.get<OverlayImage>('overlay',o.imageId,user.id))throw bad('Overlay image not found; add the image again',404);};
 function validateRequest(input:unknown,user:User):JobRequest {const request=JobRequestSchema.parse(input);enforceJob(request,user.policy);
  if(request.type==='download'&&request.download.cookieId&&(options.shared||user.role!=='owner'))throw bad('Credentials are local-owner only',403);
  if(request.type==='proxy')assertSource(request.sourceId,user);
  if(request.type==='export'){
   assertSource(request.recipe.sourceId,user);if(request.recipe.audio.sourceId)assertSource(request.recipe.audio.sourceId,user);assertOverlays(request.recipe,user);
   if(request.presetId){const record=store.get<any>('preset',request.presetId,user.id);if(!record)throw bad('Preset not found',404);request.options=effectiveOptions(request.options,record.preset);
    if(record.preset.maxHeight){const a=assertSource(request.recipe.sourceId,user);const v=a.media.streams.find(s=>s.type==='video');if(v){let width=request.recipe.crop?.width||v.width!,height=request.recipe.crop?.height||v.height!;if(Math.abs((v.rotation||0)+request.recipe.rotate)%180===90)[width,height]=[height,width];if(request.recipe.resize){width=request.recipe.resize.width;height=request.recipe.resize.height;}if(height>record.preset.maxHeight){if(request.recipe.resize)throw bad('Explicit output height exceeds preset maximum');const target=Math.floor(record.preset.maxHeight/2)*2;request.recipe.resize={width:Math.max(2,Math.floor(width*target/height/2)*2),height:target};}}}
    enforceJob(request,user.policy);
   }
   const video=assertSource(request.recipe.sourceId,user).media.streams.find(stream=>stream.type==='video');
   if(video){const recipe=request.recipe;let width=recipe.crop?.width||video.width!,height=recipe.crop?.height||video.height!;if(Math.abs(recipe.rotate-(video.rotation||0))%180===90)[width,height]=[height,width];width=recipe.resize?.width||Math.max(2,Math.floor(width/2)*2);height=recipe.resize?.height||Math.max(2,Math.floor(height/2)*2);const header=captionLayout(recipe.caption,width);if(width*(height+header.height)>user.policy.maxPixels)throw bad('Output resolution including caption exceeds policy');}
  }return request;
 }
 function submit(input:unknown,user:User,idem:string,batchId?:string){const submittedRequest=JobRequestSchema.parse(input);const accepted=store.submissionByKey(user.id,idem);if(accepted){if(JSON.stringify(accepted.submittedRequest||accepted.request)!==JSON.stringify(submittedRequest))throw bad('Idempotency key reused with different request');return accepted;}const request=validateRequest(input,user);const existing=store.existingSubmission(user.id,request,idem);if(existing)return existing;if(store.jobs(user.id).filter(j=>!['completed','failed','cancelled','interrupted'].includes(j.state)).length>=user.policy.maxQueued)throw bad('Queue limit reached',429);const record=request.type==='export'&&request.presetId?store.get<any>('preset',request.presetId,user.id):undefined;const result=store.submit(user.id,request,idem,batchId,record?{preset:record.preset,original:record.original}:undefined,submittedRequest);queue.tick();return result.job;}
 const idempotency=(req:FastifyRequest)=>z.string().min(8).max(200).parse(req.headers['idempotency-key']);
 const params=(r:FastifyRequest)=>r.params as {id:string};
 async function auxiliaryWork<T>(req:FastifyRequest,fn:(ctx:ExecutionContext & {storageReservation?:ReturnType<Store['reserve']>})=>Promise<T>){
  const u=auth(req).user;const n=auxiliary.get(u.id)||0;if(n>=2)throw bad('Two preview/inspection operations already active',429);if([...auxiliary.values()].reduce((sum,count)=>sum+count,0)>=4)throw bad('Host preview/upload capacity reached',429);auxiliary.set(u.id,n+1);
  let workDir='';const c=new AbortController();const abort=()=>c.abort();req.raw.on('aborted',abort);const response=responses.get(req)?.raw;response?.on('close',abort);
  const maxRuntimeSeconds=Math.min(120,u.policy.maxRuntimeSeconds);let timedOut=false;const deadline=setTimeout(()=>{timedOut=true;c.abort();},maxRuntimeSeconds*1000);deadline.unref();
  const reservation=worker?store.reserve(u.id):undefined;let releaseSource:(()=>void)|undefined;
  try{const sourceId=/^\/api\/v1\/sources\/([0-9a-f-]{36})\//.exec(req.url)?.[1];if(sourceId){const source=owned<Source>('source',sourceId,req);owned<Artifact>('artifact',source.artifactId,req);releaseSource=store.holdArtifact(source.artifactId);}
   workDir=await mkdtemp(path.join(store.dataDir,'work','inspect-'));const maxBytes=worker?Math.min(u.policy.maxInputBytes,Math.floor(store.availableBytes(u.id)/3)-WORKER_SCRATCH_OVERHEAD_BYTES):u.policy.maxInputBytes;if(maxBytes<=0)throw bad('Insufficient storage for bounded worker scratch',413);reservation?.add(3*(maxBytes+WORKER_SCRATCH_OVERHEAD_BYTES));
   let ctx:ExecutionContext & {storageReservation?:ReturnType<Store['reserve']>}={signal:c.signal,workDir,maxRuntimeSeconds,maxBytes,storageReservation:reservation,allowedEncoders:u.policy.allowedEncoders,maxCpuCores:!worker&&u.role==='owner'?availableParallelism():u.policy.maxCpuCores,maxMemoryMiB:u.policy.maxMemoryMiB,bandwidthBytesPerSecond:u.policy.bandwidthBytesPerSecond,maxTransferBytes:u.policy.maxTransferBytes};if(worker){const sourceId=/^\/api\/v1\/sources\/([0-9a-f-]{36})\//.exec(req.url)?.[1];const artifactId=/^\/api\/v1\/artifacts\/([0-9a-f-]{36})\/thumbnail/.exec(req.url)?.[1];const inputs=sourceId?[await sourcePath(sourceId,req)]:artifactId?[await managedPath(store,artifactId)]:[];ctx=await worker.context(ctx,inputs);}return await fn(ctx);
  }catch(error){if(timedOut)throw bad('Operation exceeded total runtime policy',408);throw error;}finally{clearTimeout(deadline);req.raw.off('aborted',abort);response?.off('close',abort);try{if(workDir)await rm(workDir,{recursive:true,force:true});}finally{releaseSource?.();reservation?.release();auxiliary.set(u.id,(auxiliary.get(u.id)||1)-1);}}
 }
 const previewPermission=(req:FastifyRequest)=>{const p=auth(req).user.policy;if(!p.process||!p.expensiveFilters)throw bad('Preview processing permission required',403);};
 app.post('/api/v1/session',async(req,reply)=>{const key=req.ip;let attempts=sessions.get(key);if(!attempts||attempts.until<Date.now())sessions.set(key,attempts={count:0,until:Date.now()+60000});if(++attempts.count>20)throw bad('Too many pairing attempts',429);
  const {token}=z.object({token:z.string().max(512)}).strict().parse(req.body);const a=store.auth(token);if(!a)throw bad('Invalid or revoked pairing credential',401);reply.setCookie('mw_session',token,{httpOnly:true,sameSite:'strict',path:'/',secure:!!options.shared});return {user:a.user};});
 app.delete('/api/v1/session',async(req,reply)=>{reply.clearCookie('mw_session',{path:'/'});return {ok:true};});
 app.get('/api/v1/capabilities',async(req):Promise<Capabilities>=>({mode:options.shared?'shared':'local',user:auth(req).user,features:['overlays-v1','upload-v1','download-v1','exact-cut-v1','copy-cut-v1','target-size-v1','crop-v1','captions-v1','audio-v1','projects-v1','pairing-v1'],tools:versions,encoders,native:Object.fromEntries(['fileClipboard','nativeDragOut','revealFile','externalActions'].map(k=>[k,{state:'unavailable',reason:options.shared?'Native operations are unavailable on remote visitors':'Use the paired desktop application for native actions'}])),sharedHosting:{enabled:!!options.shared,reason:options.shared?'Every native media operation runs in an isolated networkless Linux worker; downloader egress uses a dedicated filtered socket proxy':'Shared hosting requires explicit Docker worker configuration and HTTPS'}}));
 app.get('/api/v1/sources',async(req)=>store.all<Source>('source',auth(req).user.id));
 app.post('/api/v1/sources/from-artifact',async(req)=>{
  const {artifactId}=z.object({artifactId:Id}).strict().parse(req.body);
  const artifact=owned<Artifact>('artifact',artifactId,req),user=auth(req).user;
  if(!user.policy.process)throw bad('Editing permission required',403);
  if(!artifact.validated)throw bad('Media is not ready for editing',409);
  enforceMedia(artifact.media,user.policy);await managedPath(store,artifact.id);
  return store.all<Source>('source',user.id).find(source=>source.artifactId===artifact.id)||registerSource(store,artifact);
 });
 app.get('/api/v1/artifacts',async(req)=>store.all<Artifact>('artifact',auth(req).user.id).reverse().sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)));
 app.addContentTypeParser('application/octet-stream',(req,payload,done)=>done(null,payload));
 app.post('/api/v1/uploads',async(req)=>{
  const user=auth(req).user;if(!user.policy.upload)throw bad('Upload permission required',403);const name=z.string().min(1).max(200).parse(req.headers['x-filename']?decodeURIComponent(String(req.headers['x-filename'])):'imported-media');
  return auxiliaryWork(req,async(ctx)=>{const file=path.join(ctx.workDir,'upload');const limit=Math.min(ctx.maxBytes||user.policy.maxInputBytes,ctx.storageReservation?Number.MAX_SAFE_INTEGER:store.availableBytes(user.id));let bytes=0;const reservation=ctx.storageReservation||store.reserve(user.id);
   const limiter=new Transform({transform(chunk,encoding,cb){try{bytes+=chunk.length;if(bytes>limit)throw bad('Upload/storage byte limit exceeded',413);if(!ctx.storageReservation)reservation.add(chunk.length);cb(null,chunk);}catch(error){cb(error as Error);}}});
   const input=req.body as import('node:stream').Readable;input.pipe(limiter);
   try{await pipeline(limiter,bandwidth.stream(user.id,user.policy.bandwidthBytesPerSecond,user.policy.maxTransferBytes),createWriteStream(file,{flags:'wx',mode:0o600}),{signal:ctx.signal});const media=await validateMedia(file,tools,ctx);enforceMedia(media,user.policy);const artifact=await publish(store,file,user.id,name,media,'original',undefined,undefined,reservation);return registerSource(store,artifact);}catch(error){input.unpipe(limiter);input.resume();throw error;}finally{if(!ctx.storageReservation)reservation.release();}});
 });
 // Overlay images are PNG only: the browser normalises pasted or chosen images before upload.
 app.addContentTypeParser('image/png',(req,payload,done)=>done(null,payload));
 app.post('/api/v1/overlays',async(req)=>{
  const user=auth(req).user;if(!user.policy.upload)throw bad('Upload permission required',403);const name=z.string().min(1).max(200).parse(req.headers['x-filename']?decodeURIComponent(String(req.headers['x-filename'])):'Image');
  if(store.all<OverlayImage>('overlay',user.id).length>=200)throw bad('Overlay image limit reached',429);
  return auxiliaryWork(req,async ctx=>{const file=path.join(ctx.workDir,'overlay.png');const limit=Math.min(OVERLAY_BYTES,store.availableBytes(user.id));let bytes=0;
   const limiter=new Transform({transform(chunk,encoding,cb){bytes+=chunk.length;cb(bytes>limit?bad('Overlay image is too large (20 MB maximum)',413):null,chunk);}});
   const input=req.body as import('node:stream').Readable;input.pipe(limiter);
   try{await pipeline(limiter,bandwidth.stream(user.id,user.policy.bandwidthBytesPerSecond,user.policy.maxTransferBytes),createWriteStream(file,{flags:'wx',mode:0o600}),{signal:ctx.signal});}catch(error){input.unpipe(limiter);input.resume();throw error;}
   const head=await readFile(file);if(!head.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))throw bad('Overlay must be a PNG image',415);
   const {width,height}=await probeImage(file,tools,ctx);if(width>8192||height>8192||width*height>user.policy.maxPixels)throw bad('Overlay image resolution exceeds policy',413);
   const id=randomUUID();await writeFile(await overlayPath(store,id),head,{flag:'wx',mode:0o600});
   return store.put<OverlayImage>('overlay',id,user.id,{id,ownerId:user.id,name,width,height,bytes:head.length,createdAt:new Date().toISOString()});});
 });
 app.get('/api/v1/overlays/:id/content',async(req,reply)=>{const image=owned<OverlayImage>('overlay',params(req).id,req);return reply.header('Cache-Control','private, max-age=86400, immutable').type('image/png').send(await readFile(await overlayPath(store,image.id)));});
 app.post('/api/v1/sources/inspect',async(req)=>{const request=DownloadSchema.parse(req.body);const user=auth(req).user;if(!user.policy.download)throw bad('Download permission required',403);if(request.cookieId)localOwner(req);return auxiliaryWork(req,ctx=>withCookies(store,user.id,request.cookieId,ctx.workDir,opts=>inspectDownload(request,tools,{...ctx,...opts,policy:user.policy,testOrigin:options.testOrigin})));});
 app.get('/api/v1/jobs',async(req)=>store.jobs(auth(req).user.id));
 app.get('/api/v1/jobs/:id',async(req)=>{const job=store.job(params(req).id,auth(req).user.id);if(!job)throw bad('Job not found',404);return job;});
 app.post('/api/v1/jobs',async(req,reply)=>{const job=submit(req.body,auth(req).user,idempotency(req));reply.code(202);return job;});
 app.delete('/api/v1/jobs/:id',async(req)=>{const user=auth(req).user;const job=store.job(Id.parse(params(req).id),user.id);if(!job)throw bad('Job not found',404);if(!['completed','failed','cancelled','interrupted'].includes(job.state))throw bad('Active job history cannot be deleted',409);store.deleteJob(job.id,user.id);return {deleted:job.id,mediaRetained:true};});
 app.post('/api/v1/jobs/:id/cancel',async(req)=>queue.cancel(params(req).id,auth(req).user.id));
 app.post('/api/v1/jobs/:id/retry',async(req)=>{const user=auth(req).user;const job=store.job(params(req).id,user.id);if(!job)throw bad('Job not found',404);validateRequest(job.request.type==='export'?{...job.request,presetId:undefined}:job.request,user);if(store.jobs(user.id).filter(j=>j.state==='queued').length>=user.policy.maxQueued)throw bad('Queue limit reached',429);return queue.retry(job.id,user.id);});
 app.post('/api/v1/jobs/reorder',async(req)=>{const {ids}=z.object({ids:z.array(Id).max(1000)}).strict().parse(req.body);for(const [i,id] of ids.entries()){const j=store.job(id,auth(req).user.id);if(!j||j.state!=='queued')throw bad('Only your pending jobs can be reordered');}ids.forEach((id,i)=>store.updateJob(id,{position:Date.now()+i}));return store.jobs(auth(req).user.id);});
 app.post('/api/v1/batches',async(req,reply)=>{const {items}=z.object({items:z.array(DownloadSchema).min(1).max(100)}).strict().parse(req.body);const user=auth(req).user;const idem=idempotency(req);const old=store.all<any>('batch',user.id).find(b=>b.idem===idem);if(old){if(JSON.stringify(old.items)!==JSON.stringify(items))throw bad('Idempotency key reused with different batch');return {id:old.id,jobs:store.jobs(user.id).filter(j=>j.batchId===old.id)};}
  if(store.jobs(user.id).filter(j=>!['completed','failed','cancelled','interrupted'].includes(j.state)).length+items.length>user.policy.maxQueued)throw bad('Batch exceeds queue limit',429);items.forEach(download=>validateRequest({type:'download',download},user));
  const id=randomUUID();store.put('batch',id,user.id,{id,idem,items});const jobs=items.map((download,i)=>submit({type:'download',download},user,`${idem}:${i}`,id));reply.code(202);return {id,jobs};});
 for(const action of ['cancel','retry'] as const)app.post(`/api/v1/batches/:id/${action}`,async(req)=>{owned('batch',params(req).id,req);const user=auth(req).user;const jobs=store.jobs(user.id).filter(j=>j.batchId===params(req).id);if(action==='retry'){const retrying=jobs.filter(j=>['failed','cancelled','interrupted'].includes(j.state));const active=store.jobs(user.id).filter(j=>!['completed','failed','cancelled','interrupted'].includes(j.state));if(active.length+retrying.length>user.policy.maxQueued)throw bad('Retry batch exceeds queue capacity',429);retrying.forEach(job=>validateRequest(job.request.type==='export'?{...job.request,presetId:undefined}:job.request,user));}for(const job of jobs){if(action==='cancel')queue.cancel(job.id,user.id);else if(['failed','cancelled','interrupted'].includes(job.state))queue.retry(job.id,user.id);}return {id:params(req).id,jobs:store.jobs(user.id).filter(j=>j.batchId===params(req).id)};});
 app.get('/api/v1/history/export',async(req,reply)=>{const rows=store.jobs(auth(req).user.id);if((req.query as any).format==='csv'){const quote=(x:unknown)=>'"'+String(x??'').replace(/"/g,'""').replace(/^[=+@-]/,"'")+'"';reply.type('text/csv').header('Content-Disposition','attachment; filename="history.csv"');return ['id,state,type,createdAt,artifactId,error',...rows.map(j=>[j.id,j.state,j.request.type,j.createdAt,j.artifactId,j.error].map(quote).join(','))].join('\r\n');}return rows;});
 app.get('/api/v1/artifacts/:id/content',async(req,reply)=>{
  const a=owned<Artifact>('artifact',params(req).id,req);const file=await managedPath(store,a.id);const size=(await stat(file)).size;
  let start=0,end=size-1;const range=req.headers.range;if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||!m[1]&&!m[2]){reply.header('Content-Range',`bytes */${size}`);throw bad('Invalid range',416);}if(!m[1])start=Math.max(0,size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}if(start>end||start>=size){reply.header('Content-Range',`bytes */${size}`);throw bad('Range outside artifact',416);}reply.code(206).header('Content-Range',`bytes ${start}-${end}/${size}`);}
  const policy=auth(req).user.policy;if(end-start+1>policy.maxTransferBytes)throw bad('Transfer exceeds byte policy',413);
  const release=store.holdArtifact(a.id);activeTransfers.set(a.id,(activeTransfers.get(a.id)||0)+1);
  const stream=createReadStream(file,{start,end});let released=false;
  const finish=()=>{if(released)return;released=true;release();stream.destroy();activeTransfers.set(a.id,Math.max(0,(activeTransfers.get(a.id)||1)-1));};
  reply.raw.once('close',finish);
  reply.header('Accept-Ranges','bytes').header('Content-Length',end-start+1).type(artifactContentType(a));
  if((req.query as any).download==='1')reply.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`);const limited=bandwidth.stream(a.ownerId,policy.bandwidthBytesPerSecond,policy.maxTransferBytes);stream.on('error',e=>limited.destroy(e));limited.on('close',()=>stream.destroy());stream.pipe(limited);return reply.send(limited);
 });
 app.get('/api/v1/artifacts/:id/thumbnail',async(req,reply)=>{
  const artifact=owned<Artifact>('artifact',params(req).id,req);previewPermission(req);
  if(!artifact.media.streams.some(stream=>stream.type==='video'))throw bad('This file has no video',404);
  const release=store.holdArtifact(artifact.id);
  try{
   const file=await managedPath(store,artifact.id);
   const data=await auxiliaryWork(req,async ctx=>{const target=path.join(ctx.workDir,'thumbnail.jpg');await extractThumbnail(file,target,Math.min(3,artifact.media.duration*.1),tools,ctx);return readFile(target);});
   return reply.header('Cache-Control','private, max-age=3600').type('image/jpeg').send(data);
  }finally{release();}
 });
 app.delete('/api/v1/artifacts/:id',async(req)=>{const artifact=owned<Artifact>('artifact',params(req).id,req);const {confirmOriginal}=z.object({confirmOriginal:z.boolean().optional()}).strict().parse(req.body||{});return deleteArtifact(store,artifact,confirmOriginal);});
 app.patch('/api/v1/artifacts/:id',async(req)=>{const a=owned<Artifact>('artifact',params(req).id,req);const patch=z.object({pinned:z.boolean().optional(),expiresAt:z.string().datetime().optional()}).strict().parse(req.body);return store.put('artifact',a.id,a.ownerId,{...a,...patch});});
 app.get('/api/v1/sources/:id/frames',async(req)=>{const file=await sourcePath(params(req).id,req);previewPermission(req);const around=z.coerce.number().finite().min(0).default(0).parse((req.query as any).around);return auxiliaryWork(req,ctx=>frameIndex(file,tools,around,ctx));});
 app.get('/api/v1/sources/:id/thumb',async(req,reply)=>{const file=await sourcePath(params(req).id,req);previewPermission(req);const pts=z.coerce.number().finite().min(0).parse((req.query as any).pts);const data=await auxiliaryWork(req,async ctx=>{const target=path.join(ctx.workDir,'thumb.jpg');await extractThumbnail(file,target,pts,tools,ctx);return readFile(target);});return reply.type('image/jpeg').header('Cache-Control','private, max-age=3600').send(data);});
 app.get('/api/v1/sources/:id/frame',async(req,reply)=>{const file=await sourcePath(params(req).id,req);previewPermission(req);const pts=z.coerce.number().finite().min(0).parse((req.query as any).pts);const data=await auxiliaryWork(req,async ctx=>{const target=path.join(ctx.workDir,'frame.png');await extractFrame(file,target,pts,tools,ctx);return readFile(target);});return reply.type('image/png').send(data);});
 app.get('/api/v1/sources/:id/waveform',async(req)=>{const file=await sourcePath(params(req).id,req);previewPermission(req);const window=z.object({start:z.coerce.number().min(0).optional(),duration:z.coerce.number().positive().max(60).optional(),points:z.coerce.number().int().min(1).max(2000).optional(),track:z.coerce.number().int().min(0).max(32).optional()}).strict().parse(req.query);return auxiliaryWork(req,ctx=>waveform(file,tools,ctx,window));});
 app.post('/api/v1/export/plan',async(req)=>{const data=z.object({recipe:RecipeSchema,options:ExportSchema,presetId:Id.optional()}).strict().parse(req.body);const user=auth(req).user;const r=validateRequest({type:'export',...data},user);if(r.type!=='export')throw Error('Invalid export');const a=assertSource(r.recipe.sourceId,user);return planExport(r.recipe,r.options,a.media,user.policy.allowedEncoders.length?encoders.filter(e=>user.policy.allowedEncoders.includes(e.name)):encoders);});
 app.get('/api/v1/projects',async(req)=>store.all<Project>('project',auth(req).user.id));
 app.post('/api/v1/projects',async(req)=>{const p=z.object({id:Id.optional(),name:z.string().min(1).max(120),recipe:RecipeSchema,options:ExportSchema}).strict().parse(req.body);const user=auth(req).user;assertSource(p.recipe.sourceId,user);if(p.recipe.audio.sourceId)assertSource(p.recipe.audio.sourceId,user);assertOverlays(p.recipe,user);if(p.id)owned('project',p.id,req);const id=p.id||randomUUID();return store.put('project',id,user.id,{...p,id,updatedAt:new Date().toISOString()});});
 app.delete('/api/v1/projects/:id',async(req)=>{owned('project',params(req).id,req);store.delete('project',params(req).id,auth(req).user.id);return {ok:true};});
 app.get('/api/v1/presets',async(req)=>store.all('preset',auth(req).user.id));
 app.post('/api/v1/presets/validate',async(req)=>migratePreset(req.body));
 app.post('/api/v1/presets/import',async(req)=>{const result=migratePreset(req.body);const id=randomUUID();return store.put('preset',id,auth(req).user.id,{id,...result});});
 app.get('/api/v1/presets/:id',async(req)=>owned<any>('preset',params(req).id,req).preset);
 app.delete('/api/v1/presets/:id',async(req)=>{owned('preset',params(req).id,req);store.delete('preset',params(req).id,auth(req).user.id);return {ok:true};});
 app.get('/api/v1/settings',async(req)=>({concurrency:store.setting('concurrency',1),maxConcurrency:4}));
 app.patch('/api/v1/settings',async(req)=>{ownerOnly(req);const {concurrency}=z.object({concurrency:z.number().int().min(1).max(4)}).strict().parse(req.body);store.setSetting('concurrency',concurrency);store.updateUser(auth(req).user.id,{...auth(req).user.policy,concurrency});return {concurrency,maxConcurrency:4};});
 app.get('/api/v1/cookies',async(req)=>{localOwner(req);return store.all('credential',auth(req).user.id);});
 app.post('/api/v1/cookies/import',async(req)=>{localOwner(req);const {name,content}=z.object({name:z.string().min(1).max(120),content:z.string().max(2*1024*1024)}).strict().parse(req.body);return importCookies(store,auth(req).user.id,name,content);});
 app.post('/api/v1/cookies/browser',async(req)=>{localOwner(req);const {browser,profile}=z.object({browser:z.string(),profile:z.string().optional()}).strict().parse(req.body);return registerBrowser(store,auth(req).user.id,browser,profile);});
 app.delete('/api/v1/cookies/:id',async(req)=>{localOwner(req);await forgetCookies(store,auth(req).user.id,Id.parse(params(req).id));return {ok:true};});
 app.get('/api/v1/pairings',async(req)=>store.tokens(auth(req).user.id));
 app.post('/api/v1/pairings',async(req)=>{const {name,scopes}=z.object({name:z.string().min(1).max(120),scopes:z.array(z.enum(['read','submit','manage'])).min(1).max(3)}).strict().parse(req.body);if(scopes.some(s=>!auth(req).scopes.includes(s)))throw bad('Cannot grant unavailable scopes',403);return store.token(auth(req).user.id,name,scopes);});
 app.delete('/api/v1/pairings/:id',async(req)=>{store.revoke(auth(req).user.id,params(req).id);return {ok:true};});
 app.get('/api/v1/admin/users',async(req)=>{ownerOnly(req);return store.users();});
 app.post('/api/v1/admin/users',async(req)=>{ownerOnly(req);const {name,role}=z.object({name:z.string().min(1).max(120),role:z.enum(['member','restricted-guest'])}).strict().parse(req.body);const user=store.createUser(name,role);return {user,...store.token(user.id,'Initial pairing')};});
 app.patch('/api/v1/admin/users/:id',async(req)=>{ownerOnly(req);const schema=PolicySchema;const {policy}=z.object({policy:schema}).strict().parse(req.body);const user=store.user(Id.parse(params(req).id));if(!user)throw bad('User not found',404);return store.updateUser(user.id,policy);});
 app.post('/api/v1/retention',async(req)=>({removed:await retention(store,auth(req).user.id)}));
 app.get('/api/v1/diagnostics',async(req)=>({tools:versions,encoders,mode:options.shared?'shared':'local',isolatedWorkers:!!worker,sharedHosting:!!options.shared,failures:store.jobs(auth(req).user.id).filter(j=>j.state==='failed').map(j=>({id:j.id,type:j.request.type,error:j.error,updatedAt:j.updatedAt})).slice(-30),telemetry:false}));
 app.get('/api/v1/events',async(req,reply)=>{reply.type('text/event-stream');const jobs=store.jobs(auth(req).user.id);return `event: jobs\ndata: ${JSON.stringify(jobs)}\n\n`;});
 app.get('/api/v1/desktop/artifacts/:id',async(req)=>{localOwner(req);const secret=String(req.headers['x-desktop-secret']||'');if(!options.desktopSecret||!safeEqual(secret,options.desktopSecret))throw bad('Desktop companion pairing required',403);const a=owned<Artifact>('artifact',params(req).id,req);return {path:await nativeCopy(store,a),name:a.name,mediaTypes:a.media.streams.map(s=>s.type).filter(s=>['video','audio'].includes(s))};});
 app.get('/api/v1/openapi.json',async()=>buildOpenAPI(routes));
 const webRoot=path.resolve('dist/web');if(existsSync(path.join(webRoot,'index.html')))await app.register(fastifyStatic,{root:webRoot});else app.get('/',async(req,reply)=>reply.type('text/html').send('<p>Media Workbench service is running. Run npm run build for the browser application.</p>'));
 app.addHook('onClose',async()=>{await queue.stop();store.close();});
 return Object.assign(app,{store,queue,tools,encoders});
}
