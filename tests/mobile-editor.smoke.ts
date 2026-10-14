import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,type CDPSession,type Page} from 'playwright';
import {createServer} from '../apps/server/src/app.ts';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';

const startedAt=new Date().toISOString(),base=path.resolve('test-output/mobile-editor'),out=path.join(base,`run-${Date.now()}`);await mkdir(out,{recursive:true});
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
const tool=async(name:string)=>{const button=page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name,exact:true});if(await button.getAttribute('aria-expanded')!=='true')await button.tap();};
const closePanel=async()=>{if(await page.locator('.editor-context-panel').isVisible())await page.locator('.editor-context-panel').getByRole('button',{name:'Done',exact:true}).tap();};
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
async function layout(width:number,height:number){
  await page.setViewportSize({width,height});await closePanel();await page.evaluate(()=>window.scrollTo(0,0));
  const boxes=await page.evaluate(()=>{
    const boxes=['.editor-tool-rail','.context-timeline','.cut-preview','.app-header'].map(s=>document.querySelector(s)!.getBoundingClientRect().toJSON());
    return {rail:boxes[0],timeline:boxes[1],preview:boxes[2],body:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth>innerWidth,header:boxes[3]};
  });
  assert(!boxes.overflow,`Horizontal overflow at ${width}x${height}`);
  assert(boxes.body<=height+1,`Page scroll at ${width}x${height}: ${boxes.body}`);
  assert(boxes.timeline.y>=boxes.header.bottom&&boxes.timeline.bottom<=boxes.rail.y+1,`Timeline obscured at ${width}x${height}: ${JSON.stringify(boxes)}`);
  assert(boxes.preview.y>=0&&boxes.preview.bottom<=boxes.rail.y+1);
  assert.equal(await page.locator('.mobile-navigation').isVisible(),false);
  for(const name of ['Cut','Text','Overlay','Audio','Transform']){
    const box=await page.getByRole('navigation',{name:'Editing tools'}).getByRole('button',{name,exact:true}).boundingBox();
    assert(box&&box.width>=44&&box.height>=44&&box.y+box.height<=height+1);
  }
  await page.screenshot({path:path.join(out,`${width}x${height}.png`)});
  check(`Layout ${width}x${height}: preview, timeline and tools fit; no document scrolling`);
}
try{
  await page.goto(origin);await page.getByRole('button',{name:'Edit source',exact:true}).tap();
  await page.locator('.cut-workspace').waitFor();await page.waitForFunction(()=>document.querySelector<HTMLVideoElement>('video')!.readyState>=2);
  assert.equal(await page.locator('.editor-context-panel').isVisible(),false);
  assert.equal(await page.locator('.text-track').isVisible(),false);assert.equal(await page.locator('.overlay-track').isVisible(),false);
  for(const [width,height] of [[390,844],[360,740],[320,640],[768,1024],[844,390],[932,430],[915,412],[800,600]])await layout(width,height);
  await page.setViewportSize({width:390,height:844});await fit();
  await page.locator('.cut-preview').tap();assert.equal(await page.locator('.editor-context-panel').isVisible(),false);
  const originalSegments=(await draft()).recipe.segments;
  await page.evaluate(()=>{(window as any).busyChanges=[];new MutationObserver(()=>{if(document.querySelector('main')?.getAttribute('aria-busy')==='true')(window as any).busyChanges.push(true);}).observe(document.querySelector('main')!,{attributes:true,attributeFilter:['aria-busy']});});
  await seekFraction(.5);assert(Math.abs(await currentTime()-30)<.2,'Touch tap seeks ruler midpoint');
  const ruler=await slider().boundingBox();assert(ruler);await swipe(ruler.x+ruler.width*.5,ruler.y+22,ruler.width*.25);
  assert(Math.abs(await currentTime()-45)<.2,'Touch drag seeks continuously');
  assert.deepEqual(await page.evaluate(()=>(window as any).busyChanges),[]);
  check('Touch tap and drag seek through a 60-second source without toggling app busy state');
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Zoom in',exact:true}).tap();
  const anchored=await page.evaluate(()=>{const e=document.querySelector('.timeline-scroll')!,c=document.querySelector('.timeline-cursor')!.getBoundingClientRect();const b=e.getBoundingClientRect();return c.left>=b.left&&c.left<=b.right;});assert(anchored,'Zoom keeps visible playhead anchored');
  const view=page.locator('.timeline-scroll'),audio=await page.locator('.audio-track').boundingBox();assert(audio);
  const scrollBefore=await view.evaluate(e=>e.scrollLeft),timeBefore=await currentTime();
  const viewport=await view.boundingBox();assert(viewport);await swipe(viewport.x+viewport.width*.7,audio.y+22,-100);
  assert((await view.evaluate(e=>e.scrollLeft))>scrollBefore+60,'Touch swipe pans zoomed tracks');
  assert(Math.abs(await currentTime()-timeBefore)<.1,'Panning does not seek');
  assert.equal(await page.locator('.editor-context-panel').isVisible(),false);
  check('Zoom anchors the playhead; touch swipes pan without editing, seeking or opening tools');
  const videoLane=await page.locator('.video-track').boundingBox();assert(videoLane);
  await touch([{x:viewport.x+viewport.width*.5,y:videoLane.y+32}],'touchStart');await page.waitForTimeout(40);await touch([],'touchEnd');
  await page.waitForFunction(previous=>Math.abs(document.querySelector<HTMLVideoElement>('video')!.currentTime-previous)>.2,timeBefore,{timeout:2000});
  assert(Math.abs(await currentTime()-timeBefore)>.2,'A deliberate tap immediately after panning is not swallowed');
  await page.getByRole('button',{name:'Play',exact:true}).tap();
  await swipe(viewport.x+viewport.width*.25,audio.y+22,160);
  const manualLeft=await view.evaluate(el=>el.scrollLeft);await page.waitForTimeout(400);
  assert(Math.abs(await view.evaluate(el=>el.scrollLeft)-manualLeft)<2,'Playback following leaves manual panning alone temporarily');
  await page.getByRole('button',{name:'Pause',exact:true}).tap();
  await page.waitForFunction(()=>document.querySelector('main')?.getAttribute('aria-busy')!=='true');await page.evaluate(()=>{(window as any).busyChanges=[];});
  check('The next intentional tap works after panning; playback following respects manual navigation');
  await fit();
  const y=(await page.locator('.audio-track').boundingBox())!.y+22,x=viewport.x+viewport.width/2;
  await touch([{x:x-35,y,id:1},{x:x+35,y,id:2}],'touchStart');
  for(let i=1;i<=8;i++){await touch([{x:x-35-i*8,y,id:1},{x:x+35+i*8,y,id:2}],'touchMove');await page.waitForTimeout(20);}
  await touch([],'touchEnd');await page.waitForTimeout(300);
  const zoom=await page.locator('.timeline').evaluate(e=>parseFloat((e as HTMLElement).style.width)/100);assert(zoom>2&&zoom<4,`Pinch changed zoom: ${zoom}`);
  check('Two-finger touch pinch zooms the timeline');
  const overview=await page.locator('.timeline-overview-range').boundingBox();assert(overview);
  await swipe(overview.x+overview.width*.5,overview.y+22,overview.width*(55/60-.5));
  await page.waitForFunction(()=>Math.abs(document.querySelector<HTMLVideoElement>('video')!.currentTime-55)<.1);
  await page.getByRole('button',{name:'Show playhead',exact:true}).tap();
  assert(await page.evaluate(()=>{const c=document.querySelector('.timeline-cursor')!.getBoundingClientRect(),b=document.querySelector('.timeline-scroll')!.getBoundingClientRect();return c.x>=b.x&&c.x<=b.right;}));
  check('Full-video navigator reaches distant time and Show playhead brings it into view');
  await page.getByRole('button',{name:'More timeline actions',exact:true}).tap();
  const options=page.getByRole('region',{name:'More timeline actions',exact:true}),position=options.getByLabel('Playhead (s)',{exact:true});
  const snap=options.getByRole('button',{name:'Snap to frames',exact:true});if(await snap.getAttribute('aria-pressed')==='true')await snap.tap();
  const uncommitted=await currentTime();await position.fill('12.');assert.equal(await currentTime(),uncommitted);
  await position.fill('12.345');assert.equal(await currentTime(),uncommitted);await position.press('Enter');
  assert(Math.abs(await currentTime()-12.345)<.01);assert.equal(await position.inputValue(),'12.345');
  await position.fill('');await position.press('Enter');assert(Math.abs(await currentTime()-12.345)<.01);
  await position.fill('22.4');await position.press('Escape');assert.equal(await position.inputValue(),'12.345');
  await page.locator('video').evaluate((video:HTMLVideoElement)=>video.play());await position.focus();await page.waitForTimeout(500);
  const advancedTime=await currentTime();await position.press('Tab');assert(await currentTime()>=advancedTime-.05,'An unchanged focused time field does not rewind playback on blur');
  await page.locator('video').evaluate((video:HTMLVideoElement)=>video.pause());
  await options.getByRole('button',{name:'Done',exact:true}).tap();
  assert.deepEqual(await page.evaluate(()=>(window as any).busyChanges),[]);
  await slider().focus();await page.keyboard.press('Home');assert((await currentTime())<.01);
  await page.keyboard.press('End');assert((await currentTime())>59.9);
  check('Decimal playhead entry commits only on Enter/blur; empty and cancelled drafts do not seek; ruler Home/End reach source bounds');
  await fit();await seekFraction(.25);await page.getByRole('button',{name:'Split',exact:true}).tap();
  await page.waitForTimeout(350);assert.equal((await draft()).recipe.segments.length,2);
  await seekFraction(.75);await page.getByRole('button',{name:'Split',exact:true}).tap();
  await page.waitForTimeout(350);assert.equal((await draft()).recipe.segments.length,3,'Split targets the section under the playhead after seeking');
  await page.getByRole('button',{name:'Undo',exact:true}).tap();await page.waitForTimeout(350);
  await page.getByRole('button',{name:'Undo',exact:true}).tap();await page.waitForTimeout(350);
  assert.deepEqual((await draft()).recipe.segments,originalSegments);
  check('Mobile split and undo modify and restore the actual recipe');
  await fit();await seekFraction(.3);
  const handle=page.getByRole('slider',{name:'Region 1 start trim handle',exact:true}),hb=await handle.boundingBox();assert(hb&&hb.width>=44&&hb.height>=44);
  const before=Number(await handle.getAttribute('aria-valuenow'));await swipe(hb.x+22,hb.y+22,25);
  const after=Number(await handle.getAttribute('aria-valuenow'));assert(after>before+2&&after<before+6,'Trim uses finger delta, not offset within handle');
  assert.equal(await page.locator('.editor-context-panel').isVisible(),false);
  const hb2=await handle.boundingBox(),beforeCancelledTrim=await currentTime();assert(hb2);await swipe(hb2.x+22,hb2.y+22,20,0,true);
  assert.equal(Number(await handle.getAttribute('aria-valuenow')),after,'Cancelled trim leaves recipe unchanged');
  assert(Math.abs(await currentTime()-beforeCancelledTrim)<.01,'Cancelled trim restores the playhead');
  await page.getByRole('button',{name:'Undo',exact:true}).tap();
  check('Touch trim has a 44px target, commits relative movement and cancels safely');
  await tool('Cut');const panel=await page.locator('.editor-context-panel').boundingBox();assert(panel&&panel.y>100);
  await page.getByLabel('Region 1 in timecode',{exact:true}).fill('10');await page.getByLabel('Region 1 in timecode',{exact:true}).press('Enter');
  await page.getByLabel('Region 1 out timecode',{exact:true}).fill('10.1');await page.getByLabel('Region 1 out timecode',{exact:true}).press('Enter');await closePanel();
  const hs=await handle.boundingBox(),he=await page.getByRole('slider',{name:'Region 1 end trim handle',exact:true}).boundingBox();assert(hs&&he&&hs.y+hs.height<=he.y,'Short-section trim handles do not overlap');
  await tool('Text');await page.getByRole('checkbox',{name:'Caption above video',exact:true}).check();await page.getByLabel('Caption text',{exact:true}).fill('Mobile edit');
  await closePanel();assert.equal(await page.locator('.text-track').isVisible(),true);
  await tool('Text');await page.getByLabel('Caption text',{exact:true}).focus();await page.keyboard.press('Escape');assert.equal(await page.locator('.editor-context-panel').isVisible(),false);
  check('Inspectors open over the timeline, close with Done/Escape, and populated caption lanes remain visible');
  const overlayFile=path.join(out,'overlay.png');await runProcess(media.ffmpeg,['-y','-v','error','-i',fixture,'-frames:v','1',overlayFile]);
  await tool('Overlay');await page.getByLabel('Choose overlay image',{exact:true}).setInputFiles(overlayFile);
  await page.waitForFunction(()=>document.querySelector('.cut-workspace')?.classList.contains('has-overlays'));await closePanel();
  await layout(844,390);
  const lanes=page.locator('.context-timeline'),laneBox=await lanes.boundingBox();assert(laneBox);
  const initialVertical=await lanes.evaluate(el=>el.scrollTop);
  await swipe(laneBox.x+laneBox.width*.85,laneBox.y+laneBox.height-20,0,-90);
  assert(await lanes.evaluate(el=>el.scrollTop)>initialVertical+20,'Vertical swipe reaches lower populated lanes');
  check('Landscape populated caption and overlay lanes scroll vertically by touch');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Back to Library',exact:true}).tap();await page.getByRole('button',{name:'Edit source',exact:true}).tap();
  assert.equal(await page.locator('.editor-context-panel').isVisible(),false);await tool('Cut');
  assert.equal(await page.getByLabel('Region 1 in timecode',{exact:true}).inputValue(),'00:00:10.000');
  assert.equal(await page.getByLabel('Region 1 out timecode',{exact:true}).inputValue(),'00:00:10.100');
  check('Returning from Library preserves the edit and opens the timeline with the sheet closed');
  assert.deepEqual(errors,[]);await writeFile(path.join(out,'evidence.json'),JSON.stringify({startedAt,completedAt:new Date().toISOString(),checks,errors,passed:true,physicalDeviceTested:false},null,2));await writeFile(path.join(base,'latest.json'),JSON.stringify({run:out,evidence:path.join(out,'evidence.json')},null,2));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});await writeFile(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:String(error),body:await page.locator('body').innerText()},null,2));throw error;}
finally{await browser.close();await app.close();}
