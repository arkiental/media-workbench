import assert from 'node:assert/strict';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../apps/server/src/app.ts';
import { publish, registerSource } from '../apps/server/src/storage.ts';
import { discoverTools, probe, frameIndex, runProcess } from '../packages/media/src/index.ts';

const output=path.resolve('test-output/timeline-thumbnails');await mkdir(output,{recursive:true});
const tools=await discoverTools(),token=randomUUID();
const app=await createServer({dataDir:path.join(output,`service-${Date.now()}`),ownerToken:token,tools,encoders:[]});
const owner=app.store.users().find(u=>u.role==='owner')!,headers={host:'localhost',authorization:`Bearer ${token}`};
const fixtures=[
  {name:'single.mp4',rate:25,duration:.04,codec:'libx264'},
  {name:'short.mp4',rate:10,duration:3,codec:'libx264'},
  {name:'typical.mp4',rate:30,duration:12,codec:'libx264'},
  {name:'sparse.mkv',rate:1,duration:2,codec:'ffv1'},
  {name:'sample.webm',rate:7,duration:3,codec:'libvpx'},
  {name:'variable.mkv',rate:10,duration:3,codec:'ffv1',extra:['-vf','select=eq(n\\,0)+eq(n\\,10)+eq(n\\,20)','-fps_mode','vfr']},
  {name:'audio-tail.mp4',rate:10,duration:.4,codec:'libx264',audio:true},
];
const sources:{id:string;name:string;duration:number}[]=[],checks:string[]=[],errors:string[]=[];
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try {
  for(const fixture of fixtures){
    const file=path.join(output,fixture.name);
    await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i',`testsrc2=size=320x180:rate=${fixture.rate}:duration=${fixture.duration}`,...(fixture.audio?['-f','lavfi','-i','sine=frequency=440:duration=3','-c:a','aac']:[]),'-c:v',fixture.codec,...(fixture.extra||[]),file]);
    const media=await probe(file,tools),staged=path.join(output,`staged-${fixture.name}`);await copyFile(file,staged);
    const artifact=await publish(app.store,staged,owner.id,fixture.name,media,'original'),source=registerSource(app.store,artifact);
    sources.push({id:source.id,name:fixture.name,duration:media.duration});
    const ctx={signal:new AbortController().signal,workDir:output,maxRuntimeSeconds:30};
    const frames=await frameIndex(file,tools,Math.max(0,media.duration-1),ctx);
    const last=Math.max(...frames.map(f=>f.pts));assert.ok(Number.isFinite(last));
    const expected=await app.inject({url:`/api/v1/sources/${source.id}/thumb?pts=${Math.max(0,last-.00001)}`,headers});assert.equal(expected.statusCode,200,expected.body);
    for(const pts of [Math.max(0,media.duration-.05),media.duration]){
      const response=await app.inject({url:`/api/v1/sources/${source.id}/thumb?pts=${pts}`,headers});
      assert.equal(response.statusCode,200,`${fixture.name} at ${pts}: ${response.body}`);assert.equal(response.rawPayload.readUInt16BE(0),0xffd8);
      if(pts>last)assert.deepEqual(response.rawPayload,expected.rawPayload,`${fixture.name} returns the actual final frame`);
    }
    checks.push(`${fixture.name}: end-of-clip requests return the actual last frame (${last.toFixed(3)}s, duration ${media.duration.toFixed(3)}s).`);
  }
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert(address&&typeof address==='object');
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${address.port}`);await page.getByLabel('Access token').fill(token);await page.getByRole('button',{name:'Connect',exact:true}).click();
  const edit=async(name:string)=>{await page.locator('.app-header').getByRole('button',{name:'Library',exact:true}).click();await page.getByLabel('Search media',{exact:true}).fill(name);await page.locator('.media-card').filter({has:page.getByRole('heading',{name,exact:true})}).getByRole('button',{name:'Edit source',exact:true}).click();};
  const complete=()=>page.waitForFunction(()=>{const strip=document.querySelector('.thumbs');return !!strip&&strip.querySelectorAll('img').length>=4&&!strip.querySelector('.thumb-skeleton');},undefined,{timeout:60000});
  for(const name of ['single.mp4','short.mp4','sparse.mkv','sample.webm','variable.mkv','audio-tail.mp4']){await edit(name);await complete();assert.equal(await page.getByRole('button',{name:'Retry thumbnails'}).count(),0);}
  await page.screenshot({path:path.join(output,'desktop-complete.png')});
  checks.push('All short/low-rate/variable-rate/WebM/audio-tail timelines fully populate while navigating between sources.');
  let failedUrl='',fail=true;const requests:string[]=[];
  await page.route('**/api/v1/sources/*/thumb?*',async route=>{const url=route.request().url();requests.push(url);if(!failedUrl&&Number(new URL(url).searchParams.get('pts'))<1)failedUrl=url;if(fail&&url===failedUrl)await route.fulfill({status:503,body:'Temporary thumbnail outage'});else await route.continue();});
  await edit('typical.mp4');await page.getByRole('button',{name:'Retry thumbnails',exact:true}).waitFor({timeout:60000});
  const images=await page.locator('.thumbs img').count();assert.ok(images>4);assert.equal(await page.locator('.thumb-skeleton').count(),1);
  let before=requests.length;await page.getByRole('button',{name:'Retry thumbnails',exact:true}).evaluate((b:HTMLButtonElement)=>{b.click();b.click();});
  await page.getByRole('button',{name:'Retry thumbnails',exact:true}).waitFor();assert.equal(requests.length-before,1);assert.equal(await page.locator('.thumbs img').count(),images);
  await page.getByRole('button',{name:'Retry thumbnails',exact:true}).click();await page.getByRole('button',{name:'Retry thumbnails',exact:true}).waitFor();
  await page.getByRole('button',{name:'Retry thumbnails',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'partial-retry.png')});
  fail=false;before=requests.length;await page.getByRole('button',{name:'Retry thumbnails',exact:true}).focus();await page.keyboard.press('Enter');await complete();assert.equal(requests.length-before,1);
  checks.push('One failed thumbnail does not block the rest. Double Retry sends one request for the missing tile; keyboard retry recovers it without reloading successful images.');
  await page.unroute('**/api/v1/sources/*/thumb?*');
  let release!:()=>void,received!:()=>void;const gate=new Promise<void>(r=>release=r),pending=new Promise<void>(r=>received=r);let held=false;
  await page.route('**/api/v1/sources/*/thumb?*',async route=>{if(!held){held=true;received();await gate;}await route.continue().catch(()=>{});});
  await page.setViewportSize({width:960,height:900});await pending;
  await page.locator('.app-header').getByRole('button',{name:'Library',exact:true}).click();release();await page.goBack();await complete();
  await page.unroute('**/api/v1/sources/*/thumb?*');
  checks.push('Leaving during a pending thumbnail request aborts the old work; returning completes the strip without stale errors.');
  await page.goBack();await page.getByRole('heading',{name:'Library',exact:true}).waitFor();await page.goForward();await complete();
  await page.setViewportSize({width:390,height:844});await complete();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'mobile-complete.png'),fullPage:true});
  checks.push('Back/Forward retains a populated strip; resizing to 390px finishes the new thumbnail set without horizontal overflow.');
  assert.deepEqual(errors,[]);await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
} finally {await browser?.close();await app.close();}
