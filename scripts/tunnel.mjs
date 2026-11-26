// Serves Media Workbench through a temporary Cloudflare quick tunnel (random *.trycloudflare.com address).
// Visitors must enter the tunnel password. Usage: npm run tunnel   (Ctrl+C stops the site and the tunnel)
//
// Environment:
//   MW_TUNNEL_PASSWORD  password visitors must enter (10+ characters). Default: generated once, then reused.
//   MW_DATA_DIR         workspace for tunnel visitors. Default: .data-tunnel (separate from the desktop app).
//   MW_PORT             local port. Default: 4329.
//   MW_CLOUDFLARED      path to cloudflared. Default: cloudflared on PATH.
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'dist', 'server', 'main.js');
if (!existsSync(server)) { console.error('Build the app first: npm run build'); process.exit(1); }
const dataDir = path.resolve(root, process.env.MW_DATA_DIR || '.data-tunnel');
const port = Number(process.env.MW_PORT || 4329);
const cloudflared = process.env.MW_CLOUDFLARED || 'cloudflared';
await mkdir(dataDir, { recursive: true });

// A readable random password (about 80 bits), kept in the data folder so restarts keep the same password.
const passwordFile = path.join(dataDir, 'tunnel-password');
const generate = () => { const letters = 'abcdefghjkmnpqrstuvwxyz23456789'; return Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => letters[randomInt(letters.length)]).join('')).join('-'); };
let password = process.env.MW_TUNNEL_PASSWORD?.trim();
if (!password) {
  try { password = (await readFile(passwordFile, 'utf8')).trim(); } catch {}
  if (!password || process.argv.includes('--new-password')) { password = generate(); await writeFile(passwordFile, password + '\n', { mode: 0o600 }); }
}
if (password.length < 10) { console.error('MW_TUNNEL_PASSWORD must be at least 10 characters.'); process.exit(1); }

const children = [];
let stopping = false;
const stop = code => {
  if (stopping) return; stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(code), 1500).unref();
};
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));

// Only the tunnel settings are passed through; hosting modes that conflict with the tunnel stay off.
const env = { ...process.env, MW_HOST: '127.0.0.1', MW_PORT: String(port), MW_DATA_DIR: dataDir, MW_TUNNEL_PASSWORD: password, MW_TUNNEL_PROTOTYPE: '0', MW_SHARED: '0', MW_ISOLATE: '0', MW_PRIVATE_ORIGIN: '', MW_PRIVATE_NO_TOKEN: '0', MW_PUBLIC_ORIGIN: '', MW_DESKTOP_SECRET: '' };
const service = spawn(process.execPath, [server], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
children.push(service);
service.on('exit', code => { if (!stopping) { console.error(`Media Workbench stopped (exit ${code}).`); stop(code || 1); } });
await new Promise((resolve, reject) => {
  let buffer = '';
  service.stdout.on('data', chunk => {
    buffer += chunk;
    for (const line of buffer.split('\n').slice(0, -1)) { try { if (JSON.parse(line).event === 'ready') resolve(); } catch {} }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  });
  service.on('exit', () => reject(new Error('Media Workbench did not start.')));
}).catch(error => { console.error(error.message); stop(1); });
if (stopping) await new Promise(() => {});

const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
children.push(tunnel);
tunnel.on('error', error => { console.error(`Could not start cloudflared (${error.message}). Install it or set MW_CLOUDFLARED.`); stop(1); });
tunnel.on('exit', code => { if (!stopping) { console.error(`The Cloudflare tunnel closed (exit ${code}).`); stop(code || 1); } });
let announced = false;
tunnel.stderr.setEncoding('utf8');
tunnel.stderr.on('data', text => {
  const match = !announced && text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!match) return;
  announced = true;
  console.log(JSON.stringify({ event: 'tunnel', url: match[0], port, dataDir }));
  console.log(`\n  Media Workbench is online\n  Link:     ${match[0]}\n  Password: ${password}\n\n  The link changes each time the tunnel starts. Press Ctrl+C to stop.\n`);
});
