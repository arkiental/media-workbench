import net from 'node:net';
import { spawn } from 'node:child_process';

const separator=process.argv.indexOf('--');
const socketIndex=process.argv.indexOf('--socket');
const socketPath=socketIndex>=0?process.argv[socketIndex+1]:'/proxy/egress.sock';
if(separator<0||!socketPath?.startsWith('/proxy/')||!process.argv[separator+1]?.startsWith('/'))throw new Error('Usage: relay.mjs --socket /proxy/egress.sock -- /absolute/executable [arguments]');
const executable=process.argv[separator+1];const args=process.argv.slice(separator+2);const sockets=new Set();
const server=net.createServer(client=>{const upstream=net.connect(socketPath);sockets.add(client);sockets.add(upstream);const close=()=>{client.destroy();upstream.destroy();sockets.delete(client);sockets.delete(upstream);};client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);client.pipe(upstream);upstream.pipe(client);});
server.maxConnections=32;await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const proxyUrl=`http://127.0.0.1:${server.address().port}`;
let replaced=false;for(let i=0;i<args.length;i++){if(args[i]==='--proxy'){if(i===args.length-1)throw new Error('Missing proxy argument value.');args[i+1]=proxyUrl;replaced=true;i++;}else if(args[i].startsWith('--proxy=')){args[i]=`--proxy=${proxyUrl}`;replaced=true;}}
if(!replaced){const urlSeparator=args.indexOf('--');args.splice(urlSeparator<0?0:urlSeparator,0,'--proxy',proxyUrl);}
const child=spawn(executable,args,{shell:false,stdio:'inherit',env:{...process.env,HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,ALL_PROXY:proxyUrl,http_proxy:proxyUrl,https_proxy:proxyUrl,all_proxy:proxyUrl,NO_PROXY:'',no_proxy:''}});
const stop=()=>{for(const socket of sockets)socket.destroy();server.close();};
child.on('error',error=>{stop();process.stderr.write(`Worker executable failed: ${error.message}\n`);process.exitCode=1;});
child.on('exit',(code,signal)=>{stop();process.exitCode=code??(signal?1:0);});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{child.kill(signal);stop();});
