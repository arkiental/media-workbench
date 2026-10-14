import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../packages/jobs/src/store.ts';
import { publish } from '../apps/server/src/storage.ts';
import { runProcess } from '../packages/media/src/process.ts';
import type { ExecutionContext, MediaInfo } from '../packages/contracts/src/index.ts';

const media:MediaInfo={format:'mp4',duration:1,startTime:0,size:4,hdr:false,streams:[]};
async function workspace(){const root=path.resolve('test-output/reliability');await mkdir(root,{recursive:true});return mkdtemp(path.join(root,'publication-'));}

test('an isolated native runner cannot report success after cancellation',async()=>{
 const controller=new AbortController();
 const ctx:ExecutionContext={workDir:await workspace(),signal:controller.signal,runTool:async()=>{controller.abort();return {stdout:Buffer.from('completed'),stderr:'',exitCode:0};}};
 await assert.rejects(runProcess(process.execPath,[],ctx),/cancelled/i);
});

test('cancelled publication leaves the staged original and storage quota unchanged',async()=>{
 const root=await workspace(),store=new Store(path.join(root,'data'));const user=store.createUser('Publication fixture','owner');
 const staged=path.join(root,'staged.mp4');await writeFile(staged,'test');const controller=new AbortController();controller.abort();
 const available=store.availableBytes(user.id);
 try{
  await assert.rejects(publish(store,staged,user.id,'fixture.mp4',media,'original',undefined,undefined,undefined,controller.signal),/cancelled/i);
  assert.equal(await readFile(staged,'utf8'),'test');assert.deepEqual(await readdir(path.join(store.dataDir,'artifacts')),[]);
  assert.deepEqual(store.all('artifact',user.id),[]);assert.equal(store.availableBytes(user.id),available);
 }finally{store.close();}
});

test('metadata write failure restores the staged file instead of leaving an orphaned artifact',async()=>{
 const root=await workspace(),store=new Store(path.join(root,'data'));const user=store.createUser('Publication fixture','owner');
 const staged=path.join(root,'staged.mp4');await writeFile(staged,'test');const original=store.put.bind(store),available=store.availableBytes(user.id);
 store.put=()=>{throw Error('Controlled metadata write failure');};
 try{
  await assert.rejects(publish(store,staged,user.id,'fixture.mp4',media,'original'),/metadata write failure/);
  assert.equal(await readFile(staged,'utf8'),'test');assert.deepEqual(await readdir(path.join(store.dataDir,'artifacts')),[]);
  assert.equal(store.availableBytes(user.id),available);
 }finally{store.put=original;store.close();}
});
