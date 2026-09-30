import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, access } from 'node:fs/promises';
import { Store } from '../packages/jobs/src/store.ts';
import { importCookies, withCookies, forgetCookies, registerBrowser } from '../apps/server/src/credentials.ts';

test('synthetic cookie import is encrypted at rest, owner-scoped, temporary during use, and forgotten', {timeout:30000},async()=>{
  const root=path.resolve('test-output/review');await mkdir(root,{recursive:true});const workDir=await mkdtemp(path.join(root,'cookies-')),store=new Store(workDir);
  try {
    const owner=store.createUser('cookie-owner','owner'),other=store.createUser('other','member');
    // Deliberately synthetic credential fixture; it grants access to no service.
    const content='# Netscape HTTP Cookie File\n.example.invalid\tTRUE\t/\tFALSE\t0\treview_test_cookie\tSYNTHETIC_NOT_A_SECRET\n';
    const item=await importCookies(store,owner.id,'Synthetic review jar',content);
    const protectedFile=path.join(workDir,'credentials',item.id),stored=await readFile(protectedFile);
    assert(!stored.includes(Buffer.from('SYNTHETIC_NOT_A_SECRET')),'plaintext cookie absent from stored encrypted bytes');
    assert(!JSON.stringify(item).includes('SYNTHETIC_NOT_A_SECRET'),'credential values absent from metadata');
    await assert.rejects(withCookies(store,other.id,item.id,path.join(workDir,'work'),async()=>{}),/not found/);
    let decryptedPath='';
    await assert.rejects(withCookies(store,owner.id,item.id,path.join(workDir,'work'),async({cookieFile})=>{decryptedPath=cookieFile!;assert.equal(await readFile(decryptedPath,'utf8'),content);throw Error('synthetic callback failure');}),/synthetic callback failure/);
    await assert.rejects(access(decryptedPath),{code:'ENOENT'});
    await forgetCookies(store,owner.id,item.id);assert.equal(store.get('credential',item.id,owner.id),undefined);await assert.rejects(access(protectedFile),{code:'ENOENT'});
    for(const profile of ['C:\\Users\\owner','/home/owner','Profile:../../escape'])assert.throws(()=>registerBrowser(store,owner.id,'chrome',profile),/profile name/);
  } finally {store.close();}
});
