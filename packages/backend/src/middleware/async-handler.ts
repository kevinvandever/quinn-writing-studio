import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async Express route handler to ensure rejected promises
 * are forwarded to Express error handling middleware.
 *
 * Express 4 does not natively catch async errors — without this wrapper,
 * unhandled promise rejections cause requests to hang indefinitely.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
