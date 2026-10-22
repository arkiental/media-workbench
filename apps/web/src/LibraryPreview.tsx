import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Artifact, Job, Source } from '../../../packages/contracts/src/index';
import { contentUrl } from './api';
import { pendingCopies as pending, copySubmissionKeys as submissionKeys, requestPlaybackCopy } from './playback-copy';

const finished = ['completed', 'failed', 'cancelled', 'interrupted'];


export type PreviewPosition = { time: number; copy: boolean };

export function LibraryPreview({ artifact, sources, artifacts, jobs, canProcess, refresh, positions }: {
  positions: Map<string, PreviewPosition>; artifact: Artifact; sources: Source[]; artifacts: Artifact[]; jobs: Job[]; canProcess: boolean; refresh: () => Promise<void>;
}) {
  const source = sources.find(item => item.artifactId === artifact.id);
  const copies = source ? artifacts.filter(item => item.kind === 'proxy' && item.sourceId === source.id && item.validated) : [];
  const copy = copies.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const related = jobs.filter(job => job.request.type === 'proxy' && job.request.sourceId === source?.id);
  const active = related.find(job => !finished.includes(job.state));
  const last = [...related].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const [useCopy, setUseCopy] = useState(positions.get(artifact.id)?.copy ?? false);
  const media = useRef<HTMLMediaElement | null>(null);
  const restoring = useRef(true);
  const restoreTime = useRef<number | undefined>(undefined), restoreAttempts = useRef(0);
  const restorePosition = () => {
    const element = media.current;
    if (!element || !restoring.current || element.seeking || restoreAttempts.current >= 2) return;
    const target = restoreTime.current;
    if (target === undefined) return;
    if (target === 0) { restoring.current = false; return; }
    const ranges = element.seekable;
    if (!Array.from({ length: ranges.length }, (_, index) => target >= ranges.start(index) && target <= ranges.end(index)).some(Boolean)) return;
    restoreAttempts.current++;
    element.currentTime = target;
  };
  const remember = (event?: React.SyntheticEvent<HTMLMediaElement>) => {
    const element = media.current;
    if (event && event.currentTarget !== element) return;
    if (!element || restoring.current || element.error || element.readyState < 1 || !Number.isFinite(element.currentTime)) return;
    positions.set(artifact.id, { time: element.currentTime, copy: useCopy && !!copy });
  };
  const [error, setError] = useState('');
  const [mediaState, setMediaState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(pending.has(artifact.id));
  const [reload, setReload] = useState(0);
  const wantedCopy = useRef(false);
  const selected = useCopy && copy ? copy : artifact;
  const audioOnly = !selected.media.streams.some(stream => stream.type === 'video');
  useLayoutEffect(() => { restoring.current = true; restoreTime.current = undefined; restoreAttempts.current = 0; }, [selected.id, reload]);
  useEffect(() => { if (copy && wantedCopy.current) setUseCopy(true); }, [copy?.id]);
  useEffect(() => { if (!copy && useCopy) setUseCopy(false); }, [copy?.id, useCopy]);
  useEffect(() => { if (last) submissionKeys.delete(artifact.id); }, [last?.id]);
  useEffect(() => { setMediaState('loading'); }, [selected.id, reload]);
  useEffect(() => {
    const operation = pending.get(artifact.id);
    if (operation) void operation.then(() => setBusy(false), () => setBusy(false));
  }, [artifact.id]);

  const recover = () => {
    if (pending.has(artifact.id) || active || !canProcess) return;
    wantedCopy.current = true; setBusy(true); setError('');
    void requestPlaybackCopy(artifact.id, source, last, refresh).then(
      () => setBusy(false),
      cause => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
    );
  };
  const mediaProps = {
    ref: (element: HTMLMediaElement | null) => { media.current = element; },
    controls: true, src: contentUrl(selected.id), preload: 'metadata',
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      const element = event.currentTarget;
      if (element !== media.current) return;
      const saved = positions.get(artifact.id)?.time ?? 0;
      const time = Number.isFinite(saved) && Number.isFinite(element.duration) ? Math.max(0, Math.min(saved, Math.max(0, element.duration - .05))) : 0;
      positions.set(artifact.id, { time, copy: useCopy && !!copy });
      restoreTime.current = time;
      restorePosition();
      setMediaState('ready');
    },
    onTimeUpdate: remember, onPause: remember,
    onSeeked: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      if (event.currentTarget !== media.current) return;
      if (restoring.current && Math.abs(event.currentTarget.currentTime - (restoreTime.current ?? 0)) > .1 && restoreAttempts.current < 2) return;
      restoring.current = false; remember(event);
    },
    onProgress: (event: React.SyntheticEvent<HTMLMediaElement>) => { if (event.currentTarget === media.current) restorePosition(); },
    onPlay: (event: React.SyntheticEvent<HTMLMediaElement>) => { if (event.currentTarget === media.current && !event.currentTarget.seeking) { restoring.current = false; remember(event); } },
    onCanPlay: (event: React.SyntheticEvent<HTMLMediaElement>) => { if (event.currentTarget === media.current) { restorePosition(); setMediaState('ready'); } },
    onError: (event: React.SyntheticEvent<HTMLMediaElement>) => { if (event.currentTarget === media.current) setMediaState('error'); },
  };
  return <div className="library-preview" aria-label={`Preview ${artifact.name}`}>
    {audioOnly ? <audio key={`${selected.id}-${reload}`} {...mediaProps}/> : <video key={`${selected.id}-${reload}`} {...mediaProps} playsInline/>}
    {mediaState === 'loading' && <p role="status">Loading preview…</p>}
    {mediaState === 'error' && <p role="status">This file could not be played. Retry playback, or make a compatible playback copy.</p>}
    <div className="actions preview-recovery">
      {mediaState !== 'ready' && <button onClick={() => { setMediaState('loading'); setReload(value => value + 1); }}>Retry playback</button>}
      {copy && <button onClick={() => { remember(); wantedCopy.current = false; setUseCopy(value => !value); }}>{useCopy ? 'Play original' : 'Play playback copy'}</button>}
      {!copy && (mediaState === 'error' || active || busy || last || error) && <button disabled={!canProcess || busy || !!active} onClick={recover}>{busy ? 'Queuing playback copy…' : active ? 'Making playback copy…' : last && ['failed', 'cancelled', 'interrupted'].includes(last.state) ? 'Retry playback copy' : 'Make playback copy'}</button>}
    </div>
    {useCopy && copy && <p>Playing a compatible copy. Your original file is unchanged.</p>}
    {active && <p role="status">Playback copy: {active.state}. You can leave this page while it finishes.</p>}
    {!active && !copy && last?.error && <p role="alert">Playback copy failed: {last.error}</p>}
    {!active && !copy && last && ['cancelled', 'interrupted'].includes(last.state) && <p role="status">Playback copy was {last.state}. You can retry it here.</p>}
    {error && <p role="alert">{error}</p>}
    {!canProcess && mediaState === 'error' && !copy && <p>Your workspace permissions do not allow making playback copies.</p>}
  </div>;
}
