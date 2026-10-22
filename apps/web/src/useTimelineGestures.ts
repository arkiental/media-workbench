import {useEffect,useRef, type PointerEvent, type MouseEvent, type RefObject} from 'react';

/** Touch navigation never edits the recipe. Mouse and keyboard keep their normal behavior. */
export function useTimelineGestures({enabled,scroll,zoom,onZoom,onNavigate,onTap}:{enabled:boolean;scroll:RefObject<HTMLDivElement|null>;zoom:number;onZoom:(zoom:number,anchor:{fraction:number;offset:number})=>void;onNavigate:()=>void;onTap:(target:HTMLElement,x:number)=>boolean}) {
  const points=useRef(new Map<number,{x:number;y:number}>());
  const gesture=useRef<{x:number;y:number;left:number;top:number;distance?:number;zoom:number;fraction?:number}|undefined>(undefined);
  const suppressUntil=useRef(0);
  const moved=useRef(false),tapTarget=useRef<HTMLElement|null>(null),suppressedPointers=useRef(new Set<number>());
  useEffect(()=>{
    const clear=()=>{points.current.clear();gesture.current=undefined;tapTarget.current=null;moved.current=false;suppressUntil.current=0;};
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
    if(!points.current.size){suppressUntil.current=0;suppressedPointers.current.clear();moved.current=false;tapTarget.current=event.target as HTMLElement;}
    points.current.set(event.pointerId,{x:event.clientX,y:event.clientY});reset();
    if(points.current.size>1){moved.current=true;event.preventDefault();suppressUntil.current=performance.now()+300;onNavigate();}
  };
  const onPointerMove=(event:PointerEvent<HTMLDivElement>)=>{
    if(!points.current.has(event.pointerId))return;
    const el=scroll.current,start=gesture.current;if(!el||!start)return;
    points.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const values=[...points.current.values()];
    if(values.length>1&&start.distance){
      moved.current=true;
      event.preventDefault();el.setPointerCapture(event.pointerId);suppressUntil.current=performance.now()+300;onNavigate();
      const distance=Math.hypot(values[1].x-values[0].x,values[1].y-values[0].y);
      const next=Math.max(1,Math.min(20,Math.round(start.zoom*distance/start.distance*20)/20));
      onZoom(next,{fraction:start.fraction!,offset:(values[0].x+values[1].x)/2-el.getBoundingClientRect().left});
    }else if(Math.abs(event.clientX-start.x)>6||Math.abs(event.clientY-start.y)>6){
      moved.current=true;
      event.preventDefault();el.setPointerCapture(event.pointerId);suppressUntil.current=performance.now()+300;onNavigate();
      el.scrollLeft=start.left+start.x-event.clientX;
      if(el.parentElement)el.parentElement.scrollTop=start.top+start.y-event.clientY;
    }
  };
  // Touch can deliver pointer-up without a compatibility click after panning.
  const finish=(event:PointerEvent<HTMLDivElement>,commit=false)=>{
    const start=gesture.current;
    const tap=commit&&points.current.size===1&&!moved.current&&start&&Math.abs(event.clientX-start.x)<=6&&Math.abs(event.clientY-start.y)<=6;
    if(!points.current.delete(event.pointerId))return;
    const target=tapTarget.current;
    const blockClick=moved.current||!commit||(tap&&target&&onTap(target,event.clientX));
    if(blockClick){suppressedPointers.current.add(event.pointerId);suppressUntil.current=performance.now()+300;}
    if(!commit)moved.current=true;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    reset();
  };
  return {onPointerDown,onPointerMove,onPointerUp:(event:PointerEvent<HTMLDivElement>)=>finish(event,true),onPointerCancel:(event:PointerEvent<HTMLDivElement>)=>finish(event),onLostPointerCapture:(event:PointerEvent<HTMLDivElement>)=>{if(event.target===event.currentTarget)finish(event);},onClickCapture:(event:MouseEvent<HTMLDivElement>)=>{
    const native=event.nativeEvent as globalThis.PointerEvent;
    if(enabled&&event.detail!==0&&native.pointerType!=='mouse'&&(native.pointerId===undefined||suppressedPointers.current.has(native.pointerId))&&performance.now()<suppressUntil.current){event.preventDefault();event.stopPropagation();}
  }};
}
