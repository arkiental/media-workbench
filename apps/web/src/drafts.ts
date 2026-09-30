import { z } from 'zod';
import { RecipeSchema, ExportSchema, type Recipe } from '../../../packages/contracts/src/index';

const WorkspaceSchema=z.object({selected:z.number().int().min(0),zoom:z.number().min(1).max(20),snap:z.boolean(),tool:z.enum(['Cut','Transform','Text','Audio','Source','Project']).optional(),selectedText:z.number().int().min(0).optional(),viewerFit:z.enum(['fit','fill']).optional()});
export type WorkspaceState=z.infer<typeof WorkspaceSchema>;
const DraftSchema=z.object({
  version:z.literal(1),sourceId:z.string(),projectId:z.string().optional(),projectName:z.string(),
  history:z.array(z.unknown()).min(1).max(100),cursor:z.number().int().min(0),
  options:ExportSchema,time:z.number().finite().min(0),workspace:WorkspaceSchema,
  presetId:z.string().optional(),updatedAt:z.string()
});
export type EditorDraft=Omit<z.infer<typeof DraftSchema>,'history'>&{history:Recipe[]};
export interface DraftStorage {getItem(key:string):string|null;setItem(key:string,value:string):void}
const memory=new Map<string,string>();
export const draftKey=(owner:string,source:string,project?:string)=>`mw:draft:1:${owner}:${source}:${project||'source'}`;
export function readDraft(storage:DraftStorage|undefined,key:string,sourceId:string):EditorDraft|undefined {
  try {
    let raw=memory.get(key);try{raw=raw||storage?.getItem(key)||undefined;}catch{}
    if(!raw)return;
    const result=DraftSchema.safeParse(JSON.parse(raw));
    if(!result.success)return;
    const d=result.data;
    if(d.sourceId!==sourceId||d.cursor>=d.history.length)return;
    const parsed=d.history.map(r=>RecipeSchema.safeParse(r));
    if(!parsed[d.cursor].success||parsed.some(r=>r.success&&r.data.sourceId!==sourceId))return;
    // Number fields may create intermediate invalid undo entries while typing.
    // Do not discard the final valid edit because an older snapshot was incomplete.
    const history=parsed.flatMap(r=>r.success?[r.data]:[]);
    const cursor=parsed.slice(0,d.cursor+1).filter(r=>r.success).length-1;
    return {...d,history,cursor};
  }catch{return;}
}
export function writeDraft(storage:DraftStorage|undefined,key:string,draft:EditorDraft):boolean {
  // Always keep a session fallback, including when browser storage is full/disabled.
  const raw=JSON.stringify(draft);memory.set(key,raw);
  try{if(!storage)return false;storage.setItem(key,raw);return true;}catch{return false;}
}
export function browserStorage():Storage|undefined {try{return window.localStorage;}catch{return;}}
export function readPreference(key:string):string|undefined {try{return browserStorage()?.getItem(key)||undefined;}catch{return;}}
export function writePreference(key:string,value:string):void {try{browserStorage()?.setItem(key,value);}catch{}}
