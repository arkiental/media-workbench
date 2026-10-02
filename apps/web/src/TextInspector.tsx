import React, {useEffect,useState,useRef} from 'react';
import type { Recipe } from '../../../packages/contracts/src/index';
import { captionLayout } from '../../../packages/contracts/src/caption';

function CaptionNumber({label,value,min,onCommit}:{label:string;value:number;min:number;onCommit:(value:number)=>void}){
  const [draft,setDraft]=useState(String(value)),[editing,setEditing]=useState(false);
  const cancelled=useRef(false);
  useEffect(()=>{if(!editing)setDraft(String(value));},[value,editing]);
  const commit=()=>{const parsed=Number(draft),next=!cancelled.current&&draft.trim()&&Number.isFinite(parsed)?Math.max(min,Math.min(200,Math.round(parsed))):value;setDraft(String(next));setEditing(false);if(next!==value)onCommit(next);};
  return <input aria-label={label} type="number" min={min} max={200} value={draft} onFocus={()=>{cancelled.current=false;setEditing(true);}} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){cancelled.current=true;e.currentTarget.blur();}}}/>;
}

export function TextInspector({recipe,change,width}:{recipe:Recipe;change:(recipe:Recipe)=>void;width:number}) {
  const caption=recipe.caption;
  const patch=(next:Partial<NonNullable<Recipe['caption']>>)=>change({...recipe,caption:{text:'',size:32,padding:16,...caption,...next},text:[],captions:[]});
  const layout=captionLayout(caption,width);
  return <section className="text-inspector caption-inspector" aria-label="Caption settings">
    <div className="inspector-heading"><h2>Text</h2></div>
    <label className="check"><input type="checkbox" checked={!!caption} onChange={event=>change({...recipe,text:[],captions:[],caption:event.target.checked?{text:'Your caption',size:32,padding:16}:undefined})}/>Caption above video</label>
    {caption&&<div className="text-properties">
      <label className="field">Caption<textarea aria-label="Caption text" rows={4} maxLength={1000} value={caption.text} onChange={event=>patch({text:event.target.value})}/></label>
      <label className="field">Text size<CaptionNumber label="Caption text size" value={caption.size} min={8} onCommit={size=>patch({size})}/></label>
      <label className="field">Padding<CaptionNumber label="Caption padding" value={caption.padding} min={0} onCommit={padding=>patch({padding})}/></label>
      <output className="caption-height">Adds {layout.height} px above the video</output>
    </div>}
  </section>;
}
