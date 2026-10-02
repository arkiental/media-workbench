import React, { useEffect, useRef, useState } from 'react';
import { EditorIcon } from './EditorIcon';

let pendingThumbnail:Promise<unknown>=Promise.resolve();

async function loadThumbnail(id:string,signal:AbortSignal):Promise<Blob>{
  for(let attempt=0;attempt<4;attempt++){
    const response=await fetch(`/api/v1/artifacts/${id}/thumbnail`,{signal,credentials:'same-origin'});
    if(response.ok)return response.blob();
    if(response.status!==429||attempt===3)throw new Error('Thumbnail unavailable');
    await new Promise(resolve=>setTimeout(resolve,1000));
    signal.throwIfAborted();
  }
  throw new Error('Thumbnail unavailable');
}

export function LibraryThumbnail({id,name,duration,onPreview}:{id:string;name:string;duration:string;onPreview:()=>void}){
  const element=useRef<HTMLDivElement>(null);
  const [url,setUrl]=useState(''),[failed,setFailed]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let objectUrl='',started=false;
    setUrl('');setFailed(false);
    const observer=new IntersectionObserver(entries=>{
      if(started||!entries.some(entry=>entry.isIntersecting))return;
      started=true;observer.disconnect();
      pendingThumbnail=pendingThumbnail.catch(()=>{}).then(async()=>{
        if(controller.signal.aborted)return;
        try{
          const blob=await loadThumbnail(id,controller.signal);
          if(controller.signal.aborted)return;
          objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);
        }catch{if(!controller.signal.aborted)setFailed(true);}
      });
    },{rootMargin:'240px'});
    if(element.current)observer.observe(element.current);
    return()=>{controller.abort();observer.disconnect();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[id,revision]);
  return <div className="library-thumbnail" ref={element}>
    <button className="library-thumbnail-preview" onClick={onPreview} aria-label={`Preview ${name}`}>
      {url&&!failed?<img src={url} alt={`Video thumbnail for ${name}`} onError={()=>setFailed(true)}/>:<span className="thumbnail-placeholder">{failed?'Preview unavailable':'Loading preview…'}</span>}
      <span className="thumbnail-duration">{duration}</span>
      {url&&!failed&&<span className="thumbnail-play" aria-hidden="true"><EditorIcon name="play" size={16}/></span>}
    </button>
    {failed&&<button className="thumbnail-retry" onClick={()=>setRevision(value=>value+1)}>Retry thumbnail</button>}
  </div>;
}
