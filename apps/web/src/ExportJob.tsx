import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Artifact, ExportOptions, Job, JobRequest, Plan, Recipe } from '../../../packages/contracts/src/index';
import { bytes } from '../../../packages/ui/src/index';
import { api, contentUrl, downloadUrl } from './api';

import { JobRequestSchema } from '../../../packages/contracts/src/index';
import { readPreference, writePreference } from './drafts';
import { reviewExportPlan } from './export-plan';
import { EditorIcon } from './EditorIcon';

type Attempt = { key: string; token: string; job?: Job; jobId?: string; confirmed?: boolean; busy?: boolean; planning?: boolean; waiting?: boolean; warnings?: string[]; error?: string };
const attempts = new Map<string, Attempt>();
const planControllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const update = (scope: string, value: Attempt) => {
  attempts.set(scope, value);
  if (value.job) writePreference(`mw:export:${scope}`, JSON.stringify({ jobId: value.job.id, key: value.key }));
  listeners.forEach(listener => listener());
};
const requestKey = (request: unknown) => { const parsed = JobRequestSchema.safeParse(request); return JSON.stringify(parsed.success ? parsed.data : request); };
export const exportRequest = (recipe: Recipe, options: ExportOptions, presetId?: string): JobRequest => ({ type: 'export', recipe, options, ...(presetId ? { presetId } : {}) });
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

/** Resolves the job and output the export store currently tracks for one editor scope. */
function useExportState(scope: string, key: string, jobs: Job[], artifacts: Artifact[]) {
  const attempt = useSyncExternalStore(subscribe, () => attempts.get(scope));
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
  return { attempt, job, missing, working, stale, output };
}

/** Submits an export for an already-resolved plan. Duplicate submits for the same scope are ignored. */
async function submit(scope: string, key: string, request: JobRequest, refresh: () => Promise<void>, warnings?: string[]) {
  const previous = attempts.get(scope);
  const current: Attempt = previous?.key === key && !previous.job && !previous.confirmed ? { ...previous, busy: true, planning: false, error: '', warnings } : { key, token: crypto.randomUUID(), busy: true, warnings };
  update(scope, current);
  try {
    const submitted = await api.submit(request, current.token);
    update(scope, { ...current, job: submitted, busy: false });
    await refresh();
  } catch (cause) { update(scope, { ...attempts.get(scope)!, busy: false, planning: false, error: cause instanceof Error ? cause.message : String(cause) }); }
}

/**
 * One-click export: resolves the plan and submits it in a single step. Plan warnings travel with the
 * attempt so the status card can show them, rather than blocking the export behind a separate review.
 */
export async function exportNow({ scope, recipe, options, presetId, jobs, artifacts, refresh, onPlan }: {
  scope: string; recipe: Recipe; options: ExportOptions; presetId?: string; jobs: Job[]; artifacts: Artifact[];
  refresh: () => Promise<void>; onPlan?: (plan: Plan) => void;
}) {
  const request = exportRequest(recipe, options, presetId), key = requestKey(request);
  const previous = attempts.get(scope);
  if (previous?.busy) return;
  const tracked = jobs.find(job => job.id === (previous?.job?.id || previous?.jobId)) || previous?.job;
  if (tracked && !terminal.has(tracked.state)) return;
  // The same settings already produced a file: show it again instead of exporting a duplicate.
  if (previous?.key === key && tracked?.state === 'completed' && artifacts.some(item => item.id === tracked.artifactId && item.validated)) { update(scope, { ...previous, token: crypto.randomUUID() }); return; }
  planControllers.get(scope)?.abort();
  const controller = new AbortController(); planControllers.set(scope, controller);
  update(scope, { key, token: crypto.randomUUID(), busy: true, planning: true });
  try {
    const plan = await reviewExportPlan(recipe, options, presetId, controller.signal, () => update(scope, { ...attempts.get(scope)!, waiting: true }));
    if (controller.signal.aborted) return;
    onPlan?.(plan);
    await submit(scope, key, request, refresh, plan.warnings);
  } catch (cause) {
    if (controller.signal.aborted) { update(scope, { ...attempts.get(scope)!, busy: false, planning: false, waiting: false, error: 'Export cancelled before it started.' }); return; }
    update(scope, { ...attempts.get(scope)!, busy: false, planning: false, waiting: false, error: cause instanceof Error ? cause.message : String(cause) });
  } finally { if (planControllers.get(scope) === controller) planControllers.delete(scope); }
}

async function jobAction(scope: string, job: Job, name: 'cancel' | 'retry', refresh: () => Promise<void>) {
  const current = attempts.get(scope);
  if (!current?.job || current.busy || (name === 'retry' && !['failed', 'cancelled', 'interrupted'].includes(job.state))) return;
  update(scope, { ...current, busy: true, error: '' });
  try {
    const result = await api.action(`/jobs/${current.job.id}/${name}`) as Job;
    update(scope, { ...current, job: result, busy: false });
    await refresh();
  } catch (cause) { update(scope, { ...current, busy: false, error: cause instanceof Error ? cause.message : String(cause) }); }
}

type StatusProps = { scope: string; recipe: Recipe; options: ExportOptions; presetId?: string; jobs: Job[]; artifacts: Artifact[]; allowed: boolean; refresh: () => Promise<void>; actions?: (output: Artifact) => React.ReactNode };

function ExportStatusBody({ scope, recipe, options, presetId, jobs, artifacts, allowed, refresh, actions, compact }: StatusProps & { compact?: boolean }) {
  const key = requestKey(exportRequest(recipe, options, presetId));
  const { attempt, job, missing, working, stale, output } = useExportState(scope, key, jobs, artifacts);
  if (!attempt) return null;
  const progress = Math.min(1, Math.max(0, job?.progress || 0));
  const title = attempt.planning ? 'Preparing export…' : attempt.busy && !job ? 'Submitting export…' : missing ? 'Export history unavailable' : job ? labels[job.state] || job.state : attempt.error ? 'Export not started' : 'Export not submitted';
  return <>
    <h3 role="status">{title}</h3>
    {attempt.planning && attempt.waiting && <p>Waiting for preview work to finish. This retries automatically.</p>}
    {job?.request.type === 'export' && job.request.options.fileName && !output && <p>File: {job.request.options.fileName}</p>}
    {missing && <p>The saved job is no longer in your history. Check the Library for its file, or {compact ? 'export again' : 'review settings to export again'}.</p>}
    {stale && !attempt.planning && <p>{compact ? 'You changed the edit since this export. Export again to include the changes.' : 'This export uses earlier settings. Review your current settings before starting another export.'}</p>}
    {working && <><progress aria-label="Export progress" max={1} value={progress}/><p>{Math.floor(progress * 100)}%{job?.message ? ` · ${job.message}` : ''}</p>{!compact && <p>You can close this dialog or leave the editor while it finishes.</p>}<button disabled={attempt.busy || job?.state === 'cancelling' || !allowed} onClick={() => job && void jobAction(scope, job, 'cancel', refresh)}>Cancel export</button></>}
    {compact && !!attempt.warnings?.length && !attempt.planning && <ul className="export-warnings">{attempt.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
    {job && ['failed', 'cancelled', 'interrupted'].includes(job.state) && <><p role="alert">{job.error || labels[job.state]}</p><button disabled={attempt.busy || !allowed} onClick={() => void jobAction(scope, job, 'retry', refresh)}>{stale ? 'Retry earlier export' : 'Retry export'}</button></>}
    {attempt.error && <p role="alert">{attempt.error}</p>}
    {output && <><p>{output.name} · {bytes(output.bytes)} · {output.media.duration.toFixed(2)} seconds</p>{compact ? actions?.(output) : <><video key={output.id} aria-label="Completed export" controls preload="metadata" src={contentUrl(output.id)}/><p>If this format cannot play here, download the exported file.</p><a href={downloadUrl(output.id)} download={output.name}>Download exported file</a></>}</>}
    {job?.state === 'completed' && !output && <p role="status">The exported file is unavailable. Refresh the Library or {compact ? 'export again' : 'review settings to export again'}.</p>}
  </>;
}

/** Floating export status for the one-click flow; it follows the same attempt as the export dialog. */
export function ExportToast(props: StatusProps & { hidden?: boolean }) {
  const attempt = useSyncExternalStore(subscribe, () => attempts.get(props.scope));
  const [dismissed, setDismissed] = React.useState<string>();
  const identity = attempt ? `${attempt.token}:${attempt.job?.id || ''}` : '';
  const reference = useRef(identity);
  useEffect(() => { if (identity !== reference.current) { reference.current = identity; setDismissed(undefined); } }, [identity]);
  if (!attempt || props.hidden || dismissed === identity) return null;
  return <section className="export-toast" aria-label="Export status">
    <button className="icon-button export-toast-close" aria-label="Hide export status" title="Hide" onClick={() => {
      if (attempt.planning) planControllers.get(props.scope)?.abort();
      setDismissed(identity);
    }}><EditorIcon name="close" size={16}/></button>
    <ExportStatusBody {...props} compact/>
  </section>;
}

export function ExportJob({ scope, recipe, options, presetId, plan, jobs, artifacts, allowed, refresh, statusHost }: {
  statusHost: HTMLElement | null;
  scope: string; recipe: Recipe; options: ExportOptions; presetId?: string; plan?: Plan;
  jobs: Job[]; artifacts: Artifact[]; allowed: boolean; refresh: () => Promise<void>;
}) {
  const request = exportRequest(recipe, options, presetId), key = requestKey(request);
  const { attempt, job, working, stale, output } = useExportState(scope, key, jobs, artifacts);
  const status = useRef<HTMLDivElement>(null);
  const start = async () => {
    const previous = attempts.get(scope);
    if (!allowed || !plan || previous?.busy || working || (job?.state === 'completed' && !stale && output)) return;
    await submit(scope, key, request, refresh, plan.warnings);
    status.current?.scrollIntoView({ block: 'nearest' });
  };
  return <div className="export-job">
    <button aria-label="Export using reviewed plan" className="primary" disabled={!allowed || !plan || attempt?.busy || working || (!!output && !stale)} onClick={() => void start()}>{attempt?.busy && !job ? 'Submitting export…' : output && !stale ? 'Export complete' : 'Export video'}</button>
    {attempt && statusHost && createPortal(<div ref={status} className="export-job-status" aria-label="Export progress">
      <ExportStatusBody scope={scope} recipe={recipe} options={options} presetId={presetId} jobs={jobs} artifacts={artifacts} allowed={allowed} refresh={refresh}/>
    </div>, statusHost)}
  </div>;
}
