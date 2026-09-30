import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir,mkdtemp,readFile,writeFile,access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';
import { runProcess } from '../packages/media/src/process.ts';
import { JobRequestSchema } from '../packages/contracts/src/index.ts';

test('independent preset provenance and separate history/media deletion preserve protected data',{timeout:30000},async t=>{
 const review=path.resolve('test-output/review');await mkdir(review,{recursive:true});const root=await mkdtemp(path.join(review,'lifecycle-')),token=randomUUID();
 const app=await createServer({dataDir:path.join(root,'data'),ownerToken:token,encoders:[],startQueue:false}),owner=app.store.users()[0],headers={host:'localhost',authorization:`Bearer ${token}`};
 const original=path.join(root,'externally-owned-fixture.mp4');await runProcess(app.tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=64x48:rate=10:duration=1','-an','-c:v','libx264','-crf','0',original]);const bytes=await readFile(original);
 const upload=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers,'content-type':'application/octet-stream','x-filename':'fixture.mp4'},payload:bytes});assert.equal(upload.statusCode,200,upload.body);const source=upload.json(),artifactPath=path.join(app.store.dataDir,'artifacts',source.artifactId);const checks:string[]=[];
 try{
  await t.test('deleting a preset retains its exact portable/original job snapshots and permits retry',async()=>{
   const originalPreset={schemaVersion:0,id:'review-provenance',name:'Original portable intent',codec:'h264',maxBytes:100000};const imported=await app.inject({method:'POST',url:'/api/v1/presets/import',headers,payload:originalPreset});assert.equal(imported.statusCode,200,imported.body);const preset=imported.json();
   const idempotencyKey=randomUUID(),submitted={type:'export',recipe:{sourceId:source.id,segments:[{in:0,out:.5}]},options:{cut:'exact',mode:'size',maxBytes:100000},presetId:preset.id};
   const job=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers,'idempotency-key':idempotencyKey},payload:submitted});assert.equal(job.statusCode,202,job.body);assert.deepEqual(job.json().presetSnapshot,{preset:preset.preset,original:originalPreset});
   assert.equal((await app.inject({method:'DELETE',url:`/api/v1/presets/${preset.id}`,headers})).statusCode,200);const retained=(await app.inject({url:`/api/v1/jobs/${job.json().id}`,headers})).json();assert.deepEqual(retained.presetSnapshot,job.json().presetSnapshot);
   const duplicate=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers,'idempotency-key':idempotencyKey},payload:submitted});assert.equal(duplicate.statusCode,202,duplicate.body);assert.equal(duplicate.json().id,retained.id);assert.deepEqual(duplicate.json().presetSnapshot,retained.presetSnapshot);
   app.store.updateJob(retained.id,{state:'failed',error:'Synthetic terminal-state fixture for retry/provenance semantics'});const retry=await app.inject({method:'POST',url:`/api/v1/jobs/${retained.id}/retry`,headers});assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().request.options.maxBytes,100000);assert.deepEqual(retry.json().presetSnapshot,retained.presetSnapshot);app.store.updateJob(retained.id,{state:'cancelled'});checks.push('Preset deletion preserves exact migrated+original provenance and retry constraints');
  });
  await t.test('history deletion removes only terminal metadata and leaves original media bytes',async()=>{
   // Explicit terminal metadata fixture: media validity comes from the real upload above.
   const job=app.store.submit(owner.id,JobRequestSchema.parse({type:'proxy',sourceId:source.id}),randomUUID()).job;app.store.updateJob(job.id,{state:'completed',artifactId:source.artifactId});
   const response=await app.inject({method:'DELETE',url:`/api/v1/jobs/${job.id}`,headers});assert.equal(response.statusCode,200,response.body);assert.equal(app.store.job(job.id,owner.id),undefined);assert.deepEqual(await readFile(artifactPath),bytes);assert(app.store.get('artifact',source.artifactId,owner.id));checks.push('History-only deletion preserves actual artifact bytes');
  });
  await t.test('cross-owner, queued-job, project, pin and active lease protections precede any file removal',async()=>{
   const member=app.store.createUser('Other owner','member'),other=app.store.token(member.id,'Review other owner').token;const remove=(extra:Record<string,string>={})=>app.inject({method:'DELETE',url:`/api/v1/artifacts/${source.artifactId}`,headers:{...headers,...extra},payload:{confirmOriginal:true}});
   assert.equal((await remove({authorization:`Bearer ${other}`})).statusCode,404);assert.deepEqual(await readFile(artifactPath),bytes);
   const job=app.store.submit(owner.id,JobRequestSchema.parse({type:'proxy',sourceId:source.id}),randomUUID()).job;assert((await app.inject({method:'DELETE',url:`/api/v1/jobs/${job.id}`,headers})).statusCode>=400);assert((await remove()).statusCode>=400);app.store.updateJob(job.id,{state:'cancelled'});
   const project=await app.inject({method:'POST',url:'/api/v1/projects',headers,payload:{name:'Protected project',recipe:{sourceId:source.id,segments:[{in:0,out:1}]},options:{cut:'exact'}}});assert.equal(project.statusCode,200,project.body);assert((await remove()).statusCode>=400);await app.inject({method:'DELETE',url:`/api/v1/projects/${project.json().id}`,headers});
   assert.equal((await app.inject({method:'PATCH',url:`/api/v1/artifacts/${source.artifactId}`,headers,payload:{pinned:true}})).statusCode,200);assert((await remove()).statusCode>=400);await app.inject({method:'PATCH',url:`/api/v1/artifacts/${source.artifactId}`,headers,payload:{pinned:false}});
   app.store.lease(source.artifactId,60000);assert((await remove()).statusCode>=400);assert.deepEqual(await readFile(artifactPath),bytes);app.store.db.prepare('UPDATE leases SET until=? WHERE id=?').run('2000-01-01T00:00:00.000Z',source.artifactId);
   const unconfirmed=await app.inject({method:'DELETE',url:`/api/v1/artifacts/${source.artifactId}`,headers});assert(unconfirmed.statusCode>=400);const removed=await remove();assert.equal(removed.statusCode,200,removed.body);await assert.rejects(access(artifactPath));assert.equal(app.store.get('artifact',source.artifactId,owner.id),undefined);assert(app.store.job(job.id,owner.id),'explicit media removal must retain terminal job history');assert.deepEqual(await readFile(original),bytes);checks.push('Every deletion protection passed; confirmed managed-original removal preserved external original and terminal history');
  });
  await writeFile(path.join(root,'evidence.json'),JSON.stringify({inputBytes:bytes.length,checks},null,2));
 }finally{await app.close();}
});
