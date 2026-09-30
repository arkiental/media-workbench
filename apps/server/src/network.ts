import http from 'node:http';
import net from 'node:net';
import { Transform, type Duplex } from 'node:stream';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
export function isPublicAddress(address:string){try {let a=ipaddr.parse(address);if(a.kind()==='ipv6'&&(a as ipaddr.IPv6).isIPv4MappedAddress())a=(a as ipaddr.IPv6).toIPv4Address();return a.range()==='unicast';}catch{return false;}}
export async function validateDestination(raw:string,allowedSites:string[]=[],testOrigin?:string){
 const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Only HTTP(S) URLs without embedded credentials are allowed');
 if(testOrigin&&url.origin===testOrigin)return {url,address:'127.0.0.1'};
 if(!['','80','443'].includes(url.port))throw Error('Only public HTTP(S) ports are allowed');
 if(allowedSites.length&&!allowedSites.some(h=>url.hostname===h||url.hostname.endsWith('.'+h)))throw Error('Site is not permitted by host policy');
 const hostname=url.hostname.replace(/^\[|\]$/g,'');const addresses=net.isIP(hostname)?[{address:hostname}]:await lookup(hostname,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw Error('Private, reserved, loopback and link-local destinations are blocked');
 return {url,address:addresses[0].address};
}
/** DNS-pinned filtering proxy for every downloader connection. Shared mode additionally requires mandatory worker egress isolation. */
export async function createEgressProxy(maxBytes:number,signal:AbortSignal,testOrigin?:string,bytesPerSecond=50*1024*1024){
 const sockets=new Set<Duplex>();const streams=new Set<Transform>();let bytes=0,nextAt=Date.now();let violation='';
 const limit=(close:()=>void)=>{let timer:NodeJS.Timeout;const stream=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>maxBytes){violation='Download transfer exceeded byte policy';callback(Error(violation));return;}const now=Date.now();nextAt=Math.max(now,nextAt)+chunk.length/bytesPerSecond*1000;timer=setTimeout(()=>callback(null,chunk),Math.max(0,nextAt-now));},destroy(error,callback){clearTimeout(timer);callback(error);}});streams.add(stream);stream.on('error',close);stream.on('close',()=>streams.delete(stream));return stream;};
 const server=http.createServer(async(req,res)=>{
  try{
   const {url,address}=await validateDestination(req.url||'',[],testOrigin);
   if(violation)throw Error(violation);if(url.protocol!=='http:'||!['GET','HEAD','POST','OPTIONS'].includes(req.method||''))throw Error('Unsupported proxy operation');
   const upstream=http.request({hostname:address,port:url.port||80,method:req.method,path:url.pathname+url.search,headers:{...req.headers,host:url.host},timeout:120000},remote=>{res.writeHead(remote.statusCode||502,remote.headers);const inbound=limit(()=>{upstream.destroy();res.destroy();});remote.on('error',()=>inbound.destroy());res.on('close',()=>inbound.destroy());remote.pipe(inbound).pipe(res);});
   upstream.on('socket',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});const outbound=limit(()=>{upstream.destroy();res.destroy();});req.on('aborted',()=>upstream.destroy());res.on('close',()=>{upstream.destroy();outbound.destroy();});req.pipe(outbound).pipe(upstream);
  }catch{res.writeHead(403);res.end('Network destination blocked');}
 });
 server.on('connect',async(req,client,head)=>{
  try{
   if(violation)throw Error(violation);const {url,address}=await validateDestination(`https://${req.url}/`,[],testOrigin);
   const upstream=net.connect({host:address,port:Number(url.port)||443});sockets.add(upstream);sockets.add(client);
   let inbound:Transform|undefined,outbound:Transform|undefined;upstream.on('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');inbound=limit(close);outbound=limit(close);if(head.length)outbound.write(head);upstream.pipe(inbound).pipe(client);client.pipe(outbound).pipe(upstream);});
   const close=()=>{upstream.destroy();client.destroy();inbound?.destroy();outbound?.destroy();sockets.delete(upstream);sockets.delete(client);};upstream.on('error',close);client.on('error',close);client.on('close',close);upstream.setTimeout(120000,close);
  }catch{client.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
 });
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const stop=()=>{for(const s of sockets)s.destroy();for(const s of streams)s.destroy();server.close();};signal.addEventListener('abort',stop,{once:true});
 return {url:`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,get violation(){return violation;},close:()=>{signal.removeEventListener('abort',stop);stop();}};
}
