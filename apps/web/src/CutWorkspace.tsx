import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Recipe } from '../../../packages/contracts/src/index';
import { api, contentUrl } from './api';
import { loadSourceFrame } from './source-frame';
import type { WorkspaceState } from './drafts';
import {EditorIcon,type IconTone} from './EditorIcon';
import {compactEditorQuery} from './compact-editor';
import {useTimelineGestures} from './useTimelineGestures';

const tools:[string,string,IconTone][]=[['Text','text','text'],['Overlay','image','overlay'],['Audio','audio','audio'],['Transform','transform','video'],['Cut','cut','cut']];
const toolTone=(tool:string)=>tools.find(([value])=>value===tool)?.[2]||'cut';
const toolIcon=(tool:string)=>tools.find(([value])=>value===tool)?.[1]||'cut';
import {TransformViewport, ViewportTransformControls} from './TransformViewport';
import {OverlayLayer} from './OverlayLayer';
import {OverlayTrack} from './OverlayTrack';

const stamp=(seconds:number)=>{
  const ms=Math.max(0,Math.round(seconds*1000));
  return `${Math.floor(ms/3600000).toString().padStart(2,'0')}:${Math.floor(ms/60000)%60}`.replace(/:(\d)$/,':0$1')+`:${(Math.floor(ms/1000)%60).toString().padStart(2,'0')}.${(ms%1000).toString().padStart(3,'0')}`;
};

// Editing text is local until committed; an empty intermediate value must not create a zero-length recipe.
function BoundaryInput({label,value,commit,seconds=false}:{label:string;value:number;commit:(value:number)=>boolean;seconds?:boolean}) {
  const format=(value:number)=>seconds?value.toFixed(3):stamp(value);
  const [text,setText]=useState(format(value));
  const editing=useRef(false),dirty=useRef(false);
  useEffect(()=>{if(!editing.current)setText(format(value));},[value,seconds]);
  const apply=()=>{
    editing.current=false;
    if(!dirty.current){setText(format(value));return;}
    dirty.current=false;
    if(text===format(value))return;
    const parts=text.trim().split(':');
    const valid=/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text.trim())||/^\d{1,2}:[0-5]\d(?:\.\d{1,3})?$/.test(text.trim())||/^\d+:[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(text.trim());
    const seconds=parts.reduce((total,part)=>total*60+Number(part),0);
    if(!valid||!commit(seconds))setText(format(value));else setText(format(seconds));
  };
  return <input aria-label={label} title="Enter hours:minutes:seconds.milliseconds or seconds" type="text" inputMode="decimal" spellCheck={false} value={text}
    onFocus={()=>{editing.current=true;dirty.current=false;}} onChange={e=>{dirty.current=true;setText(e.target.value);}} onBlur={apply}
    onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();dirty.current=false;setText(format(value));}}}/>;
  }
type Props={
  viewerActions:React.ReactNode;
  exportSummary:React.ReactNode;
  tool:string;setTool:(tool:string)=>void;playbackOptions:React.ReactNode;sourceName:string;mediaWidth:number;mediaHeight:number;mediaRotation?:number;frameRate?:string;
  workspace:WorkspaceState;setWorkspace:(state:WorkspaceState)=>void;inspector?:React.ReactNode;
  pauseSignal:number;sourceId:string;previewId:string;duration:number;recipe:Recipe;change:(recipe:Recipe)=>void;
  time:number;setTime:(time:number)=>void;wave:number[];waveLoading?:boolean;hasAudio?:boolean;thumbnails:React.ReactNode;
  canUndo:boolean;canRedo:boolean;undo:()=>void;redo:()=>void;
  run:(work:()=>Promise<unknown>)=>Promise<void>;
};

export function CutWorkspace({viewerActions,exportSummary,tool,setTool,playbackOptions,sourceName,mediaWidth,mediaHeight,mediaRotation=0,frameRate,workspace,setWorkspace,inspector,pauseSignal,sourceId,previewId,duration,recipe,change,time,setTime,wave,waveLoading=false,hasAudio=true,thumbnails,canUndo,canRedo,undo,redo,run}:Props) {
  const {selected,zoom,snap}=workspace;
  const sourceEnd=Math.max(0,duration-.001);
  const canAddSection=(at:number)=>at<sourceEnd-1e-6;
  const wavePeak=Math.max(.001,...wave.map(Math.abs));
  const fit=workspace.viewerFit||'fit',setFit=(value:string)=>setWorkspace({...workspace,viewerFit:value as 'fit'|'fill'});
  const setSelected=(value:number)=>setWorkspace({...workspace,selected:value});
  const timelineScroll=useRef<HTMLDivElement>(null);
  const zoomAnchor=useRef<{fraction:number;offset:number}|undefined>(undefined);
  const timelineInitialized=useRef(false);
  const [timelineWindow,setTimelineWindow]=useState({start:0,end:1,width:0});
  const [mobile,setMobile]=useState(()=>window.matchMedia(compactEditorQuery).matches);
  const [timelineOptions,setTimelineOptions]=useState(false);
  const timelineWindowFrame=useRef(0),followSuspendedUntil=useRef(0);
  const updateTimelineWindow=()=>{
    if(!window.matchMedia(compactEditorQuery).matches||timelineWindowFrame.current)return;
    timelineWindowFrame.current=requestAnimationFrame(()=>{
      timelineWindowFrame.current=0;
      const el=timelineScroll.current;if(!el)return;
      const next={start:el.scrollLeft/el.scrollWidth,end:(el.scrollLeft+el.clientWidth)/el.scrollWidth,width:el.clientWidth};
      setTimelineWindow(previous=>previous.start===next.start&&previous.end===next.end&&previous.width===next.width?previous:next);
    });
  };
  const centerPlayhead=(at=time)=>{
    const el=timelineScroll.current;if(!el)return;
    el.scrollLeft=at/duration*el.scrollWidth-el.clientWidth/2;updateTimelineWindow();
  };
  const setZoom=(value:number)=>{
    const el=timelineScroll.current;
    if(el){
      const playhead=time/duration*el.scrollWidth-el.scrollLeft;
      const offset=playhead>=0&&playhead<=el.clientWidth?playhead:el.clientWidth/2;
      zoomAnchor.current={fraction:(el.scrollLeft+offset)/el.scrollWidth,offset};
    }
    setWorkspace({...workspace,zoom:Math.max(1,Math.min(20,value))});
  };
  const timelineGestures=useTimelineGestures({enabled:mobile,scroll:timelineScroll,zoom,onNavigate:()=>{followSuspendedUntil.current=performance.now()+1500;},onZoom:(value,anchor)=>{zoomAnchor.current=anchor;setWorkspace({...workspace,zoom:value});}});
  useLayoutEffect(()=>{
    const el=timelineScroll.current,anchor=zoomAnchor.current;
    if(el&&anchor){el.scrollLeft=zoom===1?0:anchor.fraction*el.scrollWidth-anchor.offset;zoomAnchor.current=undefined;}
    else if(el&&!timelineInitialized.current&&mobile)centerPlayhead();
    timelineInitialized.current=true;
    updateTimelineWindow();
  },[zoom]);
  useEffect(()=>{
    const query=window.matchMedia(compactEditorQuery);
    const resize=()=>{setMobile(query.matches);setPanelOpen(!query.matches);setTimelineOptions(false);};
    query.addEventListener('change',resize);
    const observer=new ResizeObserver(updateTimelineWindow);if(timelineScroll.current)observer.observe(timelineScroll.current);
    return()=>{query.removeEventListener('change',resize);observer.disconnect();cancelAnimationFrame(timelineWindowFrame.current);};
  },[]);
  const setSnap=(value:boolean)=>setWorkspace({...workspace,snap:value});
  const selectedOverlay=workspace.selectedOverlay!==undefined&&workspace.selectedOverlay<recipe.overlays.length?workspace.selectedOverlay:undefined;
  const selectOverlay=(index:number)=>{setWorkspace({...workspace,selectedOverlay:index,tool:'Overlay'});setPanelOpen(true);};
  const updateOverlay=(index:number,patch:Partial<Recipe['overlays'][number]>)=>change({...recipe,overlays:recipe.overlays.map((o,i)=>i===index?{...o,...patch}:o)});
  const [muted,setMuted]=useState(false),[volume,setVolume]=useState(1),[skipRemoved,setSkipRemoved]=useState(true),[helpOpen,setHelpOpen]=useState(false);
  const [playing,setPlaying]=useState(false),[previewing,setPreviewing]=useState(false),[ready,setReady]=useState(false);
  const [inspectFrame,setInspectFrame]=useState<number>(),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [frameAttempt,setFrameAttempt]=useState(0),[frameImage,setFrameImage]=useState<{key:string;phase:'loading'|'ready'|'error';url?:string;message?:string}>();
  const frameKey=inspectFrame===undefined?undefined:`${sourceId}:${previewId}:${inspectFrame}`;
  const currentFrame=frameImage?.key===frameKey?frameImage:undefined;
  useEffect(()=>{
    if(inspectFrame===undefined){setFrameImage(undefined);return;}
    const controller=new AbortController(),key=`${sourceId}:${previewId}:${inspectFrame}`;
    let url:string|undefined;
    setFrameImage({key,phase:'loading',message:'Loading source frame…'});
    void loadSourceFrame(sourceId,inspectFrame,{signal:controller.signal,onRetry:()=>{
      if(!controller.signal.aborted)setFrameImage({key,phase:'loading',message:'Preview is busy. Trying again…'});
    }}).then(image=>{
      if(controller.signal.aborted)return;
      url=URL.createObjectURL(image);
      setFrameImage({key,phase:'loading',url,message:'Loading source frame…'});
    }).catch(error=>{if(!controller.signal.aborted)setFrameImage({key,phase:'error',message:error instanceof Error?error.message:'Could not load this source frame. Try again.'});});
    return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[sourceId,previewId,inspectFrame,frameAttempt]);
  const [panelOpen,setPanelOpen]=useState(()=>!window.matchMedia(compactEditorQuery).matches),[trimDrag,setTrimDrag]=useState<{index:number;edge:'in'|'out';value:number}>();
  const [cropView,setCropView]=useState(true);
  const editingCrop=tool==='Transform'&&!!recipe.crop&&cropView&&(!mobile||panelOpen);
  useEffect(()=>{if(recipe.crop)setCropView(true);},[!!recipe.crop]);
  useEffect(()=>{if(recipe.resize)setCropView(false);},[recipe.resize]);
  const toolRail=useRef<HTMLElement>(null),contextPanel=useRef<HTMLDivElement>(null);
  const openTool=(value:string)=>{setTool(value);setPanelOpen(true);setTimelineOptions(false);};

  const video=useRef<HTMLVideoElement>(null),position=useRef(time),generation=useRef(0),previewEnd=useRef<number|undefined>(undefined),expectedSeek=useRef<number|undefined>(undefined);
  const activateRailTool=(value:string)=>{
    openTool(value);
  };
  const closePanel=()=>{
    setPanelOpen(false);
    const selected=Array.from(toolRail.current?.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')||[]).find(button=>button.offsetWidth>0&&button.offsetHeight>0);
    const focusTarget=selected||toolRail.current?.querySelector<HTMLElement>('.more-editor-tools>summary');
    focusTarget?.focus({preventScroll:true});
  };
  useEffect(()=>{
    if(mobile&&panelOpen)contextPanel.current?.scrollTo(0,0);
  },[mobile,panelOpen,tool]);
  useEffect(()=>{
    if(!mobile||!playing||performance.now()<followSuspendedUntil.current)return;
    const el=timelineScroll.current;if(!el)return;
    const x=time/duration*el.scrollWidth;
    if(x<el.scrollLeft||x>el.scrollLeft+el.clientWidth-12)centerPlayhead();
  },[time,playing,mobile]);
  const cache=useRef(new Map<number,{pts:number;keyframe:boolean}[]>());
  const active=Math.min(selected,recipe.segments.length-1),region=recipe.segments[active];
  const displayedRegion=trimDrag?.index===active?{...region,[trimDrag.edge]:trimDrag.value}:region;
  const reportTime=(value:number)=>{position.current=value;setTime(value);};
  const setElementTime=(value:number)=>{if(video.current){expectedSeek.current=value;video.current.currentTime=value;}};
  const stopPreview=()=>{previewEnd.current=undefined;setPreviewing(false);};
  const shuttle=useRef<{dir:number;speed:number;raf:number}>({dir:0,speed:1,raf:0});
  const stopShuttle=()=>{cancelAnimationFrame(shuttle.current.raf);shuttle.current={dir:0,speed:1,raf:0};if(video.current)video.current.playbackRate=1;};
  const pause=()=>{stopShuttle();video.current?.pause();stopPreview();};
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
      if(element){
        if(previewEnd.current===undefined&&skipRemoved&&!element.seeking){
          const at=element.currentTime;
          if(!recipe.segments.some(segment=>at>=segment.in-1e-3&&at<segment.out)){
            const next=recipe.segments.filter(segment=>segment.in>at).reduce<number|undefined>((best,segment)=>best===undefined||segment.in<best?segment.in:best,undefined);
            if(next===undefined){const end=Math.max(...recipe.segments.map(segment=>segment.out));element.pause();setElementTime(end);reportTime(end);return;}
            setElementTime(next);reportTime(next);
          }
        }
        applyGain(element.currentTime);
      }
      frame=requestAnimationFrame(tick);
    };
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[playing,skipRemoved,recipe.segments,recipe.audio,muted,volume]);

  const ctrlHeld=useRef(false);
  useEffect(()=>{
    const sync=(e:KeyboardEvent|PointerEvent)=>{ctrlHeld.current=e.ctrlKey||e.metaKey;};
    window.addEventListener('keydown',sync);window.addEventListener('keyup',sync);window.addEventListener('pointermove',sync);window.addEventListener('blur',()=>{ctrlHeld.current=false;});
    return()=>{window.removeEventListener('keydown',sync);window.removeEventListener('keyup',sync);window.removeEventListener('pointermove',sync);};
  },[]);

  const index=async(around:number)=>{
    const key=Math.floor(around);
    if(!cache.current.has(key))cache.current.set(key,await api.frames(sourceId,around));
    return cache.current.get(key)!;
  };
  const seek=async(value:number,exact=false)=>{
    const request=++generation.current;pause();
    let target=Math.max(0,Math.min(duration,value));
    // Show the user's seek immediately; indexed snapping can refine it when ready.
    setElementTime(target);reportTime(target);setInspectFrame(exact?target:undefined);
    // Scrubbing must not enqueue a server decode for every pointer event. The
    // browser seeks directly; explicit keyframe/inspection actions still use the index.
    if(snap&&!exact){const [n,d]=(frameRate||'30/1').split('/').map(Number),fps=n/(d||1);if(Number.isFinite(fps)&&fps>0)target=Math.round(target*fps)/fps;}
    if(request!==generation.current)return;
    target=Math.max(0,Math.min(sourceEnd,target));
    setElementTime(target);
    reportTime(target);setInspectFrame(exact?target:undefined);
  };
  // Local pointer feedback must not toggle the app-wide busy state on every move.
  const scrub=(at:number)=>{void seek(at).catch(error=>setError(error instanceof Error?error.message:'Could not seek the preview.'));};
  const scrubCleanup=useRef<(()=>void)|undefined>(undefined);
  useEffect(()=>()=>scrubCleanup.current?.(),[]);
  const beginScrub=(event:React.PointerEvent<HTMLElement>,overview=false)=>{
    if(!mobile||event.button!==0)return;
    event.preventDefault();event.stopPropagation();scrubCleanup.current?.();
    const target=event.currentTarget,rect=target.getBoundingClientRect(),id=event.pointerId;
    let frame=0,pending=0;
    const apply=()=>{frame=0;scrub(pending);if(overview)centerPlayhead(pending);};
    const position=(x:number)=>{pending=Math.max(0,Math.min(duration,(x-rect.left)/rect.width*duration));if(!frame)frame=requestAnimationFrame(apply);};
    target.setPointerCapture(id);position(event.clientX);
    const move=(pointer:PointerEvent)=>{if(pointer.pointerId===id)position(pointer.clientX);};
    const cleanup=()=>{cancelAnimationFrame(frame);target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',up);target.removeEventListener('pointercancel',cancel);target.removeEventListener('lostpointercapture',cancel);if(target.hasPointerCapture(id))target.releasePointerCapture(id);scrubCleanup.current=undefined;};
    const up=(pointer:PointerEvent)=>{if(pointer.pointerId!==id)return;position(pointer.clientX);cleanup();apply();};
    const cancel=(pointer:PointerEvent)=>{if(pointer.pointerId===id)cleanup();};
    scrubCleanup.current=cleanup;target.addEventListener('pointermove',move);target.addEventListener('pointerup',up);target.addEventListener('pointercancel',cancel);target.addEventListener('lostpointercapture',cancel);
  };
  // Preview audio: apply the recipe's volume, fades and removal through Web Audio so the preview matches the export.
  const audioGraph=useRef<{ctx:AudioContext;gain:GainNode}|undefined>(undefined);
  const ensureAudio=()=>{
    const element=video.current;if(!element||audioGraph.current)return;
    try{const ctx=new AudioContext(),source=ctx.createMediaElementSource(element),gain=ctx.createGain();source.connect(gain).connect(ctx.destination);audioGraph.current={ctx,gain};}catch{/* Falls back to the element volume. */}
    void audioGraph.current?.ctx.resume();
  };
  const audioGain=(at:number)=>{
    const {mode,volume:level,fadeIn,fadeOut}=recipe.audio;
    if(mode==='mute'||mode==='replace')return 0;
    let out=0,total=0,hit=-1;
    recipe.segments.forEach((segment,i)=>{if(hit<0&&at>=segment.in&&at<=segment.out){hit=i;out=total+at-segment.in;}total+=segment.out-segment.in;});
    if(hit<0)return level;
    const fadeUp=fadeIn>0?Math.min(1,out/fadeIn):1,fadeDown=fadeOut>0?Math.min(1,(total-out)/fadeOut):1;
    return level*fadeUp*fadeDown;
  };
  const applyGain=(at?:number)=>{
    const element=video.current;if(!element)return;
    const level=muted?0:volume*audioGain(at??element.currentTime);
    if(audioGraph.current){audioGraph.current.gain.gain.value=level;element.volume=1;}else element.volume=Math.max(0,Math.min(1,level));
  };
  useEffect(()=>{applyGain();},[muted,volume,recipe.audio,recipe.segments,time]);
  const frameAnchor=useRef<number|undefined>(undefined),pendingStep=useRef<number|undefined>(undefined);
  useEffect(()=>{
    const element=video.current;if(!ready||!element||!('requestVideoFrameCallback' in element))return;
    let id=0;const onFrame=(_now:number,meta:{mediaTime:number})=>{frameAnchor.current=meta.mediaTime;id=element.requestVideoFrameCallback(onFrame);};
    id=element.requestVideoFrameCallback(onFrame);return()=>element.cancelVideoFrameCallback(id);
  },[ready,previewId]);

  // Frame stepping is computed from the stream frame rate and applied straight to the video element, so it is instant and works at any position.
  const stepFrames=(count:number)=>{
    const element=video.current;if(!element||!ready)return;
    const [n,d]=(frameRate||'30/1').split('/').map(Number),fps=n/(d||1),dt=fps>0&&Number.isFinite(fps)?1/fps:1/30;
    generation.current++;pause();setInspectFrame(undefined);
    // Anchor on the frame the browser actually presented so offsets and variable frame rates do not drift.
    const base=element.seeking&&pendingStep.current!==undefined?pendingStep.current-dt*.25:frameAnchor.current!==undefined&&Math.abs(frameAnchor.current-element.currentTime)<dt*1.5?frameAnchor.current:element.currentTime;
    const frameTime=Math.max(0,Math.min(Math.max(0,duration-dt),base+count*dt));
    pendingStep.current=frameTime+dt*.25;
    setElementTime(Math.min(duration,frameTime+dt*.25));reportTime(frameTime);
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
    setElementTime(value);reportTime(value);setMessage('');return true;
  };
  const mark=(edge:'in'|'out')=>{const at=cursor();pause();reportTime(at);setBoundary(edge,at);};
  const select=(index:number)=>{generation.current++;pause();setSelected(index);setElementTime(recipe.segments[index].in);reportTime(recipe.segments[index].in);setError('');setMessage('');};
  const add=()=>{
    const at=cursor();
    if(!canAddSection(at)){setError('Move the playhead before the end of the source to add a region.');return;}
    generation.current++;pause();reportTime(at);setSelected(recipe.segments.length);setError('');
    change({...recipe,segments:[...recipe.segments,{in:at,out:duration}]});
    setMessage('Section added.');
  };
  const remove=()=>{
    if(recipe.segments.length===1)return;
    generation.current++;pause();setSelected(Math.max(0,active-1));
    change({...recipe,segments:recipe.segments.filter((_,i)=>i!==active)});
    setMessage('Section removed.');
  };
  const togglePlay=async()=>{
    const element=video.current;if(!element||!ready)return;
    generation.current++;stopPreview();setInspectFrame(undefined);
    if(element.paused){
      ensureAudio();applyGain();
      if(skipRemoved&&previewEnd.current===undefined){
        const at=element.currentTime,last=Math.max(...recipe.segments.map(segment=>segment.out)),first=Math.min(...recipe.segments.map(segment=>segment.in));
        const inside=recipe.segments.some(segment=>at>=segment.in-1e-3&&at<segment.out);
        if(!inside){const next=recipe.segments.filter(segment=>segment.in>at).reduce<number|undefined>((best,segment)=>best===undefined||segment.in<best?segment.in:best,undefined);const target=at>=last-1e-3||next===undefined?first:next;setElementTime(target);reportTime(target);}
      }
    }
    if(element.paused){try{await element.play();}catch(e){if(!(e instanceof DOMException&&e.name==='AbortError'&&element.paused))throw e;}}else element.pause();
  };
  const playRegion=async()=>{
    const element=video.current;if(!element||!ready)return;
    generation.current++;pause();setInspectFrame(undefined);
    ensureAudio();applyGain(region.in);
    setElementTime(region.in);reportTime(region.in);previewEnd.current=region.out;setPreviewing(true);
    try{await element.play();}catch(e){stopPreview();if(!(e instanceof DOMException&&e.name==='AbortError'&&element.paused))throw e;}
  };
  const history=(action:()=>void)=>{generation.current++;pause();setError('');action();};
  const split=()=>{
    const at=cursor(),target=mobile?recipe.segments.findIndex(s=>at>s.in&&at<s.out):active;
    if(target<0||at<=recipe.segments[target].in||at>=recipe.segments[target].out)return;
    generation.current++;pause();reportTime(at);setError('');
    setSelected(target);change({...recipe,segments:recipe.segments.flatMap((s,i)=>i===target?[{...s,out:at},{...s,in:at}]:[s])});
    setMessage(`Region ${target+1} split at ${stamp(at)}.`);
  };
  const commitTrim=(index:number,edge:'in'|'out',value:number)=>{
    const segment=recipe.segments[index];
    if(!segment||!Number.isFinite(value)||value<0||value>duration||(edge==='in'?value>=segment.out:value<=segment.in))return;
    if(segment[edge]===value)return;
    generation.current++;pause();setError('');
    change({...recipe,segments:recipe.segments.map((s,i)=>i===index?{...s,[edge]:value}:s)});
    setElementTime(value);reportTime(value);setMessage('');
  };
  const beginTrim=(event:React.PointerEvent<HTMLButtonElement>,index:number,edge:'in'|'out')=>{
    if(event.button!==0)return;
    const originalTime=cursor();
    event.preventDefault();event.stopPropagation();select(index);setTool('Cut');if(!mobile)setPanelOpen(true);
    const target=event.currentTarget,media=target.closest('.timeline-media')!,segment=recipe.segments[index],startX=event.clientX,startScroll=timelineScroll.current?.scrollLeft||0;
    let value=segment[edge];target.setPointerCapture(event.pointerId);
    const move=(pointer:PointerEvent)=>{
      const delta=pointer.clientX-startX+(timelineScroll.current?.scrollLeft||0)-startScroll;
      const at=Math.round((segment[edge]+delta/media.getBoundingClientRect().width*duration)*1000)/1000;
      value=edge==='in'?Math.max(0,Math.min(segment.out-.001,at)):Math.min(duration,Math.max(segment.in+.001,at));
      setTrimDrag({index,edge,value});setElementTime(value);reportTime(value);
    };
    const clean=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',finish);target.removeEventListener('pointercancel',cancel);setTrimDrag(undefined);};
    const finish=()=>{clean();commitTrim(index,edge,value);};
    const cancel=()=>{clean();setElementTime(originalTime);reportTime(originalTime);};
    target.addEventListener('pointermove',move);target.addEventListener('pointerup',finish);target.addEventListener('pointercancel',cancel);
  };
  const trimValue=(edge:'in'|'out',value:number)=>edge==='in'?Math.max(0,Math.min(region.out-.001,value)):Math.min(duration,Math.max(region.in+.001,value));
  const finishRangeTrim=(edge:'in'|'out',value:number)=>{commitTrim(active,edge,trimValue(edge,value));setTrimDrag(undefined);};
  const totalKept=recipe.segments.reduce((n,s)=>n+s.out-s.in,0);
  // Right-click menu on the timeline.
  type Menu={x:number;y:number;at:number;hit:number;lane:'video'|'audio'};
  const [menu,setMenu]=useState<Menu>();
  const menuRef=useRef<HTMLDivElement>(null);
  const openMenu=(event:React.MouseEvent<HTMLDivElement>)=>{
    const target=event.target as HTMLElement;
    if(target.closest('.text-track,.overlay-track,.trim-handle,.scrubber'))return;
    const media=event.currentTarget.querySelector('.timeline-media');if(!media)return;
    event.preventDefault();
    const rect=media.getBoundingClientRect();
    const at=Math.max(0,Math.min(duration,(event.clientX-rect.left)/rect.width*duration));
    const hit=recipe.segments.findIndex(s=>at>=s.in&&at<=s.out);
    if(hit>=0&&hit!==active)setSelected(hit);
    setMenu({x:event.clientX,y:event.clientY,at,hit,lane:target.closest('.audio-track')?'audio':'video'});
  };
  const closeMenu=()=>setMenu(undefined);
  useEffect(()=>{
    if(!menu)return;
    const away=(event:Event)=>{if(!menuRef.current?.contains(event.target as Node))closeMenu();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape')closeMenu();};
    window.addEventListener('pointerdown',away,true);window.addEventListener('keydown',key);window.addEventListener('resize',closeMenu);window.addEventListener('blur',closeMenu);window.addEventListener('wheel',closeMenu,{passive:true});
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return()=>{window.removeEventListener('pointerdown',away,true);window.removeEventListener('keydown',key);window.removeEventListener('resize',closeMenu);window.removeEventListener('blur',closeMenu);window.removeEventListener('wheel',closeMenu);};
  },[menu]);
  const menuItems=():({label:string;hint?:string;disabled?:boolean;danger?:boolean;run:()=>void}|'sep')[]=>{
    if(!menu)return [];
    const {at,hit}=menu,target=hit>=0?hit:active,segment=recipe.segments[target];
    const gap=hit<0?excluded.find(g=>at>=g.from&&at<=g.to):undefined;
    const audioItems=[
      recipe.audio.mode==='mute'?{label:'Restore audio',run:()=>change({...recipe,audio:{...recipe.audio,mode:'keep'}})}:{label:'Remove audio',run:()=>change({...recipe,audio:{...recipe.audio,mode:'mute'}})},
      {label:recipe.audio.normalize?'Stop evening out volume':'Even out volume',disabled:recipe.audio.mode==='mute',run:()=>change({...recipe,audio:{...recipe.audio,normalize:!recipe.audio.normalize}})},
      {label:'Reset audio settings',disabled:recipe.audio.mode==='mute'&&recipe.audio.volume===1,run:()=>change({...recipe,audio:{...recipe.audio,volume:1,fadeIn:0,fadeOut:0,normalize:false}})},
      {label:'Audio settings…',run:()=>openTool('Audio')},
    ];
    const timing=[
      {label:`Set section ${target+1} start here`,hint:'I',disabled:at>=segment.out,run:()=>{setBoundary('in',at);}},
      {label:`Set section ${target+1} end here`,hint:'O',disabled:at<=segment.in,run:()=>{setBoundary('out',at);}},
      {label:'Split section here',disabled:hit<0||at<=segment.in||at>=segment.out,run:()=>{pause();reportTime(at);split();}},
    ];
    const sections=[
      ...(gap?[{label:'Include this part as a section',run:()=>{generation.current++;pause();setSelected(recipe.segments.length);change({...recipe,segments:[...recipe.segments,{in:gap.from,out:gap.to}]});setMessage('Section added.');}}]:[]),
      {label:hit>=0?`Remove section ${hit+1}`:`Remove section ${active+1}`,danger:true,disabled:recipe.segments.length===1,run:()=>remove()},
    ];
    const move=[
      {label:'Move playhead here',run:()=>{generation.current++;pause();setElementTime(at);reportTime(at);}},
      {label:'Zoom to fit',disabled:zoom<=1,run:()=>setZoom(1)},
    ];
    return menu.lane==='audio'?[...audioItems,'sep',...move]:[...timing,'sep',...sections,'sep',...move];
  };
  // Source time outside every kept section, shown hatched on the video and audio tracks.
  const excluded=(()=>{
    const kept=recipe.segments.map((s,i)=>trimDrag?.index===i?{...s,[trimDrag.edge]:trimDrag.value}:s).sort((a,b)=>a.in-b.in);
    const gaps:{from:number;to:number}[]=[];let at=0;
    for(const s of kept){if(s.in>at)gaps.push({from:at,to:s.in});at=Math.max(at,s.out);}
    if(at<duration)gaps.push({from:at,to:duration});
    return gaps.filter(g=>g.to-g.from>1e-6);
  })();
  const excludedLayer=<div className="excluded-layer" aria-hidden="true">{excluded.map((g,i)=><i key={i} data-testid="excluded-range" style={{left:`${g.from/duration*100}%`,width:`${(g.to-g.from)/duration*100}%`}}/>)}</div>;
  const rulerDivisions=mobile?Math.max(2,Math.min(200,Math.floor((timelineWindow.width||300)*zoom/85))):Math.min(8,Math.max(2,Math.ceil(duration/5)));
  const shortSelection=mobile&&(region.out-region.in)/duration*(timelineWindow.width||300)*zoom<88;
  const waveform=useMemo(()=><svg className="waveform" viewBox={`0 0 ${wave.length} 100`} preserveAspectRatio="none" aria-label="Audio waveform">{wave.map((v,i)=>{const level=Math.abs(v)/wavePeak*(recipe.audio.mode==='mute'?1:audioGain(i/wave.length*duration)),amp=Math.min(1,level)*40;return <line key={i} className={level>1.001?'clip':undefined} x1={i} x2={i} y1={50-amp} y2={50+amp}/>;})}</svg>,[wave,wavePeak,recipe.audio,recipe.segments,duration]);
  // Keyboard shortcuts work from anywhere in the editor, not only when focus is inside the workspace.
  const shortcutGroups:[string,[string,string][]][]=[
    ['Playback',[['Space','Play / pause'],['K','Pause'],['L','Play forward (press again for 2×, 4×, 8×)'],['J','Play backward (press again to go faster)']]],
    ['Frames and position',[['← / →','Previous / next frame (Shift: 10 frames)'],[', / .','Previous / next frame'],['↑ / ↓','Previous / next edit point'],['Home / End','Section start / end (Shift: source start / end)']]],
    ['Editing',[['I / O','Set section start / end at playhead'],['S','Split section at playhead'],['N','Add a section at playhead'],['Delete','Remove selected section'],['[ / ]','Select previous / next section'],['Ctrl+Z / Ctrl+Y','Undo / redo']]],
    ['View',[['M','Mute preview'],['+ / −','Zoom timeline'],['?','Show or hide this list']]],
  ];
  const onKey=useRef<(event:KeyboardEvent)=>void>(()=>{});
  onKey.current=e=>{
    const target=e.target as HTMLElement|null;
    if(!target||e.defaultPrevented||menu)return;
    const editable=!!target.closest('input:not(.scrubber),textarea,select,[contenteditable="true"]');
    if(e.key==='Escape'&&helpOpen){e.preventDefault();setHelpOpen(false);return;}
    if(e.key==='Escape'&&mobile&&!document.querySelector('dialog[open]')){
      const precision=document.querySelector<HTMLDetailsElement>('.cut-precision[open]');
      if(precision){e.preventDefault();precision.open=false;return;}
      if(timelineOptions){e.preventDefault();setTimelineOptions(false);return;}
      if(panelOpen){e.preventDefault();closePanel();return;}
    }
    if(editable||document.querySelector('dialog[open],[role=dialog]:not(.shortcuts-overlay)'))return;
    const key=e.key.length===1?e.key.toLowerCase():e.key;
    if(e.ctrlKey||e.metaKey){
      if(e.altKey)return;
      if(key==='z'){e.preventDefault();if(e.shiftKey?canRedo:canUndo)history(e.shiftKey?redo:undo);}
      if(key==='y'){e.preventDefault();if(canRedo)history(redo);}
      return;
    }
    if(e.altKey)return;
    const element=video.current,at=cursor();
    const edges=[...new Set(recipe.segments.flatMap(segment=>[segment.in,segment.out]).concat([0,duration]))].sort((a,b)=>a-b);
    const jump=(value:number)=>{generation.current++;pause();setInspectFrame(undefined);setElementTime(value);reportTime(value);};
    const handled=(action:()=>void)=>{e.preventDefault();action();};
    switch(key){
      case ' ':if(target.closest('button'))return;handled(()=>void run(togglePlay));break;
      case 'k':handled(()=>{pause();});break;
      case 'l':handled(()=>{
        if(!element||!ready)return;
        const speed=shuttle.current.dir===1?Math.min(8,shuttle.current.speed*2):1;
        cancelAnimationFrame(shuttle.current.raf);shuttle.current={dir:1,speed,raf:0};element.playbackRate=speed;
        void run(async()=>{if(element.paused)await togglePlay();element.playbackRate=speed;});
      });break;
      case 'j':handled(()=>{
        if(!element||!ready)return;
        const speed=shuttle.current.dir===-1?Math.min(8,shuttle.current.speed*2):1;
        element.pause();stopPreview();cancelAnimationFrame(shuttle.current.raf);
        let last=performance.now();
        const loop=(now:number)=>{
          const next=Math.max(0,element.currentTime-(now-last)/1000*shuttle.current.speed);last=now;
          setElementTime(next);reportTime(next);applyGain(next);
          if(next<=0){stopShuttle();return;}
          shuttle.current.raf=requestAnimationFrame(loop);
        };
        shuttle.current={dir:-1,speed,raf:requestAnimationFrame(loop)};
      });break;
      case 'ArrowLeft':case 'ArrowRight':handled(()=>stepFrames((key==='ArrowRight'?1:-1)*(e.shiftKey?10:1)));break;
      case ',':case '<':handled(()=>stepFrames(key==='<'?-10:-1));break;
      case '.':case '>':handled(()=>stepFrames(key==='>'?10:1));break;
      case 'ArrowUp':handled(()=>{const previous=edges.findLast(edge=>edge<at-.02);if(previous!==undefined)jump(previous);});break;
      case 'ArrowDown':handled(()=>{const next=edges.find(edge=>edge>at+.02);if(next!==undefined)jump(next);});break;
      case 'Home':handled(()=>jump(e.shiftKey?0:region.in));break;
      case 'End':handled(()=>jump(e.shiftKey?duration:region.out));break;
      case 'i':handled(()=>mark('in'));break;
      case 'o':handled(()=>mark('out'));break;
      case 's':handled(split);break;
      case 'n':handled(add);break;
      case 'Delete':case 'Backspace':handled(()=>{if(tool==='Overlay'&&selectedOverlay!==undefined){change({...recipe,overlays:recipe.overlays.filter((_,i)=>i!==selectedOverlay)});setMessage('Overlay removed.');}else remove();});break;
      case '[':handled(()=>{if(active>0)select(active-1);});break;
      case ']':handled(()=>{if(active<recipe.segments.length-1)select(active+1);});break;
      case 'm':handled(()=>setMuted(!muted));break;
      case '+':case '=':handled(()=>setZoom(Math.min(20,zoom+1)));break;
      case '-':case '_':handled(()=>setZoom(Math.max(1,zoom-1)));break;
      case '?':handled(()=>setHelpOpen(!helpOpen));break;
    }
  };
  useEffect(()=>{const handler=(event:KeyboardEvent)=>onKey.current(event);window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[]);
  return <div className={`cut-workspace tool-${tool.toLowerCase()}${panelOpen?' is-panel-open':''}${recipe.caption?.text?' has-caption':''}${recipe.overlays.length?' has-overlays':''}${shortSelection?' has-short-selection':''}`}>
    <div className="cut-layout">
      <nav ref={toolRail} className="editor-tool-rail" aria-label="Editing tools">
        {tools.map(([value,icon,tone])=><button key={value} className={`tool-${tone}`} title={value} aria-label={value} aria-pressed={tool===value} aria-expanded={mobile?panelOpen&&tool===value:undefined} aria-controls={mobile?'editor-tool-panel':undefined} onClick={()=>mobile&&panelOpen&&tool===value?closePanel():activateRailTool(value)}><EditorIcon name={icon} tone={tone}/><span>{value}</span></button>)}
      </nav>
      <div ref={contextPanel} id="editor-tool-panel" className="editor-context-panel" role="region" aria-label={`${tool} settings`}><div className={`context-panel-heading tool-${toolTone(tool)}`}><EditorIcon name={toolIcon(tool)} size={17} tone={toolTone(tool)}/><span>{tool==='Cut'?`Trim section ${active+1}`:tool==='Source'?'Media':tool}</span><button className="context-panel-close" onClick={closePanel}>Done</button></div>
        {inspector||<aside className="region-sidebar" aria-label="Kept regions">
          <div className="region-heading"><h3>Sections</h3><span>{recipe.segments.length}</span></div>
          <div className="region-list">{recipe.segments.map((s,i)=><button key={i} className="region-choice" aria-label={`Select region ${i+1}`} aria-pressed={active===i} onClick={()=>{select(i);openTool('Cut');}}><strong>Section {i+1}</strong><span>{stamp(s.in)} to {stamp(s.out)}</span><small>{(s.out-s.in).toFixed(2)} s</small></button>)}</div>
          <div className="section-trim-range" style={{'--trim-start':`${displayedRegion.in/duration*100}%`,'--trim-end':`${displayedRegion.out/duration*100}%`} as React.CSSProperties}>
            {(['in','out'] as const).map(edge=><input key={edge} type="range" aria-label={edge==='in'?'Section start':'Section end'} min={0} max={duration} step={.001} value={displayedRegion[edge]} style={{zIndex:edge==='in'&&displayedRegion.in/duration>.9?3:edge==='out'?2:1}} onChange={event=>{const value=trimValue(edge,Number(event.target.value));pause();setTrimDrag({index:active,edge,value});setElementTime(value);reportTime(value);}} onPointerUp={event=>finishRangeTrim(edge,Number(event.currentTarget.value))} onKeyUp={event=>finishRangeTrim(edge,Number(event.currentTarget.value))} onBlur={event=>finishRangeTrim(edge,Number(event.currentTarget.value))} onPointerCancel={()=>setTrimDrag(undefined)}/>)}
          </div>
          <div className="region-edit" aria-label={`Editing region ${active+1}`}>
            {(['in','out'] as const).map(edge=><div className="section-boundary" key={edge}>
              <div className="section-boundary-heading"><strong>{edge==='in'?'Start':'End'}</strong><button className="boundary-jump" aria-label={edge==='in'?'Go to section start':'Go to section end'} title={edge==='in'?'Go to section start':'Go to section end'} onClick={()=>{pause();setElementTime(region[edge]);reportTime(region[edge]);}}><EditorIcon name={edge==='in'?'to-start':'to-end'} size={16}/></button></div>
              <BoundaryInput key={`${edge}-${active}`} label={`Region ${active+1} ${edge} timecode`} value={displayedRegion[edge]} commit={value=>setBoundary(edge,value)}/>
              <button className="boundary-mark" aria-label={edge==='in'?'Set start I':'Set end O'} title={edge==='in'?'Set start at playhead (I)':'Set end at playhead (O)'} aria-keyshortcuts={edge==='in'?'I':'O'} disabled={edge==='in'?time>=region.out:time<=region.in} onClick={()=>mark(edge)}>Use playhead <kbd>{edge==='in'?'I':'O'}</kbd></button>
            </div>)}
          </div>
          <div className="section-length">{(displayedRegion.out-displayedRegion.in).toFixed(2)} s</div>
          <div className="actions"><button aria-label="+ New region" disabled={!canAddSection(time)} onClick={add}><EditorIcon name="plus" size={16}/>Add section</button><button className="danger-quiet" aria-label="Remove region" disabled={recipe.segments.length===1} onClick={remove}>Remove section</button></div>
          <small>{totalKept.toFixed(3)} seconds kept</small>
        </aside>}
      </div>
      <div className="cut-player"><div className="source-heading"><h1 aria-label={`Editor · ${sourceName}`}><EditorIcon name="video" size={17} tone="video"/>{sourceName}</h1><span>{mediaWidth} × {mediaHeight}{frameRate?` · ${Math.round(frameRate.split('/').reduce((a,n,i)=>i?a/Number(n):Number(n),0)*100)/100} fps`:''}</span></div>
        <div className="preview-heading" data-state={editingCrop?'crop':recipe.crop||recipe.resize||recipe.rotate||recipe.caption?.text.trim()||recipe.overlays.length?'live':'original'}><strong>{editingCrop?'Crop preview':recipe.crop||recipe.resize||recipe.rotate||recipe.caption?.text.trim()||recipe.overlays.length?'Live preview':'Original preview'}</strong><span>{stamp(time)} / {stamp(duration)}</span></div>
        {tool==='Transform'&&(!mobile||panelOpen)&&<ViewportTransformControls recipe={recipe} change={change} width={mediaWidth} height={mediaHeight} sourceRotation={mediaRotation} editingCrop={editingCrop} setEditingCrop={setCropView}/>}
        <div className="cut-preview" onClick={()=>{if(!mobile)openTool('Transform');}}>
          <TransformViewport recipe={recipe} change={change} width={mediaWidth} height={mediaHeight} sourceRotation={mediaRotation} active={tool==='Transform'&&(!mobile||panelOpen)} editingCrop={editingCrop} fit={fit} pictureLayer={recipe.overlays.length>0&&<OverlayLayer overlays={recipe.overlays} time={time} selected={selectedOverlay} editing={tool==='Overlay'&&(!mobile||panelOpen)} select={selectOverlay} commit={updateOverlay}/>}>
          <video ref={video} playsInline muted={muted} src={contentUrl(previewId)} preload="metadata" aria-label="Source playback"
            onLoadedMetadata={()=>{setElementTime(Math.max(0,Math.min(duration,position.current)));setReady(true);}}
            onLoadedData={()=>setError('')}
            onPlay={()=>{generation.current++;setPlaying(true);setInspectFrame(undefined);}}
            onPause={e=>{if(e.currentTarget.paused){setPlaying(false);stopPreview();}}} onEnded={()=>{setPlaying(false);stopPreview();}}
            onSeeking={e=>{if(expectedSeek.current===undefined||Math.abs(e.currentTarget.currentTime-expectedSeek.current)>1e-5){generation.current++;stopPreview();setInspectFrame(undefined);}}}
            onSeeked={e=>{if(expectedSeek.current!==undefined&&Math.abs(e.currentTarget.currentTime-expectedSeek.current)>.05){e.currentTarget.currentTime=expectedSeek.current;return;}expectedSeek.current=undefined;pendingStep.current=undefined;applyGain(e.currentTarget.currentTime);reportTime(e.currentTarget.currentTime);}}
            onTimeUpdate={e=>{if(e.currentTarget.readyState>=1&&!e.currentTarget.seeking)reportTime(e.currentTarget.currentTime);}}
            onError={()=>{setReady(false);setPlaying(false);stopPreview();setError('This browser could not decode the preview. Generate and select a playback proxy below.');}}/>
          {inspectFrame!==undefined&&currentFrame?.url&&<img className="cut-frame" src={currentFrame.url} alt={`Source decoded frame at ${inspectFrame.toFixed(6)} seconds`} onLoad={()=>setFrameImage(frame=>frame&&frame.key===frameKey?{...frame,phase:'ready',message:undefined}:frame)} onError={()=>setFrameImage(frame=>frame&&frame.key===frameKey?{key:frame.key,phase:'error',message:'The source frame could not be displayed. Try again.'}:frame)}/>}
          </TransformViewport>
        </div>
        {inspectFrame!==undefined&&<div className="original-preview-note source-frame-status" role={currentFrame?.phase==='error'?'alert':'status'} aria-live="polite" aria-atomic="true">
          {currentFrame?.phase==='ready'?`Decoded original frame · ${inspectFrame.toFixed(6)} s`:currentFrame?.message||'Loading source frame…'}
          {currentFrame?.phase==='error'&&<div className="actions"><button type="button" onClick={()=>setFrameAttempt(attempt=>attempt+1)}>Retry frame</button></div>}
        </div>}
        {(recipe.audio.mode==='mute'||recipe.audio.mode==='replace'||recipe.audio.normalize||(skipRemoved&&excluded.length>0))&&<small className="preview-notes">{[
          skipRemoved&&excluded.length>0?'Preview plays only the kept sections':'',
          recipe.audio.mode==='mute'?'audio removed':recipe.audio.mode==='replace'?'replacement audio is not played in preview':'',
          recipe.audio.normalize?'loudness evening is applied on export':'',
        ].filter(Boolean).join(' · ')}</small>}
        <div className="cut-transport">
          <div className="transport-time"><output aria-label="Current source time">{stamp(time)}</output><span> / {stamp(duration)}</span></div>
          <div className="transport-buttons"><button title="Previous frame (Left arrow)" aria-label="Previous frame" disabled={!ready} onClick={()=>stepFrames(-1)}><EditorIcon name="frame-back"/><span>Previous frame</span></button><button className="transport-play" title={playing?'Pause':'Play'} aria-label={playing?'Pause':'Play'} disabled={!ready} onClick={()=>void run(togglePlay)}><EditorIcon name={playing?'pause':'play'}/><span>{playing?'Pause':'Play'}</span></button><button title="Next frame (Right arrow)" aria-label="Next frame" disabled={!ready} onClick={()=>stepFrames(1)}><EditorIcon name="frame-forward"/><span>Next frame</span></button></div>
          <div className="transport-view"><details className="cut-precision"><summary title="Preview and playback options"><EditorIcon name="sliders" size={17}/><span>Preview and playback options</span></summary><div className="cut-precision-menu">{viewerActions}{playbackOptions}<div className="playback-audio"><button aria-pressed={skipRemoved} title="Skip over time that is not in any kept section during playback" onClick={()=>setSkipRemoved(!skipRemoved)}><EditorIcon name="cut" size={16}/>Skip removed parts</button><button aria-pressed={muted} onClick={()=>setMuted(!muted)}><EditorIcon name="volume" size={16}/>{muted?'Unmute':'Mute'}</button><label className="playback-volume">Playback volume<input aria-label="Playback volume" type="range" min={0} max={1} step={.05} value={volume} style={{"--p":`${volume*100}%`} as React.CSSProperties} onChange={e=>{const value=Number(e.target.value);setVolume(value);}}/></label></div><div className="actions"><button onClick={()=>void run(()=>step(-1,true))}><EditorIcon name="keyframe" size={15}/>Previous keyframe</button><button onClick={()=>void run(()=>step(1,true))}><EditorIcon name="keyframe" size={15}/>Next keyframe</button><button onClick={()=>void run(()=>seek(cursor(),true))}><EditorIcon name="frame" size={15}/>Inspect source frame</button></div></div></details><select aria-label="Viewer fit" value={fit} onChange={e=>setFit(e.target.value)}><option value="fit">Fit</option><option value="fill">Fill</option></select><button title="Fullscreen" aria-label="Fullscreen" onClick={()=>void run(async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await video.current?.closest('.cut-player')?.requestFullscreen();})}><EditorIcon name="fullscreen" size={18}/></button></div>
        </div>
      </div>
      <aside className="editor-export-summary" aria-label="Export summary">{exportSummary}</aside>
    </div>
    <div className="mobile-timeline-actions" role="group" aria-label="Mobile timeline controls">
      <button aria-label="Undo" title="Undo" disabled={!canUndo} onClick={()=>history(undo)}><EditorIcon name="undo" size={20}/></button>
      <button className="mobile-split" disabled={!recipe.segments.some(s=>time>s.in&&time<s.out)} onClick={split}><EditorIcon name="split" size={18}/><span>Split</span></button>
      <button aria-label="More timeline actions" aria-expanded={timelineOptions} aria-controls="mobile-timeline-options" onClick={()=>{setTimelineOptions(!timelineOptions);setPanelOpen(false);}}><EditorIcon name="more" size={20}/></button>
      <span className="mobile-zoom-divider"/>
      <button aria-label="Zoom out" title="Zoom out" disabled={zoom<=1} onClick={()=>setZoom(zoom-1)}><EditorIcon name="zoom-out" size={18}/></button>
      <button aria-label="Zoom in" title="Zoom in" disabled={zoom>=20} onClick={()=>setZoom(zoom+1)}><EditorIcon name="zoom-in" size={18}/></button>
      <button title="Fit timeline to width" onClick={()=>setZoom(1)}>Fit</button>
    </div>
    {mobile&&timelineOptions&&<section id="mobile-timeline-options" className="mobile-timeline-options" aria-label="More timeline actions">
      <div className="context-panel-heading"><strong>Timeline options</strong><button onClick={()=>setTimelineOptions(false)}>Done</button></div>
      <div className="mobile-timeline-option-grid">
        <button disabled={!canRedo} onClick={()=>history(redo)}><EditorIcon name="redo" size={18}/>Redo</button>
        <button aria-pressed={snap} onClick={()=>setSnap(!snap)}><EditorIcon name="snap" size={18}/>Snap to frames</button>
        <button onClick={()=>{openTool('Cut');}}>Edit sections</button>
        <button disabled={recipe.segments.length===1} onClick={remove}>Remove section</button>
        <button aria-label={previewing?'Stop source region':'Play source region'} disabled={!ready} onClick={()=>{setTimelineOptions(false);void run(previewing?async()=>pause():playRegion);}}>Play section</button>
        <button onClick={()=>{setTimelineOptions(false);centerPlayhead();}}>Show playhead</button>
        <button onClick={()=>{scrub(region.in);centerPlayhead(region.in);}}>Go to start</button>
        <button onClick={()=>{scrub(region.out);centerPlayhead(region.out);}}>Go to end</button>
      </div>
      <label className="mobile-position">Playhead (s)<BoundaryInput label="Playhead (s)" value={time} seconds commit={value=>{if(!Number.isFinite(value)||value<0||value>duration)return false;scrub(value);centerPlayhead(value);return true;}}/></label>
    </section>}
    <div className="mobile-timeline-hint"><strong>Timeline <span>{Number(zoom.toFixed(1))}×</span></strong><span>{zoom>1?'Swipe to move · pinch to zoom':'Drag ruler to seek · zoom for detail'}</span></div>
    <div className="compact-timeline-toolbar" role="group" aria-label="Timeline controls">
      <div className="timeline-tool-group history-tools">
        <button aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" aria-pressed={helpOpen} onClick={()=>setHelpOpen(!helpOpen)}><EditorIcon name="keyboard"/><span>Keys</span></button>
        <button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={()=>history(undo)}><EditorIcon name="undo"/><span>Undo</span></button>
        <button aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={()=>history(redo)}><EditorIcon name="redo"/><span>Redo</span></button>
      </div>
      <div className="timeline-tool-group">
        <button aria-label="Trim selected section" title="Trim selected section" onClick={()=>openTool('Cut')}><EditorIcon name="cut" tone="cut"/><span>Trim</span></button>
        <button title="Split selected region at playhead" disabled={time<=region.in||time>=region.out} onClick={split}><EditorIcon name="split"/><span>Split</span></button>
        <button className="danger-quiet" aria-label="Remove selected section" title="Remove selected section" disabled={recipe.segments.length===1} onClick={remove}><EditorIcon name="trash" tone="danger"/><span>Remove</span></button>
        <button className="snap-toggle" title="Snap to indexed frame timestamps" aria-pressed={snap} onClick={()=>setSnap(!snap)}><EditorIcon name="snap"/><span>Snap</span><i aria-hidden="true"/></button>
      </div>
      <div className="timeline-tool-group region-play-tools"><button className="region-play" aria-label={previewing?'Stop source region':'Play source region'} title="Play the selected section" disabled={!ready} onClick={()=>void run(previewing?async()=>pause():playRegion)}><EditorIcon name={previewing?'stop':'play'}/><span>{previewing?'Stop region':'Play region'}</span></button>
        <details className="timeline-more"><summary aria-label="More timeline actions" title="More timeline actions"><EditorIcon name="more"/></summary><div><button onClick={()=>void run(()=>seek(region.in))}><EditorIcon name="to-start" size={16}/>Go to start</button><button onClick={()=>void run(()=>seek(region.out))}><EditorIcon name="to-end" size={16}/>Go to end</button><label>Playhead (s)<input aria-label="Playhead (s)" type="number" min={0} max={duration} step="any" value={time} onChange={e=>void run(()=>seek(Number(e.target.value)))}/></label></div></details>
      </div>
      <div className="timeline-tool-group timeline-zoom"><span>Zoom</span><button aria-label="Zoom out" title="Zoom out" disabled={zoom<=1} onClick={()=>setZoom(Math.max(1,zoom-1))}><EditorIcon name="zoom-out" size={16}/></button><input aria-label="Timeline zoom" type="range" min={1} max={20} step={1} value={zoom} style={{"--p":`${(zoom-1)/19*100}%`} as React.CSSProperties} onChange={e=>setZoom(Number(e.target.value))}/><button aria-label="Zoom in" title="Zoom in" disabled={zoom>=20} onClick={()=>setZoom(Math.min(20,zoom+1))}><EditorIcon name="zoom-in" size={16}/></button><button title="Fit timeline to width" onClick={()=>setZoom(1)}><EditorIcon name="fit" size={16}/>Fit</button></div>
    </div>
    {helpOpen&&<div className="shortcuts-overlay" role="dialog" aria-label="Keyboard shortcuts" onClick={()=>setHelpOpen(false)}>
      <div className="shortcuts-panel" onClick={e=>e.stopPropagation()}>
        <div className="shortcuts-head"><strong>Keyboard shortcuts</strong><button aria-label="Close keyboard shortcuts" onClick={()=>setHelpOpen(false)}>Close</button></div>
        <div className="shortcuts-body">{shortcutGroups.map(([group,items])=><section key={group}><h3>{group}</h3><dl>{items.map(([keys,label])=><React.Fragment key={keys}><dt>{keys.split(' / ').map(k=><kbd key={k}>{k}</kbd>)}</dt><dd>{label}</dd></React.Fragment>)}</dl></section>)}</div>
      </div>
    </div>}
    {menu&&<div ref={menuRef} className="timeline-menu" role="menu" aria-label={menu.lane==='audio'?'Audio track actions':'Timeline actions'} style={{left:Math.max(4,Math.min(menu.x,window.innerWidth-232)),top:Math.max(4,Math.min(menu.y,window.innerHeight-menuItems().length*34-12))}}
      onContextMenu={e=>e.preventDefault()}
      onKeyDown={e=>{if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;e.preventDefault();const items=Array.from(menuRef.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const at=items.indexOf(document.activeElement as HTMLButtonElement);items[(at+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}}>
      <div className="timeline-menu-head">{stamp(menu.at)}</div>
      {menuItems().map((item,i)=>item==='sep'?<hr key={i}/>:<button key={i} role="menuitem" className={item.danger?'is-danger':undefined} disabled={item.disabled} onClick={()=>{closeMenu();item.run();}}><span>{item.label}</span>{item.hint&&<kbd>{item.hint}</kbd>}</button>)}
    </div>}
    <div className="context-timeline" aria-label="Editing timeline">
      <div className="track-labels"><div className="track-ruler-label"><button aria-label="Timeline controls" title="Timeline controls" onClick={()=>openTool('Cut')}><EditorIcon name="more"/></button></div><button className="track-text" onClick={()=>{openTool('Text')}}><EditorIcon name="text" tone="text"/><span>Text</span></button><button className="track-overlay" onClick={()=>openTool('Overlay')}><EditorIcon name="image" tone="overlay"/><span>Overlay</span></button><button className="track-video" onClick={()=>openTool('Transform')}><EditorIcon name="video" tone="video"/><span>Video</span></button><button className="track-audio" onClick={()=>openTool('Audio')}><EditorIcon name="audio" tone="audio"/><span>Audio</span></button></div>
      <div ref={timelineScroll} className="timeline-scroll" {...timelineGestures} onScroll={updateTimelineWindow}><div className="timeline" style={{width:`${zoom*100}%`}} onContextMenu={openMenu}>
        <div className="timeline-ruler" role={mobile?'slider':undefined} tabIndex={mobile?0:undefined} aria-label={mobile?'Timeline playhead':undefined} aria-valuemin={mobile?0:undefined} aria-valuemax={mobile?duration:undefined} aria-valuenow={mobile?time:undefined} aria-valuetext={mobile?stamp(time):undefined} onPointerDown={event=>beginScrub(event)} onKeyDown={event=>{
          if(!mobile||!['ArrowLeft','ArrowRight','ArrowDown','ArrowUp','Home','End','PageDown','PageUp'].includes(event.key))return;
          event.preventDefault();event.stopPropagation();
          if(event.key==='Home')scrub(0);else if(event.key==='End')scrub(sourceEnd);
          else if(event.key==='PageDown'||event.key==='PageUp')scrub(time+(event.key==='PageUp'?1:-1)*5);
          else stepFrames((event.key==='ArrowRight'||event.key==='ArrowUp'?1:-1)*(event.shiftKey?10:1));
        }} onClick={e=>{if(mobile)return;const rect=e.currentTarget.getBoundingClientRect();void run(()=>seek((e.clientX-rect.left)/rect.width*duration));}}>{Array.from({length:rulerDivisions+1},(_,i)=>{const at=i/rulerDivisions*duration;return <span key={i} style={{left:`${at/duration*100}%`}}>{duration<10?`${at.toFixed(1)} s`:stamp(at).slice(duration>=3600?0:3,8)}</span>})}</div>
        <div className="timeline-media">
          <div className="text-track">{recipe.caption?.text?<button className="text-clip" aria-label="Edit video caption" style={{left:0,width:'100%'}} onClick={()=>openTool('Text')}><span>T</span>{recipe.caption.text}</button>:<button className="empty-text-track" onClick={()=>openTool('Text')}><EditorIcon name="plus" size={14}/>Add caption</button>}</div>
          <OverlayTrack overlays={recipe.overlays} duration={duration} selected={selectedOverlay} editing={tool==='Overlay'} select={selectOverlay} add={()=>{openTool('Overlay');requestAnimationFrame(()=>document.querySelector<HTMLInputElement>('input[aria-label="Choose overlay image"]')?.click());}} retime={(index,range)=>updateOverlay(index,range)} seek={at=>{generation.current++;pause();setInspectFrame(undefined);setElementTime(at);reportTime(at);}}/>
          <div className="video-track" onClick={()=>{if(!mobile)openTool('Cut');}}>{thumbnails}{excludedLayer}<div className="region-tracks" onClick={e=>e.stopPropagation()}>{recipe.segments.map((s,i)=>{
            const segment=trimDrag?.index===i?{...s,[trimDrag.edge]:trimDrag.value}:s;
            return <div className="region-lane" key={i}><div className={`timeline-region-wrapper${active===i?' is-selected':''}`} style={{left:`${segment.in/duration*100}%`,width:`${(segment.out-segment.in)/duration*100}%`}}><button className="timeline-region" aria-label={`Select timeline region ${i+1}`} aria-pressed={active===i} onClick={event=>{select(i);if(!mobile)openTool('Cut');const rect=event.currentTarget.closest('.timeline-media')!.getBoundingClientRect();const at=Math.max(segment.in,Math.min(segment.out,(event.clientX-rect.left)/rect.width*duration));if(event.detail){setElementTime(at);reportTime(at);}}}><span className="timeline-section-number">{i+1}</span></button>{tool==='Cut'&&active===i&&(['in','out'] as const).map(edge=><button key={edge} className={`trim-handle trim-${edge}`} style={shortSelection?{left:Math.min(0,(timelineWindow.width||300)*zoom*(1-segment.in/duration)-44),right:"auto"}:undefined} role="slider" aria-label={`Region ${i+1} ${edge==='in'?'start':'end'} trim handle`} aria-orientation="horizontal" aria-valuemin={edge==='in'?0:segment.in+.001} aria-valuemax={edge==='in'?segment.out-.001:duration} aria-valuenow={segment[edge]} aria-valuetext={stamp(segment[edge])} onPointerDown={e=>beginTrim(e,i,edge)} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();const step=e.shiftKey?.1:.01;const value=e.key==='Home'?(edge==='in'?0:segment.in+.001):e.key==='End'?(edge==='in'?segment.out-.001:duration):Math.max(edge==='in'?0:segment.in+.001,Math.min(edge==='in'?segment.out-.001:duration,segment[edge]+(e.key==='ArrowLeft'?-step:step)));commitTrim(i,edge,Math.round(value*1000)/1000);}}><span aria-hidden="true"/></button>)}</div></div>;
          })}</div></div>
          <div className={`audio-track${recipe.audio.mode==='mute'?' is-removed':''}`} onClick={()=>{if(!mobile)openTool('Audio');}}>{excludedLayer}{wave.length>0?waveform:<span className={`waveform-empty${waveLoading?' is-loading':''}`}>{!hasAudio?'No audio in this source':recipe.audio.mode==='mute'?'Audio removed':waveLoading?'Analyzing audio…':'Waveform unavailable'}</span>}{wave.length>0&&recipe.audio.mode==='mute'&&<span className="waveform-badge">Audio removed</span>}{wave.length>0&&recipe.audio.mode==='replace'&&<span className="waveform-badge">Replaced by another source</span>}</div>
          <div className="timeline-cursor" style={{left:`${time/duration*100}%`}} aria-hidden="true"/>
        </div>
        <input className="scrubber" aria-label="Timeline playhead" type="range" min={0} max={duration} step={.001} value={time} onChange={e=>{const value=Number(e.target.value);if(ctrlHeld.current){const px=e.currentTarget.getBoundingClientRect().width/duration;const near=[region.in,region.out].filter(edge=>Math.abs(edge-value)*px<=12).sort((a,b)=>Math.abs(a-value)-Math.abs(b-value))[0];if(near!==undefined){void run(()=>seek(near,true));return;}}void run(()=>seek(value));}}/>
      </div></div>
    </div>
    <div className="mobile-timeline-overview">
      <div className="timeline-overview-range" onPointerDown={event=>beginScrub(event,true)} style={{'--view-start':`${timelineWindow.start*100}%`,'--view-end':`${timelineWindow.end*100}%`} as React.CSSProperties}>
        <span className="timeline-overview-window" aria-hidden="true"/>
        <input type="range" aria-label="Navigate full video" aria-valuetext={stamp(time)} min={0} max={duration} step={.001} value={time} onChange={e=>{const value=Number(e.target.value);scrub(value);centerPlayhead(value);}}/>
      </div>
      <button aria-label="Show playhead" title="Show playhead in timeline" onClick={()=>centerPlayhead()}><EditorIcon name="play" size={16}/></button>
    </div>
    <div className="compact-timeline-status"><span>{recipe.segments.length} kept {recipe.segments.length===1?'section':'sections'} <b>·</b> {totalKept.toFixed(3)} s</span><span role="status">{message}</span><span>From {stamp(duration)}</span></div>
    {error&&<p role="alert" className="error">{error}</p>}
  </div>;
}
