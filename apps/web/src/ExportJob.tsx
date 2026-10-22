import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Artifact, ExportOptions, Job, Plan, Recipe } from '../../../packages/contracts/src/index';
import { bytes } from '../../../packages/ui/src/index';
import { api, contentUrl, downloadUrl } from './api';

import { JobRequestSchema } from '../../../packages/contracts/src/index';
import { readPreference, writePreference } from './drafts';

type Attempt = { key: string; token: string; job?: Job; jobId?: string; confirmed?: boolean; busy?: boolean; error?: string };
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const update = (scope: string, value: Attempt) => {
  attempts.set(scope, value);
  if (value.job) writePreference(`mw:export:${scope}`, JSON.stringify({ jobId: value.job.id, key: value.key }));
  listeners.forEach(listener => listener());
};
const requestKey = (request: unknown) => { const parsed = JobRequestSchema.safeParse(request); return JSON.stringify(parsed.success ? parsed.data : request); };
function restore(scope: string, key: string, jobs: Job[]): Attempt | undefined {
  try {
    const saved = JSON.parse(readPreference(`mw:export:${scope}`) || 'null');
    if (typeof saved?.jobId === 'string' && typeof saved.key === 'string') {
      return { key: saved.key, token: crypto.randomUUID(), jobId: saved.jobId, job: jobs.find(job => job.id === saved.jobId), confirmed: true };
    }
  } catch {}
  const job = jobs.filter(job => job.request.type === 'export' && requestKey(job.submittedRequest || job.request) === key)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return job ? { key, token: crypto.randomUUID(), job, confirmed: true } : undefined;
}
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const labels: Record<string, string> = { queued: 'Waiting to start', preparing: 'Preparing export', processing: 'Exporting', validating: 'Checking exported file', cancelling: 'Stopping export', completed: 'Export ready', failed: 'Export failed', cancelled: 'Export cancelled', interrupted: 'Export interrupted' };

export function ExportJob({ scope, recipe, options, presetId, plan, jobs, artifacts, allowed, refresh, statusHost }: {
  statusHost: HTMLElement | null;
  scope: string; recipe: Recipe; options: ExportOptions; presetId?: string; plan?: Plan;
  jobs: Job[]; artifacts: Artifact[]; allowed: boolean; refresh: () => Promise<void>;
}) {
  const attempt = useSyncExternalStore(subscribe, () => attempts.get(scope));
  const key = requestKey({ type: 'export', recipe, options, ...(presetId ? { presetId } : {}) });
  useEffect(() => {
    if (!attempt) { const restored = restore(scope, key, jobs); if (restored) update(scope, restored); }
  }, [scope, key, jobs, attempt]);
  const polled = jobs.find(item => item.id === (attempt?.job?.id || attempt?.jobId));
  useEffect(() => {
    if (attempt && polled && !attempt.busy && (!attempt.confirmed || polled.updatedAt > (attempt.job?.updatedAt || ''))) update(scope, { ...attempt, job: polled, confirmed: true });
  }, [scope, attempt, polled]);
  const missing = !!attempt?.confirmed && !polled;
  const job = missing ? undefined : polled && (!attempt?.job || polled.updatedAt >= attempt.job.updatedAt) ? polled : attempt?.job;
  const working = !!job && !terminal.has(job.state);
  const stale = !!attempt && attempt.key !== key;
  const output = job?.state === 'completed' ? artifacts.find(item => item.id === job.artifactId && item.validated) : undefined;
  const status = useRef<HTMLDivElement>(null);
  const start = async () => {
    const previous = attempts.get(scope);
    if (!allowed || !plan || previous?.busy || working || (job?.state === 'completed' && !stale && output)) return;
    const current: Attempt = previous?.key === key && !previous.job && !previous.confirmed ? { ...previous, busy: true, error: '' } : { key, token: crypto.randomUUID(), busy: true };
    update(scope, current);
    try {
      const submitted = await api.submit({ type: 'export', recipe, options, ...(presetId ? { presetId } : {}) }, current.token);
      update(scope, { ...current, job: submitted, busy: false });
      await refresh();
    } catch (cause) { update(scope, { ...attempts.get(scope)!, busy: false, error: cause instanceof Error ? cause.message : String(cause) }); }
    status.current?.scrollIntoView({ block: 'nearest' });
  };
  const action = async (name: 'cancel' | 'retry') => {
    const current = attempts.get(scope);
    if (!allowed || !current?.job || !job || current.busy || (name === 'retry' && !['failed', 'cancelled', 'interrupted'].includes(job.state))) return;
    update(scope, { ...current, busy: true, error: '' });
    try {
      const result = await api.action(`/jobs/${current.job.id}/${name}`) as Job;
      update(scope, { ...current, job: result, busy: false });
      await refresh();
    } catch (cause) { update(scope, { ...current, busy: false, error: cause instanceof Error ? cause.message : String(cause) }); }
  };
  const progress = Math.min(1, Math.max(0, job?.progress || 0));
  return <div className="export-job">
    <button aria-label="Export using reviewed plan" className="primary" disabled={!allowed || !plan || attempt?.busy || working || (!!output && !stale)} onClick={() => void start()}>{attempt?.busy && !job ? 'Submitting export…' : output && !stale ? 'Export complete' : 'Export video'}</button>
    {attempt && statusHost && createPortal(<div ref={status} className="export-job-status" aria-label="Export progress">
      <h3 role="status">{attempt.busy && !job ? 'Submitting export…' : missing ? 'Export history unavailable' : job ? labels[job.state] || job.state : 'Export not submitted'}</h3>
      {job?.request.type === 'export' && job.request.options.fileName && !output && <p>File: {job.request.options.fileName}</p>}
      {missing && <p>The saved job is no longer in your history. Check the Library for its file, or review settings to export again.</p>}
      {stale && <p>This export uses earlier settings. Review your current settings before starting another export.</p>}
      {working && <><progress aria-label="Export progress" max={1} value={progress}/><p>{Math.floor(progress * 100)}%{job?.message ? ` · ${job.message}` : ''}</p><p>You can close this dialog or leave the editor while it finishes.</p><button disabled={attempt.busy || job?.state === 'cancelling' || !allowed} onClick={() => void action('cancel')}>Cancel export</button></>}
      {job && ['failed', 'cancelled', 'interrupted'].includes(job.state) && <><p role="alert">{job.error || labels[job.state]}</p><button disabled={attempt.busy || !allowed} onClick={() => void action('retry')}>{stale ? 'Retry earlier export' : 'Retry export'}</button></>}
      {attempt.error && <p role="alert">{attempt.error}</p>}
      {output && <><p>{output.name} · {bytes(output.bytes)} · {output.media.duration.toFixed(2)} seconds</p><video key={output.id} aria-label="Completed export" controls preload="metadata" src={contentUrl(output.id)}/><p>If this format cannot play here, download the exported file.</p><a href={downloadUrl(output.id)} download={output.name}>Download exported file</a></>}
      {job?.state === 'completed' && !output && <p role="status">The exported file is unavailable. Refresh the Library or review settings to export again.</p>}
    </div>, statusHost)}
  </div>;
}
