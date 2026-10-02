import React from 'react';
import type { Recipe } from '../../../packages/contracts/src/index';
import { captionLayout } from '../../../packages/contracts/src/caption';

export function TextInspector({recipe,change,width}:{recipe:Recipe;change:(recipe:Recipe)=>void;width:number}) {
  const caption=recipe.caption;
  const patch=(next:Partial<NonNullable<Recipe['caption']>>)=>change({...recipe,caption:{text:'',size:32,padding:16,...caption,...next},text:[],captions:[]});
  const layout=captionLayout(caption,width);
  return <section className="text-inspector caption-inspector" aria-label="Caption settings">
    <div className="inspector-heading"><h2>Text</h2></div>
    <label className="check"><input type="checkbox" checked={!!caption} onChange={event=>change({...recipe,text:[],captions:[],caption:event.target.checked?{text:'Your caption',size:32,padding:16}:undefined})}/>Caption above video</label>
    {caption&&<div className="text-properties">
      <label className="field">Caption<textarea aria-label="Caption text" rows={4} maxLength={1000} value={caption.text} onChange={event=>patch({text:event.target.value})}/></label>
      <label className="field">Text size<input aria-label="Caption text size" type="number" min={8} max={200} value={caption.size} onChange={event=>{const value=event.target.valueAsNumber;if(Number.isFinite(value))patch({size:Math.max(8,Math.min(200,Math.round(value)))});}}/></label>
      <label className="field">Padding<input aria-label="Caption padding" type="number" min={0} max={200} value={caption.padding} onChange={event=>{const value=event.target.valueAsNumber;if(Number.isFinite(value))patch({padding:Math.max(0,Math.min(200,Math.round(value)))});}}/></label>
      <output className="caption-height">Adds {layout.height} px above the video</output>
    </div>}
  </section>;
}
