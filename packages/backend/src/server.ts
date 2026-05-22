import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

// Import config - may throw if env vars are missing, but we handle gracefully
import { config } from './config.js';
import { query } from './db/connection.js';
import { notFoundHandler, errorHandler } from './middleware/error-handler.middleware.js';
import { authRouter } from './routes/auth.routes.js';
import { projectsRouter } from './routes/projects.routes.js';
import { personasRouter } from './routes/personas.routes.js';
import { sessionsRouter } from './routes/sessions.routes.js';
import { capturesRouter } from './routes/captures.routes.js';
import { corpusRouter } from './routes/corpus.routes.js';
import { snapshotsRouter } from './routes/snapshots.routes.js';
import { substackRouter } from './routes/substack.routes.js';
import { activityRouter } from './routes/activity.routes.js';
import { intelligenceRouter } from './routes/intelligence.routes.js';
import { promptlyRouter } from './routes/promptly.routes.js';
import { goalsRouter } from './routes/goals.routes.js';
import { nudgesRouter } from './routes/nudges.routes.js';
import { themesRouter } from './routes/themes.routes.js';
import { settingsRouter } from './routes/settings.routes.js';
import { exportRouter } from './routes/export.routes.js';
import { startScheduler } from './jobs/job-scheduler.js';

const app = express();

// Trust Railway's reverse proxy for correct IP detection (rate limiting, logging)
app.set('trust proxy', 1);

// Security headers — configure helmet to allow SSE streaming
app.use(
  helmet({
    // Disable content security policy in development for easier debugging
    contentSecurityPolicy: config.NODE_ENV === 'production' ? undefined : false,
  })
);

// CORS configuration for frontend origin (supports SSE streaming)
app.use(
  cors({
    origin: config.CORS_ORIGIN,
    credentials: true,
    exposedHeaders: ['Content-Type', 'Cache-Control', 'Connection'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  })
);

// Body parsing
app.use(express.json({ limit: '10mb' }));

// Cookie parsing
app.use(cookieParser());

// Health check - basic liveness
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Health check - readiness (verifies DB connectivity)
app.get('/api/health/ready', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
    });
  }
});

// API routes
app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/personas', personasRouter);
app.use('/api', sessionsRouter);
app.use('/api/captures', capturesRouter);
app.use('/api', corpusRouter);
app.use('/api', snapshotsRouter);
app.use('/api/integrations/substack', substackRouter);
app.use('/api/activity', activityRouter);
app.use('/api/intelligence', intelligenceRouter);
app.use('/api/promptly', promptlyRouter);
app.use('/api', goalsRouter);
app.use('/api/nudges', nudgesRouter);
app.use('/api/themes', themesRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/export', exportRouter);

// Catch-all for unmatched routes (must be after all route definitions)
app.use(notFoundHandler);

// Global error handler (must be the very last middleware)
app.use(errorHandler);

// Process-level safety net: log unhandled errors instead of crashing the process.
// This prevents Redis/Bull connection failures (or any other async error) from
// taking down the entire site. Express requests will still get proper error
// responses via the errorHandler middleware above.
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason instanceof Error ? reason.message : reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err.message);
  console.error(err.stack);
  // Don't exit — let the app keep serving requests.
});

// Start server
app.listen(config.PORT, () => {
  console.log(
    `Quinn Writing Studio API running on port ${config.PORT} [${config.NODE_ENV}]`
  );

  // Start background job scheduler
  startScheduler().catch((err) => {
    console.error('[Server] Failed to start job scheduler:', err);
  });
});

export { app };
