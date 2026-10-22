import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright';
import {mkdir,mkdtemp,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';
// @ts-expect-error Packaging helpers are plain JavaScript without declarations.
import {portableEnvironment} from '../scripts/portable-package-utils.mjs';

await mkdir('test-output/saved-workflows-desktop',{recursive:true});
const directory=await mkdtemp(path.resolve('test-output/saved-workflows-desktop/run-'));
const tools=await discoverTools(),first=path.join(directory,'First source.mp4'),second=path.join(directory,'Second source.mp4');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=3','-c:v','libx264',first]);await copyFile(first,second);
const packaged=process.env.MW_TEST_PACKAGED_APP;
const environment:Record<string,string>=Object.fromEntries(Object.entries({...(packaged?portableEnvironment(process.env,directory):process.env),MW_PORTABLE_USER_DATA:path.join(directory,'profile'),MW_DATA_DIR:path.join(directory,'service')}).filter((entry):entry is [string,string]=>entry[1]!==undefined));
delete environment.ELECTRON_RUN_AS_NODE;
const launch=()=>electron.launch({executablePath:packaged||process.env.MW_TEST_ELECTRON,args:packaged?[]:['apps/desktop/main.cjs'],env:environment,timeout:70000});
const checks:string[]=[],errors:string[]=[];
let origin='';
for(let pass=0;pass<2;pass++){
 const app=await launch(),page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.getByRole('button',{name:'Library',exact:true}).waitFor();origin=new URL(page.url()).origin;
  const upload=async(file:string)=>{await page.locator('.app-header').getByRole('button',{name:'Import',exact:true}).click();await page.getByLabel('Local media').setInputFiles(file);await page.getByRole('region',{name:'File imports'}).getByText('1 of 1 ready',{exact:true}).waitFor();await page.getByRole('region',{name:'File imports'}).getByRole('button',{name:'Dismiss'}).click();};
  const dialog=page.getByRole('dialog',{name:'Export media',exact:true});
  if(pass===0){
   await upload(first);await page.getByRole('button',{name:'Edit source',exact:true}).click();await page.locator('.scrubber').waitFor();
   await page.locator('.editor-review-export').click();
   await dialog.getByLabel('Export name',{exact:true}).fill('First custom filename');
   await dialog.getByLabel('Output goal',{exact:true}).selectOption('size');await dialog.getByLabel('Maximum size (MB)',{exact:true}).fill('1');
   await dialog.getByText('Advanced encoding settings',{exact:true}).click();await dialog.getByLabel('Cutting strategy',{exact:true}).selectOption('exact');
   await dialog.getByText('Save settings as preset',{exact:true}).click();await dialog.getByLabel('Preset name',{exact:true}).fill('Small exact clips');await dialog.getByRole('button',{name:'Save preset',exact:true}).click();
   await dialog.getByRole('status').filter({hasText:'Preset saved: Small exact clips.'}).waitFor();
   const presets=await page.evaluate(async()=>await(await fetch('/api/v1/presets')).json());assert.equal(presets.length,1);assert.equal(presets[0].preset.options.fileName,undefined);assert.equal(presets[0].preset.options.maxBytes,1000000);assert.equal(presets[0].preset.options.cut,'exact');
   await dialog.getByRole('button',{name:'Close export',exact:true}).click();
   await page.getByRole('button',{name:'Project saving',exact:true}).click();const project=page.getByRole('dialog',{name:'Save your edit',exact:true});await project.getByLabel('Project name',{exact:true}).fill('Original project');await project.getByRole('button',{name:'Save project',exact:true}).click();await project.getByRole('status').filter({hasText:'Project saved: Original project.'}).waitFor();
   await project.getByLabel('Copy name',{exact:true}).fill('Alternate project');await project.getByRole('button',{name:'Save a copy',exact:true}).click();await project.getByRole('status').filter({hasText:'Copy saved: Alternate project.'}).waitFor();await project.getByRole('button',{name:'Close project saving',exact:true}).click();
   await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator('.library-projects > summary').click();await page.getByLabel('Search saved projects',{exact:true}).fill('Alternate');
   const row=page.getByRole('article',{name:'Project Alternate project',exact:true});await row.waitFor();assert.equal(await page.locator('.project-row').count(),1);assert((await row.innerText()).includes('First source.mp4'));await row.getByRole('button',{name:'Load project',exact:true}).click();await page.locator('.scrubber').waitFor();
   await page.getByRole('button',{name:'Project saving',exact:true}).click();assert.equal(await project.getByLabel('Project name',{exact:true}).inputValue(),'Alternate project');await project.getByRole('button',{name:'Close project saving',exact:true}).click();
   checks.push('Native saved-project search identifies the source and opens the matching named copy.');
   await upload(second);await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator('.media-card').filter({has:page.getByRole('heading',{name:'Second source.mp4',exact:true})}).getByRole('button',{name:'Edit source',exact:true}).click();await page.locator('.scrubber').waitFor();
   await page.locator('.editor-review-export').click();await dialog.getByLabel('Export name',{exact:true}).fill('Second custom filename');await dialog.getByLabel('Apply portable preset',{exact:true}).selectOption({label:'Small exact clips'});
   assert.equal(await dialog.getByLabel('Export name',{exact:true}).inputValue(),'Second custom filename');assert.equal(await dialog.getByLabel('Output goal',{exact:true}).inputValue(),'size');assert.equal(await dialog.getByLabel('Maximum size (MB)',{exact:true}).inputValue(),'1');
   checks.push('A named export preset is saved without a source filename and applies its size settings to another source while retaining that source filename.');
  }else{
   await page.locator('.scrubber').waitFor();await page.locator('.editor-review-export').click();assert.equal(await dialog.getByLabel('Export name',{exact:true}).inputValue(),'Second custom filename');
   await dialog.getByLabel('Apply portable preset',{exact:true}).selectOption({label:'Small exact clips'});assert.equal(await dialog.getByLabel('Export name',{exact:true}).inputValue(),'Second custom filename');
   await dialog.getByRole('button',{name:'Resolve export plan',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('[aria-label="Export using reviewed plan"]') as HTMLButtonElement)?.disabled);await dialog.getByRole('button',{name:'Export using reviewed plan',exact:true}).click();await dialog.getByRole('status').filter({hasText:/^Export ready$/}).waitFor({timeout:60000});
   const jobs=await page.evaluate(async()=>await(await fetch('/api/v1/jobs')).json());assert.equal(jobs.length,1);assert.equal(jobs[0].state,'completed');assert.equal(jobs[0].request.options.cut,'exact');assert.equal(jobs[0].request.options.maxBytes,1000000);
   const artifacts=await page.evaluate(async()=>await(await fetch('/api/v1/artifacts')).json());const output=artifacts.find((item:any)=>item.id===jobs[0].artifactId);assert.equal(output.name,'Second custom filename.mp4');assert(output.validated);assert(output.bytes<=1000000);
   await dialog.getByRole('button',{name:'Close export',exact:true}).click();await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator('.library-projects > summary').click();assert.equal(await page.getByLabel('Search saved projects',{exact:true}).inputValue(),'Alternate');await page.getByRole('article',{name:'Project Alternate project',exact:true}).waitFor();
   await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(directory,'mobile-project-search.png')});
   checks.push('Full packaged restart retains preset and separate project search; actual exact export meets the saved size limit with the current filename.');
  }
  assert.deepEqual(errors,[]);
 }catch(error){await page.screenshot({path:path.join(directory,'failure.png')});await writeFile(path.join(directory,'failure.json'),JSON.stringify({pass,error:String(error),stack:error instanceof Error?error.stack:undefined,checks,errors,body:await page.locator('body').innerText()},null,2));throw error;}
 finally{await app.close();}
 await assert.rejects(fetch(origin,{signal:AbortSignal.timeout(3000)}));
}
await writeFile(path.join(directory,'checks.json'),JSON.stringify({packaged:packaged||false,checks,errors},null,2));console.log(JSON.stringify({directory,checks,errors}));
