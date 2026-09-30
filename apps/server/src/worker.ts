import path from 'node:path';
import { lstat, realpath, readdir, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ExecutionContext, NativeRunOptions } from '../../../packages/contracts/src/index.ts';
import { runProcess } from '../../../packages/media/src/process.ts';

export type WorkerConfig={image:string;proxyVolume?:string;relayPath?:string;proxyPath?:string;memoryMiB?:number;cpus?:number;ownerLabel?:string};
export const WORKER_SCRATCH_OVERHEAD_BYTES=8*1024*1024;
type Manifest={files:{name:string;bytes:number}[];directories:string[];bytes:number};
const MAX_ENTRIES=10000;
const helperScript=`const fs=require('fs'),path=require('path');const max=Number(process.argv[1]);let bytes=0,count=0;const files=[],directories=[];function visit(dir,prefix=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(++count>10000)throw Error('Worker scratch entry limit exceeded');const name=entry.name;if(!name||/[\\\\:\\x00-\\x1f]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)/i.test(name))throw Error('Unsafe worker scratch filename');const full=path.join(dir,name),relative=prefix+name,info=fs.lstatSync(full);if(info.isSymbolicLink())throw Error('Worker created a forbidden symlink');if(info.isDirectory()){directories.push(relative);visit(full,relative+'/');}else if(info.isFile()&&info.nlink===1){bytes+=info.size;if(bytes>max)throw Error('Worker scratch byte quota exceeded');files.push({name:relative,bytes:info.size});}else throw Error('Worker created a forbidden special file or hard link');}}visit('/work');process.stdout.write(JSON.stringify({files,directories,bytes}));`;
const ownershipScript=`const fs=require('fs'),path=require('path');function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name),info=fs.lstatSync(full);if(info.isSymbolicLink())throw Error('Unsafe staged symlink');if(info.isDirectory()){visit(full);fs.chownSync(full,0,0);fs.chmodSync(full,0o700);fs.chownSync(full,1000,1000);}else if(info.isFile()){fs.chownSync(full,0,0);fs.chmodSync(full,0o600);fs.chownSync(full,1000,1000);}else throw Error('Unsafe staged special file');}}visit('/work');fs.chownSync('/work',0,0);fs.chmodSync('/work',0o700);fs.chownSync('/work',1000,1000);`;

/** Trusted host configuration only; API clients cannot choose images, mounts or tools. */
export class IsolatedWorker {
 private imageCheck?:Promise<void>;
 constructor(readonly config:WorkerConfig){if(!/^sha256:[a-f0-9]{64}$/.test(config.image))throw Error('Worker image must be an inspected immutable Docker image ID');}
 private labels(kind:string){return ['--label',`com.mediaworkbench.kind=${kind}`,...(this.config.ownerLabel?['--label',`com.mediaworkbench.owner=${this.config.ownerLabel}`]:[])];}
 private hostContext(ctx?:ExecutionContext,maxRuntimeSeconds=30):ExecutionContext{return {signal:ctx?.signal||new AbortController().signal,workDir:ctx?.workDir||process.cwd(),maxRuntimeSeconds};}
 private command(args:string[],ctx?:ExecutionContext,maxRuntimeSeconds=30){return runProcess('docker',args,this.hostContext(ctx,maxRuntimeSeconds),{maxStdoutBytes:2*1024*1024,maxStderrBytes:32768});}
 private async imageSafe(){
  this.imageCheck??=(async()=>{const raw=(await this.command(['image','inspect',this.config.image,'--format','{{json .Config}}'])).stdout.toString();const volumes=JSON.parse(raw).Volumes;if(volumes&&Object.keys(volumes).length)throw Error('Worker image declares implicit writable volumes; rebuild without Dockerfile VOLUME before enabling shared hosting.');})();
  return this.imageCheck;
 }
 async recover(){
  if(!this.config.ownerLabel)return;const label=`com.mediaworkbench.owner=${this.config.ownerLabel}`;
  const list=(await this.command(['ps','-aq','--filter',`label=${label}`])).stdout.toString().trim().split(/\s+/).filter(Boolean);if(list.some(id=>! /^[a-f0-9]{12,64}$/.test(id)))throw Error('Invalid Docker recovery response');
  if(list.length)await this.command(['rm','-f',...list]);
  const volumes=(await this.command(['volume','ls','-q','--filter',`label=${label}`])).stdout.toString().trim().split(/\s+/).filter(Boolean);
  for(const volume of volumes){if(!/^mw-(?:egress|scratch)-[a-z0-9-]+$/.test(volume))throw Error('Unexpected owned Docker volume');await this.command(['volume','rm','-f',volume]);}
 }
 async context(ctx:ExecutionContext,inputs:string[]=[]):Promise<ExecutionContext>{
  await this.imageSafe();const work=await realpath(ctx.workDir);if((await lstat(ctx.workDir)).isSymbolicLink())throw Error('Unsafe worker work directory');
  const files=await Promise.all([...new Set(inputs)].map(async input=>{const s=await lstat(input);if(!s.isFile()||s.isSymbolicLink())throw Error('Worker input must be a regular file');return realpath(input);}));
  let previous:Promise<unknown>=Promise.resolve();
  return {...ctx,runTool:(binary,args,opts)=>{const operation=previous.then(()=>this.execute(binary,args,ctx,work,files,opts));previous=operation.catch(()=>{});return operation;}};
 }
 private async execute(binary:string,args:string[],ctx:ExecutionContext,work:string,inputs:string[],options:NativeRunOptions={}){
  if(ctx.signal.aborted)throw Error('Operation cancelled');
  const name=path.basename(binary).replace(/\.exe$/i,'');const executables:Record<string,string>={ffmpeg:'/usr/bin/ffmpeg',ffprobe:'/usr/bin/ffprobe','yt-dlp':'/usr/local/bin/yt-dlp',node:'/usr/local/bin/node'};
  if(!executables[name])throw Error('Worker executable is not permitted');
  const container=`mw-worker-${randomUUID()}`;const mounts:string[]=[];
  const mount=(source:string,target:string)=>{if(source.includes(',')||target.includes(','))throw Error('Docker mount path contains unsupported comma');mounts.push('--mount',`type=bind,source=${source},target=${target},readonly`);};
  inputs.forEach((file,i)=>mount(file,`/inputs/${i}`));
  const mapPath=(value:string)=>{
   for(const [i,input] of inputs.entries())if(value===input)return `/inputs/${i}`;
   if(value===work)return '/work';if(value.startsWith(work+path.sep))return '/work/'+path.relative(work,value).split(path.sep).join('/');
   if(path.isAbsolute(value)&&!value.startsWith('http')){if(value===path.dirname(binary))return path.dirname(executables[name]);if(value==='NUL'||value==='/dev/null')return '/dev/null';throw Error('Worker argument references an unmounted host path');}
   return value;
  };
  const mapped=args.map((arg,i)=>args[i-1]==='--js-runtimes'?'node:/usr/local/bin/node':args[i-1]==='--ffmpeg-location'?'/usr/bin':mapPath(arg));
  const budget=ctx.maxBytes??1024**3;if(!Number.isSafeInteger(budget)||budget<1||budget>20_000_000_000)throw Error('Invalid worker scratch byte limit');
  const quota=budget+WORKER_SCRATCH_OVERHEAD_BYTES;
  const policy=ctx as ExecutionContext&{maxMemoryMiB?:number;maxCpuCores?:number;maxTransferBytes?:number;bandwidthBytesPerSecond?:number};
  const memory=Math.min(this.config.memoryMiB||1024,policy.maxMemoryMiB||1024),cpus=Math.min(this.config.cpus||2,policy.maxCpuCores||2);
  let scratch:Awaited<ReturnType<IsolatedWorker['startScratch']>>|undefined,cleanupProxy:(()=>Promise<void>)|undefined;
  const destroy=()=>{void this.command(['rm','-f',container]).catch(()=>{});};ctx.signal.addEventListener('abort',destroy,{once:true});
  try {
   scratch=await this.startScratch(ctx,work,quota,inputs);
   const dockerArgs=['run','--rm','--init','--name',container,...this.labels('native-worker'),'--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory',`${memory}m`,'--cpus',String(cpus),'--tmpfs','/tmp:rw,exec,nosuid,nodev,size=256m','--workdir','/work','--mount',`type=volume,source=${scratch.volume},target=/work,volume-nocopy`,...mounts];
   let command=[executables[name],...mapped];
   if(name==='yt-dlp'){
    if(!this.config.relayPath)throw Error('Isolated downloader proxy is unavailable');let volume=this.config.proxyVolume;
    if(!volume){if(!this.config.proxyPath)throw Error('Isolated proxy script missing');const proxy=await this.startProxy(ctx);volume=proxy.volume;cleanupProxy=proxy.close;}
    if(!/^mw-egress-[a-z0-9-]+$/.test(volume))throw Error('Invalid proxy volume');
    dockerArgs.push('--mount',`type=volume,source=${volume},target=/proxy,readonly`,'--mount',`type=bind,source=${path.resolve(this.config.relayPath)},target=/runtime/relay.mjs,readonly`);
    command=['/usr/local/bin/node','/runtime/relay.mjs','--socket','/proxy/egress.sock','--',...command];
   }
   dockerArgs.push('--entrypoint','/usr/bin/timeout',this.config.image,'--signal=TERM','--kill-after=3',String(Math.max(1,ctx.maxRuntimeSeconds||600)),...command);
   const result=await runProcess('docker',dockerArgs,{...ctx,runTool:undefined,maxBytes:undefined},{...options,outputPath:undefined,cwd:work});
   if(ctx.signal.aborted)throw Error('Operation cancelled');
   await scratch.copyBack();return result;
  } finally {ctx.signal.removeEventListener('abort',destroy);await this.command(['rm','-f',container]).catch(()=>{});await cleanupProxy?.();await scratch?.close();}
 }
 private async startScratch(ctx:ExecutionContext,work:string,quota:number,inputs:string[]){
  const volume=`mw-scratch-${randomUUID()}`,anchor=`${volume}-anchor`;let staging:string|undefined;
  const close=async()=>{await this.command(['rm','-f',anchor]).catch(()=>{});await this.command(['volume','rm','-f',volume]).catch(()=>{});if(staging)await rm(staging,{recursive:true,force:true});};
  const stop=()=>{void this.command(['rm','-f',anchor]).catch(()=>{});};ctx.signal.addEventListener('abort',stop,{once:true});
  try {
   await directoryManifest(work,quota);
   await this.command(['volume','create','--driver','local','--opt','type=tmpfs','--opt','device=tmpfs','--opt',`o=size=${quota},nr_inodes=20000,uid=1000,gid=1000,mode=0700,nosuid,nodev,noexec`,...this.labels('scratch-volume'),volume],ctx);
   await this.command(['run','-d','--init','--name',anchor,...this.labels('scratch-anchor'),'--network','none','--read-only','--user','0','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges','--pids-limit','32','--memory','128m','--cpus','0.5','--mount',`type=volume,source=${volume},target=/work,volume-nocopy`,'--entrypoint','/usr/bin/timeout',this.config.image,'--signal=TERM','--kill-after=3',String((ctx.maxRuntimeSeconds||600)+120),'/usr/local/bin/node','-e','setInterval(()=>{},1000)'],ctx);
   await this.command(['cp',`${work}${path.sep}.`,`${anchor}:/work`],ctx,Math.min(ctx.maxRuntimeSeconds||600,600));
   await this.command(['exec','--user','0',anchor,'/usr/local/bin/node','-e',ownershipScript],ctx);
   const copyBack=async()=>{
    const raw=(await this.command(['exec','--user','1000:1000',anchor,'/usr/local/bin/node','-e',helperScript,String(quota)],ctx)).stdout.toString();const manifest=JSON.parse(raw) as Manifest;
    if(!Array.isArray(manifest.files)||manifest.files.length>MAX_ENTRIES||manifest.bytes>quota)throw Error('Invalid scratch manifest');
    const protectedPaths=new Set(inputs.filter(input=>input.startsWith(work+path.sep)).map(input=>path.relative(work,input).split(path.sep).join('/')));
    if(manifest.files.some(file=>protectedPaths.has(file.name)))throw Error('Worker attempted to copy back an immutable input');
    staging=await mkdtemp(path.join(path.dirname(work),'worker-copyback-'));
    await this.command(['cp',`${anchor}:/work/.`,staging],ctx,Math.min(ctx.maxRuntimeSeconds||600,600));
    const staged=await directoryManifest(staging,quota);if(staged.bytes!==manifest.bytes||staged.files.length!==manifest.files.length)throw Error('Scratch copyback manifest changed');
    for(const directory of staged.directories){if(ctx.signal.aborted)throw Error('Operation cancelled');await mkdir(path.join(work,...directory.split('/')),{recursive:true,mode:0o700});}
    for(const file of staged.files){if(ctx.signal.aborted)throw Error('Operation cancelled');await rename(path.join(staging,...file.name.split('/')),path.join(work,...file.name.split('/')));}
   };
   return {volume,copyBack,close:async()=>{ctx.signal.removeEventListener('abort',stop);await close();}};
  }catch(error){ctx.signal.removeEventListener('abort',stop);await close();throw error;}
 }
 private async startProxy(ctx:ExecutionContext){
  const volume=`mw-egress-${randomUUID()}`,container=`${volume}-proxy`,init=`${volume}-init`;
  const policy=ctx as ExecutionContext&{maxTransferBytes?:number;bandwidthBytesPerSecond?:number};
  const close=async()=>{await this.command(['rm','-f',container,init]).catch(()=>{});await this.command(['volume','rm','-f',volume]).catch(()=>{});};
  try {
   await this.command(['volume','create',...this.labels('egress-volume'),volume],ctx);
   await this.command(['run','--rm','--name',init,...this.labels('egress-init'),'--network','none','--read-only','--user','0','--cap-drop','ALL','--cap-add','CHOWN','--mount',`type=volume,source=${volume},target=/proxy`,'--entrypoint','/usr/bin/timeout',this.config.image,'--kill-after=2','10','/bin/chown','1000:1000','/proxy'],ctx);
   await this.command(['run','-d','--init','--name',container,...this.labels('egress-proxy'),'--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','128m','--cpus','0.5','--mount',`type=volume,source=${volume},target=/proxy`,'--mount',`type=bind,source=${path.resolve(this.config.proxyPath!)},target=/runtime/proxy.mjs,readonly`,'-e',`MW_PROXY_MAX_BYTES=${policy.maxTransferBytes||ctx.maxBytes||1024**3}`,...(policy.bandwidthBytesPerSecond?['-e',`MW_PROXY_BYTES_PER_SECOND=${policy.bandwidthBytesPerSecond}`]:[]),'--entrypoint','/usr/bin/timeout',this.config.image,'--signal=TERM','--kill-after=3',String((ctx.maxRuntimeSeconds||600)+30),'/usr/local/bin/node','/runtime/proxy.mjs'],ctx);
   let ready=false;for(let i=0;i<50;i++){if(ctx.signal.aborted)throw Error('Operation cancelled');const logs=await this.command(['logs',container],ctx);if(logs.stdout.includes('egress-ready')){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}if(!ready)throw Error('Isolated proxy did not become ready');return {volume,close};
  }catch(error){await close();throw error;}
 }
}
async function directoryManifest(dir:string,maxBytes:number):Promise<Manifest>{
 const result:Manifest={files:[],directories:[],bytes:0};let count=0;
 const visit=async(current:string,prefix=''):Promise<void>=>{for(const entry of await readdir(current,{withFileTypes:true})){if(++count>MAX_ENTRIES)throw Error('Worker scratch entry limit exceeded');if(!entry.name||/[\\:\x00-\x1f]/.test(entry.name)||/[. ]$/.test(entry.name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(entry.name))throw Error('Unsafe worker scratch filename');const file=path.join(current,entry.name),name=prefix+entry.name,s=await lstat(file);if(s.isSymbolicLink())throw Error('Worker created a forbidden symlink');if(s.isDirectory()){result.directories.push(name);await visit(file,name+'/');}else if(s.isFile()&&s.nlink===1){result.bytes+=s.size;if(result.bytes>maxBytes)throw Error('Worker scratch byte quota exceeded');result.files.push({name,bytes:s.size});}else throw Error('Worker created a forbidden special file or hard link');}};
 await visit(dir);return result;
}
