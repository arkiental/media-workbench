import React, { useEffect, useRef, useState } from 'react';
import type { Artifact, ExportOptions, Job, Plan, Recipe } from '../../../packages/contracts/src/index';
import { bytes } from '../../../packages/ui/src/index';
import { api, contentUrl } from './api';

const terminal=new Set(['completed','failed','cancelled','interrupted']);
type Props={recipe:Recipe;options:ExportOptions;presetId?:string;jobs:Job[];artifacts:Artifact[];allowed:boolean;refresh:()=>Promise<void>;onOpen:()=>void};

export function RenderedPreview({recipe,options,presetId,jobs,artifacts,allowed,refresh,onOpen}:Props) {
  const key=JSON.stringify({recipe,options,presetId});
  const currentKey=useRef(key);currentKey.current=key;
  const [render,setRender]=useState<{key:string;jobId:string;plan:Plan}>();
  const [open,setOpen]=useState(false),[preparing,setPreparing]=useState(false),[error,setError]=useState(''),[playError,setPlayError]=useState(''),[cancelling,setCancelling]=useState(false);
  const busy=useRef(false),alive=useRef(true),dialog=useRef<HTMLDialogElement>(null),video=useRef<HTMLVideoElement>(null),autoplay=useRef(false);
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
  return <div className="rendered-preview-controls">
    <button className="preview-video-button" disabled={!allowed} onClick={()=>void start()}>Render preview</button>
    <small>Render and play the actual cuts, keyframe boundaries, effects and audio using the current export settings.</small>
    <dialog className="rendered-preview-dialog" ref={dialog} onCancel={close} onClose={()=>{autoplay.current=false;video.current?.pause();setOpen(false);}} aria-labelledby="rendered-preview-title">
      <div className="rendered-preview-heading"><h2 id="rendered-preview-title">Export preview</h2><button onClick={close}>Close preview</button></div>
      <p>This renders the full edited video. It can take as long as an export; the completed file is also available in Library.</p>
      {stale&&<p role="status" className="notice">This render belongs to an earlier edit. {working?'Cancel it or wait for it to finish before previewing the current settings.':'Close it and preview again for your current settings.'}</p>}
      {preparing&&<p role="status">Preparing export preview…</p>}
      {render&&<p>{(job?.plan||render.plan).strategy==='copy'?'Stream copy at resolved keyframes':'Exact re-encode'} · {(job?.plan||render.plan).encoder} · {(job?.plan||render.plan).duration.toFixed(3)} s</p>}
      {working&&<><p role="status">Rendering preview · {job?.state||'queued'}{job?.message?` · ${job.message}`:''}</p><progress aria-label="Preview render progress" max={1} value={Math.min(1,Math.max(0,job?.progress||0))}/><div className="actions"><button disabled={cancelling||job?.state==='cancelling'} onClick={()=>void cancel()}>Cancel preview render</button></div><small>Closing this window keeps the render in Queue.</small></>}
      {job&&['failed','cancelled','interrupted'].includes(job.state)&&<p role="alert">Preview {job.state}{job.error?`: ${job.error}`:''}. No completed preview is available.</p>}
      {output&&!stale&&open&&<><p>Validated output · {bytes(output.bytes)} · {output.media.duration.toFixed(3)} s</p><video key={output.id} ref={video} aria-label="Rendered export preview" controls preload="auto" src={contentUrl(output.id)} onCanPlay={()=>{if(autoplay.current)void play();}} onError={()=>setPlayError('This browser cannot play the rendered format. Download the actual file to inspect it in a compatible player.')}/><div className="actions"><button onClick={()=>void play()}>Play rendered video</button><a href={contentUrl(output.id)} download={output.name}>Download previewed file</a></div></>}
      {error&&<p role="alert" className="error">{error}</p>}{playError&&<p role="alert" className="error">{playError}</p>}
    </dialog>
  </div>;
}
