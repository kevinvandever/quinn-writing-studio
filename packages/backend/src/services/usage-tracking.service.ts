import { query } from '../db/connection.js';
import type { CacheUsage, ModelSelection } from './claude-api.service.js';

// ─── Pricing Configuration ───────────────────────────────────────────────────

/**
 * Pricing per 1M tokens for the default models in claude-api.service.ts
 * (https://platform.claude.com/docs/en/about-claude/pricing, October 2026):
 *   Sonnet 5.5: $2 input / $10 output, cache reads $0.10
 *   Opus 5.5:   $4 input / $20 output, cache reads $0.20
 *   Haiku 5.5:  $0.10 input / $0.50 output, cache reads $0.01 (prompts up to 100k tokens)
 * Cache writes cost 1.25x input (5-minute TTL) or 2x input (1-hour TTL).
 * Output includes thinking tokens. If you override a model ID with an env var,
 * update its rates here.
 */
interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
}

const PRICING: Record<ModelSelection, ModelPricing> = {
  sonnet: {
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    cacheReadPer1M: 0.1,
  },
  opus: {
    inputPer1M: 4.0,
    outputPer1M: 20.0,
    cacheReadPer1M: 0.2,
  },
  haiku: {
    inputPer1M: 0.1,
    outputPer1M: 0.5,
    cacheReadPer1M: 0.01,
  },
};

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

// ─── Public Functions ────────────────────────────────────────────────────────

/**
 * Calculate estimated cost in USD for a Claude API request. `inputTokens` is
 * uncached input only; cached tokens are priced from `cache`.
 */
export function calculateCost(
  model: ModelSelection,
  inputTokens: number,
  outputTokens: number,
  cache?: CacheUsage
): number {
  const pricing = PRICING[model];
  const perToken = (per1M: number) => per1M / 1_000_000;
  let cost =
    inputTokens * perToken(pricing.inputPer1M) + outputTokens * perToken(pricing.outputPer1M);
  if (cache) {
    cost += cache.readTokens * perToken(pricing.cacheReadPer1M);
    cost += cache.write5mTokens * perToken(pricing.inputPer1M * CACHE_WRITE_5M_MULTIPLIER);
    cost += cache.write1hTokens * perToken(pricing.inputPer1M * CACHE_WRITE_1H_MULTIPLIER);
  }
  return cost;
}

/**
 * Log API usage to the api_usage_logs table.
 * Should be called after every Claude API request.
 *
 * `inputTokens` is uncached input; pass `cache` for prompt-cached requests.
 * The stored input_tokens column holds all input (uncached + cache writes +
 * cache reads) so volumes stay comparable; estimated_cost_usd prices each kind.
 */
export async function logApiUsage(
  userId: string,
  model: ModelSelection,
  featureArea: string,
  inputTokens: number,
  outputTokens: number,
  cache?: CacheUsage
): Promise<void> {
  const estimatedCost = calculateCost(model, inputTokens, outputTokens, cache);
  const allInputTokens =
    inputTokens + (cache ? cache.readTokens + cache.write5mTokens + cache.write1hTokens : 0);

  await query(
    `INSERT INTO api_usage_logs (user_id, model, feature_area, input_tokens, output_tokens, estimated_cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, model, featureArea, allInputTokens, outputTokens, estimatedCost]
  );
}
