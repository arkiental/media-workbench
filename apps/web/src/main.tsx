import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Artifact, Capabilities, Job, Project, Source } from '../../../packages/contracts/src/index';
import { desktopBridge } from '../../../packages/platform/src/index';
import { Field, Panel } from '../../../packages/ui/src/index';
import { api, ApiError } from './api';
import { readPreference, writePreference } from './drafts';
import { Editor } from './Editor';
import { EditorIcon } from './EditorIcon';
import { Input, Library, SavedProjects, Presets, Integrations, Settings, Administration } from './Pages';
import './styles.css';
import './workspace.css';
import './contextual-editor.css';
import './monochrome.css';
import './pages.css';
import './editor.css';
import './responsive.css';
import './library.css';
import './trim.css';
import './layout.css';
import './transform.css';
import './caption.css';
import './refine.css';
import './slider.css';
import './audio.css';
import './overlay.css';
import './link-import.css';

type Task = (work: () => Promise<unknown>) => Promise<void>;
const primaryTabs = ['Library', 'Editor'] as const;
const tabIcons: Record<string, string> = { Library: 'library', Editor: 'editor' };

function App() {
  const [caps, setCaps] = useState<Capabilities>();
  const [token, setToken] = useState('');
  const [authNeeded, setAuthNeeded] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tab, setTab] = useState<string>('Library');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [project, setProject] = useState<Project>();
  const [theme, setTheme] = useState(() => readPreference('mw:theme') || 'dark');
  const [settingsTab, setSettingsTab] = useState('General');

  useEffect(() => { document.documentElement.dataset.theme = theme; writePreference('mw:theme', theme); }, [theme]);
  const navigate = (next: string) => { setNotice(''); setError(''); setTab(next); };
  const openProject = (next: Project) => {
    setProject(next); setSourceId(next.recipe.sourceId); navigate('Editor');
    writePreference('mw:last:' + caps!.user.id, JSON.stringify({ sourceId: next.recipe.sourceId, project: next }));
  };
  const snapshot = React.useRef({ sources: '', artifacts: '', jobs: '' });
  const refresh = async () => {
    const [nextSources, nextArtifacts, nextJobs] = await Promise.all([api.sources(), api.artifacts(), api.jobs()]);
    // Polling returns identical data most of the time; skipping unchanged state avoids re-rendering the whole app.
    const next = { sources: JSON.stringify(nextSources), artifacts: JSON.stringify(nextArtifacts), jobs: JSON.stringify(nextJobs) };
    if (next.sources !== snapshot.current.sources) setSources(nextSources);
    if (next.artifacts !== snapshot.current.artifacts) setArtifacts(nextArtifacts);
    if (next.jobs !== snapshot.current.jobs) setJobs(nextJobs);
    snapshot.current = next;
  };
  const connect = async () => {
    const next = await api.capabilities(); setCaps(next); setAuthNeeded(false); await refresh();
    try {
      const last = JSON.parse(readPreference('mw:last:' + next.user.id) || 'null');
      if (last?.sourceId) {
        setSourceId(last.sourceId);
        if (last.project?.recipe?.sourceId === last.sourceId) setProject((await api.projects()).find(item => item.id === last.project.id));
        setTab('Editor');
      }
    } catch { /* A stale local preference must not prevent opening the workspace. */ }
  };
  const run: Task = async work => {
    setError(''); setNotice(''); setBusy(true);
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  useEffect(() => { connect().catch(cause => {
    if (cause instanceof ApiError && cause.status === 401) setAuthNeeded(true);
    else setError(cause.message);
  }); }, []);
  const hasActiveJobs=jobs.some(job=>!['completed','failed','cancelled','interrupted'].includes(job.state));
  useEffect(() => {
    if (!caps) return;
    let active = true;
    let timer:number;
    const poll=async()=>{try{await refresh();}catch(cause){if(active)setError(`Could not refresh media: ${cause instanceof Error?cause.message:String(cause)}`);}finally{if(active)timer=window.setTimeout(poll,hasActiveJobs?500:5000);}};
    timer=window.setTimeout(poll,hasActiveJobs?500:5000);
    return () => { active = false; clearTimeout(timer); };
  }, [caps,hasActiveJobs]);
  const [dropping, setDropping] = useState(false);
  const importDropped = React.useRef<(files: File[]) => void>(() => {});
  importDropped.current = files => {
    if (!caps?.user.policy.upload) { setError('Import not permitted.'); return; }
    void run(async () => {
      const failed: string[] = []; let last: Source | undefined;
      for (const [index, file] of files.entries()) {
        setNotice(`Importing ${index + 1} of ${files.length}: ${file.name}`);
        try {
          if (file.size > caps.user.policy.maxInputBytes) throw new Error('File exceeds the import limit');
          last = await api.upload(file, progress => setNotice(`Importing ${index + 1} of ${files.length}: ${file.name} — ${progress < 1 ? Math.floor(progress * 100) + '%' : 'Checking media…'}`));
        } catch (cause) { failed.push(`${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
      await refresh();
      if (last) { setNotice(`Imported ${files.length - failed.length} of ${files.length} file${files.length === 1 ? '' : 's'}.`); setTab('Library'); } else setNotice('');
      if (failed.length) throw new Error(failed.join(' · '));
    });
  };
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files');
    let depth = 0;
    const enter = (event: DragEvent) => { if (hasFiles(event)) { depth++; setDropping(true); } };
    const over = (event: DragEvent) => { if (hasFiles(event)) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; } };
    const leave = (event: DragEvent) => { if (hasFiles(event) && --depth <= 0) { depth = 0; setDropping(false); } };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); depth = 0; setDropping(false);
      const files = Array.from(event.dataTransfer?.files || []).filter(file => /^(video|audio)\//.test(file.type) || /\.(mkv|mov|webm|ts|mp4|m4v|avi|mp3|wav|flac|ogg|m4a)$/i.test(file.name));
      if (files.length) importDropped.current(files);
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, []);
  const edit = (id: string) => {
    setProject(undefined); setSourceId(id); navigate('Editor');
    writePreference('mw:last:' + caps!.user.id, JSON.stringify({ sourceId: id }));
  };

  if (!caps) return <main className="login">
    <div className="login-heading"><strong>Media Workbench</strong><span>Local workspace</span></div>
    <h1>{authNeeded ? 'Connect to your workspace' : 'Opening your workspace'}</h1>

    {error && <p role="alert" className="error">{error}</p>}
    {authNeeded ? <form onSubmit={event => { event.preventDefault(); void run(async () => { await api.session(token); setToken(''); await connect(); }); }}>
      <Field label="Access token"><input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required /></Field>
      <button className="primary" disabled={busy || !token}>Connect</button>
      {busy && <p role="status">Connecting…</p>}
    </form> : <p role="status">Connecting…</p>}
  </main>;

  const selected = sources.find(source => source.id === sourceId);
  const selectedArtifact = artifacts.find(artifact => artifact.id === selected?.artifactId);
  const editing = tab === 'Editor' && selected && selectedArtifact;
  const activeJobs = jobs.filter(job => !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.state)).length;
  const navigation = () => primaryTabs.map(next => <button key={next} aria-label={next}
    aria-current={tab === next ? 'page' : undefined} onClick={() => navigate(next)}>
    <EditorIcon name={tabIcons[next]} size={18}/><span>{next}</span>
    {next === 'Library' && activeJobs > 0 && <span className="job-count" aria-hidden="true">{activeJobs}</span>}
  </button>);

  return <div className={`app-shell ${editing ? 'editing-shell' : ''}`}>
    {dropping && <div className="drop-overlay" aria-hidden="true"><EditorIcon name="upload" size={36}/><strong>Drop to import</strong></div>}
    <a className="skip-link" href="#workspace-content">Skip to workspace</a>
    <header className="app-header">
      <div className="brand"><span className="brand-glyph" aria-hidden="true"><EditorIcon name="video" size={16}/></span><strong>Media Workbench</strong></div>
      <nav className="desktop-navigation" aria-label="Main">{navigation()}</nav>
      <div className="shell-actions"><div id="editor-header-actions" />
        <button className="primary import-trigger" aria-current={tab === 'Input' ? 'page' : undefined} onClick={() => navigate('Input')}><EditorIcon name="upload" size={17}/>Import</button>
        <button className="settings-button" aria-label="Settings" title="Settings" aria-current={tab === 'Settings' ? 'page' : undefined} onClick={() => navigate('Settings')}><EditorIcon name="settings" size={18}/><span>Settings</span></button>
      </div>
    </header>
    <main id="workspace-content" tabIndex={-1} data-page={tab} className={editing ? 'editor-main page-content' : 'page-content'} aria-busy={busy}>
      {error && <div role="alert" className="error"><EditorIcon name="alert" size={18}/><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>Dismiss</button></div>}
      {notice && <p role="status" className="notice"><EditorIcon name="saved" size={18} tone="ok"/><span>{notice}</span></p>}
      {tab === 'Input' && <Input caps={caps} run={run} refresh={refresh} done={()=>navigate('Library')} setNotice={setNotice} />}
      {tab === 'Library' && <><div className="page-heading"><div><h1>Library</h1><p>Your videos and their progress, together.</p></div><button onClick={() => void run(refresh)} disabled={busy}><EditorIcon name="refresh" size={16}/>Refresh</button></div>
        <Library jobs={jobs} onImport={()=>navigate('Input')} sources={sources} artifacts={artifacts} run={run} refresh={refresh} edit={edit} setNotice={setNotice} /><details className="library-projects"><summary>Saved projects</summary><SavedProjects run={run} onProject={openProject} /></details></>}
      {tab === 'Editor' && (editing ? <Editor jobs={jobs} key={sourceId + '-' + (project?.id || '')} source={selected} artifact={selectedArtifact} sources={sources} artifacts={artifacts} caps={caps} project={project} run={run} refresh={refresh} setNotice={setNotice} />
        : <section className="empty-state editor-empty"><span className="empty-glyph" aria-hidden="true"><EditorIcon name="editor" size={28}/></span><span className="empty-label">Editor</span><h1>Choose a video to edit</h1><p>Import a file or pick something from your library to start cutting, captioning and exporting.</p><div className="actions"><button className="primary" onClick={() => navigate('Input')}><EditorIcon name="plus" size={17}/>Import</button><button onClick={() => navigate('Library')}><EditorIcon name="library" size={17}/>Open library</button></div></section>)}
      {tab === 'Settings' && <><div className="page-heading"><div><h1>Settings</h1></div></div>
        <nav className="settings-nav" aria-label="Settings">{['General', 'Presets', 'Integrations', ...(caps.user.role === 'owner' ? ['Administration'] : [])].map(next => <button key={next} aria-current={settingsTab === next ? 'page' : undefined} onClick={() => setSettingsTab(next)}>{next}</button>)}</nav>
        {settingsTab === 'General' && <div className="general-settings-layout"><Panel title="Appearance"><Field label="Color theme"><select value={theme} onChange={event => setTheme(event.target.value)}><option value="system">Follow system</option><option value="light">White</option><option value="dark">Black</option></select></Field></Panel><Settings caps={caps} run={run} setNotice={setNotice} /></div>}
        {settingsTab === 'Presets' && <Presets run={run} onProject={openProject} />}
        {settingsTab === 'Integrations' && <Integrations caps={caps} run={run} setNotice={setNotice} />}
        {settingsTab === 'Administration' && caps.user.role === 'owner' && <Administration run={run} setNotice={setNotice} />}
      </>}
    </main>
    <footer className="workspace-footer"><span><EditorIcon name="monitor" size={14}/>{desktopBridge() ? 'Desktop' : caps.mode === 'shared' ? 'Shared workspace' : 'Local workspace'}</span><span><EditorIcon name="user" size={14}/>{caps.user.name}</span></footer>
    <nav className="mobile-navigation" aria-label="Mobile">{navigation()}</nav>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
