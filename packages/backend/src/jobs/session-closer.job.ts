/**
 * Session Closer Job
 *
 * Hourly job that closes coaching sessions idle for SESSION_IDLE_HOURS, so each
 * sitting gets summarized into Session Memory even if the writer never clicks
 * End Session. Sessions the writer never spoke in are removed instead.
 */

import { closeIdleSessions } from '../services/coaching.service.js';

export async function runSessionCloser(): Promise<void> {
  const { ended, removed } = await closeIdleSessions();
  if (ended > 0 || removed > 0) {
    console.log(`[SessionCloser] Ended ${ended} idle session(s), removed ${removed} empty one(s)`);
  }
}
