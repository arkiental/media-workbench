import { useEffect, useState } from 'react';
import type { Artifact } from '../../../packages/contracts/src/index';
import { desktopBridge, browserCapabilities } from '../../../packages/platform/src/index';
import { contentUrl } from './api';
import { EditorIcon } from './EditorIcon';

type Task = (work:()=>Promise<unknown>)=>Promise<void>;

export function ArtifactActions({artifact,run,setNotice}:{artifact:Artifact;run:Task;setNotice:(s:string)=>void}) {
  const bridge=desktopBridge();const [native,setNative]=useState<Record<string,{state:string;reason?:string}>>(browserCapabilities),[actions,setActions]=useState<any[]>([]);
  useEffect(()=>{if(bridge){bridge.capabilities().then(setNative).catch(()=>{});bridge.listActions().then(setActions).catch(()=>{});}},[]);
  const perform=(work:()=>Promise<unknown>,message:string)=>void run(async()=>{await work();setNotice(message);});
  return <div className="actions"><a href={contentUrl(artifact.id)} download={artifact.name}><EditorIcon name="download" size={16}/>Download file</a>{bridge&&<><button disabled={native.fileClipboard?.state!=='available'} title={native.fileClipboard?.reason} onClick={()=>perform(()=>bridge.copyFile(artifact.id),'File copied.')}>Copy file</button><button onClick={()=>perform(()=>bridge.copyPath(artifact.id),'Path copied.')}>Copy path</button><button disabled={native.revealFile?.state!=='available'} onClick={()=>perform(()=>bridge.reveal(artifact.id),'Opened file location.')}>Reveal</button><button onClick={()=>perform(()=>bridge.saveAs(artifact.id),'Save dialog closed.')}>Save as</button><button disabled={native.nativeDragOut?.state!=='available'} draggable={native.nativeDragOut?.state==='available'} onDragStart={e=>{e.preventDefault();bridge.dragOut(artifact.id);}}>Drag file out</button>{actions.map(a=><button key={a.id} onClick={()=>void run(async()=>{const result=await bridge.runAction(a.id,artifact.id) as {cancelled?:boolean};setNotice(result?.cancelled?'External action cancelled.':'App finished; upload unconfirmed.');})}>{a.name}{a.uploads?' (upload handoff)':''}</button>)}</>}</div>;
}
