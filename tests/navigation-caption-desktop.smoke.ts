import assert from 'node:assert/strict';
import {_electron as electron,type Page} from 'playwright';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';
import {captionLayout} from '../packages/contracts/src/caption.ts';
import type {EditorDraft} from '../apps/web/src/drafts.ts';
// @ts-expect-error Packaging helpers are plain JavaScript without declarations.
import {portableEnvironment} from '../scripts/portable-package-utils.mjs';

await mkdir('test-output/navigation-caption-desktop',{recursive:true});
const directory=await mkdtemp(path.resolve('test-output/navigation-caption-desktop/run-'));
const tools=await discoverTools(),fixture=path.join(directory,'Caption navigation.mp4');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=6','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=6','-c:v','libx264','-c:a','aac',fixture]);
const packaged=process.env.MW_TEST_PACKAGED_APP;
const environment:Record<string,string>=Object.fromEntries(Object.entries({...(packaged?portableEnvironment(process.env,directory):process.env),MW_PORTABLE_USER_DATA:path.join(directory,'profile'),MW_DATA_DIR:path.join(directory,'service')}).filter((entry):entry is [string,string]=>entry[1]!==undefined));
delete environment.ELECTRON_RUN_AS_NODE;
const checks:string[]=[],errors:string[]=[];
const caption=('Native caption editing keeps previous rotation and trim edits. ').repeat(3).slice(0,128);
assert.equal(caption.length,128);
let storageKey='',expectedHistory:EditorDraft['history']|undefined,expectedCursor:number|undefined;
const draft=async(page:Page):Promise<EditorDraft>=>page.evaluate(key=>{
 const result=window.mediaWorkbench?.workspaceGet?.(key);
 if(result?.error||!result?.value)throw Error(result?.error||'Native draft unavailable');
 return JSON.parse(result.value);
},storageKey);
const currentRecipe=(value:EditorDraft)=>value.history[value.cursor];
const readHistory=async(page:Page)=>{const value=await draft(page);return {history:value.history,cursor:value.cursor};};
const visiblePlayhead=async(page:Page)=>{
 await page.waitForFunction(()=>{
  const scroll=document.querySelector<HTMLElement>('.timeline-scroll'),media=document.querySelector<HTMLElement>('.timeline-media'),input=document.querySelector<HTMLInputElement>('.scrubber');
  if(!scroll||!media||!input)return false;
  const bounds=scroll.getBoundingClientRect(),x=media.getBoundingClientRect().left+Number(input.value)/Number(input.max)*media.getBoundingClientRect().width;
  return x>=bounds.left-2&&x<=bounds.right+2;
 });
};
for(let pass=0;pass<3;pass++){
 const app=await electron.launch({executablePath:packaged||process.env.MW_TEST_ELECTRON,args:packaged?[]:['apps/desktop/main.cjs'],env:environment,timeout:70000});
 const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));let origin='';
 try{
  await page.getByRole('button',{name:'Library',exact:true}).waitFor();origin=new URL(page.url()).origin;
  if(pass===0){
   await page.locator('.app-header').getByRole('button',{name:'Import',exact:true}).click();await page.getByLabel('Local media').setInputFiles(fixture);
   const imports=page.getByRole('region',{name:'File imports'});await imports.getByText('1 of 1 ready',{exact:true}).waitFor();await imports.getByRole('button',{name:'Dismiss'}).click();await page.getByRole('button',{name:'Edit source',exact:true}).click();
   storageKey=await page.evaluate(async()=>{const [caps,sources]=await Promise.all([fetch('/api/v1/capabilities').then(r=>r.json()),fetch('/api/v1/sources').then(r=>r.json())]);const source=sources.find((s:{name:string})=>s.name==='Caption navigation.mp4');if(!source)throw Error('Imported source missing');return `mw:draft:1:${caps.user.id}:${source.id}:source`;});
  }
  await page.getByLabel('Source playback',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')!.readyState>=2);
  const rail=page.getByRole('navigation',{name:'Editing tools'}),text=page.getByLabel('Caption text',{exact:true});
  if(pass===0){
   await page.getByLabel('Region 1 in timecode',{exact:true}).fill('00:00:01.000');await page.getByLabel('Region 1 in timecode',{exact:true}).press('Enter');
   await rail.getByRole('button',{name:'Transform',exact:true}).click();await page.locator('.transform-inspector').getByRole('button',{name:'Rotate right',exact:true}).click();
   await rail.getByRole('button',{name:'Cut',exact:true}).click();
   for(const at of [3,5]){
    if(at===5)await page.getByRole('button',{name:'Select region 2',exact:true}).click();
    await page.locator('.timeline-more > summary').click();await page.getByLabel('Playhead (s)',{exact:true}).fill(String(at));await page.getByLabel('Playhead (s)',{exact:true}).press('Tab');await page.locator('.timeline-more > summary').click();
    await page.locator('#workspace-content').focus();await page.keyboard.press('s');
   }
   assert.deepEqual(currentRecipe(await draft(page)).segments,[{in:1,out:3},{in:3,out:5},{in:5,out:6}]);
   await rail.getByRole('button',{name:'Text',exact:true}).click();await page.getByRole('checkbox',{name:'Caption above video',exact:true}).check();
   const before=await draft(page);assert.equal(currentRecipe(before).rotate,90);
   await text.focus();await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');await text.pressSequentially(caption,{delay:1});
   assert.equal(await text.inputValue(),caption);const typed=await draft(page);assert.equal(currentRecipe(typed).caption?.text,caption);assert.equal(typed.history.length,before.history.length+1);assert.equal(typed.cursor,before.cursor+1);assert.equal(currentRecipe(typed).rotate,90);assert.deepEqual(currentRecipe(typed).segments,currentRecipe(before).segments);
   assert.equal(await page.getByLabel('Video caption',{exact:true}).innerText(),captionLayout(currentRecipe(typed).caption!,180).text);
   await text.press('Control+z');assert.equal(await text.inputValue(),currentRecipe(before).caption!.text);assert.deepEqual(currentRecipe(await draft(page)),currentRecipe(before));
   await text.press('Control+y');assert.equal(await text.inputValue(),caption);assert.deepEqual(currentRecipe(await draft(page)),currentRecipe(typed));
   await text.press('Tab');await text.focus();await text.press('End');await text.pressSequentially('?');await text.press('Tab');
   await page.getByRole('button',{name:'Undo',exact:true}).filter({visible:true}).click();assert.equal(await text.inputValue(),caption);
   await page.getByRole('button',{name:'Redo',exact:true}).filter({visible:true}).click();assert.equal(await text.inputValue(),caption+'?');
   await page.getByRole('button',{name:'Undo',exact:true}).filter({visible:true}).click();assert.equal(await text.inputValue(),caption);
   checks.push('128 real sequential keystrokes update caption and native draft live, preserve rotation/three trimmed sections, and group Undo/Redo per focus session.');
   await page.screenshot({path:path.join(directory,'caption-before-immediate-quit.png')});
   await text.focus();await text.press('Control+End');
   // Deliberately no blur, screenshot, polling or persistence read between the final edit and quitting Electron.
   await text.pressSequentially('!');
  }else{
   await rail.getByRole('button',{name:'Text',exact:true}).click();assert.equal(await text.inputValue(),caption+'!');
   const restored=await draft(page);assert.equal(currentRecipe(restored).caption?.text,caption+'!');assert.equal(currentRecipe(restored).rotate,90);assert.deepEqual(currentRecipe(restored).segments,[{in:1,out:3},{in:3,out:5},{in:5,out:6}]);
   if(pass===1){
    checks.push('Full native quit immediately after typing without blur restores exact caption, previous rotation and all three trimmed sections.');
    await rail.getByRole('button',{name:'Cut',exact:true}).click();await page.getByRole('button',{name:'Select region 1',exact:true}).click();
    const zoom=page.getByLabel('Timeline zoom',{exact:true});await zoom.focus();await zoom.press('Home');for(let i=0;i<9;i++)await zoom.press('ArrowRight');assert.equal(await zoom.inputValue(),'10');
    const beforeNavigation=await readHistory(page);
    for(const [key,selected,time] of [[']',1,3],[']',2,5],['[',1,3],['Home',1,3],['End',1,5],['Shift+Home',1,0],['ArrowDown',1,1],['Shift+End',1,6]] as const){
     await page.locator('.timeline-scroll').evaluate(element=>{element.scrollLeft=0;});await page.locator('#workspace-content').focus();await page.keyboard.press(key);
     await page.waitForFunction(expected=>Math.abs(Number(document.querySelector<HTMLInputElement>('.scrubber')?.value)-expected)<.002,time);
     assert.equal(await page.locator('.timeline-region[aria-pressed="true"]').getAttribute('data-region-index'),String(selected));await visiblePlayhead(page);
     assert.deepEqual(await readHistory(page),beforeNavigation,`Navigation ${key} must not mutate recipe history`);
    }
    await page.screenshot({path:path.join(directory,'zoomed-keyboard-navigation.png')});
    expectedHistory=beforeNavigation.history;expectedCursor=beforeNavigation.cursor;
    checks.push('Zoom10 keyboard section selection and edit-point/source-boundary jumps reveal the playhead; every jump preserves recipe and undo history.');
   }else{
    assert.deepEqual(restored.history,expectedHistory);assert.equal(restored.cursor,expectedCursor);await page.screenshot({path:path.join(directory,'second-relaunch.png')});
    checks.push('Second rapid native relaunch preserves exact caption and complete history after navigation-only changes.');
   }
  }
  assert.deepEqual(errors,[]);
 }catch(error){await page.screenshot({path:path.join(directory,`failure-${pass}.png`)}).catch(()=>{});await writeFile(path.join(directory,'failure.json'),JSON.stringify({pass,error:String(error),stack:error instanceof Error?error.stack:undefined,checks,errors,body:await page.locator('body').innerText().catch(()=>''),draft:storageKey?await draft(page).catch(()=>undefined):undefined},null,2));throw error;}
 finally{await app.close();}
 await assert.rejects(fetch(origin,{signal:AbortSignal.timeout(3000)}));
}
await writeFile(path.join(directory,'checks.json'),JSON.stringify({packaged:packaged||false,checks,errors},null,2));console.log(JSON.stringify({directory,checks,errors}));
