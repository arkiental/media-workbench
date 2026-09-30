// Attempts bypasses from the same network-less worker profile used for media tools.
import net from 'node:net';
import http from 'node:http';
import { Resolver } from 'node:dns/promises';
import { readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const checks=[];
for(const [host,port] of [['1.1.1.1',443],['169.254.169.254',80],['172.17.0.1',80],['192.168.65.254',80],['127.0.0.1',18081],['::1',18081],['2606:4700:4700::1111',443]]) {
  const result=await new Promise(resolve=>{const s=net.connect({host,port});const end=result=>{s.destroy();resolve(result);};s.setTimeout(1200,()=>end('timeout'));s.on('error',e=>end(e.code));s.on('connect',()=>end('CONNECTED'));});
  assert.notEqual(result,'CONNECTED',`Worker reached ${host}:${port} without proxy`);checks.push({test:'raw socket bypass',host,port,result});
}
const resolver=new Resolver({timeout:800,tries:1});resolver.setServers(['1.1.1.1']);let dnsResult;try{await resolver.resolve4('example.com');dnsResult='RESOLVED';}catch(e){dnsResult=e.code;}finally{resolver.cancel();}assert.notEqual(dnsResult,'RESOLVED');checks.push({test:'direct DNS bypass',result:dnsResult});
const proxyRequest=(url,method='GET')=>new Promise((resolve,reject)=>{const request=http.request({socketPath:'/proxy/egress.sock',path:url,method,headers:{host:new URL(method==='CONNECT'?`https://${url}`:url).host},timeout:3000},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('connect',(response,socket)=>{socket.destroy();resolve(response.statusCode);});request.on('error',reject);request.on('timeout',()=>request.destroy(new Error('Proxy request timed out')));request.end();});
for(const url of ['http://127.0.0.1/','http://10.0.0.1/','http://172.16.0.1/','http://192.168.1.1/','http://169.254.169.254/','http://[::1]/','http://[fc00::1]/','http://[fe80::1]/','http://[::ffff:127.0.0.1]/','http://localhost/']) {const status=await proxyRequest(url);assert.equal(status,403,url);checks.push({test:'proxy private HTTP rejection',url,status});}
for(const target of ['127.0.0.1:443','169.254.169.254:443','[::1]:443','[::ffff:127.0.0.1]:443']){const status=await proxyRequest(target,'CONNECT');assert.equal(status,403,target);checks.push({test:'proxy private CONNECT rejection',target,status});}
const fixtureStatus=await proxyRequest('http://127.0.0.1:18081/movie.mp4');assert.equal(fixtureStatus,200);checks.push({test:'explicit isolated fixture allowed through socket proxy',status:fixtureStatus});
const route=await readFile('/proc/net/route','utf8');const interfaces=await readFile('/proc/net/dev','utf8');assert.ok(!route.split('\n').slice(1).some(line=>line.trim()&&line.split(/\s+/)[1]==='00000000'));checks.push({test:'no default route',route,interfaces});
let readOnly;try{await writeFile('/proxy/worker-write-attempt','denied');readOnly=false;}catch(e){readOnly=e.code==='EROFS'||e.code==='EACCES';}assert.equal(readOnly,true);checks.push({test:'socket mount is readonly',readOnly});
await writeFile('/out/socket-proof.json',JSON.stringify({testedAt:new Date().toISOString(),checks},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
