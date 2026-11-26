import React, { useEffect, useRef, useState } from 'react';
import type { Capabilities, Job } from '../../../packages/contracts/src/index';
import { api } from './api';
import { EditorIcon } from './EditorIcon';
import { formatRows } from './downloadQuality';

type Task = (work: () => Promise<unknown>) => Promise<void>;
const terminal = ['completed', 'failed', 'cancelled', 'interrupted'];
const failedStates = ['failed', 'cancelled', 'interrupted'];
export const linkFrom = (text: string) => {
  const value = text.trim();
  if (!value || /\s/.test(value)) return '';
  try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) ? value : ''; } catch { return ''; }
};
const clock = (seconds?: number) => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';
  const value = Math.round(seconds), h = Math.floor(value / 3600), m = Math.floor(value % 3600 / 60), s = value % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
};

/**
 * The Library's primary entry point: paste a link, keep the suggested quality, and either download
 * or download and open the editor once the file is ready. Files can be chosen or dropped anywhere.
 */
export function QuickImport({ caps, url, setUrl, jobs, run, refresh, setNotice, importFiles, importing, openAdvanced, pendingEdit, setPendingEdit, focusSignal }: {
  caps: Capabilities; url: string; setUrl: (value: string) => void; jobs: Job[]; run: Task; refresh: () => Promise<void>; setNotice: (text: string) => void;
  importFiles: (files: File[]) => void; importing: boolean; openAdvanced: (url: string) => void;
  pendingEdit?: string; setPendingEdit: (jobId?: string) => void; focusSignal: number;
}) {
  const [metadata, setMetadata] = useState<any>(), [inspecting, setInspecting] = useState(false), [error, setError] = useState('');
  const [itemIndex, setItemIndex] = useState(1), [choice, setChoice] = useState(''), [submitting, setSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), input = useRef<HTMLInputElement>(null), version = useRef(0);
  const link = linkFrom(url), canDownload = !!caps.user.policy.download, canUpload = !!caps.user.policy.upload;
  const pending = jobs.find(job => job.id === pendingEdit);
  useEffect(() => { if (focusSignal) input.current?.focus(); }, [focusSignal]);
  const inspect = async () => {
    if (!link || !canDownload) return;
    const current = ++version.current;
    setInspecting(true); setError(''); setMetadata(undefined);
    try {
      const result = await api.inspect({ url: link, preference: 'compatible' });
      if (current !== version.current) return;
      setMetadata(result); setItemIndex(result.entries?.[0]?.itemIndex || 1); setChoice(value => value === 'audio' ? value : '');
    } catch (cause) {
      if (current === version.current) setError(cause instanceof Error ? cause.message : 'This link could not be read.');
    } finally { if (current === version.current) setInspecting(false); }
  };
  useEffect(() => {
    version.current++; setMetadata(undefined); setError(''); setInspecting(false); setChoice(value => value === 'audio' ? value : '');
    if (!link || !canDownload) return;
    const timer = window.setTimeout(() => void inspect(), 350);
    return () => window.clearTimeout(timer);
  }, [link]);
  const entry = metadata?.entries?.find((item: any) => item.itemIndex === itemIndex);
  const rows = formatRows(entry?.formats || []), video = rows.filter(row => row.kind === 'video'), audio = rows.find(row => row.kind === 'audio');
  const knownTitle = entry?.title || metadata?.title, title = knownTitle || 'Untitled media', length = clock(entry?.duration ?? metadata?.duration);
  // Downloading never waits for the lookup: before it finishes, the server picks the best quality (original voice) and names the file from the title.
  const showCard = !!link && canDownload && !pendingEdit && !error, host = (() => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const selected = choice === 'audio' ? audio : rows.find(row => row.format === choice) || video[0];
  const download = (edit: boolean) => void run(async () => {
    if (!link || submitting) return;
    setSubmitting(true);
    try {
      const audioOnly = choice === 'audio';
      const fileName = (knownTitle || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 160).trim();
      const job = await api.submit({ type: 'download', download: { url: link, preference: audioOnly ? 'audio' : 'compatible', itemIndex, ...(fileName ? { fileName } : {}), ...(selected?.format ? { format: selected.format } : {}) } });
      await refresh();
      if (edit) setPendingEdit(job.id);
      else { setUrl(''); setNotice(`Downloading ${knownTitle ? `“${knownTitle}”` : 'your video'}. It appears below and is ready to edit when finished.`); }
    } finally { setSubmitting(false); }
  });
  const cancelPending = () => void run(async () => { if (pending && !terminal.includes(pending.state)) { await api.action(`/jobs/${pending.id}/cancel`); await refresh(); } });
  const retryPending = () => void run(async () => { if (pending) { await api.action(`/jobs/${pending.id}/retry`); await refresh(); } });
  const progress = pending && Number.isFinite(pending.progress) && pending.progress > 0 && pending.state === 'downloading' ? Math.min(1, pending.progress) : undefined;
  const pendingLabel = !pending ? 'Starting download…' : pending.state === 'queued' ? 'Waiting to start' : pending.state === 'preparing' ? 'Preparing download' : pending.state === 'downloading' ? `Downloading${progress !== undefined ? ` · ${Math.floor(progress * 100)}%` : ''}` : pending.state === 'processing' ? 'Converting' : pending.state === 'validating' ? 'Checking file' : pending.state === 'completed' ? 'Opening editor…' : pending.state === 'cancelling' ? 'Stopping' : pending.error || 'Download stopped';

  return <section className="quick-import" aria-label="Add media">
    <form className="quick-import-bar" onSubmit={event => { event.preventDefault(); void inspect(); }}>
      <label className="quick-url"><EditorIcon name="link" size={18}/>
        <input ref={input} aria-label="Paste a video link" type="url" value={url} disabled={!canDownload || !!pendingEdit} placeholder={canDownload ? 'Paste a video link to download it' : 'Downloading links is not permitted'} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => setUrl(event.target.value)}/>
        {url && !pendingEdit && <button type="button" className="quick-clear" aria-label="Clear link" onClick={() => { setUrl(''); input.current?.focus(); }}><EditorIcon name="close" size={16}/></button>}
      </label>
      <span className="quick-or" aria-hidden="true">or</span>
      <button type="button" disabled={!canUpload || importing} onClick={() => fileInput.current?.click()}><EditorIcon name="upload" size={17}/>Choose files</button>
      <input aria-label="Choose media files" ref={fileInput} hidden type="file" accept="video/*,audio/*,.mkv,.mov,.webm,.ts" multiple onChange={event => { const files = Array.from(event.target.files || []); if (files.length) importFiles(files); event.target.value = ''; }}/>
    </form>
    {!url && !pendingEdit && <p className="quick-hint">Works with YouTube and many other sites. You can also press Ctrl+V anywhere here, or drop files onto the window.</p>}
    {url && !link && <p className="quick-hint" role="status">That doesn’t look like a web link yet. Links start with https://</p>}
    {error && <div className="quick-error" role="alert"><EditorIcon name="alert" size={18}/><span>{error}</span><button type="button" onClick={() => void inspect()}>Try again</button><button type="button" onClick={() => openAdvanced(link)}>More options</button></div>}
    {showCard && <div className="quick-found" aria-busy={!metadata}>
      <div className="quick-thumb" aria-hidden="true">{metadata?.thumbnail ? <img src={metadata.thumbnail} alt=""/> : metadata ? <EditorIcon name="play" size={28}/> : <i className="quick-spinner"/>}{length && <span>{length}</span>}</div>
      <div className="quick-info">
        <h2>{metadata ? title : host || 'Video link'}</h2>
        {metadata ? <p>{[metadata.uploader, length, metadata.site].filter(Boolean).join(' · ')}</p> : <p className="quick-status" role="status">{inspecting ? 'Getting the title and qualities… you can download already.' : 'Ready to download.'}</p>}
        {metadata?.entries?.length > 1 && <label className="quick-field">Video <select value={itemIndex} onChange={event => { setItemIndex(Number(event.target.value)); setChoice(''); }}>{metadata.entries.map((item: any) => <option key={item.itemIndex} value={item.itemIndex}>{item.itemIndex}. {item.title || item.id || 'Media'}</option>)}</select></label>}
      </div>
      <div className="quick-actions">
        <label className="quick-field">Quality <select aria-label="Download quality" value={choice} onChange={event => setChoice(event.target.value)}>
          <option value="">{video[0] ? `Best · ${video[0].quality}` : 'Best available'}</option>
          {video.slice(1).map(row => <option key={row.key} value={row.format}>{row.quality}</option>)}
          {(audio || !metadata) && <option value="audio">Audio only</option>}
        </select></label>
        <button type="button" disabled={!canDownload || submitting} onClick={() => download(false)}><EditorIcon name="download" size={17}/>Download</button>
        <button type="button" className="primary" disabled={!canDownload || submitting} onClick={() => download(true)}><EditorIcon name="edit" size={17}/>Download &amp; edit</button>
        <button type="button" className="quiet quick-more" onClick={() => openAdvanced(link)}>More options</button>
      </div>
    </div>}
    {pendingEdit && <div className="quick-pending" data-state={pending?.state || 'queued'}>
      <div><strong>{metadata ? title : 'Your download'}</strong><span role="status">{pendingLabel}</span></div>
      {pending && failedStates.includes(pending.state)
        ? <div className="actions"><button type="button" className="primary" onClick={retryPending}>Retry</button><button type="button" onClick={() => setPendingEdit(undefined)}>Dismiss</button></div>
        : <><progress max={1} value={progress} aria-label="Download progress"/><p>The editor opens automatically when the file is ready.</p><div className="actions"><button type="button" disabled={!pending || pending.state === 'cancelling' || pending.state === 'completed'} onClick={cancelPending}>Cancel</button><button type="button" className="quiet" onClick={() => { setPendingEdit(undefined); setUrl(''); setNotice('The download continues in your Library.'); }}>Don’t open the editor</button></div></>}
    </div>}
  </section>;
}
