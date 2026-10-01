import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { downloadMedia, inspectDownload, type DownloadContext } from '../apps/server/src/download.ts';
import { DownloadSchema, type ExecutionContext, type NativeRunOptions, type ToolPaths } from '../packages/contracts/src/index.ts';
import { defaultPolicy } from '../packages/core/src/policy.ts';
import { runProcess } from '../packages/media/src/process.ts';

const outputRoot = path.resolve('test-output/download-progress');
const nativeTools: ToolPaths = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ytdlp: 'yt-dlp', node: process.execPath };
const fixtureBytes = Buffer.from('generated local download fixture');
const metadata = { id: 'local-fixture', title: 'Local fixture', duration: 1, formats: [{ format_id: 'video', ext: 'mp4' }] };

async function workspace() {
  await mkdir(outputRoot, { recursive: true });
  return mkdtemp(path.join(outputRoot, 'case-'));
}

async function fixture(t: TestContext) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fixtureBytes.length });
    response.end(fixtureBytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const workDir = await workspace();
  const request = DownloadSchema.parse({ url: `${origin}/video`, preference: 'original' });
  const context: DownloadContext = {
    workDir, signal: new AbortController().signal, maxRuntimeSeconds: 5,
    policy: defaultPolicy('owner'), testOrigin: origin,
  };
  return { origin, workDir, request, context };
}

async function completeFile(workDir: string) {
  await writeFile(path.join(workDir, 'download.mkv'), fixtureBytes);
  return { stdout: Buffer.alloc(0), stderr: '', exitCode: 0 };
}

test('real native output streams incrementally with split CRLF, UTF-8 and EOF tails', { timeout: 10000 }, async () => {
  const workDir = await workspace();
  const lines: { line: string; stream: 'stdout' | 'stderr' }[] = [];
  let resolveFirst!: () => void;
  const first = new Promise<void>(resolve => { resolveFirst = resolve; });
  let completed = false;
  const script = String.raw`
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    (async () => {
      process.stdout.write('first\r'); await pause(30);
      process.stdout.write('\nsec'); await pause(30);
      process.stderr.write('warning\r'); await pause(30);
      process.stderr.write('\nsecond warning\n'); await pause(30);
      process.stdout.write('ond\nsnow: ');
      const snow = Buffer.from('雪');
      process.stdout.write(snow.subarray(0, 1)); await pause(30);
      process.stdout.write(snow.subarray(1));
      process.stdout.write('\rthird\r\nstdout tail');
      process.stderr.write('stderr tail');
      await pause(150);
    })();
  `;
  const running = runProcess(process.execPath, ['-e', script], {
    workDir, signal: new AbortController().signal, maxRuntimeSeconds: 5,
  }, { onOutputLine: (line, stream) => { lines.push({ line, stream }); resolveFirst(); } }).finally(() => { completed = true; });
  await first;
  assert.equal(completed, false, 'a progress line arrives before the child completes');
  const result = await running;
  assert.deepEqual(lines.filter(item => item.stream === 'stdout').map(item => item.line), ['first', 'second', 'snow: 雪', 'third', 'stdout tail']);
  assert.deepEqual(lines.filter(item => item.stream === 'stderr').map(item => item.line), ['warning', 'second warning', 'stderr tail']);
  assert.equal(result.stdout.toString(), 'first\r\nsecond\nsnow: 雪\rthird\r\nstdout tail');
  assert.equal(result.stderr, 'warning\r\nsecond warning\nstderr tail');
});

test('native line callbacks cannot accumulate or forward an oversized unterminated line', { timeout: 15000 }, async () => {
  const workDir = await workspace();
  const seen: string[] = [];
  await assert.rejects(runProcess(process.execPath, ['-e', "process.stderr.write('x'.repeat(65537));setInterval(()=>{},1000)"], {
    workDir, signal: new AbortController().signal, maxRuntimeSeconds: 5,
  }, { maxStderrBytes: 128, onOutputLine: line => seen.push(line) }), /output line exceeded limit/);
  assert.ok(seen.every(line => line.length <= 65536), 'oversized pending output stays outside callbacks, including EOF cleanup');
});

test('a native output callback error terminates the owned tool and retains its reason', { timeout: 15000 }, async () => {
  const workDir = await workspace();
  await assert.rejects(runProcess(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], {
    workDir, signal: new AbortController().signal, maxRuntimeSeconds: 5,
  }, { onOutputLine: () => { throw new Error('Progress observer rejected the output'); } }), /Progress observer rejected the output/);
});

test('runTool receives the incremental callback unchanged', async () => {
  const workDir = await workspace();
  const seen: [string, string][] = [];
  const options: NativeRunOptions = { onOutputLine: (line, stream) => seen.push([line, stream]) };
  const context: ExecutionContext = {
    workDir, signal: new AbortController().signal,
    runTool: async (binary, args, forwarded) => {
      assert.equal(binary, 'controlled-native'); assert.deepEqual(args, ['literal argument']);
      assert.equal(forwarded?.onOutputLine, options.onOutputLine);
      forwarded?.onOutputLine?.('first output', 'stdout');
      forwarded?.onOutputLine?.('second output', 'stderr');
      return { stdout: Buffer.from('first output\n'), stderr: 'second output\n', exitCode: 0 };
    },
  };
  await runProcess('controlled-native', ['literal argument'], context, options);
  assert.deepEqual(seen, [['first output', 'stdout'], ['second output', 'stderr']]);
});

test('inspection and download retain PATH FFmpeg discovery and forward explicit binary paths', async t => {
  for (const binary of ['ffmpeg', 'ffmpeg.exe', path.join(await workspace(), 'tool directory', 'ffmpeg.exe'), path.join('custom-tools', 'ffmpeg.exe')]) {
    await t.test(binary, async child => {
      const { context, request, workDir, origin } = await fixture(child);
      const tools = { ...nativeTools, ffmpeg: binary };
      const calls: string[][] = [];
      context.runTool = async (_binary, args) => {
        calls.push(args);
        assert.equal(args.at(-1), request.url);
        assert.equal(args.at(-2), '--');
        const proxy = new URL(args[args.indexOf('--proxy') + 1]);
        assert.equal(proxy.hostname, '127.0.0.1');
        assert.notEqual(proxy.origin, origin);
        if (args.includes('--dump-single-json')) return { stdout: Buffer.from(JSON.stringify(metadata)), stderr: '', exitCode: 0 };
        return completeFile(workDir);
      };
      const inspected = await inspectDownload(request, tools, context);
      assert.equal(inspected.entries[0].formats[0].id, 'video');
      const downloaded = await downloadMedia(request, tools, context);
      assert.deepEqual(await readFile(downloaded.path), fixtureBytes);
      assert.equal(calls.length, 2);
      for (const args of calls) {
        const index = args.indexOf('--ffmpeg-location');
        if (binary === path.basename(binary)) assert.equal(index, -1, 'a PATH command must not become the empty work directory');
        else { assert.ok(index >= 0); assert.equal(args[index + 1], path.resolve(binary)); }
      }
      const args = calls[1];
      assert.ok(args.lastIndexOf('--progress') > args.indexOf('--no-progress'), 'machine progress overrides the metadata quiet default');
      assert.ok(args.includes('--newline'));
      assert.equal(args[args.indexOf('--progress-delta') + 1], '0.25');
      assert.ok(args.includes('download:MW_DOWNLOAD:%(info.format_id)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.status)s'));
    });
  }
});

test('structured download progress tracks streams, ignores malformed lines and enters file preparation', async t => {
  const { context, request, workDir } = await fixture(t);
  const progress: { value: number; message?: string }[] = [];
  const stages: string[] = [];
  context.onProgress = (value, message) => progress.push({ value, message });
  context.onStage = value => stages.push(value);
  context.runTool = async (_binary, _args, options) => {
    assert.ok(options?.onOutputLine);
    const before = progress.length;
    for (const line of ['ordinary diagnostic', 'MW_DOWNLOAD:video|NaN|100|NA|downloading', 'MW_DOWNLOAD:video|Infinity|100|NA|downloading', 'MW_DOWNLOAD:video|-1|100|NA|downloading', 'MW_DOWNLOAD:|25|100|NA|downloading', 'MW_DOWNLOAD:video|25|100|NA|invalid']) options.onOutputLine(line, 'stderr');
    assert.equal(progress.length, before, 'malformed diagnostics do not overwrite valid job progress');
    for (const line of ['MW_DOWNLOAD:video|25|100|NA|downloading', 'MW_DOWNLOAD:video|50|100|NA|downloading', 'MW_DOWNLOAD:audio|25|100|NA|downloading', 'MW_DOWNLOAD:video|100|100|NA|finished', 'MW_DOWNLOAD:audio|100|100|NA|finished', 'MW_POSTPROCESS:started']) options.onOutputLine(line, 'stdout');
    return completeFile(workDir);
  };
  await downloadMedia(request, nativeTools, context);
  assert.deepEqual(progress.map(item => item.value), [0, .25, .5, .375, .625, .98, .98]);
  assert.deepEqual(stages, ['downloading', 'processing']);
  assert.match(progress[0].message!, /Connecting/);
  assert.match(progress.at(-1)!.message!, /Preparing the downloaded file/);
  assert.ok(progress.every(item => Number.isFinite(item.value) && item.value >= 0 && item.value <= .98));
});

test('unknown and estimated transfer sizes show received bytes and stay finite below completion', async t => {
  const { context, request, workDir } = await fixture(t);
  const progress: { value: number; message?: string }[] = [];
  context.onProgress = (value, message) => progress.push({ value, message });
  context.runTool = async (_binary, _args, options) => {
    for (const line of ['MW_DOWNLOAD:video|2097152|NA|NA|downloading', 'MW_DOWNLOAD:video|2097152|NA|4194304|downloading', 'MW_DOWNLOAD:video|9437184|NA|4194304|downloading']) options?.onOutputLine?.(line, 'stderr');
    return completeFile(workDir);
  };
  await downloadMedia(request, nativeTools, context);
  assert.deepEqual(progress.map(item => item.value), [0, 0, .5, .98]);
  assert.match(progress[1].message!, /2\.0 MB received/);
  assert.match(progress[2].message!, /estimated size/);
});

test('missing merged output retains bounded useful diagnostics without URL, path or credential details', async t => {
  const { context, request } = await fixture(t);
  context.runTool = async () => ({
    stdout: Buffer.from('MW_DOWNLOAD:video|100|100|NA|finished\n'),
    stderr: 'old diagnostic\n'.repeat(1000) + 'WARNING: ffmpeg not found; the separate streams could not be merged\nhttps://fixture.invalid/private?session=synthetic-secret\nC:\\private\\media\\synthetic-name.mp4\nAuthorization: synthetic-secret\nfinal observable diagnostic\n',
    exitCode: 0,
  });
  await assert.rejects(downloadMedia(request, nativeTools, context), error => {
    const message = (error as Error).message;
    assert.match(message, /did not produce a single complete media file/);
    assert.match(message, /ffmpeg not found/);
    assert.match(message, /final observable diagnostic/);
    assert.ok(message.length <= 1800);
    for (const secret of ['fixture.invalid', 'synthetic-secret', 'synthetic-name.mp4', 'MW_DOWNLOAD:']) assert.ok(!message.includes(secret), secret);
    return true;
  });
});

test('a max-filesize skip explains how to retry instead of reporting a generic incomplete output', async t => {
  const { context, request } = await fixture(t);
  context.runTool = async () => ({ stdout: Buffer.alloc(0), stderr: '[download] File is larger than max-filesize. Skipping.\n', exitCode: 0 });
  await assert.rejects(downloadMedia(request, nativeTools, context), /exceeds the file size limit.*Choose a smaller format/);
});

test('downloader native failures preserve exit status while redacting sensitive diagnostics', async t => {
  const { context, request } = await fixture(t);
  context.runTool = async () => { throw new Error('Native tool failed (17): ffmpeg merge failed\nhttps://fixture.invalid/video?token=synthetic-secret\nCookie: synthetic-secret\nfinal observable diagnostic'); };
  await assert.rejects(downloadMedia(request, nativeTools, context), error => {
    const message = (error as Error).message;
    assert.match(message, /^Native tool failed \(17\):/);
    assert.match(message, /ffmpeg merge failed/);
    assert.match(message, /final observable diagnostic/);
    assert.ok(!message.includes('fixture.invalid') && !message.includes('synthetic-secret'));
    assert.ok(message.length <= 1800);
    return true;
  });
});
