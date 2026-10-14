import { Transform } from 'node:stream';

export class ByteRateBudget {
  private next=0;
  readonly chunkBytes:number;
  constructor(private bytesPerSecond:number) {
    if(!Number.isFinite(bytesPerSecond)||bytesPerSecond<=0)throw Error('Invalid transfer rate');
    this.chunkBytes=Math.max(1,Math.floor(bytesPerSecond/10));
  }
  delay(bytes:number) {
    const now=performance.now();
    this.next=Math.max(now-20,this.next)+bytes/this.bytesPerSecond*1000;
    return Math.max(0,this.next-now);
  }
}

export function createRateLimitedStream(budget:ByteRateBudget,checkBytes:(bytes:number)=>Error|undefined) {
  let timer:NodeJS.Timeout|undefined;
  return new Transform({
    transform(chunk,_encoding,callback) {
      const error=checkBytes(chunk.length);
      if(error){callback(error);return;}
      let offset=0;
      const deliver=()=>{
        while(offset<chunk.length){
          // Keep socket activity visible while a large chunk is being throttled.
          const piece=chunk.subarray(offset,offset+budget.chunkBytes);
          offset+=piece.length;
          const delay=budget.delay(piece.length);
          if(delay>=1){
            timer=setTimeout(()=>{timer=undefined;if(!this.destroyed){this.push(piece);deliver();}},delay);
            return;
          }
          this.push(piece);
        }
        callback();
      };
      deliver();
    },
    destroy(error,callback){clearTimeout(timer);callback(error);}
  });
}
