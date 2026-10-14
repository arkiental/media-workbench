import { ByteRateBudget, createRateLimitedStream } from './rate.ts';
export class BandwidthLimiter {
 private budgets=new Map<string,{rate:number;budget:ByteRateBudget}>();
 stream(owner:string,bytesPerSecond:number,maxBytes:number){let bytes=0;let entry=this.budgets.get(owner);if(!entry||entry.rate!==bytesPerSecond){entry={rate:bytesPerSecond,budget:new ByteRateBudget(bytesPerSecond)};this.budgets.set(owner,entry);}
  return createRateLimitedStream(entry.budget,size=>{bytes+=size;if(bytes>maxBytes)return Error('Transfer exceeds byte policy');});
 }
}
