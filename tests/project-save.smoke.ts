import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools, runProcess } from '../packages/media/src/index.ts';

const output=path.resolve('test-output/project-save');await mkdir(output,{recursive:true});
const tools=await discoverTools(),fixture=path.join(output,'project-source.mp4');
await runProcess(tools.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=4','-c:v','libx264',fixture]);
const token=randomUUID(),app=await createServer({dataDir:path.join(output,`service-${Date.now()}`),ownerToken:token,tools,encoders:[]});
await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();assert(address&&typeof address==='object');
const origin=`http://127.0.0.1:${address.port}`,browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1280,height:900}});
const checks:string[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
const dialog=page.getByRole('dialog',{name:'Save your edit'}),open=()=>page.getByRole('button',{name:'Project saving',exact:true}).click(),close=()=>dialog.getByRole('button',{name:'Close project saving'}).click();
const projects=async()=>await (await page.request.get(`${origin}/api/v1/projects`)).json();
let submits=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/v1/projects'))submits++;});
try {
 await page.goto(origin);await page.getByLabel('Access token').fill(token);await page.getByRole('button',{name:'Connect',exact:true}).click();
 await page.locator('.app-header').getByRole('button',{name:'Import',exact:true}).click();await page.getByLabel('Local media').setInputFiles(fixture);
 await page.getByRole('heading',{name:'Library',exact:true}).waitFor();await page.getByRole('region',{name:'File imports'}).getByRole('button',{name:'Dismiss'}).click();await page.getByRole('button',{name:'Edit source',exact:true}).click();
 await open();await dialog.getByLabel('Project name').fill('First edit');await dialog.getByRole('button',{name:'Save project',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Project saved: First edit.'}).waitFor();
 const first=(await projects())[0];assert.equal(first.name,'First edit');
 await dialog.getByLabel('Project name').fill('Updated edit');await dialog.getByRole('button',{name:'Update project',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Project saved: Updated edit.'}).waitFor();assert.equal((await projects()).length,1);assert.equal((await projects())[0].id,first.id);assert.equal((await projects())[0].name,'Updated edit');
 await dialog.getByLabel('Copy name').fill('Alternate cut');await dialog.getByRole('button',{name:'Save a copy',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Copy saved: Alternate cut.'}).waitFor();let rows=await projects();assert.equal(rows.length,2);assert.equal(rows.find((p:any)=>p.id===first.id).name,'Updated edit');const copy=rows.find((p:any)=>p.id!==first.id);assert.equal(await dialog.getByLabel('Project name').inputValue(),'Updated edit');
 checks.push('At 1280px, create/update/copy reach real persisted projects; update preserves ID and copy leaves original intact.');
 await page.route('**/api/v1/projects',async route=>{if(route.request().method()==='POST')await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Test save outage'})});else await route.continue();});
 await dialog.getByRole('button',{name:'Update project',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'Test save outage'}).waitFor();assert.equal((await projects()).length,2);await page.screenshot({path:path.join(output,'retry-feedback.png')});await page.unroute('**/api/v1/projects');
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);await page.route('**/api/v1/projects',async route=>{if(route.request().method()==='POST'){await gate;await route.continue();}else await route.continue();});
 const before=submits;await dialog.getByRole('button',{name:'Update project',exact:true}).evaluate((b:HTMLButtonElement)=>{b.click();b.click();});await dialog.getByRole('status').filter({hasText:'Saving this snapshot'}).waitFor();await close();
 await page.getByLabel('Region 1 in timecode').fill('0.5');await page.getByLabel('Region 1 in timecode').press('Tab');await open();await dialog.getByLabel('Project name').fill('Newer edit');release();await dialog.getByRole('status').filter({hasText:'Newer changes have not been saved'}).waitFor();assert.equal(submits,before+1);assert.equal(await dialog.getByLabel('Project name').inputValue(),'Newer edit');await close();assert.equal(await page.getByLabel('Region 1 in timecode').inputValue(),'00:00:00.500');await page.unroute('**/api/v1/projects');
 await open();await dialog.getByRole('button',{name:'Update project',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Project saved: Newer edit.'}).waitFor();rows=await projects();assert.equal(rows.find((p:any)=>p.id===first.id).recipe.segments[0].in,.5);assert.equal(rows.find((p:any)=>p.id===copy.id).recipe.segments[0].in,0);
 checks.push('503 failure remains local and retry succeeds; rapid duplicate clicks submit once; edits/name changed during slow save remain live and are flagged as newer.');
 await dialog.getByLabel('Project name').fill('  ');assert.ok(await dialog.getByRole('button',{name:'Update project',exact:true}).isDisabled());await dialog.getByLabel('Project name').fill('Newer edit');await page.keyboard.press('Escape');await page.goBack();await page.getByRole('heading',{name:'Library',exact:true}).waitFor();await page.goForward();await open();assert.ok(await dialog.getByRole('button',{name:'Update project',exact:true}).isVisible());await close();
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Project saving',exact:true}).focus();await page.keyboard.press('Enter');await dialog.waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await dialog.evaluate(d=>d.scrollWidth<=d.clientWidth));
 await dialog.getByLabel('Copy name').fill('Mobile variant');await dialog.getByRole('button',{name:'Save a copy',exact:true}).focus();await page.keyboard.press('Enter');await dialog.getByRole('status').filter({hasText:'Copy saved: Mobile variant.'}).waitFor();assert.equal((await projects()).length,3);await page.screenshot({path:path.join(output,'mobile-saved.png')});await page.keyboard.press('Escape');assert.ok(await page.getByRole('button',{name:'Project saving',exact:true}).evaluate(e=>e===document.activeElement));
 await page.reload();await open();assert.equal(await dialog.getByLabel('Project name').inputValue(),'Newer edit');assert.ok(await dialog.getByRole('button',{name:'Update project',exact:true}).isVisible());await close();
 checks.push('Reload retains current project name/identity; copies retain their earlier cuts after original updates.');
 checks.push('Empty names disabled; Back/Forward retains project identity; 390px keyboard save-copy and Escape/focus return work without horizontal overflow.');
 assert.deepEqual(errors,[]);await writeFile(path.join(output,'checks.json'),JSON.stringify({checks,errors,submits},null,2));console.log(JSON.stringify({checks,errors,submits},null,2));
} catch(error){await page.screenshot({path:path.join(output,'failure.png')});throw error;}
finally {await browser.close();await app.close();}
