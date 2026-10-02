import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,stat,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer as httpServer} from 'node:http';
import {createServer} from '../apps/server/src/app.ts';
import {discoverTools,runProcess,inspectLocalImport} from '../packages/media/src/index.ts';
import {DownloadSchema} from '../packages/contracts/src/index.ts';
import type {Artifact} from '../packages/contracts/src/index.ts';

test('desktop imports use bounded checks; named downloads save in an authorized folder without overwriting', {timeout:60000},async()=>{
 await mkdir(resolve('test-output'),{recursive:true});const root=await mkdtemp(resolve('test-output/import-fixes-')),tools=await discoverTools(),file=join(root,'fixture.mp4');
 await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x72:rate=10:duration=2','-c:v','libx264','-pix_fmt','yuv420p',file]);const bytes=await readFile(file);
 const server=httpServer((_req,res)=>{res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});res.end(bytes);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const token=randomUUID(),secret=randomUUID(),app=await createServer({dataDir:join(root,'data'),ownerToken:token,desktopSecret:secret,encoders:[],testOrigin:origin});const headers={host:'localhost',authorization:`Bearer ${token}`};
 try{
  const caps=(await app.inject({url:'/api/v1/capabilities',headers})).json();assert.equal(caps.user.policy.maxInputBytes,20*1024**3);assert.equal(caps.user.policy.maxDuration,86400);
  const base={signal:new AbortController().signal,workDir:root};let checks=0;
  await inspectLocalImport(file,tools,{...base,runTool:async(binary,args,options)=>{if(args.includes('-xerror')){checks++;assert.equal(args[args.indexOf('-t')+1],'0.25');}return runProcess(binary,args,base,options);}});assert.equal(checks,2);
  const upload=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});assert.equal(upload.statusCode,200,upload.body);
  const invalid=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers,'content-type':'application/octet-stream'},payload:Buffer.from('invalid media')});assert.equal(invalid.statusCode,400);
  const folder=join(root,'Downloads');await mkdir(folder);const denied=await app.inject({method:'POST',url:'/api/v1/desktop/download-folder',headers,payload:{path:folder}});assert.equal(denied.statusCode,403);
  const selected=await app.inject({method:'POST',url:'/api/v1/desktop/download-folder',headers:{...headers,'x-desktop-secret':secret},payload:{path:folder}});assert.equal(selected.statusCode,200,selected.body);
  assert.throws(()=>DownloadSchema.parse({url:origin,fileName:'../escape.mp4'}));assert.equal(DownloadSchema.parse({url:origin,fileName:'My video'}).fileName,'My video');
  const request={type:'download',download:{url:origin+'/fixture.mp4',fileName:'My video',destinationId:selected.json().id}};
  const unauthorized=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers,'idempotency-key':randomUUID()},payload:{...request,download:{...request.download,destinationId:randomUUID()}}});assert.equal(unauthorized.statusCode,403);
  await writeFile(join(folder,'My video.mp4'),'Keep this existing file');
  const response=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{...headers,'idempotency-key':randomUUID()},payload:request});assert.equal(response.statusCode,202,response.body);
  let job=app.store.job(response.json().id)!;for(let i=0;i<200&&!['completed','failed'].includes(job.state);i++){await new Promise(r=>setTimeout(r,100));job=app.store.job(job.id)!;}
  assert.equal(job.state,'completed',job.error);assert.equal(job.savingError,undefined);assert.equal(job.savedPath,join(folder,'My video (1).mp4'));assert.equal((await stat(job.savedPath!)).size,bytes.length);assert.equal(await readFile(join(folder,'My video.mp4'),'utf8'),'Keep this existing file');
 }finally{await app.close();await new Promise<void>(r=>server.close(()=>r()));}
});

test('large preview open-ended ranges stay bounded and support seeks near the end',async()=>{
 await mkdir(resolve('test-output'),{recursive:true});const root=await mkdtemp(resolve('test-output/large-preview-')),token=randomUUID();
 const app=await createServer({dataDir:root,ownerToken:token,encoders:[],startQueue:false});
 try{
  const owner=app.store.users().find(u=>u.role==='owner')!,id=randomUUID(),size=3*1024**3;
  const file=await open(join(root,'artifacts',id),'wx');await file.truncate(size);await file.close();
  // Sparse transfer fixture checks byte ranges, not media decoding.
  const artifact:Artifact={id,ownerId:owner.id,name:'range.bin',bytes:size,media:{duration:7500,startTime:0,size,format:'test',streams:[],hdr:false},kind:'original',createdAt:new Date().toISOString(),pinned:false,validated:true};
  app.store.put('artifact',id,owner.id,artifact);
  const headers={host:'localhost',authorization:`Bearer ${token}`};
  const first=await app.inject({url:`/api/v1/artifacts/${id}/content`,headers:{...headers,range:'bytes=0-'}});
  assert.equal(first.statusCode,206,first.body.slice(0,100));assert.equal(first.rawPayload.length,8*1024**2);assert.equal(first.headers['content-range'],`bytes 0-8388607/${size}`);
  const end=await app.inject({url:`/api/v1/artifacts/${id}/content`,headers:{...headers,range:`bytes=${size-1024}-`}});
  assert.equal(end.statusCode,206);assert.equal(end.rawPayload.length,1024);assert.equal(end.headers['content-range'],`bytes ${size-1024}-${size-1}/${size}`);
 }finally{await app.close();}
});
