import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {downloadMedia,type DownloadContext} from '../apps/server/src/download.ts';
import {discoverTools,runProcess,validateMedia} from '../packages/media/src/index.ts';
import {defaultPolicy} from '../packages/core/src/policy.ts';
import {DownloadSchema,type ToolPaths} from '../packages/contracts/src/index.ts';
import {formatRows} from '../apps/web/src/downloadQuality.ts';
import {createServer} from '../apps/server/src/app.ts';

test('native WebM video becomes an MP4 with the same decoded video and audio', {timeout:90000},async t=>{
 await mkdir(path.resolve('test-output'),{recursive:true});const root=await mkdtemp(path.resolve('test-output/mp4-download-')),tools=await discoverTools();
 const webm=path.join(root,'source.webm');
 await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x72:rate=10:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libvpx-vp9','-c:a','libopus',webm]);
 let bytes=await readFile(webm);const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':req.url?.endsWith('.mkv')?'video/x-matroska':'video/webm','content-length':bytes.length});res.end(bytes);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`,workDir=path.join(root,'work');await mkdir(workDir);
 const ctx:DownloadContext={workDir,signal:AbortSignal.timeout(60000),maxRuntimeSeconds:45,policy:defaultPolicy('owner'),testOrigin:origin};
 const result=await downloadMedia(DownloadSchema.parse({url:origin+'/source.webm',preference:'original'}),tools,ctx);
 assert.equal(result.name,'download.mp4');assert.deepEqual((await readdir(workDir)).filter(f=>f.startsWith('download.')),['download.mp4']);
 const media=await validateMedia(result.path,tools);assert.match(media.format,/mp4/);assert.equal(media.streams.find(s=>s.type==='video')?.codec,'vp9');assert.equal(media.streams.find(s=>s.type==='audio')?.codec,'opus');
 const frames=async(file:string)=>(await runProcess(tools.ffmpeg,['-v','error','-i',file,'-map','0:v:0','-f','hash','-hash','sha256','-'])).stdout.toString();
 assert.equal(await frames(result.path),await frames(webm),'remux preserves all decoded frames');
 const mkv=path.join(root,'source.mkv');await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x72:rate=10:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','huffyuv','-pix_fmt','yuv422p','-c:a','pcm_s16le',mkv]);bytes=await readFile(mkv);
 const encodeDir=path.join(root,'encode');await mkdir(encodeDir);const encoded=await downloadMedia(DownloadSchema.parse({url:origin+'/source.mkv',preference:'original'}),tools,{...ctx,workDir:encodeDir});
 assert.equal(encoded.name,'download.mp4');const converted=await validateMedia(encoded.path,tools);assert.equal(converted.streams.find(s=>s.type==='video')?.codec,'h264');assert.equal(converted.streams.find(s=>s.type==='audio')?.codec,'aac');assert.ok(Math.abs(converted.duration-1)<.1);assert.deepEqual(await readdir(encodeDir),['download.mp4']);
});

test('failed MP4 merges use an intermediate then convert, and unsupported codecs trigger a bounded encode',async t=>{
 const root=await mkdtemp(path.resolve('test-output/mp4-fallback-'));const server=http.createServer((_req,res)=>res.end('fixture'));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;const tools:ToolPaths={ffmpeg:'ffmpeg',ffprobe:'ffprobe',ytdlp:'yt-dlp'};
 const calls:string[][]=[];let failed=false;
 const ctx:DownloadContext={workDir:root,signal:new AbortController().signal,maxBytes:1024,policy:{...defaultPolicy('owner'),maxInputBytes:2048},testOrigin:origin,runTool:async(binary,args)=>{
  calls.push(args);
  if(binary==='yt-dlp'){
   if(args[args.indexOf('--merge-output-format')+1]==='mp4'){await writeFile(path.join(root,'download.mp4'),'partial');throw Error('Native tool failed (1): Postprocessing: unsupported codec');}
   await writeFile(path.join(root,'download.mkv'),'video');
  }else if(binary==='ffprobe')return {stdout:Buffer.from('{"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}'),stderr:'',exitCode:0};
  else {assert.equal(args[args.indexOf('-fs')+1],'1025');assert.equal(args[args.indexOf('-protocol_whitelist')+1],'file,pipe');if(!failed){failed=true;await writeFile(args.at(-1)!,'partial');throw Error('Could not find tag for codec in stream: codec not currently supported in container');}assert.ok(args.includes('libx264'));assert.ok(args.includes('aac'));await writeFile(args.at(-1)!,'mp4');}
  return {stdout:Buffer.alloc(0),stderr:'',exitCode:0};
 }};
 const result=await downloadMedia(DownloadSchema.parse({url:origin+'/video'}),tools,ctx);
 assert.equal(result.name,'download.mp4');assert.equal(await readFile(result.path,'utf8'),'mp4');assert.deepEqual(await readdir(root),['download.mp4']);assert.equal(calls.length,5);
});

test('format rows promise the final MP4 container while audio-only choices keep their format',()=>{
 const rows=formatRows([{id:'v',ext:'webm',width:1920,height:1080,vcodec:'vp9',acodec:'none'},{id:'a',ext:'m4a',vcodec:'none',acodec:'aac'}]);
 assert.equal(rows[0].ext,'MP4');assert.equal(rows[0].format,'v+a/v');assert.equal(rows[0].codec,'VP9 / AAC');assert.equal(rows[1].ext,'M4A');
});

test('completed inspections are reused only for the same user and policy; disabled downloads cannot hit the cache', {timeout:90000},async t=>{
 const root=await mkdtemp(path.resolve('test-output/inspection-cache-')),tools=await discoverTools(),file=path.join(root,'source.mp4');
 await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','color=size=128x72:duration=1','-c:v','libx264',file]);const bytes=await readFile(file);let hits=0;
 const server=http.createServer((_req,res)=>{hits++;res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});res.end(bytes);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`,token=randomUUID(),app=await createServer({dataDir:path.join(root,'data'),ownerToken:token,encoders:[],testOrigin:origin});t.after(()=>app.close());
 const headers={host:'localhost',authorization:`Bearer ${token}`},payload={url:origin+'/source.mp4'};
 const first=await app.inject({method:'POST',url:'/api/v1/sources/inspect',headers,payload});assert.equal(first.statusCode,200,first.body);const count=hits;assert.ok(count>0);
 const again=await app.inject({method:'POST',url:'/api/v1/sources/inspect',headers,payload});assert.equal(again.statusCode,200);assert.deepEqual(again.json(),first.json());assert.equal(hits,count,'cache bypasses network and native startup');
 const owner=app.store.users().find(u=>u.role==='owner')!;app.store.updateUser(owner.id,{...owner.policy,allowedSites:['127.0.0.1']});
 assert.equal((await app.inject({method:'POST',url:'/api/v1/sources/inspect',headers,payload})).statusCode,200);assert.ok(hits>count,'changed policy invalidates cached inspection');
 const member=app.store.createUser('Other user','member'),credential=app.store.token(member.id,'Member');app.store.updateUser(member.id,{...member.policy,download:true});const beforeOther=hits;
 assert.equal((await app.inject({method:'POST',url:'/api/v1/sources/inspect',headers:{host:'localhost',authorization:`Bearer ${credential.token}`},payload})).statusCode,200);assert.ok(hits>beforeOther,'other user performs a separate extraction');
 app.store.updateUser(owner.id,{...owner.policy,download:false});assert.equal((await app.inject({method:'POST',url:'/api/v1/sources/inspect',headers,payload})).statusCode,403);
});
