import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools, runProcess } from '../packages/media/src/index.ts';

const evidence=path.resolve('test-output/transform');
await mkdir(evidence,{recursive:true});
const tools=await discoverTools(), fixture=path.join(evidence,'color-grid.mp4');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','color=red:size=640x360:rate=10:duration=3','-vf','drawbox=x=320:y=0:w=320:h=180:color=green:t=fill,drawbox=x=0:y=180:w=320:h=180:color=blue:t=fill,drawbox=x=320:y=180:w=320:h=180:color=yellow:t=fill','-c:v','libx264','-pix_fmt','yuv420p',fixture]);
const token=randomUUID();
const app=await createServer({dataDir:path.join(evidence,`service-${Date.now()}`),ownerToken:token,tools,encoders:[],startQueue:false});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();assert(address&&typeof address==='object');
  const origin=`http://127.0.0.1:${address.port}`;
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.request.post(`${origin}/api/v1/session`,{headers:{origin},data:{token}});
  await page.request.post(`${origin}/api/v1/uploads`,{headers:{origin,'content-type':'application/octet-stream','x-filename':'Color grid.mp4'},data:await readFile(fixture)});
  await page.goto(origin);
  await page.getByRole('button',{name:'Library',exact:true}).click();
  await page.getByRole('button',{name:'Edit source',exact:true}).click();
  await page.waitForFunction(()=>{const video=document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]');return !!video&&video.readyState>=2;});
  await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Transform',exact:true}).click();
  await page.getByRole('button',{name:'Toggle viewport crop',exact:true}).click();
  const handle=page.getByRole('button',{name:'Crop bottom right handle',exact:true});
  await handle.waitFor();
  const box=await handle.boundingBox();assert(box);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.down();await page.mouse.move(box.x+box.width/2-80,box.y+box.height/2-40,{steps:5});await page.mouse.up();
  assert(Number(await page.getByLabel('Crop width',{exact:true}).inputValue())<640);
  assert(Number(await page.getByLabel('Crop height',{exact:true}).inputValue())<360);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  assert.equal(await page.getByLabel('Crop width',{exact:true}).inputValue(),'640');
  assert.equal(await page.getByLabel('Crop height',{exact:true}).inputValue(),'360');
  async function field(label:string,value:number) {const input=page.getByLabel(label,{exact:true});await input.fill(String(value));if(label.startsWith('Viewport'))await input.press('Enter');}
  await field('Crop width',480);await field('Crop height',240);await field('Crop x',80);await field('Crop y',40);
  await page.screenshot({path:path.join(evidence,'crop-desktop.png')});
  const move=page.getByRole('button',{name:'Move crop area',exact:true});
  await move.focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByLabel('Crop x',{exact:true}).inputValue(),'81');
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  assert.equal(await page.getByLabel('Crop x',{exact:true}).inputValue(),'80');
  await page.locator('.viewport-transform-controls').getByRole('button',{name:'Rotate right',exact:true}).click();
  assert.equal(await page.getByRole('group',{name:'Clockwise rotation',exact:true}).getByRole('button',{name:'90°',exact:true}).getAttribute('aria-pressed'),'true');
  const rotatedHandle=await page.getByRole('button',{name:'Crop right handle',exact:true}).boundingBox();assert(rotatedHandle);
  await page.mouse.move(rotatedHandle.x+rotatedHandle.width/2,rotatedHandle.y+rotatedHandle.height/2);await page.mouse.down();
  await page.mouse.move(rotatedHandle.x+rotatedHandle.width/2,rotatedHandle.y+rotatedHandle.height/2+20,{steps:5});await page.mouse.up();
  assert(Number(await page.getByLabel('Crop width',{exact:true}).inputValue())>480);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  assert.equal(await page.getByLabel('Crop width',{exact:true}).inputValue(),'480');
  await page.screenshot({path:path.join(evidence,'rotated-crop-desktop.png')});
  await page.getByRole('button',{name:'Toggle crop result',exact:true}).click();
  await page.locator('.viewport-transform-controls').getByRole('button',{name:'Lock aspect ratio',exact:true}).click();
  await field('Viewport output width',240);await field('Viewport output height',360);
  assert.equal(await page.getByLabel('Output width',{exact:true}).inputValue(),'240');
  assert.equal(await page.getByLabel('Output height',{exact:true}).inputValue(),'360');
  const expected=path.join(evidence,'expected.png');
  async function samples(bytes:Buffer) {
    return page.evaluate(async data=>{
      const image=new Image();image.src=`data:image/png;base64,${data}`;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const context=canvas.getContext('2d')!;context.drawImage(image,0,0);
      return [[.1,.1],[.9,.1],[.1,.9],[.9,.9]].map(([horizontal,vertical])=>Array.from(context.getImageData(Math.floor(image.width*horizontal),Math.floor(image.height*vertical),1,1).data).slice(0,3));
    },bytes.toString('base64'));
  }
  for (const [rotate,filter] of [[0,'null'],[90,'transpose=clock'],[180,'hflip,vflip'],[270,'transpose=cclock']] as const) {
    await page.getByRole('group',{name:'Clockwise rotation',exact:true}).getByRole('button',{name:`${rotate}°`,exact:true}).click();
    await page.waitForTimeout(150);
    await runProcess(tools.ffmpeg,['-y','-v','error','-i',fixture,'-vf',`crop=480:240:80:40,${filter},scale=240:360`,'-frames:v','1',expected]);
    const actual=await samples(await page.locator('.transform-frame').screenshot());
    const wanted=await samples(await readFile(expected));
    for(let corner=0;corner<4;corner++)for(let channel=0;channel<3;channel++)assert(Math.abs(actual[corner][channel]-wanted[corner][channel])<=45,`Preview color regions match FFmpeg at rotation ${rotate}: ${JSON.stringify({actual,wanted})}`);
  }
  await page.getByRole('group',{name:'Clockwise rotation',exact:true}).getByRole('button',{name:'90°',exact:true}).click();
  await page.screenshot({path:path.join(evidence,'result-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Transform',exact:true}).click();
  const toolbar=await page.getByRole('group',{name:'Viewport transforms'}).boundingBox();
  const rail=await page.getByRole('navigation',{name:'Editing tools'}).boundingBox();
  assert(toolbar&&rail&&toolbar.y>=0&&toolbar.y+toolbar.height<rail.y);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(evidence,'result-mobile.png')});
  await page.getByRole('button',{name:'Toggle crop result',exact:true}).click();
  const mobileHandle=await page.getByRole('button',{name:'Crop top left handle',exact:true}).boundingBox();
  assert(mobileHandle&&mobileHandle.width>=43.9&&mobileHandle.height>=43.9);
  await page.screenshot({path:path.join(evidence,'crop-mobile.png')});
  const rotatedFixture=path.join(evidence,'oriented-grid.mp4');
  await runProcess(tools.ffmpeg,['-y','-v','error','-display_rotation','90','-i',fixture,'-c','copy',rotatedFixture]);
  await page.request.post(`${origin}/api/v1/uploads`,{headers:{origin,'content-type':'application/octet-stream','x-filename':'Oriented grid.mp4'},data:await readFile(rotatedFixture)});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Library',exact:true}).click();
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.locator('.media-card').filter({has:page.getByRole('heading',{name:'Oriented grid.mp4',exact:true})}).getByRole('button',{name:'Edit source',exact:true}).click();
  await page.waitForFunction(()=>{const video=document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]');return !!video&&video.readyState>=2;});
  await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Transform',exact:true}).click();
  await page.getByRole('button',{name:'Toggle viewport crop',exact:true}).click();
  await field('Crop width',480);await field('Crop height',240);await field('Crop x',80);await field('Crop y',40);
  await page.locator('.viewport-transform-controls').getByRole('button',{name:'Lock aspect ratio',exact:true}).click();
  await field('Viewport output width',240);await field('Viewport output height',360);
  await page.waitForTimeout(150);
  await runProcess(tools.ffmpeg,['-y','-v','error','-noautorotate','-display_rotation:v:0','0','-i',rotatedFixture,'-vf','crop=480:240:80:40,transpose=cclock,scale=240:360','-frames:v','1',expected]);
  const orientedActual=await samples(await page.locator('.transform-frame').screenshot());
  const orientedWanted=await samples(await readFile(expected));
  assert.equal(app.store.all<any>('artifact').find(artifact=>artifact.name==='Oriented grid.mp4')?.media.streams[0].rotation,90);
  for(let corner=0;corner<4;corner++)for(let channel=0;channel<3;channel++)assert(Math.abs(orientedActual[corner][channel]-orientedWanted[corner][channel])<=45,`Source orientation matches FFmpeg: ${JSON.stringify({orientedActual,orientedWanted})}`);
  await page.screenshot({path:path.join(evidence,'source-orientation.png')});
  for(const viewport of [{width:1366,height:768},{width:851,height:600},{width:320,height:740},{width:844,height:390}]) {
    await page.setViewportSize(viewport);
    await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name:'Transform',exact:true}).click();
    const controls=await page.getByRole('group',{name:'Viewport transforms'}).boundingBox();
    const preview=await page.locator('.cut-preview').boundingBox();
    assert(controls&&preview&&controls.y+controls.height<=preview.y+1,'Transform controls stay above the viewport '+JSON.stringify({viewport,controls,preview}));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(viewport.width<=850){const tools=await page.getByRole('navigation',{name:'Editing tools'}).boundingBox();assert(tools&&controls.y>=0&&controls.y+controls.height<tools.y,'Viewport controls stay above persistent tools');}
    await page.screenshot({path:path.join(evidence,`transform-${viewport.width}x${viewport.height}.png`)});
  }
  assert.deepEqual(errors,[]);
  console.log('Passed: visible viewport transforms, crop drag and keyboard, single-step undo, rotation and resize sync, four-angle and source-orientation FFmpeg color-region parity, mobile access and crop targets.');
} finally {await browser.close();await app.close();}
