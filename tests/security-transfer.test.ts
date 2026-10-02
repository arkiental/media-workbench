import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, open, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';
import { retention } from '../apps/server/src/storage.ts';
import type { Artifact } from '../packages/contracts/src/index.ts';
import { Store } from '../packages/jobs/src/store.ts';

test('upgrading preview locks releases stale reads but keeps native handoff protection',async()=>{
  await mkdir(path.resolve('test-output/review'),{recursive:true});const root=await mkdtemp(path.resolve('test-output/review/lease-upgrade-'));
  let store=new Store(root);
  const owner=store.createUser('Generated owner','owner'),preview=randomUUID(),handoff=randomUUID();
  store.lease(preview,3600000);store.lease(handoff,3600000);store.put('handoff',handoff,owner.id,{id:handoff});
  store.db.prepare('DELETE FROM settings WHERE key=?').run('scoped-preview-holds-v1');store.close();
  store=new Store(root);
  try{assert.equal(store.leased(preview),false);assert.equal(store.leased(handoff),true);store.lease(preview,60000);}finally{store.close();}
  store=new Store(root);try{assert.equal(store.leased(preview),true,'migration runs only once');assert.equal(store.leased(handoff),true);}finally{store.close();}
});

test('an actual backpressured HTTP transfer protects media until close and releases it immediately afterward', {timeout:15000},async()=>{
  const root=path.resolve('test-output/review');await mkdir(root,{recursive:true});const dataDir=await mkdtemp(path.join(root,'transfer-'));const token='transfer-review-'+randomUUID();const app=await createServer({dataDir,ownerToken:token,encoders:[],startQueue:false});
  let request:http.ClientRequest|undefined,response:http.IncomingMessage|undefined;
  try {
    const owner=app.store.users().find(u=>u.role==='owner')!;const id=randomUUID(),file=path.join(dataDir,'artifacts',id),size=64*1024*1024;
    const handle=await open(file,'wx');await handle.truncate(size);await handle.close();
    // Sparse owned bytes test transfer/retention; this is deliberately not a media-validity fixture.
    const artifact:Artifact={id,ownerId:owner.id,name:'transfer.bin',bytes:size,media:{duration:1,startTime:0,size,format:'test',streams:[],hdr:false},kind:'export',createdAt:'2020-01-01T00:00:00.000Z',expiresAt:'2020-01-02T00:00:00.000Z',pinned:false,validated:true};app.store.put('artifact',id,owner.id,artifact);
    await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as AddressInfo).port;
    response=await new Promise<http.IncomingMessage>((resolve,reject)=>{request=http.get({hostname:'127.0.0.1',port,path:`/api/v1/artifacts/${id}/content`,headers:{authorization:`Bearer ${token}`}},res=>{res.pause();resolve(res);});request.on('error',reject);});
    assert.equal(response.statusCode,200);assert(app.store.leased(id));
    assert.deepEqual(await retention(app.store,owner.id),[]);await access(file);
    await new Promise(r=>setTimeout(r,500));assert.equal(response.complete,false,'transfer is still actively backpressured');assert(app.store.leased(id));assert.deepEqual(await retention(app.store,owner.id),[]);await access(file);
    const denied=await app.inject({method:'DELETE',url:`/api/v1/artifacts/${id}`,headers:{host:'localhost',authorization:`Bearer ${token}`}});assert(denied.statusCode>=400);await access(file);
    response.destroy();request?.destroy();
    for(let attempt=0;attempt<100&&app.store.leased(id);attempt++)await new Promise(r=>setTimeout(r,20));
    assert.equal(app.store.leased(id),false,'closed preview/download does not retain a one-hour deletion lock');
    assert.deepEqual(await retention(app.store,owner.id),[id]);await assert.rejects(access(file));
    await writeFile(path.join(dataDir,'transfer-evidence.json'),JSON.stringify({bytes:size,backpressureProtected:true,activeDeletionBlocked:true,closedTransferReleased:true},null,2));
  } finally {response?.destroy();request?.destroy();await app.close();}
});
