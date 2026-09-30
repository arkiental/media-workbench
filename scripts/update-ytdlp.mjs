import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root=path.resolve('.tools'),file=path.join(root,process.platform==='win32'?'yt-dlp.exe':'yt-dlp'),manifestFile=path.join(root,'manifest.json');
const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
if(process.argv.includes('--rollback')){
 const previous=JSON.parse(await readFile(manifestFile+'.previous','utf8'));const bytes=await readFile(file+'.previous');const expected=previous.tools.find(t=>t.name==='yt-dlp').sha256;
 if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Rollback integrity mismatch');
 await unlink(file+'.replaced').catch(e=>{if(e.code!=='ENOENT')throw e;});await rename(file,file+'.replaced');await rename(file+'.previous',file);await writeFile(manifestFile,JSON.stringify(previous,null,2));console.log('Restored previous verified yt-dlp');
} else {
 const tag=process.argv[2];if(!/^20\d{2}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(tag||''))throw Error('Specify an explicit official release tag: npm run tools:update -- YYYY.MM.DD');
 const name=process.platform==='win32'?'yt-dlp.exe':'yt-dlp_linux',base=`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}`;
 const fetchOk=async url=>{const r=await fetch(url);if(!r.ok)throw Error(`Official release fetch failed (${r.status})`);return r;};
 const sums=await (await fetchOk(`${base}/SHA2-256SUMS`)).text();const expected=sums.split('\n').find(l=>l.trim().endsWith(` ${name}`))?.split(/\s+/)[0];if(!expected)throw Error('Missing official checksum');
 const bytes=Buffer.from(await (await fetchOk(`${base}/${name}`)).arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Update integrity mismatch');
 const staged=file+'.staged'+(process.platform==='win32'?'.exe':'');await writeFile(staged,bytes,{mode:0o700});
 const version=execFileSync(staged,['--ignore-config','--no-plugin-dirs','--version'],{encoding:'utf8',windowsHide:true}).trim();if(version!==tag)throw Error('Version check failed');
 // A live subprocess and option parsing check is required before atomically replacing the executable.
 execFileSync(staged,['--ignore-config','--no-plugin-dirs','--no-remote-components','--list-extractors'],{windowsHide:true,maxBuffer:2*1024*1024});
 await writeFile(manifestFile+'.previous',JSON.stringify(manifest,null,2));await unlink(file+'.previous').catch(e=>{if(e.code!=='ENOENT')throw e;});await rename(file,file+'.previous');await rename(staged,file);
 manifest.ytDlpTag=tag;Object.assign(manifest.tools.find(t=>t.name==='yt-dlp'),{sha256:expected,source:`${base}/${name}`});await writeFile(manifestFile,JSON.stringify(manifest,null,2));
 console.log(`Updated yt-dlp to ${tag}. Run npm test before considering the new tool compatible. Roll back using npm run tools:rollback.`);
}
