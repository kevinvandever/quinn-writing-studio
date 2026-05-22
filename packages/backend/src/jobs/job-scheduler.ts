import Bull from 'bull';
import * as cron from 'node-cron';
import Redis from 'ioredis';
import { config } from '../config.js';
import { query } from '../db/connection.js';
import { runGrantScanner } from './grant-scanner.job.js';
import { runAiNewsScanner } from './ai-news-scanner.job.js';
import { runPublishingScanner } from './publishing-scanner.job.js';
import { runNudgeChecker } from './nudge-checker.job.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IntelligenceSchedules {
  grant_scanner: string;
  ai_news_scanner: string;
  publishing_scanner: string;
  [key: string]: string;
}

interface JobPayload {
  userId: string;
  jobType: string;
}

// ─── Default Schedules ───────────────────────────────────────────────────────

const DEFAULT_SCHEDULES: IntelligenceSchedules = {
  grant_scanner: '0 6 * * *',       // Daily at 6:00 AM UTC
  ai_news_scanner: '0 */6 * * *',   // Every 6 hours
  publishing_scanner: '0 7 * * *',   // Daily at 7:00 AM UTC
};

// ─── Bull Queue Setup ────────────────────────────────────────────────────────

let intelligenceQueue: Bull.Queue<JobPayload> | null = null;
const cronJobs: cron.ScheduledTask[] = [];

/**
 * Initialize the Bull queue for intelligence jobs.
 */
function getQueue(): Bull.Queue<JobPayload> {
  if (!intelligenceQueue) {
    intelligenceQueue = new Bull<JobPayload>('intelligence-jobs', config.REDIS_URL, {
      redis: {
        // Don't throw fatal MaxRetriesPerRequestError when Redis is briefly unreachable.
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
        retryStrategy(times: number) {
          if (times > 10) {
            console.warn('[JobScheduler] Bull Redis retry limit reached');
            return null;
          }
          return Math.min(times * 1000, 30000);
        },
      },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60000, // 1 minute initial delay
        },
      },
    });

    // Bull queue error handler — log but never crash.
    intelligenceQueue.on('error', (err) => {
      console.warn('[JobScheduler] Queue error:', err.message);
    });

    // Register job processors
    intelligenceQueue.process('grant-scan', async (job) => {
      console.log('[JobScheduler] Processing grant-scan job');
      await runGrantScanner(job.data.userId);
    });

    intelligenceQueue.process('ai-news-scan', async (job) => {
      console.log('[JobScheduler] Processing ai-news-scan job');
      await runAiNewsScanner(job.data.userId);
    });

    intelligenceQueue.process('publishing-scan', async (job) => {
      console.log('[JobScheduler] Processing publishing-scan job');
      await runPublishingScanner(job.data.userId);
    });

    intelligenceQueue.process('nudge-check', async (job) => {
      console.log('[JobScheduler] Processing nudge-check job');
      await runNudgeChecker(job.data.userId);
    });

    // Error handling
    intelligenceQueue.on('failed', (job, err) => {
      console.error(`[JobScheduler] Job ${job.name} failed:`, err.message);
    });

    intelligenceQueue.on('completed', (job) => {
      console.log(`[JobScheduler] Job ${job.name} completed`);
    });
  }

  return intelligenceQueue;
}

// ─── Scheduler Control ───────────────────────────────────────────────────────

/**
 * Start the job scheduler. Loads schedules from settings and sets up cron jobs.
 * Should be called on server startup.
 */
export async function startScheduler(): Promise<void> {
  console.log('[JobScheduler] Starting intelligence job scheduler...');

  // Test Redis connectivity before setting up Bull queue
  try {
    const testClient = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy(times: number) {
        if (times > 2) return null;
        return Math.min(times * 500, 2000);
      },
    });

    await new Promise<void>((resolve, reject) => {
      testClient.on('ready', () => {
        testClient.disconnect();
        resolve();
      });
      testClient.on('error', (err: Error) => {
        testClient.disconnect();
        reject(err);
      });
      setTimeout(() => {
        testClient.disconnect();
        reject(new Error('Redis connection timeout'));
      }, 5000);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.warn(`[JobScheduler] Redis unavailable (${message}). Background jobs disabled.`);
    return;
  }

  const schedules = await loadSchedules();
  const userId = await getDefaultUserId();

  if (!userId) {
    console.log('[JobScheduler] No user found, scheduler will not start cron jobs');
    return;
  }

  const queue = getQueue();

  // Schedule grant scanner
  if (cron.validate(schedules.grant_scanner)) {
    const task = cron.schedule(schedules.grant_scanner, async () => {
      await queue.add('grant-scan', { userId, jobType: 'grant-scan' });
    });
    cronJobs.push(task);
    console.log(`[JobScheduler] Grant scanner scheduled: ${schedules.grant_scanner}`);
  }

  // Schedule AI news scanner
  if (cron.validate(schedules.ai_news_scanner)) {
    const task = cron.schedule(schedules.ai_news_scanner, async () => {
      await queue.add('ai-news-scan', { userId, jobType: 'ai-news-scan' });
    });
    cronJobs.push(task);
    console.log(`[JobScheduler] AI news scanner scheduled: ${schedules.ai_news_scanner}`);
  }

  // Schedule publishing scanner
  if (cron.validate(schedules.publishing_scanner)) {
    const task = cron.schedule(schedules.publishing_scanner, async () => {
      await queue.add('publishing-scan', { userId, jobType: 'publishing-scan' });
    });
    cronJobs.push(task);
    console.log(`[JobScheduler] Publishing scanner scheduled: ${schedules.publishing_scanner}`);
  }

  // Schedule nudge checker (hourly)
  const nudgeSchedule = '0 * * * *'; // Every hour
  if (cron.validate(nudgeSchedule)) {
    const task = cron.schedule(nudgeSchedule, async () => {
      await queue.add('nudge-check', { userId, jobType: 'nudge-check' });
    });
    cronJobs.push(task);
    console.log(`[JobScheduler] Nudge checker scheduled: ${nudgeSchedule}`);
  }

  console.log('[JobScheduler] All intelligence jobs scheduled');
}

/**
 * Stop the job scheduler. Cancels all cron jobs and closes the Bull queue.
 */
export async function stopScheduler(): Promise<void> {
  console.log('[JobScheduler] Stopping scheduler...');

  // Stop all cron jobs
  for (const job of cronJobs) {
    job.stop();
  }
  cronJobs.length = 0;

  // Close Bull queue
  if (intelligenceQueue) {
    await intelligenceQueue.close();
    intelligenceQueue = null;
  }

  console.log('[JobScheduler] Scheduler stopped');
}

/**
 * Manually trigger a specific job type.
 */
export async function triggerJob(jobType: string, userId: string): Promise<void> {
  const queue = getQueue();
  await queue.add(jobType, { userId, jobType });
  console.log(`[JobScheduler] Manually triggered ${jobType} job`);
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Load intelligence schedules from settings, falling back to defaults.
 */
async function loadSchedules(): Promise<IntelligenceSchedules> {
  try {
    const result = await query<{ intelligence_schedules: IntelligenceSchedules | null }>(
      `SELECT intelligence_schedules FROM settings LIMIT 1`
    );

    const schedules = result.rows[0]?.intelligence_schedules;
    if (schedules && typeof schedules === 'object') {
      return {
        ...DEFAULT_SCHEDULES,
        ...schedules,
      };
    }
  } catch (error) {
    console.error('[JobScheduler] Error loading schedules:', error);
  }

  return DEFAULT_SCHEDULES;
}

/**
 * Get the default user ID (single-user system).
 */
async function getDefaultUserId(): Promise<string | null> {
  try {
    const result = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    return result.rows[0]?.id || null;
  } catch {
    return null;
  }
}
