type Attempt={count:number;until:number};
export class PairingLimiter {
 private attempts=new Map<string,Attempt>();private nextCleanup=0;
 constructor(private readonly maxClients=4096,private readonly windowMs=60000,private readonly maxAttempts=20){}
 check(key:string,now=Date.now()){
  if(now>=this.nextCleanup){for(const [client,attempt]of this.attempts)if(attempt.until<=now)this.attempts.delete(client);this.nextCleanup=now+Math.min(10000,this.windowMs);}
  let attempt=this.attempts.get(key);
  if(!attempt||attempt.until<=now){
   if(!attempt&&this.attempts.size>=this.maxClients)throw Object.assign(Error('Pairing capacity reached. Try again shortly.'),{statusCode:429});
   this.attempts.set(key,attempt={count:0,until:now+this.windowMs});
  }
  if(++attempt.count>this.maxAttempts)throw Object.assign(Error('Too many pairing attempts'),{statusCode:429});
 }
}
