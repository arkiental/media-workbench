import React, { useEffect, useRef, useState } from 'react';
import type { Recipe } from '../../../packages/contracts/src/index';
import { EditorIcon } from './EditorIcon';
import { angle, clampCrop, dragCrop, outputSize, rotationMatrix, sourcePoint, viewportGeometry, type Crop, type Matrix } from './transform';

type Props = { recipe:Recipe; change:(recipe:Recipe)=>void; width:number; height:number; sourceRotation:number; active:boolean; editingCrop:boolean; fit:string; children:React.ReactNode; pictureLayer?:React.ReactNode };
const cssMatrix = (matrix:Matrix) => `matrix(${matrix.a},${matrix.b},${matrix.c},${matrix.d},${matrix.x},${matrix.y})`;
const handles = [['nw','top left'],['n','top'],['ne','top right'],['e','right'],['se','bottom right'],['s','bottom'],['sw','bottom left'],['w','left']] as const;

export function TransformViewport({recipe,change,width,height,sourceRotation,active,editingCrop,fit,children,pictureLayer}:Props) {
  const root = useRef<HTMLDivElement>(null);
  const [bounds,setBounds] = useState({width:0,height:0});
  const [drag,setDrag] = useState<Crop>();
  const gesture = useRef<{ pointer:number; handle:string; start:{x:number;y:number}; crop:Crop; current:Crop; matrix:Matrix; left:number; top:number } | undefined>(undefined);
  const latest = useRef(recipe);
  latest.current = recipe;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setBounds({width:entry.contentRect.width,height:entry.contentRect.height}));
    observer.observe(element);
    return () => observer.disconnect();
  },[]);
  useEffect(() => { gesture.current=undefined; setDrag(undefined); },[recipe.crop,recipe.rotate,recipe.resize,active,editingCrop]);
  const crop = drag || clampCrop(recipe.crop || {x:0,y:0,width,height},width,height);
  const geometry = viewportGeometry(recipe,width,height,bounds.width,bounds.height,editingCrop,fit==='fill',sourceRotation);
  const oriented = angle(sourceRotation)%180===90;
  const decodedWidth = oriented ? height : width;
  const decodedHeight = oriented ? width : height;
  const normalization = rotationMatrix(sourceRotation,decodedWidth,decodedHeight);
  const scaleX = Math.hypot(geometry.transform.a,geometry.transform.b) || 1;
  const scaleY = Math.hypot(geometry.transform.c,geometry.transform.d) || 1;
  const targetSize = window.matchMedia('(max-width:850px)').matches ? 44 : 24;
  const handleStyle = (handle:string):React.CSSProperties => {
    const horizontal=handle.includes('w')?(crop.x*scaleX<targetSize/2?'0%':'-50%'):handle.includes('e')?((width-crop.x-crop.width)*scaleX<targetSize/2?'-100%':'-50%'):'-50%';
    const vertical=handle.includes('n')?(crop.y*scaleY<targetSize/2?'0%':'-50%'):handle.includes('s')?((height-crop.y-crop.height)*scaleY<targetSize/2?'-100%':'-50%'):'-50%';
    const swapped=angle(recipe.rotate-sourceRotation)%180===90;
    const cursor=handle.length===2?(handle==='nw'||handle==='se'?(swapped?'nesw-resize':'nwse-resize'):(swapped?'nwse-resize':'nesw-resize')):handle==='n'||handle==='s'?(swapped?'ew-resize':'ns-resize'):(swapped?'ns-resize':'ew-resize');
    return {width:targetSize/scaleX,height:targetSize/scaleY,transform:`translate(${horizontal},${vertical})`,cursor};
  };
  const begin = (event:React.PointerEvent<HTMLButtonElement>,handle:string) => {
    if (event.button!==0 || !bounds.width || !bounds.height) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const box = root.current!.getBoundingClientRect();
    const left = box.left+geometry.left, top=box.top+geometry.top;
    gesture.current = {pointer:event.pointerId,handle,start:sourcePoint(geometry.transform,event.clientX-left,event.clientY-top),crop,current:crop,matrix:geometry.transform,left,top};
  };
  const move = (event:React.PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointer!==event.pointerId) return;
    event.stopPropagation();
    const point = sourcePoint(current.matrix,event.clientX-current.left,event.clientY-current.top);
    current.current = dragCrop(current.crop,current.handle,point.x-current.start.x,point.y-current.start.y,width,height);
    setDrag(current.current);
  };
  const finish = (event:React.PointerEvent<HTMLButtonElement>,cancel=false) => {
    const current = gesture.current;
    if (!current || current.pointer!==event.pointerId) return;
    event.stopPropagation(); gesture.current=undefined; setDrag(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && JSON.stringify(current.current)!==JSON.stringify(current.crop)) change({...latest.current,crop:current.current});
  };
  const keyboard = (event:React.KeyboardEvent<HTMLButtonElement>,handle:string) => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const amount=event.shiftKey?10:1;
    const screenX=event.key==='ArrowLeft'?-amount:event.key==='ArrowRight'?amount:0;
    const screenY=event.key==='ArrowUp'?-amount:event.key==='ArrowDown'?amount:0;
    const inverse = rotationMatrix(-angle(recipe.rotate-sourceRotation),0,0);
    change({...recipe,crop:dragCrop(crop,handle,inverse.a*screenX+inverse.c*screenY,inverse.b*screenX+inverse.d*screenY,width,height)});
  };
  const events = (handle:string) => ({onPointerDown:(event:React.PointerEvent<HTMLButtonElement>)=>begin(event,handle),onPointerMove:move,onPointerUp:(event:React.PointerEvent<HTMLButtonElement>)=>finish(event),onPointerCancel:(event:React.PointerEvent<HTMLButtonElement>)=>finish(event,true),onLostPointerCapture:()=>{gesture.current=undefined;setDrag(undefined);},onKeyDown:(event:React.KeyboardEvent<HTMLButtonElement>)=>keyboard(event,handle),onClick:(event:React.MouseEvent)=>event.stopPropagation()});
  return <div ref={root} className="transform-viewport" data-view={editingCrop?'crop':'result'} onKeyDown={event=>{if(event.key==='Escape'&&gesture.current){event.preventDefault();event.stopPropagation();gesture.current=undefined;setDrag(undefined);}}}>
    <div className="transform-frame" style={{left:geometry.left,top:geometry.top,width:geometry.width,height:geometry.height}}>
      <div className="transform-source" style={{width,height,transform:cssMatrix(geometry.transform)}}>
        <div className="transform-decoded" style={{width:decodedWidth,height:decodedHeight,transform:cssMatrix(normalization)}}>{children}</div>
        {active&&editingCrop&&<div className="viewport-crop-box" style={{left:crop.x,top:crop.y,width:crop.width,height:crop.height,borderWidth:1/scaleX}}>
          <button className="viewport-crop-move" aria-label="Move crop area" {...events('move')}><span className="crop-thirds" aria-hidden="true"/></button>
          {handles.filter(([handle])=>handle.length===2||(handle==='n'||handle==='s'?crop.width*scaleX:crop.height*scaleY)>=targetSize*3).map(([handle,label])=><button key={handle} className={`viewport-crop-handle crop-${handle}`} aria-label={`Crop ${label} handle`} style={handleStyle(handle)} {...events(handle)}/>)}
        </div>}
      </div>
      {pictureLayer&&!editingCrop&&<div className="viewport-picture" style={{top:geometry.header.height*geometry.scale,width:geometry.width,height:geometry.height-geometry.header.height*geometry.scale}}>{pictureLayer}</div>}
      {geometry.header.height>0&&<div className="viewport-caption" aria-label="Video caption" style={{width:geometry.output.width,height:geometry.header.height,fontSize:geometry.header.size,lineHeight:`${geometry.header.lineHeight}px`,padding:geometry.header.padding,transform:`scale(${geometry.scale})`}}>{geometry.header.text}</div>}
    </div>
  </div>;
}

export const even = (value:number) => Math.max(2,Math.min(7680,Math.round(value/2)*2));
export const presets = [['100%',1],['75%',.75],['50%',.5],['25%',.25]] as const;

export function SizeInput({label,value,onCommit}:{label:string;value:number;onCommit:(value:number)=>void}) {
  const [text,setText] = useState(String(value));
  useEffect(()=>setText(String(value)),[value]);
  const commit = () => { const parsed=Number(text); if(Number.isFinite(parsed)&&parsed>0)onCommit(even(parsed)); else setText(String(value)); };
  return <input aria-label={label} title={label} inputMode="numeric" value={text} onChange={event=>setText(event.target.value.replace(/\D/g,''))} onBlur={commit} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commit();}if(event.key==='Escape'){setText(String(value));event.currentTarget.blur();}}}/>;
}

export function ViewportTransformControls({recipe,change,width,height,sourceRotation,editingCrop,setEditingCrop}:{recipe:Recipe;change:(recipe:Recipe)=>void;width:number;height:number;sourceRotation:number;editingCrop:boolean;setEditingCrop:(value:boolean)=>void}) {
  const [locked,setLocked] = useState(true);
  const output = outputSize(recipe,width,height,sourceRotation);
  const natural = outputSize({...recipe,resize:undefined},width,height,sourceRotation);
  const ratio = natural.width/natural.height;
  const setResize = (next:{width:number;height:number}|undefined) => change({...recipe,resize:next&&(next.width===natural.width&&next.height===natural.height?undefined:next)});
  const setWidth = (value:number) => setResize({width:even(value),height:locked?even(value/ratio):output.height});
  const setHeight = (value:number) => setResize({width:locked?even(value*ratio):output.width,height:even(value)});
  const scaled = (factor:number) => setResize({width:even(natural.width*factor),height:even(natural.height*factor)});
  const heights = [1080,720,480].filter(h=>h<natural.height);
  const current = recipe.resize ? `${recipe.resize.width}x${recipe.resize.height}` : 'original';
  const matches = presets.find(([,factor])=>even(natural.width*factor)===output.width&&even(natural.height*factor)===output.height);
  const rotate = (delta:number) => change({...recipe,rotate:angle(recipe.rotate+delta) as Recipe['rotate']});
  return <div className="viewport-transform-controls" role="group" aria-label="Viewport transforms" onClick={event=>event.stopPropagation()}>
    <div className="vt-group" role="group" aria-label="Crop and rotate">
      <button className="vt-button" aria-label="Toggle viewport crop" aria-pressed={!!recipe.crop} onClick={()=>{change({...recipe,crop:recipe.crop?undefined:{x:0,y:0,width,height}});setEditingCrop(!recipe.crop);}}><EditorIcon name="crop" size={16}/><span>Crop</span></button>
      {recipe.crop&&<button className="vt-button" aria-label="Toggle crop result" aria-pressed={!editingCrop} onClick={()=>setEditingCrop(!editingCrop)}><EditorIcon name={editingCrop?'ok':'crop'} size={16}/><span>{editingCrop?'Show result':'Edit crop'}</span></button>}
      <span className="vt-divider" aria-hidden="true"/>
      <button className="vt-button vt-icon" aria-label="Rotate left" title="Rotate left 90°" onClick={()=>rotate(-90)}><EditorIcon name="rotate-left" size={17}/></button>
      <output className="vt-readout" aria-label="Viewport rotation">{recipe.rotate}°</output>
      <button className="vt-button vt-icon" aria-label="Rotate right" title="Rotate right 90°" onClick={()=>rotate(90)}><EditorIcon name="rotate-right" size={17}/></button>
    </div>
    <div className="vt-group vt-resize" role="group" aria-label="Resize">
      <EditorIcon name="resize" size={16}/>
      <select className="vt-select" aria-label="Viewport resize preset" value={current} onChange={event=>{const value=event.target.value;if(value==='original')setResize(undefined);else if(value.startsWith('scale:'))scaled(Number(value.slice(6)));else if(value.startsWith('h:'))setHeight(Number(value.slice(2)));}}>
        <option value="original">Original size</option>
        {presets.slice(1).map(([label,factor])=><option key={label} value={`scale:${factor}`}>{label}</option>)}
        {heights.map(h=><option key={h} value={`h:${h}`}>{h}p</option>)}
        {recipe.resize&&!matches&&!heights.some(h=>even(h*ratio)===recipe.resize!.width&&h===recipe.resize!.height)&&<option value={current}>Custom</option>}
      </select>
      <SizeInput label="Viewport output width" value={output.width} onCommit={setWidth}/><span className="vt-times" aria-hidden="true">×</span><SizeInput label="Viewport output height" value={output.height} onCommit={setHeight}/>
      <button className="vt-button vt-icon" aria-label="Lock aspect ratio" aria-pressed={locked} title={locked?'Aspect ratio locked':'Aspect ratio unlocked'} onClick={()=>setLocked(!locked)}><EditorIcon name={locked?'lock':'unlock'} size={16}/></button>
      <button className="vt-button vt-icon" aria-label="Reset size" title="Reset to original size" disabled={!recipe.resize} onClick={()=>setResize(undefined)}><EditorIcon name="reset" size={16}/></button>
    </div>
  </div>;
}
