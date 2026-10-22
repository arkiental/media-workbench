import assert from 'node:assert/strict';
import {_electron as electron,type Page,type Locator,type Request} from 'playwright';
import {mkdir,mkdtemp,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';
import type {EditorDraft} from '../apps/web/src/drafts.ts';
import type {Recipe,Source,Artifact,Job} from '../packages/contracts/src/index.ts';
// @ts-expect-error Packaging helpers are plain JavaScript without declarations.
import {portableEnvironment} from '../scripts/portable-package-utils.mjs';

await mkdir('test-output/overlay-reliability-desktop',{recursive:true});
const directory=await mkdtemp(path.resolve('test-output/overlay-reliability-desktop/run-'));
const tools=await discoverTools(),fixture=path.join(directory,'Overlay native.mp4'),image=path.join(directory,'Red overlay.png');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','color=blue:size=320x180:rate=15:duration=4','-c:v','libx264','-pix_fmt','yuv420p',fixture]);
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','color=red:size=128x64','-frames:v','1',image]);
const packaged=process.env.MW_TEST_PACKAGED_APP;
const environment:Record<string,string>=Object.fromEntries(Object.entries({...(packaged?portableEnvironment(process.env,directory):process.env),MW_PORTABLE_USER_DATA:path.join(directory,'profile'),MW_DATA_DIR:path.join(directory,'service')}).filter((entry):entry is [string,string]=>entry[1]!==undefined));
delete environment.ELECTRON_RUN_AS_NODE;
const checks:string[]=[],errors:string[]=[];
let storageKey='',expectedBeforeFinal:{history:Recipe[];cursor:number}|undefined,expectedOpacity=0;
const snapshot=async(page:Page)=>page.evaluate(key=>{const result=window.mediaWorkbench?.workspaceGet?.(key);if(result?.error||!result?.value)throw Error(result?.error||'Native draft missing');const value=JSON.parse(result.value) as EditorDraft;return {history:value.history,cursor:value.cursor};},storageKey);
const current=(state:{history:Recipe[];cursor:number})=>state.history[state.cursor];
const beginDrag=async(page:Page,target:Locator)=>{const box=await target.boundingBox();assert(box);const point={x:box.x+box.width/2,y:box.y+box.height/2};await page.mouse.move(point.x,point.y);await page.mouse.down();return point;};
const ready=async(page:Page)=>{await page.getByLabel('Source playback',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')!.readyState>=2);};
const previewSettle=(page:Page)=>{
 const pending=new Set<Request>();let changed:()=>void=()=>{};
 const relevant=(request:Request)=>/\/api\/v1\/(?:sources\/[^/]+\/(?:thumb|waveform|frames)|artifacts\/[^/]+\/thumbnail)(?:[?]|$)/.test(request.url());
 const started=(request:Request)=>{if(relevant(request)){pending.add(request);changed();}};
 const finished=(request:Request)=>{if(pending.delete(request))changed();};
 page.on('request',started);page.on('requestfinished',finished);page.on('requestfailed',finished);
 return async()=>{
  // Successful initial thumbnails and no waveform loading prevent a quiet retry gap from looking settled.
  await page.waitForFunction(()=>{const images=[...document.querySelectorAll<HTMLImageElement>('.thumbs img')];return images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0)&&!document.querySelector('.thumb-skeleton,.waveform-empty.is-loading');},{},{timeout:45000});
  await new Promise<void>((resolve,reject)=>{
   let quiet:ReturnType<typeof setTimeout>|undefined;
   const cleanup=()=>{clearTimeout(deadline);clearTimeout(quiet);changed=()=>{};page.off('request',started);page.off('requestfinished',finished);page.off('requestfailed',finished);};
   const deadline=setTimeout(()=>{cleanup();reject(Error('Initial preview requests did not settle within45seconds'));},45000);
   changed=()=>{clearTimeout(quiet);if(!pending.size)quiet=setTimeout(()=>{cleanup();resolve();},500);};changed();
  });
 };
};
for(let pass=0;pass<2;pass++){
 const app=await electron.launch({executablePath:packaged||process.env.MW_TEST_ELECTRON,args:packaged?[]:['apps/desktop/main.cjs'],env:environment,timeout:70000});
 const page=await app.firstWindow(),settleInitialPreviews=previewSettle(page);page.on('pageerror',error=>errors.push(error.message));let origin='';
 try{
  await page.getByRole('button',{name:'Library',exact:true}).waitFor();origin=new URL(page.url()).origin;
  const rail=page.getByRole('navigation',{name:'Editing tools'});
  const undo=()=>page.getByRole('button',{name:'Undo',exact:true}).filter({visible:true}).click();
  const redo=()=>page.getByRole('button',{name:'Redo',exact:true}).filter({visible:true}).click();
  if(pass===0){
   await page.locator('.app-header').getByRole('button',{name:'Import',exact:true}).click();await page.getByLabel('Local media').setInputFiles(fixture);
   const imports=page.getByRole('region',{name:'File imports'});await imports.getByText('1 of 1 ready',{exact:true}).waitFor();await imports.getByRole('button',{name:'Dismiss'}).click();await page.getByRole('button',{name:'Edit source',exact:true}).click();await ready(page);
   const identity=await page.evaluate(async()=>{const [caps,sources]=await Promise.all([fetch('/api/v1/capabilities').then(r=>r.json()),fetch('/api/v1/sources').then(r=>r.json())]);const source=sources.find((item:Source)=>item.name==='Overlay native.mp4') as Source;if(!source)throw Error('Source upload missing');return {owner:caps.user.id,source};});
   storageKey=`mw:draft:1:${identity.owner}:${identity.source.id}:source`;
   await settleInitialPreviews();checks.push('Initial thumbnail/waveform work completed and tracked preview requests settled before overlay upload; immediate-busy overlay import remains outside this gesture acceptance.');
   await rail.getByRole('button',{name:'Overlay',exact:true}).click();await page.getByLabel('Choose overlay image',{exact:true}).setInputFiles(image);
   const move=page.getByRole('button',{name:/^Move overlay 1:/}),resize=page.locator('.overlay-handle.overlay-se');await move.waitFor();await page.waitForFunction(()=>!!document.querySelector<HTMLImageElement>('.overlay-item img')?.naturalWidth);
   const added=await snapshot(page);assert.equal(current(added).overlays.length,1);assert.equal(current(added).overlays[0].opacity,1);
   for(const [target,name] of [[move,'move'],[resize,'resize']] as const){
    const before=await snapshot(page),originBox=await page.locator('.overlay-item').boundingBox();const start=await beginDrag(page,target);
    await page.mouse.move(start.x+35,start.y+18,{steps:12});assert.notDeepEqual(await page.locator('.overlay-item').boundingBox(),originBox,'Gesture must visibly preview before cancellation');
    await page.keyboard.press('Escape');await page.mouse.move(start.x+50,start.y+24,{steps:6});await page.mouse.up();assert.deepEqual(await snapshot(page),before);
    const restoredBox=await page.locator('.overlay-item').boundingBox();assert(restoredBox&&originBox);for(const property of ['x','y','width','height'] as const)assert(Math.abs(restoredBox[property]-originBox[property])<1,`${name} cancellation restores ${property}`);
   }
   checks.push('Native move and resize visibly preview, then Escape plus continued movement/release restores original geometry and history.');
   const beforeMove=await snapshot(page),moveStart=await beginDrag(page,move);await page.mouse.move(moveStart.x+28,moveStart.y+14,{steps:20});await page.mouse.up();const moved=await snapshot(page);
   assert.notDeepEqual(current(moved).overlays,current(beforeMove).overlays);assert.equal(moved.history.length,beforeMove.history.length+1);assert.equal(moved.cursor,beforeMove.cursor+1);await undo();assert.deepEqual(current(await snapshot(page)),current(beforeMove));await redo();assert.deepEqual(await snapshot(page),moved);
   const resizeStart=await beginDrag(page,resize);await page.mouse.move(resizeStart.x+20,resizeStart.y+10,{steps:20});await page.mouse.up();const resized=await snapshot(page);assert(current(resized).overlays[0].width>current(moved).overlays[0].width);assert.equal(resized.cursor,moved.cursor+1);await undo();assert.deepEqual(current(await snapshot(page)),current(moved));await redo();assert.deepEqual(await snapshot(page),resized);
   checks.push('Normal 20-move image drag and resize each commit one history entry and one Undo restores the preceding geometry.');
   const staleStart=await beginDrag(page,move);await page.mouse.move(staleStart.x+25,staleStart.y+10,{steps:8});await page.keyboard.press('Control+z');const afterUndo=await snapshot(page);assert.deepEqual(current(afterUndo),current(moved));await page.mouse.move(staleStart.x+45,staleStart.y+20,{steps:8});await page.mouse.up();assert.deepEqual(await snapshot(page),afterUndo);await redo();assert.deepEqual(await snapshot(page),resized);
   checks.push('Undo during an active move cancels its stale draft; continued pointer movement/release cannot overwrite the independent edit.');
   const opacity=page.getByLabel('Opacity',{exact:true});await opacity.scrollIntoViewIfNeeded();let range=await opacity.boundingBox();assert(range);
   const beforeOpacity=await snapshot(page);await page.mouse.move(range.x+range.width-8,range.y+range.height/2);await page.mouse.down();await page.mouse.move(range.x+range.width*.55,range.y+range.height/2,{steps:20});
   const liveOpacity=Number(await opacity.inputValue());assert(liveOpacity>.4&&liveOpacity<.7);assert(Math.abs(Number(await page.locator('.overlay-item img').evaluate(element=>getComputedStyle(element).opacity))-liveOpacity)<.015);assert.deepEqual(await snapshot(page),beforeOpacity,'Live opacity must not change durable recipe/history before release');await page.mouse.up();const faded=await snapshot(page);
   assert.equal(current(faded).overlays[0].opacity,liveOpacity);assert.equal(faded.cursor,beforeOpacity.cursor+1);assert.equal(faded.history.length,beforeOpacity.history.length+1);await undo();assert.equal(current(await snapshot(page)).overlays[0].opacity,1);await redo();assert.deepEqual(await snapshot(page),faded);
   range=await opacity.boundingBox();assert(range);await page.mouse.move(range.x+range.width*.55,range.y+range.height/2);await page.mouse.down();await page.mouse.move(range.x+range.width*.2,range.y+range.height/2,{steps:20});await page.keyboard.press('Escape');await page.mouse.move(range.x+range.width*.8,range.y+range.height/2,{steps:8});await page.mouse.up();assert.deepEqual(await snapshot(page),faded);assert.equal(Number(await opacity.inputValue()),liveOpacity);assert(Math.abs(Number(await page.locator('.overlay-item img').evaluate(element=>getComputedStyle(element).opacity))-liveOpacity)<.015);
   checks.push('Real20-move opacity drag updates image opacity live, commits one Undo step, and Escape restores the origin despite continued movement.');
   for(const kind of ['export','project']){
    await opacity.scrollIntoViewIfNeeded();range=await opacity.boundingBox();assert(range);
    await page.mouse.move(range.x+8+liveOpacity*(range.width-16),range.y+range.height/2);await page.mouse.down();await page.mouse.move(range.x+range.width*.2,range.y+range.height/2,{steps:8});await page.keyboard.press('Escape');await page.mouse.up();
    if(kind==='export')await page.locator('.editor-review-export').click();else await page.getByRole('button',{name:'Project saving',exact:true}).click();
    await page.locator('dialog[open]').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0,'Cancelled slider must not intercept a later dialog Escape');assert.deepEqual(await snapshot(page),faded);
   }
   checks.push('Export and Project dialogs close with Escape after cancelled opacity gestures without changing durable edits.');
   const otherFixture=path.join(directory,'Other overlay source.mp4');await copyFile(fixture,otherFixture);
   await page.locator('.app-header').getByRole('button',{name:'Import',exact:true}).click();await page.getByLabel('Local media').setInputFiles(otherFixture);
   const secondImports=page.getByRole('region',{name:'File imports'});await secondImports.getByText('1 of 1 ready',{exact:true}).waitFor();await secondImports.getByRole('button',{name:'Dismiss'}).click();
   const sourcesResponse=await page.evaluate(async()=>{const response=await fetch('/api/v1/sources');return {status:response.status,body:await response.text()};});assert.equal(sourcesResponse.status,200,sourcesResponse.body);const importedSources=JSON.parse(sourcesResponse.body) as Source[];const other=importedSources.find(source=>source.name==='Other overlay source.mp4');assert(other,'Second source must be imported by the UI queue');
   await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator('.page-heading').getByRole('button',{name:'Refresh',exact:true}).click();await page.locator(`[data-artifact-id="${other.artifactId}"]`).getByRole('button',{name:'Edit source',exact:true}).click();await ready(page);assert.equal(await page.locator('.overlay-item').count(),0);
   const otherDraft=await page.evaluate(key=>window.mediaWorkbench?.workspaceGet?.(key),`mw:draft:1:${identity.owner}:${other.id}:source`);assert(otherDraft?.value);assert.equal(current(JSON.parse(otherDraft.value)).overlays.length,0);
   await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator(`[data-artifact-id="${identity.source.artifactId}"]`).getByRole('button',{name:'Edit source',exact:true}).click();await ready(page);await rail.getByRole('button',{name:'Overlay',exact:true}).click();assert.deepEqual(await snapshot(page),faded);
   checks.push('Navigating to another real imported source has no overlays; returning restores this source overlay recipe and history exactly.');
   await page.screenshot({path:path.join(directory,'native-overlay-gestures.png')});
   expectedBeforeFinal=await snapshot(page);await opacity.scrollIntoViewIfNeeded();range=await opacity.boundingBox();assert(range);await page.mouse.move(range.x+range.width*.55,range.y+range.height/2);await page.mouse.down();await page.mouse.move(range.x+range.width*.65,range.y+range.height/2,{steps:20});expectedOpacity=Number(await opacity.inputValue());assert(expectedOpacity>.55&&expectedOpacity<.75);
   // Quit directly after committing, without a blur, persistence poll or screenshot.
   await page.mouse.up();
  }else{
   await ready(page);await rail.getByRole('button',{name:'Overlay',exact:true}).click();const restored=await snapshot(page);assert(expectedBeforeFinal);const expectedRecipe={...current(expectedBeforeFinal),overlays:current(expectedBeforeFinal).overlays.map((overlay,index)=>index===0?{...overlay,opacity:expectedOpacity}:overlay)};
   assert.deepEqual(current(restored),expectedRecipe);assert.equal(restored.cursor,expectedBeforeFinal.cursor+1);assert.deepEqual(restored.history,[...expectedBeforeFinal.history.slice(0,expectedBeforeFinal.cursor+1),expectedRecipe]);
   await undo();assert.deepEqual(current(await snapshot(page)),current(expectedBeforeFinal));await redo();assert.deepEqual(await snapshot(page),restored);checks.push('Full native quit immediately after pointer-up restores the completed overlay edit and exact Undo/Redo history.');
   await page.locator('.editor-review-export').click();const dialog=page.getByRole('dialog',{name:'Export media',exact:true});await dialog.getByRole('button',{name:'Resolve export plan',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('[aria-label="Export using reviewed plan"]') as HTMLButtonElement)?.disabled);await dialog.getByRole('button',{name:'Export using reviewed plan',exact:true}).click();await dialog.getByRole('status').filter({hasText:/^Export ready$/}).waitFor({timeout:90000});
   const jobs=await page.evaluate(async()=>await(await fetch('/api/v1/jobs')).json()) as Job[];assert.equal(jobs.length,1);const job=jobs[0];assert.equal(job.state,'completed');assert.equal(job.request.type,'export');if(job.request.type!=='export')throw Error('Wrong job type');assert.deepEqual(job.request.recipe.overlays,expectedRecipe.overlays);
   const artifacts=await page.evaluate(async()=>await(await fetch('/api/v1/artifacts')).json()) as Artifact[];assert(artifacts.some(artifact=>artifact.id===job.artifactId&&artifact.validated));
   const response=await page.evaluate(async id=>{const response=await fetch(`/api/v1/artifacts/${id}/content`);return {status:response.status,bytes:[...new Uint8Array(await response.arrayBuffer())]};},job.artifactId);assert.equal(response.status,200,response.status===200?'':Buffer.from(response.bytes).toString('utf8'));const output=path.join(directory,'verified-overlay-export.mp4');await writeFile(output,new Uint8Array(response.bytes));
   const pixel=async(x:number,y:number)=>[...(await runProcess(tools.ffmpeg,['-v','error','-ss','1','-i',output,'-frames:v','1','-vf',`crop=2:2:${x}:${y}`,'-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout].slice(0,3);
   const overlay=expectedRecipe.overlays[0],center=await pixel(Math.round(overlay.x*320/2)*2,Math.round(overlay.y*180/2)*2),background=await pixel(2,2);assert(center[0]>100&&center[2]>25&&center[0]>background[0]+80,`Red overlay at saved position and opacity: ${center}`);assert(background[0]<40&&background[2]>170,`Blue background retained: ${background}`);
   await page.screenshot({path:path.join(directory,'native-overlay-export.png')});checks.push('Real exported file matches restored overlay recipe, validates, and decoded pixels show translucent red at saved position with blue background outside.');
  }
  assert.deepEqual(errors,[]);
 }catch(error){await page.screenshot({path:path.join(directory,`failure-${pass}.png`)}).catch(()=>{});await writeFile(path.join(directory,'failure.json'),JSON.stringify({pass,error:String(error),stack:error instanceof Error?error.stack:undefined,checks,errors,body:await page.locator('body').innerText().catch(()=>''),draft:storageKey?await snapshot(page).catch(()=>undefined):undefined},null,2));throw error;}
 finally{await app.close();}
 await assert.rejects(fetch(origin,{signal:AbortSignal.timeout(3000)}));
}
await writeFile(path.join(directory,'checks.json'),JSON.stringify({packaged:packaged||false,checks,errors},null,2));console.log(JSON.stringify({directory,checks,errors}));
