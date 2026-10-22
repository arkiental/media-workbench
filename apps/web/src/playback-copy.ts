import type { Job, Source } from '../../../packages/contracts/src/index';
import { api } from './api';

export const pendingCopies = new Map<string, Promise<void>>();
export const copySubmissionKeys = new Map<string, string>();

export function requestPlaybackCopy(artifactId: string, source: Source | undefined, last: Job | undefined, refresh: () => Promise<void>) {
  const pending = pendingCopies.get(artifactId);
  if (pending) return pending;
  if (last && !['completed', 'failed', 'cancelled', 'interrupted'].includes(last.state)) return refresh();
  const operation = (async () => {
    if (last && ['failed', 'cancelled', 'interrupted'].includes(last.state)) {
      await api.action(`/jobs/${last.id}/retry`);
    } else {
      const editable = source || await api.editArtifact(artifactId);
      const key = copySubmissionKeys.get(artifactId) || crypto.randomUUID();
      copySubmissionKeys.set(artifactId, key);
      await api.submit({ type: 'proxy', sourceId: editable.id }, key);
    }
    await refresh();
  })();
  pendingCopies.set(artifactId, operation);
  void operation.then(() => pendingCopies.delete(artifactId), () => pendingCopies.delete(artifactId));
  return operation;
}
