import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools, runProcess } from '../packages/media/src/index.ts';
import type { Artifact, Job } from '../packages/contracts/src/index.ts';

const evidence=path.resolve('test-output/overlay');
await mkdir(evidence,{recursive:true});
const tools=await discoverTools(),fixture=path.join(evidence,'blue.mp4');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','color=blue:size=640x360:rate=10:duration=6','-c:v','libx264','-pix_fmt','yuv420p',fixture]);
const token=randomUUID();
const app=await createServer({dataDir:path.join(evidence,`service-${Date.now()}`),ownerToken:token,tools});
const browser=await chromium.launch({channel:'msedge',headless:true});
const pixel=async(file:string,at:number,x:number,y:number)=>[...(await runProcess(tools.ffmpeg,['-v','error','-ss',String(at),'-i',file,'-frames:v','1','-vf',`crop=2:2:${x}:${y}`,'-f','rawvideo','-pix_fmt','rgb24','-'])).stdout].slice(0,3);
const red=([r,g,b]:number[])=>r>180&&g<80&&b<80;
try {
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();assert(address&&typeof address==='object');
  const origin=`http://127.0.0.1:${address.port}`;
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.request.post(`${origin}/api/v1/session`,{headers:{origin},data:{token}});
  await page.request.post(`${origin}/api/v1/uploads`,{headers:{origin,'content-type':'application/octet-stream','x-filename':'Blue.mp4'},data:await readFile(fixture)});
  await page.goto(origin);
  await page.getByRole('button',{name:'Library',exact:true}).click();
  await page.getByRole('button',{name:'Edit source',exact:true}).click();
  await page.waitForFunction(()=>{const video=document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]');return !!video&&video.readyState>=2;});

  // Ctrl+V with an image on the clipboard adds an overlay at the playhead.
  await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=64;const context=canvas.getContext('2d')!;context.fillStyle='#ff0000';context.fillRect(0,0,128,64);
    const blob=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),'image/png'));
    const data=new DataTransfer();data.items.add(new File([blob],'image.png',{type:'image/png'}));
    document.body.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true}));
  });
  const clip=page.getByRole('button',{name:/^Overlay 1: Pasted image/});
  await clip.waitFor();
  const item=page.getByRole('button',{name:/^Move overlay 1/});
  await item.waitFor();
  assert.equal(await page.getByLabel('Size',{exact:true}).inputValue(),'0.4');

  // Drag the image on the video towards the left; the inspector follows.
  const box=await item.boundingBox();assert(box);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2-200,box.y+box.height/2,{steps:6});await page.mouse.up();
  const horizontal=Number(await page.getByLabel('Horizontal',{exact:true}).inputValue());
  assert(horizontal<.4&&horizontal>.1,`dragged overlay x ${horizontal}`);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  assert.equal(await page.getByLabel('Horizontal',{exact:true}).inputValue(),'0.5');
  await page.getByRole('button',{name:'Redo',exact:true}).click();

  // Corner drag resizes about the centre.
  const handle=page.locator('.overlay-handle.overlay-se');const corner=await handle.boundingBox();assert(corner);
  await page.mouse.move(corner.x+corner.width/2,corner.y+corner.height/2);await page.mouse.down();
  await page.mouse.move(corner.x+corner.width/2+60,corner.y+corner.height/2+30,{steps:5});await page.mouse.up();
  assert(Number(await page.getByLabel('Size',{exact:true}).inputValue())>.4);
  await page.getByLabel('Size',{exact:true}).fill('0.2');

  // Show it from 1 s to 3 s.
  for(const [label,value] of [['Overlay end','3'],['Overlay start','1']]){const input=page.getByLabel(label,{exact:true});await input.fill(value);await input.press('Enter');}
  await page.getByRole('listbox',{name:'Overlays'}).getByText('0:01.000 – 0:03.000').waitFor();
  await page.screenshot({path:path.join(evidence,'overlay-editor.png')});

  await page.getByRole('button',{name:'Export…',exact:true}).click();
  await page.getByRole('button',{name:'Resolve export plan',exact:true}).click();
  await page.getByRole('button',{name:'Export using reviewed plan',exact:true}).click();
  const deadline=Date.now()+120000;let job:Job|undefined;
  while(Date.now()<deadline){const jobs=await (await page.request.get(`${origin}/api/v1/jobs`)).json() as Job[];job=jobs.find(j=>j.request.type==='export');if(job&&['completed','failed'].includes(job.state))break;await new Promise(resolve=>setTimeout(resolve,500));}
  assert.equal(job?.state,'completed',job?.error);
  const artifacts=await (await page.request.get(`${origin}/api/v1/artifacts`)).json() as Artifact[];
  const output=path.join(evidence,'exported.mp4');await writeFile(output,await (await page.request.get(`${origin}/api/v1/artifacts/${job!.artifactId}/content`)).body());
  assert(artifacts.some(a=>a.id===job!.artifactId));
  const x=Math.round(horizontal*640);
  assert(!red(await pixel(output,.5,x,180)),'hidden before start');
  assert(red(await pixel(output,2,x,180)),'visible at the dragged position');
  assert(!red(await pixel(output,2,560,180)),'not drawn elsewhere');
  assert(!red(await pixel(output,4,x,180)),'hidden after end');
  assert.deepEqual(errors,[]);
  console.log('overlay smoke passed');
} finally {
  await browser.close();await app.close();
}
