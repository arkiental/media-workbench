import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir,mkdtemp,readFile,writeFile,readdir,access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools,exportMedia,runProcess } from '../packages/media/src/index.ts';
import { RecipeSchema,ExportSchema,type ExecutionContext } from '../packages/contracts/src/index.ts';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function directory(){const root=path.resolve('test-output/review');await mkdir(root,{recursive:true});return mkdtemp(path.join(root,'cancellation-'));}

test('independent cancellation of real in-flight yt-dlp closes the transfer and publishes no media',{timeout:45000},async()=>{
 const root=await directory(),tools=await discoverTools(),original=path.join(root,'original.mp4');
 await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=4','-an','-c:v','libx264','-crf','0',original]);const bytes=await readFile(original);
 let delivered=0,closed=0;const fixture=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length});if(req.method==='HEAD'){res.end();return;}let offset=0;const timer=setInterval(()=>{const part=bytes.subarray(offset,offset+1024);offset+=part.length;delivered+=part.length;res.write(part);if(offset===bytes.length){clearInterval(timer);res.end();}},30);res.on('close',()=>{clearInterval(timer);closed++;});});
 await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(fixture.address() as AddressInfo).port}`,ownerToken=randomUUID(),app=await createServer({dataDir:path.join(root,'data'),ownerToken,tools,encoders:[],testOrigin:origin});
 const headers={host:'localhost',authorization:`Bearer ${ownerToken}`};
 try{
  const submitted=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers,'idempotency-key':randomUUID()},payload:{type:'download',download:{url:origin+'/slow.mp4'}}});assert.equal(submitted.statusCode,202,submitted.body);const id=submitted.json().id;
  for(let i=0;i<500&&delivered<4096;i++)await pause(20);assert(delivered>=4096,'real downloader received bytes before cancellation');assert.equal(app.store.job(id)!.state,'downloading');const atCancel=delivered;
  const response=await app.inject({method:'POST',url:`/api/v1/jobs/${id}/cancel`,headers});assert.equal(response.statusCode,200,response.body);
  for(let i=0;i<500&&app.store.job(id)!.state!=='cancelled';i++)await pause(20);assert.equal(app.store.job(id)!.state,'cancelled');assert.equal(app.store.job(id)!.artifactId,undefined);
  for(let i=0;i<100;i++){try{await access(path.join(app.store.dataDir,'work',id));await pause(20);}catch{break;}}
  await assert.rejects(access(path.join(app.store.dataDir,'work',id)));assert(closed>0,'fixture must observe the active connection closing');const stoppedAt=delivered;await pause(200);assert.equal(delivered,stoppedAt);assert(delivered<bytes.length,'cancel must stop before complete media transfer');assert.deepEqual(await readdir(path.join(app.store.dataDir,'artifacts')),[]);assert.deepEqual(await readFile(original),bytes);
  await writeFile(path.join(root,'download-evidence.json'),JSON.stringify({state:'cancelled',atCancel,delivered,sourceBytes:bytes.length,closed,artifactCount:0,originalPreserved:true},null,2));
 }finally{await app.close();fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));}
});

test('independent abort after actual encode and validation progress leaves no published or partial export',{timeout:45000},async()=>{
 const root=await directory(),tools=await discoverTools(),original=path.join(root,'original.mp4');
 await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=4','-an','-c:v','libx264','-crf','0',original]);const bytes=await readFile(original),checks:unknown[]=[];
 for(const target of ['processing','validating']){
  const workDir=path.join(root,target);await mkdir(workDir);const output=path.join(workDir,'must-not-publish.mp4'),controller=new AbortController();let stage='',actualProgress=false;
  const ctx:ExecutionContext={signal:controller.signal,workDir,maxRuntimeSeconds:30,maxBytes:5*1024*1024,onStage:state=>{stage=state;},onProgress:progress=>{if(stage===target&&progress>0){actualProgress=true;controller.abort();}}};
  ctx.runTool=async(binary,args,options)=>{
   const paced=binary===tools.ffmpeg&&(target==='processing'?args.includes('-progress'):stage==='validating'&&args.includes('null'));
   // Test-only real-time input pacing keeps the real subprocess active until it emits decoded/encoded progress.
   const actual=[...args];if(paced){actual.splice(actual.indexOf('-i'),0,'-readrate','1');if(!actual.includes('-progress'))actual.unshift('-progress','pipe:2');}
   return runProcess(binary,actual,{...ctx,runTool:undefined},{...options,...(paced?{duration:4}:{})});
  };
  await assert.rejects(exportMedia(original,output,RecipeSchema.parse({sourceId:randomUUID(),segments:[{in:0,out:4}],audio:{mode:'mute'}}),ExportSchema.parse({cut:'exact',quality:18}),tools,ctx),/cancelled/);assert(actualProgress,`actual ${target} native output must precede cancellation`);await assert.rejects(access(output));assert(!(await readdir(workDir)).some(name=>name.startsWith('.partial-')));assert.deepEqual(await readFile(original),bytes);checks.push({stage:target,actualProgress,published:false,partial:false,originalPreserved:true});
 }
 await writeFile(path.join(root,'media-evidence.json'),JSON.stringify({checks},null,2));
});
