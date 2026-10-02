export class ByteRateBudget {
  private next=0;
  constructor(private bytesPerSecond:number) {}
  delay(bytes:number) {
    const now=performance.now();
    this.next=Math.max(now-20,this.next)+bytes/this.bytesPerSecond*1000;
    return Math.max(0,this.next-now);
  }
}
