import type { Artifact, Capabilities, DownloadRequest, ExportOptions, Job, JobRequest, Plan, Project, Recipe, Source } from '../../../packages/contracts/src/index';

export class ApiError extends Error { constructor(message:string, public status:number) { super(message); } }
export type RequestOptions=RequestInit & {timeoutMs?:number};
type UploadOptions={signal?:AbortSignal;timeoutMs?:number;validationTimeoutMs?:number};
const errorMessage=(data:unknown,fallback:string):string=>{
  if(!data||typeof data!=='object')return fallback;
  const value=data as {message?:unknown;error?:unknown};
  if(typeof value.message==='string'&&value.message)return value.message;
  if(typeof value.error==='string'&&value.error)return value.error;
  if(value.error&&typeof value.error==='object'&&'message' in value.error&&typeof value.error.message==='string')return value.error.message||fallback;
  return fallback;
};
export async function request<T>(path:string, init:RequestOptions = {}):Promise<T> {
  const {timeoutMs=120000,signal,...options}=init,controller=new AbortController();
  const cancel=()=>controller.abort(signal?.reason);
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>controller.abort(new Error('The request timed out. Check Library before trying again.')),timeoutMs);
  try{
    const headers=new Headers(options.headers);
    if(options.body&&typeof options.body==='string')headers.set('content-type','application/json');
    const response=await fetch(`/api/v1${path}`,{...options,headers,signal:controller.signal,credentials:'same-origin'});
    if(response.status===204)return undefined as T;
    let data:unknown;
    try{data=await response.json();}catch(e){
      if(controller.signal.aborted)throw controller.signal.reason;
      if(response.ok)throw new Error('The service returned an invalid response. Check Library before trying again.');
    }
    if(!response.ok)throw new ApiError(errorMessage(data,`Request failed (${response.status})`),response.status);
    return data as T;
  }catch(e){if(controller.signal.aborted)throw controller.signal.reason;throw e;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
export const api = {
  session:(token:string)=>request('/session',{method:'POST',body:JSON.stringify({token})}),
  capabilities:()=>request<Capabilities>('/capabilities'), sources:()=>request<Source[]>('/sources'), artifacts:()=>request<Artifact[]>('/artifacts'), jobs:()=>request<Job[]>('/jobs'),
  editArtifact:(artifactId:string)=>request<Source>('/sources/from-artifact',{method:'POST',body:JSON.stringify({artifactId})}),
  upload:(file:File,onProgress?:(progress:number)=>void,options:UploadOptions={})=>new Promise<Source>((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST','/api/v1/uploads');xhr.setRequestHeader('content-type','application/octet-stream');xhr.setRequestHeader('x-filename',encodeURIComponent(file.name));
    let timer:ReturnType<typeof setTimeout>,settled=false,timedOut=false;
    const cancel=()=>xhr.abort(),finish=(error?:Error,data?:Source)=>{
      if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);
      if(error)reject(error);else resolve(data!);
    };
    const resetDeadline=(milliseconds=options.timeoutMs??120000)=>{clearTimeout(timer);timer=setTimeout(()=>{timedOut=true;xhr.abort();},milliseconds);};
    xhr.upload.onprogress=event=>{resetDeadline();if(event.lengthComputable&&event.total>0)onProgress?.(event.loaded/event.total);};
    xhr.upload.onload=()=>resetDeadline(options.validationTimeoutMs??options.timeoutMs??900000);
    xhr.onerror=()=>finish(new Error('Import connection interrupted. Check free disk space and try again.'));
    xhr.onabort=()=>finish(new Error(timedOut?'Import timed out while waiting for the service. Check Library before trying again.':'Import cancelled'));
    xhr.onload=()=>{
      let data:unknown;try{data=JSON.parse(xhr.responseText);}catch{finish(new Error('The import service returned an invalid response'));return;}
      if(xhr.status>=200&&xhr.status<300)finish(undefined,data as Source);else finish(new ApiError(errorMessage(data,'Import failed'),xhr.status));
    };
    if(options.signal?.aborted){finish(new Error('Import cancelled'));return;}
    options.signal?.addEventListener('abort',cancel,{once:true});resetDeadline();xhr.send(file);
  }),
  inspect:(download:DownloadRequest)=>request<any>('/sources/inspect',{method:'POST',body:JSON.stringify(download)}),
  submit:(job:JobRequest,idempotencyKey:string=crypto.randomUUID())=>request<Job>('/jobs',{method:'POST',headers:{'idempotency-key':idempotencyKey},body:JSON.stringify(job)}),
  batch:(items:DownloadRequest[])=>request<{id:string;jobs:Job[]}>('/batches',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({items})}),
  action:(path:string,body?:unknown)=>request<any>(path,{method:'POST',body:body===undefined?undefined:JSON.stringify(body)}),
  plan:(recipe:Recipe,options:ExportOptions,presetId?:string,init:RequestOptions={})=>request<Plan>('/export/plan',{...init,method:'POST',body:JSON.stringify({recipe,options,...(presetId?{presetId}:{})})}),
  frames:(id:string,around:number)=>request<{pts:number;keyframe:boolean}[]>(`/sources/${id}/frames?around=${around}`),
  waveform:(id:string)=>request<{duration:number;peaks:number[];sampleRate:number}>(`/sources/${id}/waveform`),
  projects:()=>request<Project[]>('/projects'),
  saveProject:(project:Omit<Project,'id'|'updatedAt'>,id?:string)=>request<Project>('/projects',{method:'POST',body:JSON.stringify({...project,...(id?{id}:{})})}),
  remove:(path:string)=>request(path,{method:'DELETE'}),
  patch:(path:string,body:unknown)=>request<any>(path,{method:'PATCH',body:JSON.stringify(body)})
};
export function contentUrl(id:string) { return `/api/v1/artifacts/${id}/content`; }
export function downloadUrl(id:string) { return `${contentUrl(id)}?download=1`; }
export function saveJson(name:string,value:unknown) { saveText(name,JSON.stringify(value,null,2),'application/json'); }
export function saveText(name:string,value:string,type='text/plain') { const a=document.createElement('a'); const url=URL.createObjectURL(new Blob([value],{type})); a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000); }
