import React, {useEffect,useRef,useState} from 'react';
import type {Artifact,Project,Source} from '../../../packages/contracts/src/index';
import {Panel} from '../../../packages/ui/src/index';
import {api,saveJson} from './api';
import {readPreference,writePreference} from './drafts';
import {EditorIcon} from './EditorIcon';
import './saved-projects.css';

type Props={mediaLoaded:boolean;sources:Source[];artifacts:Artifact[];ownerId:string;onProject:(project:Project)=>void};
export function SavedProjects({mediaLoaded,sources,artifacts,ownerId,onProject}:Props){
  const preference=`mw:last:saved-projects:${ownerId}`;
  const [view,setView]=useState(()=>{try{const saved=JSON.parse(readPreference(preference)||'{}');return {query:typeof saved.query==='string'?saved.query:'',sort:saved.sort==='name'?'name':'recent'};}catch{return {query:'',sort:'recent'};}});
  const [projects,setProjects]=useState<Project[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[deleting,setDeleting]=useState<string>();
  const mounted=useRef(true),busy=useRef(false),deleteBusy=useRef(false);
  const load=async()=>{
    if(busy.current||deleteBusy.current)return;busy.current=true;setLoading(true);setError('');
    try{const rows=await api.projects();if(mounted.current)setProjects(rows);}
    catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{busy.current=false;if(mounted.current)setLoading(false);}
  };
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;};},[]);
  useEffect(()=>writePreference(preference,JSON.stringify(view)),[preference,view]);
  const remove=async(project:Project)=>{
    if(deleteBusy.current||busy.current)return;deleteBusy.current=true;setDeleting(project.id);setError('');
    try{await api.remove(`/projects/${project.id}`);if(mounted.current){setProjects(rows=>rows.filter(row=>row.id!==project.id));}}
    catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{deleteBusy.current=false;if(mounted.current)setDeleting(undefined);}
  };
  const sourceFor=(project:Project)=>sources.find(source=>source.id===project.recipe.sourceId);
  const query=view.query.trim().toLocaleLowerCase();
  const filtered=projects.filter(project=>[project.name,sourceFor(project)?.name||''].some(value=>value.toLocaleLowerCase().includes(query))).sort((a,b)=>view.sort==='name'?a.name.localeCompare(b.name)||a.id.localeCompare(b.id):b.updatedAt.localeCompare(a.updatedAt)||a.name.localeCompare(b.name));
  return <div className="projects-page"><Panel title="Saved projects">
    <div className="saved-project-tools"><label>Search saved projects<input type="search" value={view.query} placeholder="Project or source name" onChange={event=>setView({...view,query:event.target.value})}/></label><label>Sort saved projects<select aria-label="Sort saved projects" value={view.sort} onChange={event=>setView({...view,sort:event.target.value})}><option value="recent">Recently updated</option><option value="name">Name A-Z</option></select></label><button disabled={loading||!!deleting} onClick={()=>void load()}>{loading?'Refreshing…':'Refresh projects'}</button></div>
    {loading&&<p role="status">Loading saved projects…</p>}
    {error&&<div role="alert" className="saved-project-error"><p>Saved projects could not be updated: {error}</p><button disabled={loading||!!deleting} onClick={()=>void load()}>Retry projects</button></div>}
    {!loading&&!error&&projects.length===0&&<p>No saved projects yet. Use Project in the Editor to save a named edit.</p>}
    {!loading&&projects.length>0&&<p role="status">{filtered.length} of {projects.length} saved projects</p>}
    {!loading&&projects.length>0&&!filtered.length&&<div className="saved-project-empty"><p>No projects match “{view.query}”.</p><button onClick={()=>setView({...view,query:''})}>Clear project search</button></div>}
    <div className="project-list">{filtered.map(project=>{
      const source=sourceFor(project),available=!!source&&artifacts.some(artifact=>artifact.id===source.artifactId&&artifact.validated);
      const duration=project.recipe.segments.reduce((total,segment)=>total+segment.out-segment.in,0);
      return <article className="row project-row" key={project.id} aria-label={`Project ${project.name}`}><div className="project-name"><strong>{project.name}</strong><span className="saved-project-source">Source: {source?.name||(mediaLoaded?'Unavailable source':'Checking source…')}</span><small>{project.recipe.segments.length} {project.recipe.segments.length===1?'section':'sections'} | {duration.toFixed(2)} seconds kept</small><small>Updated {new Date(project.updatedAt).toLocaleString()}</small>{!mediaLoaded&&<p role="status">Checking source availability…</p>}{mediaLoaded&&!available&&<p className="saved-project-unavailable">Source media is unavailable. Your saved edit is retained; download its settings to keep a copy.</p>}</div><div className="actions"><button disabled={!mediaLoaded||!available} onClick={()=>onProject(project)}><EditorIcon name="folder" size={16}/>Load project</button><details className="project-manage"><summary>More</summary><button onClick={()=>saveJson(`${project.name}-edit.json`,{recipe:project.recipe,options:project.options})}>Download edit settings</button><button className="quiet" disabled={!!deleting||loading} onClick={()=>void remove(project)}>{deleting===project.id?'Deleting…':'Delete project recipe'}</button></details></div></article>;
    })}</div>
  </Panel></div>;
}
