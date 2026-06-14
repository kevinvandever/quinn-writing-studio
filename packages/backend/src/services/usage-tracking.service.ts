import { query } from '../db/connection.js';
import type { ModelSelection } from './claude-api.service.js';

// ─── Pricing Configuration ───────────────────────────────────────────────────

/**
 * Configurable pricing rates per 1M tokens.
 * Sonnet 4.6: $3 input / $15 output per 1M tokens
 * Opus 4.8: $5 input / $25 output per 1M tokens
 */
interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICING: Record<ModelSelection, ModelPricing> = {
  sonnet: {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
  opus: {
    inputPer1M: 5.0,
    outputPer1M: 25.0,
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
