import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type RequestListener} from 'node:http';
import {loadSourceFrame,FrameLoadError} from '../apps/web/src/source-frame.ts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=','base64');
async function endpoint(t:TestContext,listener:RequestListener) {
  const server=createServer(listener);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
  const address=server.address();assert.ok(address&&typeof address==='object');
  return `http://127.0.0.1:${address.port}`;
}
const controller=()=>new AbortController();

test('source frame retries real temporary HTTP failures and preserves the requested time and PNG bytes',async t=>{
  const requests:{url:string;method:string;accept:string}[]=[],options:RequestInit[]=[];
  const origin=await endpoint(t,(request,response)=>{
    requests.push({url:request.url!,method:request.method!,accept:request.headers.accept!});
    if(requests.length<3){response.writeHead(requests.length===1?429:503,{'content-type':'application/json','retry-after':'0'});response.end('{"error":"Preview is busy"}');}
    else{response.writeHead(200,{'content-type':'image/png'});response.end(png);}
  });
  const image=await loadSourceFrame('generated-source',.525,{signal:controller().signal,fetcher:async(input,init)=>{options.push(init!);return fetch(origin+input,init);}});
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  assert.deepEqual(requests,Array.from({length:3},()=>({url:'/api/v1/sources/generated-source/frame?pts=0.525',method:'GET',accept:'image/png'})));
  assert.ok(options.every(option=>option.credentials==='same-origin'&&option.signal));
});

test('repeated busy responses stop after the bounded automatic retry count',async t=>{
  let requests=0;
  const origin=await endpoint(t,(_request,response)=>{requests++;response.writeHead(429,{'content-type':'application/json'});response.end('{"error":"Busy"}');});
  await assert.rejects(loadSourceFrame('generated-source',0,{signal:controller().signal,retryDelayMs:1,fetcher:(input,init)=>fetch(origin+input,init)}),error=>error instanceof FrameLoadError&&error.status===429&&/still busy/.test(error.message));
  assert.equal(requests,4);
});

test('permission, missing-source and server failures are not automatically retried',async()=>{
  for(const status of [401,403,404,500,502]){
    let requests=0;
    await assert.rejects(loadSourceFrame('generated-source',0,{signal:controller().signal,fetcher:async()=>{requests++;return new Response('{"error":"Generated failure"}',{status});}}),error=>error instanceof FrameLoadError&&error.status===status);
    assert.equal(requests,1,`Status ${status} must leave retry to the user`);
  }
});

test('frame deadlines cover a real stalled response body and cancel the owned request',async t=>{
  let closed=false;
  const origin=await endpoint(t,(request,response)=>{
    request.once('close',()=>{closed=true;});
    response.writeHead(200,{'content-type':'image/png'});response.write(png.subarray(0,8));
  });
  await assert.rejects(loadSourceFrame('generated-source',0,{signal:controller().signal,timeoutMs:100,totalTimeoutMs:1000,fetcher:(input,init)=>fetch(origin+input,init)}),/took too long/);
  for(let retry=0;retry<10&&!closed;retry++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(closed,true,'the timed-out body must not keep its HTTP operation active');
});

test('changing selection cancels a frame body with the caller reason',async t=>{
  let received!:()=>void;const bodyStarted=new Promise<void>(resolve=>received=resolve);
  const origin=await endpoint(t,(_request,response)=>{
    response.writeHead(200,{'content-type':'image/png'});response.write(png.subarray(0,8));received();
  });
  const abort=controller(),reason=new DOMException('Selection changed','AbortError');
  const pending=loadSourceFrame('generated-source',0,{signal:abort.signal,fetcher:(input,init)=>fetch(origin+input,init)});
  await bodyStarted;abort.abort(reason);
  await assert.rejects(pending,error=>error===reason);
});

test('cancellation during retry waiting prevents another request, and an already cancelled load sends none',async()=>{
  let requests=0;
  const abort=controller(),reason=new DOMException('Frame closed','AbortError');
  await assert.rejects(loadSourceFrame('generated-source',0,{signal:abort.signal,onRetry:()=>abort.abort(reason),fetcher:async()=>{requests++;return new Response('busy',{status:429,headers:{'retry-after':'999999'}});}}),error=>error===reason);
  assert.equal(requests,1);
  await assert.rejects(loadSourceFrame('generated-source',0,{signal:abort.signal,fetcher:async()=>{requests++;return new Response(png,{headers:{'content-type':'image/png'}});}}),error=>error===reason);
  assert.equal(requests,1);
});

test('invalid image responses fail visibly without reloading the same bad output',async()=>{
  for(const response of [new Response('<html>offline</html>',{headers:{'content-type':'text/html'}}),new Response('not a PNG',{headers:{'content-type':'image/png'}}),new Response('',{headers:{'content-type':'image/png'}})]){
    let requests=0;
    await assert.rejects(loadSourceFrame('generated-source',0,{signal:controller().signal,fetcher:async()=>{requests++;return response;}}),/source frame.*(?:return|read)|return a source frame/i);
    assert.equal(requests,1);
  }
});

test('negative and nonfinite frame positions fail before sending a request',async()=>{
  for(const pts of [-1,NaN,Infinity]){
    let requests=0;
    await assert.rejects(loadSourceFrame('generated-source',pts,{signal:controller().signal,fetcher:async()=>{requests++;return new Response(png,{headers:{'content-type':'image/png'}});}}),/Choose a time/);
    assert.equal(requests,0);
  }
});
