import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';
// @ts-expect-error Packaging helpers are plain JavaScript without declarations.
import {portableEnvironment} from '../scripts/portable-package-utils.mjs';

await mkdir('test-output/parallel-desktop',{recursive:true});
const directory=await mkdtemp(path.resolve('test-output/parallel-desktop/run-'));
const tools=await discoverTools(),fixture=path.join(directory,'Project acceptance.mp4');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=3','-c:v','libx264',fixture]);
const packaged=process.env.MW_TEST_PACKAGED_APP;
const environment:Record<string,string>=Object.fromEntries(Object.entries({...(packaged?portableEnvironment(process.env,directory):process.env),MW_PORTABLE_USER_DATA:path.join(directory,'profile'),MW_DATA_DIR:path.join(directory,'service')}).filter((entry):entry is [string,string]=>entry[1]!==undefined));
delete environment.ELECTRON_RUN_AS_NODE;
const launch=()=>electron.launch({executablePath:packaged||process.env.MW_TEST_ELECTRON,args:packaged?[]:['apps/desktop/main.cjs'],env:environment,timeout:70000});
const checks:string[]=[],errors:string[]=[];
let originalId='',copyId='',previewJobId='',origin='';
for(let pass=0;pass<2;pass++){
  const app=await launch();
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.getByRole('button',{name:'Library',exact:true}).waitFor();origin=new URL(page.url()).origin;
    if(pass===0){
      await page.locator('.app-header').getByRole('button',{name:'Import',exact:true}).click();
      await page.getByLabel('Local media').setInputFiles(fixture);
      await page.getByRole('region',{name:'File imports'}).getByText('1 of 1 ready',{exact:true}).waitFor();
      await page.getByRole('region',{name:'File imports'}).getByRole('button',{name:'Dismiss'}).click();
      await page.getByRole('button',{name:'Edit source',exact:true}).click();
      await page.locator('.scrubber').waitFor();
      await page.getByRole('button',{name:'Project saving',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'Save your edit',exact:true});
      await dialog.getByRole('textbox',{name:'Project name',exact:true}).fill('Original edit');
      await dialog.getByRole('button',{name:'Save project',exact:true}).click();
      await dialog.getByRole('status').filter({hasText:'Project saved: Original edit.'}).waitFor();
      originalId=await page.evaluate(async()=>(await(await fetch('/api/v1/projects')).json())[0].id);
      await dialog.getByRole('textbox',{name:'Copy name',exact:true}).fill('Alternate edit');
      await dialog.getByRole('button',{name:'Save a copy',exact:true}).click();
      await dialog.getByRole('status').filter({hasText:'Copy saved: Alternate edit.'}).waitFor();
      const projects=await page.evaluate(async()=>await(await fetch('/api/v1/projects')).json());
      assert.equal(projects.length,2);assert.equal(projects.find((p:any)=>p.id===originalId).name,'Original edit');
      copyId=projects.find((p:any)=>p.id!==originalId).id;
      await dialog.getByRole('button',{name:'Close project saving',exact:true}).click();
      const bounds=await page.locator('.scrubber').boundingBox();assert(bounds);
      await page.locator('.scrubber').click({position:{x:bounds.width/2,y:bounds.height/2}});
      await page.getByRole('button',{name:'Split',exact:true}).click();
      await page.waitForFunction(()=>document.querySelectorAll('.timeline-region').length===2);
      await page.getByRole('button',{name:'Project saving',exact:true}).click();
      await dialog.getByRole('button',{name:'Update project',exact:true}).click();
      await dialog.getByRole('status').filter({hasText:'Project saved: Original edit.'}).waitFor();
      const updated=await page.evaluate(async()=>await(await fetch('/api/v1/projects')).json());
      assert.equal(updated.length,2);assert.equal(updated.find((p:any)=>p.id===originalId).recipe.segments.length,2);assert.equal(updated.find((p:any)=>p.id===copyId).recipe.segments.length,1);
      await dialog.getByRole('button',{name:'Close project saving',exact:true}).click();
      checks.push('Native Project controls create an original, save a distinct copy, and update only the original with two edited sections.');
    }else{
      await page.locator('.scrubber').waitFor();
      assert.equal(await page.locator('.timeline-region').count(),2);
      await page.getByRole('button',{name:'Project saving',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'Save your edit',exact:true});
      assert.equal(await dialog.getByRole('textbox',{name:'Project name',exact:true}).inputValue(),'Original edit');
      await dialog.getByRole('button',{name:'Update project',exact:true}).waitFor();
      await dialog.getByRole('button',{name:'Close project saving',exact:true}).click();
      checks.push('Full desktop restart restores the active original project, its name and two edited sections.');
    }
    await page.getByRole('button',{name:'Render edited preview',exact:true}).click();
    const preview=page.getByRole('dialog',{name:'Export preview',exact:true});
    await preview.getByLabel('Rendered export preview',{exact:true}).waitFor({timeout:60000});
    await page.waitForFunction(()=>{const video=document.querySelector('dialog video') as HTMLVideoElement;return video?.readyState>=2;});
    const jobs=await page.evaluate(async()=>(await(await fetch('/api/v1/jobs')).json()).filter((j:any)=>j.request.type==='export'));
    assert.equal(jobs.length,1);assert.equal(jobs[0].state,'completed');
    if(pass===0)previewJobId=jobs[0].id;else assert.equal(jobs[0].id,previewJobId);
    checks.push(pass===0?'Real edited preview produces one validated export.':'Restart reopens the same playable rendered job without submitting another export.');
    await page.screenshot({path:path.join(directory,`preview-${pass}.png`)});
    if(pass===1){
      await preview.getByRole('button',{name:'Close preview',exact:true}).click();
      await page.setViewportSize({width:390,height:844});
      await page.locator('.cut-precision > summary').click();
      await page.getByRole('button',{name:'Render preview',exact:true}).focus();
      await page.keyboard.press('Enter');
      await preview.getByLabel('Rendered export preview',{exact:true}).waitFor();
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert(await preview.evaluate(element=>element.scrollWidth<=element.clientWidth));
      const box=await preview.boundingBox();assert(box);assert(box.x>=0&&box.x+box.width<=391);
      await page.screenshot({path:path.join(directory,'mobile-preview.png')});
      await page.keyboard.press('Escape');await preview.waitFor({state:'hidden'});
      assert.equal(await page.evaluate(async()=>(await(await fetch('/api/v1/jobs')).json()).filter((job:any)=>job.request.type==='export').length),1);
      checks.push('Styled mobile preview opens through playback options by keyboard, fits the viewport and closes with Escape without duplicate work.');
    }
    assert.deepEqual(errors,[]);
  }catch(error){await page.screenshot({path:path.join(directory,'failure.png')});await writeFile(path.join(directory,'failure.json'),JSON.stringify({pass,error:String(error),checks,errors,body:await page.locator('body').innerText()},null,2));throw error;}
  finally{await app.close();}
  await assert.rejects(fetch(origin,{signal:AbortSignal.timeout(3000)}));
}
await writeFile(path.join(directory,'checks.json'),JSON.stringify({packaged:packaged||false,checks,errors,originalId,copyId,previewJobId},null,2));
console.log(JSON.stringify({directory,checks,errors}));
