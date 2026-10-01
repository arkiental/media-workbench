import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Artifact, Capabilities, Job, Project, Source } from '../../../packages/contracts/src/index';
import { desktopBridge } from '../../../packages/platform/src/index';
import { Field, Panel } from '../../../packages/ui/src/index';
import { api, ApiError } from './api';
import { readPreference, writePreference } from './drafts';
import { Editor } from './Editor';
import { Input, Queue, Library, SavedProjects, Presets, Integrations, Settings, Administration } from './Pages';
import './styles.css';
import './workspace.css';
import './contextual-editor.css';
import './monochrome.css';
import './pages.css';
import './editor.css';
import './responsive.css';

type Task = (work: () => Promise<unknown>) => Promise<void>;
const primaryTabs = ['Library', 'Editor', 'Queue'] as const;

function App() {
  const [caps, setCaps] = useState<Capabilities>();
  const [token, setToken] = useState('');
  const [authNeeded, setAuthNeeded] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tab, setTab] = useState<string>('Editor');
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
  const refresh = async () => {
    const [nextSources, nextArtifacts, nextJobs] = await Promise.all([api.sources(), api.artifacts(), api.jobs()]);
    setSources(nextSources); setArtifacts(nextArtifacts); setJobs(nextJobs);
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
  useEffect(() => {
    if (!caps) return;
    let active = true;
    const timer = setInterval(() => refresh().catch(cause => { if (active) setError(`Could not refresh media: ${cause.message}`); }), 1800);
    return () => { active = false; clearInterval(timer); };
  }, [caps]);
  const edit = (id: string) => {
    setProject(undefined); setSourceId(id); navigate('Editor');
    writePreference('mw:last:' + caps!.user.id, JSON.stringify({ sourceId: id }));
  };

  if (!caps) return <main className="login">
    <div className="login-heading"><strong>Media Workbench</strong><span>Local workspace</span></div>
    <h1>{authNeeded ? 'Connect to your workspace' : 'Opening your workspace'}</h1>
    <p>Enter the access token from your local setup to open your media.</p>
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
  const navigation = () => primaryTabs.map(next => <button key={next} aria-label={next === 'Queue' ? 'Jobs' : next}
    aria-current={tab === next ? 'page' : undefined} onClick={() => navigate(next)}>
    <span>{next === 'Queue' ? 'Jobs' : next}</span>
    {next === 'Queue' && activeJobs > 0 && <span className="job-count" aria-hidden="true">{activeJobs}</span>}
  </button>);

  return <div className={`app-shell ${editing ? 'editing-shell' : ''}`}>
    <a className="skip-link" href="#workspace-content">Skip to workspace</a>
    <header className="app-header">
      <div className="brand"><strong>Media Workbench</strong></div>
      <nav className="desktop-navigation" aria-label="Main">{navigation()}</nav>
      <div className="shell-actions"><div id="editor-header-actions" />
        {!editing && <button className="primary" onClick={() => navigate('Input')}>Add media</button>}
        <button aria-current={tab === 'Settings' ? 'page' : undefined} onClick={() => navigate('Settings')}>Settings</button>
      </div>
    </header>
    <main id="workspace-content" tabIndex={-1} data-page={tab} className={editing ? 'editor-main page-content' : 'page-content'} aria-busy={busy}>
      {error && <div role="alert" className="error"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>Dismiss</button></div>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {tab === 'Input' && <Input caps={caps} run={run} refresh={refresh} edit={edit} setNotice={setNotice} />}
      {tab === 'Queue' && <Queue jobs={jobs} sources={sources} artifacts={artifacts} run={run} refresh={refresh} edit={edit} setNotice={setNotice} />}
      {tab === 'Library' && <><div className="page-heading"><div><h1>Your media</h1><p>Files, finished exports, and saved projects.</p></div><button onClick={() => void run(refresh)} disabled={busy}>Refresh</button></div>
        <Library sources={sources} artifacts={artifacts} run={run} refresh={refresh} edit={edit} setNotice={setNotice} /><SavedProjects run={run} onProject={openProject} /></>}
      {tab === 'Editor' && (editing ? <Editor jobs={jobs} key={sourceId + '-' + (project?.id || '')} source={selected} artifact={selectedArtifact} sources={sources} artifacts={artifacts} caps={caps} project={project} run={run} refresh={refresh} setNotice={setNotice} />
        : <section className="empty-state editor-empty"><span className="empty-label">Editor</span><h1>Choose a video to edit</h1><p>Add a file, paste a link, or open a saved project.</p><div className="actions"><button className="primary" onClick={() => navigate('Input')}>Add media</button><button onClick={() => navigate('Library')}>Open library</button></div></section>)}
      {tab === 'Settings' && <><div className="page-heading"><div><h1>Settings</h1><p>Appearance, saved presets, and local connections.</p></div></div>
        <nav className="settings-nav" aria-label="Settings">{['General', 'Presets', 'Integrations', ...(caps.user.role === 'owner' ? ['Administration'] : [])].map(next => <button key={next} aria-current={settingsTab === next ? 'page' : undefined} onClick={() => setSettingsTab(next)}>{next}</button>)}</nav>
        {settingsTab === 'General' && <><Panel title="Appearance"><Field label="Color theme"><select value={theme} onChange={event => setTheme(event.target.value)}><option value="system">Follow system</option><option value="light">White</option><option value="dark">Black</option></select></Field><p className="muted">Remembered on this device.</p></Panel><Settings caps={caps} run={run} setNotice={setNotice} /></>}
        {settingsTab === 'Presets' && <Presets run={run} onProject={openProject} />}
        {settingsTab === 'Integrations' && <Integrations caps={caps} run={run} setNotice={setNotice} />}
        {settingsTab === 'Administration' && caps.user.role === 'owner' && <Administration run={run} setNotice={setNotice} />}
      </>}
    </main>
    <footer className="workspace-footer"><span>{desktopBridge() ? 'Desktop' : caps.mode === 'shared' ? 'Shared workspace' : 'Local workspace'}</span><span>{caps.user.name}</span></footer>
    <nav className="mobile-navigation" aria-label="Mobile">{navigation()}</nav>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
