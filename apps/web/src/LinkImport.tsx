import React, { useState, useEffect } from 'react';
import {desktopBridge} from '../../../packages/platform/src/index';
import { bytes } from '../../../packages/ui/src/index';
import { EditorIcon } from './EditorIcon';
import { formatRows } from './downloadQuality';

type Filter = 'video'|'audio'|'all';
export type LinkImportProps = {
  url:string; setUrl:(value:string)=>void; canInspect:boolean; canDownload:boolean; working?:string; error:string;
  metadata?:any; entry?:any; itemIndex:number; setItemIndex:(index:number)=>void;
  format:string; setFormat:(format:string)=>void;
  inspect:()=>void; download:(format:string,kind:'video'|'audio',fileName:string,destinationId?:string)=>void; duration:(seconds:number)=>string; children?:React.ReactNode;
};

const views=(count:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(count);
const published=(raw?:string)=>raw?new Date(Date.UTC(+raw.slice(0,4),+raw.slice(4,6)-1,+raw.slice(6,8))).toLocaleDateString('en',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'}):'';
const size=(value?:number)=>value?`~ ${bytes(value)}`:'Unknown';

export function LinkImport(p:LinkImportProps) {
  const [filter,setFilter]=useState<Filter>('all');
  const rows=formatRows(p.entry?.formats||[]);
  const visible=rows.filter(row=>filter==='all'||row.kind===filter);
  const selected=rows.find(row=>row.format===p.format)||rows[0];
  const m=p.metadata,title=p.entry?.title||m?.title||'';
  const [fileName,setFileName]=useState(''),[destination,setDestination]=useState<{id:string;label:string}>(),[folderError,setFolderError]=useState('');
  useEffect(()=>setFileName(title.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,160)),[title,p.itemIndex]);
  const chooseFolder=async()=>{try{setFolderError('');const selected=await desktopBridge()?.chooseDownloadFolder?.();if(selected)setDestination(selected);}catch(error){setFolderError(error instanceof Error?error.message:String(error));}};
  const total=p.entry?.duration??m?.duration;
  const busy=!!p.working;
  return <div className="link-import">
    <div className="li-head"><div><h1>Download from YouTube</h1><p>Paste a link below to download video or audio. Supports YouTube and many other sites.</p></div>
      <a className="li-button" href="https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md" target="_blank" rel="noreferrer noopener"><EditorIcon name="globe" size={20}/>Supported sites</a></div>
    <section className="li-step"><h2><span>1.</span> Paste link</h2>
      <form className="li-paste" onSubmit={e=>{e.preventDefault();if(p.canInspect&&!busy)p.inspect();}}>
        <label className="li-url"><EditorIcon name="link" size={20}/><input aria-label="Video or audio links" type="url" value={p.url} onChange={e=>p.setUrl(e.target.value)} placeholder="Paste a video or audio link" autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
          {p.url&&<button type="button" className="li-clear" aria-label="Clear link" onClick={()=>p.setUrl('')}><EditorIcon name="close" size={18}/></button>}</label>
        <button className="li-inspect" type="submit" disabled={!p.canInspect||busy}><EditorIcon name="search" size={20}/>{p.working==='inspect'?'Inspecting…':'Inspect media'}</button>
      </form>
      {p.error&&<p role="alert" className="li-error">{p.error}</p>}
      {!p.canDownload&&<p className="permission-note">Download not permitted.</p>}
    </section>
    {m&&<>
      <section className="li-step"><h2><span>2.</span> Media found</h2>
        {m.entries?.length>1&&<label className="li-item">Item <select value={p.itemIndex} onChange={e=>{p.setItemIndex(Number(e.target.value));p.setFormat('');}}>{m.entries.map((e:any)=><option key={e.itemIndex} value={e.itemIndex}>{e.itemIndex}. {e.title||e.id||'Media'}</option>)}</select></label>}
        <div className="li-found">
          <div className="li-thumb" aria-hidden="true">{m.thumbnail?<img src={m.thumbnail} alt=""/>:<EditorIcon name="play" size={34}/>}{typeof total==='number'&&<span>{p.duration(total)}</span>}</div>
          <div className="li-info"><h3>{title}</h3>
            <p className="li-meta">{[m.uploader,typeof m.viewCount==='number'&&`${views(m.viewCount)} views`,m.uploadDate&&`Published on ${published(m.uploadDate)}`].filter(Boolean).map((part,i)=><React.Fragment key={i}>{i>0&&<i aria-hidden="true">•</i>}<span>{part}</span></React.Fragment>)}</p>
            {m.description&&<p className="li-desc">{m.description}</p>}
            <div className="li-tags">{m.site&&<span><EditorIcon name="camera" size={20}/>{m.site}</span>}{rows.some(r=>r.kind==='audio')&&<span><EditorIcon name="music" size={20}/>Music</span>}{typeof total==='number'&&<span><EditorIcon name="clock" size={20}/>{p.duration(total)}</span>}</div>
          </div>
        </div>
      </section>
      <section className="li-step li-formats"><div className="li-step-head"><h2><span>3.</span> Choose format &amp; quality</h2>
        <div className="li-filters" role="group" aria-label="Format type">{([['video','camera','Video'],['audio','music','Audio'],['all','layers','All formats']] as const).map(([id,icon,label])=><button key={id} type="button" aria-pressed={filter===id} onClick={()=>setFilter(id)}><EditorIcon name={icon} size={20}/>{label}</button>)}</div></div>
        <div className="li-table" role="radiogroup" aria-label="Format and quality">
          <div className="li-row li-th" aria-hidden="true"><span/><span>Format</span><span>Quality</span><span>Resolution</span><span>Codec</span><span>File size</span></div>
          {visible.map(row=><label key={row.key} className={`li-row${selected?.key===row.key?' is-selected':''}`}>
            <input type="radio" name="download-format" checked={selected?.key===row.key} onChange={()=>p.setFormat(row.format)}/><i className="li-radio" aria-hidden="true"/>
            <span className="li-format"><b>{row.ext||'—'}</b>{row.tier&&<em>{row.tier}</em>}</span>
            <strong className="li-quality">{row.quality}</strong><span data-label="Resolution">{row.resolution}</span><span data-label="Codec">{row.codec||'—'}</span><span data-label="Size">{size(row.bytes)}</span>
          </label>)}
          {!visible.length&&<p className="li-empty">{rows.length?'No formats of this type are available.':'No downloadable formats were reported. The default quality will be used.'}</p>}
        </div>
      </section>
      <section className="li-step"><h2><span>4.</span> Download</h2>
        <div className="li-save">
          <label className="li-name"><input aria-label="File name" maxLength={160} value={fileName} disabled={busy} onChange={e=>setFileName(e.target.value)} placeholder="Video name"/><span>{selected?.ext?`.${selected.kind==='video'&&selected.format.includes('+')?'mkv':selected.ext.toLowerCase()}`:''}</span></label>
          <div className="li-dest"><EditorIcon name="folder" size={22}/><span title={destination?.label}>{destination?.label||'Library'}</span><button type="button" disabled={busy||!desktopBridge()?.chooseDownloadFolder} title={desktopBridge()?.chooseDownloadFolder?'Choose a folder; a copy also stays in Library':'Use the desktop app to choose a folder'} onClick={()=>void chooseFolder()}>Change</button>{destination&&<button type="button" disabled={busy} onClick={()=>setDestination(undefined)}>Reset</button>}</div>
          <button className="li-go" type="button" disabled={!p.canDownload||busy||!fileName.trim()||/[\\/:*?"<>|\x00-\x1f]/.test(fileName)} onClick={()=>p.download(selected?.format||'',selected?.kind||'video',fileName.trim(),destination?.id)}><EditorIcon name="download" size={30}/><span><b>{p.working==='download'?'Queueing…':'Download'}</b>{selected?.bytes?<small>{size(selected.bytes)}</small>:null}</span></button>
        </div>
        {folderError&&<p role="alert">{folderError}</p>}{!desktopBridge()?.chooseDownloadFolder&&<p>Downloads stay in Library. Use Download file afterward to save through your browser.</p>}
      </section></>}
    {p.children}
  </div>;
}
