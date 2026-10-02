import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools,runProcess,exportMedia } from '../packages/media/src/index.ts';
import { RecipeSchema,ExportSchema } from '../packages/contracts/src/index.ts';
import { captionLayout } from '../packages/contracts/src/caption.ts';

const root=path.resolve('test-output/caption');await mkdir(root,{recursive:true});
const tools=await discoverTools(),fixture=path.join(root,'fixture.mp4');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','color=red:size=640x360:rate=10:duration=2','-c:v','libx264',fixture]);
const token=randomUUID(),app=await createServer({dataDir:path.join(root,`service-${Date.now()}`),ownerToken:token,tools,encoders:[],startQueue:false});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.request.post(`${origin}/api/v1/session`,{headers:{origin},data:{token}});
  await page.route('**/api/v1/sources/inspect',route=>route.fulfill({json:{title:'Available quality fixture',entries:[{itemIndex:1,title:'Video',formats:[480,720,1080,2160].map(height=>({id:`v${height}`,width:Math.round(height*16/9),height,vcodec:'h264',acodec:'aac',ext:'mp4'}))},{itemIndex:2,title:'Second video',formats:[{id:'second720',width:1280,height:720,vcodec:'h264',acodec:'aac',ext:'mp4'}]}]}}));
  await page.goto(origin);await page.getByRole('banner').getByRole('button',{name:'Import',exact:true}).click();
  await page.getByRole('button',{name:'From a link',exact:true}).click();
  await page.getByLabel('Video or audio links',{exact:true}).fill('https://example.com/video');
  const quality=page.getByRole('group',{name:'Download quality'});await quality.waitFor();
  assert.deepEqual(await quality.getByRole('button').allTextContents(),['Best available','480p','720p','1080p','4K']);
  await quality.getByRole('button',{name:'1080p',exact:true}).click();assert.equal(await page.getByLabel('Provider format selector',{exact:true}).inputValue(),'v1080');
  assert.equal(await quality.getByRole('button',{name:'1080p',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await quality.getByRole('button',{name:'Best available',exact:true}).getAttribute('aria-pressed'),'false');
  await page.waitForTimeout(300);
  await page.screenshot({path:path.join(root,'download-quality-desktop.png')});
  await page.getByLabel('Media item to download',{exact:true}).selectOption('2');assert.deepEqual(await quality.getByRole('button').allTextContents(),['Best available','720p']);
  await page.setViewportSize({width:390,height:844});await page.getByLabel('Media item to download',{exact:true}).selectOption('1');await quality.getByRole('button',{name:'720p',exact:true}).click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(root,'download-quality-mobile.png'),fullPage:true});
  const upload=await page.request.post(`${origin}/api/v1/uploads`,{headers:{origin,'content-type':'application/octet-stream','x-filename':'Caption fixture.mp4'},data:await readFile(fixture)});assert.equal(upload.status(),200);const source=await upload.json();
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'Library',exact:true}).click();await page.getByRole('button',{name:'Edit source',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')?.readyState!>=2);
  const rail=page.getByRole('navigation',{name:'Editing tools'});assert.deepEqual(await rail.getByRole('button').allTextContents(),['Text','Overlay','Audio','Transform','Cut']);
  await rail.getByRole('button',{name:'Text',exact:true}).click();await page.getByRole('checkbox',{name:'Caption above video',exact:true}).check();
  const text='A white caption above the video';await page.getByLabel('Caption text',{exact:true}).fill(text);await page.getByLabel('Caption text size',{exact:true}).fill('32');await page.getByLabel('Caption padding',{exact:true}).fill('16');
  const header=captionLayout({text,size:32,padding:16},640);assert.equal(await page.getByLabel('Video caption',{exact:true}).innerText(),header.text);
  assert.equal(await page.getByLabel('Video caption',{exact:true}).evaluate(element=>getComputedStyle(element).color),'rgb(255, 255, 255)');
  await page.screenshot({path:path.join(root,'caption-desktop.png')});
  await page.getByLabel('Caption padding',{exact:true}).fill('24');assert.equal(await page.getByLabel('Video caption',{exact:true}).evaluate(element=>element.style.height),`${header.height+16}px`);
  await page.getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await page.getByLabel('Caption padding',{exact:true}).inputValue(),'16');
  for(const viewport of [{width:390,height:844},{width:320,height:740},{width:844,height:390}]){
    await page.setViewportSize(viewport);await rail.getByRole('button',{name:'Text',exact:true}).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(root,`caption-${viewport.width}x${viewport.height}.png`),fullPage:true});
  }
  const workDir=path.join(root,`export-${Date.now()}`);await mkdir(workDir,{recursive:true});
  const recipe=RecipeSchema.parse({sourceId:source.id,segments:[{in:0,out:2}],caption:{text,size:32,padding:16}}),output=path.join(workDir,'caption.mp4');
  const result=await exportMedia(fixture,output,recipe,ExportSchema.parse({cut:'exact'}),tools,{signal:new AbortController().signal,workDir});
  const video=result.media.streams.find(stream=>stream.type==='video');assert.equal(video?.width,640);assert.equal(video?.height,360+header.height);
  const decoded=(await runProcess(tools.ffmpeg,['-v','error','-i',output,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
  let white=0;for(let pixel=0;pixel<640*header.height;pixel++){const offset=pixel*3;if(decoded[offset]>200&&decoded[offset+1]>200&&decoded[offset+2]>200)white++;}assert(white>50,'export contains white caption glyphs in the added black band');
  const bottom=(640*(header.height+100)+320)*3;assert(decoded[bottom]>200&&decoded[bottom+1]<80&&decoded[bottom+2]<80,'picture stays red below caption, not stretched or covered');
  await runProcess(tools.ffmpeg,['-y','-v','error','-i',output,'-frames:v','1',path.join(root,'caption-export.png')]);
  assert.deepEqual(errors,[]);console.log('Passed automatic quality shortcuts, per-item available resolutions, four editor tools, live caption settings, Undo, mobile layout and actual taller FFmpeg export with white text above the unchanged picture.');
} finally {await browser.close();await app.close();}
