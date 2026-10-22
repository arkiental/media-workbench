import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';
// @ts-expect-error Packaging helpers are plain JavaScript without declarations.
import {portableEnvironment} from '../scripts/portable-package-utils.mjs';

await mkdir('test-output/audio-editing-desktop',{recursive:true});
const directory=await mkdtemp(path.resolve('test-output/audio-editing-desktop/run-'));
const tools=await discoverTools(),fixture=path.join(directory,'Audio editing.mp4');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=6','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=6','-c:v','libx264','-c:a','aac',fixture]);
const packaged=process.env.MW_TEST_PACKAGED_APP;
const environment:Record<string,string>=Object.fromEntries(Object.entries({...(packaged?portableEnvironment(process.env,directory):process.env),MW_PORTABLE_USER_DATA:path.join(directory,'profile'),MW_DATA_DIR:path.join(directory,'service')}).filter((entry):entry is [string,string]=>entry[1]!==undefined));
delete environment.ELECTRON_RUN_AS_NODE;
const checks:string[]=[],errors:string[]=[];
for(let pass=0;pass<2;pass++){
 const app=await electron.launch({executablePath:packaged||process.env.MW_TEST_ELECTRON,args:packaged?[]:['apps/desktop/main.cjs'],env:environment,timeout:70000});
 const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));let origin='';
 try{
  await page.getByRole('button',{name:'Library',exact:true}).waitFor();origin=new URL(page.url()).origin;
  await page.addInitScript(()=>{
   const state={bindings:[] as {element:HTMLMediaElement;context:AudioContext}[],gains:[] as GainNode[],closed:0};(window as any).__audioCheck=state;
   const source=AudioContext.prototype.createMediaElementSource,gain=AudioContext.prototype.createGain,close=AudioContext.prototype.close;
   AudioContext.prototype.createMediaElementSource=function(element){const node=source.call(this,element);state.bindings.push({element,context:this});return node;};
   AudioContext.prototype.createGain=function(){const node=gain.call(this);state.gains.push(node);return node;};
   AudioContext.prototype.close=function(){state.closed++;return close.call(this);};
  });
  await page.reload();await page.getByRole('button',{name:'Library',exact:true}).waitFor();
  if(pass===0){
   await page.locator('.app-header').getByRole('button',{name:'Import',exact:true}).click();await page.getByLabel('Local media').setInputFiles(fixture);
   const imports=page.getByRole('region',{name:'File imports'});await imports.getByText('1 of 1 ready',{exact:true}).waitFor();await imports.getByRole('button',{name:'Dismiss'}).click();
   await page.getByRole('button',{name:'Edit source',exact:true}).click();
  }
  await page.getByLabel('Source playback',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')!.readyState>=2);
  await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Audio',exact:true}).click();
  const number=page.getByLabel('Volume multiplier',{exact:true});await number.waitFor();
  if(pass===0){
   const range=page.getByRole('slider',{name:'Volume slider',exact:true}),box=await range.boundingBox();assert(box);
   await page.mouse.move(box.x+box.width*.5,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.8,box.y+box.height/2,{steps:20});await page.mouse.up();
   assert(Number(await number.inputValue())>1.4);await page.getByRole('button',{name:'Undo',exact:true}).filter({visible:true}).click();assert.equal(await number.inputValue(),'1');
   await number.fill('0.5');await number.press('Enter');assert.equal(await number.inputValue(),'0.5');
   await number.fill('');await number.press('Escape');assert.equal(await number.inputValue(),'0.5');
   checks.push('Native volume drag is one undo step; decimal entry commits and Escape cancels an empty edit.');
  }else{
   assert.equal(await number.inputValue(),'0.5');checks.push('Full desktop restart restores the committed audio level.');
  }
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.waitForFunction(()=>{const s=(window as any).__audioCheck;return s.bindings.some((b:any)=>b.element===document.querySelector('video[aria-label="Source playback"]'))&&s.gains.some((g:GainNode)=>Math.abs(g.gain.value-.5)<.001);});
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  if(pass===0){
   await page.getByLabel('Source playback',{exact:true}).dispatchEvent('error');await page.getByRole('button',{name:'Retry playback',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')!.readyState>=2);
   await page.getByRole('button',{name:'Play',exact:true}).click();
   await page.waitForFunction(()=>{const s=(window as any).__audioCheck;return s.bindings.length>=2&&s.bindings.at(-1).element===document.querySelector('video[aria-label="Source playback"]')&&Math.abs(s.gains.at(-1).gain.value-.5)<.001&&s.closed>=1;});
   await page.getByRole('button',{name:'Pause',exact:true}).click();checks.push('Actual native AudioContext is rebound after playback retry, retaining half-volume and closing the obsolete context.');
  }else{
   await page.locator('.editor-review-export').click();const dialog=page.getByRole('dialog',{name:'Export media',exact:true});await dialog.getByRole('button',{name:'Resolve export plan',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('[aria-label="Export using reviewed plan"]') as HTMLButtonElement)?.disabled);await dialog.getByRole('button',{name:'Export using reviewed plan',exact:true}).click();await dialog.getByRole('status').filter({hasText:/^Export ready$/}).waitFor({timeout:60000});
   const jobs=await page.evaluate(async()=>await(await fetch('/api/v1/jobs')).json());assert.equal(jobs.length,1);assert.equal(jobs[0].state,'completed');assert.equal(jobs[0].request.recipe.audio.volume,.5);
   const artifacts=await page.evaluate(async()=>await(await fetch('/api/v1/artifacts')).json());assert(artifacts.find((a:any)=>a.id===jobs[0].artifactId)?.media.streams.some((s:any)=>s.type==='audio'));
   await dialog.getByRole('button',{name:'Close export',exact:true}).click();
   await page.setViewportSize({width:390,height:844});await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Audio',exact:true}).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(directory,'mobile-audio.png')});
   checks.push('Restored audio settings produce a real completed export with audio; compact audio controls fit without horizontal overflow.');
  }
  if(pass===0){await page.getByRole('button',{name:'Library',exact:true}).click();await page.waitForFunction(()=>{const s=(window as any).__audioCheck;return s.closed===s.bindings.length;});await page.getByRole('button',{name:'Edit source',exact:true}).click();await page.locator('.scrubber').waitFor();checks.push('Leaving Editor releases the audio contexts and returning keeps committed edits.');}
  assert.deepEqual(errors,[]);
 }catch(error){await page.screenshot({path:path.join(directory,'failure.png')});await writeFile(path.join(directory,'failure.json'),JSON.stringify({pass,error:String(error),stack:error instanceof Error?error.stack:undefined,checks,errors,body:await page.locator('body').innerText()},null,2));throw error;}
 finally{await app.close();}
 await assert.rejects(fetch(origin,{signal:AbortSignal.timeout(3000)}));
}
await writeFile(path.join(directory,'checks.json'),JSON.stringify({packaged:packaged||false,checks,errors},null,2));console.log(JSON.stringify({directory,checks,errors}));
