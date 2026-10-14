import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, request } from '../apps/web/src/api.ts';

test('a stalled request has a bounded wait and preserves explicit cancellation',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>{
    init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true});
  });
  const fallback=new AbortController(),timer=setTimeout(()=>fallback.abort(new Error('Fallback deadline reached')),150);
  try{
    await assert.rejects(request('/jobs',{signal:fallback.signal,timeoutMs:15} as any),/timed out/i);
    const cancelled=new AbortController(),pending=request('/jobs',{signal:cancelled.signal,timeoutMs:500} as any);
    cancelled.abort(new DOMException('Cancelled by caller','AbortError'));
    await assert.rejects(pending,{name:'AbortError',message:'Cancelled by caller'});
  }finally{clearTimeout(timer);globalThis.fetch=original;}
});

test('the deadline includes a stalled response body and errors remain readable',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async(_url,init)=>({ok:true,status:200,json:()=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}))}) as Response;
    const fallback=new AbortController(),timer=setTimeout(()=>fallback.abort(new Error('Fallback deadline reached')),150);
    try{await assert.rejects(request('/jobs',{signal:fallback.signal,timeoutMs:15} as any),/timed out/i);}finally{clearTimeout(timer);}
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'The selected format is unavailable'}}),{status:400});
    await assert.rejects(request('/jobs'),(e:any)=>e instanceof ApiError&&e.status===400&&e.message==='The selected format is unavailable');
    globalThis.fetch=async()=>new Response('<html>offline</html>',{status:502});
    await assert.rejects(request('/jobs'),/Request failed \(502\)/);
    globalThis.fetch=async()=>new Response('not json');
    await assert.rejects(request('/jobs'),/invalid response/i);
  }finally{globalThis.fetch=original;}
});

test('explicit submission retry keys are retained without automatic retries',async()=>{
  const original=globalThis.fetch,calls:RequestInit[]=[];
  globalThis.fetch=async(_url,init)=>{calls.push(init!);throw new TypeError('Connection lost');};
  try{
    await assert.rejects(api.submit({type:'proxy',sourceId:crypto.randomUUID()},'preview-retry-key'),/Connection lost/);
    await assert.rejects(api.submit({type:'proxy',sourceId:crypto.randomUUID()},'preview-retry-key'),/Connection lost/);
    assert.equal(calls.length,2);
    assert.equal(new Headers(calls[0].headers).get('idempotency-key'),'preview-retry-key');
    assert.equal(new Headers(calls[1].headers).get('idempotency-key'),'preview-retry-key');
    assert.equal(calls[0].credentials,'same-origin');
  }finally{globalThis.fetch=original;}
});

class FakeXHR {
  static current:FakeXHR;
  upload:{onprogress:((event:any)=>void)|null;onload:(()=>void)|null}={onprogress:null,onload:null};
  onerror:(()=>void)|null=null;onabort:(()=>void)|null=null;onload:(()=>void)|null=null;
  status=200;responseText='{}';aborted=false;sent=false;
  constructor(){FakeXHR.current=this;}
  open(){}setRequestHeader(){}
  send(){this.sent=true;}abort(){this.aborted=true;this.onabort?.();}
}

test('imports time out only after inactivity and can be cancelled',async()=>{
  const original=globalThis.XMLHttpRequest;globalThis.XMLHttpRequest=FakeXHR as any;
  try{
    const progress:number[]=[],pending=api.upload(new File(['fixture'],'media.mp4'),p=>progress.push(p),{timeoutMs:45});
    const xhr=FakeXHR.current;
    for(let n=1;n<=3;n++){await new Promise(r=>setTimeout(r,20));assert.equal(xhr.aborted,false);xhr.upload.onprogress?.({lengthComputable:true,loaded:n,total:4});}
    xhr.responseText=JSON.stringify({id:'imported'});xhr.onload?.();assert.equal((await pending).id,'imported');assert.deepEqual(progress,[.25,.5,.75]);
    await assert.rejects(api.upload(new File(['fixture'],'media.mp4'),undefined,{timeoutMs:15}),/timed out/i);assert.equal(FakeXHR.current.aborted,true);
    const controller=new AbortController(),cancel=api.upload(new File(['fixture'],'media.mp4'),undefined,{signal:controller.signal,timeoutMs:500});controller.abort();await assert.rejects(cancel,/cancelled/i);assert.equal(FakeXHR.current.aborted,true);
    const already=new AbortController();already.abort();await assert.rejects(api.upload(new File(['fixture'],'media.mp4'),undefined,{signal:already.signal}),/cancelled/i);assert.equal(FakeXHR.current.sent,false);
  }finally{globalThis.XMLHttpRequest=original;}
});

test('completed uploads allow a separate bounded validation wait and report structured errors',async()=>{
  const original=globalThis.XMLHttpRequest;globalThis.XMLHttpRequest=FakeXHR as any;
  try{
    const pending=api.upload(new File(['fixture'],'media.mp4'),undefined,{timeoutMs:15,validationTimeoutMs:80}),xhr=FakeXHR.current;
    xhr.upload.onload?.();await new Promise(r=>setTimeout(r,35));assert.equal(xhr.aborted,false);xhr.responseText=JSON.stringify({id:'checked'});xhr.onload?.();assert.equal((await pending).id,'checked');
    const failure=api.upload(new File(['fixture'],'media.mp4'));FakeXHR.current.status=403;FakeXHR.current.responseText=JSON.stringify({error:{message:'Import permission required'}});FakeXHR.current.onload?.();await assert.rejects(failure,(e:any)=>e instanceof ApiError&&e.message==='Import permission required'&&e.status===403);
    const invalid=api.upload(new File(['fixture'],'media.mp4'));FakeXHR.current.responseText='<html>invalid</html>';FakeXHR.current.onload?.();await assert.rejects(invalid,/invalid response/);
  }finally{globalThis.XMLHttpRequest=original;}
});
