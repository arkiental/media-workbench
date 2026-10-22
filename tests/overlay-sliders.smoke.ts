import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools, runProcess } from '../packages/media/src/index.ts';
import type { Artifact, Job } from '../packages/contracts/src/index.ts';

await mkdir(path.resolve('test-output/overlay-sliders'),{recursive:true});
const evidence=await mkdtemp(path.resolve('test-output/overlay-sliders/run-'));
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

  await page.waitForLoadState('networkidle');
  // Ctrl+V with an image on the clipboard adds an overlay at the playhead.
  await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=64;const context=canvas.getContext('2d')!;context.fillStyle='#ff0000';context.fillRect(0,0,128,64);
    const blob=await new Promise<Blob>(resolve=>canvas.toBlob(b=>resolve(b!),'image/png'));
    const data=new DataTransfer();data.items.add(new File([blob],'image.png',{type:'image/png'}));
    document.body.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true}));
  });
  const clip=page.getByRole('button',{name:/^Overlay 1: Pasted image/});
  await clip.waitFor().catch(async error=>{await writeFile(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),errors,body:await page.locator('body').innerText()},null,2));throw error;});
  const item=page.getByRole('button',{name:/^Move overlay 1/});
  await item.waitFor();
  assert.equal(await page.getByLabel('Size',{exact:true}).inputValue(),'0.4');


 const checks:string[]=[];await page.evaluate(()=>{(window as any).pointerAudit=[];for(const type of ['pointerdown','gotpointercapture','lostpointercapture','pointercancel','pointerup'])document.addEventListener(type,(e:any)=>(window as any).pointerAudit.push({type,id:e.pointerId,target:e.target.getAttribute('aria-label')}),true);});
 const range=(name:string)=>page.getByLabel(name,{exact:true});
 const undo=()=>page.getByRole('button',{name:'Undo',exact:true}).click();const redo=()=>page.getByRole('button',{name:'Redo',exact:true}).click();
 const begin=async(name:string,to:number)=>{const slider=range(name);await slider.scrollIntoViewIfNeeded();const r=(await slider.boundingBox())!,from=Number(await slider.inputValue());await page.mouse.move(r.x+8+from*(r.width-16),r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+8+to*(r.width-16),r.y+r.height/2,{steps:20});};
 await begin('Opacity',.4);const opacity=Number(await range('Opacity').inputValue());assert(opacity>.3&&opacity<.5);assert(Math.abs(await page.locator('.overlay-item img').evaluate(el=>Number(getComputedStyle(el).opacity))-opacity)<.01);await page.mouse.up();await undo();assert.equal(await range('Opacity').inputValue(),'1');await redo();assert.equal(Number(await range('Opacity').inputValue()),opacity);checks.push('20-move opacity gesture previews live and one Undo/Redo restores whole gesture.');
 for(const kind of ['Escape','pointercancel','lostcapture','windowblur']){const before=await range('Opacity').inputValue();await begin('Opacity',.8);if(kind==='Escape')await page.keyboard.press('Escape');else if(kind==='windowblur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));else await range('Opacity').evaluate((el,kind)=>el.dispatchEvent(new PointerEvent(kind==='lostcapture'?'lostpointercapture':'pointercancel',{pointerId:1,bubbles:true})),kind);await page.mouse.move(300,300);await page.mouse.up();assert.equal(await range('Opacity').inputValue(),before);await range('Opacity').focus();await page.keyboard.press('ArrowRight');assert.equal(Number(await range('Opacity').inputValue()),Number(Math.min(1,Number(before)+.01).toFixed(2)));await undo();assert.equal(await range('Opacity').inputValue(),before);}checks.push('Escape/window blur and bubbling pointercancel/lostcapture handlers discard changes; next keyboard gesture works.');
 for(const kind of ['export','project']){await begin('Opacity',.8);await page.keyboard.press('Escape');await page.mouse.up();await page.getByRole('button',{name:kind==='export'?/^Export[.\u2026]$/: 'Project saving',exact:true}).click();await page.keyboard.press('Escape');const closed=await page.locator('dialog[open]').count();await writeFile(path.join(evidence,'dialog-escape.json'),JSON.stringify({kind,closed},null,2));assert.equal(closed,0,'Cancelled slider must not swallow later dialog Escape');}checks.push('Export and Project dialogs close with Escape after cancelled slider.');

 // Real held-key repeats use repeated keydown events followed by a single keyup.
 const keyStart=Number(await range('Opacity').inputValue());await range('Opacity').focus();for(let i=0;i<10;i++)await page.keyboard.down('ArrowLeft');await page.keyboard.up('ArrowLeft');assert(Math.abs(Number(await range('Opacity').inputValue())-(keyStart-.1))<.001);await undo();assert.equal(Number(await range('Opacity').inputValue()),keyStart);checks.push('Held-key repeats form one Undo step.');
 await range('Opacity').focus();await page.keyboard.down('ArrowRight');await page.keyboard.press('Escape');await page.keyboard.down('ArrowRight');await page.keyboard.up('ArrowRight');assert.equal(Number(await range('Opacity').inputValue()),keyStart);await page.keyboard.press('ArrowRight');assert.equal(Number(await range('Opacity').inputValue()),Number((keyStart+.01).toFixed(2)));await undo();checks.push('Escape suppresses held-key repeats until release, then next gesture works.');
 for(const label of ['Size','Horizontal','Vertical']){const before=await range(label).inputValue();await begin(label,.7);await page.mouse.up();assert.notEqual(await range(label).inputValue(),before);await undo();assert.equal(await range(label).inputValue(),before);}checks.push('Size and both position sliders preserve one-step Undo.');
 await begin('Opacity',.7);await page.getByRole('button',{name:'Center',exact:true}).evaluate((b:HTMLButtonElement)=>b.click());await page.mouse.up();assert.equal(Number(await range('Opacity').inputValue()),keyStart);checks.push('Newer independent recipe edit invalidates stale slider release.');
 await begin('Opacity',.8);await page.getByRole('button',{name:'Text',exact:true}).first().evaluate((b:HTMLButtonElement)=>b.click());await page.mouse.up();await page.getByRole('button',{name:'Overlay',exact:true}).first().click();assert.equal(Number(await range('Opacity').inputValue()),keyStart);checks.push('Tool change discards transient slider preview.');
 await range('Opacity').focus();await page.keyboard.down('ArrowRight');await page.keyboard.press('Tab');await page.keyboard.up('ArrowRight');assert.equal(Number(await range('Opacity').inputValue()),keyStart);checks.push('Tab before key release cancels unfinished edit.');
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Overlay',exact:true}).first().click();await range('Opacity').scrollIntoViewIfNeeded();const touchBox=(await range('Opacity').boundingBox())!,tx=touchBox.x+8+keyStart*(touchBox.width-16),ty=touchBox.y+touchBox.height/2,cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:ty,id:4}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchBox.x+touchBox.width*.8,y:ty,id:4}]});assert.notEqual(Number(await range('Opacity').inputValue()),keyStart);await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});assert.equal(Number(await range('Opacity').inputValue()),keyStart);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:ty,id:5}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchBox.x+touchBox.width*.7,y:ty,id:5}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.notEqual(Number(await range('Opacity').inputValue()),keyStart);await page.setViewportSize({width:1440,height:1000});await undo();assert.equal(Number(await range('Opacity').inputValue()),keyStart);checks.push('Actual mobile CDP touchCancel restores starting value; fresh touch commits once and Undo restores.');
 await begin('Opacity',.8);const captureBefore=await range('Opacity').evaluate(el=>el.hasPointerCapture(1));await range('Opacity').evaluate(el=>el.releasePointerCapture(1));await page.mouse.move(300,300);const captureAfter=await range('Opacity').evaluate(el=>el.hasPointerCapture(1));await writeFile(path.join(evidence,'capture-diagnostic.json'),JSON.stringify({captureBefore,captureAfter,events:await page.evaluate(()=>(window as any).pointerAudit)},null,2));await page.keyboard.press('Escape');await page.mouse.up();assert.equal(Number(await range('Opacity').inputValue()),keyStart);
 await begin('Opacity',.5);await page.mouse.up();const saved=await range('Opacity').inputValue();await page.reload();await page.locator('.scrubber').waitFor();await page.getByRole('button',{name:'Overlay',exact:true}).first().click();assert.equal(await range('Opacity').inputValue(),saved);checks.push('Completed slider values survive reload.');
 await begin('Opacity',.9);await page.reload();await page.mouse.up();await page.locator('.scrubber').waitFor();await page.getByRole('button',{name:'Overlay',exact:true}).first().click();assert.equal(await range('Opacity').inputValue(),saved);checks.push('Reload during gesture retains last completed value, not transient preview.');
 const end=page.getByLabel('Overlay end',{exact:true}),originalEnd=await end.inputValue();await end.fill('5.5');await end.press('Enter');await end.press('Tab');await undo();assert.equal(await end.inputValue(),originalEnd);checks.push('Existing time field Enter/Tab commits once.');
 await page.getByRole('button',{name:/^Export[.\u2026]$/,exact:true}).click();await page.getByRole('button',{name:'Resolve export plan',exact:true}).click();await page.getByRole('button',{name:'Export using reviewed plan',exact:true}).click();await page.getByRole('status').filter({hasText:/^Export ready$/}).waitFor({timeout:60000});const job=app.store.jobs().find(j=>j.request.type==='export'&&j.state==='completed');assert(job?.artifactId);const exported=path.join(evidence,'exported.mp4');await writeFile(exported,await(await page.request.get(origin+'/api/v1/artifacts/'+job.artifactId+'/content')).body());const rgb=await pixel(exported,1,320,180);assert(Math.abs(rgb[0]-255*Number(saved))<35&&Math.abs(rgb[2]-255*(1-Number(saved)))<35,JSON.stringify({rgb,saved}));checks.push('Real export pixels reflect completed slider opacity, not cancelled preview.');
 await page.keyboard.press('Escape');const other=await page.request.post(origin+'/api/v1/uploads',{headers:{origin,'content-type':'application/octet-stream','x-filename':'Other.mp4'},data:await readFile(fixture)});assert.equal(other.status(),200,await other.text());await page.getByRole('button',{name:'Library',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.locator('.media-card').filter({has:page.getByRole('heading',{name:'Other.mp4',exact:true})}).getByRole('button',{name:'Edit source',exact:true}).click();await page.locator('.scrubber').waitFor();await page.getByRole('button',{name:'Overlay',exact:true}).first().click();assert.equal(await page.locator('.overlay-choice').count(),0);await page.getByRole('button',{name:'Library',exact:true}).click();await page.locator('.media-card').filter({has:page.getByRole('heading',{name:'Blue.mp4',exact:true})}).getByRole('button',{name:'Edit source',exact:true}).click();await page.locator('.scrubber').waitFor();await page.getByRole('button',{name:'Overlay',exact:true}).first().click();assert.equal(await range('Opacity').inputValue(),saved);checks.push('Another source has no overlay draft leakage; original source restores completed opacity.');
 assert.deepEqual(errors,[]);await writeFile(path.join(evidence,'checks.json'),JSON.stringify({checks,errors,pointerAudit:await page.evaluate(()=>(window as any).pointerAudit)},null,2));console.log(JSON.stringify({evidence,checks,errors}));
}finally{await browser.close();await app.close();}
