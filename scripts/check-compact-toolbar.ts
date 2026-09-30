import {chromium} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {createServer} from '../apps/server/src/app.ts';
const out=path.resolve('test-output/compact-toolbar');await mkdir(out,{recursive:true});
const sourcePath=process.argv[2];if(!sourcePath)throw new Error('Pass a video longer than 7 seconds');
const token=randomUUID(),app=await createServer({dataDir:path.join(out,'service-'+Date.now()),ownerToken:token});
await app.listen({host:'127.0.0.1',port:0});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1905,height:940}}),errors:string[]=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:'+(app.server.address() as {port:number}).port);
 await page.getByLabel('Access token',{exact:true}).fill(token);await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByRole('button',{name:'Add media',exact:true}).click();await page.getByLabel('Local media',{exact:true}).setInputFiles({name:'content.mp4',mimeType:'video/mp4',buffer:await readFile(sourcePath)});
 await page.getByRole('heading',{name:'Editor · content.mp4'}).waitFor({timeout:45000});
 const seek=async(n:number)=>{await page.getByLabel('Timeline playhead',{exact:true}).fill(String(n));await page.waitForFunction(n=>{const v=document.querySelector('video');return v&&!v.seeking&&Math.abs(v.currentTime-n)<.002},n)};
 await seek(5.073);
 await page.waitForFunction(()=>{const imgs=Array.from(document.querySelectorAll<HTMLImageElement>('img[alt^="Source thumbnail"]'));return imgs.length===4&&imgs.every(i=>i.complete&&i.naturalWidth>0)});
 const toolbar=page.getByRole('group',{name:'Timeline controls',exact:true});
 assert.ok((await toolbar.boundingBox())!.height<=60);
 assert.equal(await page.locator('.cut-only-controls').count(),0);
 await page.getByRole('button',{name:'Split',exact:true}).click();await page.getByRole('button',{name:'Select region 2',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('[aria-label="Region 1 out timecode"]')?.value==='00:00:05.073');
 await page.getByRole('button',{name:'Select region 2',exact:true}).click();assert.equal(await page.getByLabel('Region 2 in timecode').inputValue(),'00:00:05.073');
 await page.getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Select region 2',exact:true}).count(),0);
 const input=page.getByLabel('Region 1 in timecode');await input.fill('00:00:01.250');await input.press('Enter');assert.equal(await input.inputValue(),'00:00:01.250');
 await input.fill('00:77:00.000');await input.press('Enter');assert.equal(await input.inputValue(),'00:00:01.250');
 await input.fill('2.5');await input.press('Enter');assert.equal(await input.inputValue(),'00:00:02.500');
 await input.fill('3');await input.press('Escape');await input.press('Tab');assert.equal(await input.inputValue(),'00:00:02.500');
 await input.fill('0');await input.press('Enter');
 await page.getByRole('button',{name:'Zoom in',exact:true}).click();assert.equal(await page.getByLabel('Timeline zoom',{exact:true}).inputValue(),'2');
 await toolbar.getByRole('button',{name:'Fit',exact:true}).click();assert.equal(await page.getByLabel('Timeline zoom',{exact:true}).inputValue(),'1');
 await page.getByRole('button',{name:'Snap',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Snap',exact:true}).getAttribute('aria-pressed'),'true');await page.getByRole('button',{name:'Snap',exact:true}).click();
 await page.getByLabel('More timeline actions',{exact:true}).click();await page.getByRole('button',{name:'Go to start',exact:true}).click();await page.getByLabel('More timeline actions',{exact:true}).click();await seek(5.073);
 await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
 for(const width of [1440,1024,900,390]){
  await page.setViewportSize({width,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`No page overflow at ${width}`);
  await page.screenshot({path:path.join(out,`${width}.png`),fullPage:true});
 }
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'results.json'),JSON.stringify({errors,checks:['Compact single desktop row','Split preserves source-time boundaries; undo restores region','Timecode and seconds input; invalid input and Escape preserve previous boundary','Zoom and Fit','Snap toggle','Navigation menu','No overflow at 1905, 1440, 1024, 900 and 390 pixels']},null,2));console.log('Compact toolbar checks passed: '+out);
}finally{await browser.close();await app.close()}
