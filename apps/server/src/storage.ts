import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, rename, unlink, mkdir, copyFile, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Artifact, MediaInfo, Source } from '../../../packages/contracts/src/index.ts';
import { Store } from '../../../packages/jobs/src/store.ts';
export async function managedPath(store:Store,id:string,allowDeleting=false){
 if(!/^[0-9a-f-]{36}$/.test(id))throw Error('Invalid artifact ID');
 if(store.deletingArtifact(id)&&!allowDeleting)throw Error('Artifact deletion is in progress');
 const root=path.join(store.dataDir,'artifacts');if((await lstat(root)).isSymbolicLink())throw Error('Unsafe artifact directory');
 const file=path.join(root,id);const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Artifact is not a regular managed file');
 if(path.dirname(await realpath(file))!==await realpath(root))throw Error('Artifact escapes managed storage');return file;
}
export async function publish(store:Store,staged:string,ownerId:string,name:string,media:MediaInfo,kind:Artifact['kind'],jobId?:string,sourceId?:string,reserved?:ReturnType<Store['reserve']>):Promise<Artifact>{
 const root=path.join(store.dataDir,'artifacts');if((await lstat(root)).isSymbolicLink())throw Error('Unsafe artifact directory');
 const stat=await lstat(staged);if(!stat.isFile()||stat.isSymbolicLink()||!stat.size)throw Error('Invalid staged output');
 const reservation=reserved||store.reserve(ownerId);if(reservation.bytes<stat.size)reservation.add(stat.size-reservation.bytes);
 try{const id=randomUUID();const target=path.join(root,id);await rename(staged,target);
 const artifact:Artifact={id,ownerId,name:safeName(name),bytes:stat.size,media:{...media,size:stat.size},kind,createdAt:new Date().toISOString(),pinned:false,validated:true,...(jobId?{jobId}:{}),...(sourceId?{sourceId}:{})};
 store.put('artifact',id,ownerId,artifact);return artifact;}finally{if(!reserved)reservation.release();}
}
/** Overlay images live beside artifacts as validated PNG files named by their record id. */
export async function overlayPath(store:Store,id:string){
 if(!/^[0-9a-f-]{36}$/.test(id))throw Error('Invalid overlay image ID');
 const root=path.join(store.dataDir,'overlays');await mkdir(root,{recursive:true,mode:0o700});if((await lstat(root)).isSymbolicLink())throw Error('Unsafe overlay directory');
 return path.join(await realpath(root),id+'.png');
}
export const safeName=(name:string)=>{let value=name.replace(/[\x00-\x1f<>:"/\\|?*]/g,'_').replace(/^\.+/,'').slice(0,180).replace(/[. ]+$/,'')||'media';if(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value))value='_'+value;return value;};
/** A separate verified copy preserves the original when an external editor changes the handoff. */
const handoffs=new WeakMap<Store,Map<string,Promise<string>>>();
export function nativeCopy(store:Store,artifact:Artifact){
 const release=store.holdArtifact(artifact.id);
 let active=handoffs.get(store);if(!active){active=new Map();handoffs.set(store,active);}const previous=active.get(artifact.id)||Promise.resolve('');
 const operation=previous.catch(()=>{}).then(()=>makeNativeCopy(store,artifact));active.set(artifact.id,operation);
 return operation.finally(()=>{release();if(active!.get(artifact.id)===operation)active!.delete(artifact.id);});
}
async function makeNativeCopy(store:Store,artifact:Artifact){
 const source=await managedPath(store,artifact.id);const root=path.join(store.dataDir,'handoffs');await mkdir(root,{recursive:true,mode:0o700});if((await lstat(root)).isSymbolicLink())throw Error('Unsafe handoff directory');
 const dir=path.join(root,artifact.id);await mkdir(dir,{recursive:true,mode:0o700});if((await lstat(dir)).isSymbolicLink())throw Error('Unsafe handoff directory');
 const prior=store.get<any>('handoff',artifact.id,artifact.ownerId);if(prior){if(safeName(prior.name)!==prior.name)throw Error('Invalid handoff record');const file=path.join(root,artifact.id,prior.name);const s=await lstat(file).catch(()=>undefined);if(s?.isFile()&&!s.isSymbolicLink()&&await fileHash(file)===await fileHash(source)){store.put('handoff',artifact.id,artifact.ownerId,{...prior,expiresAt:new Date(Date.now()+3600000).toISOString()});return file;}}
 const extension=artifact.media.format.includes('matroska')?'.mkv':artifact.media.format.includes('wav')?'.wav':artifact.media.format.includes('mp3')?'.mp3':'.mp4';
 const name=safeName(artifact.name)+(path.extname(artifact.name)?'':extension);const target=path.join(dir,name);const reservation=store.reserve(artifact.ownerId);reservation.add(artifact.bytes);const temporary=path.join(dir,randomUUID()+'.tmp');
 try{await copyFile(source,temporary);if(await fileHash(source)!==await fileHash(temporary))throw Error('Native handoff copy failed verification');await rename(temporary,target);store.put('handoff',artifact.id,artifact.ownerId,{id:artifact.id,ownerId:artifact.ownerId,name,bytes:artifact.bytes,expiresAt:new Date(Date.now()+3600000).toISOString()});return target;}finally{await unlink(temporary).catch(()=>{});reservation.release();}
}
async function fileHash(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export function artifactContentType(artifact:Artifact){const video=artifact.media.streams.some(s=>s.type==='video'),format=artifact.media.format,ext=path.extname(artifact.name).toLowerCase();if(ext==='.webm')return video?'video/webm':'audio/webm';if(format.includes('matroska'))return video?'video/x-matroska':'audio/x-matroska';if(format.includes('wav'))return 'audio/wav';if(format.includes('mp3'))return 'audio/mpeg';if(format.includes('ogg'))return video?'video/ogg':'audio/ogg';if(format.includes('flac'))return 'audio/flac';if(format.includes('mov')||format.includes('mp4'))return video?'video/mp4':'audio/mp4';if(format.includes('mpegts'))return 'video/mp2t';return 'application/octet-stream';}
export function registerSource(store:Store,artifact:Artifact,url?:string):Source{const source:Source={id:randomUUID(),ownerId:artifact.ownerId,artifactId:artifact.id,name:artifact.name,createdAt:new Date().toISOString(),...(url?{url}:{})};store.put('source',source.id,source.ownerId,source);return source;}
export async function deleteArtifact(store:Store,artifact:Artifact,confirmOriginal=false){
 if(artifact.kind==='original'&&!confirmOriginal)throw Error('Confirm deletion of the managed imported original; the external source file is unaffected');
 if(artifact.pinned)throw Error('Unpin this artifact before deleting it');
 store.beginArtifactDelete(artifact.id);
 try{
 const sources=store.all<Source>('source',artifact.ownerId).filter(s=>s.artifactId===artifact.id),ids=new Set(sources.map(s=>s.id));
 if(store.all<any>('project',artifact.ownerId).some(p=>ids.has(p.recipe.sourceId)||ids.has(p.recipe.audio.sourceId)))throw Error('Artifact is protected by a saved project');
 if(store.jobs(artifact.ownerId).some(j=>!['completed','failed','cancelled','interrupted'].includes(j.state)&&(j.artifactId===artifact.id||(j.request.type==='export'&&(ids.has(j.request.recipe.sourceId)||ids.has(j.request.recipe.audio.sourceId||'')))||(j.request.type==='proxy'&&ids.has(j.request.sourceId)))))throw Error('Artifact is protected by active or queued work');
 const file=await managedPath(store,artifact.id,true);
 // Clipboard paths and external apps use the separate handoff copy. Keep it
 // until its own expiry; retention cleans it even after the library row is gone.
 await unlink(file);store.delete('artifact',artifact.id,artifact.ownerId);for(const s of sources)store.delete('source',s.id,s.ownerId);return {deleted:artifact.id,historyRetained:true};}finally{store.endArtifactDelete(artifact.id);}
}
export async function retention(store:Store,ownerId:string){
 const protectedIds=new Set<string>();
 for(const p of store.all<any>('project',ownerId))for(const id of [p.recipe.sourceId,p.recipe.audio.sourceId]){if(!id)continue;const s=store.get<Source>('source',id,ownerId);if(s)protectedIds.add(s.artifactId);}
 for(const j of store.jobs(ownerId).filter(j=>!['completed','failed','cancelled','interrupted'].includes(j.state))){const r=j.request;for(const id of r.type==='export'?[r.recipe.sourceId,r.recipe.audio.sourceId]:r.type==='proxy'?[r.sourceId]:[]){if(!id)continue;const s=store.get<Source>('source',id,ownerId);if(s)protectedIds.add(s.artifactId);}}
 const removed:string[]=[];
 for(const a of store.all<Artifact>('artifact',ownerId)){
  if(a.kind==='original'||a.pinned||protectedIds.has(a.id)||store.leased(a.id)||!a.expiresAt||a.expiresAt>new Date().toISOString())continue;
  try{await deleteArtifact(store,a);removed.push(a.id);}catch(error){if(!/protected by|Unpin/.test(String(error)))throw error;}
 }
 for(const item of store.all<any>('handoff',ownerId)){if(item.expiresAt>new Date().toISOString()||store.leased(item.id))continue;const root=path.join(store.dataDir,'handoffs'),dir=path.join(root,item.id);if(!/^[0-9a-f-]{36}$/.test(item.id)||safeName(item.name)!==item.name)throw Error('Invalid handoff record');if((await lstat(root)).isSymbolicLink()||(await lstat(dir)).isSymbolicLink())throw Error('Unsafe handoff cleanup');const file=path.join(dir,item.name);const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw Error('Unsafe handoff cleanup');await unlink(file);store.delete('handoff',item.id,ownerId);}
 return removed;
}
