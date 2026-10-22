import { api, ApiError } from './api';

// These admission errors are returned before upload processing or publication starts.
export async function importFile(file:File,signal:AbortSignal,onProgress:(progress:number)=>void,onWaiting:()=>void,onAttempt:()=>void) {
  let deadline:number|undefined;
  for(let attempt=0;;attempt++) {
    signal.throwIfAborted();onAttempt();
    try{return await api.upload(file,onProgress,{signal});}
    catch(error){
      signal.throwIfAborted();
      if(!(error instanceof ApiError)||error.status!==429||!/^Two preview\/inspection operations already active$|^Host preview\/upload capacity reached$/i.test(error.message))throw error;
      deadline??=Date.now()+15000;
      if(attempt>=7||Date.now()>=deadline)throw new Error('Preview work is still busy. Wait a moment, then use Retry failed files.');
      onWaiting();
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},Math.min(400*(attempt+1),2000,deadline!-Date.now()));
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      });
      if(Date.now()>=deadline)throw new Error('Preview work is still busy. Wait a moment, then use Retry failed files.');
    }
  }
}
