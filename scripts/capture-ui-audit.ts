import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';

const out=path.resolve('docs/ui-audit-2026-09-18');
await mkdir(path.join(out,'screenshots'),{recursive:true});
const app=await createServer({dataDir:path.resolve('test-output/ui-audit-'+Date.now()),ownerToken:globalThis.crypto.randomUUID()});
const token=randomUUID();const owner=app.store.users().find(u=>u.role==='owner')!;
app.store.token(owner.id,'Audit',['read','submit','manage'],token);
await app.listen({host:'127.0.0.1',port:0});
const addr=app.server.address() as {port:number};
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const evidence:any={date:new Date().toISOString(),viewport:{width:1440,height:900},screens:[],errors:[]};
page.on('pageerror',e=>evidence.errors.push(e.message));
const capture=async(name:string,fullPage=false)=>{await page.screenshot({path:path.join(out,'screenshots',name+'.png'),fullPage});evidence.screens.push({name,height:await page.evaluate(()=>document.documentElement.scrollHeight),text:await page.locator('main').innerText()});console.log('Captured '+name);};
try{
 await page.goto('http://127.0.0.1:'+addr.port);
 await page.getByLabel('Access token',{exact:true}).fill(token);
 await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.getByRole('heading',{name:'Import media'}).waitFor();
 await capture('01-import');
 await page.getByRole('button',{name:'Editor',exact:true}).click();await capture('02-editor-empty');
 await page.getByRole('button',{name:'Input',exact:true}).click();
 await page.getByLabel('Local media',{exact:true}).setInputFiles(path.resolve('test-output/fixtures/numbered-cfr.mp4'));
 await page.getByRole('heading',{name:'Editor · numbered-cfr.mp4'}).waitFor({timeout:45000});
 await page.waitForFunction(()=>{const imgs=[...document.querySelectorAll('img')];return imgs.length>=4&&imgs.every(i=>i.complete&&i.naturalWidth>0)});
 await page.locator('video').first().evaluate(async(v:HTMLVideoElement)=>{await v.play();v.pause();});
 await capture('03-editor-viewport');await capture('04-editor-full',true);
 await page.getByLabel('Segment 1 in (s)',{exact:true}).fill('0.5');
 await page.getByLabel('Segment 1 out (s)',{exact:true}).fill('1.5');
 await page.getByLabel('Compression mode',{exact:true}).selectOption('size');
 await page.getByLabel('Maximum output bytes',{exact:true}).fill('30000');
 await page.getByRole('button',{name:'Resolve export plan',exact:true}).click();
 await page.locator('.plan').waitFor();await page.locator('.plan').scrollIntoViewIfNeeded();await capture('05-export-plan');
 await page.getByRole('button',{name:'Export using reviewed plan',exact:true}).click();
 await page.getByRole('heading',{name:'Completed export previews'}).waitFor({timeout:60000});
 await page.getByRole('button',{name:'Preview video',exact:true}).click();
 await page.getByLabel('Rendered export preview',{exact:true}).waitFor({timeout:60000});
 await page.getByLabel('Rendered export preview',{exact:true}).evaluate((v:HTMLVideoElement)=>v.pause());
 await capture('06-rendered-preview');
 await page.getByRole('button',{name:'Close preview',exact:true}).click();
 await page.getByRole('button',{name:'Save project',exact:true}).click();
 for(const [i,name] of ['Queue','Library','Presets','Integrations','Settings','Administration'].entries()){
  await page.getByRole('button',{name,exact:true}).click();await page.waitForTimeout(300);await page.evaluate(()=>window.scrollTo(0,0));await capture(String(i+7).padStart(2,'0')+'-'+name.toLowerCase(),true);
 }
 await page.getByRole('button',{name:'Editor',exact:true}).click();
 evidence.returnedRegionStart=await page.getByLabel('Segment 1 in (s)',{exact:true}).inputValue();
 evidence.returnedRegionEnd=await page.getByLabel('Segment 1 out (s)',{exact:true}).inputValue();
 await page.getByLabel('Segment 1 in (s)',{exact:true}).fill('0.7');
 await page.getByRole('button',{name:'Queue',exact:true}).click();
 await page.getByRole('button',{name:'Editor',exact:true}).click();
 evidence.unsavedStartAfterNavigation=await page.getByLabel('Segment 1 in (s)',{exact:true}).inputValue();
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));await capture('13-editor-mobile',true);
 evidence.mobileOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 await writeFile(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2));
}finally{await browser.close();await app.close();}
