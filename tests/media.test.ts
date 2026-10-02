import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, access, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { mediaThreads } from '../packages/media/src/index.ts';
import { generateFixtures } from '../packages/test-fixtures/generate.ts';
import { discoverTools, toolVersions, probe, runProcess, testEncoders, planExport, exportMedia, frameIndex, extractFrame, waveform, createProxy, mapCues } from '../packages/media/src/index.ts';
import { RecipeSchema, ExportSchema } from '../packages/contracts/src/index.ts';
import type { ExecutionContext } from '../packages/contracts/src/index.ts';

const tools=await discoverTools();await mkdir(resolve('test-output'),{recursive:true});const root=await mkdtemp(resolve('test-output/media-'));const fixtures=await generateFixtures(join(root,'fixtures'),tools);const encoders=await testEncoders(tools,root);
const ctx=():ExecutionContext=>({signal:new AbortController().signal,workDir:root,maxRuntimeSeconds:120});
const recipe=(patch:Record<string,unknown>={})=>RecipeSchema.parse({sourceId:randomUUID(),segments:[{in:0,out:4}],...patch});
const options=(patch:Record<string,unknown>={})=>ExportSchema.parse({cut:'exact',quality:0,...patch});
async function hashes(path:string){return (await runProcess(tools.ffmpeg,['-hide_banner','-loglevel','error','-i',path,'-map','0:v:0','-an','-c:v','rawvideo','-pix_fmt','yuv420p','-f','framemd5','-'])).stdout.toString().split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1)!.trim());}
async function audioSamples(path:string){return (await runProcess(tools.ffmpeg,['-v','error','-i',path,'-map','0:a:0','-ac','1','-ar','48000','-c:a','pcm_s16le','-f','s16le','-'])).stdout;}
const evidence:any={testedAt:new Date().toISOString(),platform:process.platform,versions:await toolVersions(tools),encoders,outputs:[],checks:[]};

test('CPU threads use the machine capacity while respecting explicit worker budgets',()=>{
  assert.equal(mediaThreads(),availableParallelism());
  assert.equal(mediaThreads({...ctx(),maxCpuCores:2}),Math.min(2,availableParallelism()));
  assert.equal(mediaThreads({...ctx(),maxCpuCores:.25}),1);
});

test('real NVIDIA fast exports preserve full duration and strict size across supported codecs',async t=>{
  const supported=encoders.filter(e=>e.available&&e.name.endsWith('_nvenc'));
  if(!supported.length){t.skip('No operational NVIDIA encoder');return;}
  for(const encoder of supported){
    const output=join(root,`gpu-fast-${encoder.codec}.mp4`);
    const result=await exportMedia(fixtures.numbered,output,recipe(),options({encoder:'hardware',allowSoftwareFallback:false,codec:encoder.codec,speed:'fast',mode:'size',maxBytes:150000,maxAttempts:1}),tools,{...ctx(),allowedEncoders:[encoder.name]});
    assert.equal(result.plan.encoder,encoder.name);assert.equal(result.plan.hardware,true);assert.equal(result.plan.cpuThreads,availableParallelism());
    assert(result.media.size<=150000);assert.equal((await hashes(output)).length,40);assert(Math.abs(result.media.duration-4)<.15);
    evidence.outputs.push({path:output,...result});
  }
});

test('max-size H264/HEVC budgets finish in one pass with complete short, silent and multi-cut outputs',async()=>{
  for(const [name,edit,settings,frames] of [
    ['audio',recipe(),{maxBytes:90000},40],
    ['short',recipe({segments:[{in:.2,out:1}],audio:{mode:'mute'}}),{maxBytes:30000},8],
    ['multi',recipe({segments:[{in:0,out:1},{in:2,out:3}],audio:{mode:'mute'}}),{maxBytes:50000},20],
    ['hevc',recipe({audio:{mode:'mute'}}),{maxBytes:90000,codec:'hevc'},40],
  ] as const){
    let encodes=0,validations=0;const base=ctx();const output=join(root,`one-pass-${name}.mp4`);
    const result=await exportMedia(fixtures.numbered,output,edit,options({mode:'size',maxAttempts:1,...settings}),tools,{...base,runTool:async(binary,args,processOptions)=>{
      if(args.includes('-/filter_complex')){encodes++;assert(!args.includes('-pass'));assert(!args.includes('-fs'));}
      if(args.includes('-xerror')&&args.some(arg=>arg.includes('.partial-')))validations++;
      return runProcess(binary,args,base,processOptions);
    }});
    assert.equal(encodes,1);assert.equal(validations,1);assert(result.media.size<=settings.maxBytes);assert.equal((await hashes(output)).length,frames);
  }
});

test('oversized candidate skips decode; correction and exhausted budget never publish oversize',async()=>{
  for(const maxAttempts of [1,2]){
    let encodes=0,validations=0;const base=ctx(),output=join(root,`forced-oversize-${maxAttempts}.mp4`);
    const operation=exportMedia(fixtures.numbered,output,recipe({audio:{mode:'mute'}}),options({mode:'size',maxBytes:90000,maxAttempts}),tools,{...base,runTool:async(binary,args,processOptions)=>{
      if(args.includes('-xerror')&&args.some(arg=>arg.includes('.partial-')))validations++;
      const result=await runProcess(binary,args,base,processOptions);
      if(args.includes('-/filter_complex')&&++encodes===1)await appendFile(processOptions!.outputPath!,Buffer.alloc(100000));
      return result;
    }});
    if(maxAttempts===1){await assert.rejects(operation,/Cannot meet/);await assert.rejects(access(output));assert.equal(validations,0);}
    else{const result=await operation;assert.equal(encodes,2);assert.equal(validations,1);assert(result.media.size<=90000);assert.equal((await hashes(output)).length,40);}
  }
});

test('audio-only max size uses an audio budget without an unused minimum video bitrate',async()=>{
  const result=await exportMedia(fixtures.audio,join(root,'audio-budget.mp4'),recipe({segments:[{in:0,out:1}]}),options({mode:'size',maxBytes:23000,maxAttempts:1}),tools,ctx());
  assert(result.media.size<=23000);assert.equal(result.media.streams.some(stream=>stream.type==='video'),false);assert(Math.abs(result.media.duration-1)<.15);
});

test('real tool capability tests validate a file; strict unavailable GPU selection rejects',async()=>{assert(encoders.find(e=>e.name==='libx264')?.available);const media=await probe(fixtures.numbered,tools);const unavailable=encoders.map(e=>({...e,available:e.hardware?false:e.available}));assert.throws(()=>planExport(recipe(),options({encoder:'hardware',allowSoftwareFallback:false}),media,unavailable),/No operational/);const plan=planExport(recipe(),options({encoder:'hardware',allowSoftwareFallback:true}),media,unavailable);assert.equal(plan.hardware,false);assert.equal(plan.encoder,'libx264');assert(plan.warnings.length);});
test('CFR exact multi-cut preserves visibly numbered frames and in-inclusive out-exclusive identity',async()=>{const out=join(root,'exact-cfr.mp4');const result=await exportMedia(fixtures.numbered,out,recipe({segments:[{in:.3,out:1},{in:1.6,out:2}]}),options(),tools,ctx());const source=await hashes(fixtures.numbered),actual=await hashes(out);assert.deepEqual(actual,[...source.slice(3,10),...source.slice(16,20)]);evidence.outputs.push({path:out,...result});evidence.checks.push('CFR frame hashes: source frames 3..9 and 16..19 exactly preserved');await extractFrame(out,join(root,'exact-first.png'),0,tools);});
test('VFR and nonzero-origin exact cuts select matching decoded frame identities',async()=>{for(const file of [fixtures.vfr,fixtures.offset]){const info=await probe(file,tools);const frames=await frameIndex(file,tools);assert(frames.length>10);const begin=frames[2].pts,end=frames[9].pts;const output=join(root,`${file===fixtures.vfr?'vfr':'offset'}-exact.mp4`);await exportMedia(file,output,recipe({segments:[{in:begin,out:end}],audio:{mode:'mute'}}),options(),tools,ctx());const source=await hashes(file),actual=await hashes(output);assert.deepEqual(actual,source.slice(2,9));evidence.outputs.push({path:output,sourceStart:info.startTime,selectedPts:{begin,end},frameCount:actual.length});}});
test('bounded exact frame inspection matches origin-decoded CFR/VFR/offset/NTSC images',async()=>{for(const [i,file] of [fixtures.numbered,fixtures.vfr,fixtures.offset,fixtures.ntsc].entries()){const frames=await frameIndex(file,tools);const selected=join(root,`inspection-${i}.png`),baseline=join(root,`inspection-baseline-${i}.png`);await extractFrame(file,selected,frames[12].pts,tools,ctx());await runProcess(tools.ffmpeg,['-v','error','-i',file,'-vf','select=eq(n\\,12)','-frames:v','1','-fps_mode','vfr','-update','1',baseline]);assert.deepEqual(await readFile(selected),await readFile(baseline));}});
test('rational NTSC frame indices keep full precision through exact export boundaries',async()=>{const frames=await frameIndex(fixtures.ntsc,tools);assert(Math.abs(frames[1].pts-1001/30000)<1e-12);const out=join(root,'ntsc-exact.mp4');await exportMedia(fixtures.ntsc,out,recipe({segments:[{in:frames[1].pts,out:frames[13].pts}],audio:{mode:'mute'}}),options(),tools,ctx());assert.deepEqual(await hashes(out),(await hashes(fixtures.ntsc)).slice(1,13));evidence.outputs.push({path:out,media:await probe(out,tools),sourceFrameIndices:[1,12]});});
test('copy snaps to advertised keyframes and preserves decoded frames on controlled GOP fixture',async()=>{const out=join(root,'copy.mp4');const result=await exportMedia(fixtures.longGop,out,recipe({segments:[{in:.4,out:1.8}],audio:{mode:'mute'}}),options({cut:'copy',mode:'auto'}),tools,ctx());assert.deepEqual(result.plan.segments,[{in:0,out:2}]);const src=await hashes(fixtures.longGop),actual=await hashes(out);assert.deepEqual(actual,src.slice(0,20));evidence.outputs.push({path:out,...result});});
test('strict byte limit validates full output; impossible limit fails without publishing',async()=>{const out=join(root,'strict.mp4');const result=await exportMedia(fixtures.numbered,out,recipe(),options({mode:'size',maxBytes:90000}),tools,ctx());assert((await stat(out)).size<=90000);assert(Math.abs(result.media.duration-4)<.15);assert.equal((await hashes(out)).length,40);const bad=join(root,'impossible.mp4');await assert.rejects(exportMedia(fixtures.numbered,bad,recipe(),options({mode:'size',maxBytes:1024}),tools,ctx()),/infeasible/);await assert.rejects(access(bad));evidence.outputs.push({path:out,...result});});
test('real AV1 oversized first attempt is corrected within bounded size attempts',async()=>{const out=join(root,'strict-corrected-av1.mp4');const result=await exportMedia(fixtures.numbered,out,recipe({audio:{mode:'mute'}}),options({codec:'av1',mode:'size',maxBytes:50000}),tools,ctx());const attempts=result.plan.measuredAttempts as {bytes:number}[];assert(attempts.length>=2&&attempts.length<=3);assert(attempts[0].bytes>50000);assert(result.media.size<=50000);assert.equal((await hashes(out)).length,40);const impossible=join(root,'no-correction-permitted.mp4');await assert.rejects(exportMedia(fixtures.numbered,impossible,recipe({audio:{mode:'mute'}}),options({codec:'av1',mode:'size',maxBytes:50000,maxAttempts:1}),tools,ctx()),/Cannot meet/);await assert.rejects(access(impossible));evidence.outputs.push({path:out,...result});});
test('rendered crop, rotation, captions, text, track selection and replacement padding',async()=>{const out=join(root,'edited.mp4');const edit=recipe({crop:{x:20,y:20,width:200,height:120},rotate:90,resize:{width:120,height:200},text:[{in:0,out:1,text:"Literal %{n} : ' quote \\ ; 雪"}],captions:[{in:.5,out:2,text:'Caption across source time'}],audio:{mode:'replace',volume:.5,fadeIn:.1,fadeOut:.1,normalize:true}});const result=await exportMedia(fixtures.numbered,out,edit,options({quality:18}),tools,ctx(),fixtures.audio);assert.equal(result.media.streams.find(s=>s.type==='video')?.width,120);assert.equal(result.media.streams.find(s=>s.type==='video')?.height,200);const pcm=await audioSamples(out);const rms=(start:number,end:number)=>{let sum=0,n=0;for(let i=Math.floor(start*48000);i<Math.min(pcm.length/2,end*48000);i++){sum+=(pcm.readInt16LE(i*2)/32768)**2;n++;}return Math.sqrt(sum/n);};assert(rms(.2,.8)>.005);assert(rms(2,3.5)<.001);await extractFrame(out,join(root,'edited-visible.png'),.6,tools);evidence.outputs.push({path:out,...result});});
test('soft captions map through cuts; source audio pulses retain alignment within 30ms',async()=>{const out=join(root,'soft.mp4');await exportMedia(fixtures.numbered,out,recipe({segments:[{in:1,out:3}],captions:[{in:.5,out:1.5,text:'First cue'},{in:2,out:2.4,text:'Second cue'}],subtitleMode:'soft'}),options({quality:18}),tools,ctx());const info=await probe(out,tools);assert(info.streams.some(s=>s.type==='subtitle'));const subtitle=(await runProcess(tools.ffmpeg,['-v','error','-i',out,'-map','0:s:0','-f','srt','-'])).stdout.toString();assert(subtitle.includes('00:00:00,000 --> 00:00:00,500'));assert(subtitle.includes('00:00:01,000 --> 00:00:01,400'));const samples=await audioSamples(out);let first=-1;for(let i=0;i<samples.length/2;i++)if(Math.abs(samples.readInt16LE(i*2))>3000){first=i/48000;break;}assert(first>=0&&first<.03);evidence.checks.push({audioAlignmentFirstPulseSeconds:first,toleranceSeconds:.03});evidence.outputs.push({path:out,media:info});});
test('proxy retains source timestamp mapping; exports use original resolution and frame identity',async()=>{const proxy=join(root,'proxy.mp4');const proxied=await createProxy(fixtures.numbered,proxy,tools,ctx());assert(Math.abs(proxied.duration-4)<.15);const out=join(root,'original-after-proxy.mp4');const result=await exportMedia(fixtures.numbered,out,recipe({segments:[{in:1,out:2}],audio:{mode:'mute'}}),options(),tools,ctx());assert.equal(result.media.streams[0].width,320);assert.deepEqual(await hashes(out),(await hashes(fixtures.numbered)).slice(10,20));const wave=await waveform(fixtures.numbered,tools);assert(wave.peaks.length>0);assert(wave.peaks.every(p=>p>=0&&p<=1));const hostile=await probe(fixtures.hostile,tools);assert.equal(hostile.duration,4);evidence.outputs.push({path:proxy,media:proxied});});
test('caption timing map intersects split segments deterministically',()=>{assert.deepEqual(mapCues([{in:.5,out:2.5,text:'x'}],[{in:1,out:2},{in:2.2,out:3}]),[{in:0,out:1,text:'x'},{in:1,out:1.2999999999999998,text:'x'}]);});
test('source rotation is baked once, crop uses encoded coordinates, and explicit frame rate resamples',async()=>{const out=join(root,'rotation-source.mp4');const result=await exportMedia(fixtures.rotated,out,recipe({crop:{x:20,y:20,width:200,height:120},segments:[{in:0,out:1}],audio:{mode:'mute'}}),options({frameRate:5}),tools,ctx());const video=result.media.streams.find(s=>s.type==='video')!;assert.equal(video.width,120);assert.equal(video.height,200);assert.equal(video.rotation,0);assert.equal((await hashes(out)).length,5);await extractFrame(out,join(root,'rotation-source.png'),0,tools);evidence.outputs.push({path:out,...result});});
test('software HEVC and AV1 exports are real complete decoded files',async()=>{for(const codec of ['hevc','av1'] as const){const out=join(root,`${codec}.mp4`);const result=await exportMedia(fixtures.numbered,out,recipe({segments:[{in:0,out:1}],audio:{mode:'mute'}}),options({codec,quality:28,speed:'fast'}),tools,ctx());assert.equal(result.media.streams[0].codec,codec);assert.equal((await hashes(out)).length,10);evidence.outputs.push({path:out,...result});}});
test('source track selection, mix, volume and waveform retain real audio energy',async()=>{const selected=join(root,'selected-track.mp4');await exportMedia(fixtures.multipleAudio,selected,recipe({audio:{mode:'keep',track:1}}),options({quality:18}),tools,ctx());const track=await waveform(selected,tools);assert(Math.max(...track.peaks.slice(0,9))>.01);assert(Math.max(...track.peaks.slice(15))<.001);const mixed=join(root,'mixed.mp4');await exportMedia(fixtures.numbered,mixed,recipe({audio:{mode:'mix',volume:.5}}),options({quality:18}),tools,ctx(),fixtures.audio);const wave=await waveform(mixed,tools);assert(wave.peaks[0]>.1);assert(Math.max(...wave.peaks.slice(18,23))>.1);evidence.outputs.push({path:selected,media:await probe(selected,tools)},{path:mixed,media:await probe(mixed,tools)});});
test('cancel processing and validation leaves no published artifact or overwritten unrelated file',async()=>{for(const stage of ['processing','validating']){const output=join(root,`cancel-${stage}.mp4`);const controller=new AbortController();await assert.rejects(exportMedia(fixtures.numbered,output,recipe(),options({quality:18}),tools,{...ctx(),signal:controller.signal,onStage:state=>{if(state===stage)controller.abort();}}),/cancelled/);await assert.rejects(access(output));}const unrelated=join(root,'existing.mp4');await writeFile(unrelated,'preserve me');await assert.rejects(exportMedia(fixtures.numbered,unrelated,recipe(),options(),tools,ctx()),/refusing overwrite/);assert.equal(await readFile(unrelated,'utf8'),'preserve me');});
test('waveform windows return progressively, cache decoded peaks and cancel active analysis',async()=>{
  const audio=join(root,'long-waveform.wav');await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=95','-c:a','pcm_s16le',audio]);
  const first=await waveform(audio,tools,ctx());assert.equal(first.duration,95);assert.equal(first.start,0);assert.equal(first.end,30);assert.equal(first.complete,false);assert.equal(first.peaks.length,300);assert(first.peaks.every(p=>p>.1&&p<.2));
  const window={start:30,duration:10,points:20};const middle=await waveform(audio,tools,ctx(),window);assert.equal(middle.start,30);assert.equal(middle.end,40);assert.equal(middle.peaks.length,20);assert.equal(middle.complete,false);
  const cached=await waveform(audio,tools,{...ctx(),runTool:async()=>{throw new Error('Cache unexpectedly decoded');}},window);assert.deepEqual(cached,middle);
  const last=await waveform(audio,tools,ctx(),{start:90,duration:10});assert.equal(last.end,95);assert.equal(last.complete,true);assert.equal(last.peaks.length,50);
  await assert.rejects(waveform(audio,tools,ctx(),{duration:61}),/Invalid waveform window/);
  const controller=new AbortController();let progressed=false;await assert.rejects(waveform(audio,tools,{...ctx(),signal:controller.signal,onProgress:()=>{progressed=true;controller.abort();}},{start:10,duration:60}),/cancelled/);assert(progressed);
  evidence.checks.push({waveform:{totalSeconds:95,firstWindowSeconds:first.end,firstWindowComplete:first.complete,cachedPeakCount:middle.peaks.length,activeCancellation:true}});
});
test('exact decoded frame cache avoids a second native decode and honors cancellation',async()=>{
  const initial=join(root,'cached-first.png'),second=join(root,'cached-second.png');await extractFrame(fixtures.numbered,initial,.7,tools,ctx());await extractFrame(fixtures.numbered,second,.7,tools,{...ctx(),runTool:async()=>{throw new Error('Cache unexpectedly decoded');}});assert.deepEqual(await readFile(initial),await readFile(second));const controller=new AbortController();controller.abort();await assert.rejects(extractFrame(fixtures.numbered,join(root,'cached-aborted.png'),.7,tools,{...ctx(),signal:controller.signal}),/cancelled/);
});
test('injected hardware export failure retries real software only when policy permits',async()=>{
  let smokeCount=0,failedCount=0;
  const injected=(failure='Native tool failed (1): injected hardware encoder runtime failure'):ExecutionContext=>{const context=ctx();return {...context,runTool:async(binary,args,processOptions)=>{
    if(binary===tools.ffmpeg&&args.includes('-encoders'))return {stdout:Buffer.from(' V..... libx264 software\n V..... h264_nvenc injected-hardware\n'),stderr:'',exitCode:0};
    if(binary===tools.ffmpeg&&args.includes('h264_nvenc')){if(args.includes('lavfi')){smokeCount++;return runProcess(binary,args.map(value=>value==='h264_nvenc'?'libx264':value),context,processOptions);}failedCount++;throw new Error(failure);}
    return runProcess(binary,args,context,processOptions);
  }};};
  const edit=recipe({segments:[{in:0,out:1}],audio:{mode:'mute'}}),out=join(root,'injected-hardware-fallback.mp4');const result=await exportMedia(fixtures.numbered,out,edit,options({encoder:'hardware',allowSoftwareFallback:true}),tools,injected());assert.equal(result.plan.encoder,'libx264');assert.equal(result.plan.hardware,false);assert(result.plan.warnings.some(w=>w.includes('encoding process failed')));assert.equal((result.plan.measuredAttempts as unknown[]).length,2);assert.deepEqual(await hashes(out),(await hashes(fixtures.numbered)).slice(0,10));
  const denied=join(root,'injected-hardware-denied.mp4');await assert.rejects(exportMedia(fixtures.numbered,denied,edit,options({encoder:'hardware',allowSoftwareFallback:false}),tools,injected()),/injected hardware/);await assert.rejects(access(denied));
  const exhausted=join(root,'injected-hardware-exhausted.mp4');await assert.rejects(exportMedia(fixtures.numbered,exhausted,edit,options({encoder:'hardware',allowSoftwareFallback:true,mode:'size',maxBytes:50000,maxAttempts:1}),tools,injected()),/strict attempt budget/);await assert.rejects(access(exhausted));
  const forbidden=join(root,'encoder-policy-denied.mp4');await assert.rejects(exportMedia(fixtures.numbered,forbidden,edit,options({encoder:'software'}),tools,{...injected(),allowedEncoders:['libx265']}),/No operational/);await assert.rejects(access(forbidden));
  for(const [kind,message]of [['disk','Native tool failed (1): No space left on device'],['timeout','Native tool failed (124): deadline reached']]){const limited=join(root,`injected-${kind}.mp4`);await assert.rejects(exportMedia(fixtures.numbered,limited,edit,options({encoder:'hardware',allowSoftwareFallback:true}),tools,injected(message)),error=>(error as Error).message===message);await assert.rejects(access(limited));}assert.equal(smokeCount,6);assert.equal(failedCount,5);
  evidence.outputs.push({path:out,...result,testMethod:'Injected hardware failure; smoke and final software file use real libx264. No physical GPU success claimed.'});evidence.checks.push({hardwareSmokeRecheckedAcrossJobs:smokeCount});
});
test.after(async()=>{await writeFile(join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(`Media evidence: ${join(root,'evidence.json')}`);});
