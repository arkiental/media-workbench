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

test('an actual backpressured HTTP transfer renews its retention lease until the stream closes', {timeout:50000},async()=>{
  const root=path.resolve('test-output/review');await mkdir(root,{recursive:true});const dataDir=await mkdtemp(path.join(root,'transfer-'));const token='transfer-review-'+randomUUID();const app=await createServer({dataDir,ownerToken:token,encoders:[],startQueue:false});
  let request:http.ClientRequest|undefined,response:http.IncomingMessage|undefined;
  try {
    const owner=app.store.users().find(u=>u.role==='owner')!;const id=randomUUID(),file=path.join(dataDir,'artifacts',id),size=64*1024*1024;
    const handle=await open(file,'wx');await handle.truncate(size);await handle.close();
    // Sparse owned bytes test transfer/retention; this is deliberately not a media-validity fixture.
    const artifact:Artifact={id,ownerId:owner.id,name:'transfer.bin',bytes:size,media:{duration:1,startTime:0,size,format:'test',streams:[],hdr:false},kind:'export',createdAt:'2020-01-01T00:00:00.000Z',expiresAt:'2020-01-02T00:00:00.000Z',pinned:false,validated:true};app.store.put('artifact',id,owner.id,artifact);
    await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as AddressInfo).port;
    response=await new Promise<http.IncomingMessage>((resolve,reject)=>{request=http.get({hostname:'127.0.0.1',port,path:`/api/v1/artifacts/${id}/content`,headers:{authorization:`Bearer ${token}`}},res=>{res.pause();resolve(res);});request.on('error',reject);});
    assert.equal(response.statusCode,200);const lease=()=>String((app.store.db.prepare('SELECT until FROM leases WHERE id=?').get(id) as any).until);const first=lease();
    assert.deepEqual(await retention(app.store,owner.id),[]);await access(file);
    await new Promise(r=>setTimeout(r,31000));assert.equal(response.complete,false,'transfer is still actively backpressured');const renewed=lease();assert(Date.parse(renewed)>Date.parse(first)+20000,'active transfer lease was renewed rather than retaining its initial expiry');assert.deepEqual(await retention(app.store,owner.id),[]);await access(file);
    await writeFile(path.join(dataDir,'transfer-evidence.json'),JSON.stringify({bytes:size,firstLeaseUntil:first,renewedLeaseUntil:renewed,activeAfter31Seconds:true,expiredArtifactRetained:true},null,2));
  } finally {response?.destroy();request?.destroy();await app.close();}
});
