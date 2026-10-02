import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Artifact, ExportOptions, Job, Plan, Recipe } from '../../../packages/contracts/src/index';
import { bytes } from '../../../packages/ui/src/index';
import { api, contentUrl } from './api';
import { EditorIcon, type IconTone } from './EditorIcon';
import { desktopBridge, browserCapabilities } from '../../../packages/platform/src/index';

const terminal=new Set(['completed','failed','cancelled','interrupted']);
const stateLabels:Record<string,string>={queued:'Waiting to start',preparing:'Preparing',processing:'Rendering',validating:'Checking file',cancelling:'Stopping'};
type Native=Record<string,{state:string;reason?:string}>;
type Props={recipe:Recipe;options:ExportOptions;presetId?:string;jobs:Job[];artifacts:Artifact[];allowed:boolean;refresh:()=>Promise<void>;onOpen:()=>void;dialogHost:HTMLElement|null};

export function RenderedPreview({recipe,options,presetId,jobs,artifacts,allowed,refresh,onOpen,dialogHost}:Props) {
  const key=JSON.stringify({recipe,options,presetId});
  const currentKey=useRef(key);currentKey.current=key;
  const [render,setRender]=useState<{key:string;jobId:string;plan:Plan}>();
  const [open,setOpen]=useState(false),[preparing,setPreparing]=useState(false),[error,setError]=useState(''),[playError,setPlayError]=useState(''),[cancelling,setCancelling]=useState(false);
  const busy=useRef(false),alive=useRef(true),dialog=useRef<HTMLDialogElement>(null),video=useRef<HTMLVideoElement>(null),autoplay=useRef(false);
  const [native,setNative]=useState<Native>(browserCapabilities),[copied,setCopied]=useState<'file'|'path'|''>(''),[fileError,setFileError]=useState('');
  const bridge=desktopBridge(),copiedTimer=useRef(0);
  useEffect(()=>{bridge?.capabilities().then(setNative).catch(()=>{});return()=>window.clearTimeout(copiedTimer.current);},[]);
  const job=jobs.find(j=>j.id===render?.jobId);
  const output=job?.state==='completed'?artifacts.find(a=>a.id===job.artifactId&&a.validated):undefined;
  const stale=!!render&&render.key!==key;
  const working=!!render&&(!job||!terminal.has(job.state));
  useEffect(()=>()=>{alive.current=false;},[]);
  useEffect(()=>{if(stale){autoplay.current=false;video.current?.pause();}},[stale]);
  const show=()=>{onOpen();setOpen(true);setPlayError('');if(!dialog.current?.open)dialog.current?.showModal();};
  const close=()=>{autoplay.current=false;video.current?.pause();setOpen(false);dialog.current?.close();};
  const play=async()=>{
    if(!video.current||stale||!dialog.current?.open)return;
    autoplay.current=false;
    try{await video.current.play();}catch{if(alive.current)setPlayError('Playback did not start. Press Play below, or download this rendered file if your browser does not support its format.');}
  };
  const start=async()=>{
    if(busy.current){show();return;}
    show();setError('');autoplay.current=true;
    if(working){if(stale)autoplay.current=false;return;}
    if(render?.key===key&&output){if(video.current){video.current.currentTime=0;await play();}return;}
    // Never substitute a lower-quality proxy: these are the actual requested export settings.
    busy.current=true;setPreparing(true);setRender(undefined);
    const snapshot={recipe,options,...(presetId?{presetId}:{})},snapshotKey=key;
    try{
      const plan=await api.plan(recipe,options,presetId);
      if(!alive.current||currentKey.current!==snapshotKey){if(alive.current)setError('The edit changed while preparing. Preview again to render the current edit.');return;}
      const submitted=await api.submit({type:'export',...snapshot});
      if(alive.current)setRender({key:snapshotKey,jobId:submitted.id,plan});
      await refresh();
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
    finally{busy.current=false;if(alive.current)setPreparing(false);}
  };
  const cancel=async()=>{
    if(!render||cancelling)return;autoplay.current=false;video.current?.pause();setCancelling(true);setError('');
    try{await api.action(`/jobs/${render.jobId}/cancel`);await refresh();}
    catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setCancelling(false);}
  };
  const fileAction=async(kind:'file'|'path'|'reveal'|'save',id:string)=>{
    if(!bridge)return;setFileError('');
    try{
      if(kind==='file')await bridge.copyFile(id);else if(kind==='path')await bridge.copyPath(id);else if(kind==='reveal')await bridge.reveal(id);else await bridge.saveAs(id);
      if(kind==='file'||kind==='path'){setCopied(kind);window.clearTimeout(copiedTimer.current);copiedTimer.current=window.setTimeout(()=>setCopied(''),2200);}
    }catch(e){setFileError(e instanceof Error?e.message:String(e));}
  };
  const plan=job?.plan||render?.plan;
  const failed=!!job&&['failed','cancelled','interrupted'].includes(job.state);
  const ready=!!output&&!stale;
  const processing=plan?.strategy==='copy'?'Copying':'Rendering';
  const status:[string,IconTone|'muted']=stale?['Outdated','warn']:ready?['Ready','ok']:failed?[job!.state==='failed'?'Failed':job!.state==='cancelled'?'Cancelled':'Interrupted','danger']:preparing||working?[processing,'info']:['Not rendered','muted'];
  const picture=output?.media.streams.find(stream=>stream.type==='video');
  const progress=Math.min(1,Math.max(0,job?.progress||0));
  const clipboard=native.fileClipboard?.state==='available';
  return <div className="rendered-preview-controls">
    {document.getElementById('editor-header-actions')&&createPortal(<button className="header-preview-button" aria-label="Render edited preview" disabled={!allowed||!dialogHost} onClick={()=>void start()}><EditorIcon name="eye" size={17}/>Render preview</button>,document.getElementById('editor-header-actions')!)}
    <button className="preview-video-button" disabled={!allowed||!dialogHost} onClick={()=>void start()}><EditorIcon name="eye" size={16}/>Render preview</button>
    {dialogHost&&createPortal(<dialog className="rendered-preview-dialog" ref={dialog} onCancel={close} onClose={()=>{autoplay.current=false;video.current?.pause();setOpen(false);}} aria-label="Export preview">
      <div className="rendered-preview-heading">
        <div className="rp-title"><EditorIcon name="eye" size={20}/><h2 id="rendered-preview-title">Rendered preview</h2><span className="rp-status" data-tone={status[1]}>{status[0]}</span></div>
        <button className="icon-button" aria-label="Close preview" title="Close (Esc)" onClick={close}><EditorIcon name="close" size={18}/></button>
      </div>
      {stale&&<p role="status" className="notice rp-notice"><EditorIcon name="alert" size={18} tone="warn"/><span>This render belongs to an earlier edit. {working?'Cancel it or wait for it to finish before previewing the current settings.':'Close it and render again to preview your current settings.'}</span></p>}
      <div className="rp-body">
        <div className="rp-stage">
          {ready&&open?<video key={output!.id} ref={video} aria-label="Rendered export preview" controls preload="auto" src={contentUrl(output!.id)} onCanPlay={()=>{if(autoplay.current)void play();}} onError={()=>setPlayError('Cannot play this format here. Save or download the file to watch it.')}/>
          :<div className="rp-placeholder">
            {(preparing||working)&&!failed?<>
              <span className="rp-spinner" aria-hidden="true"/>
              <strong role="status">{preparing?'Preparing export preview…':`${job?.state==='processing'?processing:stateLabels[job?.state||'queued']||processing}${progress>0?` · ${Math.floor(progress*100)}%`:''}`}</strong>
              <progress aria-label="Preview render progress" max={1} value={progress}/>
              {job?.message&&<small>{job.message}</small>}
              {working&&<button disabled={cancelling||job?.state==='cancelling'} onClick={()=>void cancel()}><EditorIcon name="cancel" size={16}/>Cancel preview render</button>}
            </>:failed?<>
              <EditorIcon name="alert" size={28} tone="danger"/>
              <strong role="alert">Preview {job!.state}{job!.error?`: ${job!.error}`:''}.</strong>
              <button onClick={()=>void start()}><EditorIcon name="refresh" size={16}/>Render again</button>
            </>:<>
              <EditorIcon name="eye" size={28}/>
              <strong>{stale?'Preview is out of date':'No preview rendered yet'}</strong>
            </>}
          </div>}
        </div>
        <aside className="rp-side" aria-label="Rendered file">
          <dl className="rp-facts">
            <dt>Duration</dt><dd>{ready?`${output!.media.duration.toFixed(2)} s`:plan?`${plan.duration.toFixed(2)} s`:'—'}</dd>
            <dt>File size</dt><dd>{ready?bytes(output!.bytes):'—'}</dd>
            <dt>Resolution</dt><dd>{picture?.width&&picture.height?`${picture.width} × ${picture.height}`:'—'}</dd>
            <dt>Format</dt><dd>{options.container.toUpperCase()}{picture?.codec?` · ${picture.codec.toUpperCase()}`:''}</dd>
            <dt>Processing</dt><dd>{plan?(plan.strategy==='copy'?'Stream copy':'Re-encode'):'—'}</dd>
          </dl>
          <div className="rp-actions" role="group" aria-label="Rendered file actions">
            {bridge?<>
              <button className="primary rp-copy" disabled={!ready||!clipboard} title={clipboard?'Copy the file so it can be pasted into another app':native.fileClipboard?.reason} onClick={()=>void fileAction('file',output!.id)}><EditorIcon name={copied==='file'?'check':'copy'} size={17}/>{copied==='file'?'Copied to clipboard':'Copy to clipboard'}</button>
              <button disabled={!ready} onClick={()=>void fileAction('save',output!.id)}><EditorIcon name="save" size={16}/>Save as…</button>
              <button disabled={!ready||native.revealFile?.state!=='available'} title={native.revealFile?.reason} onClick={()=>void fileAction('reveal',output!.id)}><EditorIcon name="folder" size={16}/>Show in folder</button>
              <button disabled={!ready} onClick={()=>void fileAction('path',output!.id)}><EditorIcon name={copied==='path'?'check':'link'} size={16}/>{copied==='path'?'Path copied':'Copy file path'}</button>
            </>:<>
              {ready?<a className="rp-download primary-link" href={contentUrl(output!.id)} download={output!.name}><EditorIcon name="download" size={17}/>Download previewed file</a>:<button className="primary" disabled><EditorIcon name="download" size={17}/>Download previewed file</button>}
              <p className="rp-hint"><EditorIcon name="info" size={15}/>Copy to clipboard is available in the desktop app.</p>
            </>}
            {bridge&&ready&&<a className="rp-download" href={contentUrl(output!.id)} download={output!.name}><EditorIcon name="download" size={16}/>Download</a>}
            {ready&&<button className="rp-replay" onClick={()=>{if(video.current)video.current.currentTime=0;void play();}}><EditorIcon name="rotate-left" size={16}/>Play from start</button>}
          </div>
          {copied&&<p role="status" className="rp-feedback"><EditorIcon name="saved" size={15} tone="ok"/>{copied==='file'?'File copied. Paste it into any app.':'File path copied.'}</p>}
          {plan?.strategy==='copy'&&<p className="rp-hint">Lossless cut at keyframes.{ready?` Kept: ${plan.segments.map(s=>`${s.in.toFixed(3)}–${s.out.toFixed(3)} s`).join(', ')}.`:' Cut edges may include extra frames.'}</p>}
          {plan&&<details className="rp-details"><summary>Processing details</summary><p>{plan.strategy==='copy'?'Stream copy at resolved keyframes':'Exact re-encode'} · {plan.encoder}</p><p>Video: {plan.video}. Audio: {plan.audio}.</p>{typeof plan.validation==='string'&&<p>{plan.validation}</p>}</details>}
        </aside>
      </div>
      {error&&<p role="alert" className="error">{error}</p>}{playError&&<p role="alert" className="error">{playError}</p>}{fileError&&<p role="alert" className="error">{fileError}</p>}
    </dialog>,dialogHost)}
  </div>;
}
