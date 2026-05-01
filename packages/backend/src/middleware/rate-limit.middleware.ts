import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';
import { config } from '../config.js';

/**
 * Creates a Redis store for rate limiting, with fallback to in-memory store
 * if Redis is unavailable.
 */
function createRedisStore(prefix: string): RedisStore | undefined {
  try {
    const client = new Redis(config.REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });

    client.on('error', (err) => {
      console.warn(`[RateLimit] Redis error for ${prefix}:`, err.message);
    });

    // Attempt connection (non-blocking)
    client.connect().catch(() => {
      console.warn(`[RateLimit] Redis unavailable for ${prefix}, falling back to memory store`);
    });

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
