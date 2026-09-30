import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools, validateMedia } from '../packages/media/src/index.ts';
import { generateFixtures } from '../packages/test-fixtures/generate.ts';
import { managedPath } from '../apps/server/src/storage.ts';
import type { Job } from '../packages/contracts/src/index.ts';

test('vertical slice: real yt-dlp inspect/mixed batch, upload, exact strict-size export, retry, history/restart',async()=>{
 const tools=await discoverTools();const root=path.resolve('test-output/workflow',randomUUID());await mkdir(root,{recursive:true});
 const fixture=await generateFixtures(path.join(root,'fixtures'),tools);const bytes=await readFile(fixture.numbered);
 const fixtureServer=httpServer((req,res)=>{if(req.url==='/movie.mp4'){res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length});res.end(bytes);}else{res.writeHead(404);res.end('Missing fixture');}});
 await new Promise<void>(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(fixtureServer.address() as any).port}`;
 const ownerToken=randomUUID()+randomUUID();const dataDir=path.join(root,'data');let app=await createServer({dataDir,ownerToken,tools,encoders:[],testOrigin:origin});
 const headers={authorization:`Bearer ${ownerToken}`,host:'localhost'};
 const call=(method:'GET'|'POST'|'PATCH',url:string,payload?:any,extra={})=>app.inject({method,url,headers:{...headers,...extra},payload});
 const waitJob=async(id:string)=>{for(let i=0;i<300;i++){const job=app.store.job(id)!;if(['completed','failed','cancelled','interrupted'].includes(job.state))return job;await new Promise(r=>setTimeout(r,100));}throw Error('Job timed out');};
 try{
  const inspect=await call('POST','/api/v1/sources/inspect',{url:origin+'/movie.mp4'});assert.equal(inspect.statusCode,200,inspect.body);assert.ok(inspect.json().entries[0].formats.length);
  const batch=await call('POST','/api/v1/batches',{items:[{url:origin+'/movie.mp4'},{url:origin+'/missing.mp4'}]},{'idempotency-key':randomUUID()});assert.equal(batch.statusCode,202,batch.body);
  const jobs=await Promise.all(batch.json().jobs.map((j:Job)=>waitJob(j.id)));assert.deepEqual(jobs.map(j=>j.state),['completed','failed']);
  const downloaded=app.store.get<any>('artifact',jobs[0].artifactId!,jobs[0].ownerId)!;const downloadedMedia=await validateMedia(await managedPath(app.store,downloaded.id),tools);assert.equal(downloadedMedia.streams[0].width,320);
  const retry=await call('POST',`/api/v1/jobs/${jobs[1].id}/retry`);assert.equal(retry.statusCode,200,retry.body);assert.equal((await waitJob(jobs[1].id)).state,'failed');assert.equal(app.store.job(jobs[1].id)!.attempt,2);
  const upload=await call('POST','/api/v1/uploads',bytes,{'content-type':'application/octet-stream','x-filename':encodeURIComponent('Unicode 雪 & $ clip.mp4')});assert.equal(upload.statusCode,200,upload.body);const source=upload.json();
  const request={type:'export',recipe:{sourceId:source.id,segments:[{in:.3,out:2.3}]},options:{cut:'exact',mode:'size',maxBytes:200000}};
  const idem=randomUUID();const submitted=await call('POST','/api/v1/jobs',request,{'idempotency-key':idem});assert.equal(submitted.statusCode,202,submitted.body);const duplicate=await call('POST','/api/v1/jobs',request,{'idempotency-key':idem});assert.equal(submitted.json().id,duplicate.json().id);
  const outputJob=await waitJob(submitted.json().id);assert.equal(outputJob.state,'completed',JSON.stringify(outputJob));const output=await managedPath(app.store,outputJob.artifactId!);const info=await validateMedia(output,tools);assert.ok((await stat(output)).size<=200000);assert.ok(Math.abs(info.duration-2)<.15);
  const range=await call('GET',`/api/v1/artifacts/${outputJob.artifactId}/content`,undefined,{range:'bytes=0-31'});assert.equal(range.statusCode,206,range.body);assert.equal(range.rawPayload.length,32);
  const history=await call('GET','/api/v1/history/export?format=csv');assert.match(history.body,/completed/);
  const queued=app.store.submit(outputJob.ownerId,{type:'proxy',sourceId:source.id},randomUUID()).job;app.store.updateJob(queued.id,{state:'processing'});
  await app.close();app=await createServer({dataDir,ownerToken,tools,encoders:[],testOrigin:origin,startQueue:false});assert.equal(app.store.job(queued.id)!.state,'interrupted');assert.equal(app.store.job(outputJob.id)!.state,'completed');
  await writeFile(path.join(root,'evidence.json'),JSON.stringify({date:new Date().toISOString(),downloadedMedia,output:info,bytes:(await stat(output)).size,jobs:jobs.map(j=>({id:j.id,state:j.state})),outputJob},null,2));
 }finally{await app.close();await new Promise<void>(resolve=>fixtureServer.close(()=>resolve()));}
});
