import assert from 'node:assert/strict';
import test from 'node:test';
import { RecipeSchema } from '../packages/contracts/src/index.ts';
import { captionLayout } from '../packages/contracts/src/caption.ts';
import { downloadQualities } from '../apps/web/src/downloadQuality.ts';
import { viewportGeometry } from '../apps/web/src/transform.ts';
import { enforceJob,defaultPolicy } from '../packages/core/src/policy.ts';
import { ExportSchema } from '../packages/contracts/src/index.ts';

test('caption adds an even-height band without scaling or cropping the picture',()=>{
  const caption={text:'White caption\nSecond line',size:20,padding:12};
  const layout=captionLayout(caption,640);assert.equal(layout.height,74);
  assert.equal(captionLayout({...caption,text:'   '},640).height,0);
  const geometry=viewportGeometry({rotate:0,caption},640,360,640,434,false,false);
  assert.deepEqual(geometry.output,{width:640,height:434});assert.equal(geometry.transform.y,74);assert.equal(geometry.transform.a,1);
  assert.equal(viewportGeometry({rotate:0,caption},640,360,640,434,true,false).header.height,0);
});

test('caption wraps long words and explicit lines consistently at output width',()=>{
  const layout=captionLayout({text:'longcaptionword\nSecond',size:20,padding:10},100);
  assert(layout.text.includes('\n'));assert.equal(layout.height%2,0);
  assert(layout.text.split('\n').every(line=>[...line].length<=5));
});

test('quality buttons reflect actual video formats and preserve separate audio',()=>{
  const formats=[{id:'480',width:854,height:480,vcodec:'h264',acodec:'aac',ext:'mp4'},{id:'720',width:1280,height:720,vcodec:'h264',acodec:'none',ext:'mp4'},{id:'4k',width:2160,height:3840,vcodec:'vp9',acodec:'none',ext:'webm'},{id:'audio',vcodec:'none',acodec:'aac'}];
  assert.deepEqual(downloadQualities(formats,true),[{label:'480p',format:'480'},{label:'720p',format:'720+bestaudio/720'},{label:'4K',format:'4k+bestaudio/4k'}]);
  assert.deepEqual(downloadQualities([{id:'storyboard',width:1920,height:1080,vcodec:'none',acodec:'none'}],true),[]);
});

test('caption schema rejects unsafe values and requires permission to render',()=>{
  const sourceId='6e6f5506-dc18-4f10-83fb-5f80dad99002';
  assert.equal(RecipeSchema.safeParse({sourceId,segments:[{in:0,out:1}],caption:{text:'hello',size:Infinity,padding:0}}).success,false);
  const recipe=RecipeSchema.parse({sourceId,segments:[{in:0,out:1}],caption:{text:'hello',size:20,padding:8}});
  assert.throws(()=>enforceJob({type:'export',recipe,options:ExportSchema.parse({cut:'copy'})},{...defaultPolicy('member'),expensiveFilters:false}),/Expensive processing/);
});
