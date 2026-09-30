import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable,Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BandwidthLimiter } from '../apps/server/src/bandwidth.ts';
import { runProcess } from '../packages/media/src/process.ts';
import { createEgressProxy } from '../apps/server/src/network.ts';

test('independent host bandwidth limit schedules aggregate bytes before delivering parallel streams',{timeout:10000},async()=>{
 const limiter=new BandwidthLimiter(),start=performance.now();let received=0;
 const stream=()=>pipeline(Readable.from([Buffer.alloc(4096)]),limiter.stream('same-user',4096,8192),new Writable({write(chunk,encoding,callback){received+=chunk.length;callback();}}));
 await Promise.all([stream(),stream()]);assert.equal(received,8192);assert(performance.now()-start>=1800,'parallel streams must share the owner rate');
 await assert.rejects(pipeline(Readable.from([Buffer.alloc(1025)]),limiter.stream('other-user',4096,1024),new Writable({write(chunk,encoding,callback){callback();}})),/byte policy/);
});

test('independent local proxy delays first complete body, shares concurrent rate and fails closed after byte ceiling',{timeout:20000},async()=>{
 const body=Buffer.alloc(8192,97),checks:unknown[]=[],fixture=http.createServer((req,res)=>{res.writeHead(200,{'Content-Length':body.length});res.end(body);});
 await new Promise<void>(resolve=>fixture.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
 const fetch=(proxy:string)=>new Promise<Buffer>((resolve,reject)=>{const url=new URL(proxy),req=http.get({hostname:url.hostname,port:url.port,path:origin+'/bytes',headers:{host:new URL(origin).host}},res=>{const chunks:Buffer[]=[];if(res.statusCode!==200){res.resume();reject(Error(`status ${res.statusCode}`));return;}res.on('error',reject);res.on('aborted',()=>reject(Error('response aborted')));res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(Buffer.concat(chunks)));});req.on('error',reject);});
 try{
  let proxy=await createEgressProxy(65536,new AbortController().signal,origin,1024);
  try{const start=performance.now();assert.deepEqual(await fetch(proxy.url),body);const elapsedMs=performance.now()-start;assert(elapsedMs>=6500,'first complete body bypassed the configured rate');checks.push({case:'first HTTP body',bytes:8192,bytesPerSecond:1024,elapsedMs});}finally{proxy.close();}
  proxy=await createEgressProxy(65536,new AbortController().signal,origin,8192);
  try{const start=performance.now(),outputs=await Promise.all([fetch(proxy.url),fetch(proxy.url)]);outputs.forEach(value=>assert.deepEqual(value,body));const elapsedMs=performance.now()-start;assert(elapsedMs>=1800,'parallel responses bypassed aggregate proxy rate');checks.push({case:'concurrent HTTP responses',bytes:16384,bytesPerSecond:8192,elapsedMs});}finally{proxy.close();}
  proxy=await createEgressProxy(1024,new AbortController().signal,origin,8192);
  try{await assert.rejects(fetch(proxy.url));assert.match(proxy.violation,/byte policy/);await assert.rejects(fetch(proxy.url),/status 403/);checks.push({case:'byte ceiling and subsequent request fail closed',maxBytes:1024});}finally{proxy.close();}
 }finally{fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));}
 const root=path.resolve('test-output/review');await mkdir(root,{recursive:true});const evidence=await mkdtemp(path.join(root,'local-bandwidth-'));await writeFile(path.join(evidence,'evidence.json'),JSON.stringify({checks},null,2));
});

test('independent socket proxy limits first HTTP/TLS payloads, concurrent transfers and total bytes',{skip:process.env.MW_TEST_ISOLATION!=='1',timeout:45000},async()=>{
 const root=path.resolve('test-output/review');await mkdir(root,{recursive:true});const work=await mkdtemp(path.join(root,'proxy-bandwidth-')),script=path.join(work,'proof.mjs');
 await writeFile(script,`import http from 'node:http';import https from 'node:https';import tls from 'node:tls';import fs from 'node:fs';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';import {createUnixProxy} from '/proof/proxy.mjs';
 const bytes=Buffer.alloc(8192,97),checks=[],respond=(req,res)=>{res.writeHead(200,{'Content-Length':bytes.length});res.end(bytes);},fixture=http.createServer(respond);await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+fixture.address().port;
 const fetch=socketPath=>new Promise((resolve,reject)=>{const req=http.get({socketPath,path:origin+'/data',headers:{host:new URL(origin).host}},res=>{const chunks=[];res.on('error',reject);res.on('aborted',()=>reject(new Error('response aborted')));res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(Buffer.concat(chunks)));});req.on('error',reject);});
 let proxy=await createUnixProxy({socketPath:'/proxy/egress.sock',testOrigin:origin,maxBytes:65536,bytesPerSecond:1024});try{let start=performance.now();assert.deepEqual(await fetch('/proxy/egress.sock'),bytes);let elapsedMs=performance.now()-start;assert(elapsedMs>=6500,'first8192-byte HTTP response completed too early: '+elapsedMs);checks.push({case:'first HTTP body',bytes:8192,bytesPerSecond:1024,elapsedMs});}finally{await proxy.close();}
 proxy=await createUnixProxy({socketPath:'/proxy/egress.sock',testOrigin:origin,maxBytes:65536,bytesPerSecond:8192});try{const start=performance.now(),results=await Promise.all([fetch('/proxy/egress.sock'),fetch('/proxy/egress.sock')]);for(const value of results)assert.deepEqual(value,bytes);const elapsedMs=performance.now()-start;assert(elapsedMs>=1800,'two transfers must share aggregate rate');checks.push({case:'two concurrent HTTP transfers',bytes:16384,bytesPerSecond:8192,elapsedMs});}finally{await proxy.close();}
 proxy=await createUnixProxy({socketPath:'/proxy/egress.sock',testOrigin:origin,maxBytes:1024,bytesPerSecond:8192});try{await assert.rejects(fetch('/proxy/egress.sock'));assert.match(proxy.violation,/byte policy/);checks.push({case:'byte ceiling rejects complete8192-byte body',maxBytes:1024});}finally{await proxy.close();await new Promise(resolve=>fixture.close(resolve));}
 const cert=spawnSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-noenc','-keyout','/proxy/key.pem','-out','/proxy/cert.pem','-days','1','-subj','/CN=localhost'],{encoding:'utf8'});assert.equal(cert.status,0,cert.stderr);const secureFixture=https.createServer({key:fs.readFileSync('/proxy/key.pem'),cert:fs.readFileSync('/proxy/cert.pem')},respond);await new Promise(resolve=>secureFixture.listen(0,'127.0.0.1',resolve));const secureOrigin='https://127.0.0.1:'+secureFixture.address().port;
 proxy=await createUnixProxy({socketPath:'/proxy/egress.sock',testOrigin:secureOrigin,maxBytes:65536,bytesPerSecond:4096});try{const tunneled=await new Promise((resolve,reject)=>{const req=http.request({socketPath:'/proxy/egress.sock',method:'CONNECT',path:new URL(secureOrigin).host});req.on('connect',(res,socket)=>{assert.equal(res.statusCode,200);resolve(socket);});req.on('error',reject);req.end();});const socket=tls.connect({socket:tunneled,rejectUnauthorized:false});await new Promise((resolve,reject)=>{socket.once('secureConnect',resolve);socket.once('error',reject);});const start=performance.now(),result=await new Promise((resolve,reject)=>{const chunks=[];socket.on('data',chunk=>chunks.push(chunk));socket.on('end',()=>resolve(Buffer.concat(chunks)));socket.on('error',reject);socket.write('GET /data HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n');});const elapsedMs=performance.now()-start,separator=result.indexOf('\\r\\n\\r\\n');assert(separator>=0);assert.deepEqual(result.subarray(separator+4),bytes);assert(elapsedMs>=1800,'first complete TLS response bypassed bandwidth rate');checks.push({case:'first actual TLS body through CONNECT',bytes:8192,bytesPerSecond:4096,elapsedMs});}finally{await proxy.close();await new Promise(resolve=>secureFixture.close(resolve));}console.log(JSON.stringify({checks}));`);
 const result=await runProcess('docker',['run','--rm','--network','none','--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--tmpfs','/proxy:rw,size=1m,uid=1000,gid=1000,mode=0700','--mount',`type=bind,source=${path.resolve('deploy/egress/proxy.mjs')},target=/proof/proxy.mjs,readonly`,'--mount',`type=bind,source=${script},target=/review.mjs,readonly`,'--entrypoint','/usr/local/bin/node',process.env.MW_WORKER_IMAGE||'media-workbench:local','/review.mjs']);
 const evidence=JSON.parse(result.stdout.toString());assert.equal(evidence.checks.length,4);await writeFile(path.join(work,'evidence.json'),JSON.stringify(evidence,null,2));
});
