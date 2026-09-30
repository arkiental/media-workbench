import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp,mkdir,writeFile,readFile,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { IsolatedWorker } from '../apps/server/src/worker.ts';
import { runProcess,discoverTools } from '../packages/media/src/index.ts';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test('independent running Docker worker has restricted mounts/resources and cancellation removes its real container',{skip:process.env.MW_TEST_ISOLATION!=='1',timeout:60000},async()=>{
 const review=path.resolve('test-output/review');await mkdir(review,{recursive:true});const root=await mkdtemp(path.join(review,'worker-'));const work=path.join(root,'work');await mkdir(work);
 const sibling=path.join(root,'other-user-secret'),input=path.join(root,'explicit-input');await writeFile(sibling,'private sibling unchanged');await writeFile(input,'selected input');
 const image=(await runProcess('docker',['image','inspect',process.env.MW_WORKER_IMAGE||'media-workbench:local','--format','{{.Id}}'])).stdout.toString().trim();
 const label=`review-${randomUUID()}`,worker=new IsolatedWorker({image,ownerLabel:label,memoryMiB:128,cpus:.5}),tools=await discoverTools(),controller=new AbortController();
 const ctx=await worker.context({workDir:work,signal:controller.signal,maxRuntimeSeconds:30,maxBytes:1024*1024},[input]);
 const script="const fs=require('fs');let dataWritable=false;try{fs.writeFileSync('/data/review-volume-escape','must fail');dataWritable=true}catch{};console.log(JSON.stringify({uid:process.getuid(),input:fs.readFileSync('/inputs/0','utf8'),dataWritable,mounts:fs.readFileSync('/proc/self/mountinfo','utf8')}));setInterval(()=>fs.appendFileSync('/work/heartbeat','x'),50)";
 const operation=runProcess(tools.node!,['-e',script],ctx).then(()=>({error:''}),error=>({error:String(error)}));let container='';
 try{
  let started:any;for(let i=0;i<100;i++){
   const ids=(await runProcess('docker',['ps','-q','--filter',`label=com.mediaworkbench.owner=${label}`,'--filter','name=mw-worker-'])).stdout.toString().trim().split(/\s+/).filter(Boolean);
   if(ids.length){assert.equal(ids.length,1);container=ids[0];const logs=(await runProcess('docker',['logs',container])).stdout.toString().trim();if(logs){started=JSON.parse(logs);break;}}
   await pause(100);
  }assert(started,'actual worker must start before cancellation');assert.match(container,/^[a-f0-9]+$/);
  const info=JSON.parse((await runProcess('docker',['inspect',container])).stdout.toString())[0];const host=info.HostConfig;
  assert.equal(host.NetworkMode,'none');assert.equal(host.ReadonlyRootfs,true);assert.equal(info.Config.User,'1000:1000');assert.deepEqual(host.CapDrop,['ALL']);assert(host.SecurityOpt.includes('no-new-privileges'));assert.equal(host.PidsLimit,128);assert.equal(host.Memory,128*1024*1024);assert.equal(host.NanoCpus,500000000);
  const binds=info.Mounts.filter((m:any)=>m.Type==='bind');assert.equal(binds.length,1,'only selected files may be host binds');assert.deepEqual(binds.map((m:any)=>[m.Destination,m.RW]),[['/inputs/0',false]]);
  for(const mount of info.Mounts)if(mount.RW)assert(['/work','/tmp'].includes(mount.Destination),`unexpected writable mount ${mount.Destination}`);
  const scratch=info.Mounts.find((m:any)=>m.Destination==='/work');assert.equal(scratch.Type,'volume');const volumeInfo=JSON.parse((await runProcess('docker',['volume','inspect',scratch.Name])).stdout.toString())[0];assert.equal(volumeInfo.Options.type,'tmpfs');assert.match(volumeInfo.Options.o,/size=/,'work volume must have a kernel filesystem byte ceiling');
  assert.equal(started.uid,1000);assert.equal(started.input,'selected input');assert.equal(started.dataWritable,false,'image-declared /data must not provide a writable quota escape');
  controller.abort();const outcome=await operation;assert.match(outcome.error,/cancel/i);
  const remaining=(await runProcess('docker',['ps','-aq','--filter',`label=com.mediaworkbench.owner=${label}`])).stdout.toString().trim();assert.equal(remaining,'','abort must remove daemon-owned containers');
  await pause(350);assert.deepEqual(await readdir(work),[],'cancelled scratch must never be copied back to the host');const volumes=(await runProcess('docker',['volume','ls','-q','--filter',`label=com.mediaworkbench.owner=${label}`])).stdout.toString().trim();assert.equal(volumes,'','all per-invocation scratch volumes must be removed');assert.equal(await readFile(sibling,'utf8'),'private sibling unchanged');
  await writeFile(path.join(root,'evidence.json'),JSON.stringify({image,container,hostConfig:host,mounts:info.Mounts,volumeInfo,started:{uid:started.uid,input:started.input,dataWritable:started.dataWritable},cancellation:outcome.error,remaining,volumes,copybackFiles:await readdir(work)},null,2));
 }finally{controller.abort();await operation;await worker.recover();}
});

test('independent cancellation during downloader proxy preparation leaves no owned container or volume',{skip:process.env.MW_TEST_ISOLATION!=='1',timeout:45000},async()=>{
 const review=path.resolve('test-output/review');await mkdir(review,{recursive:true});const work=await mkdtemp(path.join(review,'worker-preparation-'));
 const image=(await runProcess('docker',['image','inspect',process.env.MW_WORKER_IMAGE||'media-workbench:local','--format','{{.Id}}'])).stdout.toString().trim(),label=`review-${randomUUID()}`;
 const worker=new IsolatedWorker({image,ownerLabel:label,proxyPath:path.resolve('deploy/egress/proxy.mjs'),relayPath:path.resolve('deploy/egress/relay.mjs')}),tools=await discoverTools(),controller=new AbortController();
 const ctx=await worker.context({workDir:work,signal:controller.signal,maxRuntimeSeconds:20,maxBytes:1024*1024});
 const operation=runProcess(tools.ytdlp,['--version'],ctx).then(()=>({error:''}),error=>({error:String(error)}));let preparing='';
 try{
  for(let i=0;i<100;i++){preparing=(await runProcess('docker',['ps','-q','--filter',`label=com.mediaworkbench.owner=${label}`,'--filter','name=mw-egress-'])).stdout.toString().trim();if(preparing)break;await pause(50);}assert(preparing,'a real named proxy/init must start before cancellation');controller.abort();const result=await operation;assert.match(result.error,/cancel/i);await pause(500);
  for(const args of [['ps','-aq'],['volume','ls','-q']])assert.equal((await runProcess('docker',[...args,'--filter',`label=com.mediaworkbench.owner=${label}`])).stdout.toString().trim(),'','cancelled proxy startup must clean every owned resource');
  await writeFile(path.join(work,'evidence.json'),JSON.stringify({image,preparing,result,remainingContainers:[],remainingVolumes:[]},null,2));
 }finally{controller.abort();await operation;await worker.recover();}
});

test('independent worker rejects a completed scratch write exceeding its byte allowance',{skip:process.env.MW_TEST_ISOLATION!=='1',timeout:30000},async()=>{
 const review=path.resolve('test-output/review');await mkdir(review,{recursive:true});const work=await mkdtemp(path.join(review,'worker-quota-'));
 const image=(await runProcess('docker',['image','inspect',process.env.MW_WORKER_IMAGE||'media-workbench:local','--format','{{.Id}}'])).stdout.toString().trim();
 const worker=new IsolatedWorker({image}),tools=await discoverTools(),ctx=await worker.context({workDir:work,signal:new AbortController().signal,maxRuntimeSeconds:10,maxBytes:1024});
 await assert.rejects(runProcess(tools.node!,['-e',"require('fs').writeFileSync('/work/oversized-scratch',Buffer.alloc(16*1024*1024))"],ctx),/quota|byte|limit|failed/i,'a fast completed writer must not evade the periodic resource monitor');
});

test('independent worker refuses an image with an undeclared writable volume',{skip:process.env.MW_TEST_ISOLATION!=='1',timeout:60000},async()=>{
 const tag=`mw-review-implicit-volume-${randomUUID()}`,base=process.env.MW_WORKER_IMAGE||'media-workbench:local';assert.match(base,/^[a-zA-Z0-9._:/@-]+$/);
 const review=path.resolve('test-output/review');await mkdir(review,{recursive:true});const work=await mkdtemp(path.join(review,'worker-volume-image-'));
 try{
  await runProcess('docker',['build','-t',tag,'-'],undefined,{stdin:`FROM ${base}\nVOLUME ["/unexpected-review-volume"]\n`,maxStdoutBytes:2*1024*1024});
  const image=(await runProcess('docker',['image','inspect',tag,'--format','{{.Id}}'])).stdout.toString().trim(),worker=new IsolatedWorker({image});
  await assert.rejects(worker.context({workDir:work,signal:new AbortController().signal,maxRuntimeSeconds:10,maxBytes:1024}),/implicit writable volumes/i);
 }finally{await runProcess('docker',['image','rm','--no-prune',tag]).catch(()=>{});}
});
