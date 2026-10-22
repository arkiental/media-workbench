import { packager } from '@electron/packager';
import { downloadArtifact } from '@electron/get';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadPinned, hashFile, nativeTools, portableEnvironment, safeArchiveEntry } from './portable-package-utils.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const runtimeFiles = ['apps/desktop', 'dist', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SECURITY.md', 'package-lock.json', 'toolchain.lock.json'];
const publicDocs = ['docs/API.md', 'docs/WINDOWS_PORTABLE.md', 'docs/UX_RELIABILITY_2026-10-22.md'];
const supplements = { 'abstract-logging': 'notices/npm/abstract-logging-LICENSE.txt' };

async function exists(file) { return access(file).then(() => true, () => false); }
async function productionDependencies(staging, lock) {
  const records = [];
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative.startsWith('node_modules/') || entry.dev || entry.devOptional) continue;
    const source = path.join(root, relative), destination = path.join(staging, relative);
    const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    if (pkg.version !== entry.version) throw Error('Installed dependency differs from package-lock: ' + pkg.name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, dereference: true, filter: file => {
      const inside = path.relative(source, file);
      return !inside.split(path.sep).includes('node_modules');
    } });
    const licenses = (await readdir(source)).filter(name => /^(licen[sc]e|copying|copyright|notice)([._-]|$)/i.test(name));
    if (!licenses.length) {
      const supplement = supplements[pkg.name];
      if (!supplement || !await exists(path.join(root, supplement))) throw Error('Missing retained license text for ' + pkg.name + '. Add the exact upstream notice before packaging.');
      await copyFile(path.join(root, supplement), path.join(destination, 'LICENSE'));
      licenses.push('LICENSE');
    }
    records.push({ path: relative, name: pkg.name, version: pkg.version, license: pkg.license ?? entry.license, resolved: entry.resolved, integrity: entry.integrity, retainedNotices: licenses });
  }
  return records;
}
async function officialNode(staging, lock) {
  const version = lock.node, folder = 'node-v' + version + '-win-x64', name = folder + '.zip';
  const base = 'https://nodejs.org/dist/v' + version + '/';
  const cache = path.join(root, 'test-output', 'portable-cache'); await mkdir(cache, { recursive: true });
  const sumsFile = path.join(cache, 'node-' + version + '-SHASUMS256.txt');
  if (!await exists(sumsFile)) {
    const response = await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('Cannot obtain the official Node release checksums');
    const sums = await response.text(); if (sums.length > 1024 ** 2) throw Error('Unexpected Node checksum list size');
    await writeFile(sumsFile, sums);
  }
  const line = (await readFile(sumsFile, 'utf8')).split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts.at(-1) === name);
  const expected = line?.[0]; if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw Error('Official Node archive checksum is missing');
  const archive = path.join(cache, name);
  if (!await exists(archive) || await hashFile(archive) !== expected) {
    await rm(archive, { force: true }); await downloadPinned(base + name, archive, expected, { maxBytes: 100 * 1024 ** 2, label: 'Node runtime' });
  }
  const env = portableEnvironment(process.env, staging), tar = path.join(env.SystemRoot, 'System32', 'tar.exe');
  const scratch = await mkdtemp(path.join(cache, 'node-'));
  try {
    const listing = await execute(tar, ['-tf', archive], { env, windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 ** 2 });
    if (listing.stdout.split(/\r?\n/).filter(Boolean).some(name => name !== folder && !safeArchiveEntry(name, folder))) throw Error('Unexpected Node release archive layout');
    await execute(tar, ['-xf', archive, '-C', scratch, folder + '/node.exe', folder + '/LICENSE'], { env, windowsHide: true, timeout: 60000 });
    const tools = path.join(staging, '.tools'); await mkdir(tools, { recursive: true });
    await copyFile(path.join(scratch, folder, 'node.exe'), path.join(tools, 'node.exe'));
    await copyFile(path.join(scratch, folder, 'LICENSE'), path.join(tools, 'Node-LICENSE.txt'));
    const actual = (await execute(path.join(tools, 'node.exe'), ['--version'], { env, windowsHide: true })).stdout.trim();
    if (actual !== 'v' + version) throw Error('Bundled Node version differs from the locked release');
    await copyFile(sumsFile, path.join(tools, 'Node-SHASUMS256.txt'));
    return { name: 'node', path: 'node.exe', version, sha256: await hashFile(path.join(tools, 'node.exe')), source: base + name, archiveSha256: expected, checksumSource: base + 'SHASUMS256.txt', licensePath: 'Node-LICENSE.txt' };
  } finally {
    if (path.dirname(path.resolve(scratch)) !== path.resolve(cache)) throw Error('Unsafe Node preparation cleanup path');
    await rm(scratch, { recursive: true, force: true });
  }
}
async function inventory(directory, base = directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await inventory(file, base));
    else if (item.isFile()) files.push({ path: path.relative(base, file).replaceAll('\\', '/'), sha256: await hashFile(file) });
    else throw Error('Unexpected linked file in packaged output: ' + path.relative(base, file));
  }
  return files;
}

export async function packageDesktop({ portable = false } = {}) {
  process.chdir(root);
  const outputRoot=path.resolve(process.env.MW_PACKAGE_OUTPUT||'release');
  if(process.env.MW_PACKAGE_OUTPUT&&await exists(outputRoot))throw Error('Choose a new package output directory; existing output will not be replaced.');
  if (portable && (process.platform !== 'win32' || process.arch !== 'x64')) throw Error('Portable release packaging requires Windows x64');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const toolsLock = JSON.parse(await readFile('toolchain.lock.json', 'utf8'));
  const sourceCommit = (await execute('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), 'rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit)) throw Error('Cannot identify the package source commit');
  const sourceServerSha256 = await hashFile('dist/server/main.js');
  await mkdir('test-output', { recursive: true });
  const staging = await mkdtemp(path.resolve('test-output/package-'));
  for (const item of runtimeFiles) await cp(item, path.join(staging, item), { recursive: true, dereference: true, filter: file => path.basename(file) !== '.build-state.json' });
  for (const item of publicDocs) if (await exists(item)) await cp(item, path.join(staging, item), { recursive: true, dereference: true });
  const dependencies = await productionDependencies(staging, lock);
  await writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: 'apps/desktop/main.cjs', type: 'module', dependencies: pkg.dependencies }));
  let tools, bootstrapRequired = false;
  if (portable) {
    const node = await officialNode(staging, toolsLock); tools = [node]; bootstrapRequired = true;
    await mkdir(path.join(staging, 'scripts'), { recursive: true });
    for (const name of ['portable-bootstrap.mjs', 'portable-package-utils.mjs']) await copyFile(path.join(root, 'scripts', name), path.join(staging, 'scripts', name));
    await writeFile(path.join(staging, 'portable-tools.json'), JSON.stringify({ schemaVersion: 1, node, nativeDownloads: nativeTools }, null, 2));
    await writeFile(path.join(staging, '.tools', 'manifest.json'), JSON.stringify({ schemaVersion: 1, bootstrapRequired, ytDlpTag: nativeTools.ytdlp.version, tools }, null, 2));
  } else {
    const manifest = JSON.parse(await readFile('.tools/manifest.json', 'utf8')); tools = manifest.tools;
    await mkdir(path.join(staging, '.tools'), { recursive: true });
    for (const tool of tools) {
      if (path.basename(tool.path) !== tool.path || await hashFile(path.join(root, '.tools', tool.path)) !== tool.sha256) throw Error('Tool integrity mismatch: ' + tool.name);
      await copyFile(path.join(root, '.tools', tool.path), path.join(staging, '.tools', tool.path));
    }
    await writeFile(path.join(staging, '.tools', 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  const electronArchive = await downloadArtifact({ version: toolsLock.electron, artifactName: 'electron', platform: process.platform, arch: process.arch });
  const electron = { version: toolsLock.electron, source: 'https://github.com/electron/electron/releases/download/v' + toolsLock.electron + '/electron-v' + toolsLock.electron + '-' + process.platform + '-' + process.arch + '.zip', sha256: await hashFile(electronArchive), checksumVerification: '@electron/get release checksum validation' };
  const result = await packager({ dir: staging, electronZipDir: path.dirname(electronArchive), out: outputRoot, name: 'Media Workbench', platform: process.platform, arch: process.arch, electronVersion: toolsLock.electron, asar: false, overwrite: !process.env.MW_PACKAGE_OUTPUT, prune: false, appCopyright: 'MIT original application; separate component licenses', executableName: 'media-workbench' });
  for (const output of result) {
    const app = path.join(output, 'resources', 'app'), packagedServerSha256 = await hashFile(path.join(app, 'dist/server/main.js'));
    if (packagedServerSha256 !== sourceServerSha256 || await hashFile('dist/server/main.js') !== sourceServerSha256) throw Error('Packaged server differs from the final build; rebuild from stable source.');
    if (portable) {
      const launcher = '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nset "NODE_OPTIONS="\r\nset "NODE_PATH="\r\nset "NODE_EXTRA_CA_CERTS="\r\nset "NODE_USE_ENV_PROXY="\r\n".\\resources\\app\\.tools\\node.exe" ".\\resources\\app\\scripts\\portable-bootstrap.mjs" --launch\r\nif errorlevel 1 pause\r\n';
      await writeFile(path.join(output, 'Start Media Workbench.cmd'), launcher);
      await copyFile(path.join(root, 'LICENSE'), path.join(output, 'Media-Workbench-LICENSE.txt'));
      await copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md'));
      if (await exists('docs/WINDOWS_PORTABLE.md')) await copyFile('docs/WINDOWS_PORTABLE.md', path.join(output, 'READ-ME-FIRST.md'));
      for (const native of ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe', 'yt-dlp.exe.previous']) if (await exists(path.join(app, '.tools', native))) throw Error('Portable ZIP must not contain downloaded native tools');
    }
    for (const notice of ['LICENSE', 'LICENSES.chromium.html']) if (!await exists(path.join(output, notice))) throw Error('Missing Electron release notice: ' + notice);
    const provenance = { schemaVersion: 2, sourceCommit, builtAt: new Date().toISOString(), version: pkg.version, platform: process.platform, arch: process.arch, electronVersion: toolsLock.electron, electron, sourceServerPath: 'dist/server/main.js', sourceServerSha256, packagedServerSha256, serverMatchesFinalBuild: true, bootstrapRequired, nativeToolsIncluded: !portable, tools, npmDependencies: dependencies, nativeDownloads: portable ? nativeTools : undefined, includedPublicDocs: [], files: await inventory(output), distribution: portable ? 'Unsigned portable app. Official Node and Electron runtimes and npm production dependencies retained with notices. FFmpeg and yt-dlp are downloaded by the user on first launch; not included in this archive.' : 'Personal local build with developer-supplied native tools.' };
    provenance.includedPublicDocs = [];
    for (const item of publicDocs) if (await exists(path.join(app, item))) provenance.includedPublicDocs.push(item);
    await writeFile(path.join(output, 'package-provenance.json'), JSON.stringify(provenance, null, 2)); await writeFile(path.join(app, 'package-provenance.json'), JSON.stringify(provenance, null, 2));
  }
  console.log(JSON.stringify({ outputs: result, portable, bootstrapRequired }, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await packageDesktop({ portable: process.argv.includes('--portable') });
