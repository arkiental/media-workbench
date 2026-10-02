import type { Recipe } from '../../../packages/contracts/src/index';

export function initialRecipe(sourceId:string,duration:number): Recipe {
  return {schemaVersion:1,sourceId,segments:[{in:0,out:duration}],rotate:0,text:[],captions:[],subtitleMode:'burn',overlays:[],audio:{mode:'keep',track:0,volume:1,fadeIn:0,fadeOut:0,normalize:false}};
}
export function removeInterval(recipe:Recipe,start:number,end:number):Recipe {
  if(end<=start) throw new Error('Removal end must be after start.');
  const segments=recipe.segments.flatMap(s=> end<=s.in || start>=s.out ? [s] : [{in:s.in,out:Math.min(start,s.out)},{in:Math.max(end,s.in),out:s.out}].filter(p=>p.out>p.in));
  if(!segments.length) throw new Error('At least one segment must remain.');
  return {...recipe,segments};
}
export function parseCaptions(text:string):Recipe['captions'] {
  const time=(t:string)=> { const p=t.replace(',','.').split(':').map(Number); if(p.length<2 || p.some(v=>!Number.isFinite(v))) throw new Error('Invalid caption timestamp.'); return p.reduce((a,n)=>a*60+n,0); };
  return text.replace(/^\uFEFF/,'').replace(/\r/g,'').split(/\n\s*\n/).flatMap(block=> {
    const lines=block.trim().split('\n'); const i=lines.findIndex(l=>l.includes('-->')); if(i<0) return [];
    const match=lines[i].match(/^([\d:.,]+)\s+-->\s+([\d:.,]+)(?:\s.*)?$/); if(!match) throw new Error('Invalid SRT/VTT cue.');
    const cue={in:time(match[1]),out:time(match[2]),text:lines.slice(i+1).join('\n')};
    if(cue.out<=cue.in) throw new Error('Caption end must be after start.'); return [cue];
  });
}
export function captionsToSrt(captions:Recipe['captions']) {
  const time=(n:number)=> { const ms=Math.round(n*1000); return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`; };
  return captions.map((c,i)=>`${i+1}\n${time(c.in)} --> ${time(c.out)}\n${c.text}`).join('\n\n')+'\n';
}
