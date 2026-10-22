import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from '../apps/server/src/app.ts';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';

const startedAt=new Date().toISOString(),base=path.resolve('test-output/timeline-touch'),out=path.join(base,`run-${Date.now()}`);await mkdir(out,{recursive:true});
const media=await discoverTools(),fixture=path.join(out,'Timeline sample.mp4');
await runProcess(media.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15:duration=60','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=60','-c:v','libx264','-preset','ultrafast','-crf','28','-c:a','aac',fixture]);
const token=randomUUID(),app=await createServer({dataDir:path.join(out,`service-${Date.now()}`),ownerToken:token,tools:media});
await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
const response=await fetch(origin+'/api/v1/uploads',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','x-filename':'Timeline%20sample.mp4'},body:await readFile(fixture)});assert.equal(response.status,200);
const browser=await chromium.launch({channel:process.env.MW_BROWSER_CHANNEL||'msedge',headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:1});
await context.addCookies([{name:'mw_session',value:token,url:origin,httpOnly:true,sameSite:'Strict'}]);
const page=await context.newPage(),cdp=await context.newCDPSession(page),errors:string[]=[],checks:string[]=[];
page.on('pageerror',error=>errors.push(error.message));
const check=(message:string)=>{checks.push(message);console.log(message);};
const draft=async()=>page.evaluate(()=>{const key=Object.keys(localStorage).find(key=>key.startsWith('mw:draft:'))!;const d=JSON.parse(localStorage[key]);return {...d,recipe:d.history[d.cursor]};});
const currentTime=()=>page.locator('video[aria-label="Source playback"]').evaluate((v:HTMLVideoElement)=>v.currentTime);
const slider=()=>page.getByRole('slider',{name:'Timeline playhead',exact:true});
async function touch(points:{x:number;y:number;id?:number}[],type:'touchStart'|'touchMove'|'touchEnd'|'touchCancel'){
  await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map((p,i)=>({...p,id:p.id??i+1,radiusX:3,radiusY:3}))});
}
async function swipe(x:number,y:number,dx:number,dy=0,cancel=false){
  await touch([{x,y}],'touchStart');
  for(let i=1;i<=12;i++){await touch([{x:x+dx*i/12,y:y+dy*i/12}],'touchMove');await page.waitForTimeout(16);}
  await touch([],cancel?'touchCancel':'touchEnd');await page.waitForTimeout(80);
}
async function seekFraction(fraction:number){
  const ruler=await slider().boundingBox();assert(ruler);
  await page.touchscreen.tap(ruler.x+ruler.width*fraction,ruler.y+20);
  await page.waitForFunction(()=>!document.querySelector<HTMLVideoElement>('video')!.seeking);
}
async function fit(){await page.getByRole('button',{name:'Fit',exact:true}).tap();await page.waitForFunction(()=>document.querySelector<HTMLElement>('.timeline')!.style.width==='100%');}
const trials:any[]=[];
try{
  await page.goto(origin);await page.getByRole('button',{name:'Edit source',exact:true}).tap();
  await page.getByLabel('Source playback',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')!.readyState>=2);
  await page.evaluate(()=>{(window as any).events=[];for(const name of ['pointerdown','pointerup','pointercancel','click'])document.addEventListener(name,event=>{const e=event as PointerEvent;(window as any).events.push({name,id:e.pointerId,type:e.pointerType,detail:e.detail,x:e.clientX,y:e.clientY,target:(e.target as HTMLElement).className,time:performance.now()});},true);});
  await page.waitForFunction(()=>Object.keys(localStorage).some(key=>key.startsWith('mw:draft:')));const originalRecipe=(await draft()).recipe;
  await page.evaluate(()=>{const video=document.querySelector<HTMLVideoElement>('video[aria-label="Source playback"]')!,descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime')!;(window as any).seekWrites=[];Object.defineProperty(video,'currentTime',{get(){return descriptor.get!.call(this);},set(value){(window as any).seekWrites.push(value);descriptor.set!.call(this,value);}});});
  for(let i=0;i<16;i++){
    await fit();await seekFraction(.75);const zooms=1+i%4;for(let z=0;z<zooms;z++)await page.getByRole('button',{name:'Zoom in',exact:true}).tap();
    const view=await page.locator('.timeline-scroll').boundingBox(),audio=await page.locator('.audio-track').boundingBox();assert(view&&audio);const before=await currentTime();
    await swipe(view.x+view.width*.7,audio.y+22,-100);assert(Math.abs(await currentTime()-before)<.1,'Pan must not seek');
    const lane=await page.locator('.video-track').boundingBox();assert(lane);const x=view.x+view.width*(i%2?.3:.5),y=lane.y+32,expected=(x-lane.x)/lane.width*60;
    const trial={i,zooms,before,x,y,expected,scroll:await page.locator('.timeline-scroll').evaluate(e=>e.scrollLeft),after:0};trials.push(trial);
    await page.evaluate(()=>(window as any).seekWrites=[]);await touch([{x,y}],'touchStart');await page.waitForTimeout([0,20,40,80][i%4]);await touch([],'touchEnd');
    await page.waitForFunction(value=>Math.abs(document.querySelector<HTMLVideoElement>('video')!.currentTime-value)<.15,expected,{timeout:2000});trial.after=await currentTime();await page.waitForTimeout(350);const writes=await page.evaluate(()=>(window as any).seekWrites as number[]);assert.equal(writes.filter(value=>Math.abs(value-expected)<.02).length,1,'One seek at the tapped time, including any later compatibility click');
  }
  check('Sixteen real pan/tap sequences at 2x–5x zoom seek the exact tapped position once, across 0–80ms taps and different scroll positions.');
  const point=async(fraction=.4)=>{const view=await page.locator('.timeline-scroll').boundingBox(),lane=await page.locator('.video-track').boundingBox();assert(view&&lane);const x=view.x+view.width*fraction,y=lane.y+32;return {x,y,expected:(x-lane.x)/lane.width*60};};
  const tapAt=async(fraction=.4)=>{const p=await point(fraction);await touch([{x:p.x,y:p.y}],'touchStart');await touch([],'touchEnd');await page.waitForFunction(value=>Math.abs(document.querySelector<HTMLVideoElement>('video')!.currentTime-value)<.15,p.expected);};
  await fit();await seekFraction(.5);await page.getByRole('button',{name:'Zoom in',exact:true}).tap();await page.getByRole('button',{name:'Zoom in',exact:true}).tap();
  let p=await point(.4);await touch([{x:p.x,y:p.y}],'touchStart');await touch([{x:p.x+3,y:p.y+2}],'touchMove');await touch([],'touchEnd');const lane=await page.locator('.video-track').boundingBox();assert(lane);await page.waitForFunction(value=>Math.abs(document.querySelector<HTMLVideoElement>('video')!.currentTime-value)<.15,(p.x+3-lane.x)/lane.width*60);
  check('Small finger jitter remains a tap and uses the release position.');
  for(const kind of ['return','hold','cancel-tap','cancel-pan','lost-capture']){
    const before=await currentTime();p=await point(.6);await touch([{x:p.x,y:p.y}],'touchStart');
    if(kind!=='cancel-tap')await touch([{x:p.x-60,y:p.y}],'touchMove');
    if(kind==='return')await touch([{x:p.x,y:p.y}],'touchMove');
    if(kind==='hold')await page.waitForTimeout(450);
    if(kind==='lost-capture')await page.evaluate(()=>{const el=document.querySelector('.timeline-scroll')!;const id=(window as any).events.filter((e:any)=>e.name==='pointerdown').at(-1).id;if(el.hasPointerCapture(id))el.releasePointerCapture(id);});
    await touch([],kind.startsWith('cancel')?'touchCancel':'touchEnd');await page.waitForTimeout(350);assert(Math.abs(await currentTime()-before)<.1,kind+' must not seek');await tapAt(.25);
  }
  check('Drag out-and-back, held drags, cancelled taps/pans and lost capture never seek; each next intentional tap works.');
  p=await point(.5);const beforePinch=await currentTime();await touch([{x:p.x-30,y:p.y,id:1},{x:p.x+30,y:p.y,id:2}],'touchStart');await touch([{x:p.x-60,y:p.y,id:1},{x:p.x+60,y:p.y,id:2}],'touchMove');await touch([{x:p.x+60,y:p.y,id:2}],'touchEnd');await touch([],'touchEnd');await page.waitForTimeout(350);assert(Math.abs(await currentTime()-beforePinch)<.1);await tapAt(.3);
  check('Pinch with staggered finger release does not seek or leak a click, and the following tap works.');
  await page.screenshot({path:path.join(out,'mobile-tap.png')});
  await tapAt(.25);p=await point(.65);await page.mouse.click(p.x,p.y);await page.waitForFunction(value=>Math.abs(document.querySelector<HTMLVideoElement>('video')!.currentTime-value)<.15,p.expected);
  await page.setViewportSize({width:1280,height:900});await page.getByRole('button',{name:'Fit',exact:true}).click();p=await point(.3);await page.mouse.click(p.x,p.y);await page.waitForFunction(value=>Math.abs(document.querySelector<HTMLVideoElement>('video')!.currentTime-value)<.15,p.expected);
  assert.deepEqual((await draft()).recipe,originalRecipe);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'desktop.png')});
  check('Mouse clicks work immediately after touch and in desktop layout; all gestures preserve the edit recipe.');
  await writeFile(path.join(out,'checks.json'),JSON.stringify({checks,errors,trials},null,2));console.log(JSON.stringify({out,checks,errors}));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});throw error;}finally{await writeFile(path.join(out,'trace.json'),JSON.stringify({trials,events:await page.evaluate(()=>(window as any).events)},null,2));await browser.close();await app.close();}
