import { mkdir, writeFile, readFile, copyFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const dir=path.resolve('.tools'); await mkdir(dir,{recursive:true});
const headers={'User-Agent':'MediaWorkbench-build'};
const manifestPath=path.join(dir,'manifest.json');
let previous;try{previous=JSON.parse(await readFile(manifestPath,'utf8'));}catch{}
const lock=JSON.parse(await readFile('toolchain.lock.json','utf8'));
const tag=process.env.MW_YTDLP_TAG||previous?.ytDlpTag||lock.ytDlpTag;
const base=`https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(tag)}`;
const name=process.platform==='win32'?'yt-dlp.exe':'yt-dlp_linux';
const sums=await fetch(`${base}/SHA2-256SUMS`,{headers}).then(r=>{if(!r.ok)throw Error('Cannot obtain release checksums');return r.text()});
const expected=sums.split('\n').find(l=>l.trim().endsWith(` ${name}`))?.split(/\s+/)[0];
if(!expected||!/^[a-f0-9]{64}$/.test(expected))throw Error('Missing trusted release checksum');
const bytes=Buffer.from(await fetch(`${base}/${name}`,{headers}).then(r=>{if(!r.ok)throw Error('Cannot download official tool');return r.arrayBuffer()}));
const hash=createHash('sha256').update(bytes).digest('hex'); if(hash!==expected)throw Error('Tool integrity mismatch');
const target=path.join(dir,process.platform==='win32'?'yt-dlp.exe':'yt-dlp');
if(previous)await writeFile(manifestPath+'.previous',JSON.stringify(previous,null,2));
await unlink(target+'.previous').catch(e=>{if(e.code!=='ENOENT')throw e;});
try {await rename(target,target+'.previous');} catch(e) {if(e.code!=='ENOENT')throw e;}
await writeFile(target,bytes,{mode:0o700});
const manifest={schemaVersion:1,ytDlpTag:tag,createdAt:new Date().toISOString(),tools:[]};
manifest.tools.push({name:'yt-dlp',path:path.basename(target),sha256:hash,source:`${base}/${name}`,license:'Unlicense; executable dependencies retain their licenses'});
for(const name of ['ffmpeg','ffprobe','node']){
 const envName=`MW_${name.toUpperCase()}`;
 const binary=process.env[envName]||(name==='node'?process.execPath:execFileSync(process.platform==='win32'?'where.exe':'which',[name],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0]);
 const destination=path.join(dir,name+(process.platform==='win32'?'.exe':''));
 if(path.resolve(binary)!==destination)await copyFile(binary,destination);
 const data=await readFile(destination); const version=execFileSync(destination,[name==='node'?'--version':'-version'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/)[0];
 manifest.tools.push({name,path:path.basename(destination),sha256:createHash('sha256').update(data).digest('hex'),version,source:'Explicit local developer installation; redistribution not approved'});
}
await writeFile(manifestPath,JSON.stringify(manifest,null,2));
console.log(`Verified yt-dlp ${tag}; staged explicit local FFmpeg/ffprobe/Node with hashes in .tools/manifest.json. Not a redistributable tool bundle.`);
