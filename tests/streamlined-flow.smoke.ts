import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from '../apps/server/src/app.ts';
import { generateFixtures } from '../packages/test-fixtures/generate.ts';

// Paste a link in the Library, Download & edit, then one-click Export: the streamlined path end to end.
const evidenceDir = path.resolve('test-output/streamlined-flow'); await mkdir(evidenceDir, { recursive: true });
const fixture = path.resolve('test-output/fixtures/numbered-cfr.mp4');
try { await readFile(fixture); } catch { await generateFixtures(); }
const bytes = await readFile(fixture);
const fixtureServer = createHttpServer((req, res) => {
  if (req.url === '/clip') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>Sample clip</title><video src="/movie.mp4"></video></html>'); }
  else if (req.url === '/movie.mp4') { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length }); res.end(bytes); }
  else { res.writeHead(404); res.end(); }
});
await new Promise<void>(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = `http://127.0.0.1:${(fixtureServer.address() as any).port}`;
const token = randomUUID();
const app = await createServer({ dataDir: path.join(evidenceDir, `service-${Date.now()}`), ownerToken: token, testOrigin: fixtureOrigin });
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const checks: string[] = [], errors: string[] = [];
const browser = await chromium.launch({ channel: process.env.MW_BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  const paste = (text: string) => page.evaluate(value => { const data = new DataTransfer(); data.setData('text/plain', value); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true })); }, text);
  const jobs = () => page.evaluate(async () => await (await fetch('/api/v1/jobs')).json());
  await page.goto(origin); await page.getByLabel('Access token', { exact: true }).fill(token); await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('heading', { name: 'Library', exact: true }).waitFor();

  await paste('not a link'); assert.equal(await page.getByLabel('Paste a video link', { exact: true }).inputValue(), '');
  await paste(`${fixtureOrigin}/clip`);
  assert.equal(await page.getByLabel('Paste a video link', { exact: true }).inputValue(), `${fixtureOrigin}/clip`);
  checks.push('Pasting a link anywhere on the Library fills the quick import box; other text is ignored');

  // Download is available instantly, before the link lookup finishes; the server still names the file from the title.
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByText(/^Downloading (your video|“Sample clip)/).waitFor();
  assert.equal(await page.getByLabel('Paste a video link', { exact: true }).inputValue(), '');
  const finished = async (count: number) => { let list: any[] = []; for (let i = 0; i < 150; i++) { list = (await jobs()).filter((job: any) => job.request.type === 'download'); if (list.length >= count && list.every((job: any) => ['completed', 'failed'].includes(job.state))) break; await page.waitForTimeout(200); } return list; };
  const artifactNames = () => page.evaluate(async () => (await (await fetch('/api/v1/artifacts')).json()).map((item: any) => item.name));
  let downloads = await finished(1);
  assert.equal(downloads[0]?.state, 'completed', downloads[0]?.error);
  assert((await artifactNames()).some((name: string) => /^Sample clip/.test(name)), 'An instant download is named from the media title');
  assert.equal(await page.locator('.cut-workspace').count(), 0);
  checks.push('Download works instantly after pasting, stays in the Library and names the file from the title');

  // Waiting for the lookup shows the title and sends it as the file name.
  await paste(`${fixtureOrigin}/clip`);
  await page.locator('.quick-found').getByRole('heading', { name: /^Sample clip/ }).waitFor();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByText(/^Downloading “Sample clip/).waitFor({ timeout: 8000 }).catch(async error => { await page.screenshot({ path: path.join(evidenceDir, 'debug-second-download.png') }); console.log('NOTICE TEXTS', await page.locator('[role=status],[role=alert],.notice').allInnerTexts()); throw error; });
  downloads = await finished(2);
  const named = downloads.find((job: any) => job.request.download.fileName);
  assert.equal(named?.state, 'completed', named?.error); assert.match(named.request.download.fileName, /^Sample clip/);
  checks.push('After the lookup the title, quality list and file name come from the link');

  // Download & edit opens the editor by itself once the file is ready.
  await paste(`${fixtureOrigin}/clip`);
  await page.getByRole('button', { name: 'Download & edit', exact: true }).click();
  await page.getByText('The editor opens automatically when the file is ready.').waitFor();
  await paste('https://example.invalid/other');
  assert.equal(await page.getByLabel('Paste a video link', { exact: true }).inputValue(), `${fixtureOrigin}/clip`);
  await page.locator('.cut-workspace').waitFor({ timeout: 60000 });
  checks.push('Download & edit shows progress, ignores a second paste, and opens the editor automatically');

  // One-click Export starts immediately; the status card reports the finished file.
  const before = (await jobs()).filter((job: any) => job.request.type === 'export').length;
  await page.getByRole('button', { name: 'Export now', exact: true }).click();
  const toast = page.getByRole('region', { name: 'Export status' });
  await toast.getByText('Export ready', { exact: true }).waitFor({ timeout: 120000 });
  await toast.getByRole('link', { name: 'Download file' }).waitFor();
  const exports = (await jobs()).filter((job: any) => job.request.type === 'export');
  assert.equal(exports.length, before + 1);
  assert.equal(exports.at(-1).state, 'completed');
  await page.screenshot({ path: path.join(evidenceDir, 'export-ready.png') });
  checks.push('Export now resolves the plan and submits in one click; the status card offers the finished file');

  await toast.getByRole('button', { name: 'Hide export status' }).click(); await toast.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Export now', exact: true }).click();
  await toast.getByText('Export ready', { exact: true }).waitFor();
  assert.equal((await jobs()).filter((job: any) => job.request.type === 'export').length, before + 1);
  checks.push('Exporting unchanged settings again re-shows the finished file instead of duplicating the export');

  await page.getByRole('button', { name: 'Export…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Export media' }).waitFor();
  assert.equal(await toast.count(), 0);
  checks.push('The full export dialog stays available and hides the status card while open');
  assert.deepEqual(errors, []);
} finally {
  await writeFile(path.join(evidenceDir, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
  await browser.close(); await app.close(); fixtureServer.close();
}
console.log(`${checks.length} streamlined-flow checks passed`);
