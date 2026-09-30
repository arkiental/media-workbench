import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from '../apps/server/src/app.ts';
import {nativeCopy,managedPath,safeName} from '../apps/server/src/storage.ts';
import {runProcess,validateMedia} from '../packages/media/src/index.ts';
import {defaultPolicy} from '../packages/core/src/policy.ts';
import type {Artifact} from '../packages/contracts/src/index.ts';

test('real service transfer bounds, codec policy, operation deadline, documented API and immutable native handoff',{timeout:45000},async t=>{
 await mkdir('test-output/service-limits',{recursive:true});const dir=await mkdtemp(path.resolve('test-output/service-limits/run-'));
 const token=randomUUID(),secret=randomUUID(),app=await createServer({dataDir:dir,ownerToken:token,desktopSecret:secret,encoders:[{name:'libx264',codec:'h264',hardware:false,available:true,testedAt:new Date().toISOString()}],startQueue:false});
 const owner=app.store.users()[0],headers={host:'localhost',authorization:`Bearer ${token}`};
 const fixture=path.join(dir,'fixture.mp4');await runProcess(app.tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=96x64:rate=10:duration=2','-an','-c:v','libx264','-crf','0',fixture]);const bytes=await readFile(fixture);
 try{
  const imported=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers,'content-type':'application/octet-stream','x-filename':'CON.mp4'},payload:bytes});assert.equal(imported.statusCode,200,imported.body);const source=imported.json(),artifact=app.store.get<Artifact>('artifact',source.artifactId,owner.id)!;
  await t.test('native actions return a named byte-identical copy and external edits cannot mutate the original',async()=>{
   assert.equal(safeName('CON.mp4'),'_CON.mp4');const paths=await Promise.all([nativeCopy(app.store,artifact),nativeCopy(app.store,artifact),nativeCopy(app.store,artifact)]);assert.equal(new Set(paths).size,1);assert.equal(path.extname(paths[0]),'.mp4');assert.notEqual(paths[0],await managedPath(app.store,artifact.id));assert.deepEqual(await readFile(paths[0]),bytes);
   await writeFile(paths[0],'external editor modified its copy');assert.deepEqual(await readFile(await managedPath(app.store,artifact.id)),bytes);const restored=await nativeCopy(app.store,artifact);assert.deepEqual(await readFile(restored),bytes);await validateMedia(restored,app.tools);assert.equal(app.store.all('handoff',owner.id).length,1);assert.equal(app.store.diskUsage(owner.id),bytes.length*2);assert.deepEqual(await readdir(path.dirname(restored)),['_CON.mp4']);
  });
  await t.test('codec and encoder policy applies to real uploaded bytes and export planning',async()=>{
   const user=app.store.createUser('Policy test','member',{...defaultPolicy('member'),allowedInputCodecs:['vp9']});const userToken=app.store.token(user.id,'test').token;
   const denied=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers,authorization:`Bearer ${userToken}`,'content-type':'application/octet-stream'},payload:bytes});assert.equal(denied.statusCode,400,denied.body);assert.match(denied.body,/codec/);assert.equal(app.store.all('artifact',user.id).length,0);
   const plan=()=>app.inject({method:'POST',url:'/api/v1/export/plan',headers,payload:{recipe:{sourceId:source.id,segments:[{in:0,out:1}]},options:{cut:'exact',encoder:'software',codec:'h264'}}});
   app.store.updateUser(owner.id,{...owner.policy,allowedOutputCodecs:['hevc']});assert.match((await plan()).body,/codec/);
   app.store.updateUser(owner.id,{...owner.policy,allowedEncoders:['libx265']});const enc=await plan();assert.equal(enc.statusCode,400);assert.match(enc.body,/encoder/);app.store.updateUser(owner.id,owner.policy);
  });
  await t.test('first chunks and concurrent downloads obey the same user bandwidth budget',async()=>{
   app.store.updateUser(owner.id,{...owner.policy,bandwidthBytesPerSecond:4096,maxTransferBytes:8192});const begun=Date.now();
   const responses=await Promise.all([0,1].map(()=>app.inject({url:`/api/v1/artifacts/${artifact.id}/content`,headers:{...headers,range:'bytes=0-8191'}})));assert(responses.every(r=>r.statusCode===206));assert(Date.now()-begun>=3700,`16384 bytes arrived in ${Date.now()-begun}ms despite4096B/s cap`);responses.forEach(r=>assert.deepEqual(r.rawPayload,bytes.subarray(0,8192)));
   app.store.updateUser(owner.id,{...owner.policy,maxTransferBytes:1024});const denied=await app.inject({url:`/api/v1/artifacts/${artifact.id}/content`,headers});assert.equal(denied.statusCode,413);app.store.updateUser(owner.id,owner.policy);
  });
  await t.test('whole upload deadline aborts a slow transfer and releases slots and reservations',async()=>{
   const user=app.store.createUser('Deadline test','member',{...defaultPolicy('member'),bandwidthBytesPerSecond:1024,maxRuntimeSeconds:1});const userToken=app.store.token(user.id,'test').token;const begun=Date.now();
   const response=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers,authorization:`Bearer ${userToken}`,'content-type':'application/octet-stream'},payload:bytes});assert.equal(response.statusCode,408,response.body);assert.match(response.body,/total runtime/);assert(Date.now()-begun<4000);assert.equal(app.store.availableBytes(user.id),user.policy.diskBytes);assert.equal(app.store.all('artifact',user.id).length,0);assert.deepEqual(await readdir(path.join(dir,'work')),[]);
  });
  await t.test('machine API includes every route group and runtime policy/recipe contracts',async()=>{
   const response=await app.inject({url:'/api/v1/openapi.json',headers});assert.equal(response.statusCode,200,response.body);const api=response.json();assert.equal(api.openapi,'3.1.0');assert(Object.keys(api.paths).length>=35);
   for(const route of ['/jobs/{id}/retry','/batches/{id}/cancel','/sources/{id}/waveform','/artifacts/{id}/content','/admin/users/{id}','/desktop/artifacts/{id}','/presets/import','/history/export','/pairings/{id}'])assert(api.paths[route],route);
   assert(api.components.schemas.Policy.properties.maxCpuCores);assert(api.components.schemas.Policy.properties.bandwidthBytesPerSecond);assert(api.paths['/jobs'].post.parameters.some((p:any)=>p.name==='Idempotency-Key'));assert.deepEqual(api.paths['/session'].post.security,[]);
  });
  await t.test('preview/upload concurrency has a global ceiling across distinct users',async()=>{
   const tokens=[0,1,2,3,4].map(index=>{const user=app.store.createUser(`Concurrent user ${index}`,'member',{...defaultPolicy('member'),bandwidthBytesPerSecond:1024,maxRuntimeSeconds:2});return app.store.token(user.id,'test').token;});
   const upload=(credential:string)=>app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers,authorization:`Bearer ${credential}`,'content-type':'application/octet-stream'},payload:bytes});
   const active=tokens.slice(0,4).map(upload);await new Promise(resolve=>setTimeout(resolve,100));const fifth=await upload(tokens[4]);assert.equal(fifth.statusCode,429,fifth.body);assert.match(fifth.body,/Host.*capacity/);const ended=await Promise.all(active);assert(ended.every(response=>response.statusCode===408));assert.deepEqual(await readdir(path.join(dir,'work')),[]);
  });
  await writeFile(path.join(dir,'evidence.json'),JSON.stringify({inputBytes:bytes.length,checks:['native copy extension, byte identity and original immutability','real input codec rejection','output codec and encoder restrictions','aggregate first-chunk transfer timing','total upload deadline408 and reservation cleanup','machine API route coverage']},null,2));
 }finally{await app.close();}
});
