/**
 * API Usage / Cost Reporting
 *
 * `usage-tracking.service.ts` has been writing every Claude call to
 * api_usage_logs (model, feature area, tokens, estimated cost) but nothing ever
 * read it — so spend was invisible. That matters now that the deep coaching
 * modes (Essay Triage, Editorial Pass, /analyze, /place-this) route to Opus,
 * which costs meaningfully more per call than Sonnet.
 *
 * Returns the shape the existing UsageDashboard component was written against.
 */
import { Router, Request, Response } from 'express';
import { query } from '../db/connection.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';

export const usageRouter = Router();

usageRouter.use(requireAuth);

/** Map a period name to a number of days. */
const PERIOD_DAYS: Record<string, number> = {
  week: 7,
  month: 30,
  quarter: 90,
};

// ─── GET /api/usage ──────────────────────────────────────────────────────────

/**
 * Aggregate API usage for the current user over a period.
 * Query params: period = week | month | quarter (default: month)
 */
usageRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const periodParam = typeof req.query['period'] === 'string' ? req.query['period'] : 'month';
  const days = PERIOD_DAYS[periodParam] ?? PERIOD_DAYS['month']!;

  const result = await query<{
    date: string;
    model: string;
    feature_area: string;
    total_cost: string;
    total_input_tokens: string;
    total_output_tokens: string;
  }>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
            model,
            feature_area,
            SUM(estimated_cost_usd)::text AS total_cost,
            SUM(input_tokens)::text       AS total_input_tokens,
            SUM(output_tokens)::text      AS total_output_tokens
     FROM api_usage_logs
     WHERE user_id = $1
       AND created_at >= NOW() - ($2 || ' days')::interval
     GROUP BY 1, 2, 3
     ORDER BY 1 DESC`,
    [userId, String(days)]
  );

  // decimal/bigint columns come back as strings from pg — coerce before math.
  const daily = result.rows.map((r) => ({
    date: r.date,
    model: r.model,
    feature_area: r.feature_area,
    total_cost: parseFloat(r.total_cost) || 0,
    total_input_tokens: parseInt(r.total_input_tokens, 10) || 0,
    total_output_tokens: parseInt(r.total_output_tokens, 10) || 0,
  }));

  let totalCost = 0;
  const byModel: Record<string, number> = {};
  const byFeature: Record<string, number> = {};

  for (const row of daily) {
    totalCost += row.total_cost;
    byModel[row.model] = (byModel[row.model] ?? 0) + row.total_cost;
    byFeature[row.feature_area] = (byFeature[row.feature_area] ?? 0) + row.total_cost;
  }

  res.json({
    usage: {
      totalCost,
      byModel,
      byFeature,
      daily,
      period: periodParam,
    },
  });
}));
