import React, { useEffect, useRef, useState } from 'react';
import type { Recipe } from '../../../packages/contracts/src/index';
import { api, contentUrl } from './api';
import type { WorkspaceState } from './drafts';
import {EditorIcon} from './EditorIcon';
import {CanvasText} from './CanvasText';

const stamp=(seconds:number)=>{
  const ms=Math.max(0,Math.round(seconds*1000));
  return `${Math.floor(ms/3600000).toString().padStart(2,'0')}:${Math.floor(ms/60000)%60}`.replace(/:(\d)$/,':0$1')+`:${(Math.floor(ms/1000)%60).toString().padStart(2,'0')}.${(ms%1000).toString().padStart(3,'0')}`;
};

// Editing text is local until committed; an empty intermediate value must not create a zero-length recipe.
function BoundaryInput({label,value,commit}:{label:string;value:number;commit:(value:number)=>boolean}) {
  const [text,setText]=useState(stamp(value));
  useEffect(()=>setText(stamp(value)),[value]);
  const apply=()=>{
    if(text===stamp(value))return;
    const parts=text.trim().split(':');
    const valid=/^\d+(?:\.\d+)?$/.test(text.trim())||/^\d{1,2}:[0-5]\d(?:\.\d{1,3})?$/.test(text.trim())||/^\d+:[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(text.trim());
    const seconds=parts.reduce((total,part)=>total*60+Number(part),0);
    if(!valid||!commit(seconds))setText(stamp(value));else setText(stamp(seconds));
  };
  return <input aria-label={label} title="Enter hours:minutes:seconds.milliseconds or seconds" type="text" spellCheck={false} value={text}
    onChange={e=>setText(e.target.value)} onBlur={apply}
    onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur();}if(e.key==='Escape'){e.preventDefault();setText(stamp(value));}}}/>;
}

type Props={
  viewerActions:React.ReactNode;
  tool:string;setTool:(tool:string)=>void;selectedText:number;selectText:(index:number)=>void;sourceName:string;mediaWidth:number;mediaHeight:number;frameRate?:string;
  workspace:WorkspaceState;setWorkspace:(state:WorkspaceState)=>void;inspector?:React.ReactNode;
  pauseSignal:number;sourceId:string;previewId:string;duration:number;recipe:Recipe;change:(recipe:Recipe)=>void;
  time:number;setTime:(time:number)=>void;wave:number[];thumbnails:React.ReactNode;
  canUndo:boolean;canRedo:boolean;undo:()=>void;redo:()=>void;
  run:(work:()=>Promise<unknown>)=>Promise<void>;
};

export function CutWorkspace({viewerActions,tool,setTool,selectedText,selectText,sourceName,mediaWidth,mediaHeight,frameRate,workspace,setWorkspace,inspector,pauseSignal,sourceId,previewId,duration,recipe,change,time,setTime,wave,thumbnails,canUndo,canRedo,undo,redo,run}:Props) {
  const {selected,zoom,snap}=workspace;
  const wavePeak=Math.max(.001,...wave.map(Math.abs));
  const fit=workspace.viewerFit||'fit',setFit=(value:string)=>setWorkspace({...workspace,viewerFit:value as 'fit'|'fill'});
  const setSelected=(value:number)=>setWorkspace({...workspace,selected:value});
  const setZoom=(value:number)=>setWorkspace({...workspace,zoom:value});
  const setSnap=(value:boolean)=>setWorkspace({...workspace,snap:value});
  const [muted,setMuted]=useState(false),[volume,setVolume]=useState(1);
  const [playing,setPlaying]=useState(false),[previewing,setPreviewing]=useState(false),[ready,setReady]=useState(false);
  const [inspectFrame,setInspectFrame]=useState<number>(),[error,setError]=useState(''),[message,setMessage]=useState('');
  const video=useRef<HTMLVideoElement>(null),position=useRef(time),generation=useRef(0),previewEnd=useRef<number|undefined>(undefined),expectedSeek=useRef<number|undefined>(undefined);
  const cache=useRef(new Map<number,{pts:number;keyframe:boolean}[]>());
  const active=Math.min(selected,recipe.segments.length-1),region=recipe.segments[active];
  const reportTime=(value:number)=>{position.current=value;setTime(value);};
  const setElementTime=(value:number)=>{if(video.current){expectedSeek.current=value;video.current.currentTime=value;}};
  const stopPreview=()=>{previewEnd.current=undefined;setPreviewing(false);};
  const pause=()=>{video.current?.pause();stopPreview();};
  const cursor=()=>video.current&&!video.current.paused?video.current.currentTime:position.current;

  useEffect(()=>{
    generation.current++;pause();setReady(false);setInspectFrame(undefined);setError('');
    return()=>{generation.current++;video.current?.pause();previewEnd.current=undefined;};
  },[previewId]);
  useEffect(()=>{pause();setSelected(active);},[recipe.segments]);
  useEffect(()=>{generation.current++;pause();},[pauseSignal]);

  // Check every displayed browser frame, rather than waiting for the coarse timeupdate event.
  useEffect(()=>{
    if(!playing)return;
    let frame=0;
    const tick=()=>{
      const element=video.current;
      if(element&&previewEnd.current!==undefined&&element.currentTime>=previewEnd.current){
        const end=previewEnd.current;element.pause();setElementTime(end);reportTime(end);stopPreview();return;
      }
      frame=requestAnimationFrame(tick);
    };
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[playing]);

  const index=async(around:number)=>{
    const key=Math.floor(around);
    if(!cache.current.has(key))cache.current.set(key,await api.frames(sourceId,around));
    return cache.current.get(key)!;
  };
  const seek=async(value:number,exact=false)=>{
    const request=++generation.current;pause();
    let target=Math.max(0,Math.min(duration,value));
    if(snap&&!exact){const frames=await index(target);if(frames.length)target=frames.reduce((a,b)=>Math.abs(b.pts-target)<Math.abs(a.pts-target)?b:a,frames[0]).pts;}
    if(request!==generation.current)return;
    target=Math.max(0,Math.min(duration,target));
    setElementTime(target);
    reportTime(target);setInspectFrame(exact?target:undefined);
  };
  const step=async(direction:number,keyframe=false)=>{
    const at=cursor(),request=++generation.current;pause();
    const frames=(await index(at)).filter(f=>!keyframe||f.keyframe).sort((a,b)=>a.pts-b.pts);
    if(request!==generation.current)return;
    const frame=direction>0?frames.find(f=>f.pts>at+1e-7):frames.findLast(f=>f.pts<at-1e-7);
    if(!frame)throw new Error(`No ${keyframe?'keyframe':'frame'} found in this indexed window. Seek to another position.`);
    await seek(frame.pts,true);
  };
  const setBoundary=(edge:'in'|'out',value:number)=>{
    const next={...region,[edge]:value};
    if(!Number.isFinite(value)||next.in<0||next.out>duration||next.in>=next.out){
      setError('Start must be before end, and both must be inside the source duration.');return false;
    }
    if(region[edge]===value)return true;
    generation.current++;pause();setError('');
    change({...recipe,segments:recipe.segments.map((s,i)=>i===active?next:s)});
    setMessage(`Region ${active+1}: ${edge==='in'?'start':'end'} set to ${stamp(value)}`);return true;
  };
  const mark=(edge:'in'|'out')=>{const at=cursor();pause();reportTime(at);setBoundary(edge,at);};
  const select=(index:number)=>{generation.current++;pause();setSelected(index);setError('');setMessage(`Region ${index+1} selected. Playhead unchanged.`);};
  const add=()=>{
    const at=cursor();
    if(at>=duration){setError('Move the playhead before the end of the source to add a region.');return;}
    generation.current++;pause();reportTime(at);setSelected(recipe.segments.length);setError('');
    change({...recipe,segments:[...recipe.segments,{in:at,out:duration}]});
    setMessage('New region starts at the playhead and ends at the source end. Use Set end to shorten it.');
  };
  const remove=()=>{
    if(recipe.segments.length===1)return;
    generation.current++;pause();setSelected(Math.max(0,active-1));
    change({...recipe,segments:recipe.segments.filter((_,i)=>i!==active)});
    setMessage(`Region ${active+1} removed from the recipe. Source media retained.`);
  };
  const togglePlay=async()=>{
    const element=video.current;if(!element||!ready)return;
    generation.current++;stopPreview();setInspectFrame(undefined);
    if(element.paused){try{await element.play();}catch(e){if(!(e instanceof DOMException&&e.name==='AbortError'&&element.paused))throw e;}}else element.pause();
  };
  const playRegion=async()=>{
    const element=video.current;if(!element||!ready)return;
    generation.current++;pause();setInspectFrame(undefined);
    setElementTime(region.in);reportTime(region.in);previewEnd.current=region.out;setPreviewing(true);
    try{await element.play();}catch(e){stopPreview();if(!(e instanceof DOMException&&e.name==='AbortError'&&element.paused))throw e;}
  };
  const history=(action:()=>void)=>{generation.current++;pause();setError('');action();};
  const split=()=>{
    const at=cursor();if(at<=region.in||at>=region.out)return;
    generation.current++;pause();reportTime(at);setError('');
    change({...recipe,segments:recipe.segments.flatMap((s,i)=>i===active?[{...s,out:at},{...s,in:at}]:[s])});
    setMessage(`Region ${active+1} split at ${stamp(at)}.`);
  };
  return <div className={`cut-workspace tool-${tool.toLowerCase()}`} onKeyDown={e=>{
    const target=e.target as HTMLElement;
    if((e.ctrlKey||e.metaKey)&&!target.closest('input,textarea,select,[contenteditable="true"]')){
      if(e.key.toLowerCase()==='z'){e.preventDefault();if(e.shiftKey?canRedo:canUndo)history(e.shiftKey?redo:undo);}
      if(e.key.toLowerCase()==='y'){e.preventDefault();if(canRedo)history(redo);}
    }
    if(e.ctrlKey||e.metaKey||e.altKey||target.closest('input,textarea,select,[contenteditable="true"]'))return;
    if(e.key.toLowerCase()==='i'){e.preventDefault();mark('in');}
    if(e.key.toLowerCase()==='o'){e.preventDefault();mark('out');}
    if(e.code==='Space'&&!target.closest('button')){e.preventDefault();void run(togglePlay);}
  }}>
    <div className="cut-layout">
      <nav className="editor-tool-rail" aria-label="Editing tools">
        {[['Source','Media','media'],['Text','Text','text'],['Audio','Audio','audio'],['Transform','Transform','transform']].map(([value,label,icon])=><button key={value} title={label} aria-pressed={tool===value} onClick={()=>setTool(value)}><EditorIcon name={icon}/><span>{label}</span></button>)}
        <details className="more-editor-tools"><summary aria-label="More editing tools"><EditorIcon name="more"/></summary><button onClick={()=>setTool('Cut')} aria-pressed={tool==='Cut'}><EditorIcon name="cut"/>Cut</button><button onClick={()=>setTool('Project')}>Project</button></details>
      </nav>
      <div className="cut-player"><div className="source-heading"><h1 aria-label={`Editor · ${sourceName}`}>{sourceName}</h1><span>{mediaWidth} × {mediaHeight} · {frameRate?Math.round(frameRate.split('/').reduce((a,n,i)=>i?a/Number(n):Number(n),0)*100)/100:24} fps · {stamp(duration)}{(recipe.crop||recipe.rotate||recipe.resize)&&<span className="source-preview-label"> · Source preview — render to review transforms</span>}</span></div>
        <div className="cut-preview" onClick={()=>setTool('Transform')}>
          <video style={{objectFit:fit==='fill'?'cover':'contain'}} ref={video} muted={muted} src={contentUrl(previewId)} preload="metadata" aria-label="Source playback"
            onLoadedMetadata={()=>{setElementTime(Math.max(0,Math.min(duration,position.current)));setReady(true);}}
            onLoadedData={()=>setError('')}
            onPlay={()=>{generation.current++;setPlaying(true);setInspectFrame(undefined);}}
            onPause={e=>{if(e.currentTarget.paused){setPlaying(false);stopPreview();}}} onEnded={()=>{setPlaying(false);stopPreview();}}
            onSeeking={e=>{if(expectedSeek.current===undefined||Math.abs(e.currentTarget.currentTime-expectedSeek.current)>1e-5){generation.current++;stopPreview();setInspectFrame(undefined);}}}
            onSeeked={e=>{expectedSeek.current=undefined;reportTime(e.currentTarget.currentTime);}}
            onTimeUpdate={e=>{if(e.currentTarget.readyState>=1&&!e.currentTarget.seeking)reportTime(e.currentTarget.currentTime);}}
            onError={()=>{setReady(false);setPlaying(false);stopPreview();setError('This browser could not decode the preview. Generate and select a playback proxy below.');}}/>
          {inspectFrame!==undefined&&<img className="cut-frame" src={`/api/v1/sources/${sourceId}/frame?pts=${inspectFrame}`} alt={`Source decoded frame at ${inspectFrame.toFixed(6)} seconds`}/>}
          <CanvasText recipe={recipe} time={time} selected={selectedText} active={tool==='Text'} select={selectText} change={change} width={mediaWidth} height={mediaHeight} fit={fit}/>
        </div>
        {inspectFrame!==undefined&&<small>Decoded original frame · {inspectFrame.toFixed(6)} s</small>}
        <div className="cut-transport">
          <div className="transport-time"><output aria-label="Current source time">{stamp(time)}</output><span> / {stamp(duration)}</span></div>
          <div className="transport-buttons"><button title="Previous frame" aria-label="Previous frame" onClick={()=>void run(()=>step(-1))}><EditorIcon name="previous"/></button><button className="transport-play" title={playing?'Pause':'Play'} aria-label={playing?'Pause':'Play'} disabled={!ready} onClick={()=>void run(togglePlay)}><EditorIcon name={playing?'pause':'play'}/></button><button title="Next frame" aria-label="Next frame" onClick={()=>void run(()=>step(1))}><EditorIcon name="next"/></button></div>
          <div className="transport-view"><select aria-label="Viewer fit" value={fit} onChange={e=>setFit(e.target.value)}><option value="fit">Fit</option><option value="fill">Fill</option></select><button title="Fullscreen" aria-label="Fullscreen" onClick={()=>void run(async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await video.current?.closest('.cut-player')?.requestFullscreen();})}><EditorIcon name="fullscreen"/></button></div>
        </div>
        <details className="cut-precision"><summary>Frame inspection and playback</summary>{viewerActions}<button aria-pressed={muted} onClick={()=>setMuted(!muted)}>{muted?'Unmute':'Mute'}</button><label className="playback-volume">Playback volume<input aria-label="Playback volume" type="range" min={0} max={1} step={.05} value={volume} onChange={e=>{const value=Number(e.target.value);setVolume(value);if(video.current)video.current.volume=value;}}/></label><div className="actions"><button onClick={()=>void run(()=>step(-1,true))}>Previous keyframe</button><button onClick={()=>void run(()=>step(1,true))}>Next keyframe</button><button onClick={()=>void run(()=>seek(cursor(),true))}>Inspect source frame</button></div></details>
      </div>
      {inspector||<aside className="region-sidebar" aria-label="Kept regions">
        <div className="region-heading"><h3>Keep regions</h3><span>{recipe.segments.length}</span></div>
        <p className="muted">Exported in the order shown.</p>
        <div className="region-list">{recipe.segments.map((s,i)=><button key={i} className="region-choice" aria-label={`Select region ${i+1}`} aria-pressed={active===i} onClick={()=>select(i)}><strong>Region {i+1}</strong><span>{stamp(s.in)} → {stamp(s.out)}</span><small>{(s.out-s.in).toFixed(3)} s{active===i?' · editing':''}</small></button>)}</div>
        <div className="actions"><button disabled={time>=duration} onClick={add}>+ New region</button><button disabled={recipe.segments.length===1} onClick={remove}>Remove region</button></div>
        <small>Total kept: {recipe.segments.reduce((n,s)=>n+s.out-s.in,0).toFixed(3)} s</small>
      </aside>}
    </div>
    <div className="compact-timeline-toolbar" role="group" aria-label="Timeline controls">
      <div className="timeline-tool-group history-tools">
        <button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={()=>history(undo)}><EditorIcon name="undo"/><span>Undo</span></button>
        <button aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={()=>history(redo)}><EditorIcon name="redo"/><span>Redo</span></button>
      </div>
      <div className="timeline-tool-group">
        <button title="Split selected region at playhead" disabled={time<=region.in||time>=region.out} onClick={split}><EditorIcon name="cut"/><span>Split</span></button>
        <button className="snap-toggle" title="Snap to indexed frame timestamps" aria-pressed={snap} onClick={()=>setSnap(!snap)}><EditorIcon name="snap"/><span>Snap</span><i aria-hidden="true"/></button>
      </div>
      <div className="timeline-tool-group region-edit" aria-label={`Editing region ${active+1}`}>
        <div className="compact-boundary"><span>In</span><BoundaryInput key={`in-${active}`} label={`Region ${active+1} in timecode`} value={region.in} commit={value=>setBoundary('in',value)}/><button className="mark-button" aria-label="Set start I" title="Set start at playhead (I)" aria-keyshortcuts="I" onClick={()=>mark('in')}><kbd>I</kbd></button></div>
        <div className="compact-boundary"><span>Out</span><BoundaryInput key={`out-${active}`} label={`Region ${active+1} out timecode`} value={region.out} commit={value=>setBoundary('out',value)}/><button className="mark-button" aria-label="Set end O" title="Set end at playhead (O)" aria-keyshortcuts="O" onClick={()=>mark('out')}><kbd>O</kbd></button></div>
      </div>
      <div className="timeline-tool-group region-play-tools"><button className="region-play" aria-label={previewing?'Stop source region':'Play source region'} disabled={!ready} onClick={()=>void run(previewing?async()=>pause():playRegion)}><EditorIcon name={previewing?'pause':'play'}/><span>{previewing?'Stop region':'Play region'}</span></button>
        <details className="timeline-more"><summary aria-label="More timeline actions" title="More timeline actions"><EditorIcon name="more"/></summary><div><button onClick={()=>void run(()=>seek(region.in))}>Go to start</button><button onClick={()=>void run(()=>seek(region.out))}>Go to end</button><label>Playhead (s)<input aria-label="Playhead (s)" type="number" min={0} max={duration} step="any" value={time} onChange={e=>void run(()=>seek(Number(e.target.value)))}/></label></div></details>
      </div>
      <div className="timeline-tool-group timeline-zoom"><span>Zoom</span><button aria-label="Zoom out" disabled={zoom<=1} onClick={()=>setZoom(Math.max(1,zoom-1))}>−</button><input aria-label="Timeline zoom" type="range" min={1} max={20} step={1} value={zoom} onChange={e=>setZoom(Number(e.target.value))}/><button aria-label="Zoom in" disabled={zoom>=20} onClick={()=>setZoom(Math.min(20,zoom+1))}>+</button><button title="Fit timeline to width" onClick={()=>setZoom(1)}>Fit</button></div>
    </div>
    <div className="context-timeline" aria-label="Editing timeline">
      <div className="track-labels"><div className="track-ruler-label"><button aria-label="Timeline controls" title="Timeline controls" onClick={()=>setTool('Cut')}><EditorIcon name="more"/></button></div><button onClick={()=>{setTool('Text');if(recipe.text.length)selectText(selectedText)}}><EditorIcon name="text"/><span>Text</span></button><button onClick={()=>setTool('Transform')}><EditorIcon name="video"/><span>Video</span></button><button onClick={()=>setTool('Audio')}><EditorIcon name="audio"/><span>Audio</span></button></div>
      <div className="timeline-scroll"><div className="timeline" style={{width:`${zoom*100}%`}}>
        <div className="timeline-ruler" onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();void run(()=>seek((e.clientX-rect.left)/rect.width*duration));}}>{Array.from({length:Math.min(8,Math.max(2,Math.ceil(duration/2)))},(_,i)=>{const interval=duration>16?duration/7:2;const at=i*interval;return <span key={i} style={{left:`${at/duration*100}%`}}>{stamp(at).slice(0,8)}</span>})}</div>
        <div className="timeline-media">
          <div className="text-track">{recipe.text.map((c,i)=><button key={i} className="text-clip" aria-label={`Select timeline text ${i+1}`} aria-pressed={tool==='Text'&&i===selectedText} style={{left:`${c.in/duration*100}%`,width:`${(c.out-c.in)/duration*100}%`}} onClick={()=>{selectText(i);if(time<c.in||time>=c.out)void run(()=>seek(c.in,true));}}><span>T</span>{c.text||'Untitled text'}</button>)}{!recipe.text.length&&<button className="empty-text-track" onClick={()=>setTool('Text')}>+ Add a title</button>}</div>
          <div className="video-track" onClick={()=>setTool('Transform')}>{thumbnails}{tool==='Cut'&&<div className="region-tracks" onClick={e=>e.stopPropagation()}>{recipe.segments.map((s,i)=><div className="region-lane" key={i}><button className="timeline-region" aria-label={`Select timeline region ${i+1}`} aria-pressed={active===i} style={{left:`${s.in/duration*100}%`,width:`${(s.out-s.in)/duration*100}%`}} onClick={()=>select(i)}>{i+1}</button></div>)}</div>}</div>
          <div className="audio-track" onClick={()=>setTool('Audio')}>{wave.length>0?<svg className="waveform" viewBox={`0 0 ${wave.length} 100`} preserveAspectRatio="none" aria-label="Audio waveform">{wave.map((v,i)=><line key={i} x1={i} x2={i} y1={50-Math.min(1,Math.abs(v)/wavePeak)*40} y2={50+Math.min(1,Math.abs(v)/wavePeak)*40}/>)}</svg>:<span className="waveform-empty">Original audio</span>}</div>
          <div className="timeline-cursor" style={{left:`${time/duration*100}%`}} aria-hidden="true"/>
        </div>
        <input className="scrubber" aria-label="Timeline playhead" type="range" min={0} max={duration} step={.001} value={time} onChange={e=>void run(()=>seek(Number(e.target.value)))}/>
      </div></div>
    </div>
    <div className="compact-timeline-status"><span>Region {active+1} <b>·</b> {(region.out-region.in).toFixed(3)} s</span><span role="status">{message}</span><span>{stamp(region.in)} – {stamp(region.out)}</span></div>
    {error&&<p role="alert" className="error">{error}</p>}
  </div>;
}
