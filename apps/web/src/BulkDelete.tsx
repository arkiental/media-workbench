import React, { useRef, useState } from 'react';

type Item = {id:string;name:string;disabled?:boolean;original?:boolean;history?:boolean};

export function useBulkDelete({items,scope,kind,remove,refresh,setNotice,beforeOpen}:{items:Item[];scope:string;kind:'files'|'jobs'|'items';remove:(item:Item)=>Promise<unknown>;refresh:()=>Promise<void>;setNotice:(text:string)=>void;beforeOpen?:()=>void}) {
  const [selection,setSelection]=useState<{scope:string;ids:Set<string>}>({scope,ids:new Set()});
  const [targets,setTargets]=useState<Item[]>([]),[errors,setErrors]=useState<string[]>([]),[busy,setBusy]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null),locked=useRef(false);
  const eligible=items.filter(item=>!item.disabled);
  const selected=eligible.filter(item=>selection.scope===scope&&selection.ids.has(item.id));
  const all=eligible.length>0&&selected.length===eligible.length;
  const toggle=(id:string)=>setSelection(previous=>{const ids=new Set(previous.scope===scope?previous.ids:[]);if(ids.has(id))ids.delete(id);else ids.add(id);return {scope,ids};});
  const open=(items:Item[])=>{beforeOpen?.();setTargets(items);setErrors([]);dialog.current?.showModal();};
  const title=kind==='items'?'Delete selected items?':kind==='files'?'Delete selected files?':'Delete selected job history?';
  const fileCount=targets.filter(item=>!item.history).length,historyCount=targets.length-fileCount;
  const clear=()=>setSelection({scope,ids:new Set()});
  const confirm=async()=>{
    if(locked.current||!targets.length)return;
    locked.current=true;setBusy(true);setErrors([]);
    const failed:Item[]=[],messages:string[]=[],deleted=new Set<string>();
    for(const item of targets){
      try{await remove(item);deleted.add(item.id);}
      catch(error){failed.push(item);messages.push(`${item.name}: ${error instanceof Error?error.message:String(error)}`);}
    }
    setSelection(previous=>({scope:previous.scope,ids:new Set([...previous.ids].filter(id=>!deleted.has(id)))}));
    setTargets(failed);
    try{await refresh();}catch(error){messages.push(`Could not refresh the list: ${error instanceof Error?error.message:String(error)}`);}
    setErrors(messages);
    if(deleted.size)setNotice(`Deleted ${deleted.size} ${kind==='items'?(deleted.size===1?'item':'items'):kind==='files'?(deleted.size===1?'library file':'library files'):(deleted.size===1?'job history entry':'job history entries')}.`);
    locked.current=false;setBusy(false);
    if(!messages.length)dialog.current?.close();
  };
  const checkbox=(item:Item)=><label className="item-select-hit" title={item.disabled?(item.history?'Only finished jobs can be deleted':'Pinned media is protected'):`Select ${item.name}`}><input type="checkbox" className="item-select" aria-label={`Select ${item.name}`} disabled={item.disabled||busy} checked={!item.disabled&&selection.scope===scope&&selection.ids.has(item.id)} onChange={()=>toggle(item.id)}/></label>;
  const controls=<>
    <div className="bulk-toolbar">
      <label><input type="checkbox" aria-label="Select all visible" ref={node=>{if(node)node.indeterminate=selected.length>0&&!all;}} checked={all} disabled={!eligible.length||busy} onChange={()=>all?clear():setSelection({scope,ids:new Set(eligible.map(item=>item.id))})}/>Select all visible</label>
      <span aria-live="polite">{selected.length} selected</span>
      {selected.length>0&&<button className="quiet" disabled={busy} onClick={clear}>Clear selection</button>}
      <button className="danger-quiet" disabled={!selected.length||busy} onClick={()=>open(selected)}>Delete selected</button>
      <small>{kind==='items'?'Active tasks and pinned files are protected.':kind==='files'?'Pinned files are excluded.':'Finished jobs only. Media files are kept.'}</small>
    </div>
    <dialog ref={dialog} className="library-delete-dialog bulk-delete-dialog" aria-label={title} onCancel={event=>{if(locked.current)event.preventDefault();}}>
      <h2>{title}</h2>
      <p>{kind==='items'?`${fileCount?`Permanently delete ${fileCount} library ${fileCount===1?'file':'files'}. `:''}${historyCount?`Remove ${historyCount} activity ${historyCount===1?'entry':'entries'}. `:''}Original files on your computer are kept. Deleting activity keeps its media files.`:kind==='files'?'This permanently deletes the selected library files. Your original imported files and job history are kept.':'This deletes the selected job history entries. All media files are kept.'}</p>
      <ul className="bulk-delete-list">{targets.map(item=><li key={item.id}>{item.name}{kind==='items'&&<small>{item.history?'Activity only':'Library file'}</small>}</li>)}</ul>
      {errors.length>0&&<div role="alert" className="error"><p>{targets.length?'Some items could not be deleted. Successful deletions have been removed from the selection.':'The items were deleted, but the list could not be refreshed.'}</p><ul>{errors.map((error,index)=><li key={index}>{error}</li>)}</ul></div>}
      <div className="actions"><button autoFocus disabled={busy} onClick={()=>dialog.current?.close()}>{errors.length?'Close':'Cancel'}</button><button className="library-delete-confirm" disabled={busy||!targets.length} onClick={()=>void confirm()}>{busy?'Deleting…':`Delete ${targets.length} ${kind==='items'?(targets.length===1?'item':'items'):kind==='files'?(targets.length===1?'file':'files'):(targets.length===1?'job':'jobs')}`}</button></div>
    </dialog>
  </>;
  return {checkbox,controls,clear,open};
}
