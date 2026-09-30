import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, symlink } from 'node:fs/promises';
import { Store } from '../packages/jobs/src/store.ts';
import { managedPath, retention } from '../apps/server/src/storage.ts';
import { JobRequestSchema, RecipeSchema, type Artifact, type MediaInfo } from '../packages/contracts/src/index.ts';

async function workspace() { const root=path.resolve('test-output/review'); await mkdir(root,{recursive:true}); return mkdtemp(path.join(root,'storage-')); }
const media:MediaInfo={duration:1,startTime:0,size:8,format:'test',streams:[],hdr:false};

test('retention deletes only expired eligible artifacts and protects originals, pins, leases, projects and jobs', async () => {
  const workDir=await workspace(), store=new Store(workDir);
  try {
    const owner=store.createUser('review-owner','owner');
    async function artifact(kind:Artifact['kind']='export',pinned=false) {
      const a:Artifact={id:randomUUID(),ownerId:owner.id,name:'sentinel',bytes:8,media,kind,createdAt:'2020-01-01T00:00:00.000Z',expiresAt:'2020-01-02T00:00:00.000Z',pinned,validated:true};
      await writeFile(path.join(workDir,'artifacts',a.id),'sentinel'); store.put('artifact',a.id,owner.id,a); return a;
    }
    function source(a:Artifact) { const s={id:randomUUID(),ownerId:owner.id,artifactId:a.id,name:'source',createdAt:'2020-01-01T00:00:00.000Z'};store.put('source',s.id,owner.id,s); return s; }
    const eligible=await artifact(), original=await artifact('original'), pinned=await artifact('export',true), leased=await artifact(), projectDependency=await artifact(), jobDependency=await artifact();
    store.lease(leased.id,60000);
    const projectSource=source(projectDependency), jobSource=source(jobDependency);
    const recipe=RecipeSchema.parse({sourceId:projectSource.id,segments:[{in:0,out:1}]});
    store.put('project',randomUUID(),owner.id,{recipe});
    store.submit(owner.id,JobRequestSchema.parse({type:'proxy',sourceId:jobSource.id}),randomUUID());
    assert.deepEqual(await retention(store,owner.id),[eligible.id]);
    assert.equal(store.get('artifact',eligible.id,owner.id),undefined);
    await assert.rejects(readFile(path.join(workDir,'artifacts',eligible.id)),{code:'ENOENT'});
    for(const a of [original,pinned,leased,projectDependency,jobDependency]) assert.equal(await readFile(await managedPath(store,a.id),'utf8'),'sentinel');
  } finally {store.close();}
});

test('artifact lookup rejects traversal and a redirected managed directory', async () => {
  const workDir=await workspace(), store=new Store(workDir);
  try {
    await assert.rejects(managedPath(store,'../workbench.sqlite'),/Invalid artifact/);
    const outside=path.join(workDir,'outside');await mkdir(outside);
    const id=randomUUID();await writeFile(path.join(outside,id),'outside original');
    await rename(path.join(workDir,'artifacts'),path.join(workDir,'artifacts-old'));
    await symlink(outside,path.join(workDir,'artifacts'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(managedPath(store,id),/Unsafe artifact directory/);
    assert.equal(await readFile(path.join(outside,id),'utf8'),'outside original');
  } finally {store.close();}
});

test('persistent identities enforce owner-specific idempotency, token scope, expiry and revocation', async () => {
  const workDir=await workspace(), store=new Store(workDir);
  try {
    const a=store.createUser('A','owner'),b=store.createUser('B','member');
    const request=JobRequestSchema.parse({type:'proxy',sourceId:randomUUID()});
    const first=store.submit(a.id,request,'same-key'),second=store.submit(a.id,request,'same-key');
    assert.equal(first.created,true); assert.equal(second.created,false); assert.equal(first.job.id,second.job.id);
    assert.notEqual(store.submit(b.id,request,'same-key').job.id,first.job.id);
    assert.equal(store.job(first.job.id,b.id),undefined);
    assert.throws(()=>store.submit(a.id,JobRequestSchema.parse({type:'proxy',sourceId:randomUUID()}),'same-key'),/different request/);
    const credential=store.token(a.id,'Read only',['read']);assert.deepEqual(store.auth(credential.token)?.scopes,['read']);
    store.revoke(b.id,credential.id); assert(store.auth(credential.token),'other user cannot revoke token');
    store.revoke(a.id,credential.id); assert.equal(store.auth(credential.token),undefined);
    assert.equal(store.auth(store.token(a.id,'Expired',['read'],undefined,'2020-01-01T00:00:00.000Z').token),undefined);
  } finally {store.close();}
});
