import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFreshness, dependencyState } from './build-state.mjs';

function runNode(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${args[0]} failed (${signal || code}).`)));
  });
}

async function nonemptyFile(file) {
  try { const info = await stat(file); return info.isFile() && info.size > 0; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function checkTools(root, platform = process.platform) {
  const suffix = platform === 'win32' ? '.exe' : '';
  for (const name of ['node', 'ffmpeg', 'ffprobe', 'yt-dlp']) {
    if (!await nonemptyFile(path.join(root, '.tools', `${name}${suffix}`))) throw new Error(`Media tool ${name} is missing or empty. Run npm run tools:setup before launching.`);
  }
}

export async function prepareLaunch(root, { run = runNode, log = console.log, platform = process.platform } = {}) {
  await dependencyState(root);
  await checkTools(root, platform);
  const electronRoot = path.join(root, 'node_modules', 'electron');
  const executable = platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  if (!await nonemptyFile(path.join(electronRoot, 'dist', executable))) {
    log('Installing the missing Electron runtime...');
    await run(root, [path.join(electronRoot, 'install.js')]);
  }
  const expected = JSON.parse(await readFile(path.join(electronRoot, 'package.json'), 'utf8')).version;
  const actual = await readFile(path.join(electronRoot, 'dist', 'version'), 'utf8').then(value => value.trim(), () => 'missing');
  if (actual !== expected || !await nonemptyFile(path.join(electronRoot, 'dist', executable))) throw new Error(`Electron runtime is ${actual}; expected ${expected}. Run node node_modules/electron/install.js to repair the runtime.`);
  const freshness = await buildFreshness(root);
  if (freshness.current) {
    log('Using the current build.');
    return { built: false, reason: freshness.reason };
  }
  log(`Building Media Workbench: ${freshness.reason}.`);
  await run(root, [path.join(root, 'scripts', 'build.mjs')]);
  if (!(await buildFreshness(root)).current) throw new Error('The build did not produce current verified outputs. Launch stopped.');
  return { built: true, reason: freshness.reason };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try { await prepareLaunch(root); }
  catch (error) { console.error(`Cannot start Media Workbench: ${error.message}`); process.exitCode = 1; }
}
