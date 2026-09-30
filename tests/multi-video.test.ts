import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp,mkdir,readFile,writeFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DownloadSchema } from '../packages/contracts/src/index.ts';
import { defaultPolicy } from '../packages/core/src/policy.ts';
import { discoverTools,runProcess,validateMedia,toolVersions } from '../packages/media/src/index.ts';
import { inspectDownload,downloadMedia } from '../apps/server/src/download.ts';

test('real yt-dlp bounded multi-video inspection and explicit item selection preserve the selected media',{timeout:120000},async()=>{
 const root=await mkdtemp(path.resolve('test-output/multi-video-')),tools=await discoverTools();
 const originals:Buffer[]=[];for(const [i,color] of ['red','blue'].entries()){const file=path.join(root,`source-${i+1}.mp4`);await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i',`color=c=${color}:size=${160+i*32}x${90+i*18}:rate=10:duration=1`,'-c:v','libx264','-crf','0',file]);originals.push(await readFile(file));}
 const mediaRequests:string[]=[];const server=http.createServer((req,res)=>{const url=new URL(req.url!,'http://fixture');if(url.pathname==='/post'||url.pathname==='/large'){const count=url.pathname==='/large'?105:2;res.writeHead(200,{'content-type':'text/html'});res.end(`<html><title>Multiple videos fixture</title>${Array.from({length:count},(_,i)=>`<video controls src="/video-${i+1}.mp4"></video>`).join('')}</html>`);}else {const match=/^\/video-(\d+)\.mp4$/.exec(url.pathname);if(!match){res.writeHead(404);return res.end();}mediaRequests.push(url.pathname);const data=originals[(Number(match[1])-1)%2];res.writeHead(200,{'content-type':'video/mp4','content-length':data.length});res.end(data);}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const context=async(name:string)=>{const workDir=path.join(root,name);await mkdir(workDir);return {workDir,signal:AbortSignal.timeout(90000),maxRuntimeSeconds:30,policy:defaultPolicy('owner'),testOrigin:origin};};
 const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
 try{
  const metadata=await inspectDownload(DownloadSchema.parse({url:origin+'/post'}),tools,await context('inspect'));assert.equal(metadata.entries.length,2);assert.deepEqual(metadata.entries.map((e:any)=>e.itemIndex),[1,2]);assert(metadata.entries.every((e:any)=>e.formats.length>0));
  const bounded=await inspectDownload(DownloadSchema.parse({url:origin+'/large'}),tools,await context('bounded'));assert.equal(bounded.entries.length,100);assert.equal(bounded.limitReached,true);assert.equal(bounded.inspectionLimit,100);
  mediaRequests.length=0;const first=await downloadMedia(DownloadSchema.parse({url:origin+'/post',preference:'original'}),tools,await context('default'));const firstMedia=await validateMedia(first.path,tools);assert.equal(hash(await readFile(first.path)),hash(originals[0]));assert(!mediaRequests.includes('/video-2.mp4'),'first-item default must not transfer the other video');
  mediaRequests.length=0;const second=await downloadMedia(DownloadSchema.parse({url:origin+'/post',itemIndex:2,preference:'original'}),tools,await context('second'));const secondMedia=await validateMedia(second.path,tools);assert.equal(hash(await readFile(second.path)),hash(originals[1]));assert(!mediaRequests.includes('/video-1.mp4'),'selected second item must not transfer the first video');
  const missing=await context('missing');await assert.rejects(downloadMedia(DownloadSchema.parse({url:origin+'/post',itemIndex:3}),tools,missing),/Selected media item is unavailable/);assert.deepEqual(await readdir(missing.workDir),[]);
  const direct=await context('direct');await assert.rejects(downloadMedia(DownloadSchema.parse({url:origin+'/video-1.mp4?list=incidental-playlist',itemIndex:2}),tools,direct),/Selected media item is unavailable/);assert.deepEqual(await readdir(direct.workDir),[]);
  const directDefault=await downloadMedia(DownloadSchema.parse({url:origin+'/video-1.mp4?list=incidental-playlist'}),tools,await context('direct-default'));await validateMedia(directDefault.path,tools);assert.equal(hash(await readFile(directDefault.path)),hash(originals[0]));
  for(const itemIndex of [0,-1,1.5,101,'2'])assert.equal(DownloadSchema.safeParse({url:origin+'/post',itemIndex}).success,false);
  await writeFile(path.join(root,'evidence.json'),JSON.stringify({versions:await toolVersions(tools),inspection:metadata,inspectionLimit:bounded.inspectionLimit,boundedEntries:bounded.entries.length,first:{hash:hash(await readFile(first.path)),media:firstMedia},second:{hash:hash(await readFile(second.path)),media:secondMedia},checks:['first item default','explicit second item only','bounded100of105metadataentries','missing item rejected before completed output','direct URL cannot masquerade as item2','direct media with incidental list remains one file','invalid indices rejected']},null,2));
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
