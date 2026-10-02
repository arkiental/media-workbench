import { Transform } from 'node:stream';
import { ByteRateBudget } from './rate.ts';
export class BandwidthLimiter {
 private budgets=new Map<string,{rate:number;budget:ByteRateBudget}>();
 stream(owner:string,bytesPerSecond:number,maxBytes:number){let bytes=0;let timer:NodeJS.Timeout|undefined;let entry=this.budgets.get(owner);if(!entry||entry.rate!==bytesPerSecond){entry={rate:bytesPerSecond,budget:new ByteRateBudget(bytesPerSecond)};this.budgets.set(owner,entry);}const budget=entry.budget;
  return new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>maxBytes){callback(Error('Transfer exceeds byte policy'));return;}const delay=budget.delay(chunk.length);if(delay<1)callback(null,chunk);else timer=setTimeout(()=>callback(null,chunk),delay);},destroy(error,callback){if(timer)clearTimeout(timer);callback(error);}});
 }
}
