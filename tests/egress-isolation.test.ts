import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';

function docker(args:string[],timeoutMs=30000):Promise<{code:number;stdout:string;stderr:string}>{return new Promise((resolve,reject)=>{const child=spawn('docker',args,{shell:false,windowsHide:true});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error(`Docker timed out: ${args[0]}`));},timeoutMs);child.stdout.on('data',data=>stdout+=data.toString());child.stderr.on('data',data=>stderr+=data.toString());child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);resolve({code:code??1,stdout,stderr});});});}
test('network-none workers use only a readonly Unix-socket proxy for real yt-dlp', {skip:process.env.MW_TEST_DOCKER_EGRESS!=='1',timeout:180000},async()=>{
  const id=randomUUID().slice(0,12),volume=`mw-egress-proof-${id}`,sidecar=`mw-egress-sidecar-${id}`,imageTag=process.env.MW_WORKER_IMAGE||'media-workbench:local';
  const imageInfo=await docker(['image','inspect',imageTag,'--format','{{.Id}}']);assert.equal(imageInfo.code,0,imageInfo.stderr);const image=imageInfo.stdout.trim();
  const directory=path.resolve('test-output/egress',id);await mkdir(directory,{recursive:true});const fixtureDir=path.resolve('test-output/fixtures');const scripts=path.resolve('deploy/egress');
  const scriptMount=`type=bind,source=${scripts},target=/proof,readonly`,outMount=`type=bind,source=${directory},target=/out`,fixtureMount=`type=bind,source=${fixtureDir},target=/fixture,readonly`;
  const workerBase=['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','512m','--cpus','1','--tmpfs','/tmp:rw,exec,nosuid,nodev,size=256m','--mount',scriptMount,'--mount',outMount,'--mount',`type=volume,source=${volume},target=/proxy,readonly`];
  const outputs:any[]=[];
  try {
    let result=await docker(['volume','create',volume]);assert.equal(result.code,0,result.stderr);
    result=await docker(['run','--rm','--user','0','--network','none','--cap-drop','ALL','--mount',`type=volume,source=${volume},target=/proxy`,image,'/usr/local/bin/node','-e',"require('node:fs').chmodSync('/proxy',0o777)"]);assert.equal(result.code,0,result.stderr);
    result=await docker(['run','-d','--name',sidecar,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','128m','--cpus','0.5','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--mount',scriptMount,'--mount',fixtureMount,'--mount',`type=volume,source=${volume},target=/proxy`,image,'/usr/local/bin/node','/proof/proof-sidecar.mjs']);assert.equal(result.code,0,result.stderr);
    let ready=false;for(let i=0;i<30;i++){result=await docker(['logs',sidecar]);if(result.stdout.includes('egress-ready')){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,200));}assert.ok(ready,`${result.stdout}\n${result.stderr}`);
    result=await docker([...workerBase,image,'/usr/local/bin/node','/proof/proof-worker.mjs']);outputs.push({test:'raw socket, DNS, private destinations and readonly socket mount',...result});assert.equal(result.code,0,result.stderr);
    const common=['/usr/local/bin/node','/proof/relay.mjs','--socket','/proxy/egress.sock','--','/usr/local/bin/yt-dlp','--ignore-config','--no-plugin-dirs','--no-playlist','--no-remote-components','--no-cache-dir','--js-runtimes','node:/usr/local/bin/node','--ffmpeg-location','/usr/bin','--proxy','http://discarded.invalid:123','--socket-timeout','3','--retries','0','--fragment-retries','0'];
    result=await docker([...workerBase,image,...common,'-o','/out/verified.%(ext)s','--','http://127.0.0.1:18081/movie.mp4'],45000);outputs.push({test:'real yt-dlp uses relay and downloads full fixture',...result});assert.equal(result.code,0,result.stderr);
    const actual=await readFile(path.join(directory,'verified.mp4')),expected=await readFile(path.join(fixtureDir,'numbered-cfr.mp4'));assert.deepEqual(actual,expected);
    result=await docker([...workerBase,image,'/usr/bin/ffmpeg','-v','error','-i','/out/verified.mp4','-f','null','-']);outputs.push({test:'downloaded artifact fully decodes',...result});assert.equal(result.code,0,result.stderr);
    for(const [name,url] of [['redirect','http://127.0.0.1:18081/redirect-private'],['nested','http://127.0.0.1:18081/nested.m3u8']]){const before=(await docker(['logs',sidecar])).stdout.match(/egress-denied/g)?.length||0;result=await docker([...workerBase,image,...common,'-o',`/out/${name}.%(ext)s`,'--',url],45000);const after=(await docker(['logs',sidecar])).stdout.match(/egress-denied/g)?.length||0;outputs.push({test:`${name} private destination blocked through actual yt-dlp`,proxyDeniedRequests:after-before,...result});assert.notEqual(result.code,0);assert.ok(after>before,`${name}: failed without an observed proxy rejection: ${result.stderr}`);}
    await writeFile(path.join(directory,'evidence.json'),JSON.stringify({testedAt:new Date().toISOString(),imageTag,image,workerNetwork:'none',proxyTransport:'per-job Unix socket, readonly worker mount',bytes:actual.length,sha256:createHash('sha256').update(actual).digest('hex'),outputs},null,2));
  } catch(error) {await writeFile(path.join(directory,'failure.json'),JSON.stringify({error:String(error),outputs,sidecar:await docker(['logs',sidecar])},null,2));throw error;} finally {await docker(['rm','-f',sidecar]);await docker(['volume','rm',volume]);}
});
