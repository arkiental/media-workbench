import React, { useRef, useState } from 'react';
import { bytes } from '../../../packages/ui/src/index';
import { importFile } from './import-file';

type Entry = { file: File; state: 'capacity' | 'waiting' | 'uploading' | 'checking' | 'ready' | 'failed' | 'stopped'; progress: number; error?: string };

export function useImportQueue(refresh: () => Promise<void>) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [active, setActive] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const start = async (files: File[], maxBytes: number) => {
    if (controller.current || !files.length) return;
    const batch = new AbortController();
    controller.current = batch;
    setActive(true); setRefreshError('');
    const next: Entry[] = files.map(file => ({ file, state: 'waiting', progress: 0 }));
    const publish = () => setEntries(next.map(entry => ({ ...entry })));
    publish();
    try {
      for (const entry of next) {
        if (batch.signal.aborted) { entry.state = 'stopped'; publish(); continue; }
        try {
          if (entry.file.size > maxBytes) throw new Error(`Exceeds the ${bytes(maxBytes)} file size limit.`);
          entry.state = 'uploading'; publish();
          await importFile(entry.file, batch.signal, progress => {
            entry.progress = progress;
            entry.state = progress < 1 ? 'uploading' : 'checking';
            publish();
          }, () => { entry.state = 'capacity'; entry.progress = 0; publish(); }, () => { entry.state = 'uploading'; entry.progress = 0; publish(); });
          entry.state = 'ready';
        } catch (error) {
          entry.state = batch.signal.aborted ? 'stopped' : 'failed';
          if (!batch.signal.aborted) entry.error = error instanceof Error ? error.message : String(error);
        }
        publish();
      }
      try { await refresh(); } catch { setRefreshError('Could not refresh Library. Refresh it before importing these files again.'); }
      return next.every(entry => entry.state === 'ready');
    } finally {
      controller.current = null;
      setActive(false);
    }
  };
  return { entries, active, refreshError, start, cancel: () => controller.current?.abort(), clear: () => setEntries([]) };
}

export function ImportQueue({ queue, maxBytes, openLibrary }: { queue: ReturnType<typeof useImportQueue>; maxBytes: number; openLibrary: () => void }) {
  const { entries, active } = queue;
  if (!entries.length) return null;
  const ready = entries.filter(entry => entry.state === 'ready').length;
  const failed = entries.filter(entry => entry.state === 'failed');
  const stopped = entries.some(entry => entry.state === 'stopped');
  const current = entries.find(entry => entry.state === 'uploading' || entry.state === 'checking' || entry.state === 'capacity');
  return <section className="import-queue" aria-label="File imports">
    <div className="import-queue-heading">
      <div role="status"><strong>{active ? 'Importing files' : stopped ? 'Import stopped' : 'Import finished'}</strong><p>{ready} of {entries.length} ready{failed.length ? ` · ${failed.length} failed` : ''}</p></div>
      <div className="actions">{active ? <button onClick={queue.cancel}>Stop import</button> : <>
        {!!failed.length && <button onClick={() => void queue.start(failed.map(entry => entry.file), maxBytes)}>Retry failed files</button>}
        <button onClick={openLibrary}>View Library</button><button onClick={queue.clear}>Dismiss</button>
      </>}</div>
    </div>
    {current && <div className="import-current"><span>{current.file.name}</span><progress aria-label="Current file upload" max={1} value={current.state !== 'uploading' ? undefined : current.progress}/><span>{current.state === 'capacity' ? 'Waiting for preview work. Retrying automatically.' : current.state === 'checking' ? 'Checking media…' : `${Math.floor(current.progress * 100)}% uploaded`}</span></div>}
    <details><summary>File details</summary><ul>{entries.map((entry, index) => <li key={index}><span>{entry.file.name}</span><span>{({ capacity: 'Waiting for preview work', waiting: 'Waiting', uploading: 'Uploading', checking: 'Checking media', ready: 'Ready', failed: 'Failed', stopped: 'Stopped' })[entry.state]}</span>{entry.error && <p>{entry.error}</p>}</li>)}</ul></details>
    {stopped && <p>Completed files stay in Library. A file already finishing may still appear there; check Library before importing it again.</p>}
    {queue.refreshError && <p role="alert">{queue.refreshError}</p>}
  </section>;
}
