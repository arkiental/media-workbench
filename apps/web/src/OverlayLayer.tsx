import React, { useRef, useState } from 'react';
import type { Overlay } from '../../../packages/contracts/src/index';
import { overlayUrl, visibleAt } from './overlay';

type Props = { overlays:Overlay[]; time:number; selected?:number; editing:boolean; select:(index:number)=>void; commit:(index:number,patch:Partial<Overlay>)=>void };
type Gesture = { pointer:number; index:number; mode:'move'|'scale'; startX:number; startY:number; origin:Overlay; rect:DOMRect; centerX:number; centerY:number; halfWidth:number; halfHeight:number; patch:Partial<Overlay> };
const corners = ['nw','ne','se','sw'] as const;
const SNAP_PX = 8;

// Positioned in the output picture's own box, so percentages match the export's fractions exactly.
export function OverlayLayer({overlays,time,selected,editing,select,commit}:Props) {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture|undefined>(undefined);
  const [draft,setDraft] = useState<{index:number;patch:Partial<Overlay>}>();
  const [guides,setGuides] = useState<{x:boolean;y:boolean}>({x:false,y:false});
  const begin = (event:React.PointerEvent<HTMLElement>, index:number, mode:Gesture['mode']) => {
    if (event.button!==0 || !root.current) return;
    event.preventDefault(); event.stopPropagation();
    if (selected!==index || !editing) { select(index); if (mode==='scale') return; }
    const box = event.currentTarget.closest('.overlay-item')!.getBoundingClientRect(), rect = root.current.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {pointer:event.pointerId,index,mode,startX:event.clientX,startY:event.clientY,origin:overlays[index],rect,centerX:box.left+box.width/2,centerY:box.top+box.height/2,halfWidth:box.width/2,halfHeight:box.height/2,patch:{}};
  };
  const move = (event:React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || g.pointer!==event.pointerId) return;
    event.stopPropagation();
    if (g.mode==='move') {
      let x = g.origin.x+(event.clientX-g.startX)/g.rect.width, y = g.origin.y+(event.clientY-g.startY)/g.rect.height;
      // Snap the centre to the picture's centre lines so centring is effortless.
      const snapX = Math.abs(x-.5)*g.rect.width<SNAP_PX, snapY = Math.abs(y-.5)*g.rect.height<SNAP_PX;
      if (snapX) x = .5; if (snapY) y = .5;
      g.patch = {x:Math.max(-1,Math.min(2,x)),y:Math.max(-1,Math.min(2,y))}; setGuides({x:snapX,y:snapY});
    } else {
      const factor = Math.max(Math.abs(event.clientX-g.centerX)/g.halfWidth, Math.abs(event.clientY-g.centerY)/g.halfHeight);
      g.patch = {width:Math.max(.01,Math.min(4,g.origin.width*factor))};
    }
    setDraft({index:g.index,patch:g.patch});
  };
  const finish = (event:React.PointerEvent<HTMLElement>, cancel=false) => {
    const g = gesture.current;
    if (!g || g.pointer!==event.pointerId) return;
    event.stopPropagation(); gesture.current = undefined; setDraft(undefined); setGuides({x:false,y:false});
    if (!cancel && Object.keys(g.patch).length) commit(g.index, g.patch);
  };
  const keyboard = (event:React.KeyboardEvent<HTMLElement>, index:number) => {
    const o = overlays[index], step = event.shiftKey ? .05 : .01, clamp = (v:number) => Math.max(-1,Math.min(2,Math.round(v*1000)/1000));
    const dx = event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0, dy = event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;
    if (!dx && !dy) return;
    event.preventDefault(); event.stopPropagation();
    commit(index, {x:clamp(o.x+dx), y:clamp(o.y+dy)});
  };
  const handlers = (index:number, mode:Gesture['mode']) => ({onPointerDown:(e:React.PointerEvent<HTMLElement>)=>begin(e,index,mode),onPointerMove:move,onPointerUp:(e:React.PointerEvent<HTMLElement>)=>finish(e),onPointerCancel:(e:React.PointerEvent<HTMLElement>)=>finish(e,true),onLostPointerCapture:()=>{gesture.current=undefined;setDraft(undefined);setGuides({x:false,y:false});}});
  return <div ref={root} className="overlay-layer" onClick={event=>{if((event.target as HTMLElement).closest('.overlay-item'))event.stopPropagation();}}>
    {guides.x&&<i className="overlay-guide overlay-guide-x" aria-hidden="true"/>}
    {guides.y&&<i className="overlay-guide overlay-guide-y" aria-hidden="true"/>}
    {overlays.map((base,index)=>{
      const o = draft?.index===index ? {...base,...draft.patch} : base;
      const visible = visibleAt(o,time), isSelected = editing && selected===index;
      // The selected overlay stays editable outside its time range, shown faintly.
      if (!visible && !isSelected) return null;
      return <div key={index} className={`overlay-item${isSelected?' is-selected':''}${visible?'':' is-outside'}`} style={{left:`${o.x*100}%`,top:`${o.y*100}%`,width:`${o.width*100}%`,zIndex:index+1}}>
        <img src={overlayUrl(o.imageId)} alt="" draggable={false} style={{opacity:visible?o.opacity:Math.min(.35,o.opacity)}}/>
        <button className="overlay-move" aria-label={`Move overlay ${index+1}: ${o.name}`} title={isSelected?'Drag to move · arrow keys nudge':`Select ${o.name}`} onKeyDown={event=>keyboard(event,index)} onFocus={()=>{if(!isSelected)select(index);}} {...handlers(index,'move')}/>
        {isSelected&&corners.map(corner=><span key={corner} className={`overlay-handle overlay-${corner}`} aria-hidden="true" {...handlers(index,'scale')}/>)}
        {isSelected&&!visible&&<span className="overlay-outside-note">Not shown at playhead</span>}
      </div>;
    })}
  </div>;
}
