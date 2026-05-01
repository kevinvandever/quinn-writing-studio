/**
 * Themes Routes
 *
 * Provides cross-project theme analysis and theme map endpoints.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { analyzeThemes, getThemeMap } from '../services/theme-analysis.service.js';

const router = Router();

// Apply auth middleware to all theme routes
router.use(requireAuth);

/**
 * POST /api/themes/analyze
 * Trigger cross-project theme analysis.
 */
router.post('/analyze', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const connections = await analyzeThemes(userId);

  res.json({
    connections,
    count: connections.length,
    message: `Discovered ${connections.length} thematic connections`,
  });
}));

/**
 * GET /api/themes
 * Get the theme map (all connections with document details).
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const connections = await getThemeMap(userId);

  // Group by theme for easier frontend consumption
  const themeGroups: Record<string, typeof connections> = {};
  for (const conn of connections) {
    if (!themeGroups[conn.theme]) {
      themeGroups[conn.theme] = [];
    }
    themeGroups[conn.theme]!.push(conn);
  }

  res.json({
    connections,
    themes: Object.entries(themeGroups).map(([theme, conns]) => ({
      theme,
      connectionCount: conns.length,
      avgStrength: conns.reduce((sum, c) => sum + c.strength, 0) / conns.length,
      connections: conns,
    })),
  });
}));

export const themesRouter = router;
