import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/connection.js';
import { AppError, ErrorCodes } from '../middleware/error-handler.middleware.js';
import { asyncHandler } from '../middleware/async-handler.js';

const router = Router();

const COOKIE_NAME = 'quinn_session';
const JWT_EXPIRY = '7d';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1, 'Display name is required').max(100),
});

interface JwtPayload {
  userId: string;
  email: string;
}

function getCookieOptions() {
  const isProduction = config.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' as const : 'lax' as const,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    path: '/',
  };
}

/**
 * POST /api/auth/login
 * Validate email/password with bcrypt, issue JWT in HTTP-only secure cookie.
 */
router.post('/login', asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = loginSchema.parse(req.body);

  const result = await query<{
    id: string;
    email: string;
    password_hash: string;
    display_name: string;
  }>(
    'SELECT id, email, password_hash, display_name FROM users WHERE email = $1',
    [email]
  );

  const user = result.rows[0];
  if (!user) {
    throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Invalid email or password');
  }

  const passwordValid = await bcrypt.compare(password, user.password_hash);
  if (!passwordValid) {
    throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Invalid email or password');
  }

  // Update last_login_at
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  // Issue JWT
  const payload: JwtPayload = { userId: user.id, email: user.email };
  const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: JWT_EXPIRY });

  res.cookie(COOKIE_NAME, token, getCookieOptions());

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    },
  });
}));

/**
 * POST /api/auth/register
 * Create a new user account with email/password.
 */
router.post('/register', asyncHandler(async (req: Request, res: Response) => {
  const { email, password, displayName } = registerSchema.parse(req.body);

  // Check if user already exists
  const existing = await query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );

  if (existing.rows.length > 0) {
    throw new AppError(409, ErrorCodes.CONFLICT, 'An account with this email already exists');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 10);

  // Create user
  const result = await query<{ id: string; email: string; display_name: string }>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, display_name`,
    [email, passwordHash, displayName]
  );

  const user = result.rows[0];
  if (!user) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'Failed to create user');
  }

  // Issue JWT
  const payload: JwtPayload = { userId: user.id, email: user.email };
  const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: JWT_EXPIRY });

  res.cookie(COOKIE_NAME, token, getCookieOptions());

  res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    },
  });
}));

/**
 * POST /api/auth/logout
 * Clear the auth cookie.
 */
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'none' as const,
    path: '/',
  });

  res.json({ message: 'Logged out successfully' });
});

/**
 * GET /api/auth/session
 * Validate current JWT from cookie, return user info if valid.
 */
router.get('/session', asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;

  if (!token) {
    throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'No active session');
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
  } catch {
    throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Invalid or expired session');
  }

  const result = await query<{
    id: string;
    email: string;
    display_name: string;
  }>(
    'SELECT id, email, display_name FROM users WHERE id = $1',
    [payload.userId]
  );

  const user = result.rows[0];
  if (!user) {
    throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'User not found');
  }

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    },
  });
}));

export const authRouter = router;
