import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {chromium,type Page} from 'playwright';
import {createServer} from '../apps/server/src/app.ts';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';

await mkdir(path.resolve('test-output'),{recursive:true});
const output=await mkdtemp(path.resolve('test-output/preview-reliability-')),tools=await discoverTools(),fixture=path.join(output,'fixture.mp4');
await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x72:rate=10:duration=4','-c:v','libx264','-g','10','-bf','2','-pix_fmt','yuv420p','-movflags','+faststart',fixture]);
const token=randomUUID(),app=await createServer({dataDir:path.join(output,'service'),ownerToken:token,encoders:[],tools});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,page:Page|undefined;
const checks:string[]=[],pageErrors:string[]=[];
try{
  const harness=`
    import React,{useCallback,useEffect,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {RenderedPreview} from './apps/web/src/RenderedPreview.tsx';
    import {api} from './apps/web/src/api.ts';
    import {RecipeSchema,ExportSchema} from './packages/contracts/src/index.ts';
    const original=RecipeSchema.parse({sourceId:new URLSearchParams(window.location.search).get('source'),segments:[{in:0,out:3}],audio:{mode:'mute'}});
    const options=ExportSchema.parse({cut:'copy',copyValidation:'full',mode:'auto'});
    function Harness(){
      const [recipe,setRecipe]=useState(original),[jobs,setJobs]=useState([]),[artifacts,setArtifacts]=useState([]),[host,setHost]=useState(null),[mounted,setMounted]=useState(true);
      const refresh=useCallback(async()=>{const [jobs,artifacts]=await Promise.all([api.jobs(),api.artifacts()]);setJobs(jobs);setArtifacts(artifacts);},[]);
      useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),100);return()=>clearInterval(timer);},[]);
      window.fixture={change:()=>setRecipe({...original,segments:[{in:0,out:2}]}),reset:()=>setRecipe(original),unmount:()=>setMounted(false),refresh};
      return <><div ref={setHost}/>{mounted&&<RenderedPreview recipe={recipe} options={options} jobs={jobs} artifacts={artifacts} allowed refresh={refresh} onOpen={()=>{}} dialogHost={host}/>}</>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `;
  const bundle=await build({stdin:{contents:harness,resolveDir:process.cwd(),loader:'tsx',sourcefile:'preview-reliability-harness.tsx'},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});
  app.get('/__preview_reliability.js',async(_req,reply)=>reply.type('application/javascript').send(bundle.outputFiles[0].text));
  app.get('/__preview_reliability',async(_req,reply)=>reply.type('text/html').send('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/__preview_reliability.js"></script></body></html>'));
  const imported=await app.inject({method:'POST',url:'/api/v1/uploads',headers:{host:'localhost',authorization:`Bearer ${token}`,'content-type':'application/octet-stream','x-filename':'fixture.mp4'},payload:await readFile(fixture)});
  assert.equal(imported.statusCode,200,imported.body);const sourceId=imported.json().id;
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  browser=await chromium.launch({channel:process.env.MW_BROWSER_CHANNEL||'msedge',headless:true});page=await browser.newPage({viewport:{width:1366,height:900}});page.on('pageerror',error=>pageErrors.push(error.message));
  const session=await page.request.post(`${origin}/api/v1/session`,{data:{token}});assert.equal(session.status(),200);
  await page.goto(`${origin}/__preview_reliability?source=${sourceId}`);
  const dialog=page.getByRole('dialog',{name:'Export preview',exact:true}),start=page.getByRole('button',{name:'Render preview',exact:true}),video=dialog.getByLabel('Rendered export preview',{exact:true});
  await start.waitFor();
  let releasePlan!:()=>void,planSeen!:()=>void;const seen=new Promise<void>(resolve=>planSeen=resolve),gate=new Promise<void>(resolve=>releasePlan=resolve);
  await page.route('**/api/v1/export/plan',async route=>{planSeen();await gate;await route.continue().catch(()=>{});});
  await start.click();await seen;await page.evaluate('window.fixture.change()');await dialog.getByRole('alert').filter({hasText:'The edit changed while preparing'}).waitFor();releasePlan();await page.unroute('**/api/v1/export/plan');
  assert.equal(app.store.jobs(imported.json().ownerId).length,0);checks.push('An edit changed during planning aborts the old request and submits no export');
  await dialog.getByRole('button',{name:'Close preview',exact:true}).click();await page.evaluate('window.fixture.reset()');
  let lost=false;const retryKeys:string[]=[];
  await page.route('**/api/v1/jobs',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    retryKeys.push(route.request().headers()['idempotency-key']);
    if(!lost){lost=true;const response=await route.fetch();assert.equal(response.status(),202);await route.abort('failed');}else await route.continue();
  });
  await start.click();await dialog.getByRole('alert').filter({hasText:/Failed to fetch|Load failed|NetworkError/}).waitFor();
  assert.equal(app.store.jobs(imported.json().ownerId).length,1);
  await dialog.getByRole('button',{name:'Close preview',exact:true}).click();await start.click();await video.waitFor({timeout:45000});
  assert.equal(retryKeys.length,1);assert.equal(app.store.jobs(imported.json().ownerId).length,1);await page.unroute('**/api/v1/jobs');
  await page.waitForFunction(()=>document.querySelector('video')!.readyState>=2);checks.push('A lost submission response reconnects the accepted durable job without another POST');
  await video.evaluate((element:HTMLVideoElement)=>{element.pause();(element as any).originalPlay=element.play;element.play=()=>Promise.reject(new DOMException('Playback blocked','NotAllowedError'));});
  await dialog.getByRole('button',{name:'Play from start',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'Playback did not start'}).waitFor();
  await video.evaluate((element:HTMLVideoElement)=>{element.play=(element as any).originalPlay;});await dialog.getByRole('button',{name:'Play from start',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('video')!.currentTime>0&&!document.querySelector('video')!.paused);assert.equal(await dialog.getByRole('alert').filter({hasText:'Playback did not start'}).count(),0);checks.push('Actual rendered MP4 advances playback and successful replay clears the earlier error');
  const completed=app.store.jobs(imported.json().ownerId)[0];assert.equal(completed.state,'completed');const oldOutput=completed.artifactId!;
  const oldPlayer=await video.elementHandle();assert.ok(oldPlayer);await page.evaluate('window.fixture.change()');await dialog.getByRole('status').filter({hasText:'earlier edit'}).waitFor();assert.equal(await video.count(),0);assert.equal(await oldPlayer.evaluate(element=>(element as HTMLVideoElement).paused),true);await oldPlayer.dispose();checks.push('Changing the edit stops actual playback and marks the completed preview outdated');
  await page.evaluate('window.fixture.reset()');await video.waitFor();await dialog.getByRole('button',{name:'Close preview',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('video'));const removed=await page.request.delete(`${origin}/api/v1/artifacts/${oldOutput}`);assert.equal(removed.status(),200,await removed.text());assert.equal((await removed.json()).historyRetained,true);await page.evaluate('window.fixture.refresh()');
  // Reopen through the dialog without starting a replacement, to inspect missing-output recovery.
  await page.evaluate('document.querySelector("dialog").showModal()');await dialog.getByRole('alert').filter({hasText:'no longer available'}).waitFor();await dialog.getByRole('button',{name:'Render again',exact:true}).click();await video.waitFor({timeout:45000});
  assert.equal(app.store.jobs(imported.json().ownerId).length,2);assert.notEqual(await video.getAttribute('src'),`/api/v1/artifacts/${oldOutput}/content`);checks.push('A deleted rendered artifact has explicit recovery and Render again produces a validated replacement');
  await dialog.getByRole('button',{name:'Close preview',exact:true}).click();await page.evaluate('window.fixture.change()');
  let pendingPlan!:()=>void,releaseUnmount!:()=>void;const pending=new Promise<void>(resolve=>pendingPlan=resolve),unmountGate=new Promise<void>(resolve=>releaseUnmount=resolve);
  await page.route('**/api/v1/export/plan',async route=>{pendingPlan();await unmountGate;await route.continue().catch(()=>{});});await start.click();await pending;await page.evaluate('window.fixture.unmount()');releaseUnmount();await page.unroute('**/api/v1/export/plan');await page.waitForTimeout(150);
  assert.equal(app.store.jobs(imported.json().ownerId).length,2);assert.deepEqual(pageErrors,[]);checks.push('Unmounting during planning cancels the request, submits no job and raises no browser errors');
  await writeFile(path.join(output,'result.json'),JSON.stringify({testedAt:new Date().toISOString(),checks,pageErrors,jobCount:2},null,2));console.log(JSON.stringify({output,checks:checks.length,pageErrors}));
}catch(error){if(page)await writeFile(path.join(output,'page.html'),await page.content());await writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),checks,pageErrors},null,2));throw error;}
finally{await browser?.close();await app.close();}
