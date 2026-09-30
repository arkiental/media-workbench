import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readDraft,writeDraft,draftKey,type EditorDraft} from '../apps/web/src/drafts.ts';
import {initialRecipe} from '../apps/web/src/recipe.ts';
import {ExportSchema} from '../packages/contracts/src/index.ts';
const source='11111111-1111-4111-8111-111111111111';
const draft=():EditorDraft=>({version:1,sourceId:source,projectName:'Clip',history:[initialRecipe(source,4)],cursor:0,options:ExportSchema.parse({}),time:1.2,workspace:{selected:0,zoom:3,snap:true},updatedAt:new Date().toISOString()});
test('draft round trip preserves editing context and isolates owner/project',()=>{
 const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>{values.set(k,v);}};
 const key=draftKey('owner',source);const d=draft();d.history[0].segments=[{in:.5,out:1.5}];
 assert.equal(writeDraft(storage,key,d),true);assert.deepEqual(readDraft(storage,key,source),d);
 assert.equal(readDraft(storage,draftKey('another-owner',source),source),undefined);
 assert.equal(readDraft(storage,draftKey('owner',source,'project'),source),undefined);
});
test('invalid, foreign and out-of-range persisted drafts are ignored',()=>{
 for(const value of ['{',JSON.stringify({...draft(),version:2}),JSON.stringify({...draft(),cursor:9}),JSON.stringify({...draft(),sourceId:'wrong'})]){
  assert.equal(readDraft({getItem:()=>value,setItem:()=>{}},'invalid',source),undefined);
 }
});
test('storage failures retain session copy without claiming durable save',()=>{
 const storage={getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('full');}};
 const key='unavailable';const d=draft();assert.equal(writeDraft(storage,key,d),false);assert.deepEqual(readDraft(storage,key,source),d);
});
test('an intermediate invalid undo entry cannot erase a later valid draft',()=>{
 const d=draft();d.history=[d.history[0],{...d.history[0],crop:{x:0,y:0,width:0,height:100}},{...d.history[0],crop:{x:0,y:0,width:160,height:100}}];d.cursor=2;
 const restored=readDraft({getItem:()=>JSON.stringify(d),setItem:()=>{}},'partial-number',source)!;
 assert.equal(restored.history.length,2);assert.equal(restored.cursor,1);assert.equal(restored.history[1].crop?.width,160);
});
