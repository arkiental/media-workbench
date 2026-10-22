import assert from 'node:assert/strict';
import { _electron as electron, type Page } from 'playwright';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { discoverTools, runProcess } from '../packages/media/src/index.ts';
// @ts-expect-error Packaging helpers are plain JavaScript without declarations.
import { portableEnvironment } from '../scripts/portable-package-utils.mjs';

async function seekFraction(page:Page,fraction:number){const slider=page.locator('.scrubber'),bounds=await slider.boundingBox();assert(bounds);await slider.click({position:{x:bounds.width*fraction,y:bounds.height/2}});}

await mkdir('test-output/desktop-workflows', { recursive: true });
const directory = await mkdtemp(path.resolve('test-output/desktop-workflows/run-'));
const fixture = path.join(directory, 'Desktop source.mp4');
const tools = await discoverTools();
await runProcess(tools.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-c:v', 'libx264', fixture]);
const packaged = process.env.MW_TEST_PACKAGED_APP;
const environment: Record<string, string> = Object.fromEntries(Object.entries({ ...(packaged ? portableEnvironment(process.env, directory) : process.env), MW_PORTABLE_USER_DATA: path.join(directory, 'profile'), MW_DATA_DIR: path.join(directory, 'service') }).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete environment.ELECTRON_RUN_AS_NODE;
const launch = () => electron.launch({ executablePath: packaged || process.env.MW_TEST_ELECTRON, args: packaged ? [] : ['apps/desktop/main.cjs'], env: environment, timeout: 70000 });
const desktop = await launch();
const checks: string[] = [], errors: string[] = [];
let origin = '';
try {
  const page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: 'Library', exact: true }).waitFor();
  origin = new URL(page.url()).origin;
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  await page.locator('.app-header').getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByLabel('Local media').setInputFiles(fixture);
  await page.getByRole('heading', { name: 'Library', exact: true }).waitFor();
  await page.getByRole('region', { name: 'File imports' }).getByRole('button', { name: 'Dismiss' }).click();
  await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  if (packaged || process.env.MW_TEST_DESKTOP_PERSISTENCE) {
    const ruler = page.locator('.scrubber');
    const bounds = await ruler.boundingBox(); assert(bounds);
    await ruler.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await page.waitForFunction(() => { const key = Object.keys(localStorage).find(key => key.startsWith('mw:draft:')); if (!key) return false; const d = JSON.parse(localStorage[key]); return d.history[d.cursor].segments.length === 2; });
    checks.push('Packaged Editor splits the generated source through timeline seek and Split controls.');
  }
  await page.getByRole('button', { name: 'Export…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export media' });
  await dialog.getByLabel('Export name', { exact: true }).fill('Desktop saved revision');
  await dialog.getByRole('button', { name: 'Resolve export plan' }).click();
  await page.waitForFunction(() => !(document.querySelector('[aria-label="Export using reviewed plan"]') as HTMLButtonElement)?.disabled);
  await dialog.getByRole('button', { name: 'Export using reviewed plan' }).click();
  await dialog.getByRole('status').filter({ hasText: /^Export ready$/ }).waitFor({ timeout: 60000 });
  await page.reload();
  await page.getByRole('button', { name: 'Export…', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: /^Export ready$/ }).waitFor();
  checks.push('Real Electron starts its isolated loopback service, imports generated media, exports a named revision and restores completion after reload.');
  await dialog.getByRole('button', { name: 'Close export', exact: true }).click();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const card = page.locator('.media-card').filter({ has: page.getByRole('heading', { name: 'Desktop saved revision.mp4', exact: true }) });
  await card.getByText('File details', { exact: true }).click();
  const savePath = path.join(directory, 'cancelled-choice.mp4');
  await assert.rejects(access(savePath));
  await desktop.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async (...args: any[]) => {
      const options = args.at(-1);
      if (options.defaultPath !== 'Desktop saved revision.mp4') throw Error('Incorrect Save As default name');
      return { canceled: false, filePath };
    };
  }, savePath);
  await card.getByRole('button', { name: 'Save as', exact: true }).click();
  await page.getByText(`Saved to ${savePath}.`, { exact: true }).waitFor();
  assert.equal(await page.locator('.notice-info').count(),0);
  const artifact = await page.evaluate(async () => (await (await fetch('/api/v1/artifacts')).json()).find((item: any) => item.name === 'Desktop saved revision.mp4'));
  const sourceBytes = await page.evaluate(async id => Array.from(new Uint8Array(await (await fetch(`/api/v1/artifacts/${id}/content`)).arrayBuffer())), artifact.id);
  assert.deepEqual(await readFile(savePath), Buffer.from(sourceBytes));
  await desktop.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
  await card.getByRole('button', { name: 'Save as', exact: true }).click();
  await page.getByText('Save cancelled. No file was saved.', { exact: true }).waitFor();
  assert.equal(await page.locator('.notice-info').count(),1);await page.screenshot({path:path.join(directory,'save-cancelled.png')});
  assert.deepEqual(await readFile(savePath), Buffer.from(sourceBytes));
  await desktop.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},path.join(directory,'missing-directory','cannot-save.mp4'));
  await card.getByRole('button',{name:'Save as',exact:true}).click();
  await page.getByRole('alert').filter({hasText:/ENOENT|no such file/i}).waitFor();
  assert.equal(await page.getByText('Save cancelled. No file was saved.',{exact:true}).count(),0);
  await page.waitForTimeout(6000);await page.getByRole('alert').filter({hasText:/ENOENT|no such file/i}).waitFor();
  await assert.rejects(access(path.join(directory,'missing-directory','cannot-save.mp4')));
  assert.deepEqual(await readFile(savePath),Buffer.from(sourceBytes));
  checks.push('Success names the saved destination; cancellation is neutral and creates no file; real copy failure is an error that survives successful background polling without claiming a save.');
  checks.push('Library Save As invokes real native IPC with the correct suggested name and copies identical bytes to a new disposable path; chooser cancellation leaves the saved file unchanged. OS chooser selections were supplied by the test.');
  await page.screenshot({ path: path.join(directory, 'native-library.png') });
  assert.deepEqual(errors, []);
} finally { await desktop.close(); }
await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(3000) }));
checks.push('Closing the isolated Electron shell stops its task-owned service.');
if (packaged || process.env.MW_TEST_DESKTOP_PERSISTENCE) {
  const reopened = await launch();
  let reopenedOrigin = '';
  try {
    const page = await reopened.firstWindow();
    await page.getByRole('button', { name: 'Library', exact: true }).waitFor();
    reopenedOrigin = new URL(page.url()).origin;
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('heading', { name: 'Desktop saved revision.mp4', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('mw:draft:')));
    const restoredSegments = await page.evaluate(() => { const key = Object.keys(localStorage).find(key => key.startsWith('mw:draft:'))!; const draft = JSON.parse(localStorage[key]); return draft.history[draft.cursor].segments; });
    assert.equal(restoredSegments.length, 2, 'Full packaged restart must retain the two edited sections');
    await page.locator('.editor-review-export').click();
    await page.getByRole('dialog', { name: 'Export media' }).getByRole('status').filter({ hasText: /^Export ready$/ }).waitFor();
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/v1/jobs')).json()).filter((j: any) => j.request.type === 'export').length), 1);
    checks.push('Closing and relaunching the packaged executable restores the edited source and completed export without resubmission, with only Windows system tools on PATH.');
    await page.getByRole('button',{name:'Close export',exact:true}).click();
    const second=path.join(directory,'Second source.mp4');
    await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','color=c=blue:size=320x180:rate=30:duration=2','-c:v','libx264',second]);
    await page.locator('.app-header').getByRole('button',{name:'Import',exact:true}).click();
    let uploadAttempts=0;
    await page.route('**/api/v1/uploads',async route=>{uploadAttempts++;if(uploadAttempts<=2)await route.fulfill({status:429,json:{error:'Two preview/inspection operations already active'}});else await route.continue();});
    await page.getByLabel('Local media').setInputFiles(second);
    await page.getByRole('region',{name:'File imports'}).getByText('Waiting for preview work. Retrying automatically.',{exact:true}).waitFor();
    // Capacity recovery must happen without a manual retry.
    await page.getByRole('region',{name:'File imports'}).getByText('1 of 1 ready',{exact:true}).waitFor();
    await page.unroute('**/api/v1/uploads');assert(uploadAttempts>=3&&uploadAttempts<=8);
    assert.equal(await page.evaluate(async()=>(await(await fetch('/api/v1/sources')).json()).filter((source:any)=>source.name==='Second source.mp4').length),1);
    checks.push('Packaged import waits through capacity responses and recovers automatically, creating one source without manual Retry.');
    await page.getByRole('region',{name:'File imports'}).getByRole('button',{name:'Dismiss'}).click();
    await page.getByRole('button',{name:'Library',exact:true}).click();
    await page.locator('.media-card').filter({has:page.getByRole('heading',{name:'Second source.mp4',exact:true})}).getByRole('button',{name:'Edit source'}).click();
    await seekFraction(page,0.4);
    await page.getByRole('button',{name:'Split',exact:true}).click();
    await page.getByRole('button',{name:'Library',exact:true}).click();
    await page.locator('.media-card').filter({has:page.getByRole('heading',{name:'Desktop source.mp4',exact:true})}).getByRole('button',{name:'Edit source'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.timeline-region').length===2);
    assert.equal(await page.locator('.timeline-region').count(),2);
    await seekFraction(page,1/6);
    await page.getByRole('button',{name:'Split',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.timeline-region').length===3);
    assert.equal(await page.locator('.timeline-region').count(),3);
    // Close immediately, before the 250ms playhead debounce can run.
  } catch (error) {
    const page = await reopened.firstWindow();
    await page.screenshot({path:path.join(directory,'reopen-failure.png')});
    await writeFile(path.join(directory,'failure.json'),JSON.stringify({checks,errors,body:await page.locator('body').textContent(),error:String(error)},null,2));
    throw error;
  } finally { await reopened.close(); }
  await assert.rejects(fetch(reopenedOrigin, { signal: AbortSignal.timeout(3000) }));
  const rapid=await launch();
  try{
    const page=await rapid.firstWindow();await page.locator('.timeline-region').first().waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('.timeline-region').length===3);
    assert.equal(await page.locator('.timeline-region').count(),3);
    await page.getByRole('button',{name:'Library',exact:true}).click();
    await page.locator('.media-card').filter({has:page.getByRole('heading',{name:'Second source.mp4',exact:true})}).getByRole('button',{name:'Edit source'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.timeline-region').length===2);
    assert.equal(await page.locator('.timeline-region').count(),2);
    await page.evaluate(async()=>{const caps=await(await fetch('/api/v1/capabilities')).json();const key='mw:last:'+caps.user.id;const bridge=window.mediaWorkbench!;const old=bridge.workspaceGet!(key);if(!old.value||!JSON.parse(old.value).sourceId)throw Error('Expected current source preference before missing-source test');const result=bridge.workspaceSet!(key,JSON.stringify({sourceId:'missing-test-source'}),old.value??null);if(!result.ok)throw Error(result.error);});
    checks.push('Separate source edits survive switching and restart; a third section committed immediately before closing is restored.');
  }finally{await rapid.close();}
  const missing=await launch();
  try{const page=await missing.firstWindow();await page.getByRole('heading',{name:'Choose a video to edit'}).waitFor();await page.getByRole('button',{name:'Open library'}).click();await page.getByRole('heading',{name:'Desktop source.mp4',exact:true}).waitFor();checks.push('An unavailable last source opens a recoverable empty Editor without replacing existing drafts or media.');}finally{await missing.close();}
}
await writeFile(path.join(directory, 'checks.json'), JSON.stringify({ checks, errors }, null, 2));
console.log(JSON.stringify({ directory, checks, errors }));
