/**
 * Session Closer Job
 *
 * Hourly job that closes coaching sessions idle for SESSION_IDLE_HOURS, so each
 * sitting gets summarized into Session Memory even if the writer never clicks
 * End Session. Sessions the writer never spoke in are removed instead.
 *
 * It then brings Quinn's notebook up to date for every project, which also
 * retries any notebook update that failed when its session ended.
 */
import { closeIdleSessions } from '../services/coaching.service.js';
import { updatePendingNotebooks } from '../services/notebook.service.js';

export async function runSessionCloser(): Promise<void> {
  const { ended, removed } = await closeIdleSessions();
  if (ended > 0 || removed > 0) {
    console.log(`[SessionCloser] Ended ${ended} idle session(s), removed ${removed} empty one(s)`);
  }
  try {
    await updatePendingNotebooks();
  } catch (err) {
    console.warn('[SessionCloser] Notebook update failed:', err instanceof Error ? err.message : err);
  }
}
