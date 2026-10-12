import { access, copyFile, cp, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { downloadPinned, hashFile, nativeTools, portableEnvironment, safeArchiveEntry } from './portable-package-utils.mjs';

const execute = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleRoot = path.resolve(appRoot, '../..');

async function cachedTools(toolsRoot, nodeRecord) {
  try {
    const manifest = JSON.parse(await readFile(path.join(toolsRoot, 'manifest.json'), 'utf8'));
    if (manifest.ytDlpTag !== nativeTools.ytdlp.version || manifest.ffmpegVersion !== nativeTools.ffmpeg.version || manifest.tools.length !== 4) return false;
    for (const [name, file] of [['node', 'node.exe'], ['ffmpeg', 'ffmpeg.exe'], ['ffprobe', 'ffprobe.exe'], ['yt-dlp', 'yt-dlp.exe']]) {
      const records = manifest.tools.filter(tool => tool.name === name && tool.path === file);
      if (records.length !== 1 || !/^[a-f0-9]{64}$/.test(records[0].sha256)) return false;
      const expected = name === 'node' ? nodeRecord.sha256 : name === 'yt-dlp' ? nativeTools.ytdlp.sha256 : records[0].sha256;
      if (records[0].sha256 !== expected || await hashFile(path.join(toolsRoot, file)) !== expected) return false;
    }
    return manifest;
  } catch { return false; }
}

export async function prepareTools(root = appRoot) {
  if (process.platform !== 'win32') throw Error('This portable package is for Windows x64.');
  const toolsRoot = path.join(root, '.tools'), bundle = path.resolve(root, '../..');
  const env = portableEnvironment(process.env, bundle);
  const config = JSON.parse(await readFile(path.join(root, 'portable-tools.json'), 'utf8'));
  const nodeRecord = config.node;
  if (nodeRecord.path !== 'node.exe' || await hashFile(path.join(toolsRoot, 'node.exe')) !== nodeRecord.sha256) throw Error('The bundled Node runtime is damaged. Extract a fresh copy of the portable ZIP.');
  const cached = await cachedTools(toolsRoot, nodeRecord);
  if (cached) return { event: 'portable-tools-ready', offline: true, versions: { node: nodeRecord.version, ffmpeg: nativeTools.ffmpeg.version, ytDlp: nativeTools.ytdlp.version } };
  console.log('First-time setup downloads FFmpeg and yt-dlp from their official release hosts. Later launches work offline.');
  const tar = path.join(env.SystemRoot, 'System32', 'tar.exe');
  await access(tar).catch(() => { throw Error('Windows tar.exe is required to unpack FFmpeg. Use a supported Windows version with the built-in archive tool.'); });
  let lock;
  const lockPath = path.join(toolsRoot, 'setup.lock');
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recorded = await readFile(lockPath, 'utf8').catch(() => '');
    const pidText = recorded.trim(), pid = Number(pidText);
    if (!/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(pid) || pid > 0xffffffff) throw Error('The first-time setup lock is incomplete or unreadable. Close all Media Workbench setup windows. In the extracted portable folder, remove resources\\app\\.tools\\setup.lock, then run Start Media Workbench.cmd again.');
    let stale = false;
    try { process.kill(pid, 0); } catch (probe) { stale = probe.code === 'ESRCH'; }
    if (!stale || await readFile(lockPath, 'utf8').catch(() => '') !== recorded) throw Error('Another first-time setup is running. Wait for it to finish before opening the launcher again.');
    await rm(lockPath, { force: true }); lock = await open(lockPath, 'wx');
  }
  let scratch;
  try {
    await lock.writeFile(String(process.pid));
    scratch = await mkdtemp(path.join(toolsRoot, 'setup-'));
    const archive = path.join(scratch, 'ffmpeg.7z');
    const progress = label => {
      let last = 0;
      return received => { const mb = Math.floor(received / 1024 ** 2); if (mb >= last + 10) { last = mb; console.log(label + ': ' + mb + ' MB downloaded'); } };
    };
    console.log('Downloading FFmpeg 8.0.1…');
    await downloadPinned(nativeTools.ffmpeg.url, archive, nativeTools.ffmpeg.sha256, { label: 'FFmpeg', onProgress: progress('FFmpeg') });
    const listing = await execute(tar, ['-tf', archive], { cwd: scratch, env, windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 ** 2 });
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some(name => name.replaceAll('\\', '/') !== nativeTools.ffmpeg.folder && !safeArchiveEntry(name, nativeTools.ffmpeg.folder))) throw Error('The FFmpeg archive has an unexpected layout.');
    const binaries = ['ffmpeg', 'ffprobe'].map(name => nativeTools.ffmpeg.folder + '/bin/' + name + '.exe');
    if (binaries.some(name => !entries.includes(name))) throw Error('The FFmpeg archive is missing the required tools.');
    const notices = entries.filter(name => /(?:^|\/)(?:licen[sc]e|copying|copyright|notice|readme)(?:[._/-]|$)/i.test(name));
    await execute(tar, ['-xf', archive, '-C', scratch, ...binaries, ...notices], { cwd: scratch, env, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 ** 2 });
    console.log('Downloading yt-dlp ' + nativeTools.ytdlp.version + '…');
    await downloadPinned(nativeTools.ytdlp.url, path.join(scratch, 'yt-dlp.exe'), nativeTools.ytdlp.sha256, { maxBytes: 64 * 1024 ** 2, label: 'yt-dlp', onProgress: progress('yt-dlp') });
    const records = [nodeRecord];
    for (const name of ['ffmpeg', 'ffprobe', 'yt-dlp']) {
      const source = name === 'yt-dlp' ? path.join(scratch, 'yt-dlp.exe') : path.join(scratch, nativeTools.ffmpeg.folder, 'bin', name + '.exe');
      const destination = path.join(toolsRoot, name + '.exe');
      const digest = await hashFile(source);
      await copyFile(source, destination + '.new'); await rename(destination + '.new', destination);
      records.push({ name, path: name + '.exe', sha256: digest, version: name === 'yt-dlp' ? nativeTools.ytdlp.version : nativeTools.ffmpeg.version, source: name === 'yt-dlp' ? nativeTools.ytdlp.url : nativeTools.ffmpeg.url, archiveSha256: name === 'yt-dlp' ? undefined : nativeTools.ffmpeg.sha256 });
    }
    const noticesRoot = path.join(toolsRoot, 'native-notices', 'ffmpeg');
    await mkdir(noticesRoot, { recursive: true });
    for (const name of notices) {
      const destination = path.join(noticesRoot, name.slice(nativeTools.ffmpeg.folder.length + 1));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(scratch, name), destination, { recursive: true, dereference: true });
    }
    for (const [name, args] of [['ffmpeg', ['-version']], ['ffprobe', ['-version']], ['yt-dlp', ['--version']]]) {
      await execute(path.join(toolsRoot, name + '.exe'), args, { cwd: root, env, windowsHide: true, timeout: 30000, maxBuffer: 1024 ** 2 });
    }
    const manifest = { schemaVersion: 1, ytDlpTag: nativeTools.ytdlp.version, ffmpegVersion: nativeTools.ffmpeg.version, createdAt: new Date().toISOString(), distribution: 'Native tools downloaded by the user on first run; not included in the portable ZIP.', tools: records };
    await writeFile(path.join(toolsRoot, 'manifest.json.new'), JSON.stringify(manifest, null, 2)); await rename(path.join(toolsRoot, 'manifest.json.new'), path.join(toolsRoot, 'manifest.json'));
    return { event: 'portable-tools-ready', offline: false, versions: { node: nodeRecord.version, ffmpeg: nativeTools.ffmpeg.version, ytDlp: nativeTools.ytdlp.version } };
  } finally {
    try {
      if (scratch) {
        const checked = path.resolve(scratch);
        if (path.dirname(checked) !== path.resolve(toolsRoot) || !path.basename(checked).startsWith('setup-')) throw Error('Unsafe setup cleanup path');
        await rm(checked, { recursive: true, force: true });
      }
    } finally { await lock.close().finally(() => rm(lockPath, { force: true })); }
  }
}

async function main() {
  const env = portableEnvironment(process.env, bundleRoot);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  const result = await prepareTools();
  console.log(JSON.stringify(result));
  if (process.argv.includes('--prepare-only')) return;
  await mkdir(env.MW_PORTABLE_USER_DATA, { recursive: true }); await mkdir(env.MW_DATA_DIR, { recursive: true });
  const executable = path.join(bundleRoot, 'media-workbench.exe');
  await access(executable);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [], { cwd: bundleRoot, env, shell: false, windowsHide: false, detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error('Media Workbench could not start: ' + error.message); process.exitCode = 1; });
}
