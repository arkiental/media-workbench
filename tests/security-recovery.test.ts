import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess } from '../packages/media/src/process.ts';
import { discoverTools, validateMedia } from '../packages/media/src/index.ts';

const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('real forced service crash retains an interrupted job and first retry replaces its partial workspace', {timeout:180000},async()=>{
  const root=path.resolve('test-output/review');await mkdir(root,{recursive:true});const dataDir=await mkdtemp(path.join(root,'crash-'));const token='crash-review-'+randomUUID(),tools=await discoverTools();
  const input=path.join(dataDir,'user-original.mp4');await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=960x540:rate=24','-t','12','-an','-c:v','libx264','-preset','veryfast','-crf','18',input]);
  const original=await readFile(input);const sentinel=path.join(dataDir,'unrelated-original.txt');await writeFile(sentinel,'never delete original');
  async function boot(){
    const child=spawn(process.execPath,['--import','tsx','apps/server/src/main.ts'],{cwd:path.resolve('.'),shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{...process.env,MW_DATA_DIR:dataDir,MW_OWNER_TOKEN:token,MW_PORT:'0',MW_HOST:'127.0.0.1'}});
    let stderr='';child.stderr.on('data',b=>stderr+=b.toString());
    const port=await new Promise<number>((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('Service boot timeout '+stderr)),45000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timeout);reject(Error(`Service boot exit ${code}: ${stderr}`));});child.stdout.on('data',b=>{output+=b;for(const line of output.split('\n')){try{const ready=JSON.parse(line);if(ready.event==='ready'){clearTimeout(timeout);resolve(ready.port);}}catch{}}});});
    const origin=`http://127.0.0.1:${port}`;
    const request=async(route:string,init:RequestInit={})=>{const response=await fetch(origin+route,{...init,headers:{authorization:`Bearer ${token}`,...init.headers}});return {status:response.status,value:await response.json()};};
    const stop=async()=>{if(child.exitCode!==null)return;if(process.platform==='win32')await runProcess('taskkill.exe',['/PID',String(child.pid),'/T','/F']);else process.kill(-child.pid!,'SIGKILL');await new Promise<void>(r=>{if(child.exitCode!==null)r();else child.once('exit',()=>r());});};
    return{child,origin,request,stop};
  }
  let server=await boot();
  try {
    const uploaded=await server.request('/api/v1/uploads',{method:'POST',headers:{'content-type':'application/octet-stream','x-filename':'user-original.mp4'},body:original});assert.equal(uploaded.status,200);
    const created=await server.request('/api/v1/jobs',{method:'POST',headers:{'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({type:'export',recipe:{sourceId:uploaded.value.id,segments:[{in:0,out:12}],audio:{mode:'mute'}},options:{cut:'exact',codec:'hevc',encoder:'software',speed:'quality',quality:18}})});assert.equal(created.status,202);
    const id=created.value.id,workDir=path.join(dataDir,'work',id);let observedPartial=false;
    for(let i=0;i<500;i++){const job=(await server.request(`/api/v1/jobs/${id}`)).value;if(job.state==='failed'||job.state==='completed')throw Error('Job ended before crash injection: '+JSON.stringify(job));try{const files=await readdir(workDir);if(job.state==='processing'&&files.some(f=>f.startsWith('.partial-'))){observedPartial=true;break;}}catch{}await pause(20);}
    assert(observedPartial,'real encode had created a partial output before forced termination');
    await server.stop();assert((await readdir(workDir)).length>0,'abrupt crash left a real partial workspace');
    server=await boot();const recovered=(await server.request(`/api/v1/jobs/${id}`)).value;assert.equal(recovered.state,'interrupted');assert(!recovered.artifactId);assert.match(recovered.message,/interrupted|retry/i);
    const retry=await server.request(`/api/v1/jobs/${id}/retry`,{method:'POST'});assert.equal(retry.status,200);let result:any;
    for(let i=0;i<1200;i++){result=(await server.request(`/api/v1/jobs/${id}`)).value;if(['completed','failed','cancelled'].includes(result.state))break;await pause(50);}
    assert.equal(result.state,'completed',JSON.stringify(result));assert.equal(result.attempt,2);
    const artifact=(await server.request('/api/v1/artifacts')).value.find((a:any)=>a.id===result.artifactId);assert(artifact?.validated);
    const output=path.join(dataDir,'artifacts',artifact.id);const actual=await validateMedia(output,tools);assert(Math.abs(actual.duration-12)<.15);assert((await stat(output)).size>0);
    assert.deepEqual(await readFile(input),original);assert.equal(await readFile(sentinel,'utf8'),'never delete original');
    await writeFile(path.join(dataDir,'recovery-evidence.json'),JSON.stringify({jobId:id,crashedAt:'processing with actual partial file',recoveredState:recovered.state,retryAttempt:result.attempt,resultState:result.state,output,media:actual,originalPreserved:true},null,2));
  } finally {await server.stop();}
});
