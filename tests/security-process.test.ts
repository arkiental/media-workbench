import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../packages/media/src/process.ts';

const root = path.resolve('test-output/review');
async function workspace() { await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, 'process-')); }
function exists(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('untrusted argument values remain separate literal arguments', async () => {
  const workDir = await workspace();
  const values = ['spaces in name.mp4', 'quote"name', 'Unicode-雪-ș', '& echo INJECTED', '$(whoami)', '; touch unexpected', '--exec=bad'];
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...values], { workDir, signal: new AbortController().signal });
  assert.deepEqual(JSON.parse(result.stdout.toString()), values);
});

test('cancellation kills an owned child and grandchild while preserving unrelated files', async () => {
  const workDir = await workspace();
  const unrelated = path.join(workDir, 'original-do-not-delete.txt');
  const pids = path.join(workDir, 'owned-pids.json');
  await writeFile(unrelated, 'original sentinel');
  const childScript = `setInterval(() => {}, 1000)`;
  const parentScript = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore',windowsHide:true}); fs.writeFileSync(process.argv[1], JSON.stringify([process.pid,c.pid])); setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const running = runProcess(process.execPath, ['-e', parentScript, pids], { workDir, signal: controller.signal, maxRuntimeSeconds: 10 });
  let owned: number[] = [];
  for (let i=0; i<100; i++) { try { owned = JSON.parse(await readFile(pids,'utf8')); break; } catch { await new Promise(r=>setTimeout(r,25)); } }
  assert.equal(owned.length, 2, 'owned descendant process started');
  assert(owned.every(exists));
  controller.abort();
  await assert.rejects(running, /cancelled/i);
  for (let i=0; i<100 && owned.some(exists); i++) await new Promise(r=>setTimeout(r,25));
  assert(owned.every(pid=>!exists(pid)), `owned processes still alive: ${owned.filter(exists).join(', ')}`);
  assert.equal(await readFile(unrelated,'utf8'), 'original sentinel');
});

test('native stdout resource limit fails instead of accumulating unbounded output', async () => {
  const workDir = await workspace();
  await assert.rejects(runProcess(process.execPath, ['-e', "setInterval(()=>process.stdout.write(Buffer.alloc(65536)),1)"], { workDir, signal: new AbortController().signal, maxRuntimeSeconds: 5 }, { maxStdoutBytes: 1024 }), /output exceeded limit/);
});

test('Linux forced group cleanup kills a SIGTERM-resistant descendant after its parent exits', {skip:process.platform==='win32'}, async () => {
  const workDir=await workspace(), ready=path.join(workDir,'resistant.pid');
  const descendant=`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
  const parent=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const controller=new AbortController();const running=runProcess(process.execPath,['-e',parent,ready],{workDir,signal:controller.signal,maxRuntimeSeconds:10});
  let pid=0;for(let i=0;i<100;i++){try{pid=Number(await readFile(ready,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,25));}}
  assert(pid>0&&exists(pid));controller.abort();await assert.rejects(running,/cancelled/);
  for(let i=0;i<120&&exists(pid);i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(exists(pid),false,'descendant must receive forced kill despite direct parent closing earlier');
});
