import http from 'node:http';
import net from 'node:net';
import { Transform, type Duplex } from 'node:stream';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { ByteRateBudget, createRateLimitedStream } from './rate.ts';

export function isPublicAddress(address: string) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    return parsed.range() === 'unicast';
  } catch { return false; }
}

function checkCancellation(signal?: AbortSignal) {
  if (signal?.aborted) throw Error('Operation cancelled');
}

async function resolveAddresses(hostname: string, signal?: AbortSignal): Promise<LookupAddress[]> {
  checkCancellation(signal);
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, addresses?: LookupAddress[]) => {
      clearTimeout(deadline); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(addresses!);
    };
    const abort = () => finish(Error('Operation cancelled'));
    const deadline = setTimeout(() => finish(Error('Site address lookup timed out. Check the link and try again.')), 10000);
    signal?.addEventListener('abort', abort, { once: true });
    lookup(hostname, { all: true, verbatim: true }).then(addresses => finish(undefined, addresses), () => finish(Error('The site address could not be resolved. Check the link and try again.')));
    if (signal?.aborted) abort();
  });
}

export async function validateDestination(raw: string, allowedSites: string[] = [], testOrigin?: string, signal?: AbortSignal) {
  checkCancellation(signal);
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Only HTTP(S) URLs without embedded credentials are allowed');
  if (testOrigin && url.origin === testOrigin) return { url, address: '127.0.0.1' };
  if (!['', '80', '443'].includes(url.port)) throw Error('Only public HTTP(S) ports are allowed');
  if (allowedSites.length && !allowedSites.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw Error('Site is not permitted by host policy');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await resolveAddresses(hostname, signal);
  checkCancellation(signal);
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw Error('Private, reserved, loopback and link-local destinations are blocked');
  return { url, address: addresses[0].address };
}

type ProxyOptions = { idleTimeoutMs?: number };

/** Pins every downloader connection to a validated DNS result; shared mode also isolates worker egress. */
export async function createEgressProxy(maxBytes: number, signal: AbortSignal, testOrigin?: string, bytesPerSecond = 50 * 1024 * 1024, options: ProxyOptions = {}) {
  checkCancellation(signal);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) throw Error('Invalid network transfer limits');
  const idleTimeoutMs = options.idleTimeoutMs ?? 20000;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) throw Error('Invalid network timeout');
  const sockets = new Set<Duplex>(), streams = new Set<Transform>();
  const budget = new ByteRateBudget(bytesPerSecond);
  let bytes = 0, violation = '', stopped = false;
  const limit = (close: () => void) => {
    const stream = createRateLimitedStream(budget, size => {
      bytes += size;
      if (bytes > maxBytes) { violation = 'Download transfer exceeded byte policy'; return Error(violation); }
    });
    streams.add(stream); stream.on('error', close); stream.once('close', () => streams.delete(stream));
    return stream;
  };
  const server = http.createServer(async (request, response) => {
    try {
      const { url, address } = await validateDestination(request.url || '', [], testOrigin, signal);
      if (stopped || request.destroyed || response.destroyed) return;
      if (violation) throw Error(violation);
      if (url.protocol !== 'http:' || !['GET', 'HEAD', 'POST', 'OPTIONS'].includes(request.method || '')) throw Error('Unsupported proxy operation');
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host };
      delete headers['proxy-connection']; delete headers['proxy-authorization'];
      let inbound: Transform | undefined, outbound: Transform | undefined, timedOut = false;
      const close = () => { upstream.destroy(); inbound?.destroy(); outbound?.destroy(); if (!response.destroyed) response.destroy(); };
      const upstream = http.request({ hostname: address, port: url.port || 80, method: request.method, path: url.pathname + url.search, headers, timeout: idleTimeoutMs, agent: false }, remote => {
        if (stopped || response.destroyed) { remote.destroy(); return; }
        response.writeHead(remote.statusCode || 502, remote.headers);
        inbound = limit(close);
        remote.on('pause', () => upstream.setTimeout(0));
        remote.on('resume', () => upstream.setTimeout(idleTimeoutMs));
        remote.once('aborted', close); remote.on('error', close); response.once('close', close);
        remote.pipe(inbound).pipe(response);
      });
      upstream.on('socket', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
      upstream.once('timeout', () => { timedOut = true; upstream.destroy(Error('Upstream timed out')); });
      upstream.on('error', () => {
        inbound?.destroy(); outbound?.destroy();
        if (response.destroyed) return;
        if (response.headersSent) response.destroy();
        else { response.writeHead(timedOut ? 504 : 502); response.end(timedOut ? 'Network upstream timed out' : 'Network upstream connection failed'); }
      });
      outbound = limit(close);
      request.once('aborted', close); request.on('error', close);
      response.once('close', () => { upstream.destroy(); outbound?.destroy(); });
      request.pipe(outbound).pipe(upstream);
    } catch {
      if (!response.destroyed) { response.writeHead(403); response.end('Network destination blocked'); }
    }
  });
  server.on('connect', async (request, client, head) => {
    try {
      if (violation) throw Error(violation);
      const { url, address } = await validateDestination(`https://${request.url}/`, [], testOrigin, signal);
      if (stopped || client.destroyed) return;
      const upstream = net.connect({ host: address, port: Number(url.port) || 443 });
      sockets.add(upstream); sockets.add(client);
      let inbound: Transform | undefined, outbound: Transform | undefined, closed = false;
      const close = () => {
        if (closed) return; closed = true;
        upstream.destroy(); client.destroy(); inbound?.destroy(); outbound?.destroy(); sockets.delete(upstream); sockets.delete(client);
      };
      upstream.once('connect', () => {
        if (stopped || client.destroyed) { close(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        inbound = limit(close); outbound = limit(close);
        if (head.length) outbound.write(head);
        upstream.pipe(inbound).pipe(client); client.pipe(outbound).pipe(upstream);
      });
      upstream.on('error', close); client.on('error', close); client.once('close', close);
      upstream.once('close', hadError => { if (hadError || !upstream.readableEnded) close(); });
      upstream.on('pause', () => upstream.setTimeout(0));
      upstream.on('resume', () => upstream.setTimeout(idleTimeoutMs));
      upstream.setTimeout(idleTimeoutMs, close);
    } catch { if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const stop = () => {
    stopped = true;
    for (const socket of sockets) socket.destroy();
    for (const stream of streams) stream.destroy();
    if (server.listening) server.close();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    checkCancellation(signal);
    return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, get violation() { return violation; }, close: () => { signal.removeEventListener('abort', stop); stop(); } };
  } catch (error) { signal.removeEventListener('abort', stop); stop(); throw error; }
}
