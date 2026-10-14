import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';

const privateOrigin='https://fixture.example.ts.net:9443';
test('private access fails closed for invalid origin or incompatible hosting modes',async()=>{
 const root=path.resolve('test-output/reliability');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'private-invalid-'));
 for(const extra of [{shared:true},{tunnelPrototype:true},{privateOrigin:'http://fixture.example.ts.net'},{privateOrigin:privateOrigin+'/path'}]){
  const dataDir=path.join(dir,randomUUID());await assert.rejects(createServer({dataDir,privateOrigin,...extra}),/Private/);
  await assert.rejects(access(dataDir));
 }
});

test('private browser access keeps anonymous and other user credentials out while preserving loopback owner use',async()=>{
 const root=path.resolve('test-output/reliability');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'private-access-'));
 const ownerToken=randomUUID(),app=await createServer({dataDir:dir,ownerToken,privateOrigin,encoders:[],startQueue:false});
 const remote={host:'fixture.example.ts.net:9443',origin:privateOrigin};
 try{
  const member=app.store.createUser('Test member','member'),memberToken=app.store.token(member.id,'Fixture credential').token;
  assert.equal((await app.inject({url:'/api/v1/jobs',headers:remote})).statusCode,401);
  assert.equal((await app.inject({url:'/api/v1/jobs',headers:{...remote,authorization:`Bearer ${memberToken}`}})).statusCode,403);
  const denied=await app.inject({method:'POST',url:'/api/v1/session',headers:remote,payload:{token:memberToken}});assert.equal(denied.statusCode,403);assert.equal(denied.headers['set-cookie'],undefined);
  const paired=await app.inject({method:'POST',url:'/api/v1/session',headers:remote,payload:{token:ownerToken}});assert.equal(paired.statusCode,200,paired.body);
  const cookie=String(paired.headers['set-cookie']);for(const flag of ['Secure','HttpOnly','SameSite=Strict'])assert(cookie.includes(flag),flag);
  assert.equal((await app.inject({url:'/api/v1/capabilities',headers:{...remote,cookie:cookie.split(';')[0]}})).json().mode,'local');
  assert.equal((await app.inject({url:'/api/v1/jobs',headers:{host:'localhost',authorization:`Bearer ${ownerToken}`}})).statusCode,200);
  const local=await app.inject({method:'POST',url:'/api/v1/session',headers:{host:'localhost',origin:'http://localhost'},payload:{token:ownerToken}});assert.equal(local.statusCode,200);assert(!String(local.headers['set-cookie']).includes('Secure'));
  for(const headers of [{...remote,origin:'https://attacker.example'},{...remote,origin:'http://fixture.example.ts.net:9443'},{...remote,host:'attacker.example'}])assert.equal((await app.inject({url:'/api/v1/jobs',headers:{...headers,authorization:`Bearer ${ownerToken}`}})).statusCode,403);
 }finally{await app.close();}
});

test('token-free private access rejects public/shared or nonloopback configuration before opening storage',async()=>{
 const root=path.resolve('test-output/reliability');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'private-no-token-invalid-'));
 for(const extra of [{privateOrigin:undefined},{shared:true},{tunnelPrototype:true},{publicOrigin:'https://public.example'},{host:'0.0.0.0'},{host:'::'},{host:'192.168.1.20'},{privateOrigin:'https://public.example'}]){
  const dataDir=path.join(dir,randomUUID());await assert.rejects(createServer({dataDir,privateOrigin,privateNoToken:true,...extra}),/Token-free private access/);
  await assert.rejects(access(dataDir));
 }
});

test('token-free private Serve access requires its exact host, loopback peer and identity while keeping tokens unchanged',async()=>{
 const root=path.resolve('test-output/reliability');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'private-no-token-'));
 const app=await createServer({dataDir:dir,ownerToken:randomUUID(),privateOrigin,privateNoToken:true,host:'127.0.0.1',encoders:[],startQueue:false});
 const headers={host:'fixture.example.ts.net:9443',origin:privateOrigin,'tailscale-user-login':'fixture@example.invalid'};
 try{
  const owner=app.store.users().find(user=>user.role==='owner')!,tokensBefore=app.store.tokens(owner.id);
  const accepted=await app.inject({url:'/api/v1/capabilities',headers,remoteAddress:'127.0.0.1'});assert.equal(accepted.statusCode,200,accepted.body);assert.equal(accepted.json().user.id,owner.id);assert.equal(accepted.headers['set-cookie'],undefined);
  app.store.updateUser(owner.id,{...owner.policy,maxQueued:2});
  assert.equal((await app.inject({url:'/api/v1/capabilities',headers,remoteAddress:'127.0.0.1'})).json().user.policy.maxQueued,2);
  assert.equal((await app.inject({url:'/api/v1/jobs',headers,remoteAddress:'::1'})).statusCode,200);
  assert.equal((await app.inject({url:'/api/v1/jobs',headers,remoteAddress:'192.168.1.20'})).statusCode,401);
  assert.equal((await app.inject({url:'/api/v1/jobs',headers:{host:headers.host,origin:headers.origin},remoteAddress:'127.0.0.1'})).statusCode,401);
  for(const extra of [{'tailscale-user-login':''},{host:'fixture.example.ts.net:443'},{host:'localhost'}])assert.equal((await app.inject({url:'/api/v1/jobs',headers:{...headers,...extra},remoteAddress:'127.0.0.1'})).statusCode,401);
  assert.equal((await app.inject({url:'/api/v1/jobs',headers:{...headers,origin:'https://attacker.example'},remoteAddress:'127.0.0.1'})).statusCode,403);
  assert.deepEqual(app.store.tokens(owner.id),tokensBefore);
 }finally{await app.close();}
 const authenticated=await createServer({dataDir:dir,privateOrigin,host:'127.0.0.1',encoders:[],startQueue:false});
 try{assert.equal((await authenticated.inject({url:'/api/v1/jobs',headers,remoteAddress:'127.0.0.1'})).statusCode,401);}finally{await authenticated.close();}
});
