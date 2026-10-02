import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorIcon } from './EditorIcon';
import { TextInspector } from './TextInspector';
import { AudioInspector } from './AudioInspector';
import { TransformInspector } from './TransformInspector';
import { OverlayInspector } from './OverlayInspector';
import { MAX_OVERLAYS, imageFromClipboard, newOverlay, uploadOverlayImage } from './overlay';
import { ExportSchema, RecipeSchema } from '../../../packages/contracts/src/index';
import type { Artifact, Capabilities, ExportOptions, Job, Plan, Project, Recipe, Source } from '../../../packages/contracts/src/index';
import { bytes, Checkbox, Field, NumberField, Panel } from '../../../packages/ui/src/index';
import { api, contentUrl, request, saveJson } from './api';
import { initialRecipe, removeInterval } from './recipe';
import { CutWorkspace } from './CutWorkspace';
import { RenderedPreview } from './RenderedPreview';
import { browserStorage, draftKey, readDraft, writeDraft, type WorkspaceState } from './drafts';
import { ArtifactActions } from './ArtifactActions';
import { angle, clampCrop, outputSize } from './transform';
type Task = (work:()=>Promise<unknown>)=>Promise<void>;

export function Editor({source,artifact,sources,artifacts,jobs,caps,project,run,refresh,setNotice}:{jobs:Job[];source:Source;artifact:Artifact;sources:Source[];artifacts:Artifact[];caps:Capabilities;project?:Project;run:Task;refresh:()=>Promise<void>;setNotice:(s:string)=>void}) {
  const duration=artifact?.media.duration||1,stream=artifact?.media.streams.find(s=>s.type==='video');
  const storage=browserStorage(),key=draftKey(caps.user.id,source.id,project?.id);
  const [restored]=useState(()=>{const d=readDraft(storage,key,source.id);return d&&(!project||d.updatedAt>=project.updatedAt)?d:undefined;});
  const [history,setHistory]=useState<Recipe[]>(restored?.history||[project?{...project.recipe,overlays:project.recipe.overlays||[]}:initialRecipe(source.id,duration)]),[cursor,setCursor]=useState(restored?.cursor||0);
  const [workspace,setWorkspace]=useState<WorkspaceState>(restored?.workspace||{selected:0,zoom:1,snap:false});
  const [draftSaved,setDraftSaved]=useState<boolean|null>(true);
  const tool=['Text','Overlay','Audio','Transform','Cut'].includes(workspace.tool||'')?workspace.tool!:'Cut';
  const setTool=(tool:string)=>setWorkspace(w=>({...w,tool:tool as WorkspaceState['tool']}));

  const exportDialog=useRef<HTMLDialogElement>(null);
  const [previewDialogHost,setPreviewDialogHost]=useState<HTMLDivElement|null>(null);
  const planRevision=useRef(0);const invalidatePlan=()=>{planRevision.current++;setPlan(undefined);};
  const recipe=history[cursor];const change=(raw:Recipe)=>{
    let next=raw;
    // Keep an explicit resize in step with crop/rotate changes: same scale factor, new aspect ratio.
    if(raw.resize&&recipe.resize&&stream&&(raw.crop!==recipe.crop||raw.rotate!==recipe.rotate)&&JSON.stringify(raw.crop)+raw.rotate!==JSON.stringify(recipe.crop)+recipe.rotate){
      const before=outputSize({...recipe,resize:undefined},stream.width||640,stream.height||360,stream.rotation||0),after=outputSize({...raw,resize:undefined},stream.width||640,stream.height||360,stream.rotation||0);
      const factor=recipe.resize.width/before.width,fit=(v:number)=>Math.max(2,Math.min(7680,Math.round(v/2)*2));
      next={...raw,resize:{width:fit(after.width*factor),height:fit(after.height*factor)}};
    }
    const updated=[...history.slice(0,cursor+1),next].slice(-100);setHistory(updated);setCursor(updated.length-1);invalidatePlan();};
  const [options,setOptions]=useState<ExportOptions>(()=>{
    const selected=restored?.options||project?.options||ExportSchema.parse({mode:'auto',encoder:'auto',speed:'fast'});
    // Upgrade old source drafts once; saved projects and subsequent explicit choices remain intact.
    return restored&&!restored.performanceVersion&&!project?{...selected,encoder:'auto',speed:'fast'}:selected;
  }),[plan,setPlan]=useState<Plan>();
  const [time,setTime]=useState(Math.min(duration,restored?.time||0)),[pauseSource,setPauseSource]=useState(0);
  const [wave,setWave]=useState<number[]>([]),[waveLoading,setWaveLoading]=useState(false);const waveAbort=useRef<AbortController|null>(null);
  const [removeStart,setRemoveStart]=useState(0),[removeEnd,setRemoveEnd]=useState(Math.min(1,duration)),[projectName,setProjectName]=useState(restored?.projectName||project?.name||source.name),[projectId,setProjectId]=useState(restored?.projectId||project?.id);
  const [presetId,setPresetId]=useState<string|undefined>(restored?.presetId);const [previewId,setPreviewId]=useState(source.artifactId),[presetList,setPresetList]=useState<any[]>([]);
  const proxies=artifacts.filter(a=>a.kind==='proxy'&&a.sourceId===source.id);
  const exports=artifacts.filter(a=>a.kind==='export'&&a.sourceId===source.id);
  const setExport=(next:ExportOptions)=>{setOptions(next);invalidatePlan();};
  useEffect(()=>{request<any[]>('/presets').then(setPresetList).catch(()=>{});return()=>waveAbort.current?.abort();},[]);
  const audio=(patch:Partial<Recipe['audio']>)=>change({...recipe,audio:{...recipe.audio,...patch}});
  // Uploading takes a moment; the overlay is added to whatever the recipe is by then, at the playhead it was requested from.
  const [addingOverlay,setAddingOverlay]=useState(false);const latest=useRef({recipe,change});latest.current={recipe,change};
  const addOverlay=(file:File)=>void run(async()=>{
    if(!stream)throw new Error('Overlays need a source with video.');
    if(latest.current.recipe.overlays.length>=MAX_OVERLAYS)throw new Error(`You can use up to ${MAX_OVERLAYS} overlays.`);
    const at=time;setAddingOverlay(true);
    try{
      const image=await uploadOverlayImage(file,file.name&&file.name!=='image.png'?file.name:'Pasted image');
      const {recipe:current,change:apply}=latest.current,overlay=newOverlay(image,at,duration,outputSize(current,stream.width||640,stream.height||360,stream.rotation||0));
      apply({...current,overlays:[...current.overlays,overlay]});
      setWorkspace(w=>({...w,tool:'Overlay',selectedOverlay:current.overlays.length}));setNotice(`Overlay added at ${at.toFixed(2)} s.`);
    }finally{setAddingOverlay(false);}
  });
  const pasteOverlay=useRef<(event:ClipboardEvent)=>void>(()=>{});
  pasteOverlay.current=event=>{
    const target=event.target as HTMLElement|null;
    if(target?.closest('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]'))return;
    const file=imageFromClipboard(event.clipboardData);if(!file)return;
    event.preventDefault();addOverlay(file);
  };
  useEffect(()=>{const handler=(event:ClipboardEvent)=>pasteOverlay.current(event);window.addEventListener('paste',handler);return()=>window.removeEventListener('paste',handler);},[]);
  const saveDraft=useRef(()=>{});
  saveDraft.current=()=>{if(!RecipeSchema.safeParse(recipe).success||!ExportSchema.safeParse(options).success){setDraftSaved(null);return;}setDraftSaved(writeDraft(storage,key,{version:1,performanceVersion:1,sourceId:source.id,history,cursor,options,time,workspace,projectName,projectId,presetId,updatedAt:new Date().toISOString()}));};
  // Scrubbing and dragging must not serialize the full undo history on every pointer event.
  useEffect(()=>{const timer=window.setTimeout(()=>saveDraft.current(),250);return()=>window.clearTimeout(timer);},[history,cursor,options,time,workspace,projectName,projectId,presetId,key]);
  useEffect(()=>{const flush=()=>saveDraft.current();window.addEventListener('pagehide',flush);return()=>{window.removeEventListener('pagehide',flush);flush();};},[]);
  useEffect(()=>{
    setWave([]);setWaveLoading(false);if(!artifact.media.streams.some(s=>s.type==='audio'))return;
    const controller=new AbortController(),count=Math.min(2000,Math.max(100,Math.ceil(duration*40))),combined=Array(count).fill(0);
    setWaveLoading(true);
    void(async()=>{let start=0;try{while(start<duration){
      const length=Math.min(30,duration-start);let data:{peaks:number[];sampleRate:number;start:number;end:number;complete:boolean}|undefined;
      // The server allows two preview operations at once; wait for a free slot instead of giving up.
      for(let attempt=0;attempt<12&&!data;attempt++){
        try{data=await request<{peaks:number[];sampleRate:number;start:number;end:number;complete:boolean}>(`/sources/${source.id}/waveform?start=${start}&duration=${length}&points=${Math.max(1,Math.ceil(count*length/duration))}&track=${recipe.audio.track}`,{signal:controller.signal});}
        catch(e){if((e as {status?:number}).status!==429||controller.signal.aborted)throw e;await new Promise(resolve=>setTimeout(resolve,300+attempt*150));}
      }
      if(!data)throw new Error('Waveform is busy');
      if(controller.signal.aborted)return;
      data.peaks.forEach((v,i)=>{const index=Math.min(count-1,Math.floor((data.start+i/data.sampleRate)/duration*count));combined[index]=Math.max(combined[index],v)});setWave([...combined]);
      if(data.complete||data.end<=start)break;start=data.end;
    }}catch{/* Playback remains available if waveform analysis is unavailable. */}finally{if(!controller.signal.aborted)setWaveLoading(false);}})();
    return()=>controller.abort();
  },[source.id,recipe.audio.track]);
  const keptDuration=recipe.segments.reduce((n,s)=>n+s.out-s.in,0);
  const resizeValue=recipe.resize?`${recipe.resize.width}x${recipe.resize.height}`:'original';
  const baseWidth=recipe.crop?.width||stream?.width||1920,baseHeight=recipe.crop?.height||stream?.height||1080;
  const rotated=angle(recipe.rotate-(stream?.rotation||0))%180===90;
  const imageWidth=rotated?baseHeight:baseWidth,imageHeight=rotated?baseWidth:baseHeight;
  const resolutionChoices=[1080,720,480].filter(height=>height<imageHeight).map(height=>({height,width:Math.max(2,Math.floor(imageWidth/imageHeight*height/2)*2)})).filter(({width})=>width<=7680);
  const playbackOptions=<>    <details><summary>Playback source and original media details</summary><Field label="Playback source"><select value={previewId} onChange={e=>setPreviewId(e.target.value)}><option value={source.artifactId}>Original media</option>{proxies.map(p=><option key={p.id} value={p.id}>Proxy · {new Date(p.createdAt).toLocaleString()}</option>)}</select></Field><button aria-label="Generate playback proxy" disabled={!caps.user.policy.process} onClick={()=>void run(async()=>{await api.submit({type:'proxy',sourceId:source.id});await refresh();setNotice('Playback copy queued.');})}>Make playback copy</button><pre>{JSON.stringify(artifact?.media,null,2)}</pre></details>    <details><summary>Remove a source interval from all kept segments</summary><div className="form-grid"><NumberField label="Remove from (s)" value={removeStart} onChange={setRemoveStart}/><NumberField label="Remove until (s)" value={removeEnd} onChange={setRemoveEnd}/><button onClick={()=>void run(async()=>change(removeInterval(recipe,removeStart,removeEnd)))}>Remove interval</button></div></details>    <div className="actions"><button disabled={waveLoading} onClick={()=>void run(async()=>{waveAbort.current=new AbortController();setWaveLoading(true);try{const count=Math.min(2000,Math.ceil(duration*10)),combined=Array(count).fill(0);let start=0;while(start<duration){const data=await request<{peaks:number[];sampleRate:number;start:number;end:number;complete:boolean}>(`/sources/${source.id}/waveform?start=${start}&duration=30&points=${Math.max(1,Math.ceil(count*30/duration))}&track=${recipe.audio.track}`,{signal:waveAbort.current.signal});data.peaks.forEach((v,i)=>{const index=Math.min(count-1,Math.floor((data.start+i/data.sampleRate)/duration*count));combined[index]=Math.max(combined[index],v);});setWave([...combined]);setNotice(`Waveform generated through ${data.end.toFixed(1)} of ${duration.toFixed(1)} seconds`);if(data.complete||data.end<=start)break;start=data.end;}}finally{setWaveLoading(false);}})}>Load waveform</button>{waveLoading&&<button onClick={()=>waveAbort.current?.abort()}>Cancel waveform</button>}</div></>;
  const exportSummary=<>
    <h2 className="pane-title"><EditorIcon name="export" size={17}/>Export</h2>
    <Field label="Cutting"><select aria-label="Cutting mode" value={options.cut==='auto'&&options.mode!=='auto'?'custom':options.cut} onChange={e=>{setPresetId(undefined);setExport({...options,cut:e.target.value as ExportOptions['cut'],...(e.target.value!=='exact'?{mode:'auto' as const}:{})});}}><option value="auto">Fast when possible</option><option value="copy">Lossless keyframe cut</option><option value="exact">Exact frame cut</option>{options.cut==='auto'&&options.mode!=='auto'&&<option value="custom">Current compression settings</option>}</select></Field>
    <p className="muted">Lossless cuts snap to keyframes. Exact cuts take longer.</p>
    {stream&&<Field label="Video size"><select aria-label="Export resolution" value={resizeValue} onChange={e=>{const value=e.target.value;if(value==='original')change({...recipe,resize:undefined});else{const [width,height]=value.split('x').map(Number);change({...recipe,resize:{width,height}});}}}>
      <option value="original">Original size</option>
      {resolutionChoices.map(({height,width})=><option key={height} value={`${width}x${height}`}>{height}p</option>)}
      {recipe.resize&&!resolutionChoices.some(({width,height})=>`${width}x${height}`===resizeValue)&&<option value={resizeValue}>Custom ({recipe.resize.width} × {recipe.resize.height})</option>}
    </select></Field>}
    <Field label="File type"><select aria-label="Export file type" value={options.container} onChange={e=>setExport({...options,container:e.target.value as ExportOptions['container']})}><option value="mp4">MP4</option><option value="mkv">MKV</option></select></Field>
    <Field label="Max size"><select aria-label="Export maximum file size" value={options.mode==='size'?String(options.maxBytes):'none'} onChange={e=>setExport(e.target.value==='none'?{...options,mode:'auto'}:{...options,cut:options.cut==='copy'?'auto':options.cut,mode:'size',maxBytes:Number(e.target.value)})}><option value="none">No size limit</option>{[10,20,50,100].map(size=><option key={size} value={size*1_000_000}>{size} MB</option>)}{options.mode==='size'&&![10,20,50,100].includes((options.maxBytes||0)/1_000_000)&&<option value={options.maxBytes}>{bytes(options.maxBytes||0)}</option>}</select></Field>
    <div className="export-summary-details"><h3>Output</h3><strong>{keptDuration.toFixed(2)} seconds</strong><span>{options.container.toUpperCase()}{recipe.resize?` · ${recipe.resize.height}p`:''}{options.mode==='size'?` · up to ${bytes(options.maxBytes||0)}`:''}</span></div>
    <button className="export-summary-review" onClick={()=>exportDialog.current?.showModal()}><EditorIcon name="sliders" size={16}/>Review settings</button>
    <details className="editor-project-settings"><summary><EditorIcon name="save" size={15}/>Project</summary>    <div className="form-grid"><Field label="Project name"><input value={projectName} onChange={e=>setProjectName(e.target.value)}/></Field><button disabled={!projectName.trim()} onClick={()=>void run(async()=>{const p=await api.saveProject({name:projectName,recipe,options},projectId);setProjectId(p.id);setNotice('Project saved.');})}><EditorIcon name="save" size={16}/>Save project</button><button aria-label="Export recipe JSON" onClick={()=>saveJson('edit-recipe.json',{recipe,options})}><EditorIcon name="download" size={16}/>Download edit settings</button></div></details>
  </>;
  const inspector=<div className="editor-inspector"><div hidden={tool!=='Transform'}>    <TransformInspector recipe={recipe} change={change} width={stream?.width||640} height={stream?.height||360} sourceRotation={stream?.rotation||0}/></div><div hidden={tool!=='Text'}>    <TextInspector recipe={recipe} change={change} width={outputSize(recipe,stream?.width||640,stream?.height||360,stream?.rotation||0).width}/></div><div hidden={tool!=='Overlay'}>    <OverlayInspector recipe={recipe} change={change} selected={workspace.selectedOverlay} select={selectedOverlay=>setWorkspace(w=>({...w,selectedOverlay}))} time={time} duration={duration} adding={addingOverlay} addImage={addOverlay}/></div><div hidden={tool!=='Audio'}>    <AudioInspector recipe={recipe} audio={audio} artifact={artifact} sources={sources} artifacts={artifacts} duration={duration}/></div></div>;
  return <div className="editor-workspace" ref={setPreviewDialogHost}>
    {document.getElementById('editor-header-actions')&&createPortal(<><span className="editor-save-state" data-state={draftSaved===null?'invalid':draftSaved?'saved':'session'} role="status"><EditorIcon name={draftSaved===null?'alert':'saved'} size={16}/>{draftSaved===null?'Unsaved fields':draftSaved?'Saved':'Session draft'}</span><button className="primary editor-review-export" aria-label="Export…" onClick={()=>exportDialog.current?.showModal()}><EditorIcon name="export" size={17}/>Review export</button></>,document.getElementById('editor-header-actions')!)}

        <CutWorkspace playbackOptions={playbackOptions} exportSummary={exportSummary} viewerActions={<RenderedPreview dialogHost={previewDialogHost} recipe={recipe} options={options} presetId={presetId} jobs={jobs} artifacts={artifacts} allowed={caps.user.policy.process} refresh={refresh} onOpen={()=>setPauseSource(n=>n+1)}/>} tool={tool} setTool={setTool} sourceName={source.name} mediaWidth={stream?.width||1920} mediaHeight={stream?.height||1080} mediaRotation={stream?.rotation||0} frameRate={stream?.frameRate} workspace={workspace} setWorkspace={setWorkspace} inspector={tool==='Cut'?undefined:inspector} pauseSignal={pauseSource} sourceId={source.id} previewId={previewId} duration={duration} recipe={recipe} change={change} time={time} setTime={setTime} wave={wave} waveLoading={waveLoading} hasAudio={artifact.media.streams.some(s=>s.type==='audio')} thumbnails={<SourceThumbnails sourceId={source.id} duration={duration}/>} run={run} canUndo={cursor>0} canRedo={cursor<history.length-1} undo={()=>{setCursor(cursor-1);invalidatePlan();}} redo={()=>{setCursor(cursor+1);invalidatePlan();}}/>
    <dialog ref={exportDialog} className="export-dialog" aria-label="Export media">
      <div className="dialog-heading"><strong><EditorIcon name="export" size={20}/>Review and export</strong><button className="icon-button" aria-label="Close export" title="Close" onClick={()=>exportDialog.current?.close()}><EditorIcon name="close" size={18}/></button></div>
      <Panel title="Export settings">
        <Field label="Saved preset"><select aria-label="Apply portable preset" value="" onChange={e=>{
          const item=presetList.find(p=>(p.id||p.preset?.id)===e.target.value);
          if(item){setPresetId(item.id);const p=item.preset||item;setExport(p.options);if(p.maxHeight&&stream?.height&&stream.height>p.maxHeight)change({...recipe,resize:{height:p.maxHeight,width:Math.floor((stream.width||640)/stream.height*p.maxHeight/2)*2}});}
        }}><option value="">Choose a saved preset</option>{presetList.map(p=><option key={p.id||p.preset?.id} value={p.id||p.preset?.id}>{p.name||p.preset?.name}</option>)}</select></Field>
        <div className="export-goal">
          <Field label="Output goal"><select value={options.mode} onChange={e=>setExport({...options,mode:e.target.value as ExportOptions['mode'],...(e.target.value==='size'?{maxBytes:options.maxBytes||20_000_000}:{})})}><option value="quality">Picture quality</option><option value="size">Fit a maximum file size</option><option value="auto">Automatic</option><option value="bitrate">Bitrate target</option></select></Field>
          {options.mode==='size'&&<NumberField label="Maximum size (MB)" min={.001024} step={.1} value={(options.maxBytes||20_000_000)/1_000_000} onChange={v=>setExport({...options,maxBytes:Math.max(1024,Math.round(v*1_000_000))})}/>}
          <p className="muted">{keptDuration.toFixed(3)} seconds · {options.container.toUpperCase()} · original file kept</p>
        </div>
        <details><summary>Advanced encoding settings</summary><ExportFields options={options} change={setExport}/></details>
        <Checkbox label="Fully verify lossless exports (slower)" value={options.copyValidation==='full'} onChange={value=>setExport({...options,copyValidation:value?'full':'fast'})}/>
        {!plan&&<p className="export-step-hint"><EditorIcon name="info" size={16} tone="info"/>Review the settings first to check how the export will be processed, then export.</p>}
        {plan&&<div className="plan">
          <h3><EditorIcon name="saved" size={18} tone="ok"/>Ready to export</h3>
          <p>{plan.duration.toFixed(3)} seconds · {options.container.toUpperCase()}</p>
          {plan.warnings.length>0&&<ul className="export-warnings">{plan.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul>}
          <details><summary>Processing details</summary>
            <p>{plan.strategy==='copy'?'Stream copy':'Exact re-encode'} · {plan.encoder}</p>
            <p>Video: {plan.video}. Audio: {plan.audio}. Maximum attempts: {plan.attempts}.</p>
            {plan.reasons.length>0&&<ul>{plan.reasons.map((reason,i)=><li key={i}>{reason}</li>)}</ul>}
            <p>Requested cut positions: {plan.segments.map(s=>s.in.toFixed(6)+' to '+s.out.toFixed(6)).join(', ')} seconds{plan.strategy==='copy'?'; keyframe positions resolve during export.':'.'}</p>
          </details>
        </div>}
        <div className="actions">
          <button aria-label="Resolve export plan" disabled={!caps.user.policy.process} onClick={()=>void run(async()=>{
            const revision=++planRevision.current;setPlan(undefined);const resolved=await api.plan(recipe,options,presetId);if(revision===planRevision.current)setPlan(resolved);
          })}><EditorIcon name="sliders" size={16}/>Review settings</button>
          <button aria-label="Export using reviewed plan" disabled={!plan||!caps.user.policy.process} onClick={()=>void run(async()=>{
            await api.submit({type:'export',recipe,options,...(presetId?{presetId}:{})});await refresh();setNotice('Export queued.');
          })} className="primary"><EditorIcon name="export" size={16}/>Export video</button>
        </div>
      </Panel>
    </dialog>
    <details className="completed-results" hidden={!exports.length}><summary>Completed export previews ({exports.length})</summary>    {exports.length>0&&<Panel title="Completed export previews">{exports.map(a=><article key={a.id}><h3>{a.name} · {bytes(a.bytes)}</h3><video controls src={contentUrl(a.id)} preload="metadata"/><ArtifactActions artifact={a} run={run} setNotice={setNotice}/></article>)}</Panel>}</details>
  </div>;
}



const thumbCache=new Map<string,string>();
const TILE_WIDTH=96,MAX_TILES=48;

// One tile per slice of the timeline's current width, filled progressively with small JPEGs.
export function SourceThumbnails({sourceId,duration}:{sourceId:string;duration:number}) {
  const root=useRef<HTMLDivElement>(null);
  const [tiles,setTiles]=useState(4),[urls,setUrls]=useState<Record<number,string>>({}),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{
    const element=root.current;if(!element)return;
    const measure=()=>setTiles(Math.max(4,Math.min(MAX_TILES,Math.ceil(element.clientWidth/TILE_WIDTH))));
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    const controller=new AbortController();let active=true;setError('');
    const key=(index:number)=>`${sourceId}:${tiles}:${index}`;
    const have:Record<number,string>={};for(let i=0;i<tiles;i++){const cached=thumbCache.get(key(i));if(cached)have[i]=cached;}
    setUrls(have);
    const order=Array.from({length:tiles},(_,i)=>i).filter(i=>!have[i]).sort((a,b)=>Math.abs(a-tiles/2)-Math.abs(b-tiles/2));
    const load=async(index:number)=>{
      const pts=Math.min(Math.max(0,duration-.05),(index+.5)/tiles*duration);
      for(let attempt=0;attempt<6;attempt++){
        const response=await fetch(`/api/v1/sources/${sourceId}/thumb?pts=${pts.toFixed(3)}`,{credentials:'same-origin',signal:controller.signal});
        if(response.status===429){await new Promise(resolve=>setTimeout(resolve,300+attempt*200));continue;}
        if(!response.ok)throw new Error(`Thumbnail request failed (${response.status}).`);
        const url=URL.createObjectURL(await response.blob());thumbCache.set(key(index),url);
        if(active)setUrls(current=>({...current,[index]:url}));return;
      }
      throw new Error('Thumbnails are busy. Try again in a moment.');
    };
    void(async()=>{try{
      const workers=[0].map(async()=>{while(active&&order.length){const index=order.shift()!;await load(index);}});
      await Promise.all(workers);
    }catch(e){if(active&&!(e instanceof DOMException&&e.name==='AbortError'))setError(e instanceof Error?e.message:String(e));}})();
    return()=>{active=false;controller.abort();};
  },[sourceId,duration,tiles,revision]);
  return <><div className="thumbs" ref={root}>{Array.from({length:tiles},(_,i)=>urls[i]
    ?<img key={i} src={urls[i]} alt={`Source thumbnail at ${((i+.5)/tiles*duration).toFixed(2)} seconds`}/>
    :<span key={i} className="thumb-skeleton" aria-hidden="true"/>)}</div>{error&&<p className="error-text">{error} <button onClick={()=>setRevision(revision+1)}>Retry thumbnails</button></p>}</>;
}


export function ExportFields({options:o,change}:{options:ExportOptions;change:(o:ExportOptions)=>void}) {
  const update=(patch:Partial<ExportOptions>)=>change({...o,...patch});
  return <><div className="form-grid"><Field label="Cutting strategy"><select value={o.cut} onChange={e=>update({cut:e.target.value as ExportOptions['cut']})}><option value="auto">Automatic, explained</option><option value="copy">Fast stream copy at keyframes</option><option value="exact">Exact frame re-encode</option></select></Field><Field label="Compression mode"><select value={o.mode} onChange={e=>update({mode:e.target.value as ExportOptions['mode'],...(e.target.value==='size'&&!o.maxBytes?{maxBytes:20_000_000}:{})})}><option value="auto">Automatic</option><option value="quality">Quality target</option><option value="bitrate">Bitrate target</option><option value="size">Maximum byte size</option></select></Field><Field label="Video codec"><select value={o.codec} onChange={e=>update({codec:e.target.value as ExportOptions['codec']})}><option value="h264">H.264</option><option value="hevc">H.265 / HEVC</option><option value="av1">AV1</option></select></Field><Field label="Container"><select value={o.container} onChange={e=>update({container:e.target.value as ExportOptions['container']})}><option value="mp4">MP4</option><option value="mkv">Matroska</option></select></Field><Field label="Encoder preference"><select value={o.encoder} onChange={e=>update({encoder:e.target.value as ExportOptions['encoder']})}><option value="software">Software CPU</option><option value="hardware">Verified hardware</option><option value="auto">Automatic</option></select></Field><Field label="Speed / efficiency"><select value={o.speed} onChange={e=>update({speed:e.target.value as ExportOptions['speed']})}><option value="fast">Faster</option><option value="balanced">Balanced</option><option value="quality">More compression effort</option></select></Field>{o.mode==='quality'&&<NumberField label="Quality value (lower is higher quality)" value={o.quality} min={0} max={51} step={1} onChange={quality=>update({quality})}/ >}{o.mode==='bitrate'&&<NumberField label="Video bitrate (bits/s)" value={o.bitrate} min={10000} step={1000} onChange={bitrate=>update({bitrate})}/ >}{o.mode==='size'&&<><NumberField label="Maximum output bytes" value={o.maxBytes||20_000_000} min={1024} step={1} onChange={maxBytes=>update({maxBytes})}/><p>{((o.maxBytes||0)/1_000_000).toFixed(3)} MB · {((o.maxBytes||0)/1_048_576).toFixed(3)} MiB. Complete decodable output must fit; an impossible constraint fails explicitly.</p><NumberField label="Maximum encode attempts" value={o.maxAttempts} min={1} max={3} step={1} onChange={maxAttempts=>update({maxAttempts})}/></>}<NumberField label="Audio bitrate (bits/s)" value={o.audioBitrate} min={16000} max={320000} step={1000} onChange={audioBitrate=>update({audioBitrate})}/></div><Checkbox label="Set constant output frame rate" value={o.frameRate!==undefined} onChange={v=>update({frameRate:v?30:undefined})}/>{o.frameRate!==undefined&&<NumberField label="Output frames per second" value={o.frameRate} min={1} max={240} onChange={frameRate=>update({frameRate})}/>}<Checkbox label="Allow software fallback if the requested hardware cannot run" value={o.allowSoftwareFallback} onChange={allowSoftwareFallback=>update({allowSoftwareFallback})}/></>;
}
