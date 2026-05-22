import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';
import { config } from '../config.js';

/**
 * Shared Redis client for all rate-limit stores.
 * Created once, reused across limiters.
 * null if Redis is unavailable (falls back to in-memory).
 */
let redisClient: Redis | null = null;
let redisDisabled = false;

function getRedisClient(): Redis | null {
  if (redisDisabled) return null;
  if (redisClient) return redisClient;

  try {
    redisClient = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null, // never throw MaxRetriesPerRequestError
      enableOfflineQueue: false,  // fail commands immediately if not connected
      connectTimeout: 5000,
      retryStrategy(times) {
        // Stop retrying after 10 attempts; backoff up to 30s between attempts.
        if (times > 10) {
          console.warn('[RateLimit] Redis retry limit reached, disabling Redis-backed rate limiting.');
          redisDisabled = true;
          return null;
        }
        return Math.min(times * 1000, 30000);
      },
    });

    redisClient.on('ready', () => {
      console.log('[RateLimit] Redis connected');
      redisDisabled = false;
    });

    redisClient.on('error', (err) => {
      console.warn('[RateLimit] Redis error:', err.message);
    });

    redisClient.on('end', () => {
      console.warn('[RateLimit] Redis connection closed');
    });

    return redisClient;
  } catch (err) {
    console.warn('[RateLimit] Failed to create Redis client, using memory store:', err instanceof Error ? err.message : err);
    redisDisabled = true;
    return null;
  }
}

/**
 * Creates a Redis store for rate limiting.
 * Returns undefined if Redis is unavailable (express-rate-limit falls back to memory).
 */
function createRedisStore(prefix: string): RedisStore | undefined {
  const client = getRedisClient();
  if (!client) return undefined;

  try {
    return new RedisStore({
      // @ts-expect-error - ioredis is compatible with rate-limit-redis sendCommand
      sendCommand: (...args: string[]) => client.call(...args),
      prefix: `rl:${prefix}:`,
    });
  } catch {
    console.warn(`[RateLimit] Failed to create Redis store for ${prefix}, using memory store`);
    return undefined;
  }
}

/**
 * General rate limiter: 100 requests per minute per IP.
 * Applied to all API routes.
 */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('general'),
  message: {
    code: 'RATE_LIMITED',
    message: 'Too many requests, please try again later',
  },
});

/**
 * Claude API rate limiter: 20 requests per minute per IP.
 * Applied to endpoints that call the Claude API.
 */
export const claudeApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('claude'),
  message: {
    code: 'RATE_LIMITED',
    message: 'Too many AI requests, please try again later',
  },
});
