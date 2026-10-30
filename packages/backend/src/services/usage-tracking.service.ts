import { query } from '../db/connection.js';
import type { ModelSelection } from './claude-api.service.js';

// ─── Pricing Configuration ───────────────────────────────────────────────────

/**
 * Pricing per 1M tokens for the default models in claude-api.service.ts
 * (https://platform.claude.com/docs/en/about-claude/pricing, October 2026):
 *   Sonnet 5.5: $2 input / $10 output
 *   Opus 5.5:   $4 input / $20 output
 *   Haiku 5.5:  $0.10 input / $0.50 output (prompts up to 100k tokens)
 * Output includes thinking tokens. If you override a model ID with an env var,
 * update its rates here.
 */
interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICING: Record<ModelSelection, ModelPricing> = {
  sonnet: {
    inputPer1M: 2.0,
    outputPer1M: 10.0,
  },
  opus: {
    inputPer1M: 4.0,
    outputPer1M: 20.0,
  },
  haiku: {
    inputPer1M: 0.1,
    outputPer1M: 0.5,
  },
};

// ─── Public Functions ────────────────────────────────────────────────────────

/**
 * Calculate estimated cost in USD for a Claude API request.
 */
export function calculateCost(
  model: ModelSelection,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = PRICING[model];
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Log API usage to the api_usage_logs table.
 * Should be called after every Claude API request.
 */
export async function logApiUsage(
  userId: string,
  model: ModelSelection,
  featureArea: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  const estimatedCost = calculateCost(model, inputTokens, outputTokens);

  await query(
    `INSERT INTO api_usage_logs (user_id, model, feature_area, input_tokens, output_tokens, estimated_cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, model, featureArea, inputTokens, outputTokens, estimatedCost]
  );
}
