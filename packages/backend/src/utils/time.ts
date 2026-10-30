/**
 * Date/time formatting in the writer's time zone.
 *
 * The backend runs in UTC on Railway, so formatting with the server's zone
 * would tell Quinn it's 1 AM when it's 9 PM in Vermont, and could put an
 * evening session on the wrong day.
 */
import { config } from '../config.js';

/** e.g. "Friday, October 30, 2026" */
export function formatWriterDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    timeZone: config.WRITER_TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** e.g. "9:05 PM EDT" */
export function formatWriterTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    timeZone: config.WRITER_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}
