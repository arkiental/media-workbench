import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from '../apps/server/src/app.ts';
import { discoverTools, runProcess, exportMedia, testEncoders, planExport, probe } from '../packages/media/src/index.ts';
import { RecipeSchema, ExportSchema, type ExecutionContext } from '../packages/contracts/src/index.ts';

const tools=await discoverTools();const root=path.resolve('test-output');await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'overlay-'));
const ctx=():ExecutionContext=>({signal:new AbortController().signal,workDir:dir,maxRuntimeSeconds:120});
const source=path.join(dir,'black.mp4'),image=path.join(dir,'red.png');
await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','color=black:size=320x180:rate=10:duration=4','-c:v','libx264','-pix_fmt','yuv420p',source]);
await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','color=red:size=64x32','-frames:v','1',image]);
const pixel=async(file:string,at:number,x:number,y:number)=>[...(await runProcess(tools.ffmpeg,['-v','error','-ss',String(at),'-i',file,'-frames:v','1','-vf',`crop=2:2:${x}:${y}`,'-f','rawvideo','-pix_fmt','rgb24','-'])).stdout].slice(0,3);
const red=([r,g,b]:number[])=>r>180&&g<70&&b<70;

test('overlay composites at its picture position only while visible, mapped through cuts',{timeout:120000},async()=>{
  const imageId=randomUUID(),out=path.join(dir,'overlaid.mp4');
  // Source 0.5–2.5 s survives the cut as output 0.5–1.5 s.
  const recipe=RecipeSchema.parse({sourceId:randomUUID(),segments:[{in:0,out:1},{in:2,out:4}],audio:{mode:'mute'},overlays:[{imageId,in:.5,out:2.5,x:.25,y:.5,width:.2}]});
  const encoders=await testEncoders(tools,dir);
  assert.equal(planExport(recipe,ExportSchema.parse({cut:'auto',mode:'auto'}),await probe(source,tools),encoders).strategy,'exact');
  await exportMedia(source,out,recipe,ExportSchema.parse({cut:'exact'}),tools,ctx(),undefined,{[imageId]:image});
  assert(!red(await pixel(out,.2,80,90)),'hidden before its start');
  assert(red(await pixel(out,.75,80,90)),'visible in the first kept section');
  assert(red(await pixel(out,1.25,80,90)),'visible after the cut');
  assert(!red(await pixel(out,2.5,80,90)),'hidden after its end');
  assert(!red(await pixel(out,.75,160,90)),'confined to its width');
  await assert.rejects(exportMedia(source,path.join(dir,'missing.mp4'),recipe,ExportSchema.parse({cut:'exact'}),tools,ctx()),/overlay image is missing/i);
});

test('overlay upload accepts PNG images only and serves them to their owner',{timeout:60000},async()=>{
  const app=await createServer({dataDir:await mkdtemp(path.join(dir,'api-')),ownerToken:'overlay-owner-'+randomUUID(),startQueue:false,encoders:[]});
  const owner=app.store.users().find(u=>u.role==='owner')!,other=app.store.createUser('Other','member');
  const headers=(token:string)=>({host:'localhost',authorization:`Bearer ${token}`,'content-type':'image/png'});
  const ownerToken=app.store.token(owner.id,'t').token,otherToken=app.store.token(other.id,'t').token;
  try{
    const png=await readFile(image);
    const uploaded=await app.inject({method:'POST',url:'/api/v1/overlays',headers:{...headers(ownerToken),'x-filename':'red.png'},payload:png});
    assert.equal(uploaded.statusCode,200,uploaded.body);const record=uploaded.json();assert.equal(record.width,64);assert.equal(record.height,32);
    const content=await app.inject({method:'GET',url:`/api/v1/overlays/${record.id}/content`,headers:headers(ownerToken)});
    assert.equal(content.statusCode,200);assert(content.rawPayload.equals(png));
    assert.equal((await app.inject({method:'GET',url:`/api/v1/overlays/${record.id}/content`,headers:headers(otherToken)})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/overlays',headers:headers(ownerToken),payload:Buffer.from('GIF89a not a png')})).statusCode,415);
  }finally{await app.close();}
});
