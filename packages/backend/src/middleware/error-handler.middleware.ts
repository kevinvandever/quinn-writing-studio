import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { config } from '../config.js';

// Standard error codes
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Application error class with structured error information.
 * Throw this from route handlers to return consistent JSON error responses.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Express error handler middleware.
 * Must be registered after all routes.
 * Returns consistent JSON: { code, message, details? }
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Log all errors
  console.error(`[Error] ${err.name}: ${err.message}`, {
    stack: err.stack,
    ...(err instanceof AppError && { code: err.code, statusCode: err.statusCode }),
  });

  // Handle AppError instances
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      ...(err.details !== undefined && { details: err.details }),
    });
    return;
  }

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const fieldErrors = err.errors.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));

    res.status(400).json({
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Validation failed',
      details: fieldErrors,
    });
    return;
  }

  // Generic/unknown errors — hide details in production
  const isProduction = config.NODE_ENV === 'production';

  res.status(500).json({
    code: ErrorCodes.INTERNAL_ERROR,
    message: isProduction ? 'An unexpected error occurred' : err.message,
    ...(!isProduction && { details: err.stack }),
  });
}

/**
 * Middleware for unmatched routes. Returns 404 NOT_FOUND.
 * Must be registered after all routes but before the error handler.
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  res.status(404).json({
    code: ErrorCodes.NOT_FOUND,
    message: `Route not found: ${req.method} ${req.path}`,
  });
}
