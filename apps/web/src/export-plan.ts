import type { ExportOptions, Recipe } from '../../../packages/contracts/src/index';
import { api, ApiError } from './api';

export async function reviewExportPlan(recipe: Recipe, options: ExportOptions, presetId: string | undefined, signal: AbortSignal, waiting: () => void) {
  const controller = new AbortController();
  const capacityDeadline = Date.now() + 15000;
  const cancel = () => controller.abort(signal.reason);
  if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Review took too long. Try Review settings again.')), 120000);
  try {
    for (let attempt = 0; ; attempt++) {
      try { return await api.plan(recipe, options, presetId, { signal: controller.signal }); }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const busy = error instanceof ApiError && error.status === 429 && /preview\/inspection operations already active|Host preview\/upload capacity reached/i.test(error.message);
        if (!busy) throw error;
        if (attempt === 7 || Date.now() >= capacityDeadline) throw new Error('Preview work is still busy. Wait a moment, then try Review settings again.');
        waiting();
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(controller.signal.reason); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, Math.min(2000, 400 * (attempt + 1), capacityDeadline - Date.now())));
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        });
      }
    }
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
}
