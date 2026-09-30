import { Transform } from 'node:stream';
export class BandwidthLimiter {
 private next=new Map<string,number>();
 stream(owner:string,bytesPerSecond:number,maxBytes:number){let bytes=0;let timer:NodeJS.Timeout|undefined;const schedule=this.next;
  return new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>maxBytes){callback(Error('Transfer exceeds byte policy'));return;}const now=Date.now(),finish=Math.max(now,schedule.get(owner)||now)+chunk.length/bytesPerSecond*1000;schedule.set(owner,finish);timer=setTimeout(()=>callback(null,chunk),Math.max(0,finish-now));},destroy(error,callback){if(timer)clearTimeout(timer);callback(error);}});
 }
}
