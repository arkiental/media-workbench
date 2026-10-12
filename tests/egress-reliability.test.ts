import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

const windows = { skip: process.platform !== 'win32', timeout: 5000 };
const modulePath = '../deploy/egress/proxy.mjs';
type Proxy = { violation: string; transferred: number; close: () => Promise<void> };
type Options = { socketPath: string; testOrigin?: string; bytesPerSecond?: number; maxBytes?: number; idleTimeoutMs?: number };

async function fixture(t: TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}
async function proxy(t: TestContext, origin: string, options: Partial<Options> = {}) {
  const create: (options: Options) => Promise<Proxy> = (await import(modulePath)).createUnixProxy;
  const socketPath = '\\\\.\\pipe\\media-workbench-fixture-' + randomUUID();
  const instance = await create({ socketPath, testOrigin: origin, ...options });
  t.after(() => instance.close());
  return { socketPath, instance };
}
function get(socketPath: string, target: string, timeoutMs = 3000, idleTimeoutMs = 0) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const request = http.get({ socketPath, path: target }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('aborted', () => reject(Error('Response aborted'))); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks) }));
    });
    const deadline = setTimeout(() => request.destroy(Error('Egress fixture deadline exceeded')), timeoutMs);
    if (idleTimeoutMs) request.setTimeout(idleTimeoutMs, () => request.destroy(Error('Healthy transfer exceeded client idle timeout')));
    request.on('error', reject); request.once('close', () => clearTimeout(deadline));
  });
}

test('standalone proxy keeps production socket validation when Windows fixture support is present', windows, async () => {
  const create: (options: Options) => Promise<Proxy> = (await import(modulePath)).createUnixProxy;
  await assert.rejects(create({ socketPath: '\\\\.\\pipe\\media-workbench-fixture-' + randomUUID() }), /Invalid private proxy configuration/);
  await assert.rejects(create({ socketPath: 'C:\\unrelated.sock', testOrigin: 'http://127.0.0.1:1' }), /Invalid private proxy configuration/);
});

test('standalone socket proxy paces a healthy body without exceeding its rate or client idle limit', windows, async t => {
  const body = Buffer.alloc(4096, 97), origin = await fixture(t, (_request, response) => response.end(body));
  const { socketPath } = await proxy(t, origin, { bytesPerSecond: 4096 });
  const start = performance.now(), result = await get(socketPath, origin, 3000, 250);
  assert.equal(result.status, 200); assert.deepEqual(result.body, body);
  assert(performance.now() - start >= 900, 'steady activity must retain the configured rate');
});

test('standalone socket proxy shares its rate across simultaneous responses and fails closed at its byte ceiling', windows, async t => {
  const body = Buffer.alloc(4096), origin = await fixture(t, (_request, response) => response.end(body));
  const shared = await proxy(t, origin, { bytesPerSecond: 8192 });
  const start = performance.now(), results = await Promise.all([get(shared.socketPath, origin), get(shared.socketPath, origin)]);
  results.forEach(result => assert.deepEqual(result.body, body));
  assert(performance.now() - start >= 900, 'parallel streams share one proxy budget');
  const limited = await proxy(t, origin, { maxBytes: 1024 });
  await assert.rejects(get(limited.socketPath, origin), /aborted|reset|hang up|closed/i);
  assert.match(limited.instance.violation, /byte policy/);
  assert.equal((await get(limited.socketPath, origin)).status, 403);
});

test('standalone socket proxy closes truncated responses promptly', windows, async t => {
  const origin = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 100 }); response.flushHeaders(); response.write('partial');
    setTimeout(() => response.destroy(), 25);
  });
  const { socketPath } = await proxy(t, origin);
  await assert.rejects(get(socketPath, origin, 1000), /aborted|reset|hang up|closed/i);
});

test('standalone socket proxy bounds silent upstreams while allowing intentional bandwidth backpressure', windows, async t => {
  const silent = await fixture(t, () => {}), timeout = await proxy(t, silent, { idleTimeoutMs: 50 });
  const failure = await get(timeout.socketPath, silent);
  assert.equal(failure.status, 504); assert.equal(failure.body.toString(), 'Network upstream timed out');
  const body = Buffer.alloc(96 * 1024), origin = await fixture(t, (_request, response) => response.end(body));
  const paced = await proxy(t, origin, { bytesPerSecond: 64 * 1024, idleTimeoutMs: 250 });
  assert.deepEqual((await get(paced.socketPath, origin)).body, body);
});

test('standalone socket proxy cleanup stops active streams and is safe to call twice', windows, async t => {
  const origin = await fixture(t, (_request, response) => { response.writeHead(200, { 'content-length': 4096 }); response.write(Buffer.alloc(2048)); });
  const { socketPath, instance } = await proxy(t, origin, { bytesPerSecond: 1024 });
  const pending = get(socketPath, origin, 1000);
  const rejected = assert.rejects(pending, /aborted|reset|hang up|closed/i);
  setTimeout(() => void instance.close(), 50);
  await rejected; await instance.close(); await instance.close();
});

test('standalone socket proxy validates redirected connections and never reaches an unrelated private origin', windows, async t => {
  let forbiddenHits = 0;
  const forbidden = await fixture(t, (_request, response) => { forbiddenHits++; response.end('private sentinel'); });
  const origin = await fixture(t, (_request, response) => { response.writeHead(302, { location: forbidden }); response.end(); });
  const { socketPath } = await proxy(t, origin);
  assert.equal((await get(socketPath, origin)).status, 302);
  assert.equal((await get(socketPath, forbidden)).status, 403); assert.equal(forbiddenHits, 0);
});

test('standalone CONNECT drains throttled bytes after a normal upstream FIN', windows, async t => {
  const body = Buffer.alloc(1024, 98), server = net.createServer(socket => socket.end(body));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const target = '127.0.0.1:' + (server.address() as AddressInfo).port;
  const { socketPath } = await proxy(t, 'https://' + target, { bytesPerSecond: 2048 });
  const received = await new Promise<Buffer>((resolve, reject) => {
    const request = http.request({ socketPath, method: 'CONNECT', path: target });
    request.on('connect', (response, socket, head) => {
      assert.equal(response.statusCode, 200); const chunks = [head];
      socket.setTimeout(2000, () => socket.destroy(Error('CONNECT fixture deadline exceeded')));
      socket.on('data', chunk => chunks.push(chunk)); socket.on('error', reject);
      socket.on('end', () => { socket.destroy(); resolve(Buffer.concat(chunks)); });
    });
    request.on('error', reject); request.end();
  });
  assert.deepEqual(received, body);
});
