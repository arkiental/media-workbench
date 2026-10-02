import type { Artifact, Capabilities, DownloadRequest, ExportOptions, Job, JobRequest, Plan, Project, Recipe, Source } from '../../../packages/contracts/src/index';

export class ApiError extends Error { constructor(message:string, public status:number) { super(message); } }
export async function request<T>(path:string, init:RequestInit = {}):Promise<T> {
  const headers = new Headers(init.headers);
  if(init.body && typeof init.body === 'string') headers.set('content-type','application/json');
  const response = await fetch(`/api/v1${path}`, {...init,headers,credentials:'same-origin'});
  if(!response.ok) { const error = await response.json().catch(()=>({message:response.statusText})); throw new ApiError(error.message || error.error?.message || error.error || `Request failed (${response.status})`,response.status); }
  if(response.status===204) return undefined as T;
  return response.json();
}
export const api = {
  session:(token:string)=>request('/session',{method:'POST',body:JSON.stringify({token})}),
  capabilities:()=>request<Capabilities>('/capabilities'), sources:()=>request<Source[]>('/sources'), artifacts:()=>request<Artifact[]>('/artifacts'), jobs:()=>request<Job[]>('/jobs'),
  editArtifact:(artifactId:string)=>request<Source>('/sources/from-artifact',{method:'POST',body:JSON.stringify({artifactId})}),
  upload:(file:File)=>request<Source>('/uploads',{method:'POST',headers:{'content-type':'application/octet-stream','x-filename':encodeURIComponent(file.name)},body:file}),
  inspect:(download:DownloadRequest)=>request<any>('/sources/inspect',{method:'POST',body:JSON.stringify(download)}),
  submit:(job:JobRequest)=>request<Job>('/jobs',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify(job)}),
  batch:(items:DownloadRequest[])=>request<{id:string;jobs:Job[]}>('/batches',{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({items})}),
  action:(path:string,body?:unknown)=>request<any>(path,{method:'POST',body:body===undefined?undefined:JSON.stringify(body)}),
  plan:(recipe:Recipe,options:ExportOptions,presetId?:string)=>request<Plan>('/export/plan',{method:'POST',body:JSON.stringify({recipe,options,...(presetId?{presetId}:{})})}),
  frames:(id:string,around:number)=>request<{pts:number;keyframe:boolean}[]>(`/sources/${id}/frames?around=${around}`),
  waveform:(id:string)=>request<{duration:number;peaks:number[];sampleRate:number}>(`/sources/${id}/waveform`),
  projects:()=>request<Project[]>('/projects'),
  saveProject:(project:Omit<Project,'id'|'updatedAt'>,id?:string)=>request<Project>(`/projects${id?`/${id}`:''}`,{method:id?'PUT':'POST',body:JSON.stringify(project)}),
  remove:(path:string)=>request(path,{method:'DELETE'}),
  patch:(path:string,body:unknown)=>request<any>(path,{method:'PATCH',body:JSON.stringify(body)})
};
export function contentUrl(id:string) { return `/api/v1/artifacts/${id}/content`; }
export function saveJson(name:string,value:unknown) { saveText(name,JSON.stringify(value,null,2),'application/json'); }
export function saveText(name:string,value:string,type='text/plain') { const a=document.createElement('a'); const url=URL.createObjectURL(new Blob([value],{type})); a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000); }
