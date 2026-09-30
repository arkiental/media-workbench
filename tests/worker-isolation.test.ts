import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess,discoverTools,probe,validateMedia,exportMedia } from '../packages/media/src/index.ts';
import { IsolatedWorker } from '../apps/server/src/worker.ts';
import { RecipeSchema,ExportSchema } from '../packages/contracts/src/index.ts';
import { randomUUID } from 'node:crypto';

test('Docker worker has only explicit input mounts, no network, bounded resources and produces real media',{skip:process.env.MW_TEST_ISOLATION!=='1',timeout:120000},async()=>{
 const root=await mkdtemp(path.resolve('test-output/worker-'));const work=path.join(root,'work');await mkdir(work);const tools=await discoverTools();
 const image=(await runProcess('docker',['image','inspect','media-workbench:local','--format','{{.Id}}'])).stdout.toString().trim();const runner=new IsolatedWorker({image});
 const sentinel=path.join(root,'unmounted-secret');await writeFile(sentinel,'must-not-read');
 const fixture=path.join(root,'source.mp4');await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10:duration=2','-c:v','libx264','-crf','0',fixture]);
 const ctx=await runner.context({workDir:work,signal:new AbortController().signal,maxBytes:20000000,maxRuntimeSeconds:90},[fixture]);
 const script=`const fs=require('fs');const net=require('net');const checks={uid:process.getuid(),rootWritable:false,secretReadable:false,mountedInput:fs.existsSync('/inputs/0')};try{fs.writeFileSync('/app/nope','x');checks.rootWritable=true}catch{}try{fs.readFileSync(${JSON.stringify(sentinel)});checks.secretReadable=true}catch{};const s=net.connect({host:'1.1.1.1',port:80});s.setTimeout(1000);s.once('connect',()=>{checks.network=true;s.destroy()});s.once('error',()=>{checks.network=false});s.once('timeout',()=>{checks.network=false;s.destroy()});s.once('close',()=>console.log(JSON.stringify(checks)));`;
 const facts=JSON.parse((await runProcess(tools.node!,['-e',script],ctx)).stdout.toString());assert.equal(facts.uid,1000);assert.equal(facts.rootWritable,false);assert.equal(facts.secretReadable,false);assert.equal(facts.network,false);assert.equal(facts.mountedInput,true);
 const media=await probe(fixture,tools,ctx);assert.equal(media.streams[0].width,160);
 const output=path.join(work,'export.mp4');await exportMedia(fixture,output,RecipeSchema.parse({sourceId:randomUUID(),segments:[{in:.3,out:1.3}]}),ExportSchema.parse({cut:'exact',quality:0}),tools,ctx);const result=await validateMedia(output,tools);assert.ok(Math.abs(result.duration-1)<.05);
 const hashes=async(file:string)=>{const raw=(await runProcess(tools.ffmpeg,['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-'])).stdout.toString();return raw.split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1)!.trim());};assert.deepEqual(await hashes(output),(await hashes(fixture)).slice(3,13),'Every expected original frame must survive exact worker export');
 assert.equal(await readFile(sentinel,'utf8'),'must-not-read');await writeFile(path.join(root,'evidence.json'),JSON.stringify({image,facts,result},null,2));
});
