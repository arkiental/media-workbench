import {useEffect,useRef, type PointerEvent, type MouseEvent, type RefObject} from 'react';

/** Touch navigation never edits the recipe. Mouse and keyboard keep their normal behavior. */
export function useTimelineGestures({enabled,scroll,zoom,onZoom,onNavigate}:{enabled:boolean;scroll:RefObject<HTMLDivElement|null>;zoom:number;onZoom:(zoom:number,anchor:{fraction:number;offset:number})=>void;onNavigate:()=>void}) {
  const points=useRef(new Map<number,{x:number;y:number}>());
  const gesture=useRef<{x:number;y:number;left:number;top:number;distance?:number;zoom:number;fraction?:number}|undefined>(undefined);
  const suppressUntil=useRef(0);
  useEffect(()=>{
    const clear=()=>{points.current.clear();gesture.current=undefined;};
    clear();window.addEventListener('blur',clear);
    return()=>{clear();window.removeEventListener('blur',clear);};
  },[enabled]);
  const reset=()=>{
    const el=scroll.current,values=[...points.current.values()];if(!el||!values.length){gesture.current=undefined;return;}
    const middle=values.length>1?(values[0].x+values[1].x)/2:values[0].x;
    gesture.current={x:middle,y:values[0].y,left:el.scrollLeft,top:el.parentElement?.scrollTop||0,zoom,distance:values.length>1?Math.max(1,Math.hypot(values[1].x-values[0].x,values[1].y-values[0].y)):undefined,fraction:(el.scrollLeft+middle-el.getBoundingClientRect().left)/el.scrollWidth};
  };
  const onPointerDown=(event:PointerEvent<HTMLDivElement>)=>{
    if(!enabled||event.pointerType!=='touch'||(event.target as HTMLElement).closest('.trim-handle,.overlay-trim,.overlay-clip-body,.timeline-ruler,.scrubber'))return;
    if(!points.current.size)suppressUntil.current=0;
    points.current.set(event.pointerId,{x:event.clientX,y:event.clientY});reset();
    if(points.current.size>1){event.preventDefault();suppressUntil.current=performance.now()+300;onNavigate();}
  };
  const onPointerMove=(event:PointerEvent<HTMLDivElement>)=>{
    if(!points.current.has(event.pointerId))return;
    const el=scroll.current,start=gesture.current;if(!el||!start)return;
    points.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const values=[...points.current.values()];
    if(values.length>1&&start.distance){
      event.preventDefault();el.setPointerCapture(event.pointerId);suppressUntil.current=performance.now()+300;onNavigate();
      const distance=Math.hypot(values[1].x-values[0].x,values[1].y-values[0].y);
      const next=Math.max(1,Math.min(20,Math.round(start.zoom*distance/start.distance*20)/20));
      onZoom(next,{fraction:start.fraction!,offset:(values[0].x+values[1].x)/2-el.getBoundingClientRect().left});
    }else if(Math.abs(event.clientX-start.x)>6||Math.abs(event.clientY-start.y)>6){
      event.preventDefault();el.setPointerCapture(event.pointerId);suppressUntil.current=performance.now()+300;onNavigate();
      el.scrollLeft=start.left+start.x-event.clientX;
      if(el.parentElement)el.parentElement.scrollTop=start.top+start.y-event.clientY;
    }
  };
  const finish=(event:PointerEvent<HTMLDivElement>)=>{
    if(!points.current.delete(event.pointerId))return;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    reset();
  };
  return {onPointerDown,onPointerMove,onPointerUp:finish,onPointerCancel:finish,onLostPointerCapture:(event:PointerEvent<HTMLDivElement>)=>{if(event.target===event.currentTarget)finish(event);},onClickCapture:(event:MouseEvent<HTMLDivElement>)=>{
    if(enabled&&performance.now()<suppressUntil.current){suppressUntil.current=0;event.preventDefault();event.stopPropagation();}
  }};
}
