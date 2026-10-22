import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';
// @ts-expect-error Packaging helpers are plain JavaScript without declarations.
import {portableEnvironment} from '../scripts/portable-package-utils.mjs';

await mkdir('test-output/precision-editing-desktop',{recursive:true});
const directory=await mkdtemp(path.resolve('test-output/precision-editing-desktop/run-'));
const tools=await discoverTools(),fixture=path.join(directory,'Precision editing.mp4');
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
  if(pass===0){
   await page.locator('.app-header').getByRole('button',{name:'Import',exact:true}).click();await page.getByLabel('Local media').setInputFiles(fixture);
   const imports=page.getByRole('region',{name:'File imports'});await imports.getByText('1 of 1 ready',{exact:true}).waitFor();await imports.getByRole('button',{name:'Dismiss'}).click();await page.getByRole('button',{name:'Edit source',exact:true}).click();
  }
  await page.getByLabel('Source playback',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')!.readyState>=2);
  const field=(name:string)=>page.getByLabel(name,{exact:true});
  if(pass===0){
   const trim=page.getByRole('slider',{name:'Region 1 start trim handle',exact:true});const box=await trim.boundingBox();assert(box);
   await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+70,box.y+box.height/2,{steps:10});await page.keyboard.press('Escape');await page.mouse.move(box.x+box.width/2+90,box.y+box.height/2,{steps:3});await page.mouse.up();assert.equal(await field('Region 1 in timecode').inputValue(),'00:00:00.000');
   await trim.focus();await page.keyboard.press('ArrowRight');assert.notEqual(await field('Region 1 in timecode').inputValue(),'00:00:00.000');await page.getByRole('button',{name:'Undo',exact:true}).filter({visible:true}).click();assert.equal(await field('Region 1 in timecode').inputValue(),'00:00:00.000');
   checks.push('Native trim drag Escape cancels despite continued movement and release; a subsequent keyboard trim and Undo still work.');
  }
  await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Transform',exact:true}).click();
  if(pass===0){
   await page.getByRole('switch',{name:'Crop',exact:true}).click();
   await field('Crop width').focus();await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');await field('Crop width').pressSequentially('128');await field('Crop width').press('Enter');assert.equal(await field('Crop width').inputValue(),'128');
   await page.getByRole('button',{name:'Undo',exact:true}).filter({visible:true}).click();assert.equal(await field('Crop width').inputValue(),'320');await page.getByRole('button',{name:'Redo',exact:true}).filter({visible:true}).click();assert.equal(await field('Crop width').inputValue(),'128');
   await field('Crop width').fill('');await field('Crop width').press('Escape');assert.equal(await field('Crop width').inputValue(),'128');
   for(const [name,value] of [['Crop height','90'],['Crop x','20'],['Crop y','10']]){await field(name).fill(value);await field(name).press('Enter');assert.equal(await field(name).inputValue(),value);}
   await page.locator('.transform-inspector').getByRole('button',{name:'Rotate right',exact:true}).click();
   checks.push('Sequential crop typing commits the intended dimensions once; Undo/Redo and empty Escape preserve the correct crop.');
  }else{
   for(const [name,value] of [['Crop width','128'],['Crop height','90'],['Crop x','20'],['Crop y','10']])assert.equal(await field(name).inputValue(),value);
   assert.equal(await field('Output width').inputValue(),'90');assert.equal(await field('Output height').inputValue(),'128');
   await page.locator('.editor-review-export').click();const dialog=page.getByRole('dialog',{name:'Export media',exact:true});await dialog.getByRole('button',{name:'Resolve export plan',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('[aria-label="Export using reviewed plan"]') as HTMLButtonElement)?.disabled);await dialog.getByRole('button',{name:'Export using reviewed plan',exact:true}).click();await dialog.getByRole('status').filter({hasText:/^Export ready$/}).waitFor({timeout:60000});
   const jobs=await page.evaluate(async()=>await(await fetch('/api/v1/jobs')).json());assert.equal(jobs.length,1);assert.equal(jobs[0].state,'completed');assert.deepEqual(jobs[0].request.recipe.crop,{x:20,y:10,width:128,height:90});assert.equal(jobs[0].request.recipe.segments[0].in,0);
   const artifacts=await page.evaluate(async()=>await(await fetch('/api/v1/artifacts')).json());const output=artifacts.find((a:any)=>a.id===jobs[0].artifactId);assert(output?.validated);const video=output.media.streams.find((s:any)=>s.type==='video');assert.equal(video.width,90);assert.equal(video.height,128);
   await dialog.getByRole('button',{name:'Close export',exact:true}).click();await page.setViewportSize({width:390,height:844});await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Transform',exact:true}).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(directory,'mobile-precision.png')});
   checks.push('Full desktop restart retains the exact crop/rotation and uncancelled recipe; real export validates at90x128 and compact controls fit.');
  }
  assert.deepEqual(errors,[]);
 }catch(error){await page.screenshot({path:path.join(directory,'failure.png')});await writeFile(path.join(directory,'failure.json'),JSON.stringify({pass,error:String(error),stack:error instanceof Error?error.stack:undefined,checks,errors,body:await page.locator('body').innerText()},null,2));throw error;}
 finally{await app.close();}
 await assert.rejects(fetch(origin,{signal:AbortSignal.timeout(3000)}));
}
await writeFile(path.join(directory,'checks.json'),JSON.stringify({packaged:packaged||false,checks,errors},null,2));console.log(JSON.stringify({directory,checks,errors}));
