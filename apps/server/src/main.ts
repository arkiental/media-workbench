import { createServer } from './app.ts';
import path from 'node:path';
import { runProcess } from '../../../packages/media/src/process.ts';
const dataDir=path.resolve(process.env.MW_DATA_DIR||'.data');
try {
 let workerConfig;
 if(process.env.MW_ISOLATE==='1'||process.env.MW_SHARED==='1'){
  const requested=process.env.MW_WORKER_IMAGE;if(!requested||!/^[a-z0-9][a-z0-9./:_-]{1,200}$/.test(requested))throw Error('Isolated/shared mode requires an explicitly built MW_WORKER_IMAGE');
  const image=(await runProcess('docker',['image','inspect',requested,'--format','{{.Id}}'])).stdout.toString().trim();workerConfig={image,proxyPath:path.resolve('deploy/egress/proxy.mjs'),relayPath:path.resolve('deploy/egress/relay.mjs')};
 }
 const app=await createServer({dataDir,ownerToken:process.env.MW_OWNER_TOKEN,desktopSecret:process.env.MW_DESKTOP_SECRET,host:process.env.MW_HOST||'127.0.0.1',shared:process.env.MW_SHARED==='1',publicOrigin:process.env.MW_PUBLIC_ORIGIN,workerConfig});
 await app.listen({host:process.env.MW_HOST||'127.0.0.1',port:Number(process.env.MW_PORT??4319)});
 const address=app.server.address();const port=typeof address==='object'&&address?address.port:4319;
 console.log(JSON.stringify({event:'ready',port,url:`http://127.0.0.1:${port}`,credentialFile:process.env.MW_OWNER_TOKEN?undefined:path.join(dataDir,'owner-token')}));
 let closing=false;const shutdown=async()=>{if(closing)return;closing=true;await app.close();process.exit(0);};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
 if(process.env.MW_DESKTOP_SECRET){let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;if(input.includes('\n')){if(input.trim()==='shutdown')void shutdown();input='';}});}
}catch(e){console.error(e instanceof Error?e.message:'Service failed');process.exitCode=1;}
