import React, { useLayoutEffect, useRef, useState } from 'react';
import type { Overlay, Recipe } from '../../../packages/contracts/src/index';
import { EditorIcon } from './EditorIcon';
import { MAX_OVERLAYS, imageFromClipboard, overlayUrl } from './overlay';

type Props = { active:boolean;preview:(index:number,patch?:Partial<Overlay>)=>void;recipe:Recipe; change:(recipe:Recipe)=>void; selected?:number; select:(index:number|undefined)=>void; time:number; duration:number; adding:boolean; addImage:(file:File)=>void };
const stamp = (seconds:number) => { const ms = Math.max(0,Math.round(seconds*1000)); return `${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`; };
const fill = (value:number,min:number,max:number) => ({'--p':`${Math.max(0,Math.min(1,(value-min)/(max-min)))*100}%`}) as React.CSSProperties;

const rangeKeys=new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown']);
function Slider({label,value,min,max,step,format,onChange,onPreview,revision,active}:{label:string;value:number;min:number;max:number;step:number;format:(value:number)=>string;onChange:(value:number)=>void;onPreview:(value?:number)=>void;revision:unknown;active:boolean}) {
  const [pending,setPending]=useState<number>();
  const gesture=useRef<{value:number;start:number;pointer?:number;cancelled:boolean;target:HTMLInputElement}|undefined>(undefined);
  const latest=useRef({onChange,onPreview});latest.current={onChange,onPreview};
  const clear=()=>{setPending(undefined);latest.current.onPreview();};
  const cancel=()=>{if(gesture.current){gesture.current.cancelled=true;clear();}};
  const finish=(commit:boolean)=>{const g=gesture.current;if(!g)return;gesture.current=commit&&!g.cancelled?undefined:{...g,cancelled:true};clear();if(g.pointer!==undefined&&g.target.hasPointerCapture(g.pointer))g.target.releasePointerCapture(g.pointer);if(commit&&!g.cancelled&&g.value!==g.start)latest.current.onChange(g.value);};
  useLayoutEffect(()=>{cancel();},[revision,active]);
  useLayoutEffect(()=>{const key=(event:KeyboardEvent)=>{if(!gesture.current||gesture.current.cancelled)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();cancel();}else if((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase()))cancel();};const blur=()=>cancel();window.addEventListener('keydown',key,true);window.addEventListener('blur',blur);return()=>{window.removeEventListener('keydown',key,true);window.removeEventListener('blur',blur);gesture.current=undefined;latest.current.onPreview();};},[]);
  const begin=(target:HTMLInputElement,pointer?:number)=>{if(!active)return;gesture.current={value,start:value,pointer,cancelled:false,target};};
  const shown=pending??value;
  return <label className="overlay-slider"><span><span>{label}</span><output>{format(shown)}</output></span>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={Math.max(min,Math.min(max,shown))} style={fill(shown,min,max)}
      onPointerDown={event=>{if(event.button!==0)return;begin(event.currentTarget,event.pointerId);event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerUp={event=>{if(gesture.current?.pointer===event.pointerId)finish(true);}} onPointerCancel={event=>{if(gesture.current?.pointer===event.pointerId)cancel();}} onLostPointerCapture={event=>{if(gesture.current?.pointer===event.pointerId)cancel();}}
      onKeyDown={event=>{if(rangeKeys.has(event.key)&&(!gesture.current||(gesture.current.cancelled&&!event.repeat)))begin(event.currentTarget);}}
      onKeyUp={event=>{if(rangeKeys.has(event.key)&&gesture.current?.pointer===undefined)finish(true);}} onBlur={()=>finish(false)}
      onChange={event=>{const next=Number(event.target.value),g=gesture.current;if(g){if(g.cancelled)return;g.value=next;setPending(next);onPreview(next);}else if(active)onChange(next);}}/></label>;
}

// Timecode text is local until committed, like the section boundaries.
function TimeField({label,value,commit}:{label:string;value:number;commit:(value:number)=>void}) {
  const [text,setText] = useState<string>();
  const apply = () => { if(text===undefined)return; const seconds = text.trim().split(':').reduce((total,part)=>total*60+Number(part),0); if(Number.isFinite(seconds)&&text.trim())commit(seconds); setText(undefined); };
  return <input aria-label={label} inputMode="decimal" spellCheck={false} value={text??stamp(value)} onChange={event=>setText(event.target.value)} onBlur={apply} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();if(event.key==='Escape'){setText(undefined);}}}/>;
}

export function OverlayInspector({active,preview,recipe,change,selected,select,time,duration,adding,addImage}:Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dropping,setDropping] = useState(false);
  const overlays = recipe.overlays;
  const index = selected!==undefined&&selected<overlays.length?selected:undefined, current = index===undefined?undefined:overlays[index];
  const update = (patch:Partial<Overlay>) => { if(index!==undefined)change({...recipe,overlays:overlays.map((o,i)=>i===index?{...o,...patch}:o)}); };
  const setTime = (edge:'in'|'out',value:number) => {
    if(!current)return;
    const next = Math.round(Math.max(0,Math.min(duration,value))*1000)/1000;
    if(edge==='in'?next<current.out:next>current.in)update({[edge]:next});
  };
  const remove = () => { if(index===undefined)return; change({...recipe,overlays:overlays.filter((_,i)=>i!==index)}); select(overlays.length>1?Math.max(0,index-1):undefined); };
  const duplicate = () => { if(!current||overlays.length>=MAX_OVERLAYS)return; change({...recipe,overlays:[...overlays,{...current,x:Math.min(2,current.x+.04),y:Math.min(2,current.y+.04)}]}); select(overlays.length); };
  const full = overlays.length>=MAX_OVERLAYS;
  return <div className={`overlay-inspector${dropping?' is-dropping':''}`}
    onDragOver={event=>{if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();setDropping(true);}}} onDragLeave={()=>setDropping(false)}
    onDrop={event=>{event.preventDefault();setDropping(false);const file=imageFromClipboard(event.dataTransfer);if(file)addImage(file);}}>
    <div className="overlay-card">
      <button className="overlay-add" disabled={adding||full} onClick={()=>input.current?.click()}><EditorIcon name={adding?'refresh':'plus'} size={16}/>{adding?'Adding image…':'Add overlay'}</button>
      <input ref={input} type="file" accept="image/*" hidden aria-label="Choose overlay image" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)addImage(file);}}/>
      <p className="overlay-hint">{full?`You can use up to ${MAX_OVERLAYS} overlays.`:<>Choose an image, drop one here, or press <kbd>Ctrl</kbd>+<kbd>V</kbd> to paste. It starts at the playhead.</>}</p>
    </div>
    {overlays.length>0&&<div className="overlay-card">
      <div className="overlay-card-head">Overlays</div>
      <div className="overlay-list" role="listbox" aria-label="Overlays">{overlays.map((o,i)=><button key={i} role="option" aria-selected={i===index} className="overlay-choice" onClick={()=>select(i)}>
        <img src={overlayUrl(o.imageId)} alt=""/><span><strong>{o.name}</strong><small>{stamp(o.in)} – {stamp(o.out)}</small></span>
      </button>)}</div>
    </div>}
    {current&&<>
      <div className="overlay-card">
        <div className="overlay-card-head">When it shows</div>
        <div className="overlay-times">{(['in','out'] as const).map(edge=><div key={edge} className="overlay-time">
          <span>{edge==='in'?'Start':'End'}</span>
          <TimeField label={`Overlay ${edge==='in'?'start':'end'}`} value={current[edge]} commit={value=>setTime(edge,value)}/>
          <button disabled={edge==='in'?time>=current.out:time<=current.in} onClick={()=>setTime(edge,time)} title={`Set ${edge==='in'?'start':'end'} to the playhead`}>Use playhead</button>
        </div>)}</div>
        <div className="overlay-quick"><button onClick={()=>update({in:0,out:duration})}>Whole video</button></div>
        <small className="overlay-length">Shown for {(current.out-current.in).toFixed(2)} s</small>
      </div>
      <div className="overlay-card">
        <div className="overlay-card-head">Size and position</div>
        <Slider key={"width-"+index} active={active} revision={recipe} onPreview={value=>{if(index!==undefined)preview(index,value===undefined?undefined:{width:value});}} label="Size" value={current.width} min={.02} max={1} step={.005} format={v=>`${Math.round(v*100)}%`} onChange={width=>update({width})}/>
        <Slider key={"x-"+index} active={active} revision={recipe} onPreview={value=>{if(index!==undefined)preview(index,value===undefined?undefined:{x:value});}} label="Horizontal" value={current.x} min={0} max={1} step={.005} format={v=>`${Math.round(v*100)}%`} onChange={x=>update({x})}/>
        <Slider key={"y-"+index} active={active} revision={recipe} onPreview={value=>{if(index!==undefined)preview(index,value===undefined?undefined:{y:value});}} label="Vertical" value={current.y} min={0} max={1} step={.005} format={v=>`${Math.round(v*100)}%`} onChange={y=>update({y})}/>
        <Slider key={"opacity-"+index} active={active} revision={recipe} onPreview={value=>{if(index!==undefined)preview(index,value===undefined?undefined:{opacity:value});}} label="Opacity" value={current.opacity} min={0} max={1} step={.01} format={v=>`${Math.round(v*100)}%`} onChange={opacity=>update({opacity})}/>
        <div className="overlay-quick">
          <button onClick={()=>update({x:.5,y:.5})}>Center</button>
          <button onClick={()=>update({x:.5,width:1})}>Fit width</button>
        </div>
        <p className="overlay-hint">Drag the image on the video to move it; drag a corner to resize.</p>
      </div>
      <div className="overlay-actions">
        <button disabled={full} onClick={duplicate}><EditorIcon name="copy" size={15}/>Duplicate</button>
        <button className="danger-quiet" onClick={remove}><EditorIcon name="trash" size={15} tone="danger"/>Remove overlay</button>
      </div>
    </>}
  </div>;
}
