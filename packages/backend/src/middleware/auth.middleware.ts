import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { AppError, ErrorCodes } from './error-handler.middleware.js';

const COOKIE_NAME = 'quinn_session';

export interface AuthUser {
  userId: string;
  email: string;
}

/**
 * Middleware that extracts JWT from the 'quinn_session' cookie,
 * validates it using JWT_SECRET, and attaches user info to the request.
 * Returns 401 for invalid or missing tokens.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;

  if (!token) {
    throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Authentication required');
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as AuthUser;
    req.user = {
      userId: payload.userId,
      email: payload.email,
    };
    next();
  } catch {
    throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Invalid or expired token');
  }
}
