import React, { useState } from 'react';
import type { Overlay } from '../../../packages/contracts/src/index';
import { EditorIcon } from './EditorIcon';
import { overlayLanes, overlayUrl } from './overlay';

type Edge = 'move'|'in'|'out';
type Props = { overlays:Overlay[]; duration:number; selected?:number; editing:boolean; select:(index:number)=>void; add:()=>void; retime:(index:number,range:{in:number;out:number})=>void; seek:(time:number)=>void };
const MIN_LENGTH = .1;

export function OverlayTrack({overlays,duration,selected,editing,select,add,retime,seek}:Props) {
  const [drag,setDrag] = useState<{index:number;in:number;out:number}>();
  const {lanes,count} = overlayLanes(overlays);
  const begin = (event:React.PointerEvent<HTMLElement>, index:number, edge:Edge) => {
    if (event.button!==0) return;
    event.preventDefault(); event.stopPropagation(); select(index);
    const target = event.currentTarget, rect = target.closest('.timeline-media')!.getBoundingClientRect(), o = overlays[index], startX = event.clientX;
    let range = {in:o.in,out:o.out}, moved = false;
    target.setPointerCapture(event.pointerId);
    const move = (pointer:PointerEvent) => {
      const delta = Math.round((pointer.clientX-startX)/rect.width*duration*1000)/1000;
      if (Math.abs(pointer.clientX-startX)>2) moved = true;
      if (edge==='move') { const shift = Math.max(-o.in, Math.min(duration-o.out, delta)); range = {in:o.in+shift,out:o.out+shift}; }
      else if (edge==='in') range = {in:Math.max(0, Math.min(o.out-MIN_LENGTH, o.in+delta)), out:o.out};
      else range = {in:o.in, out:Math.min(duration, Math.max(o.in+MIN_LENGTH, o.out+delta))};
      setDrag({index,...range});
      if (edge!=='move') seek(range[edge]);
    };
    const end = (commit:boolean) => {
      target.removeEventListener('pointermove',move); target.removeEventListener('pointerup',up); target.removeEventListener('pointercancel',cancel); setDrag(undefined);
      if (commit && moved && (range.in!==o.in || range.out!==o.out)) retime(index, range);
      // A plain click on the clip body moves the playhead there, as on the video track.
      else if (commit && !moved && edge==='move') seek(Math.max(o.in, Math.min(o.out-.001, (startX-rect.left)/rect.width*duration)));
    };
    const up = () => end(true), cancel = () => end(false);
    target.addEventListener('pointermove',move); target.addEventListener('pointerup',up); target.addEventListener('pointercancel',cancel);
  };
  const nudge = (event:React.KeyboardEvent<HTMLElement>, index:number, edge:Edge) => {
    if (event.key!=='ArrowLeft' && event.key!=='ArrowRight') return;
    event.preventDefault(); event.stopPropagation();
    const o = overlays[index], step = (event.key==='ArrowLeft'?-1:1)*(event.shiftKey?1:.1);
    if (edge==='move') { const shift = Math.max(-o.in, Math.min(duration-o.out, step)); retime(index,{in:o.in+shift,out:o.out+shift}); }
    else if (edge==='in') retime(index,{in:Math.max(0, Math.min(o.out-MIN_LENGTH, o.in+step)),out:o.out});
    else retime(index,{in:o.in,out:Math.min(duration, Math.max(o.in+MIN_LENGTH, o.out+step))});
  };
  if (!overlays.length) return <div className="overlay-track"><button className="empty-overlay-track" onClick={add}><EditorIcon name="plus" size={14}/>Add overlay</button></div>;
  return <div className="overlay-track" style={{'--lanes':count} as React.CSSProperties}>
    {overlays.map((base,index)=>{
      const o = drag?.index===index ? {...base,...drag} : base, isSelected = selected===index;
      return <div key={index} className={`overlay-clip${isSelected?' is-selected':''}`} style={{left:`${o.in/duration*100}%`,width:`${(o.out-o.in)/duration*100}%`,top:`calc(${lanes[index]} * 100% / var(--lanes))`}}>
        <button className="overlay-clip-body" aria-label={`Overlay ${index+1}: ${o.name}, ${o.in.toFixed(2)} to ${o.out.toFixed(2)} seconds`} aria-pressed={isSelected} title="Drag to change when it shows" onPointerDown={event=>begin(event,index,'move')} onKeyDown={event=>nudge(event,index,'move')} onClick={event=>event.stopPropagation()}>
          <img src={overlayUrl(o.imageId)} alt=""/><span>{o.name}</span>
        </button>
        {isSelected&&editing&&(['in','out'] as const).map(edge=><button key={edge} className={`overlay-trim overlay-trim-${edge}`} role="slider" aria-label={`Overlay ${index+1} ${edge==='in'?'start':'end'}`} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={o[edge]} onPointerDown={event=>begin(event,index,edge)} onKeyDown={event=>nudge(event,index,edge)} onClick={event=>event.stopPropagation()}><span aria-hidden="true"/></button>)}
      </div>;
    })}
  </div>;
}
