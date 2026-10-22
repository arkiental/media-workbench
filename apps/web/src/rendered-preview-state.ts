import { JobRequestSchema, type Job } from '../../../packages/contracts/src/index';
import { readPreference, writePreference } from './drafts';

export type PreviewReference = { key: string; jobId: string };
export function previewKey(request: unknown): string {
  const parsed = JobRequestSchema.safeParse(request);
  return JSON.stringify(parsed.success ? parsed.data : request);
}
const storageKey = (sourceId: string) => `mw:export:preview:${sourceId}`;
export function rememberPreview(sourceId: string, reference: PreviewReference) {
  writePreference(storageKey(sourceId), JSON.stringify(reference));
}
export function recoverPreview(sourceId: string, key: string, jobs: Job[]): PreviewReference | undefined {
  try {
    const saved = JSON.parse(readPreference(storageKey(sourceId)) || 'null');
    if (saved?.key === key && typeof saved.jobId === 'string') {
      const job = jobs.find(item => item.id === saved.jobId);
      if (!job || previewKey(job.submittedRequest || job.request) === key) return saved;
    }
  } catch {}
  const job = jobs.filter(item => item.request.type === 'export' && previewKey(item.submittedRequest || item.request) === key)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return job ? { key, jobId: job.id } : undefined;
}
