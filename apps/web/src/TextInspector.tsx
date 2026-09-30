import React from 'react';
import type { Recipe } from '../../../packages/contracts/src/index';
import { EditorIcon } from './EditorIcon';

export const defaultTextStyle={font:'Arial' as const,size:64,color:'#FFFFFF',align:'center' as const,x:.5,y:.2};
type Props={recipe:Recipe;selected:number;select:(index:number)=>void;change:(recipe:Recipe)=>void;time:number;duration:number;advanced:React.ReactNode};

export function TextInspector({recipe,selected,select,change,time,duration,advanced}:Props){
  const cue=recipe.text[selected];
  const patch=(data:Partial<Recipe['text'][number]>)=>change({...recipe,text:recipe.text.map((c,i)=>i===selected?{...c,...data}:c)});
  const style={...defaultTextStyle,...cue?.style};
  const setStyle=(data:Partial<typeof style>)=>patch({style:{...style,...data}});
  const pickColor=async()=>{
    const EyeDropper=(window as unknown as {EyeDropper?:new()=>{open:()=>Promise<{sRGBHex:string}>}}).EyeDropper;
    if(!EyeDropper)return;
    try{setStyle({color:(await new EyeDropper().open()).sRGBHex.toUpperCase()});}catch{/* Closing the native picker leaves the current color unchanged. */}
  };
  const add=()=>{
    const start=Math.min(time,Math.max(0,duration-.1));
    change({...recipe,text:[...recipe.text,{in:start,out:Math.min(start+4,duration),text:'Your text',style:defaultTextStyle}]});
    select(recipe.text.length);
  };
  return <section className="text-inspector" aria-label="Text properties">
    <div className="inspector-heading"><h2>Text</h2><button aria-label="Add text overlay at playhead" onClick={add}>Add text</button></div>
    {recipe.text.length>0&&<div className="text-layer-list" aria-label="Text layers">{recipe.text.map((c,i)=><button key={i} aria-label={`Select text ${i+1}`} aria-pressed={i===selected} onClick={()=>select(i)}><EditorIcon name="text"/><span>{c.text||`Text ${i+1}`}</span></button>)}</div>}
    {cue?<div className="text-properties">
      <label className="text-content-label" htmlFor="selected-text-content">Text</label>
      <textarea id="selected-text-content" aria-label={`Text overlay ${selected+1} text`} maxLength={cue.style?Math.max(500,cue.text.length):4000} rows={2} value={cue.text} onChange={e=>patch({text:e.target.value})}/>
      <div className="text-timing form-grid">
        <label className="field">Start (s)<input aria-label={`Text overlay ${selected+1} in`} type="number" inputMode="decimal" min={0} max={cue.out-.001} step=".001" value={cue.in} onChange={e=>{const n=e.target.valueAsNumber;if(Number.isFinite(n)&&n>=0&&n<cue.out)patch({in:n});}}/></label>
        <label className="field">End (s)<input aria-label={`Text overlay ${selected+1} out`} type="number" inputMode="decimal" min={cue.in+.001} max={duration} step=".001" value={cue.out} onChange={e=>{const n=e.target.valueAsNumber;if(Number.isFinite(n)&&n>cue.in&&n<=duration)patch({out:n});}}/></label>
      </div>
      <label className="property-row"><span>Font</span><select aria-label="Text font" value={style.font} onChange={e=>setStyle({font:e.target.value as typeof style.font})}><option>Arial</option><option>Playfair Display</option></select></label>
      <label className="property-row"><span>Size</span><input aria-label="Text size" type="number" inputMode="numeric" min={8} max={400} value={style.size} onChange={e=>{if(Number.isFinite(e.target.valueAsNumber))setStyle({size:Math.max(8,Math.min(400,e.target.valueAsNumber))});}}/></label>
      <div className="property-row"><span>Color</span><span className="color-control"><input aria-label="Text color" type="color" value={style.color} onChange={e=>setStyle({color:e.target.value.toUpperCase()})}/><span>{style.color}</span><button aria-label="Pick color from screen" title={'EyeDropper' in window?'Pick color from screen':'Use the color swatch to choose a color'} disabled={!('EyeDropper' in window)} onClick={()=>void pickColor()}><EditorIcon name="eyedropper"/></button></span></div>
      <div className="property-row"><span>Align</span><div className="alignment-controls" role="group" aria-label="Text alignment">{(['left','center','right'] as const).map(align=><button key={align} aria-label={`Align text ${align}`} aria-pressed={style.align===align} onClick={()=>setStyle({align})}><EditorIcon name={align}/></button>)}<button aria-label="Center text in frame" title="Center text in frame" onClick={()=>setStyle({align:'center',x:.5,y:.5})}><EditorIcon name="justify"/></button></div></div>
      <div className="text-position form-grid">{(['x','y'] as const).map(axis=><label className="field" key={axis}>{axis.toUpperCase()} position (%)<input aria-label={`Text position ${axis}`} type="number" inputMode="decimal" min={0} max={100} value={Math.round(style[axis]*100)} onChange={e=>setStyle({[axis]:Math.max(0,Math.min(1,e.target.valueAsNumber/100||0))})}/></label>)}</div>
      <button className="remove-text" aria-label="Remove text overlay" onClick={()=>{change({...recipe,text:recipe.text.filter((_,i)=>i!==selected)});select(Math.max(0,selected-1));}}><EditorIcon name="trash"/>Remove text</button>
    </div>:<div className="text-empty"><p>Add text at the playhead. Set its start, end and position here.</p></div>}
    <details className="text-advanced"><summary>Captions and advanced</summary>{advanced}</details>
  </section>;
}
