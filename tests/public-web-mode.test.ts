import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerOptions } from '../apps/server/src/app.ts';
import { IsolatedWorker } from '../apps/server/src/worker.ts';
import { JobRequestSchema, PolicySchema, type Artifact, type ExecutionContext, type Source } from '../packages/contracts/src/index.ts';
import { defaultPolicy } from '../packages/core/src/policy.ts';

const publicOrigin = 'https://workbench.example.com';
const publicHeaders = { host: 'workbench.example.com', origin: publicOrigin };
const workerConfig = {
  image: 'sha256:' + 'a'.repeat(64),
  proxyPath: path.resolve('deploy/egress/proxy.mjs'),
  relayPath: path.resolve('deploy/egress/relay.mjs')
};
const present = (file: string) => access(file).then(() => true, () => false);

test('public hosting rejects incomplete or anonymous configurations before creating storage', async () => {
  const output = path.resolve('test-output/public-web');
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'configuration-'));
  const complete = { shared: true, host: '127.0.0.1', ownerToken: randomUUID(), publicOrigin, workerConfig };
  const cases: Array<{ change: Partial<ServerOptions>; error: RegExp }> = [
    { change: { workerConfig: undefined }, error: /shared hosting is disabled/i },
    { change: { ownerToken: undefined }, error: /shared hosting is disabled/i },
    { change: { publicOrigin: undefined }, error: /shared hosting is disabled/i },
    { change: { publicOrigin: 'http://workbench.example.com' }, error: /shared hosting is disabled/i },
    { change: { publicOrigin: publicOrigin + '/app' }, error: /bare HTTPS origin/i },
    { change: { publicOrigin: 'https://owner:password@workbench.example.com' }, error: /bare HTTPS origin/i },
    { change: { testOrigin: 'http://127.0.0.1:8000' }, error: /shared hosting is disabled/i },
    { change: { workerConfig: { ...workerConfig, proxyPath: undefined } }, error: /mandatory proxy/i },
    { change: { workerConfig: { ...workerConfig, proxyVolume: 'unfiltered-proxy' } }, error: /mandatory proxy/i },
    { change: { tunnelPrototype: true }, error: /shared hosting.*tunnel/i },
    { change: { shared: false, host: '0.0.0.0' }, error: /shared hosting is disabled/i }
  ];
  for (const [index, entry] of cases.entries()) {
    const dataDir = path.join(root, String(index));
    await assert.rejects(createServer({ ...complete, ...entry.change, dataDir }), entry.error);
    assert.equal(await present(dataDir), false, 'rejected configuration must not create a workspace or owner credential');
  }
});

test('invite-only shared controller enforces session, user, quota and host boundaries', { timeout: 30000 }, async t => {
  const output = path.resolve('test-output/public-web');
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, 'controller-'));
  const dataDir = path.join(root, 'hosting-data');
  const localSentinel = path.join(root, 'desktop-private-media');
  await writeFile(localSentinel, 'local owner media must remain separate');
  let mediaRuns = 0;
  // These tests exercise controller authorization, not Docker isolation or codecs.
  t.mock.method(IsolatedWorker.prototype, 'recover', async () => {});
  t.mock.method(IsolatedWorker.prototype, 'context', async (ctx: ExecutionContext) => ({
    ...ctx,
    runTool: async (_binary: string, args: string[]) => {
      if (!['--version', '-version'].includes(args[0])) mediaRuns++;
      throw Error('Native execution is disabled in the controller boundary fixture');
    }
  }));
  const ownerToken = randomUUID();
  const desktopSecret = randomUUID();
  const app = await createServer({
    dataDir, ownerToken, desktopSecret, shared: true, host: '127.0.0.1', publicOrigin,
    workerConfig, startQueue: false, encoders: [],
    tools: { ffmpeg: 'fixture-ffmpeg', ffprobe: 'fixture-ffprobe', ytdlp: 'fixture-ytdlp', node: 'fixture-node' }
  });
  const headers = (token: string) => ({ ...publicHeaders, authorization: `Bearer ${token}` });
  const owner = app.store.users().find(user => user.role === 'owner')!;
  const member = app.store.createUser('Invited member', 'member');
  const other = app.store.createUser('Other invited member', 'member');
  const memberToken = app.store.token(member.id, 'Fixture member').token;
  const otherToken = app.store.token(other.id, 'Fixture other member').token;
  const fixture = async (ownerId: string) => {
    const artifact: Artifact = {
      id: randomUUID(), ownerId, name: 'private.mp4', bytes: 8,
      media: { duration: 1, startTime: 0, size: 8, format: 'mp4', hdr: false, streams: [{ index: 0, type: 'video', codec: 'h264', width: 32, height: 32 }] },
      kind: 'original', createdAt: new Date().toISOString(), pinned: false, validated: true
    };
    await writeFile(path.join(dataDir, 'artifacts', artifact.id), 'SENTINEL');
    app.store.put('artifact', artifact.id, ownerId, artifact);
    const source: Source = { id: randomUUID(), ownerId, artifactId: artifact.id, name: artifact.name, createdAt: artifact.createdAt };
    app.store.put('source', source.id, ownerId, source);
    return { artifact, source };
  };
  const ownerMedia = await fixture(owner.id);
  const memberMedia = await fixture(member.id);
  const memberJob = app.store.submit(member.id, JobRequestSchema.parse({ type: 'proxy', sourceId: memberMedia.source.id }), randomUUID()).job;
  try {
    await t.test('anonymous callers cannot pair themselves, register users or read media', async () => {
      for (const url of ['/api/v1/capabilities', '/api/v1/sources', '/api/v1/artifacts', '/api/v1/jobs', '/api/v1/events', '/api/v1/admin/users', `/api/v1/artifacts/${ownerMedia.artifact.id}/content`]) {
        assert.equal((await app.inject({ url, headers: publicHeaders })).statusCode, 401, url);
      }
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: publicHeaders, payload: { name: 'Uninvited', role: 'member' } })).statusCode, 401);
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/session', headers: publicHeaders, payload: { token: 'unissued' } })).statusCode, 401);
      assert.equal(app.store.users().length, 3);
    });
    await t.test('HTTPS session cookies work only for their user and revocation invalidates them', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/v1/session', headers: publicHeaders, payload: { token: memberToken } });
      assert.equal(response.statusCode, 200, response.body);
      const setCookie = String(response.headers['set-cookie']);
      assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /Secure/i); assert.match(setCookie, /SameSite=Strict/i);
      const cookie = setCookie.split(';')[0];
      const capabilities = await app.inject({ url: '/api/v1/capabilities', headers: { ...publicHeaders, cookie } });
      assert.equal(capabilities.json().user.id, member.id);
      assert.equal(capabilities.json().mode, 'shared');
      const foreignOrigin = await app.inject({ method: 'POST', url: '/api/v1/pairings', headers: { ...publicHeaders, cookie, origin: 'https://attacker.example.com' }, payload: { name: 'Unwanted', scopes: ['read'] } });
      assert.equal(foreignOrigin.statusCode, 403);
      const fresh = app.store.token(member.id, 'Revocation fixture');
      const paired = await app.inject({ method: 'POST', url: '/api/v1/session', headers: publicHeaders, payload: { token: fresh.token } });
      app.store.revoke(member.id, fresh.id);
      assert.equal((await app.inject({ url: '/api/v1/jobs', headers: { ...publicHeaders, cookie: String(paired.headers['set-cookie']).split(';')[0] } })).statusCode, 401);
    });
    await t.test('owner and other members cannot enumerate or access member media, jobs or previews', async () => {
      for (const token of [ownerToken, otherToken]) {
        for (const url of [`/api/v1/artifacts/${memberMedia.artifact.id}/content`, `/api/v1/artifacts/${memberMedia.artifact.id}/thumbnail`, `/api/v1/sources/${memberMedia.source.id}/frames?around=0`, `/api/v1/sources/${memberMedia.source.id}/waveform`, `/api/v1/jobs/${memberJob.id}`]) {
          assert.equal((await app.inject({ url, headers: headers(token) })).statusCode, 404, url);
        }
        for (const url of ['/api/v1/sources', '/api/v1/artifacts', '/api/v1/jobs', '/api/v1/events']) {
          const response = await app.inject({ url, headers: headers(token) });
          assert.equal(response.statusCode, 200);
          assert.equal(response.body.includes(memberMedia.artifact.id), false);
          assert.equal(response.body.includes(memberMedia.source.id), false);
          assert.equal(response.body.includes(memberJob.id), false);
        }
        assert((await app.inject({ method: 'POST', url: `/api/v1/jobs/${memberJob.id}/cancel`, headers: headers(token) })).statusCode >= 400);
      }
      assert.equal((await app.inject({ url: `/api/v1/artifacts/${ownerMedia.artifact.id}/content`, headers: headers(memberToken) })).statusCode, 404);
      assert.equal(app.store.job(memberJob.id)!.state, 'queued');
    });
    await t.test('shared owner and members cannot use host credentials, native paths or destinations', async () => {
      for (const token of [ownerToken, memberToken]) {
        for (const url of ['/api/v1/cookies', `/api/v1/desktop/artifacts/${ownerMedia.artifact.id}`]) {
          assert.equal((await app.inject({ url, headers: { ...headers(token), 'x-desktop-secret': desktopSecret } })).statusCode, 403);
        }
        assert.equal((await app.inject({ method: 'POST', url: '/api/v1/cookies/browser', headers: headers(token), payload: { browser: 'chrome', profile: localSentinel } })).statusCode, 403);
        assert.equal((await app.inject({ method: 'POST', url: '/api/v1/desktop/download-folder', headers: { ...headers(token), 'x-desktop-secret': desktopSecret }, payload: { path: root } })).statusCode, 403);
        for (const download of [{ url: 'https://example.com/media.mp4', destinationId: randomUUID() }, { url: 'https://example.com/media.mp4', cookieId: randomUUID() }]) {
          assert.equal((await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: { ...headers(token), 'idempotency-key': randomUUID() }, payload: { type: 'download', download } })).statusCode, 403);
        }
      }
      assert.equal((await app.inject({ url: '/api/v1/admin/users', headers: headers(memberToken) })).statusCode, 403);
      assert.equal((await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: headers(memberToken), payload: { concurrency: 4 } })).statusCode, 403);
      assert.equal(await readFile(localSentinel, 'utf8'), 'local owner media must remain separate');
    });
    await t.test('bounded queue is idempotent and oversized uploads publish nothing', async () => {
      const user = app.store.createUser('Bounded invited member', 'member', { ...defaultPolicy('member'), maxQueued: 1, maxInputBytes: 1024, diskBytes: 64 * 1024 ** 2 });
      const token = app.store.token(user.id, 'Bounded fixture').token;
      const requestHeaders = { ...headers(token), 'idempotency-key': randomUUID() };
      const payload = { type: 'download', download: { url: 'https://example.com/media.mp4' } };
      const accepted = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: requestHeaders, payload });
      assert.equal(accepted.statusCode, 202, accepted.body);
      const repeated = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: requestHeaders, payload });
      assert.equal(repeated.statusCode, 202); assert.equal(repeated.json().id, accepted.json().id);
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: { ...requestHeaders, 'idempotency-key': randomUUID() }, payload })).statusCode, 429);
      const available = app.store.availableBytes(user.id);
      const upload = await app.inject({ method: 'POST', url: '/api/v1/uploads', headers: { ...headers(token), 'content-type': 'application/octet-stream', 'x-filename': 'oversized.mp4' }, payload: Buffer.alloc(1025) });
      assert.equal(upload.statusCode, 413, upload.body);
      assert.equal(app.store.all('artifact', user.id).length, 0);
      assert.equal(app.store.availableBytes(user.id), available, 'failed upload releases its scratch reservation');
    });
    await t.test('only the local reverse proxy can forward a client address for pairing limits', async () => {
      const attempt = (remoteAddress: string, forwarded: string) => app.inject({ method: 'POST', url: '/api/v1/session', remoteAddress, headers: { ...publicHeaders, 'x-forwarded-for': forwarded }, payload: { token: 'unissued' } });
      for (let index = 0; index < 20; index++) assert.equal((await attempt('127.0.0.1', '203.0.113.10')).statusCode, 401);
      assert.equal((await attempt('127.0.0.1', '203.0.113.10')).statusCode, 429);
      assert.equal((await attempt('127.0.0.1', '203.0.113.11')).statusCode, 401, 'one remote client cannot consume another client pairing budget');
      for (let index = 0; index < 20; index++) assert.equal((await attempt('198.51.100.25', `203.0.113.${index + 30}`)).statusCode, 401);
      assert.equal((await attempt('198.51.100.25', '203.0.113.90')).statusCode, 429, 'an untrusted direct client cannot bypass limits by forging forwarded addresses');
    });
    await t.test('foreign Host and Origin are denied even with a valid credential', async () => {
      assert.equal((await app.inject({ url: '/api/v1/capabilities', headers: { ...headers(memberToken), host: 'attacker.example.com' } })).statusCode, 403);
      assert.equal((await app.inject({ url: '/api/v1/capabilities', headers: { ...headers(memberToken), origin: 'https://attacker.example.com' } })).statusCode, 403);
      assert.equal((await app.inject({ url: '/api/v1/capabilities', headers: { ...headers(memberToken), 'x-forwarded-host': 'attacker.example.com' } })).statusCode, 200, 'forwarded Host does not replace the authenticated raw Host boundary');
    });
    assert.equal(mediaRuns, 0, 'rejected operations never reach native tools');
  } finally {
    await app.close();
  }
});

test('public member policy template fits the runtime contract and bounded scratch budget', async () => {
  const policy = PolicySchema.parse(JSON.parse(await readFile(path.resolve('deploy/public-member-policy.example.json'), 'utf8')));
  assert.equal(policy.concurrency, 1);
  assert(policy.maxQueued <= 8);
  assert(3 * (policy.maxInputBytes + 8 * 1024 ** 2) < policy.diskBytes);
  assert(3 * (policy.maxOutputBytes + 8 * 1024 ** 2) < policy.diskBytes);
});
