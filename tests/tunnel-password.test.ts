import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';

const root = path.resolve('test-output/reliability');
const remote = { host: 'quiet-river-1234.trycloudflare.com', origin: 'https://quiet-river-1234.trycloudflare.com' };

test('password-protected tunnel rejects weak passwords and conflicting hosting modes', async () => {
  await mkdir(root, { recursive: true }); const dir = await mkdtemp(path.join(root, 'tunnel-invalid-'));
  for (const extra of [{ tunnelPassword: 'short' }, { tunnelPassword: 'long enough password', tunnelPrototype: true }, { tunnelPassword: 'long enough password', privateOrigin: 'https://fixture.example.ts.net' }, { tunnelPassword: 'long enough password', publicOrigin: 'https://public.example' }]) {
    await assert.rejects(createServer({ dataDir: path.join(dir, randomUUID()), encoders: [], startQueue: false, ...extra }), /tunnel/i);
  }
});

test('tunnel visitors must enter the password and get a limited, secure session', async () => {
  await mkdir(root, { recursive: true }); const dir = await mkdtemp(path.join(root, 'tunnel-password-'));
  const ownerToken = randomUUID(), password = 'correct-horse-battery';
  let app = await createServer({ dataDir: dir, ownerToken, tunnelPassword: password, encoders: [], startQueue: false });
  try {
    assert.equal((await app.inject({ url: '/api/v1/jobs', headers: remote })).statusCode, 401, 'No anonymous tunnel access');
    assert.equal((await app.inject({ url: '/api/v1/jobs', headers: { ...remote, host: 'attacker.example' } })).statusCode, 403, 'Other hostnames are refused');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/session', headers: { ...remote, origin: 'https://other.trycloudflare.com' }, payload: { token: password } })).statusCode, 403, 'Cross-origin login refused');
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/session', headers: remote, payload: { token: 'wrong-password-here' } });
    assert.equal(wrong.statusCode, 401); assert.equal(wrong.headers['set-cookie'], undefined);
    const signedIn = await app.inject({ method: 'POST', url: '/api/v1/session', headers: remote, payload: { token: password } });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const cookie = String(signedIn.headers['set-cookie']);
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict']) assert(cookie.includes(flag), flag);
    const caps = (await app.inject({ url: '/api/v1/capabilities', headers: { ...remote, cookie: cookie.split(';')[0] } })).json();
    assert.equal(caps.user.name, 'Tunnel visitor'); assert.equal(caps.user.role, 'member');
    assert.equal((await app.inject({ url: '/api/v1/admin/users', headers: { ...remote, cookie: cookie.split(';')[0] } })).statusCode, 403, 'Visitors cannot administer the workspace');
    assert.equal((await app.inject({ url: '/api/v1/jobs', headers: { host: 'localhost', authorization: `Bearer ${ownerToken}` } })).statusCode, 200, 'Local owner access is unchanged');
  } finally { await app.close(); }

  // Restarting with a new password revokes the old one.
  app = await createServer({ dataDir: dir, ownerToken, tunnelPassword: 'a-brand-new-password', encoders: [], startQueue: false });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/session', headers: remote, payload: { token: password } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/session', headers: remote, payload: { token: 'a-brand-new-password' } })).statusCode, 200);
  } finally { await app.close(); }

  // Without tunnel mode, quick-tunnel hostnames are refused entirely.
  app = await createServer({ dataDir: dir, ownerToken, encoders: [], startQueue: false });
  try { assert.equal((await app.inject({ url: '/api/v1/jobs', headers: remote })).statusCode, 403); }
  finally { await app.close(); }
});
