import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initialRecipe,parseCaptions,captionsToSrt,removeInterval } from '../apps/web/src/recipe.ts';
import { shareXAction } from '../packages/platform/src/actions.ts';
const require=createRequire(import.meta.url);
const native=require('../apps/desktop/native.cjs');

test('external action placeholders remain individual arguments through a real process',async()=>{
  await mkdir('test-output/native',{recursive:true});const dir=await mkdtemp(path.resolve('test-output/native/arguments-'));
  const script=path.join(dir,'argument receiver.cjs');const output=path.join(dir,'received.json');
  await writeFile(script,"require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))");
  const hostilePath=path.join(dir,'spaces 雪 & dollar$ (test) [1].mp4');await writeFile(hostilePath,'fixture');
  const requested=['{file}','--title=quote " and Unicode 雪 & $()','{filename}','{directory}'];
  const args=native.expandArguments(requested,hostilePath);
  await native.runProcess(process.execPath,[script,output,...args]);
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),[hostilePath,'--title=quote " and Unicode 雪 & $()',path.basename(hostilePath),dir]);
});
test('native action validation rejects renderer executable selection, shell text, and unknown placeholders',()=>{
  const action={name:'Editor',args:['{file}'],uploads:false,timeoutSeconds:30};
  assert.deepEqual(native.validateAction(action).args,['{file}']);
  assert.throws(()=>native.validateAction({...action,executable:'C:\\evil.exe'}),/Unexpected/);
  assert.throws(()=>native.validateAction({...action,args:'--exec evil'}),/array/);
  assert.throws(()=>native.validateAction({...action,args:['{token}']}),/Unknown/);
  assert.throws(()=>native.validateId('../../secret'),/opaque/);
});
test('real Windows file clipboard retains CF_HDROP and Unicode managed path', {skip:process.platform!=='win32'||process.env.MW_TEST_NATIVE_CLIPBOARD!=='1'},async()=>{
  await mkdir('test-output/native',{recursive:true});const dir=await mkdtemp(path.resolve('test-output/native/clipboard-'));const file=path.join(dir,'clipboard 雪 & file.txt');await writeFile(file,'Generated clipboard verification fixture\n');
  const result=await native.windowsFileClipboard(file);assert.equal(result.fileDrop,true);assert.ok(result.paths.includes(file));assert.ok(result.formats.includes('FileDrop'));
  const inspected=await native.windowsFileClipboard(undefined,'inspect');assert.deepEqual(inspected.paths,[file]);
  await writeFile(path.resolve('test-output/native/clipboard-evidence.json'),JSON.stringify({testedAt:new Date().toISOString(),platform:process.platform,result,inspected},null,2));
});
test('caption import and removed intervals retain source-time coordinates',()=>{
  const captions=parseCaptions('WEBVTT\n\n00:00.250 --> 00:01.200\nHello 雪\n\n00:02.000 --> 00:03.000\nSecond');
  assert.deepEqual(parseCaptions(captionsToSrt(captions)),captions);
  const result=removeInterval(initialRecipe('00000000-0000-0000-0000-000000000001',4),1,2);
  assert.deepEqual(result.segments,[{in:0,out:1},{in:2,out:4}]);
  assert.throws(()=>removeInterval(result,0,4),/remain/);
});
test('ShareX adapter uses documented file and task arguments with upload confirmation metadata',()=>{
  const action=shareXAction('Configured upload 雪 & quotes "task"');
  assert.equal(action.uploads,true);assert.equal(action.adapter,'sharex');
  assert.deepEqual(native.expandArguments(native.validateAction(action).args,'C:\\Generated media\\clip & 雪.mp4'),['C:\\Generated media\\clip & 雪.mp4','-task','Configured upload 雪 & quotes "task"']);
  assert.throws(()=>native.validateAction({...action,uploads:false}),/upload-marked/);
  assert.throws(()=>shareXAction('{file}'),/braces/);
});
