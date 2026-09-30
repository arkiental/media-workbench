import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RecipeSchema,ExportSchema} from '../packages/contracts/src/index.ts';
import {discoverTools,exportMedia,mapCues,runProcess} from '../packages/media/src/index.ts';
const style={font:'Playfair Display' as const,size:60,color:'#FF0000',align:'left' as const,x:.2,y:.4};
test('styled cues preserve styling when source-time cuts split and reorder them',()=>{
 const cues=[{in:.5,out:3,text:'Title',style}];const mapped=mapCues(cues,[{in:2,out:4},{in:0,out:1}]);
 assert.deepEqual(mapped,[{in:0,out:1,text:'Title',style},{in:2.5,out:3,text:'Title',style}]);
 assert.equal(RecipeSchema.safeParse({sourceId:randomUUID(),segments:[{in:0,out:1}],text:[{...cues[0],style:{...style,color:'red:movie=bad'}}]}).success,false);
});
test('real export applies bundled font, size, color, alignment and position',async()=>{
 await mkdir(resolve('test-output'),{recursive:true});const dir=await mkdtemp(resolve('test-output/text-style-')),tools=await discoverTools();
 const input=join(dir,'black.mp4');await runProcess(tools.ffmpeg,['-v','error','-f','lavfi','-i','color=black:size=640x360:rate=10:duration=1','-c:v','libx264',input]);
 const bounds=async(file:string,channel:number)=>{const raw=(await runProcess(tools.ffmpeg,['-v','error','-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-'])).stdout;let x0=640,y0=360,x1=0,y1=0,count=0;for(let y=0;y<360;y++)for(let x=0;x<640;x++){const i=(y*640+x)*3;if(raw[i+channel]>100&&raw[i+channel]>raw[i+(channel+1)%3]*2&&raw[i+channel]>raw[i+(channel+2)%3]*2){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);count++}}return{x0,y0,x1,y1,count}};
 const output=join(dir,'styled.mp4');await exportMedia(input,output,RecipeSchema.parse({sourceId:randomUUID(),segments:[{in:0,out:1}],text:[{in:0,out:1,text:'Wild',style}],audio:{mode:'mute'}}),ExportSchema.parse({cut:'exact',quality:0}),tools,{workDir:dir,signal:new AbortController().signal,maxRuntimeSeconds:90});
 const red=await bounds(output,0);assert.ok(red.count>300,JSON.stringify(red));assert.ok(red.x0>=120&&red.x0<=145,JSON.stringify(red));assert.ok(red.y0>90&&red.y1<190,JSON.stringify(red));
 const smaller=join(dir,'smaller-right.mp4');await exportMedia(input,smaller,RecipeSchema.parse({sourceId:randomUUID(),segments:[{in:0,out:1}],text:[{in:0,out:1,text:'Wild',style:{...style,size:30,color:'#00FF00',align:'right',x:.8,y:.8}}],audio:{mode:'mute'}}),ExportSchema.parse({cut:'exact',quality:0}),tools,{workDir:dir,signal:new AbortController().signal,maxRuntimeSeconds:90});
 const green=await bounds(smaller,1);assert.ok(green.count>50);assert.ok(green.x0>400&&green.x1<=520,JSON.stringify(green));assert.ok(green.y0>250,JSON.stringify(green));assert.ok(green.x1-green.x0<(red.x1-red.x0)*.7);
 const edge=join(dir,'edge.mp4');await exportMedia(input,edge,RecipeSchema.parse({sourceId:randomUUID(),segments:[{in:0,out:1}],text:[{in:0,out:1,text:'Wild',style:{...style,align:'center',x:0}}],audio:{mode:'mute'}}),ExportSchema.parse({cut:'exact',quality:0}),tools,{workDir:dir,signal:new AbortController().signal,maxRuntimeSeconds:90});
 const clipped=await bounds(edge,0);assert.ok(clipped.x0<=2,JSON.stringify(clipped));assert.ok(clipped.x1<(red.x1-red.x0)*.65,JSON.stringify(clipped));assert.ok(clipped.count<red.count*.8,'Titles centered on an edge clip, matching the canvas rather than silently repositioning on export');
 console.log('Styled export evidence: '+dir);
});
