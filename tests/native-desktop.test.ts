import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { validateMedia } from '../packages/media/src/index.ts';
const nativeHelper=createRequire(import.meta.url)('../apps/desktop/native.cjs');

test('real Electron shell owns a standalone service and uses narrow artifact IPC', {skip:process.env.MW_TEST_DESKTOP!=='1',timeout:120000},async()=>{
  await mkdir('test-output/native',{recursive:true});const directory=await mkdtemp(path.resolve('test-output/native/desktop-'));
  const environment:Record<string,string>=Object.fromEntries(Object.entries({...process.env,MW_DATA_DIR:path.join(directory,'service')}).filter((entry):entry is [string,string]=>entry[1]!==undefined));delete environment.ELECTRON_RUN_AS_NODE;
  if(process.env.MW_RESTRICT_DESKTOP_PATH==='1'){for(const key of Object.keys(environment))if(key.toLowerCase()==='path')delete environment[key];const systemRoot=process.env.SystemRoot||'C:\\Windows';environment.PATH=process.platform==='win32'?`${systemRoot}\\System32;${systemRoot}\\System32\\WindowsPowerShell\\v1.0`:'/usr/bin:/bin';}
  const desktop=await electron.launch({args:[...(process.env.MW_DESKTOP_EXECUTABLE?[]:['apps/desktop/main.cjs']),`--user-data-dir=${path.join(directory,'profile')}`],...(process.env.MW_DESKTOP_EXECUTABLE?{executablePath:process.env.MW_DESKTOP_EXECUTABLE}:{}),env:environment,timeout:70000});
  let serviceOrigin='';
  try {
    const page=await desktop.firstWindow();await page.getByRole('banner').getByRole('button',{name:'Import',exact:true}).click();await page.getByRole('heading',{name:'Import',exact:true}).waitFor({timeout:60000});serviceOrigin=new URL(page.url()).origin;
    const preferences=await desktop.evaluate(({BrowserWindow})=>(BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences());
    assert.equal(preferences.sandbox,true);assert.equal(preferences.contextIsolation,true);assert.equal(preferences.nodeIntegration,false);
    assert.equal(await page.evaluate(()=>typeof (window as any).require),'undefined');
    const native=await page.evaluate(async()=>window.mediaWorkbench!.capabilities());assert.equal(native.fileClipboard.state,process.platform==='win32'?'available':'unavailable');
    await page.getByLabel('Local media',{exact:true}).setInputFiles(path.resolve('test-output/fixtures/numbered-cfr.mp4'));await page.getByRole('heading',{name:'Library',exact:true}).waitFor();await page.locator('.media-card').filter({hasText:'numbered-cfr.mp4'}).getByRole('button',{name:'Edit source',exact:true}).click();
    await page.getByRole('heading',{name:'Editor · numbered-cfr.mp4'}).waitFor({timeout:30000});
    await page.waitForFunction(()=>{const images=Array.from(document.querySelectorAll<HTMLImageElement>('img[alt^="Source thumbnail"]'));return images.length===4&&images.every(image=>image.complete&&image.naturalWidth>0);});
    await page.getByRole('heading',{name:'Keep regions',exact:true}).waitFor();await page.getByLabel('Playhead (s)',{exact:true}).fill('0.5');await page.getByRole('button',{name:'Set start I',exact:true}).click();await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('.region-edit input')?.value==='0.5');
    await page.getByRole('button',{name:'Preview video',exact:true}).click();await page.getByLabel('Rendered export preview',{exact:true}).waitFor({timeout:60000});await page.waitForFunction(()=>{const v=document.querySelector<HTMLVideoElement>('video[aria-label="Rendered export preview"]');return v&&v.readyState>=2&&v.currentTime>0;});await page.getByRole('button',{name:'Close preview',exact:true}).click();
    const artifact=await page.evaluate(async()=> (await(await fetch('/api/v1/artifacts')).json()).find((a:any)=>a.kind==='original'));
    await assert.rejects(page.evaluate(async()=>window.mediaWorkbench!.copyPath('../../host-file')),/opaque/);
    await page.evaluate(async id=>window.mediaWorkbench!.copyPath(id),artifact.id);const copiedPath=await desktop.evaluate(({clipboard})=>clipboard.readText());assert.ok(path.isAbsolute(copiedPath));assert.equal(path.basename(copiedPath),artifact.name);assert.equal(path.extname(copiedPath),'.mp4');
    let clipboardReadback:any;if(process.platform==='win32'){await page.evaluate(async id=>window.mediaWorkbench!.copyFile(id),artifact.id);const formats=await desktop.evaluate(async({clipboard})=>(await clipboard.read()).flatMap(item=>item.types));assert.ok(formats.some(f=>/CF_HDROP|FileDrop|filename|uri-list/i.test(f)),formats.join(', '));clipboardReadback=await nativeHelper.windowsFileClipboard(copiedPath,'inspect');assert.deepEqual(clipboardReadback.paths,[copiedPath]);}
    const savePath=path.join(directory,'saved export 雪.mp4');
    await desktop.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},savePath);
    await page.evaluate(async id=>window.mediaWorkbench!.saveAs(id),artifact.id);
    const original=await readFile(copiedPath),saved=await readFile(savePath);assert.deepEqual(saved,original);assert.deepEqual(original,await readFile(path.resolve('test-output/fixtures/numbered-cfr.mp4')));
    const appPath=await desktop.evaluate(({app})=>app.getAppPath()),toolSuffix=process.platform==='win32'?'.exe':'';const outputMedia=await validateMedia(savePath,{ffmpeg:path.join(appPath,'.tools',`ffmpeg${toolSuffix}`),ffprobe:path.join(appPath,'.tools',`ffprobe${toolSuffix}`),ytdlp:path.join(appPath,'.tools',`yt-dlp${toolSuffix}`)});assert.equal(outputMedia.streams.find(s=>s.type==='video')?.width,320);
    await page.screenshot({path:path.join(directory,'desktop.png'),fullPage:true});
    await writeFile(path.join(directory,'evidence.json'),JSON.stringify({testedAt:new Date().toISOString(),platform:process.platform,packagedExecutable:process.env.MW_DESKTOP_EXECUTABLE||null,regionSidebar:true,regionStart:.5,renderedPreview:true,restrictedPath:process.env.MW_RESTRICT_DESKTOP_PATH==='1',sandbox:preferences.sandbox,contextIsolation:preferences.contextIsolation,nodeIntegration:preferences.nodeIntegration,serviceOrigin,artifactId:artifact.id,copyFile:process.platform==='win32',copiedPath,savePath,clipboardReadback,outputMedia,saveAsBytes:saved.length,sha256:createHash('sha256').update(saved).digest('hex')},null,2));
  } finally {await desktop.close();}
  for(let i=0;i<20;i++){try{await fetch(serviceOrigin);await new Promise(r=>setTimeout(r,300));}catch{return;}}
  assert.fail('Owned service was still accepting connections after desktop shutdown.');
});
