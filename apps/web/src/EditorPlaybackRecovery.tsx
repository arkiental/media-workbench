import React, { useEffect, useState } from 'react';
import type { Artifact, Job, Source } from '../../../packages/contracts/src/index';
import { copySubmissionKeys, pendingCopies, requestPlaybackCopy } from './playback-copy';

const wantedCopies = new Set<string>();
export const rememberEditorPreview = (source: Source, id: string) => { if (id === source.artifactId) wantedCopies.delete(source.id); else wantedCopies.add(source.id); };
const terminal = ['completed', 'failed', 'cancelled', 'interrupted'];
const latestCopy = (source: Source, artifacts: Artifact[]) => artifacts.filter(a => a.sourceId === source.id && a.kind === 'proxy' && a.validated).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
export const initialEditorPreview = (source: Source, artifacts: Artifact[]) => wantedCopies.has(source.id) ? latestCopy(source, artifacts)?.id || source.artifactId : source.artifactId;

export function EditorPlaybackRecovery({ source, artifacts, jobs, failed, previewId, select, retryPlayback, allowed, refresh }: {
  source: Source; artifacts: Artifact[]; jobs: Job[]; failed: boolean; previewId: string; select: (id: string) => void;
  retryPlayback: () => void; allowed: boolean; refresh: () => Promise<void>;
}) {
  const copy = latestCopy(source, artifacts);
  const related = jobs.filter(j => j.request.type === 'proxy' && j.request.sourceId === source.id);
  const active = related.find(j => !terminal.includes(j.state));
  const last = [...related].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const [busy, setBusy] = useState(pendingCopies.has(source.artifactId)), [error, setError] = useState('');
  useEffect(() => {
    const pending = pendingCopies.get(source.artifactId);
    if (pending) void pending.then(() => setBusy(false), cause => { setBusy(false); setError(cause instanceof Error ? cause.message : String(cause)); });
  }, [source.artifactId]);
  useEffect(() => { if (last) copySubmissionKeys.delete(source.artifactId); }, [last?.id]);
  useEffect(() => {
    if (copy && wantedCopies.has(source.id) && previewId !== copy.id) select(copy.id);
    else if (previewId !== source.artifactId && !artifacts.some(a => a.id === previewId)) select(source.artifactId);
  }, [copy?.id, previewId, artifacts, source.id]);
  const recover = () => {
    if (!allowed || active || pendingCopies.has(source.artifactId)) return;
    wantedCopies.add(source.id); setBusy(true); setError('');
    void requestPlaybackCopy(source.artifactId, source, last, refresh).then(() => setBusy(false), cause => { setBusy(false); setError(cause instanceof Error ? cause.message : String(cause)); });
  };
  const switchTo = (id: string) => { rememberEditorPreview(source,id); select(id); setError(''); };
  if (!failed && !copy && !active && !busy && !error && !last) return null;
  return <section className="editor-playback-recovery" aria-label="Editor playback recovery">
    {failed && <p role="alert">This file could not play in your browser. Retry playback or use a compatible playback copy.</p>}
    {previewId !== source.artifactId && <p role="status">Playing a compatible copy. Edits and exports still use your original source.</p>}
    <div className="actions">
      {failed && <button onClick={retryPlayback}>Retry playback</button>}
      {copy && <button onClick={() => switchTo(previewId === source.artifactId ? copy.id : source.artifactId)}>{previewId === source.artifactId ? 'Play playback copy' : 'Play original'}</button>}
      {!copy && <button disabled={!allowed || busy || !!active} onClick={recover}>{busy ? 'Queuing playback copy…' : active ? 'Making playback copy…' : last && ['failed', 'cancelled', 'interrupted'].includes(last.state) ? 'Retry playback copy' : 'Make playback copy'}</button>}
    </div>
    {active && <p role="status">Playback copy: {active.state}{active.progress > 0 ? ` · ${Math.floor(active.progress * 100)}%` : ''}. You can leave the editor while it finishes.</p>}
    {!active && !copy && last && ['failed', 'cancelled', 'interrupted'].includes(last.state) && <p role="alert">{last.error || `Playback copy ${last.state}. You can retry it here.`}</p>}
    {error && <p role="alert">{error}</p>}
    {!allowed && !copy && <p>Your workspace permissions do not allow making playback copies.</p>}
  </section>;
}
