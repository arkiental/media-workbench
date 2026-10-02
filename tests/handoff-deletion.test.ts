import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from '../apps/server/src/app.ts';
import {nativeCopy,deleteArtifact,retention,publish} from '../apps/server/src/storage.ts';
import {Store} from '../packages/jobs/src/store.ts';
import type {Artifact,MediaInfo} from '../packages/contracts/src/index.ts';

test('native handoff releases the library file and survives its deletion until expiry',async()=>{
  await mkdir(resolve('test-output'),{recursive:true});const root=await mkdtemp(resolve('test-output/handoff-delete-'));
  const token=randomUUID(),secret=randomUUID();const app=await createServer({dataDir:join(root,'data'),ownerToken:token,desktopSecret:secret,encoders:[],startQueue:false});
  try{
    const owner=app.store.users()[0],input=join(root,'fixture.mp4'),bytes=Buffer.from('handoff byte preservation fixture');await writeFile(input,bytes);
    const media={size:bytes.length,duration:1,format:'mp4',streams:[{type:'video',codec:'h264'}]} as MediaInfo;
    const artifact=await publish(app.store,input,owner.id,'clip.mp4',media,'export');
    const copying=nativeCopy(app.store,artifact);
    await assert.rejects(deleteArtifact(app.store,artifact),/protected/);
    const handoffPath=await copying;assert.equal(app.store.leased(artifact.id),false);
    const response=await app.inject({url:`/api/v1/desktop/artifacts/${artifact.id}`,headers:{host:'localhost',authorization:`Bearer ${token}`,'x-desktop-secret':secret}});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.json().path,handoffPath);assert.equal(app.store.leased(artifact.id),false);
    const deleted=await app.inject({method:'DELETE',url:`/api/v1/artifacts/${artifact.id}`,headers:{host:'localhost',authorization:`Bearer ${token}`}});
    assert.equal(deleted.statusCode,200,deleted.body);assert.deepEqual(await readFile(handoffPath),bytes);
    assert.equal(app.store.get('artifact',artifact.id,owner.id),undefined);assert.equal(app.store.diskUsage(owner.id),bytes.length);
    await retention(app.store,owner.id);assert.deepEqual(await readFile(handoffPath),bytes);
    const copy=app.store.get<any>('handoff',artifact.id,owner.id);app.store.put('handoff',artifact.id,owner.id,{...copy,expiresAt:'2000-01-01T00:00:00.000Z'});
    await retention(app.store,owner.id);await assert.rejects(access(handoffPath));assert.equal(app.store.diskUsage(owner.id),0);
    const failedId=randomUUID();await assert.rejects(nativeCopy(app.store,{...artifact,id:failedId} as Artifact));assert.equal(app.store.leased(failedId),false);
  }finally{await app.close();}
});

test('startup migrates old handoff locks without shortening copy lifetime or removing unrelated locks',async()=>{
  const root=await mkdtemp(resolve('test-output/handoff-migration-'));let store=new Store(root);
  const owner=store.createUser('Owner','owner'),id=randomUUID(),other=randomUUID();store.put('handoff',id,owner.id,{id,expiresAt:'2000-01-01T00:00:00.000Z'});store.lease(id,3600000);store.lease(other,60000);
  const until=(store.db.prepare('SELECT until FROM leases WHERE id=?').get(id) as {until:string}).until;
  store.db.prepare('DELETE FROM settings WHERE key=?').run('independent-handoffs-v1');store.close();store=new Store(root);
  try{assert.equal(store.leased(id),false);assert.equal(store.leased(other),true);assert.equal(store.get<any>('handoff',id,owner.id).expiresAt,until);}finally{store.close();}
});
