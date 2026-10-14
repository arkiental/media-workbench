import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { createEgressProxy } from '../apps/server/src/network.ts';

async function fixture(t: TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function get(proxy: string, target: string, timeoutMs = 1000) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(proxy);
    const request = http.get({ hostname: url.hostname, port: url.port, path: target }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('aborted', () => reject(Error('Response aborted')));
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    });
    const deadline = setTimeout(() => { request.destroy(); reject(Error('Proxy response exceeded fixture deadline')); }, timeoutMs);
    request.on('error', reject);
    request.once('close', () => clearTimeout(deadline));
  });
}

test('pre-cancelled and startup-cancelled egress proxies do not return a live listener', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    if (before) controller.abort();
    const operation = createEgressProxy(1024, controller.signal);
    if (!before) controller.abort();
    await assert.rejects(operation.then(proxy => { proxy.close(); return proxy; }), /cancelled|aborted/i);
  }
});

test('truncated upstream responses close the downstream promptly instead of hanging until a downloader timeout', { timeout: 5000 }, async t => {
  const origin = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 100 });
    response.flushHeaders(); response.write('partial');
    setTimeout(() => response.destroy(), 25);
  });
  const proxy = await createEgressProxy(1024, new AbortController().signal, origin);
  t.after(() => proxy.close());
  await assert.rejects(get(proxy.url, origin), /aborted|reset|closed/i);
});

test('closing a proxy during a throttled response closes its client and upstream', { timeout: 5000 }, async t => {
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const origin = await fixture(t, (_request, response) => {
    response.on('close', disconnected);
    response.writeHead(200, { 'content-length': 4096 }); response.write(Buffer.alloc(2048));
  });
  const controller = new AbortController();
  const proxy = await createEgressProxy(8192, controller.signal, origin, 1024);
  t.after(() => proxy.close());
  const pending = get(proxy.url, origin);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /aborted|reset|closed|hang up/i);
  await closed;
});

test('a silent upstream has a bounded idle timeout and a clear gateway response', { timeout: 5000 }, async t => {
  const origin = await fixture(t, () => {});
  const proxy = await createEgressProxy(8192, new AbortController().signal, origin, 8192, { idleTimeoutMs: 50 });
  t.after(() => proxy.close());
  const result = await get(proxy.url, origin);
  assert.equal(result.status, 504); assert.equal(result.body, 'Network upstream timed out');
});

test('rate-limited HTTP bodies deliver steady activity without triggering a client idle timeout', { timeout: 5000 }, async t => {
  const body = Buffer.alloc(4096, 97);
  const origin = await fixture(t, (_request, response) => response.end(body));
  const proxy = await createEgressProxy(8192, new AbortController().signal, origin, 4096);
  t.after(() => proxy.close());
  const received = await new Promise<Buffer>((resolve, reject) => {
    const url = new URL(proxy.url), chunks: Buffer[] = [];
    const request = http.get({ hostname: url.hostname, port: url.port, path: origin }, response => {
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.setTimeout(250, () => request.destroy(Error('Healthy transfer exceeded the client idle timeout')));
    request.on('error', reject);
  });
  assert.deepEqual(received, body);
});

test('intentional bandwidth backpressure is not mistaken for a silent upstream', { timeout: 5000 }, async t => {
  const body = Buffer.alloc(96 * 1024, 99);
  const origin = await fixture(t, (_request, response) => response.end(body));
  const proxy = await createEgressProxy(128 * 1024, new AbortController().signal, origin, 64 * 1024, { idleTimeoutMs: 250 });
  t.after(() => proxy.close());
  const result = await get(proxy.url, origin, 3000);
  assert.equal(result.status, 200); assert.equal(Buffer.byteLength(result.body), body.length);
});

test('a CONNECT tunnel drains its complete throttled body after a normal upstream close', { timeout: 5000 }, async t => {
  const body = Buffer.alloc(1024, 98);
  const fixture = net.createServer(socket => socket.end(body));
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const target = `127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  const proxy = await createEgressProxy(4096, new AbortController().signal, `https://${target}`, 2048);
  t.after(() => proxy.close());
  const received = await new Promise<Buffer>((resolve, reject) => {
    const url = new URL(proxy.url);
    const request = http.request({ hostname: url.hostname, port: url.port, method: 'CONNECT', path: target });
    request.on('connect', (response, socket, head) => {
      assert.equal(response.statusCode, 200);
      const chunks = [head];
      socket.setTimeout(2000, () => socket.destroy(Error('CONNECT body exceeded fixture deadline')));
      socket.on('data', chunk => chunks.push(chunk)); socket.on('error', reject);
      socket.on('end', () => { socket.destroy(); resolve(Buffer.concat(chunks)); });
    });
    request.on('error', reject); request.end();
  });
  assert.deepEqual(received, body);
});
