import React,{useEffect,useRef,useState} from 'react';
import type {Recipe} from '../../../packages/contracts/src/index';
import {defaultTextStyle} from './TextInspector';
type Props={recipe:Recipe;time:number;selected:number;active:boolean;select:(index:number)=>void;change:(recipe:Recipe)=>void;width:number;height:number;fit:string};
export function CanvasText({recipe,time,selected,active,select,change,width,height,fit}:Props){
  const root=useRef<HTMLDivElement>(null);const [bounds,setBounds]=useState({width:0,height:0});
  const [drag,setDrag]=useState<{index:number;x:number;y:number;size:number}>();
  useEffect(()=>{if(!root.current)return;const observer=new ResizeObserver(([entry])=>setBounds({width:entry.contentRect.width,height:entry.contentRect.height}));observer.observe(root.current);return()=>observer.disconnect();},[]);
  const scale=fit==='fill'?Math.max(bounds.width/width,bounds.height/height):Math.min(bounds.width/width,bounds.height/height);
  const scaledWidth=width*scale,scaledHeight=height*scale,left=(bounds.width-scaledWidth)/2,top=(bounds.height-scaledHeight)/2;
  const begin=(e:React.PointerEvent<HTMLButtonElement>,index:number,corner?:string)=>{
    if(e.button!==0)return;e.stopPropagation();select(index);e.currentTarget.setPointerCapture(e.pointerId);
    const style={...defaultTextStyle,...recipe.text[index].style},startX=e.clientX,startY=e.clientY;
    let current={index,x:style.x,y:style.y,size:style.size};
    const target=e.currentTarget;
    const move=(event:PointerEvent)=>{const dx=(event.clientX-startX)*(corner?.endsWith('w')?-1:1),dy=(event.clientY-startY)*(corner?.startsWith('n')?-1:1);current=corner?{...current,size:Math.max(8,Math.min(400,Math.round(style.size+(dx+dy)/2/Math.max(scale,.01))))}:{...current,x:Math.max(0,Math.min(1,style.x+(event.clientX-startX)/scaledWidth)),y:Math.max(0,Math.min(1,style.y+(event.clientY-startY)/scaledHeight))};setDrag(current)};
    const finish=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',finish);target.removeEventListener('pointercancel',cancel);setDrag(undefined);if(current.x!==style.x||current.y!==style.y||current.size!==style.size)change({...recipe,text:recipe.text.map((c,i)=>i===index?{...c,style:{...style,x:current.x,y:current.y,size:current.size}}:c)})};
    const cancel=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',finish);target.removeEventListener('pointercancel',cancel);setDrag(undefined)};
    target.addEventListener('pointermove',move);target.addEventListener('pointerup',finish);target.addEventListener('pointercancel',cancel);
  };
  const moveWithKeys=(event:React.KeyboardEvent<HTMLButtonElement>,index:number)=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    const style={...defaultTextStyle,...recipe.text[index].style},amount=event.shiftKey?.01:.001;
    const x=Math.max(0,Math.min(1,style.x+(event.key==='ArrowLeft'?-amount:event.key==='ArrowRight'?amount:0))),y=Math.max(0,Math.min(1,style.y+(event.key==='ArrowUp'?-amount:event.key==='ArrowDown'?amount:0)));
    change({...recipe,text:recipe.text.map((cue,i)=>i===index?{...cue,style:{...style,x,y}}:cue)});
  };
  const resizeWithKeys=(event:React.KeyboardEvent<HTMLButtonElement>,index:number)=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    const style={...defaultTextStyle,...recipe.text[index].style},amount=event.shiftKey?10:1;
    const size=event.key==='Home'?8:event.key==='End'?400:Math.max(8,Math.min(400,style.size+(['ArrowRight','ArrowUp'].includes(event.key)?amount:-amount)));
    change({...recipe,text:recipe.text.map((cue,i)=>i===index?{...cue,style:{...style,size}}:cue)});
  };
  return <div ref={root} className="canvas-text-layer" aria-label="Text overlays">{recipe.text.map((cue,index)=>{
    if(time<cue.in||time>=cue.out)return null;
    const style={...defaultTextStyle,...cue.style,...(drag?.index===index?drag:{})},isSelected=active&&index===selected;
    // Old, unstyled cues retain their legacy top-centered layout until styled.
    const x=cue.style?style.x:.5,y=cue.style?style.y:0;
    return <div key={index} onClick={e=>e.stopPropagation()} className={`canvas-title ${isSelected?'is-selected':''}`} style={{left:left+x*scaledWidth,top:top+y*scaledHeight+(cue.style?0:12*scale),transform:`translate(${style.align==='left'?0:style.align==='right'?-100:-50}%,${cue.style?-50:0}%)`,fontFamily:cue.style?style.font:'Arial',fontWeight:cue.style&&style.font==='Playfair Display'?700:400,fontSize:(cue.style?style.size:Math.max(10,Math.min(24,Math.floor(width/20),Math.floor(height/10))))*scale,color:style.color,textAlign:style.align}}>
      <button className="canvas-title-content" aria-label={`Select text overlay ${index+1}: ${cue.text||'Untitled'}`} onClick={e=>{e.stopPropagation();select(index)}} onPointerDown={e=>begin(e,index)} onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const amount=e.shiftKey ? .01 : .001;change({...recipe,text:recipe.text.map((c,i)=>i===index?{...c,style:{...style,x:Math.max(0,Math.min(1,style.x+(e.key==='ArrowLeft'?-amount:e.key==='ArrowRight'?amount:0))),y:Math.max(0,Math.min(1,style.y+(e.key==='ArrowUp'?-amount:e.key==='ArrowDown'?amount:0)))}}:c)})}}>{cue.text||'Your text'}</button>
      {isSelected&&<><span className="selection-stem"/>{['nw','ne','sw','se'].map(corner=><button key={corner} className={`selection-handle ${corner}`} role="slider" aria-label={`Resize text ${corner}`} aria-valuemin={8} aria-valuemax={400} aria-valuenow={style.size} aria-valuetext={`${style.size} pixels`} onPointerDown={e=>begin(e,index,corner)} onKeyDown={e=>resizeWithKeys(e,index)}/>)}<button className="selection-handle top" aria-label="Move selected text" onPointerDown={e=>begin(e,index)} onKeyDown={e=>moveWithKeys(e,index)}/></>}
    </div>
  })}</div>;
}
