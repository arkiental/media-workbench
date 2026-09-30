// Deterministic integration-test fixture. Never used by production worker execution.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createUnixProxy } from './proxy.mjs';
const bytes=await readFile('/fixture/numbered-cfr.mp4');
const fixture=createServer((req,res)=>{
  if(req.url==='/movie.mp4'){res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});res.end(bytes);}
  else if(req.url==='/redirect-private'){res.writeHead(302,{location:'http://169.254.169.254/latest/meta-data/'});res.end();}
  else if(req.url==='/nested.m3u8'){res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'});res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nhttp://169.254.169.254/private-segment.ts\n#EXT-X-ENDLIST\n');}
  else{res.writeHead(404);res.end('Not found');}
});
await new Promise(resolve=>fixture.listen(18081,'127.0.0.1',resolve));
const proxy=await createUnixProxy({socketPath:'/proxy/egress.sock',maxBytes:5_000_000,testOrigin:'http://127.0.0.1:18081',onRejected:()=>process.stdout.write(JSON.stringify({event:'egress-denied'})+'\n')});
process.stdout.write(JSON.stringify({event:'egress-ready',fixtureOrigin:'http://127.0.0.1:18081'})+'\n');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await proxy.close();fixture.close();process.exit(0);});
