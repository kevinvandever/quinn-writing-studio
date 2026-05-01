/**
 * Export Routes
 *
 * Provides data export functionality for user data portability.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import { generateExport, getExportStatus, getExportBuffer } from '../services/export.service.js';

const router = Router();

// Apply auth middleware to all export routes
router.use(requireAuth);

// In-memory export job tracking (in production, use Redis or DB)
const exportJobs = new Map<string, { userId: string; status: string; projectId?: string }>();

/**
 * POST /api/export
 * Initiate a full or per-project export.
 * Body: { project_id?: string } — if omitted, exports all data.
 */
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { project_id } = req.body;

  // Generate a job ID
  const jobId = crypto.randomUUID();

  // Track the job
  exportJobs.set(jobId, { userId, status: 'processing', projectId: project_id });

  // Start export generation (async)
  generateExport(userId, project_id)
    .then(() => {
      const job = exportJobs.get(jobId);
      if (job) job.status = 'completed';
    })
    .catch((err) => {
      console.error('[Export] Export generation failed:', err);
      const job = exportJobs.get(jobId);
      if (job) job.status = 'failed';
    });

  res.status(202).json({
    jobId,
    status: 'processing',
    message: 'Export initiated. Check status at /api/export/:jobId/status',
  });
}));

/**
 * GET /api/export/:jobId/status
 * Check export progress.
 */
router.get('/:jobId/status', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const jobId = req.params.jobId as string;

  const job = exportJobs.get(jobId);

  if (!job || job.userId !== userId) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Export job not found');
  }

  // Also check the service-level status
  const serviceStatus = getExportStatus(userId);

  res.json({
    jobId,
    status: job.status,
    ready: job.status === 'completed' && serviceStatus === 'ready',
    downloadUrl: job.status === 'completed' ? `/api/export/${jobId}/download` : null,
  });
}));

/**
 * GET /api/export/:jobId/download
 * Download the export archive.
 */
router.get('/:jobId/download', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const jobId = req.params.jobId as string;

  const job = exportJobs.get(jobId);

  if (!job || job.userId !== userId) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Export job not found');
  }

  if (job.status !== 'completed') {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Export is not yet ready for download');
  }

  const buffer = getExportBuffer(userId);

  if (!buffer) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Export file not found. It may have expired.');
  }

  const filename = `quinn-export-${new Date().toISOString().split('T')[0]}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length.toString());
  res.send(buffer);

  // Clean up after download
  exportJobs.delete(jobId);
}));

export const exportRouter = router;
