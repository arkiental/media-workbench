import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp,mkdir,readFile,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools,runProcess } from '../packages/media/src/index.ts';

test('independent shared API uses isolated tools for real upload, previews and exact exported frame identities',{skip:process.env.MW_TEST_SHARED!=='1',timeout:240000},async()=>{
 const rootDir=path.resolve('test-output/review');await mkdir(rootDir,{recursive:true});const root=await mkdtemp(path.join(rootDir,'shared-')),tools=await discoverTools();
 const image=(await runProcess('docker',['image','inspect',process.env.MW_WORKER_IMAGE||'media-workbench:local','--format','{{.Id}}'])).stdout.toString().trim();
 const fixture=path.join(root,'fixture.mp4');await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10:duration=2','-c:v','libx264','-crf','0',fixture]);
 const ownerToken=randomUUID(),desktopSecret=randomUUID(),app=await createServer({dataDir:path.join(root,'data'),ownerToken,desktopSecret,tools,encoders:[],shared:true,host:'127.0.0.1',publicOrigin:'https://review.invalid',workerConfig:{image,proxyPath:path.resolve('deploy/egress/proxy.mjs'),relayPath:path.resolve('deploy/egress/relay.mjs')}});
 const headers={host:'review.invalid',origin:'https://review.invalid',authorization:`Bearer ${ownerToken}`};const evidence:any={image,checks:[]};
 try{
  const capabilities=await app.inject({url:'/api/v1/capabilities',headers});assert.equal(capabilities.statusCode,200,capabilities.body);assert.equal(capabilities.json().mode,'shared');assert.match(capabilities.json().tools.ffmpeg,/ffmpeg version 9\./);evidence.tools=capabilities.json().tools;
  assert.equal((await app.inject({url:'/api/v1/cookies',headers})).statusCode,403);evidence.checks.push('Shared reports actual FFmpeg9 tool version and denies local cookie authority');
  const imported=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers,'content-type':'application/octet-stream','x-filename':'fixture.mp4'},payload:await readFile(fixture)});assert.equal(imported.statusCode,200,imported.body);const source=imported.json();assert(source.id&&source.artifactId);evidence.source=source;
  assert.equal((await app.inject({url:`/api/v1/desktop/artifacts/${source.artifactId}`,headers:{...headers,'x-desktop-secret':desktopSecret}})).statusCode,403,'even a valid local bridge credential cannot expose a shared host artifact path');
  const index=await app.inject({url:`/api/v1/sources/${source.id}/frames?around=0.5`,headers});assert.equal(index.statusCode,200,index.body);assert(index.json().length>0||index.json().frames?.length>0,'real frame timestamps expected');
  const png=await app.inject({url:`/api/v1/sources/${source.id}/frame?pts=0.3`,headers});assert.equal(png.statusCode,200,png.body);assert.deepEqual(png.rawPayload.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));await writeFile(path.join(root,'shared-frame.png'),png.rawPayload);evidence.checks.push('Shared upload is fully validated and source frame/index routes produce actual decoder output');
  const member=app.store.createUser('Isolated other user','member'),memberToken=app.store.token(member.id,'Reviewer').token;assert.equal((await app.inject({url:`/api/v1/sources/${source.id}/frame?pts=0.3`,headers:{...headers,authorization:`Bearer ${memberToken}`}})).statusCode,404);evidence.checks.push('Other shared user cannot decode owner source');
  const submitted=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers,'idempotency-key':randomUUID()},payload:{type:'export',recipe:{sourceId:source.id,segments:[{in:.3,out:1.3}]},options:{cut:'exact',quality:0}}});assert.equal(submitted.statusCode,202,submitted.body);
  let job=submitted.json();for(let i=0;i<1000&&!['completed','failed','cancelled'].includes(job.state);i++){await new Promise(resolve=>setTimeout(resolve,150));job=(await app.inject({url:`/api/v1/jobs/${job.id}`,headers})).json();}assert.equal(job.state,'completed',JSON.stringify(job));assert(job.toolVersions?.ffmpeg);assert(job.resourceUsage?.elapsedMs>0);
  const result=await app.inject({url:`/api/v1/artifacts/${job.artifactId}/content`,headers});assert.equal(result.statusCode,200);const output=path.join(root,'shared-exact.mp4');await writeFile(output,result.rawPayload);
  const hashes=async(file:string)=>{const text=(await runProcess(tools.ffmpeg,['-v','error','-xerror','-i',file,'-map','0:v:0','-f','framemd5','-'])).stdout.toString();return text.split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>line.split(',').at(-1)!.trim());};const actual=await hashes(output),expected=(await hashes(fixture)).slice(3,13);assert.deepEqual(actual,expected);evidence.job=job;evidence.output={bytes:result.rawPayload.length,frameHashes:actual};evidence.checks.push('Shared queued export publishes exactly the ten expected original decoded frames');
  await writeFile(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
 }catch(error){await writeFile(path.join(root,'failure.json'),JSON.stringify({...evidence,error:String(error)},null,2));throw error;}finally{await app.close();}
});
