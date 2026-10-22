import React, {useRef,useState} from 'react';
import {ExportSchema,type ExportOptions,type Preset} from '../../../packages/contracts/src/index';
import {effectiveOptions} from '../../../packages/core/src/presets';
import {api} from './api';
import './export-preset-save.css';

type SavedPreset={id:string;preset:Preset};
function reusableOptions(options:ExportOptions){
  const {fileName,maxBytes,...rest}=options;
  return {...rest,...(options.mode==='size'?{maxBytes}:{})};
}
export function ExportPresetSave({options,activePreset,blocked,onSaved}:{options:ExportOptions;activePreset?:Preset;blocked:boolean;onSaved:(preset:SavedPreset)=>void}){
  const [name,setName]=useState(''),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const [saved,setSaved]=useState<{name:string;key:string}>();
  const busy=useRef(false),alive=useRef(true);
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  let settings:ExportOptions|undefined;
  try{settings=ExportSchema.parse(reusableOptions(effectiveOptions(options,activePreset)));}catch{}
  const key=JSON.stringify(settings??reusableOptions(options));
  const valid=!!settings;
  const save=async()=>{
    if(busy.current||!name.trim()||!valid||blocked)return;
    busy.current=true;setSaving(true);setError('');setSaved(undefined);
    const snapshotKey=key,snapshotName=name.trim(),savedSettings=settings!;
    const preset:Preset={schemaVersion:1,id:crypto.randomUUID(),revision:1,name:snapshotName,
      requires:[...(savedSettings.cut==='exact'?['exact-cut-v1']:[]),...(savedSettings.mode==='size'?['target-size-v1']:[])],options:savedSettings};
    try{
      await api.action('/presets/validate',preset);
      const record=await api.action('/presets/import',preset) as SavedPreset;
      if(alive.current){onSaved(record);setSaved({name:snapshotName,key:snapshotKey});}
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:'Could not save these settings.');}
    finally{busy.current=false;if(alive.current)setSaving(false);}
  };
  return <details className="export-preset-save">
    <summary>Save settings as preset</summary>
    <p>Reuse these encoding settings on other videos. The export name, cuts and picture edits are not included.</p>
    <label>Preset name<input aria-label="Preset name" maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label>
    <button type="button" disabled={saving||!name.trim()||!valid||blocked} onClick={()=>void save()}>{saving?'Saving preset…':'Save preset'}</button>
    {!valid&&<p role="status">Finish entering valid export settings before saving a preset.{activePreset?` Keep within ${activePreset.name}'s requirements, or choose Custom settings (no preset).`:''}</p>}
    {saving&&<p role="status">Saving these settings. You can keep editing.</p>}
    {error&&<div role="alert"><p>Preset save failed: {error}</p><p>Try saving again. If the connection was interrupted, check Saved preset or Presets in Settings first.</p></div>}
    {saved&&<p role="status">Preset saved: {saved.name}. Choose it from Saved preset to reuse it.{saved.key!==key?' Your current settings have changed since this preset was saved.':''}</p>}
  </details>;
}
