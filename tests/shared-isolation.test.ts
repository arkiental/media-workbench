import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';
import { runProcess,discoverTools } from '../packages/media/src/index.ts';
test('shared service authenticates distinct users and processes real media only inside isolated workers',{skip:process.env.MW_TEST_ISOLATION!=='1',timeout:240000},async()=>{
 const dir=await mkdtemp(path.resolve('test-output/shared-'));const tools=await discoverTools();
 const image=(await runProcess('docker',['image','inspect','media-workbench:local','--format','{{.Id}}'])).stdout.toString().trim();
 const app=await createServer({dataDir:path.join(dir,'data'),ownerToken:'shared-test-owner-token-abcdef',tools,shared:true,publicOrigin:'https://workbench.test',workerConfig:{image,proxyPath:path.resolve('deploy/egress/proxy.mjs'),relayPath:path.resolve('deploy/egress/relay.mjs')}});
 const headers={authorization:'Bearer shared-test-owner-token-abcdef',host:'workbench.test',origin:'https://workbench.test'};
 try{
  const c=await app.inject({url:'/api/v1/capabilities',headers});assert.equal(c.statusCode,200,c.body);assert.equal(c.json().mode,'shared');assert.match(c.json().tools.ffmpeg,/9\.0\.1/);
  const member=await app.inject({method:'POST',url:'/api/v1/admin/users',headers,payload:{name:'Shared member',role:'member'}});assert.equal(member.statusCode,200,member.body);const memberHeaders={...headers,authorization:`Bearer ${member.json().token}`};
  const fixture=path.join(dir,'numbered.mp4');await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10:duration=2','-c:v','libx264','-crf','0',fixture]);
  const upload=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{...memberHeaders,'content-type':'application/octet-stream','x-filename':'source.mp4'},payload:await readFile(fixture)});assert.equal(upload.statusCode,200,upload.body);const source=upload.json();
  const job=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...memberHeaders,'idempotency-key':randomUUID()},payload:{type:'export',recipe:{sourceId:source.id,segments:[{in:.3,out:1.3}]},options:{cut:'exact',mode:'quality',quality:0}}});assert.equal(job.statusCode,202,job.body);
  let final;for(let i=0;i<600;i++){final=app.store.job(job.json().id)!;if(['completed','failed','cancelled'].includes(final.state))break;await new Promise(r=>setTimeout(r,200));}assert.equal(final?.state,'completed',JSON.stringify(final));
  const result=await app.inject({url:`/api/v1/artifacts/${final!.artifactId}/content`,headers:memberHeaders});assert.equal(result.statusCode,200,result.body);const out=path.join(dir,'output.mp4');await writeFile(out,result.rawPayload);
  const hashes=async(file:string)=>(await runProcess(tools.ffmpeg,['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-'])).stdout.toString().split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1)!.trim());assert.deepEqual(await hashes(out),(await hashes(fixture)).slice(3,13));
  assert.equal((await app.inject({url:`/api/v1/artifacts/${final!.artifactId}/content`,headers})).statusCode,404);
  assert.equal((await app.inject({url:'/api/v1/cookies',headers})).statusCode,403);
  assert.equal((await app.inject({url:`/api/v1/desktop/artifacts/${final!.artifactId}`,headers:memberHeaders})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/sources/inspect',headers:memberHeaders,payload:{url:'http://169.254.169.254/'}})).statusCode,400);
  const cookie=await app.inject({method:'POST',url:'/api/v1/session',headers:{host:'workbench.test',origin:'https://workbench.test'},payload:{token:member.json().token}});assert.match(String(cookie.headers['set-cookie']),/Secure/);
  await writeFile(path.join(dir,'evidence.json'),JSON.stringify({image,tools:c.json().tools,frames:10,bytes:result.rawPayload.length,job:final,checks:['member upload via isolated decoder','isolated exact10sourceframes','owner cannot read member file','shared cookies denied','native bridge denied','metadata destination rejected','secure cookie']},null,2));
 }finally{await app.close();}
});
