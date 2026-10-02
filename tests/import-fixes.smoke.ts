import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createServer} from '../apps/server/src/app.ts';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';

const root=path.resolve('test-output/import-ui');await mkdir(root,{recursive:true});
const tools=await discoverTools(),fixture=path.join(root,'two-hour-fixture.mp4');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=1:duration=7500','-c:v','libx264','-preset','ultrafast','-g','30','-pix_fmt','yuv420p',fixture],undefined,{maxStderrBytes:2000});
const token=randomUUID(),secret=randomUUID(),app=await createServer({dataDir:path.join(root,`service-${Date.now()}`),ownerToken:token,desktopSecret:secret,tools,encoders:[],startQueue:false});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as any).port}`;
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.request.post(`${origin}/api/v1/session`,{headers:{origin},data:{token}});await page.goto(origin);
 await page.getByRole('banner').getByRole('button',{name:'Import',exact:true}).click();
 const importStart=performance.now();await page.getByLabel('Local media',{exact:true}).setInputFiles(fixture);
 await page.getByRole('heading',{name:'two-hour-fixture.mp4',exact:true}).waitFor({timeout:30000});const importMs=Math.round(performance.now()-importStart);
 await page.getByRole('button',{name:'Edit source',exact:true}).click();await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')?.readyState!>=2);
 let frameRequests=0;page.on('request',request=>{if(request.url().includes('/frames?'))frameRequests++;});
 const scrubber=page.getByLabel('Timeline playhead',{exact:true}),box=await scrubber.boundingBox();assert(box);
 for(const fraction of [.2,.6,.3,.9])await page.mouse.click(box.x+box.width*fraction,box.y+box.height/2);
 await page.waitForFunction(()=>{const v=document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]');return v&&!v.seeking&&v.currentTime>6000&&v.readyState>=2;},{},{timeout:20000});
 assert.equal(frameRequests,0,'normal scrubbing must not send frame-index jobs');
 await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Text',exact:true}).click();await page.getByRole('checkbox',{name:'Caption above video',exact:true}).check();
 await page.getByLabel('Caption text',{exact:true}).fill('Caption size: 64');
 const size=page.getByLabel('Caption text size',{exact:true});await size.fill('');await size.pressSequentially('64');assert.equal(await size.inputValue(),'64');await size.press('Enter');assert.equal(await size.inputValue(),'64');
 await size.fill('999');await size.press('Escape');assert.equal(await size.inputValue(),'64');
 await page.screenshot({path:path.join(root,'long-preview-caption.png')});
 await page.getByRole('banner').getByRole('button',{name:'Import',exact:true}).click();await page.screenshot({path:path.join(root,'large-file-import.png')});
 await page.getByRole('button',{name:'From a link',exact:true}).click();
 await page.route('**/api/v1/sources/inspect',route=>route.fulfill({json:{title:'Sample video',duration:120,entries:[{itemIndex:1,title:'Sample video',duration:120,formats:[{id:'18',height:720,width:1280,ext:'mp4',vcodec:'h264',acodec:'aac',filesize:12000000}]}]}}));
 await page.getByLabel('Video or audio links',{exact:true}).fill('https://example.com/video');await page.getByLabel('File name',{exact:true}).waitFor();await page.getByLabel('File name',{exact:true}).fill('My custom video');
 await page.evaluate("window.mediaWorkbench = {chooseDownloadFolder: async () => ({id: '11111111-1111-4111-8111-111111111111', label: 'Downloads'})}");
 // Re-render discovers the desktop bridge; native picker registration is covered separately.
 await page.getByLabel('File name',{exact:true}).fill('My custom download');await page.getByRole('button',{name:'Change',exact:true}).click();await page.getByText('Downloads',{exact:true}).waitFor();
 await page.screenshot({path:path.join(root,'download-name-folder.png')});
 const submitted=page.waitForRequest(request=>request.url().endsWith('/api/v1/jobs')&&request.method()==='POST');
 await page.route('**/api/v1/jobs',async route=>{if(route.request().method()==='POST')await route.fulfill({status:202,json:{id:randomUUID()}});else await route.continue();});
 await page.getByRole('button',{name:/^Download/}).last().click();const payload=(await submitted).postDataJSON();assert.equal(payload.download.fileName,'My custom download');assert.equal(payload.download.destinationId,'11111111-1111-4111-8111-111111111111');
 assert.deepEqual(errors,[]);await writeFile(path.join(root,'evidence.json'),JSON.stringify({importMs,duration:7500,frameRequests,captionSize:64,downloadPayload:payload},null,2));console.log(JSON.stringify({passed:true,importMs,duration:7500,frameRequests,captionSize:64}));
}finally{await browser.close();await app.close();}
