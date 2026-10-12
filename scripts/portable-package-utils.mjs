import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

export const nativeTools = Object.freeze({
  ffmpeg: { version: '8.0.1', url: 'https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-full_build.7z', sha256: '42edab4b9241ff1184b26d5f4545322227589713a7e56cf4459c4c4e30ccaaac', folder: 'ffmpeg-8.0.1-full_build' },
  ytdlp: { version: '2026.08.19', url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe', sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a' }
});

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function portableEnvironment(input, root) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']) {
    const value = Object.entries(input).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    if (value) env[key] = value;
  }
  env.SystemRoot ||= 'C:\\Windows'; env.WINDIR ||= env.SystemRoot;
  env.PATH = path.join(env.SystemRoot, 'System32');
  env.MW_PORTABLE_ROOT = root;
  env.MW_PORTABLE_USER_DATA = path.join(root, 'data', 'desktop');
  env.MW_DATA_DIR = path.join(root, 'data', 'media-service');
  return env;
}
export function safeArchiveEntry(name, prefix) {
  const normalized = name.replaceAll('\\', '/');
  return !normalized.includes('\0') && !normalized.startsWith('/') && !/^[a-z]:/i.test(normalized) && !normalized.split('/').includes('..') && normalized.startsWith(prefix + '/');
}
export async function downloadPinned(url, destination, expected, { maxBytes = 250 * 1024 ** 2, label = 'File', onProgress } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw Error('Missing download integrity record');
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw Error('Only fixed secure download URLs are supported');
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = destination + '.part';
  try {
    const response = await fetch(target, { headers: { 'User-Agent': 'MediaWorkbench-Portable' }, signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') throw Error(label + ' download failed (' + response.status + ')');
    if (Number(response.headers.get('content-length')) > maxBytes) throw Error(label + ' download is larger than its allowed size');
    let received = 0;
    const hash = createHash('sha256');
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) { callback(Error(label + ' download is larger than its allowed size')); return; }
        hash.update(chunk); onProgress?.(received); callback(null, chunk);
      }
    }), createWriteStream(partial, { flags: 'wx' }));
    if (hash.digest('hex') !== expected) throw Error(label + ' download did not pass its integrity check. Run the launcher again.');
    await rename(partial, destination);
  } catch (error) { await rm(partial, { force: true }); throw error; }
}
