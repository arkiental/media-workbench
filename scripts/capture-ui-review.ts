import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';

// Captures the main screens for visual review. Usage: tsx scripts/capture-ui-review.ts <out-dir>
const out=path.resolve(process.argv[2]||'test-output/ui-review');
await mkdir(out,{recursive:true});
const token=randomUUID();
const app=await createServer({dataDir:path.resolve('test-output/ui-review-data-'+Date.now()),ownerToken:token});
await app.listen({host:'127.0.0.1',port:0});
const origin='http://127.0.0.1:'+(app.server.address() as {port:number}).port;
const browser=await chromium.launch({channel:process.env.MW_BROWSER_CHANNEL||'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
const shot=async(name:string,fullPage=false)=>{await page.waitForTimeout(250);await page.screenshot({path:path.join(out,name+'.png'),fullPage});console.log('Captured '+name);};
try{
  await page.goto(origin);await shot('00-login');
  await page.getByLabel('Access token',{exact:true}).fill(token);await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.getByRole('heading',{name:'Choose a video to edit'}).waitFor();await shot('01-editor-empty');
  await page.getByRole('banner').getByRole('button',{name:'Add media',exact:true}).click();await page.getByRole('heading',{name:'Import media'}).waitFor();await shot('02-import');
  await page.getByLabel('Local media',{exact:true}).setInputFiles(path.resolve('test-output/fixtures/numbered-cfr.mp4'));
  await page.getByRole('heading',{name:'Editor · numbered-cfr.mp4'}).waitFor({timeout:45000});
  await page.waitForFunction(()=>{const images=[...document.querySelectorAll<HTMLImageElement>('img[alt^="Source thumbnail"]')];return images.length===4&&images.every(i=>i.complete&&i.naturalWidth>0);},undefined,{timeout:30000}).catch(()=>{});
  await page.waitForTimeout(1500);await shot('03-editor-cut');
  for(const tool of ['Text','Audio','Transform']){await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:tool,exact:true}).click();await shot('04-editor-'+tool.toLowerCase());}
  await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Cut',exact:true}).click();
  await page.locator('.cut-precision > summary').click();await shot('04-editor-options');await page.locator('.cut-precision > summary').click();
  await page.getByRole('button',{name:'Export…'}).click();await shot('05-export-dialog');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Render edited preview'}).click();await page.getByLabel('Rendered export preview',{exact:true}).waitFor({timeout:60000}).catch(()=>{});await shot('05-rendered-preview');
  await page.getByRole('dialog',{name:'Export preview'}).getByRole('button',{name:'Close preview'}).click();
  await page.getByRole('button',{name:'Library',exact:true}).click();await page.waitForTimeout(800);await shot('06-library',true);
  await page.getByRole('button',{name:'Jobs',exact:true}).click();await page.waitForTimeout(500);await shot('07-jobs',true);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await shot('08-settings',true);
  await page.getByRole('button',{name:'Editor',exact:true}).click();await page.waitForTimeout(800);
  await page.setViewportSize({width:1100,height:760});await shot('09-editor-1100');
  await page.setViewportSize({width:390,height:844});await shot('10-editor-mobile',true);
  console.log('Page errors:',errors.length?errors:'none');
}finally{await browser.close();await app.close();}
