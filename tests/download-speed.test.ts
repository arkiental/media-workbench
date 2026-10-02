import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BandwidthLimiter } from '../apps/server/src/bandwidth.ts';

const sink=()=>new Writable({write(_chunk,_encoding,callback){callback();}});
const chunks=(count:number,size:number)=>Readable.from(Array.from({length:count},()=>Buffer.alloc(size)));

test('limiter removes per-chunk timer overhead without raising the bandwidth cap',async()=>{
  const rate=50*1024**2,count=4096,size=1024;
  let next=Date.now();
  const legacy=new Transform({transform(chunk,_encoding,callback){const now=Date.now();next=Math.max(now,next)+chunk.length/rate*1000;setTimeout(()=>callback(null,chunk),Math.max(0,next-now));}});
  let started=performance.now();await pipeline(chunks(count,size),legacy,sink());const before=performance.now()-started;
  started=performance.now();await pipeline(chunks(count,size),new BandwidthLimiter().stream('benchmark',rate,count*size),sink());const after=performance.now()-started;
  console.log(JSON.stringify({benchmark:'4 MiB, 1 KiB chunks, same 50 MiB/s cap',beforeMs:Math.round(before),afterMs:Math.round(after),speedup:Number((before/after).toFixed(1))}));
  assert(after>=count*size/rate*1000-25,'rate budget allows at most a 20ms burst');
  assert(after<before,'optimized transfer eliminates serial timer overhead');
});

test('parallel streams share one owner bandwidth budget',async()=>{
  const limiter=new BandwidthLimiter(),started=performance.now();
  await Promise.all([pipeline(chunks(32,4096),limiter.stream('shared',1024**2,128*1024),sink()),pipeline(chunks(32,4096),limiter.stream('shared',1024**2,128*1024),sink())]);
  assert(performance.now()-started>=225,'aggregate transfer remains capped across concurrent streams');
});

test('byte caps and cancellation still reject incomplete transfers',async()=>{
  await assert.rejects(pipeline(chunks(2,1024),new BandwidthLimiter().stream('bytes',1024**2,1024),sink()),/byte policy/);
  const controller=new AbortController();
  const transfer=pipeline(chunks(2,1024),new BandwidthLimiter().stream('cancel',1024,4096),sink(),{signal:controller.signal});
  setTimeout(()=>controller.abort(),25);
  await assert.rejects(transfer,{name:'AbortError'});
});
