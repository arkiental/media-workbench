type FrameLoadOptions={signal:AbortSignal;fetcher?:typeof fetch;timeoutMs?:number;totalTimeoutMs?:number;maxRetries?:number;retryDelayMs?:number;onRetry?:()=>void};

export class FrameLoadError extends Error {
  constructor(message:string,public status?:number){super(message);}
}

const cancelled=(signal:AbortSignal)=>signal.reason||new DOMException('Frame loading cancelled','AbortError');
function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  if(signal.aborted){void work.catch(()=>{});return Promise.reject(cancelled(signal));}
  return new Promise((resolve,reject)=>{
    const cancel=()=>{signal.removeEventListener('abort',cancel);reject(cancelled(signal));};
    signal.addEventListener('abort',cancel,{once:true});
    work.then(value=>{signal.removeEventListener('abort',cancel);resolve(value);},error=>{signal.removeEventListener('abort',cancel);reject(error);});
  });
}
function wait(milliseconds:number,signal:AbortSignal):Promise<void> {
  if(signal.aborted)return Promise.reject(cancelled(signal));
  return new Promise((resolve,reject)=>{
    const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(cancelled(signal));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},milliseconds);
    signal.addEventListener('abort',cancel,{once:true});
  });
}
function retryDelay(response:Response,retry:number,base:number) {
  const header=response.headers.get('retry-after');
  if(header){
    const seconds=Number(header),requested=Number.isFinite(seconds)?seconds*1000:Date.parse(header)-Date.now();
    if(Number.isFinite(requested)&&requested>=0)return Math.min(5000,Math.max(250,requested));
  }
  return Math.min(5000,base*2**retry);
}

export async function loadSourceFrame(sourceId:string,pts:number,{signal,fetcher=fetch,timeoutMs=15000,totalTimeoutMs=45000,maxRetries=3,retryDelayMs=1000,onRetry}:FrameLoadOptions):Promise<Blob> {
  if(!Number.isFinite(pts)||pts<0)throw new FrameLoadError('Choose a time inside the source before inspecting a frame.');
  const url=`/api/v1/sources/${encodeURIComponent(sourceId)}/frame?pts=${encodeURIComponent(String(pts))}`,deadline=Date.now()+totalTimeoutMs;
  for(let retry=0;retry<=maxRetries;retry++){
    if(signal.aborted)throw cancelled(signal);
    const remaining=deadline-Date.now();
    if(remaining<=0)throw new FrameLoadError('Frame loading took too long. Try again.');
    const controller=new AbortController(),cancel=()=>controller.abort(cancelled(signal));
    signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>controller.abort(new FrameLoadError('Frame loading took too long. Try again.')),Math.min(timeoutMs,remaining));
    let delay:number|undefined;
    try{
      const response=await abortable(fetcher(url,{method:'GET',credentials:'same-origin',headers:{accept:'image/png'},signal:controller.signal}),controller.signal);
      if(response.status===429||response.status===503){
        await abortable(response.body?.cancel()||Promise.resolve(),controller.signal);
        if(retry===maxRetries)throw new FrameLoadError('The preview is still busy. Try again.',response.status);
        delay=retryDelay(response,retry,retryDelayMs);
      }else{
        if(!response.ok){
          await abortable(response.body?.cancel()||Promise.resolve(),controller.signal);
          throw new FrameLoadError(response.status===401?'Sign in again to load this frame.':response.status===403?'You cannot preview this source.':response.status===404?'This source frame is no longer available.':'Could not load this source frame. Try again.',response.status);
        }
        if(!/^image\/png(?:;|$)/i.test(response.headers.get('content-type')||'')){
          await abortable(response.body?.cancel()||Promise.resolve(),controller.signal);
          throw new FrameLoadError('The service did not return a source frame. Try again.');
        }
        const image=await abortable(response.blob(),controller.signal);
        const signature=new Uint8Array(await abortable(image.slice(0,8).arrayBuffer(),controller.signal));
        if(signature.length!==8||signature.some((byte,index)=>byte!==[137,80,78,71,13,10,26,10][index]))throw new FrameLoadError('The source frame could not be read. Try again.');
        return image;
      }
    }catch(error){
      if(controller.signal.aborted)throw cancelled(controller.signal);
      if(error instanceof FrameLoadError)throw error;
      throw new FrameLoadError('Could not load this source frame. Check the connection and try again.');
    }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
    if(delay!==undefined){
      onRetry?.();
      await wait(Math.min(delay,Math.max(0,deadline-Date.now())),signal);
    }
  }
  throw new FrameLoadError('The preview is still busy. Try again.');
}
