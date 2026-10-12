import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectDownload, downloadMedia, type DownloadContext } from '../apps/server/src/download.ts';
import { defaultPolicy } from '../packages/core/src/policy.ts';
import type { ToolPaths } from '../packages/contracts/src/index.ts';

const tools: ToolPaths = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ytdlp: 'yt-dlp', node: process.execPath };
const media = { id: 'fixture', title: 'Fixture', duration: 1, formats: [{ format_id: 'video', ext: 'mp4' }] };

async function context(t: TestContext, handler: http.RequestListener = (_request, response) => response.end('fixture')) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const workDir = await mkdtemp(path.join(tmpdir(), 'mw-download-reliability-'));
  const controller = new AbortController();
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert(path.resolve(workDir).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(workDir, { recursive: true, force: true });
  });
  const ctx: DownloadContext = { workDir, signal: controller.signal, maxRuntimeSeconds: 5, policy: defaultPolicy('owner'), testOrigin: origin };
  return { request: { url: origin + '/video', preference: 'original' as const }, ctx, controller };
}

test('empty or malformed inspection metadata fails clearly instead of returning an empty success or raw parser error', async t => {
  for (const value of ['not json', 'null', '[]', '{"entries":[]}', '{"entries":"unexpected"}']) {
    await t.test(value, async child => {
      const { request, ctx } = await context(child);
      ctx.runTool = async () => ({ stdout: Buffer.from(value), stderr: '', exitCode: 0 });
      await assert.rejects(inspectDownload(request, tools, ctx), /media details|media was found|media metadata/i);
    });
  }
});

test('optional thumbnail failure cannot convert a cancelled inspection into success', async t => {
  const { request, ctx, controller } = await context(t);
  ctx.runTool = async (_binary, args) => {
    if (args.includes('--dump-single-json')) return { stdout: Buffer.from(JSON.stringify(media)), stderr: '', exitCode: 0 };
    controller.abort(); throw Error('Operation cancelled');
  };
  await assert.rejects(inspectDownload(request, tools, ctx), /cancelled|aborted/i);
});

test('malformed optional format fields do not crash an otherwise valid inspection', async t => {
  const { request, ctx } = await context(t);
  ctx.runTool = async (_binary, args) => ({ stdout: args.includes('--dump-single-json') ? Buffer.from(JSON.stringify({ ...media, formats: {} })) : Buffer.alloc(0), stderr: '', exitCode: 0 });
  const result = await inspectDownload(request, tools, ctx);
  assert.equal(result.entries.length, 1); assert.deepEqual(result.entries[0].formats, []);
});

test('unexpected optional metadata values cannot escape as objects or invalid numeric display fields', async t => {
  const { request, ctx } = await context(t);
  const data = { ...media, title: {}, duration: {}, formats: [null, [], 'unexpected', { format_id: {} }, { format_id: 'valid', ext: {}, width: '1920', height: 720, fps: -5, vcodec: {}, acodec: 'aac' }] };
  ctx.runTool = async (_binary, args) => ({ stdout: args.includes('--dump-single-json') ? Buffer.from(JSON.stringify(data)) : Buffer.alloc(0), stderr: '', exitCode: 0 });
  const result = await inspectDownload(request, tools, ctx);
  assert.equal(result.title, 'Media'); assert.equal(result.duration, null);
  const [format] = result.entries[0].formats;
  assert.equal(result.entries[0].formats.length, 1); assert.equal(format.id, 'valid');
  assert.equal(format.height, 720); assert.equal(format.acodec, 'aac');
  for (const key of ['ext', 'width', 'fps', 'vcodec'] as const) assert.equal(format[key], undefined);
});

test('a missing optional thumbnail preserves usable inspected media', async t => {
  const { request, ctx } = await context(t);
  ctx.runTool = async (_binary, args) => {
    if (args.includes('--dump-single-json')) return { stdout: Buffer.from(JSON.stringify(media)), stderr: '', exitCode: 0 };
    throw Error('Thumbnail unavailable');
  };
  const result = await inspectDownload(request, tools, ctx);
  assert.equal(result.entries[0].formats[0].id, 'video'); assert.equal(result.thumbnail, undefined);
});

test('an empty completed filename cannot be reported as a successful download', async t => {
  const { request, ctx } = await context(t);
  ctx.runTool = async () => { await writeFile(path.join(ctx.workDir, 'download.mp4'), Buffer.alloc(0)); return { stdout: Buffer.alloc(0), stderr: '', exitCode: 0 }; };
  await assert.rejects(downloadMedia(request, tools, ctx), /downloaded file is empty.*Inspect the link/i);
});

test('byte-policy violations retain their clear cause when the downloader also reports a native network error', async t => {
  const { request, ctx } = await context(t, (_request, response) => response.end(Buffer.alloc(4096)));
  ctx.policy = { ...ctx.policy, maxInputBytes: 1024, maxTransferBytes: 1024 };
  ctx.runTool = async (_binary, args) => {
    const url = new URL(args[args.indexOf('--proxy') + 1]);
    await new Promise<void>(resolve => {
      const req = http.get({ hostname: url.hostname, port: url.port, path: request.url }, response => {
        response.resume(); response.on('aborted', resolve); response.on('error', resolve); response.on('end', resolve);
      }); req.on('error', () => resolve());
    });
    throw Error('Native tool failed (1): connection reset');
  };
  await assert.rejects(downloadMedia(request, tools, ctx), /transfer exceeded byte policy/i);
});
