import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools, runProcess } from '../packages/media/src/index.ts';

test('export planning refreshes incomplete encoder readiness without bypassing the owner policy',{timeout:45000},async()=>{
 const root=path.resolve('test-output/reliability');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'encoder-readiness-'));
 const tools=await discoverTools(),file=path.join(dir,'fixture.mp4');
 await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=96x64:rate=10:duration=2','-an','-c:v','libx264',file]);
 const token=randomUUID(),app=await createServer({dataDir:path.join(dir,'data'),ownerToken:token,tools,startQueue:false});
 const headers={host:'localhost',authorization:`Bearer ${token}`};
 try{
  const imported=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{...headers,'content-type':'application/octet-stream'},payload:await readFile(file)});
  assert.equal(imported.statusCode,200,imported.body);
  app.encoders.splice(0,app.encoders.length);
  const payload={recipe:{sourceId:imported.json().id,segments:[{in:0,out:1}]},options:{cut:'exact',codec:'h264',encoder:'software'}};
  const plan=await app.inject({method:'POST',url:'/api/v1/export/plan',headers,payload});
  assert.equal(plan.statusCode,200,plan.body);assert.equal(plan.json().encoder,'libx264');
  assert(app.encoders.some(e=>e.name==='libx264'&&e.available));
  const owner=app.store.users().find(user=>user.role==='owner')!;
  app.store.updateUser(owner.id,{...owner.policy,allowedEncoders:['libx265']});
  const denied=await app.inject({method:'POST',url:'/api/v1/export/plan',headers,payload});
  assert.equal(denied.statusCode,400,denied.body);assert.match(denied.body,/No operational/);
 }finally{await app.close();}
});
