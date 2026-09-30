import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, unlink, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../../../packages/media/src/process.ts';
import { Store } from '../../../packages/jobs/src/store.ts';
type Credential={id:string;ownerId:string;name:string;kind:'file'|'browser';browser?:string;profile?:string;protectedBy:string};
async function restricted(file:string){
 if(process.platform==='win32')await runProcess('icacls.exe',[file,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`]);
 else await chmod(file,(await stat(file)).isDirectory()?0o700:0o600);
}
async function protect(data:Buffer,encrypt:boolean,store:Store){
 if(process.platform==='win32'){
  const script=`Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${encrypt?'Protect':'Unprotect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r))`;
  return Buffer.from((await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],undefined,{stdin:data.toString('base64')})).stdout.toString().trim(),'base64');
 }
 const keyFile=path.join(store.dataDir,'credentials','local.key');let key:Buffer;
 try{key=await readFile(keyFile);}catch{key=randomBytes(32);await writeFile(keyFile,key,{mode:0o600,flag:'wx'});}
 if(encrypt){const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(data),c.final(),c.getAuthTag()]);}
 const d=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));d.setAuthTag(data.subarray(-16));return Buffer.concat([d.update(data.subarray(12,-16)),d.final()]);
}
export async function importCookies(store:Store,owner:string,name:string,content:string){
 if(content.length>2*1024*1024||!/^# (Netscape HTTP Cookie File|HTTP Cookie File)/.test(content))throw Error('Import a Netscape cookies file (maximum 2 MiB)');
 const id=randomUUID();const file=path.join(store.dataDir,'credentials',id);await writeFile(file,await protect(Buffer.from(content),true,store),{mode:0o600,flag:'wx'});await restricted(file);
 const item:Credential={id,ownerId:owner,name,kind:'file',protectedBy:process.platform==='win32'?'Windows DPAPI':'AES-GCM with permission-restricted local key'};return store.put('credential',id,owner,item);
}
export function registerBrowser(store:Store,owner:string,browser:string,profile?:string){
 if(!['chrome','chromium','edge','firefox','brave','opera','vivaldi'].includes(browser))throw Error('Unsupported browser');
 if(profile&&!/^[\p{L}\p{N} _.-]{1,80}$/u.test(profile))throw Error('Use a profile name, not a path');
 const id=randomUUID();return store.put<Credential>('credential',id,owner,{id,ownerId:owner,name:browser+(profile?' / '+profile:''),kind:'browser',browser,profile,protectedBy:'Browser OS storage; extraction on explicit job only'});
}
export async function withCookies<T>(store:Store,owner:string,id:string|undefined,workDir:string,fn:(opts:{cookieFile?:string;browserCookie?:{browser:string;profile?:string}})=>Promise<T>):Promise<T>{
 if(!id)return fn({});const c=store.get<Credential>('credential',id,owner);if(!c)throw Error('Cookie profile not found');
 if(c.kind==='browser')return fn({browserCookie:{browser:c.browser!,profile:c.profile}});
 const file=path.join(workDir,'session-cookies.txt');await restricted(workDir);
 try{await writeFile(file,await protect(await readFile(path.join(store.dataDir,'credentials',c.id)),false,store),{mode:0o600,flag:'wx'});await restricted(file);return await fn({cookieFile:file});}finally{await unlink(file).catch(()=>{});}
}
export async function forgetCookies(store:Store,owner:string,id:string){const c=store.get<Credential>('credential',id,owner);if(!c)throw Error('Cookie profile not found');if(c.kind==='file')await unlink(path.join(store.dataDir,'credentials',id));store.delete('credential',id,owner);}
