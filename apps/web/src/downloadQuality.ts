type Format = {id:string;width?:number;height?:number;vcodec?:string;acodec?:string;ext?:string;tbr?:number;fps?:number;bytes?:number|null};
export function downloadQualities(formats:Format[],compatible:boolean) {
  const groups=new Map<number,Format[]>();
  for(const format of formats) {
    if(!format.width||!format.height||!format.vcodec||format.vcodec==='none')continue;
    const resolution=Math.min(format.width,format.height);
    if(!groups.has(resolution))groups.set(resolution,[]);
    groups.get(resolution)!.push(format);
  }
  const audio=formats.some(format=>format.acodec&&format.acodec!=='none'&&format.vcodec==='none');
  return [...groups].sort(([left],[right])=>left-right).map(([resolution,choices])=>{
    choices.sort((left,right)=>(compatible?Number(right.ext==='mp4')-Number(left.ext==='mp4'):0)||(right.tbr||0)-(left.tbr||0)||(right.fps||0)-(left.fps||0));
    const chosen=choices[0];
    return {label:resolution===2160?'4K':`${resolution}p`,format:chosen.acodec==='none'&&audio?`${chosen.id}+bestaudio/${chosen.id}`:chosen.id};
  });
}

export type FormatRow = {key:string;format:string;kind:'video'|'audio';ext:string;tier:string;quality:string;resolution:string;codec:string;bytes?:number};
const tiers=['Best quality','High quality','Standard','Low'];
const codecName=(codec?:string)=>!codec||codec==='none'?'':codec.startsWith('avc1')?'H.264':codec.startsWith('mp4a')?'AAC':codec.startsWith('vp09')||codec.startsWith('vp9')?'VP9':codec.startsWith('av01')?'AV1':codec.startsWith('hev')||codec.startsWith('hvc')?'H.265':codec==='opus'?'Opus':codec.split('.')[0].toUpperCase();
/** One selectable row per resolution (best encode first), followed by the best audio-only streams. */
export function formatRows(formats:Format[]):FormatRow[] {
  const audioOnly=formats.filter(f=>f.acodec&&f.acodec!=='none'&&(!f.vcodec||f.vcodec==='none')).sort((a,b)=>(b.tbr||0)-(a.tbr||0));
  const groups=new Map<number,Format[]>();
  for(const f of formats) {
    if(!f.width||!f.height||!f.vcodec||f.vcodec==='none')continue;
    const resolution=Math.min(f.width,f.height);
    groups.set(resolution,[...(groups.get(resolution)||[]),f]);
  }
  const video=[...groups].sort(([a],[b])=>b-a).map(([resolution,choices],index):FormatRow=>{
    choices.sort((a,b)=>Number(b.ext==='mp4')-Number(a.ext==='mp4')||(b.tbr||0)-(a.tbr||0)||(b.fps||0)-(a.fps||0));
    const chosen=choices[0],needsAudio=chosen.acodec==='none'&&audioOnly.length>0;
    const bytes=chosen.bytes?chosen.bytes+(needsAudio?audioOnly[0].bytes||0:0):undefined;
    const codec=[codecName(chosen.vcodec),codecName(needsAudio?audioOnly[0].acodec:chosen.acodec)].filter(Boolean).join(' / ');
    return {key:chosen.id,format:needsAudio?`${chosen.id}+bestaudio/${chosen.id}`:chosen.id,kind:'video',ext:(chosen.ext||'').toUpperCase(),tier:chosen.ext==='mp4'||!chosen.ext?(tiers[index]||''):'',quality:resolution===2160?'4K':`${resolution}p`,resolution:`${chosen.width} × ${chosen.height}`,codec,bytes};
  });
  const seen=new Set<string>(),audio:FormatRow[]=[];
  for(const f of audioOnly) {
    const ext=(f.ext||'').toUpperCase();
    if(seen.has(ext)||audio.length>=2)continue;
    seen.add(ext);
    audio.push({key:f.id,format:f.id,kind:'audio',ext,tier:'Audio only',quality:'',resolution:'—',codec:`${codecName(f.acodec)}${f.tbr?` (${Math.round(f.tbr)} kbps)`:''}`,bytes:f.bytes||undefined});
  }
  return [...video,...audio];
}
