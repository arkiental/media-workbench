import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,readdir,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {discoverTools,runProcess,inspectLocalImport,validateMedia,testEncoders,exportMedia,createProxy} from '../packages/media/src/index.ts';
import {RecipeSchema,ExportSchema,type ToolPaths,type ExecutionContext} from '../packages/contracts/src/index.ts';

let root:string,tools:ToolPaths,video:string,slow:string,audio:string;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
before(async()=>{
  await mkdir(resolve('test-output'),{recursive:true});root=await mkdtemp(resolve('test-output/media-reliability-'));tools=await discoverTools();
  video=join(root,'valid.mp4');slow=join(root,'slow.mp4');audio=join(root,'audio.wav');
  for(const [file,rate]of [[video,10],[slow,1]] as const)await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i',`testsrc2=size=128x72:rate=${rate}:duration=4`,'-c:v','libx264','-g',String(rate),'-bf','2','-pix_fmt','yuv420p','-movflags','+faststart',file]);
  await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','pcm_s16le',audio]);
});
after(async()=>{await writeFile(join(root,'evidence.json'),JSON.stringify({testedAt:new Date().toISOString(),ffmpeg:tools.ffmpeg,fixtures:[video,slow,audio]},null,2));});
const context=(workDir:string):ExecutionContext=>({workDir,signal:new AbortController().signal,maxRuntimeSeconds:30,maxCpuCores:2});

test('bounded imports accept audio and slow frame rates; corrupt, unsupported and truncated files fail',async()=>{
  for(const file of [video,slow,audio]){const ctx=context(root),argsSeen:string[][]=[];ctx.runTool=async(binary,args,options)=>{argsSeen.push(args);return runProcess(binary,args,context(root),options);};const media=await inspectLocalImport(file,tools,ctx);assert.ok(media.duration>0);const decodes=argsSeen.filter(args=>args.includes('-xerror'));assert.equal(decodes.length,2);assert.ok(decodes.every(args=>args[args.indexOf('-t')+1]==='0.25'));}
  const bytes=await readFile(video),beforeHash=digest(bytes);
  const corrupt=join(root,'corrupt.mp4'),unsupported=join(root,'unsupported.txt'),truncated=join(root,'truncated.mp4');
  await writeFile(corrupt,Buffer.alloc(400));await writeFile(unsupported,'This is not playable media');await writeFile(truncated,bytes.subarray(0,Math.floor(bytes.length*.55)));
  for(const file of [corrupt,unsupported,truncated]){await assert.rejects(inspectLocalImport(file,tools,context(root)));await assert.rejects(validateMedia(file,tools,context(root)));}
  assert.equal(digest(await readFile(video)),beforeHash);
});

test('software encoder smoke recovers after a transient failure and only caches verified success',async()=>{
  const version=`reliability-fixture-${randomUUID()}`,ctx=context(root);let transient=true,smokes=0;
  ctx.runTool=async(binary,args,options)=>{
    if(args.includes('-version'))return {stdout:Buffer.from(version),stderr:'',exitCode:0};
    if(args.includes('-encoders'))return {stdout:Buffer.from(' V..... libx264 software H264\n'),stderr:'',exitCode:0};
    if(args.includes('lavfi')){smokes++;if(transient)throw new Error('Native tool exceeded runtime limit');}
    return runProcess(binary,args,context(root),options);
  };
  const first=await testEncoders(tools,root,ctx,'h264');assert.equal(first.find(e=>e.name==='libx264')?.available,false);
  transient=false;const second=await testEncoders(tools,root,ctx,'h264');assert.equal(second.find(e=>e.name==='libx264')?.available,true);assert.equal(smokes,2);
  const third=await testEncoders(tools,root,ctx,'h264');assert.equal(third.find(e=>e.name==='libx264')?.available,true);assert.equal(smokes,2);
});

test('concurrent codec tests retain each verified software result',async()=>{
  const version=`concurrent-codecs-${randomUUID()}`,ctx=context(root),smokes=new Map<string,number>();
  let release!:()=>void,seen!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>seen=resolve);
  ctx.runTool=async(binary,args,options)=>{
    if(args.includes('-version'))return {stdout:Buffer.from(version),stderr:'',exitCode:0};
    if(args.includes('-encoders'))return {stdout:Buffer.from(' V..... libx264 software H264\n V..... libx265 software HEVC\n'),stderr:'',exitCode:0};
    if(args.includes('lavfi')){const name=args[args.indexOf('-c:v')+1];smokes.set(name,(smokes.get(name)??0)+1);if(name==='libx264'&&smokes.get(name)===1){seen();await gate;}}
    return runProcess(binary,args,context(root),options);
  };
  const h264=testEncoders(tools,root,ctx,'h264');await started;
  try{const hevc=await testEncoders(tools,root,ctx,'hevc');assert.equal(hevc.find(e=>e.name==='libx265')?.available,true);}finally{release();}
  assert.equal((await h264).find(e=>e.name==='libx264')?.available,true);
  await testEncoders(tools,root,ctx,'hevc');assert.equal(smokes.get('libx265'),1);
});

test('corruption after encoding is rejected before publication and a retry still succeeds',async()=>{
  const work=await mkdtemp(join(root,'corruption-')),beforeHash=digest(await readFile(video)),output=join(work,'result.mp4'),ctx=context(work);
  const recipe=RecipeSchema.parse({sourceId:randomUUID(),segments:[{in:0,out:3}],audio:{mode:'mute'}}),options=ExportSchema.parse({cut:'copy',copyValidation:'full',mode:'auto'});
  let corrupted=false;
  ctx.runTool=async(binary,args,runOptions)=>{const result=await runProcess(binary,args,context(work),runOptions);if(args.includes('-c')&&args[args.indexOf('-c')+1]==='copy'&&runOptions?.outputPath&&!corrupted){const bytes=await readFile(runOptions.outputPath);await writeFile(runOptions.outputPath,bytes.subarray(0,Math.floor(bytes.length/2)));corrupted=true;}return result;};
  await assert.rejects(exportMedia(video,output,recipe,options,tools,ctx));assert.equal(corrupted,true);await assert.rejects(access(output));assert.equal((await readdir(work)).filter(file=>file.startsWith('.partial-')).length,0);assert.equal(digest(await readFile(video)),beforeHash);
  const retry=await exportMedia(video,output,recipe,options,tools,context(work));assert.equal(retry.plan.strategy,'copy');assert.equal((await validateMedia(output,tools)).duration,retry.media.duration);
  const completed=digest(await readFile(output));await assert.rejects(exportMedia(video,output,recipe,options,tools,context(work)),/refusing overwrite/);assert.equal(digest(await readFile(output)),completed);
});

test('cancelling final export or proxy validation publishes no output and preserves the original',async()=>{
  const original=digest(await readFile(video));
  for(const kind of ['export','proxy'] as const){const work=await mkdtemp(join(root,`${kind}-cancel-`)),output=join(work,'result.mp4'),controller=new AbortController(),ctx={...context(work),signal:controller.signal};let validation=false;
    ctx.runTool=async(binary,args,options)=>{const result=await runProcess(binary,args,context(work),options);if(args.includes('-xerror')&&args.includes('null')&&args[args.indexOf('-i')+1]!==video){validation=true;controller.abort();}return result;};
    const operation=kind==='proxy'?createProxy(video,output,tools,ctx):exportMedia(video,output,RecipeSchema.parse({sourceId:randomUUID(),segments:[{in:0,out:3}],audio:{mode:'mute'}}),ExportSchema.parse({cut:'copy',copyValidation:'full',mode:'auto'}),tools,ctx);
    await assert.rejects(operation,/cancelled/i);assert.equal(validation,true);await assert.rejects(access(output));assert.equal((await readdir(work)).some(file=>file.startsWith('.partial-')||file.startsWith('.proxy-')),false);
  }
  assert.equal(digest(await readFile(video)),original);
});
