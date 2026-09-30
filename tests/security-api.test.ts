import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';
import { defaultPolicy } from '../packages/core/src/policy.ts';
import { JobRequestSchema, type Artifact, type Source } from '../packages/contracts/src/index.ts';
import { runProcess } from '../packages/media/src/process.ts';

test('independent authenticated API adversarial cases', {timeout:60000},async t=>{
  const root=path.resolve('test-output/review');await mkdir(root,{recursive:true});const dataDir=await mkdtemp(path.join(root,'api-'));
  const ownerToken='review-owner-token-'+randomUUID();const app=await createServer({dataDir,ownerToken,startQueue:false});
  const owner=app.store.users().find(u=>u.role==='owner')!,alice=app.store.createUser('Alice','member'),bob=app.store.createUser('Bob','restricted-guest');
  const aliceToken=app.store.token(alice.id,'Alice token').token,bobToken=app.store.token(bob.id,'Bob token').token,readToken=app.store.token(alice.id,'Read only',['read']).token;
  const headers=(token=ownerToken)=>({host:'localhost',authorization:`Bearer ${token}`});
  async function fixture(userId:string) {
    const artifact:Artifact={id:randomUUID(),ownerId:userId,name:'literal " 雪 & file.mp4',bytes:8,media:{duration:1,startTime:0,size:8,format:'mov,mp4',streams:[{index:0,type:'video',codec:'h264',width:32,height:32}],hdr:false},kind:'download',createdAt:new Date().toISOString(),pinned:false,validated:true};
    await writeFile(path.join(dataDir,'artifacts',artifact.id),'SENTINEL');app.store.put('artifact',artifact.id,userId,artifact);
    const source:Source={id:randomUUID(),ownerId:userId,artifactId:artifact.id,name:artifact.name,createdAt:artifact.createdAt};app.store.put('source',source.id,userId,source);return{artifact,source};
  }
  const a=await fixture(alice.id),b=await fixture(bob.id);
  const aliceJob=app.store.submit(alice.id,JobRequestSchema.parse({type:'proxy',sourceId:a.source.id}),randomUUID()).job;
  try {
    await t.test('authentication, Host, Origin and scope checks reject unauthorized callers',async()=>{
      assert.equal((await app.inject({url:'/api/v1/jobs',headers:{host:'localhost'}})).statusCode,401);
      assert.equal((await app.inject({url:'/api/v1/jobs',headers:{...headers(),host:'attacker.example'}})).statusCode,403);
      assert.equal((await app.inject({url:'/api/v1/jobs',headers:{...headers(),origin:'https://attacker.example'}})).statusCode,403);
      assert.equal((await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers(readToken),'idempotency-key':randomUUID()},payload:{type:'proxy',sourceId:a.source.id}})).statusCode,403);
      assert.equal((await app.inject({method:'POST',url:'/api/v1/pairings',headers:headers(readToken),payload:{name:'escalation',scopes:['read','submit','manage']}})).statusCode,403);
    });
    await t.test('cross-user artifact, frame, waveform, job, cancellation and event access is denied',async()=>{
      for(const url of [`/api/v1/artifacts/${a.artifact.id}/content`,`/api/v1/sources/${a.source.id}/frames?around=0`,`/api/v1/sources/${a.source.id}/frame?pts=0`,`/api/v1/sources/${a.source.id}/waveform`,`/api/v1/jobs/${aliceJob.id}`])assert.equal((await app.inject({url,headers:headers(bobToken)})).statusCode,404,url);
      const cancel=await app.inject({method:'POST',url:`/api/v1/jobs/${aliceJob.id}/cancel`,headers:headers(bobToken)});assert(cancel.statusCode>=400);assert.equal(app.store.job(aliceJob.id)?.state,'queued');
      for(const url of ['/api/v1/jobs','/api/v1/events','/api/v1/sources','/api/v1/artifacts']){const response=await app.inject({url,headers:headers(bobToken)});assert.equal(response.statusCode,200);assert(!response.body.includes(a.artifact.id));assert(!response.body.includes(a.source.id));assert(!response.body.includes(aliceJob.id));}
    });
    await t.test('authenticated range delivery returns exactly the requested bytes and rejects invalid ranges',async()=>{
      const response=await app.inject({url:`/api/v1/artifacts/${a.artifact.id}/content`,headers:{...headers(aliceToken),range:'bytes=2-4'}});assert.equal(response.statusCode,206);assert.equal(response.body,'NTI');assert.equal(response.headers['content-range'],'bytes 2-4/8');
      assert.equal((await app.inject({url:`/api/v1/artifacts/${a.artifact.id}/content`,headers:{...headers(aliceToken),range:'bytes=900-999'}})).statusCode,416);
      assert.equal((await app.inject({url:`/api/v1/artifacts/${a.artifact.id}/content`,headers:{host:'localhost',range:'bytes=2-4'}})).statusCode,401);
    });
    await t.test('owner cookie/native/administrator authority is unavailable to members and browser-only clients',async()=>{
      for(const url of ['/api/v1/admin/users','/api/v1/cookies'])assert.equal((await app.inject({url,headers:headers(aliceToken)})).statusCode,403);
      assert.equal((await app.inject({url:`/api/v1/desktop/artifacts/${a.artifact.id}`,headers:headers(aliceToken)})).statusCode,403);
      const own=await fixture(owner.id);assert.equal((await app.inject({url:`/api/v1/desktop/artifacts/${own.artifact.id}`,headers:headers()})).statusCode,403);
      const pairing=await app.inject({method:'POST',url:'/api/v1/pairings',headers:headers(aliceToken),payload:{name:'Scoped review token',scopes:['read']}});assert.equal(pairing.statusCode,200);const token=pairing.json();
      assert.equal((await app.inject({url:'/api/v1/jobs',headers:headers(token.token)})).statusCode,200);await app.inject({method:'DELETE',url:`/api/v1/pairings/${token.id}`,headers:headers(aliceToken)});assert.equal((await app.inject({url:'/api/v1/jobs',headers:headers(token.token)})).statusCode,401);
    });
    await t.test('download-only users cannot submit exports, plans or proxies',async()=>{
      const request={type:'export',recipe:{sourceId:b.source.id,segments:[{in:0,out:1}]},options:{cut:'exact'}};
      for(const [url,payload] of [['/api/v1/jobs',request],['/api/v1/jobs',{type:'proxy',sourceId:b.source.id}],['/api/v1/export/plan',{recipe:request.recipe,options:request.options}]] as const){const r=await app.inject({method:'POST',url,headers:{...headers(bobToken),'idempotency-key':randomUUID()},payload});assert(r.statusCode>=400);assert.match(r.body,/permission/i);}
    });
    await t.test('repeating an accepted idempotent submission succeeds even after queue reaches quota',async()=>{
      const user=app.store.createUser('One queued job','member',{...defaultPolicy('member'),maxQueued:1});const token=app.store.token(user.id,'Queue test').token;const input=await fixture(user.id);const payload={type:'proxy',sourceId:input.source.id};const key=randomUUID();
      const first=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers(token),'idempotency-key':key},payload});assert.equal(first.statusCode,202);
      const retry=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers(token),'idempotency-key':key},payload});assert.equal(retry.statusCode,202);assert.equal(retry.json().id,first.json().id);
      assert.equal((await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers(token),'idempotency-key':randomUUID()},payload})).statusCode,429);
    });
    await t.test('download-only read token cannot trigger on-demand waveform processing',async()=>{
      const r=await app.inject({url:`/api/v1/sources/${b.source.id}/waveform`,headers:headers(bobToken)});assert(r.statusCode>=400);assert.match(r.body,/permission/i,'must reject on policy before launching a native decoder');
    });
    await t.test('concurrent real uploads cannot oversubscribe the same disk quota',async()=>{
      const input=path.join(dataDir,'upload-fixture.mp4');await runProcess(app.tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=5','-t','1','-an','-c:v','libx264','-pix_fmt','yuv420p',input]);const bytes=await readFile(input);
      const user=app.store.createUser('Upload quota','member',{...defaultPolicy('member'),diskBytes:Math.floor(bytes.length*1.5)});const token=app.store.token(user.id,'Upload quota').token;
      const upload=()=>app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers(token),'content-type':'application/octet-stream','x-filename':'fixture.mp4'},payload:bytes});
      const responses=await Promise.all([upload(),upload()]);const succeeded=responses.filter(r=>r.statusCode===200);
      assert.equal(succeeded.length,1,`expected only one quota reservation; statuses ${responses.map(r=>r.statusCode)}, stored bytes ${app.store.diskUsage(user.id)}, quota ${user.policy.diskBytes}`);
      assert(app.store.diskUsage(user.id)<=user.policy.diskBytes);
    });
    await t.test('direct API preset application preserves hard byte and height constraints',async()=>{
      const imported=await app.inject({method:'POST',url:'/api/v1/presets/import',headers:headers(aliceToken),payload:{schemaVersion:1,id:'review-ceilings',revision:1,name:'Review ceilings',requires:['exact-cut-v1','target-size-v1'],options:{cut:'exact',mode:'size',maxBytes:90000},maxHeight:16}});assert.equal(imported.statusCode,200,imported.body);
      const payload={type:'export',recipe:{sourceId:a.source.id,segments:[{in:0,out:1}]},options:{cut:'auto',mode:'quality',maxBytes:90000},presetId:imported.json().id};
      const resolved=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers(aliceToken),'idempotency-key':randomUUID()},payload});assert.equal(resolved.statusCode,202,resolved.body);assert.equal(resolved.json().request.options.mode,'size');assert.equal(resolved.json().request.options.cut,'exact');assert.equal(resolved.json().request.recipe.resize.height,16);
      const conflict=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers(aliceToken),'idempotency-key':randomUUID()},payload:{...payload,recipe:{...payload.recipe,resize:{width:32,height:32}}}});assert(conflict.statusCode>=400);assert.match(conflict.body,/height|resize/i);
    });
    await t.test('retrying a failed batch cannot bypass a reduced pending-job quota',async()=>{
      const user=app.store.createUser('Retry quota','member',{...defaultPolicy('member'),maxQueued:1});const token=app.store.token(user.id,'Retry quota').token,batchId=randomUUID();
      app.store.put('batch',batchId,user.id,{id:batchId,idem:randomUUID(),items:[]});
      for(let i=0;i<2;i++){const j=app.store.submit(user.id,JobRequestSchema.parse({type:'download',download:{url:'https://example.com/fixture.mp4'}}),randomUUID(),batchId).job;app.store.updateJob(j.id,{state:'failed'});}
      const response=await app.inject({method:'POST',url:`/api/v1/batches/${batchId}/retry`,headers:headers(token)});
      assert(app.store.jobs(user.id).filter(j=>j.state==='queued').length<=1,`batch retry returned ${response.statusCode} and exceeded pending quota`);
    });
    await t.test('direct API input/output codec and operational encoder policies are enforced',async()=>{
      const user=app.store.createUser('Codec restrictions','member',{...defaultPolicy('member'),allowedInputCodecs:['hevc']});const token=app.store.token(user.id,'Codec restrictions').token;
      const upload=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers(token),'content-type':'application/octet-stream','x-filename':'h264.mp4'},payload:await readFile(path.join(dataDir,'upload-fixture.mp4'))});assert(upload.statusCode>=400);assert.match(upload.body,/codec.*policy/i);assert.equal(app.store.all('artifact',user.id).length,0);
      const input=await fixture(user.id);app.store.updateUser(user.id,{...defaultPolicy('member'),allowedOutputCodecs:['h264'],allowedEncoders:['libx264']});
      const payload={recipe:{sourceId:input.source.id,segments:[{in:0,out:1}]},options:{cut:'exact',codec:'h264'}};
      const good=await app.inject({method:'POST',url:'/api/v1/export/plan',headers:headers(token),payload});assert.equal(good.statusCode,200,good.body);assert.equal(good.json().encoder,'libx264');
      const codec=await app.inject({method:'POST',url:'/api/v1/export/plan',headers:headers(token),payload:{...payload,options:{...payload.options,codec:'hevc'}}});assert(codec.statusCode>=400);assert.match(codec.body,/codec.*policy/i);
      app.store.updateUser(user.id,{...defaultPolicy('member'),allowedEncoders:['libx265']});const encoder=await app.inject({method:'POST',url:'/api/v1/export/plan',headers:headers(token),payload});assert(encoder.statusCode>=400);assert.match(encoder.body,/operational|encoder|fallback/i);
    });
  } finally {await app.close();}
});

test('network hosting fails closed before opening a service',async()=>{
  await assert.rejects(createServer({dataDir:path.resolve('test-output/review/no-shared-start'),shared:true}),/Shared hosting is disabled/);
  await assert.rejects(createServer({dataDir:path.resolve('test-output/review/no-network-start'),host:'0.0.0.0'}),/Shared hosting is disabled/);
});
