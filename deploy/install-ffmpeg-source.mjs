import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const release='9.0.1';
const hash='cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635';
async function fetchFile(url,path){const r=await fetch(url);if(!r.ok)throw Error(`Official FFmpeg download failed: ${r.status}`);const b=Buffer.from(await r.arrayBuffer());await writeFile(path,b);return b;}
const tar=await fetchFile(`https://ffmpeg.org/releases/ffmpeg-${release}.tar.xz`,`/tmp/ffmpeg-${release}.tar.xz`);
if(createHash('sha256').update(tar).digest('hex')!==hash)throw Error('FFmpeg source SHA256 mismatch');
await fetchFile(`https://ffmpeg.org/releases/ffmpeg-${release}.tar.xz.asc`,`/tmp/ffmpeg-${release}.tar.xz.asc`);
await fetchFile('https://ffmpeg.org/ffmpeg-devel.asc','/tmp/ffmpeg-devel.asc');
execFileSync('gpg',['--batch','--import','/tmp/ffmpeg-devel.asc']);
const keys=execFileSync('gpg',['--batch','--with-colons','--fingerprint'],{encoding:'utf8'});
if(!keys.includes('FCF986EA15E6E293A5644F10B4322F04D67658D8'))throw Error('Unexpected FFmpeg release signing key');
execFileSync('gpg',['--batch','--verify',`/tmp/ffmpeg-${release}.tar.xz.asc`,`/tmp/ffmpeg-${release}.tar.xz`]);
execFileSync('tar',['-xJf',`/tmp/ffmpeg-${release}.tar.xz`,'-C','/tmp']);
