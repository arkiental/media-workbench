import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const {desktopStorage}=createRequire(import.meta.url)('../apps/desktop/workspace-storage.cjs');
test('desktop workspace survives reopening and rejects stale writes without overwriting newer data',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mw-drafts-')),a=desktopStorage(root),b=desktopStorage(root),key='mw:draft:1:owner:source:source';
 assert.equal(a.get(key),null);a.set(key,'two sections',null);assert.equal(b.get(key),'two sections');
 b.set(key,'three sections','two sections');assert.throws(()=>a.set(key,'stale','two sections'),/newer workspace draft/);assert.equal(a.get(key),'three sections');
 assert.equal(a.get('mw:draft:1:owner:missing:source'),null);a.set('mw:draft:1:owner:second:source','second',null);assert.equal(a.get(key),'three sections');
 assert.equal((await readdir(root)).filter(name=>name.endsWith('.tmp')).length,0);
 assert((await Promise.all((await readdir(root)).map(name=>readFile(path.join(root,name),'utf8')))).includes('three sections'));
});
