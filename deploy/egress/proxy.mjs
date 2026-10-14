import http from 'node:http';
import net from 'node:net';
import { Transform } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { createRequire } from 'node:module';
import { mkdir, chmod, unlink, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const ipaddr = createRequire(process.platform === 'win32' ? import.meta.url : '/app/package.json')('ipaddr.js');

function publicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === 'unicast';
  } catch { return false; }
}
async function addressesFor(hostname, signal) {
  if (signal.aborted) throw new Error('Operation cancelled');
  return new Promise((resolvePromise, reject) => {
    const finish = (error, addresses) => {
      clearTimeout(deadline); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolvePromise(addresses);
    };
    const abort = () => finish(new Error('Operation cancelled'));
    const deadline = setTimeout(() => finish(new Error('Site address lookup timed out')), 10000);
    signal.addEventListener('abort', abort, { once: true });
    lookup(hostname, { all: true, verbatim: true }).then(addresses => finish(undefined, addresses), () => finish(new Error('Site address lookup failed')));
    if (signal.aborted) abort();
  });
}
async function destination(raw, testOrigin, signal) {
  if (signal.aborted) throw new Error('Operation cancelled');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) without URL credentials is permitted.');
  if (testOrigin && url.origin === testOrigin) return { url, address: '127.0.0.1' };
  if (!['', '80', '443'].includes(url.port)) throw new Error('Only HTTP(S) standard ports are permitted.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await addressesFor(hostname, signal);
  if (signal.aborted) throw new Error('Operation cancelled');
  if (!addresses.length || addresses.some(address => !publicAddress(address.address))) throw new Error('Private or reserved destination rejected.');
  return { url, address: addresses[0].address };
}

/** One proxy per job. The socket volume is the worker's only outgoing network channel. */
export async function createUnixProxy({ socketPath, maxBytes = 500_000_000, bytesPerSecond = 50 * 1024 * 1024, testOrigin, onRejected, idleTimeoutMs = 20000 }) {
  const fixturePrefix = '\\\\.\\pipe\\media-workbench-fixture-';
  const fixturePipe = process.platform === 'win32' && !!testOrigin && typeof socketPath === 'string' && socketPath.startsWith(fixturePrefix) && /^[a-z0-9-]+$/.test(socketPath.slice(fixturePrefix.length));
  if (typeof socketPath !== 'string' || (!socketPath.startsWith('/proxy/') && !fixturePipe) || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error('Invalid private proxy configuration.');
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 1024) throw new Error('Invalid proxy bandwidth policy');
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) throw new Error('Invalid network timeout');
  if (!fixturePipe) {
    await mkdir(dirname(socketPath), { recursive: true });
    try {
      const previous = await lstat(socketPath);
      if (!previous.isSocket()) throw new Error('Proxy destination is not a socket.');
      await unlink(socketPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let transferred = 0, violation = '', nextAt = 0, stopped = false, closing;
  const sockets = new Set(), limiters = new Set(), controller = new AbortController();
  const pieceBytes = Math.max(1, Math.floor(bytesPerSecond / 10));
  const limiter = close => {
    let timer;
    const stream = new Transform({
      transform(chunk, _encoding, callback) {
        transferred += chunk.length;
        if (transferred > maxBytes) { violation = 'Transfer byte policy exceeded'; callback(new Error(violation)); return; }
        let offset = 0;
        const deliver = () => {
          while (offset < chunk.length) {
            const piece = chunk.subarray(offset, offset + pieceBytes); offset += piece.length;
            const now = performance.now(); nextAt = Math.max(now - 20, nextAt) + piece.length / bytesPerSecond * 1000;
            const delay = Math.max(0, nextAt - now);
            if (delay >= 1) {
              timer = setTimeout(() => { timer = undefined; if (!this.destroyed) { this.push(piece); deliver(); } }, delay);
              return;
            }
            this.push(piece);
          }
          callback();
        };
        deliver();
      },
      destroy(error, callback) { clearTimeout(timer); callback(error); }
    });
    limiters.add(stream); stream.on('error', close); stream.once('close', () => limiters.delete(stream));
    return stream;
  };
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const server = http.createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (request, response) => {
    try {
      if (violation) throw new Error(violation);
      const { url, address } = await destination(request.url || '', testOrigin, controller.signal);
      if (stopped || request.destroyed || response.destroyed) return;
      if (url.protocol !== 'http:' || !['GET', 'HEAD', 'POST', 'OPTIONS'].includes(request.method || '')) throw new Error('Unsupported proxy operation.');
      const headers = { ...request.headers, host: url.host, connection: 'close' };
      delete headers['proxy-authorization']; delete headers['proxy-connection']; delete headers.upgrade;
      let inbound, outbound, timedOut = false;
      const close = () => { upstream.destroy(); inbound?.destroy(); outbound?.destroy(); if (!response.destroyed) response.destroy(); };
      const upstream = http.request({ hostname: address, port: Number(url.port) || 80, method: request.method, path: url.pathname + url.search, headers, timeout: idleTimeoutMs, agent: false }, remote => {
        if (stopped || response.destroyed) { remote.destroy(); return; }
        response.writeHead(remote.statusCode || 502, remote.headers);
        inbound = limiter(close);
        remote.on('pause', () => upstream.setTimeout(0)); remote.on('resume', () => upstream.setTimeout(idleTimeoutMs));
        remote.once('aborted', close); remote.on('error', close); response.once('close', close);
        remote.pipe(inbound).pipe(response);
      });
      upstream.on('socket', track);
      upstream.once('timeout', () => { timedOut = true; upstream.destroy(new Error('Upstream timed out')); });
      upstream.on('error', () => {
        inbound?.destroy(); outbound?.destroy();
        if (response.destroyed) return;
        if (response.headersSent) response.destroy();
        else { response.writeHead(timedOut ? 504 : 502); response.end(timedOut ? 'Network upstream timed out' : 'Network upstream connection failed'); }
      });
      outbound = limiter(close);
      request.once('aborted', close); request.on('error', close);
      response.once('close', () => { upstream.destroy(); outbound?.destroy(); });
      request.pipe(outbound).pipe(upstream);
    } catch {
      onRejected?.();
      if (!response.destroyed) { response.writeHead(403, { 'content-type': 'text/plain', connection: 'close' }); response.end('Network destination blocked'); }
    }
  });
  server.maxConnections = 32;
  server.on('connection', socket => { track(socket); socket.on('error', () => {}); socket.setTimeout(120000, () => socket.destroy()); });
  server.on('connect', async (request, client, head) => {
    try {
      if (violation) throw new Error(violation);
      const { url, address } = await destination('https://' + request.url + '/', testOrigin, controller.signal);
      if (stopped || client.destroyed) return;
      const upstream = track(net.connect({ host: address, port: Number(url.port) || 443 })); track(client);
      let inbound, outbound, closed = false;
      const close = () => {
        if (closed) return; closed = true;
        upstream.destroy(); client.destroy(); inbound?.destroy(); outbound?.destroy();
      };
      upstream.setTimeout(idleTimeoutMs, close); client.setTimeout(120000, close);
      upstream.on('pause', () => upstream.setTimeout(0)); upstream.on('resume', () => upstream.setTimeout(idleTimeoutMs));
      client.on('pause', () => client.setTimeout(0)); client.on('resume', () => client.setTimeout(120000));
      upstream.on('error', close); client.on('error', close); client.once('close', close);
      upstream.once('close', hadError => { if (hadError || !upstream.readableEnded) close(); });
      upstream.once('connect', () => {
        if (stopped || client.destroyed) { close(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        inbound = limiter(close); outbound = limiter(close);
        if (head.length) outbound.write(head);
        upstream.pipe(inbound).pipe(client); client.pipe(outbound).pipe(upstream);
      });
    } catch { onRejected?.(); if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  const close = () => {
    if (closing) return closing;
    stopped = true; controller.abort();
    for (const socket of sockets) socket.destroy();
    for (const stream of limiters) stream.destroy();
    closing = new Promise(resolvePromise => server.close(() => resolvePromise())).then(() => fixturePipe ? undefined : unlink(socketPath).catch(() => {}));
    return closing;
  };
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.removeListener('error', reject); resolvePromise(); });
    });
    if (!fixturePipe) await chmod(socketPath, 0o666);
    return { get transferred() { return transferred; }, get violation() { return violation; }, close };
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const proxy = await createUnixProxy({ socketPath: process.env.MW_PROXY_SOCKET || '/proxy/egress.sock', maxBytes: Number(process.env.MW_PROXY_MAX_BYTES || 500_000_000), bytesPerSecond: Number(process.env.MW_PROXY_BYTES_PER_SECOND || 50 * 1024 * 1024) });
  process.stdout.write(JSON.stringify({ event: 'egress-ready' }) + '\n');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await proxy.close(); process.exit(0); });
}
