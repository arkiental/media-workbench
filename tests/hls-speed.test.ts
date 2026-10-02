import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import path from 'node:path';
import { mkdir,readFile,mkdtemp } from 'node:fs/promises';
import { downloadMedia } from '../apps/server/src/download.ts';
import { defaultPolicy } from '../packages/core/src/policy.ts';
import { discoverTools,runProcess,validateMedia } from '../packages/media/src/index.ts';

test('real HLS downloads use parallel fragments and keep complete media', {timeout:60000},async()=>{
  const root=path.resolve('test-output/hls-speed');await mkdir(root,{recursive:true});const work=await mkdtemp(path.join(root,'fixture-'));
  const tools=await discoverTools();
  await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10:duration=4','-c:v','libx264','-g','5','-sc_threshold','0','-hls_time','0.5','-hls_list_size','0','-hls_segment_filename',path.join(work,'chunk-%02d.ts'),path.join(work,'index.m3u8')]);
  let active=0,peak=0;
  const server=http.createServer(async(request,response)=>{
    try{
      const name=path.basename(new URL(request.url!,'http://localhost').pathname),data=await readFile(path.join(work,name));
      if(name.endsWith('.ts')){active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,100));active--;}
      response.writeHead(200,{'content-type':name.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t','content-length':data.length});response.end(data);
    }catch{response.writeHead(404);response.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  try{
    const timings:number[]=[];
    for(const concurrency of [1,8]){
      peak=0;const workDir=await mkdtemp(path.join(root,'download-'));const started=performance.now();
      const result=await downloadMedia({url:`${origin}/index.m3u8`,preference:'original'},tools,{workDir,signal:new AbortController().signal,testOrigin:origin,policy:defaultPolicy('owner'),runTool:(binary,args,options)=>{const selected=[...args],index=selected.indexOf('--concurrent-fragments');if(index>=0)selected[index+1]=String(concurrency);return runProcess(binary,selected,{workDir,signal:new AbortController().signal},options);}});
      timings.push(performance.now()-started);const media=await validateMedia(result.path,tools);assert(Math.abs(media.duration-4)<.1);
      if(concurrency===1)assert.equal(peak,1);else assert(peak>1&&peak<=8,`parallel fragments in flight: ${peak}`);
    }
    console.log(JSON.stringify({benchmark:'generated local HLS, 100ms fragment latency',sequentialMs:Math.round(timings[0]),parallelMs:Math.round(timings[1]),speedup:Number((timings[0]/timings[1]).toFixed(2))}));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
