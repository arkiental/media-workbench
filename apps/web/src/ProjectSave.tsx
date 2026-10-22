import React, { useRef, useState } from 'react';
import type { ExportOptions, Recipe } from '../../../packages/contracts/src/index';
import { api, saveJson } from './api';
import { EditorIcon } from './EditorIcon';
import './project-save.css';

export function ProjectSave({name,id,recipe,options,onName,onSaved}:{name:string;id?:string;recipe:Recipe;options:ExportOptions;onName:(name:string)=>void;onSaved:(id:string)=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),busy=useRef(false);
  const [saving,setSaving]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState<{name:string;key:string;copy:boolean}>();
  const [copyName,setCopyName]=useState<string>();
  const separateName=copyName??`${name.slice(0,115)} copy`;
  const key=JSON.stringify({name:name.trim(),recipe,options});
  const save=async(copy:boolean)=>{
    if(busy.current||!(copy?separateName:name).trim())return;
    busy.current=true;setSaving(true);setError('');setSaved(undefined);
    const snapshot={name:(copy?separateName:name).trim(),recipe,options},snapshotKey=key;
    try {
      const project=await api.saveProject(snapshot,copy?undefined:id);
      if(!copy)onSaved(project.id);
      setSaved({name:snapshot.name,key:snapshotKey,copy});
    } catch(e) { setError(e instanceof Error?e.message:'The project could not be saved.'); }
    finally {busy.current=false;setSaving(false);}
  };
  return <>
    <button className="project-save-trigger" aria-label="Project saving" title="Save project or make a copy" onClick={()=>dialog.current?.showModal()}><EditorIcon name="save" size={17}/><span>Project</span></button>
    <dialog ref={dialog} className="project-save-dialog" aria-labelledby="project-save-title">
      <div className="project-save-heading"><h2 id="project-save-title">Save your edit</h2><button aria-label="Close project saving" onClick={()=>dialog.current?.close()}>Close</button></div>
      <p>Your working draft saves automatically. Named projects appear under Saved projects in Library.</p>
      <label className="project-save-name">Project name<input autoFocus maxLength={120} value={name} onChange={e=>onName(e.target.value)}/></label>
      <p>{id?'Update this project, or save a separate copy to keep the existing version.':'Create a named project from your current edit.'}</p>
      <div className="project-save-actions"><button className="primary" disabled={saving||!name.trim()} onClick={()=>void save(false)}>{saving?'Saving…':id?'Update project':'Save project'}</button></div>
      {id&&<div className="project-save-copy"><label className="project-save-name">Copy name<input maxLength={120} value={separateName} onChange={e=>setCopyName(e.target.value)}/></label><button disabled={saving||!separateName.trim()} onClick={()=>void save(true)}>Save a copy</button></div>}
      {saving&&<p role="status">Saving this snapshot. You can close this panel and keep editing.</p>}
      {error&&<div role="alert"><p>Project save failed: {error}</p><p>Your working draft is unchanged. Try saving again. If the connection was interrupted, check Saved projects in Library first.</p></div>}
      {saved&&<p role="status">{saved.copy?'Copy saved':'Project saved'}: {saved.name}.{saved.copy?' Your current project stays selected.':''}{saved.key!==key?' Newer changes have not been saved to this snapshot yet.':''}</p>}
      <button className="project-save-download" aria-label="Export recipe JSON" onClick={()=>saveJson('edit-recipe.json',{recipe,options})}><EditorIcon name="download" size={16}/>Download edit settings</button>
    </dialog>
  </>;
}
