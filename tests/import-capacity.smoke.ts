import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createServer} from '../apps/server/src/app.ts';
import {discoverTools,runProcess} from '../packages/media/src/index.ts';

await mkdir('test-output/import-capacity',{recursive:true});const output=await mkdtemp(path.resolve('test-output/import-capacity/run-'));
const tools=await discoverTools(),fixture=path.join(output,'valid.mp4'),invalid=path.join(output,'invalid.mp4');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=3','-c:v','libx264',fixture]);await writeFile(invalid,'Not media');
const bytes=await readFile(fixture),token=randomUUID(),app=await createServer({dataDir:path.join(output,'service'),ownerToken:token,tools});
await app.listen({host:'127.0.0.1',port:0});const origin=`http://127.0.0.1:${(app.server.address() as any).port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[],checks:string[]=[];
page.on('pageerror',e=>errors.push(e.message));const queue=page.getByRole('region',{name:'File imports'}),waiting=queue.getByText('Waiting for preview work. Retrying automatically.',{exact:true});
const open=async()=>{if(await queue.count())await queue.getByRole('button',{name:'Dismiss',exact:true}).click();await page.locator('.app-header').getByRole('button',{name:'Import',exact:true}).click();};
const count=()=>page.evaluate(async()=>(await(await fetch('/api/v1/sources')).json()).length);
const held:ReturnType<typeof httpRequest>[]=[];
try{
 await page.goto(origin);await page.getByLabel('Access token').fill(token);await page.getByRole('button',{name:'Connect',exact:true}).click();await open();
 let calls=0,accepted=0,invalidCalls=0;
 await page.route('**/api/v1/uploads',async route=>{calls++;const name=decodeURIComponent(route.request().headers()['x-filename']);if(name==='invalid.mp4')invalidCalls++;if(calls<=2)await route.fulfill({status:429,json:{error:'Two preview/inspection operations already active'}});else{accepted++;await route.continue();}});
 await page.getByLabel('Local media').setInputFiles([fixture,invalid]);await waiting.waitFor();
 const extra=await page.evaluateHandle(()=>{const d=new DataTransfer();d.items.add(new File(['extra'],'extra.mp4'));return d;});await page.locator('body').dispatchEvent('drop',{dataTransfer:extra});
 await page.getByRole('status').filter({hasText:'An import is already running.'}).waitFor();
 assert.equal(await page.getByRole('alert').filter({hasText:'An import is already running.'}).count(),0,'Duplicate drop is an informational status, not an import failure');
 await page.screenshot({path:path.join(output,'mobile-waiting.png')});
 await queue.getByText(/1 of 2 ready.*1 failed/).waitFor();assert.equal(calls,4);assert.equal(accepted,2);assert.equal(invalidCalls,1);assert.equal(await count(),1);
 checks.push('Known busy responses recover automatically; valid file publishes once, invalid media fails once, and another drop during waiting cannot start a second batch.');await page.unroute('**/api/v1/uploads');
 await open();calls=0;await page.route('**/api/v1/uploads',async route=>{calls++;await route.fulfill({status:429,json:{error:'Host preview/upload capacity reached'}});});
 await page.getByLabel('Local media').setInputFiles([fixture,fixture]);await waiting.waitFor();await queue.getByRole('button',{name:'Stop import'}).click();await queue.getByText('Import stopped',{exact:true}).waitFor();await page.waitForTimeout(2200);assert.equal(calls,1);assert.equal(await count(),1);checks.push('Stop during backoff cancels immediately, sends no later retry and skips queued files.');
 await open();calls=0;const began=Date.now();await page.getByLabel('Local media').setInputFiles(fixture);await queue.getByRole('button',{name:'Retry failed files'}).waitFor({timeout:20000});assert.equal(calls,8);assert(Date.now()-began<18000);await queue.getByText('File details',{exact:true}).click();await queue.getByText('Preview work is still busy. Wait a moment, then use Retry failed files.',{exact:true}).waitFor();await page.unroute('**/api/v1/uploads');await queue.getByRole('button',{name:'Retry failed files'}).click();await queue.getByText('1 of 1 ready',{exact:true}).waitFor();assert.equal(await count(),2);checks.push('Persistent capacity pressure stops after eight attempts with readable feedback; explicit retry later succeeds once.');
 await open();calls=0;await page.route('**/api/v1/uploads',async route=>{calls++;await route.fulfill({status:429,json:{error:'Account upload quota reached'}});});await page.getByLabel('Local media').setInputFiles(fixture);await queue.getByRole('button',{name:'Retry failed files'}).waitFor();await page.waitForTimeout(700);assert.equal(calls,1);await page.unroute('**/api/v1/uploads');checks.push('Unrelated 429 errors are not treated as temporary preview capacity.');
 await open();await page.waitForLoadState('networkidle');calls=0;await page.route('**/api/v1/uploads',async route=>{calls++;const response=await fetch(origin+'/api/v1/uploads',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/octet-stream','x-filename':'valid.mp4'},body:bytes});assert(response.ok,await response.text());await route.abort('connectionreset');});await page.getByLabel('Local media').setInputFiles(fixture);await queue.getByRole('button',{name:'Retry failed files'}).waitFor();await page.waitForTimeout(1000);assert.equal(calls,1);assert.equal(await count(),3);await page.unroute('**/api/v1/uploads');checks.push('Lost accepted response remains an interruption, without automatic resubmission or duplicate publication.');
 await open();const completed:Promise<number>[]=[];
 for(let i=0;i<2;i++){let resolve!:(code:number)=>void;completed.push(new Promise(r=>resolve=r));const req=httpRequest(origin+'/api/v1/uploads',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','x-filename':`held-${i}.mp4`}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode||0));});req.on('error',()=>resolve(0));held.push(req);req.write(bytes.subarray(0,100));}
 let busy=false;for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,50));const probe=await fetch(origin+'/api/v1/uploads',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream'},body:'invalid'});if(probe.status===429){busy=true;break;}}assert(busy,'Two real streams must occupy admission slots');
 calls=0;page.on('request',request=>{if(request.url().endsWith('/api/v1/uploads'))calls++;});await page.getByLabel('Local media').setInputFiles(fixture);await waiting.waitFor();assert.equal(await count(),3);held.forEach(req=>req.end(bytes.subarray(100)));assert.deepEqual(await Promise.all(completed),[200,200]);await queue.getByText('1 of 1 ready',{exact:true}).waitFor();assert.equal(await count(),6);assert(calls>=2);checks.push('Two real in-flight uploads saturate the server; the UI waits and imports once when slots free, with limits unchanged.');
 assert.deepEqual(errors,[]);await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({output,checks,errors}));
}catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await writeFile(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:String(error),body:await page.locator('body').textContent()},null,2));throw error;}
finally{held.forEach(req=>req.destroy());await browser.close();await app.close();}
