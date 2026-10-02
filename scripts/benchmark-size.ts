import {mkdir,access,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {discoverTools,runProcess,testEncoders,exportMedia} from '../packages/media/src/index.ts';
import {RecipeSchema,ExportSchema,type ExecutionContext} from '../packages/contracts/src/index.ts';
const root=resolve('test-output/size-benchmark');await mkdir(root,{recursive:true});const tools=await discoverTools();const fixture=join(root,'motion-1080p.mp4');
try{await access(fixture);}catch{await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=30:duration=12','-f','lavfi','-i','sine=frequency=440:duration=12','-c:v','libx264','-preset','veryfast','-crf','18','-c:a','aac',fixture]);}
await testEncoders(tools,root);
const calls:{kind:string;ms:number}[]=[];const base:ExecutionContext={signal:new AbortController().signal,workDir:root,maxRuntimeSeconds:180,...(process.argv[5]?{maxCpuCores:Number(process.argv[5])}:{})};
const ctx:ExecutionContext={...base,runTool:async(binary,args,options)=>{const start=performance.now();const result=await runProcess(binary,args,base,options);if(args.includes('-/filter_complex')||args.includes('-xerror'))calls.push({kind:args.includes('-/filter_complex')?'encode':'decode-check',ms:Math.round(performance.now()-start)});return result;}};
const start=performance.now();const result=await exportMedia(fixture,join(root,`${process.argv[2]}-${Date.now()}.mp4`),RecipeSchema.parse({sourceId:randomUUID(),segments:[{in:0,out:12}]}),ExportSchema.parse({cut:'exact',mode:'size',maxBytes:2_000_000,encoder:process.argv[3]||'software',speed:process.argv[4]||'balanced'}),tools,ctx);
const evidence={label:process.argv[2],totalMs:Math.round(performance.now()-start),size:result.media.size,duration:result.media.duration,calls,plan:result.plan};await writeFile(join(root,`${process.argv[2]}.json`),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
