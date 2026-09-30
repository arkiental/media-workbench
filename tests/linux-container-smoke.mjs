import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const output=resolve('test-output/linux-container');await mkdir(output,{recursive:true});
const name=`mw-linux-smoke-${randomUUID().slice(0,8)}`,image='media-workbench:local';
async function exec(binary,args,input){return new Promise((res,rej)=>{const c=spawn(binary,args,{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',d=>{stdout+=d;if(stdout.length>4e6)c.kill();});c.stderr.on('data',d=>{stderr=(stderr+d).slice(-20000);});c.on('error',rej);c.on('close',code=>code===0?res({stdout,stderr}):rej(Error(`${binary} exited ${code}: ${stderr}\n${stdout.slice(-5000)}`)));c.stdin.end(input);});}
const docker=(args,input)=>exec('docker',args,input);
const inside=String.raw`
import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const base='http://127.0.0.1:4319';
let ready=false;for(let i=0;i<120;i++){try{const r=await fetch(base+'/api/v1/capabilities');if(r.status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert(ready,'service became ready');
assert.notEqual(process.getuid(),0);assert.equal(process.env.PATH,'/not-a-developer-path');
await assert.rejects(writeFile('/app/forbidden','x'),/EROFS|EACCES/);
await assert.rejects(access('/app/node_modules/electron'));
const token=(await readFile('/data/owner-token','utf8')).trim();
async function api(route,options={}){const r=await fetch(base+route,{...options,headers:{authorization:'Bearer '+token,...options.headers}});if(!r.ok)throw Error(r.status+' '+await r.text());return r;}
const caps=await (await api('/api/v1/capabilities')).json();assert.equal(caps.sharedHosting.enabled,false);assert(caps.tools.ffmpeg.includes('9.0.1'));assert.equal(caps.tools.ytdlp,'2026.08.19');assert(caps.encoders.find(e=>e.name==='libx264')?.available);
execFileSync('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=2','-f','lavfi','-i','sine=frequency=1000:duration=2','-c:v','libx264','-crf','0','-c:a','aac','-y','/tmp/fixture.mp4']);
const source=await (await api('/api/v1/uploads',{method:'POST',headers:{'content-type':'application/octet-stream','x-filename':'linux-fixture.mp4'},body:await readFile('/tmp/fixture.mp4')})).json();
const body={type:'export',recipe:{sourceId:source.id,segments:[{in:.2,out:1.6}],text:[{in:.2,out:1.3,text:'Linux real output'}]},options:{cut:'exact',mode:'size',maxBytes:60000,audioBitrate:32000}};
const key='linux-smoke-idempotency';const job=await (await api('/api/v1/jobs',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)})).json();const again=await (await api('/api/v1/jobs',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)})).json();assert.equal(again.id,job.id);
let final;for(let i=0;i<240;i++){final=await (await api('/api/v1/jobs/'+job.id)).json();if(['completed','failed','cancelled'].includes(final.state))break;await new Promise(r=>setTimeout(r,250));}assert.equal(final.state,'completed',JSON.stringify(final));
const r=await api('/api/v1/artifacts/'+final.artifactId+'/content');const bytes=Buffer.from(await r.arrayBuffer());assert(bytes.length<=60000&&bytes.length>1000);await writeFile('/tmp/linux-output.mp4',bytes);
const partial=await api('/api/v1/artifacts/'+final.artifactId+'/content',{headers:{range:'bytes=0-99'}});assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,100);
execFileSync('/usr/bin/ffmpeg',['-v','error','-xerror','-i','/tmp/linux-output.mp4','-f','null','-']);const probe=JSON.parse(execFileSync('/usr/bin/ffprobe',['-v','error','-show_format','-show_streams','-of','json','/tmp/linux-output.mp4'],{encoding:'utf8'}));assert(Math.abs(Number(probe.format.duration)-1.4)<.1);assert.equal(Number(probe.streams.find(s=>s.codec_type==='video').nb_frames),14);
const unauthorized=await fetch(base+'/api/v1/artifacts/'+final.artifactId+'/content');assert.equal(unauthorized.status,401);
await assert.rejects(fetch('http://1.1.1.1',{signal:AbortSignal.timeout(1500)}));
console.log(JSON.stringify({platform:process.platform,uid:process.getuid(),node:process.version,tools:caps.tools,bytes:bytes.length,media:probe,plan:final.plan,checks:['headless-no-electron','empty-developer-PATH','read-only-root','non-root','network-none','authenticated-upload','real-edit-export','14-frames','strict-60000-bytes','authenticated-ranges','idempotent-job','unauthorized-output-401','shared-disabled']}));
`;

let created=false;
try{
  if(!process.argv.includes('--skip-build')){console.log('Building pinned Linux runtime image…');const result=await docker(['build','--target','runtime','-t',image,'.']);await writeFile(join(output,'build.log'),result.stdout+result.stderr);}
  await docker(['run','-d','--init','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','256','--memory','3g','--cpus','2','--tmpfs','/tmp:rw,exec,nosuid,nodev,size=512m','--tmpfs','/data:rw,noexec,nosuid,nodev,size=1g,uid=1000,gid=1000','-e','PATH=/not-a-developer-path',image]);created=true;
  const result=await docker(['exec','-i',name,'/usr/local/bin/node','--input-type=module'],inside);const evidence=JSON.parse(result.stdout.trim());
  // docker cp does not reliably traverse a tmpfs mount. Transfer our generated
  // output through the container process, then independently inspect the bytes.
  const mediaBytes=await docker(['exec',name,'/usr/local/bin/node','-e',"process.stdout.write(require('node:fs').readFileSync('/tmp/linux-output.mp4').toString('base64'))"]);
  await writeFile(join(output,'linux-output.mp4'),Buffer.from(mediaBytes.stdout,'base64'));
  const ffprobe=process.env.MW_FFPROBE||resolve('.tools',process.platform==='win32'?'ffprobe.exe':'ffprobe');
  const checked=await exec(ffprobe,['-v','error','-show_format','-show_streams','-of','json',join(output,'linux-output.mp4')]);evidence.independentHostProbe=JSON.parse(checked.stdout);assert(Math.abs(Number(evidence.independentHostProbe.format.duration)-1.4)<.1);
  evidence.testedAt=new Date().toISOString();evidence.image=JSON.parse((await docker(['image','inspect',image])).stdout)[0].Id;
  await writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:true,evidence:join(output,'evidence.json'),bytes:evidence.bytes,checks:evidence.checks}));
}finally{if(created){await docker(['logs',name]).then(r=>writeFile(join(output,'service.log'),r.stdout+r.stderr)).catch(()=>{});await docker(['rm','-f','-v',name]);}}
