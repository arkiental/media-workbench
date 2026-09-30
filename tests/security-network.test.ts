import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { validateDestination, createEgressProxy, isPublicAddress } from '../apps/server/src/network.ts';
import { defaultPolicy } from '../packages/core/src/policy.ts';
import { DownloadSchema } from '../packages/contracts/src/index.ts';

async function listen(handler:http.RequestListener) { const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return {server,origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,close:()=>new Promise<void>(r=>server.close(()=>r()))}; }
function get(proxy:string,target:string) { return new Promise<{status:number;body:string}>((resolve,reject)=>{const p=new URL(proxy);const request=http.get({hostname:p.hostname,port:p.port,path:target},response=>{let body='';response.on('data',b=>body+=b);response.on('end',()=>resolve({status:response.statusCode!,body}));});request.on('error',reject);}); }

test('destination policy rejects alternate IPv4 spellings, private IPv6, credentials and non-HTTP protocols', async () => {
  for(const value of ['127.0.0.1','0.0.0.0','10.1.2.3','172.16.1.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(isPublicAddress(value),false,value);
  for(const value of ['http://127.1/','http://2130706433/','http://0x7f000001/','http://0177.0.0.1/','http://[::ffff:127.0.0.1]/','http://[::1]/','file:///etc/passwd','ftp://example.com/','https://owner:secret@example.com/','https://example.com:444/'])await assert.rejects(validateDestination(value),value);
});

test('redirect follow-up to a different private origin cannot reach the destination through proxy', async () => {
  let forbiddenHits=0;
  const forbidden=await listen((_req,res)=>{forbiddenHits++;res.end('secret sentinel');});
  const allowed=await listen((_req,res)=>{res.writeHead(302,{location:forbidden.origin+'/secret'});res.end();});
  const proxy=await createEgressProxy(100000,new AbortController().signal,allowed.origin);
  try {assert.equal((await get(proxy.url,allowed.origin+'/redirect')).status,302);assert.equal((await get(proxy.url,forbidden.origin+'/secret')).status,403);assert.equal(forbiddenHits,0);}
  finally {proxy.close();await allowed.close();await forbidden.close();}
});

test('real yt-dlp nested HLS download cannot read another loopback origin through filtering proxy', {timeout:45000}, async () => {
  const { downloadMedia } = await import('../apps/server/src/download.ts');
  let forbiddenHits=0, playlistHits=0;
  const forbidden=await listen((_req,res)=>{forbiddenHits++;res.end('private sentinel');});
  const allowed=await listen((req,res)=>{
    if(req.url==='/playlist.m3u8'){playlistHits++;res.setHeader('content-type','application/vnd.apple.mpegurl');res.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\n${forbidden.origin}/private.ts\n#EXT-X-ENDLIST\n`);}
    else {res.setHeader('content-type','text/html');res.end('<html><title>Network fixture</title><video controls src="/playlist.m3u8"></video></html>');}
  });
  const root=path.resolve('test-output/review');await mkdir(root,{recursive:true});const workDir=await mkdtemp(path.join(root,'nested-hls-'));
  const suffix=process.platform==='win32'?'.exe':'';
  const tools={ffmpeg:path.resolve(`.tools/ffmpeg${suffix}`),ffprobe:path.resolve(`.tools/ffprobe${suffix}`),ytdlp:path.resolve(`.tools/yt-dlp${suffix}`),node:path.resolve(`.tools/node${suffix}`)};
  try {
    await assert.rejects(downloadMedia(DownloadSchema.parse({url:allowed.origin+'/video',preference:'original'}),tools,{workDir,signal:new AbortController().signal,maxRuntimeSeconds:30,policy:defaultPolicy('owner'),testOrigin:allowed.origin}),/403|Forbidden|fragment|not produce a single complete|downloaded file is empty/i);
    assert(playlistHits>0,'yt-dlp actually parsed the nested manifest before failing');assert.equal(forbiddenHits,0,'private server received no connection');
    assert.equal((await readdir(workDir)).filter(f=>/^download\.[a-zA-Z0-9]{1,8}$/.test(f)).length,0,'no completed artifact was produced');
  } finally {await allowed.close();await forbidden.close();}
});
