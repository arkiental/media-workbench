import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const { waitForService, stopService, hasExited } = createRequire(import.meta.url)('../apps/desktop/startup.cjs');
const buildState = await import(pathToFileURL(path.resolve('scripts/build-state.mjs')).href);
const { prepareLaunch } = await import(pathToFileURL(path.resolve('scripts/prepare-launch.mjs')).href);

async function generatedCheckout() {
  await mkdir('test-output/startup', { recursive: true });
  const root = await mkdtemp(path.resolve('test-output/startup/checkout-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ dependencies: { example: '1.0.0' }, devDependencies: { electron: '44.3.0' } }),
    'package-lock.json': JSON.stringify({ packages: { '': { dependencies: { example: '1.0.0' }, devDependencies: { electron: '44.3.0' } }, 'node_modules/example': { version: '1.0.0' }, 'node_modules/electron': { version: '44.3.0' } } }),
    'node_modules/example/package.json': JSON.stringify({ version: '1.0.0' }),
    'node_modules/electron/package.json': JSON.stringify({ version: '44.3.0' }),
    'node_modules/electron/dist/electron.exe': 'generated executable marker',
    'node_modules/electron/dist/version': '44.3.0\n',
    'tsconfig.json': '{}',
    'scripts/build.mjs': 'generated build script marker',
    'scripts/build-state.mjs': 'generated build cache marker',
    'apps/server/src/main.ts': 'export const value = 1;',
    'apps/web/src/main.tsx': 'export const title = "fixture";',
    'apps/web/src/main.css': 'body { color: white; }',
    'apps/web/index.html': '<div id="root"></div>',
    'apps/web/assets/fonts/generated.woff2': 'generated font marker',
    'packages/example.ts': 'export const shared = true;',
    'tests/generated.ts': 'export const testInput = true;',
    'dist/server/main.js': 'generated service output',
    'dist/web/main.js': 'generated browser output',
    'dist/web/index.html': '<div id="root"></div>',
    'dist/web/fonts/generated.woff2': 'generated font output',
    '.tools/node.exe': 'generated Node marker',
    '.tools/ffmpeg.exe': 'generated FFmpeg marker',
    '.tools/ffprobe.exe': 'generated ffprobe marker',
    '.tools/yt-dlp.exe': 'generated downloader marker',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await buildState.recordBuild(root, await buildState.buildInputs(root));
  return root;
}

test('startup cache detects changed bytes even with restored timestamps, and missing or altered outputs', async () => {
  const root = await generatedCheckout();
  assert.equal((await buildState.buildFreshness(root)).current, true);
  const source = path.join(root, 'apps/server/src/main.ts');
  const original = await readFile(source);
  const before = await stat(source);
  await utimes(source, before.atime, new Date(before.mtimeMs + 10000));
  assert.equal((await buildState.buildFreshness(root)).current, true, 'timestamp-only changes reuse identical content');
  await writeFile(source, 'export const value = 2;');
  await utimes(source, before.atime, before.mtime);
  assert.equal((await buildState.buildFreshness(root)).current, false, 'a same-size change with its timestamp restored must rebuild');
  await writeFile(source, original);
  assert.equal((await buildState.buildFreshness(root)).current, true);
  await writeFile(path.join(root, 'dist/web/main.js'), 'changed browser output');
  assert.equal((await buildState.buildFreshness(root)).current, false);
  await writeFile(path.join(root, 'dist/web/main.js'), 'generated browser output');
  await unlink(path.join(root, 'dist/web/fonts/generated.woff2'));
  assert.equal((await buildState.buildFreshness(root)).current, false, 'copied assets are part of the completed build');
});

test('startup refuses to stamp inputs that changed while building', async () => {
  const root = await generatedCheckout();
  const inputs = await buildState.buildInputs(root);
  await writeFile(path.join(root, 'apps/web/src/main.css'), 'body { color: black; }');
  await assert.rejects(buildState.recordBuild(root, inputs), /changed during the build/);
  assert.equal((await buildState.buildFreshness(root)).current, false);
});

test('missing and malformed build records require a rebuild instead of blocking recovery', async () => {
  const root = await generatedCheckout();
  const record = path.join(root, 'dist/.build-state.json');
  await unlink(record);
  assert.equal((await buildState.buildFreshness(root)).current, false);
  await writeFile(record, '{unfinished');
  assert.equal((await buildState.buildFreshness(root)).current, false);
  await writeFile(record, 'null');
  assert.equal((await buildState.buildFreshness(root)).current, false);
});

test('repeat launch reuses current outputs; source changes run one build and failed builds stop launch', async () => {
  const root = await generatedCheckout();
  const calls: string[][] = [];
  const run = async (_root: string, args: string[]) => {
    calls.push(args);
    await buildState.recordBuild(root, await buildState.buildInputs(root));
  };
  const options = { run, log: () => {}, platform: 'win32' };
  assert.equal((await prepareLaunch(root, options)).built, false);
  assert.equal(calls.length, 0);
  await writeFile(path.join(root, 'apps/server/src/main.ts'), 'export const value = 9;');
  assert.equal((await prepareLaunch(root, options)).built, true);
  assert.equal(calls.length, 1);
  assert.equal(path.basename(calls[0][0]), 'build.mjs');
  assert.equal((await prepareLaunch(root, options)).built, false);
  await writeFile(path.join(root, 'tests/generated.ts'), 'export const testInput = false;');
  await assert.rejects(prepareLaunch(root, { ...options, run: async () => { throw new Error('TypeScript regression'); } }), /TypeScript regression/);
  assert.equal((await buildState.buildFreshness(root)).current, false);
});

test('a missing Electron runtime repairs only Electron; missing dependencies and tools fail without reinstalling', async () => {
  const root = await generatedCheckout();
  const calls: string[][] = [];
  await unlink(path.join(root, 'node_modules/electron/dist/electron.exe'));
  const options = {
    platform: 'win32', log: () => {}, run: async (_root: string, args: string[]) => {
      calls.push(args);
      assert.equal(path.basename(args[0]), 'install.js');
      await writeFile(path.join(root, 'node_modules/electron/dist/electron.exe'), 'repaired generated marker');
    },
  };
  assert.equal((await prepareLaunch(root, options)).built, false);
  assert.equal(calls.length, 1);
  await unlink(path.join(root, '.tools/ffprobe.exe'));
  await assert.rejects(prepareLaunch(root, options), /ffprobe.*missing/);
  assert.equal(calls.length, 1);
  await writeFile(path.join(root, '.tools/ffprobe.exe'), 'generated ffprobe marker');
  await writeFile(path.join(root, 'node_modules/example/package.json'), JSON.stringify({ version: '0.9.0' }));
  await assert.rejects(prepareLaunch(root, options), /requires 1.0.0.*npm ci/);
  assert.equal(calls.length, 1, 'launch must not silently replace existing dependencies');
});

function generatedChild(source: string, t: TestContext) {
  const child = spawn(process.execPath, ['-e', source], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  t.after(async () => {
    if (!hasExited(child)) { child.kill(); await once(child, 'exit').catch(() => {}); }
  });
  return child;
}

test('desktop readiness ignores unrelated/invalid ports, handles split and oversized lines, then removes its listeners', async t => {
  const child = generatedChild(`
    process.stdout.write('{"event":"progress","port":1}\\n{"event":"ready","port":70000}\\n');
    process.stdout.write('x'.repeat(150000) + '\\n');
    process.stdout.write('{"event":"ready","po');
    setTimeout(() => process.stdout.write('rt":54321}\\n'), 20);
    process.stdin.on('data', data => { if(data.toString().trim() === 'shutdown') process.exit(0); });
  `, t);
  assert.equal(await waitForService(child, { timeoutMs: 5000 }), 54321);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('exit'), 0);
  await stopService(child, { graceMs: 500, forceStop: () => { throw Error('Graceful service must not be killed'); } });
  assert.equal(child.exitCode, 0);
});

test('early service failure and readiness timeout include useful diagnostics and clear listeners', async t => {
  const failed = generatedChild(`process.stderr.write('generated startup failure\\n'); process.exitCode = 7;`, t);
  await assert.rejects(waitForService(failed, { timeoutMs: 5000, logPath: 'generated/service.log' }), /exited.*7.*generated startup failure.*Log: generated\/service.log/s);
  assert.equal(failed.stdout.listenerCount('data'), 0);
  const stalled = generatedChild(`process.stderr.write('generated stall\\n'); setInterval(() => {}, 1000);`, t);
  await assert.rejects(waitForService(stalled, { timeoutMs: 1000, logPath: 'generated/service.log' }), /within 1 seconds.*generated stall.*Log:/s);
  assert.equal(stalled.stdout.listenerCount('data'), 0);
  assert.equal(stalled.listenerCount('exit'), 0);
});

test('service spawn failure rejects promptly with its cause and log path', async () => {
  const child = spawn(path.resolve('test-output/startup/absent-runtime.exe'), [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await assert.rejects(waitForService(child, { timeoutMs: 5000, logPath: 'generated/service.log' }), /Cannot start.*ENOENT.*Log: generated\/service.log/s);
  assert.equal(child.stdout!.listenerCount('data'), 0);
});

test('shutdown escalation targets the owned child and waits for its actual exit', async t => {
  const child = generatedChild(`console.log(JSON.stringify({event:'ready',port:54321})); process.stdin.resume(); setInterval(() => {}, 1000);`, t);
  await waitForService(child, { timeoutMs: 5000 });
  const forced: number[] = [];
  await stopService(child, { graceMs: 40, forceStop: (owned: ChildProcessWithoutNullStreams) => { forced.push(owned.pid!); owned.kill(); } });
  assert.deepEqual(forced, [child.pid]);
  assert.equal(hasExited(child), true);
  assert.equal(child.stdin.listenerCount('error'), 0);
});

test('shutdown remains bounded when its force helper never responds', async t => {
  const child = generatedChild(`console.log(JSON.stringify({event:'ready',port:54321})); process.stdin.resume(); setInterval(() => {}, 1000);`, t);
  await waitForService(child, { timeoutMs: 5000 });
  const started = performance.now();
  let attempts = 0;
  await assert.rejects(stopService(child, { graceMs: 20, forceTimeoutMs: 50, forceStop: () => { attempts++; return new Promise(() => {}); } }), /did not exit after forced shutdown/);
  assert.equal(attempts, 1);
  assert(performance.now() - started < 1000, 'a hung force helper must not block desktop shutdown indefinitely');
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.stdin.listenerCount('error'), 0);
});
