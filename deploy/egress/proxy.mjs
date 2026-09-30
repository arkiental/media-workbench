import http from 'node:http';
import net from 'node:net';
import { Transform } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { createRequire } from 'node:module';
import { mkdir,chmod,unlink,lstat } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const ipaddr=createRequire('/app/package.json')('ipaddr.js');

function publicAddress(address) {
  try {let parsed=ipaddr.parse(address);if(parsed.kind()==='ipv6'&&parsed.isIPv4MappedAddress())parsed=parsed.toIPv4Address();return parsed.range()==='unicast';}catch{return false;}
}
async function destination(raw,testOrigin) {
  const url=new URL(raw);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Only HTTP(S) without URL credentials is permitted.');
  if(testOrigin&&url.origin===testOrigin)return {url,address:'127.0.0.1'};
  if(!['','80','443'].includes(url.port))throw new Error('Only HTTP(S) standard ports are permitted.');
  const hostname=url.hostname.replace(/^\[|\]$/g,'');const addresses=net.isIP(hostname)?[{address:hostname}]:await lookup(hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('Private or reserved destination rejected.');
  return {url,address:addresses[0].address};
}

/** One proxy per job. The socket volume is the worker's only outgoing network channel. */
export async function createUnixProxy({socketPath,maxBytes=500_000_000,bytesPerSecond=50*1024*1024,testOrigin,onRejected}) {
  if(!socketPath.startsWith('/proxy/')||!Number.isSafeInteger(maxBytes)||maxBytes<1024)throw new Error('Invalid private proxy configuration.');
  await mkdir(dirname(socketPath),{recursive:true});
  try{const previous=await lstat(socketPath);if(!previous.isSocket())throw new Error('Proxy destination is not a socket.');await unlink(socketPath);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!Number.isFinite(bytesPerSecond)||bytesPerSecond<1024)throw new Error('Invalid proxy bandwidth policy');
  let transferred=0,violation='',nextAt=Date.now();const sockets=new Set();
  const limiters=new Set();
  const limiter=close=>{let timer;const stream=new Transform({transform(chunk,encoding,callback){transferred+=chunk.length;if(transferred>maxBytes){violation='Transfer byte policy exceeded';callback(new Error(violation));return;}const now=Date.now();nextAt=Math.max(now,nextAt)+chunk.length/bytesPerSecond*1000;timer=setTimeout(()=>callback(null,chunk),Math.max(0,nextAt-now));},destroy(error,callback){if(timer)clearTimeout(timer);callback(error);}});limiters.add(stream);stream.on('error',close);stream.on('close',()=>limiters.delete(stream));return stream;};
  const track=socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});return socket;};
  const server=http.createServer({requestTimeout:30000,headersTimeout:10000,maxHeaderSize:16384},async(req,res)=>{
    try {
      if(violation)throw new Error(violation);
      const {url,address}=await destination(req.url||'',testOrigin);
      if(url.protocol!=='http:'||!['GET','HEAD','POST','OPTIONS'].includes(req.method||''))throw new Error('Unsupported proxy operation.');
      const headers={...req.headers,host:url.host,connection:'close'};delete headers['proxy-authorization'];delete headers['proxy-connection'];delete headers.upgrade;
      const upstream=http.request({hostname:address,port:Number(url.port)||80,method:req.method,path:url.pathname+url.search,headers,timeout:120000},remote=>{res.writeHead(remote.statusCode||502,remote.headers);const inbound=limiter(()=>{upstream.destroy();res.destroy();});remote.on('error',()=>inbound.destroy());res.on('close',()=>inbound.destroy());remote.pipe(inbound).pipe(res);});
      upstream.on('socket',track);upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Upstream connection failed');});upstream.on('timeout',()=>upstream.destroy());
      const outbound=limiter(()=>{upstream.destroy();res.destroy();});req.on('aborted',()=>upstream.destroy());res.on('close',()=>{upstream.destroy();outbound.destroy();});req.pipe(outbound).pipe(upstream);
    }catch {onRejected?.();res.writeHead(403,{'content-type':'text/plain','connection':'close'});res.end('Network destination blocked');}
  });
  server.maxConnections=32;server.on('connection',socket=>{track(socket);socket.setTimeout(120000,()=>socket.destroy());});
  server.on('connect',async(req,client,head)=>{
    try {
      if(violation)throw new Error(violation);
      const {url,address}=await destination(`https://${req.url}/`,testOrigin);
      const upstream=track(net.connect({host:address,port:Number(url.port)||443}));track(client);
      let inbound,outbound;const close=()=>{upstream.destroy();client.destroy();inbound?.destroy();outbound?.destroy();};upstream.setTimeout(120000,close);client.setTimeout(120000,close);upstream.on('error',close);client.on('error',close);client.on('close',close);
      upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');inbound=limiter(close);outbound=limiter(close);if(head.length)outbound.write(head);upstream.pipe(inbound).pipe(client);client.pipe(outbound).pipe(upstream);});
    }catch{onRejected?.();client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
  });
  await new Promise((resolvePromise,reject)=>{server.once('error',reject);server.listen(socketPath,resolvePromise);});
  await chmod(socketPath,0o666);
  return {get transferred(){return transferred;},get violation(){return violation;},close:async()=>{for(const socket of sockets)socket.destroy();for(const stream of limiters)stream.destroy();await new Promise(resolvePromise=>server.close(resolvePromise));await unlink(socketPath).catch(()=>{});}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const proxy=await createUnixProxy({socketPath:process.env.MW_PROXY_SOCKET||'/proxy/egress.sock',maxBytes:Number(process.env.MW_PROXY_MAX_BYTES||500_000_000),bytesPerSecond:Number(process.env.MW_PROXY_BYTES_PER_SECOND||50*1024*1024)});
  process.stdout.write(JSON.stringify({event:'egress-ready'})+'\n');
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await proxy.close();process.exit(0);});
}
