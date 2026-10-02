import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RecipeSchema, ExportSchema, type ExecutionContext, type NativeRunOptions, type ToolPaths } from '../packages/contracts/src/index.ts';
import { discoverTools, exportMedia, planExport, probe, runProcess, validateMedia } from '../packages/media/src/index.ts';
import { Store } from '../packages/jobs/src/store.ts';
import { Queue } from '../packages/jobs/src/queue.ts';
import { managedPath, publish, registerSource } from '../apps/server/src/storage.ts';
import type { IsolatedWorker } from '../apps/server/src/worker.ts';
import type { Artifact, Job } from '../packages/contracts/src/index.ts';

let root: string;
let tools: ToolPaths;
const fixtures: { name: string; file: string }[] = [];
const evidence: { testedAt: string; checks: unknown[] } = { testedAt: new Date().toISOString(), checks: [] };
const copyOptions = ExportSchema.parse({ cut: 'copy', mode: 'auto', container: 'mkv', copyValidation: 'full' });
const recipe = () => RecipeSchema.parse({ sourceId: randomUUID(), segments: [{ in: 7.2, out: 9.1 }], audio: { mode: 'mute' } });
const isHash = (args: string[]) => args.includes('-hash') && args.includes('sha256');
const inputOf = (args: string[]) => args[args.indexOf('-i') + 1];

async function workspace() {
  return mkdtemp(path.join(root, 'case-'));
}

function context(workDir: string): ExecutionContext {
  const ctx: ExecutionContext = { workDir, signal: new AbortController().signal, maxRuntimeSeconds: 30 };
  ctx.runTool = async (binary, args, options) => {
    if (args.includes('-encoders')) return { stdout: Buffer.alloc(0), stderr: '', exitCode: 0 };
    return runProcess(binary, args, { ...ctx, runTool: undefined }, options);
  };
  return ctx;
}

async function hash(file: string, filter?: string) {
  return (await runProcess(tools.ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-an',
    ...(filter ? ['-vf', filter] : []), '-c:v', 'rawvideo', '-fps_mode', 'vfr', '-f', 'hash', '-hash', 'sha256', '-'])).stdout.toString().trim();
}

async function frames(file: string) {
  const result = await runProcess(tools.ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0', '-an', '-c:v', 'rawvideo', '-fps_mode', 'vfr', '-f', 'framemd5', '-']);
  return result.stdout.toString().split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)!.trim());
}

before(async () => {
  tools = await discoverTools();
  await mkdir(path.resolve('test-output/copy-validation'), { recursive: true });
  root = await mkdtemp(path.resolve('test-output/copy-validation/run-'));
  const base = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=12'];
  const cfr = path.join(root, 'cfr.mp4');
  await runProcess(tools.ffmpeg, [...base, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '20', '-keyint_min', '20', '-sc_threshold', '0', '-bf', '0', cfr]);
  fixtures.push({ name: 'H264 CFR', file: cfr });
  const bframes = path.join(root, 'bframes.mp4');
  await runProcess(tools.ffmpeg, [...base, '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-g', '20', '-keyint_min', '20', '-sc_threshold', '0', '-bf', '3', bframes]);
  fixtures.push({ name: 'H264 B-frames', file: bframes });
  const vfr = path.join(root, 'vfr.mkv');
  await runProcess(tools.ffmpeg, [...base, '-vf', 'select=not(eq(mod(n\\,3)\\,1))', '-fps_mode', 'vfr', '-an', '-c:v', 'ffv1', '-g', '1', vfr]);
  fixtures.push({ name: 'VFR', file: vfr });
  const offset = path.join(root, 'offset.mkv');
  await runProcess(tools.ffmpeg, ['-y', '-v', 'error', '-i', vfr, '-vf', 'setpts=PTS+5/TB', '-fps_mode', 'vfr', '-an', '-c:v', 'ffv1', '-g', '1', offset]);
  fixtures.push({ name: 'VFR nonzero origin', file: offset });
  const ntscBase = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=30000/1001:duration=12', '-an'];
  const ntsc = path.join(root, 'ntsc.mp4');
  await runProcess(tools.ffmpeg, [...ntscBase, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '0', ntsc]);
  fixtures.push({ name: 'Rational NTSC H264', file: ntsc });
  const av1 = path.join(root, 'ntsc-av1.mp4');
  await runProcess(tools.ffmpeg, [...ntscBase, '-c:v', 'libaom-av1', '-cpu-used', '8', '-threads', '2', '-row-mt', '1', '-crf', '32', '-b:v', '0', '-g', '60', '-lag-in-frames', '0', av1]);
  fixtures.push({ name: 'Rational NTSC AV1', file: av1 });
}, { timeout: 60000 });

after(async () => {
  await writeFile(path.resolve('test-output/copy-validation/evidence.json'), JSON.stringify({ ...evidence, root, fixtures }, null, 2));
});

test('fast automatic trims preserve decoded frame identities without encoder tests, full scans or full decodes', { timeout: 60000 }, async t => {
  for(const fixture of fixtures)await t.test(fixture.name,async()=>{
    const workDir=await workspace(),output=path.join(workDir,'fast.mkv'),ctx=context(workDir),underlying=ctx.runTool!;
    const calls:string[][]=[];ctx.runTool=async(binary,args,options)=>{calls.push(args);return underlying(binary,args,options);};
    const started=performance.now();
    const result=await exportMedia(fixture.file,output,recipe(),ExportSchema.parse({cut:'auto',mode:'auto',container:'mkv'}),tools,ctx);
    const elapsedMs=performance.now()-started;
    assert.equal(result.plan.strategy,'copy');assert.match(String(result.plan.validation),/bounded cut-edge/);
    assert(!calls.some(args=>args.includes('-encoders')||args.includes('-hash')||args.includes('-show_frames')));
    assert(calls.filter(args=>args.includes('-show_packets')).every(args=>args.includes('-read_intervals')));
    assert(calls.filter(args=>args.includes('-xerror')).every(args=>args.includes('-t')&&args[args.indexOf('-t')+1]==='0.5'));
    const sourceMedia=await probe(fixture.file,tools),[n,d]=sourceMedia.streams.find(s=>s.type==='video')!.timeBase!.split('/').map(Number),tick=n/d;
    const {in:start,out:end}=result.plan.segments[0];
    assert(start>=6&&start<8.1);
    assert.equal(await hash(output),await hash(fixture.file,`trim=start_pts=${Math.ceil(start/tick-1e-7)}:end_pts=${Math.ceil(end/tick-1e-7)}`));
    await validateMedia(output,tools);
    evidence.checks.push({name:`fast ${fixture.name}`,elapsedMs,start,end,toolCalls:calls.length});
  });
});

test('lossless multi-cut preserves section order, avoids duplicate adjacent splits and retains audio', { timeout: 30000 }, async()=>{
  const workDir=await workspace(),source=path.join(workDir,'with-audio.mp4');
  await runProcess(tools.ffmpeg,['-v','error','-i',fixtures[1].file,'-f','lavfi','-i','sine=frequency=440:duration=12','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac',source]);
  for(const segments of [[{in:6,out:8},{in:2,out:4}],[{in:2,out:3},{in:3,out:4}]]){
    const edit=RecipeSchema.parse({sourceId:randomUUID(),segments}),output=path.join(workDir,`${randomUUID()}.mp4`);
    const result=await exportMedia(source,output,edit,ExportSchema.parse({mode:'auto'}),tools,context(workDir));
    assert.equal(result.plan.strategy,'copy');assert(result.media.streams.some(s=>s.type==='audio'));
    const sourceFrames=await frames(source),expected=result.plan.segments.flatMap(s=>sourceFrames.slice(Math.round(s.in*10),Math.round(s.out*10)));
    assert.deepEqual(await frames(output),expected);
    await validateMedia(output,tools);
    assert(Math.abs(result.media.duration-result.plan.duration)<.15);
    evidence.checks.push({name:'multi-cut with audio',requested:segments,resolved:result.plan.segments,duration:result.media.duration});
  }
});

test('automatic fast mode still encodes filters and compression targets, and exact remains explicit',async()=>{
  const source=await probe(fixtures[0].file,tools),edit=recipe(),encoders=[{name:'libx264',codec:'h264' as const,hardware:false,available:true,testedAt:new Date().toISOString()}];
  assert.equal(planExport(edit,ExportSchema.parse({mode:'auto'}),source,[]).strategy,'copy');
  for(const options of [{cut:'exact',mode:'auto'},{mode:'quality'},{mode:'bitrate'},{mode:'size',maxBytes:100000}])assert.equal(planExport(edit,ExportSchema.parse(options),source,encoders).strategy,'exact');
  assert.equal(planExport({...edit,resize:{width:64,height:64}},ExportSchema.parse({mode:'auto'}),source,encoders).strategy,'exact');
  assert.equal(planExport(edit,ExportSchema.parse({mode:'auto'}),await probe(fixtures[2].file,tools),encoders).strategy,'exact','FFV1 cannot silently select automatic MP4 stream copy');
});

test('fast cut cancellation and cumulative multi-cut byte limits prevent publication',async()=>{
  const workDir=await workspace(),controller=new AbortController(),ctx=context(workDir),underlying=ctx.runTool!;
  const output=path.join(workDir,'cancelled-fast.mkv');ctx.signal=controller.signal;
  ctx.runTool=async(binary,args,options)=>{if(args.includes('-xerror'))controller.abort();return underlying(binary,args,options);};
  await assert.rejects(exportMedia(fixtures[0].file,output,recipe(),ExportSchema.parse({mode:'auto',container:'mkv'}),tools,ctx),/cancelled/);
  await assert.rejects(access(output));assert.deepEqual((await readdir(workDir)).filter(n=>n.startsWith('.partial-')),[]);
  const limited=path.join(workDir,'limited.mkv');
  await assert.rejects(exportMedia(fixtures[0].file,limited,{...recipe(),segments:[{in:2,out:4},{in:6,out:8}]},ExportSchema.parse({mode:'auto',container:'mkv'}),tools,{...context(workDir),maxBytes:1000}),/resource byte limit/);
  await assert.rejects(access(limited));assert.deepEqual((await readdir(workDir)).filter(n=>n.startsWith('cut-')||n.startsWith('.partial-')),[]);
});

test('bounded late-copy verification equals the full-decode baseline across timestamps and codecs', { timeout: 120000 }, async t => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const workDir = await workspace();
      const output = path.join(workDir, 'copied.mkv');
      const ctx = context(workDir);
      const underlying = ctx.runTool!;
      let sourceArgs: string[] | undefined;
      let sourceOptions: NativeRunOptions | undefined;
      let actualSourceHash: string | undefined;
      const progress: { value: number; message?: string }[] = [];
      ctx.onProgress = (value, message) => progress.push({ value, message });
      ctx.runTool = async (binary, args, options) => {
        const result = await underlying(binary, args, options);
        if (isHash(args) && inputOf(args) === fixture.file) { sourceArgs = args; sourceOptions = options; actualSourceHash = result.stdout.toString().trim(); }
        return result;
      };
      const result = await exportMedia(fixture.file, output, recipe(), copyOptions, tools, ctx);
      assert.equal(result.plan.strategy, 'copy');
      assert.equal(result.plan.framePreservation, 'Decoded source/output SHA-256 match');
      assert.ok(sourceArgs && sourceOptions && actualSourceHash, 'the real selected-source verification executed');
      const start = result.plan.segments[0].in, end = result.plan.segments[0].out;
      assert.ok(start >= 6 && start < 8.1, 'selection genuinely starts late in the generated file');
      const inputIndex = sourceArgs.indexOf('-i');
      assert.ok(sourceArgs.indexOf('-ss') >= 0 && sourceArgs.indexOf('-ss') < inputIndex);
      assert.ok(sourceArgs.indexOf('-t') >= 0 && sourceArgs.indexOf('-t') < inputIndex);
      assert.equal(Number(sourceArgs[sourceArgs.indexOf('-ss') + 1]), start);
      assert.equal(Number(sourceArgs[sourceArgs.indexOf('-t') + 1]), end - start + 1);
      assert.ok(sourceArgs.includes('-copyts') && sourceArgs.includes('-start_at_zero'));
      assert.equal(sourceOptions.duration, end - start);
      assert.equal(sourceOptions.progressOffset, start);
      const sourceMedia = await probe(fixture.file, tools);
      const [numerator, denominator] = sourceMedia.streams.find(stream => stream.type === 'video')!.timeBase!.split('/').map(Number);
      const tick = numerator / denominator;
      const filter = `trim=start_pts=${Math.ceil(start / tick - 1e-7)}:end_pts=${Math.ceil(end / tick - 1e-7)}`;
      assert.equal(sourceArgs[sourceArgs.indexOf('-vf') + 1], filter);
      const baseline = await hash(fixture.file, filter);
      const outputHash = await hash(output);
      assert.equal(actualSourceHash, baseline, 'input seeking preserves the old full-decode SHA-256 exactly');
      assert.equal(outputHash, baseline, 'the copied file preserves the selected decoded frames');
      const allFrames = await frames(fixture.file);
      const frameInfo = JSON.parse((await runProcess(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', fixture.file])).stdout.toString()).frames;
      assert.equal(frameInfo.length, allFrames.length);
      const expectedFrames = allFrames.filter((_hash, index) => {
        const time = Number(frameInfo[index].best_effort_timestamp_time) - sourceMedia.startTime;
        return time >= start - 1e-6 && time < end - 1e-6;
      });
      assert.ok(expectedFrames.length >= 10);
      assert.deepEqual(await frames(output), expectedFrames, 'independent frame identities retain inclusive start and exclusive end');
      for (const label of ['Checking original frames', 'Checking copied frames', 'Checking the completed file']) {
        assert.ok(progress.some(item => item.message?.startsWith(label)), `${label} exposes the checking phase`);
      }
      assert.ok(progress.some(item => item.value > 0 && item.value <= .98), 'the real checking tools emit partial progress');
      assert.ok(progress.every(item => Number.isFinite(item.value) && item.value >= 0 && item.value <= 1));
      evidence.checks.push({ name: fixture.name, start, end, frames: expectedFrames.length, baseline, boundedSourceHash: actualSourceHash, outputHash });
    });
  }
});

test('keyframe verification cache reuses an unchanged source and invalidates changed metadata', { timeout: 30000 }, async () => {
  const workDir = await workspace();
  const source = path.join(workDir, 'cache-source.mp4');
  await copyFile(fixtures[0].file, source);
  const ctx = context(workDir), underlying = ctx.runTool!;
  let scans = 0;
  ctx.runTool = async (binary, args, options) => { if (args.includes('-skip_frame') && args.includes('nokey')) scans++; return underlying(binary, args, options); };
  await exportMedia(source, path.join(workDir, 'first.mkv'), recipe(), copyOptions, tools, ctx);
  assert.equal(scans, 1);
  await exportMedia(source, path.join(workDir, 'second.mkv'), recipe(), copyOptions, tools, ctx);
  assert.equal(scans, 1, 'a second export does not rescan every keyframe');
  const before = await stat(source);
  await utimes(source, before.atime, new Date(before.mtimeMs + 2000));
  await exportMedia(source, path.join(workDir, 'third.mkv'), recipe(), copyOptions, tools, ctx);
  assert.equal(scans, 2, 'changed source metadata cannot reuse stale frame boundaries');
  const controller = new AbortController();
  const cancelled = { ...ctx, signal: controller.signal, onPlan: () => controller.abort() };
  await assert.rejects(exportMedia(source, path.join(workDir, 'cancelled.mkv'), recipe(), copyOptions, tools, cancelled), /cancelled/);
  await assert.rejects(access(path.join(workDir, 'cancelled.mkv')));
  evidence.checks.push({ name: 'keyframe cache reuse, invalidation and cached cancellation', scans });
});

test('cancelling the real bounded source check leaves no published file or partial copy', { timeout: 15000 }, async () => {
  const workDir = await workspace(), output = path.join(workDir, 'cancelled.mkv');
  const controller = new AbortController(), ctx = context(workDir), underlying = ctx.runTool!;
  ctx.signal = controller.signal;
  let entered = false;
  ctx.runTool = async (binary, args, options) => {
    if (!isHash(args) || inputOf(args) !== fixtures[0].file) return underlying(binary, args, options);
    entered = true;
    const inputIndex = args.indexOf('-i');
    const paced = [...args.slice(0, inputIndex), '-re', ...args.slice(inputIndex)];
    const timer = setTimeout(() => controller.abort(), 150);
    try { return await underlying(binary, paced, options); } finally { clearTimeout(timer); }
  };
  const sentinel = path.join(workDir, 'unrelated.txt');
  await writeFile(sentinel, 'preserve this generated sentinel');
  await assert.rejects(exportMedia(fixtures[0].file, output, recipe(), copyOptions, tools, ctx), /cancelled/);
  assert.ok(entered && controller.signal.aborted, 'cancellation interrupts actual source verification');
  await assert.rejects(access(output));
  assert.deepEqual((await readdir(workDir)).filter(file => file.startsWith('.partial-')), []);
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve this generated sentinel');
  evidence.checks.push({ name: 'cancellation during real source verification rejects publication' });
});

test('a decodable but different copied output fails frame identity validation before publication', { timeout: 15000 }, async () => {
  const workDir = await workspace(), output = path.join(workDir, 'wrong-frames.mkv');
  const replacement = path.join(workDir, 'replacement.mkv');
  await runProcess(tools.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=96x64:rate=10:duration=4', '-an', '-c:v', 'libx264', replacement]);
  const bytes = await readFile(replacement), ctx = context(workDir), underlying = ctx.runTool!;
  let replaced = false;
  ctx.runTool = async (binary, args, options) => {
    const result = await underlying(binary, args, options);
    if (args.includes('-c') && args[args.indexOf('-c') + 1] === 'copy' && options?.outputPath) { await writeFile(options.outputPath, bytes); replaced = true; }
    return result;
  };
  await assert.rejects(exportMedia(fixtures[0].file, output, recipe(), copyOptions, tools, ctx), /did not preserve the selected decoded frames/);
  assert.ok(replaced);
  await assert.rejects(access(output));
  assert.deepEqual((await readdir(workDir)).filter(file => file.startsWith('.partial-')), []);
  evidence.checks.push({ name: 'different decoded frames rejected before publication' });
});

test('completed-file validation reports progress and rejects corrupt packets after a successful probe', { timeout: 15000 }, async () => {
  const workDir = await workspace();
  const ctx: ExecutionContext = { workDir, signal: new AbortController().signal, maxRuntimeSeconds: 15 };
  const progress: { value: number; message?: string }[] = [];
  ctx.onProgress = (value, message) => progress.push({ value, message });
  const valid = await validateMedia(fixtures[0].file, tools, ctx);
  assert.equal(valid.duration, 12);
  assert.ok(progress.some(item => item.value > 0 && item.message?.startsWith('Checking the completed file')));
  const packets = JSON.parse((await runProcess(tools.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pos,size', '-of', 'json', fixtures[0].file])).stdout.toString()).packets;
  const selected = packets[Math.floor(packets.length / 2)], bytes = await readFile(fixtures[0].file);
  bytes.fill(255, Number(selected.pos), Number(selected.pos) + Number(selected.size));
  const corrupted = path.join(workDir, 'corrupt-packet.mp4');
  await writeFile(corrupted, bytes);
  assert.equal((await probe(corrupted, tools, ctx)).duration, 12, 'container metadata alone still looks valid');
  await assert.rejects(validateMedia(corrupted, tools, ctx), /Native tool failed|Invalid|corrupt|Error/i);
  evidence.checks.push({ name: 'full completed-file decode reports progress and rejects corrupt packet data' });
});

test('native checking progress subtracts the selected source offset and clamps negative and final timestamps', { timeout: 10000 }, async () => {
  const workDir = await workspace(), progress: number[] = [];
  const script = "process.stderr.write('out_time_us=500000\\n');setTimeout(()=>process.stderr.write('out_time_us=1500000\\n'),40);setTimeout(()=>process.stderr.write('out_time_us=3500000\\n'),80)";
  await runProcess(process.execPath, ['-e', script], { workDir, signal: new AbortController().signal, onProgress: value => progress.push(value) }, { duration: 2, progressOffset: 1 });
  assert.deepEqual(progress, [0, .25, .98]);
  evidence.checks.push({ name: 'native progress subtracts the source offset and retains bounds', progress });
});

test('real queue publishes verified media once and still rejects forbidden output codecs', { timeout: 30000 }, async () => {
  const workDir = await workspace(), store = new Store(path.join(workDir, 'queue-data'));
  const owner = store.createUser('Generated fixture owner', 'owner');
  const staged = path.join(workDir, 'upload.mp4');
  await copyFile(fixtures[0].file, staged);
  const original = await publish(store, staged, owner.id, 'Generated fixture.mp4', await validateMedia(staged, tools), 'original');
  const source = registerSource(store, original);
  let fullChecks = 0;
  const worker = { context: async (ctx: ExecutionContext) => ({
    ...ctx, runTool: async (binary: string, args: string[], options?: NativeRunOptions) => {
      if (args.includes('-encoders')) return { stdout: Buffer.alloc(0), stderr: '', exitCode: 0 };
      if (args.includes('-xerror') && args.includes('null')) fullChecks++;
      return runProcess(binary, args, { ...ctx, runTool: undefined }, options);
    },
  }) } as unknown as IsolatedWorker;
  const queue = new Queue(store, tools, [], undefined, worker);
  const waitJob = async (id: string): Promise<Job> => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const job = store.job(id)!;
      if (['completed', 'failed', 'cancelled'].includes(job.state)) return job;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Generated queue fixture did not complete');
  };
  try {
    const edit = { ...recipe(), sourceId: source.id };
    const first = store.submit(owner.id, { type: 'export', recipe: edit, options: copyOptions }, randomUUID()).job;
    queue.tick();
    const completed = await waitJob(first.id);
    assert.equal(completed.state, 'completed', completed.error);
    assert.equal(fullChecks, 1, 'export performs one complete decode instead of repeating it in the queue');
    const artifact = store.get<Artifact>('artifact', completed.artifactId!, owner.id)!;
    assert.equal(artifact.validated, true); assert.equal(artifact.kind, 'export');
    assert.equal(artifact.media.streams.find(stream => stream.type === 'video')?.codec, 'h264');
    assert.equal((await frames(await managedPath(store, artifact.id))).length, 40);
    store.updateUser(owner.id, { ...owner.policy, allowedOutputCodecs: ['av1'] });
    const rejected = store.submit(owner.id, { type: 'export', recipe: edit, options: copyOptions }, randomUUID()).job;
    queue.tick();
    const denied = await waitJob(rejected.id);
    assert.equal(denied.state, 'failed');
    assert.match(denied.error!, /codec is not allowed by policy/);
    assert.equal(denied.artifactId, undefined);
    assert.equal(fullChecks, 2, 'policy rejection still follows the completed output validation');
    store.updateUser(owner.id, owner.policy);
    const proxied = store.submit(owner.id, { type: 'proxy', sourceId: source.id }, randomUUID()).job;
    queue.tick();
    const proxy = await waitJob(proxied.id);
    assert.equal(proxy.state, 'completed', proxy.error);
    assert.equal(fullChecks, 3, 'proxy validation is also reused without a second full decode');
    assert.deepEqual(await readFile(await managedPath(store, original.id)), await readFile(fixtures[0].file));
    evidence.checks.push({ name: 'actual queue reuses complete output validation while retaining publication and codec policy', fullChecks });
  } finally { await queue.stop(); store.close(); }
});
