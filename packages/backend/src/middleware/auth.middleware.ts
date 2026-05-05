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
 * Middleware that extracts JWT from the 'quinn_session' cookie or
 * Authorization Bearer header, validates it using JWT_SECRET, and
 * attaches user info to the request.
 * Returns 401 for invalid or missing tokens.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  // Try cookie first, then Authorization header (mobile fallback)
  let token = req.cookies?.[COOKIE_NAME] as string | undefined;

  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
  }

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
