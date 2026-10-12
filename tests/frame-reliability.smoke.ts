import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,type Page} from 'playwright';
import {createServer} from '../apps/server/src/app.ts';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';

await mkdir(path.resolve('test-output'),{recursive:true});
const output=await mkdtemp(path.resolve('test-output/frame-reliability-')),fixture=path.resolve('test-output/fixtures/numbered-cfr.mp4'),tools=await discoverTools();
const token=randomUUID(),app=await createServer({dataDir:path.join(output,'service'),ownerToken:token,encoders:[],tools});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,page:Page|undefined;
const checks:string[]=[],pageErrors:string[]=[];
try{
  const upload=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{host:'localhost',authorization:`Bearer ${token}`,'content-type':'application/octet-stream','x-filename':'Frame sample.mp4'},payload:await readFile(fixture)});
  assert.equal(upload.statusCode,200,upload.body);
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  browser=await chromium.launch({channel:process.env.MW_BROWSER_CHANNEL||'msedge',headless:true});page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',error=>pageErrors.push(error.message));
  assert.equal((await page.request.post(`${origin}/api/v1/session`,{data:{token}})).status(),200);await page.goto(origin);
  await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator('.media-card').filter({has:page.getByRole('heading',{name:'Frame sample.mp4',exact:true})}).getByRole('button',{name:'Edit source',exact:true}).click();
  await page.getByRole('heading',{name:/Editor .*Frame sample\.mp4/}).waitFor();await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')!.readyState>=2);
  await page.getByLabel('Timeline playhead',{exact:true}).fill('1.1');await page.waitForFunction(()=>Math.abs(document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')!.currentTime-1.1)<.002);
  let attempts=0,releaseFirst!:()=>void,firstSeen!:()=>void;const gate=new Promise<void>(resolve=>releaseFirst=resolve),seen=new Promise<void>(resolve=>firstSeen=resolve);const frameRoute=/\/api\/v1\/sources\/[^/]+\/frame\?/;
  await page.route(frameRoute,async route=>{attempts++;if(attempts<=4){if(attempts===1){firstSeen();await gate;}await route.fulfill({status:429,contentType:'application/json',headers:{'retry-after':'0'},body:JSON.stringify({error:'Two preview/inspection operations already active'})});}else await route.continue();});
  const precision=page.locator('.cut-precision');await precision.locator(':scope > summary').click();await precision.getByRole('button',{name:'Inspect source frame',exact:true}).click();await precision.locator(':scope > summary').click();await seen;
  const status=page.locator('.source-frame-status');await status.getByText('Loading source frame…',{exact:true}).waitFor();await status.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'mobile-loading.png')});checks.push('Mobile source-frame loading is visible without page overflow');releaseFirst();
  const error=page.getByRole('alert').filter({hasText:'The preview is still busy. Try again.'});await error.waitFor();assert.equal(attempts,4);const retry=error.getByRole('button',{name:'Retry frame',exact:true});await retry.scrollIntoViewIfNeeded();const retryBox=await retry.boundingBox();assert.ok(retryBox&&retryBox.width>=44&&retryBox.height>=44,JSON.stringify(retryBox));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'mobile-error.png')});checks.push('Four busy responses stop automatically and expose an accessible44px Retry frame action on mobile');
  await retry.click();const image=page.getByAltText('Source decoded frame at 1.100000 seconds',{exact:true});await image.waitFor();await image.evaluate(async(element:HTMLImageElement)=>element.decode());assert.ok(await image.evaluate((element:HTMLImageElement)=>element.complete&&element.naturalWidth===320&&element.naturalHeight===180));assert.equal(await error.count(),0);assert.ok(attempts>=5);await page.unroute(frameRoute);
  const png=Buffer.from((await image.evaluate((element:HTMLImageElement)=>{const canvas=document.createElement('canvas');canvas.width=element.naturalWidth;canvas.height=element.naturalHeight;canvas.getContext('2d')!.drawImage(element,0,0);return canvas.toDataURL('image/png');})).split(',')[1],'base64'),displayed=path.join(output,'recovered-frame.png');await writeFile(displayed,png);
  const baseline=await runProcess(tools.ffmpeg,['-v','error','-i',fixture,'-map','0:v:0','-vf','select=gte(t\\,1.1)','-frames:v','1','-fps_mode','vfr','-pix_fmt','rgb24','-f','hash','-hash','sha256','-']);const recovered=await runProcess(tools.ffmpeg,['-v','error','-i',displayed,'-map','0:v:0','-pix_fmt','rgb24','-f','hash','-hash','sha256','-']);assert.equal(recovered.stdout.toString().trim(),baseline.stdout.toString().trim());await image.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'mobile-recovered.png')});checks.push('Explicit retry recovers a real320x180 PNG whose RGB pixels match the independently decoded original at1.1seconds');
  assert.deepEqual(pageErrors,[]);await writeFile(path.join(output,'result.json'),JSON.stringify({testedAt:new Date().toISOString(),checks,pageErrors,attempts,pts:1.1,width:320,height:180,sha256:recovered.stdout.toString().trim()},null,2));console.log(JSON.stringify({output,checks:checks.length,pageErrors,attempts}));
}catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png')});await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,pageErrors},null,2));throw error;}
finally{await browser?.close();await app.close();}
