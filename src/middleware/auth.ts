import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import prisma from '../prisma';

export type Role = 'user' | 'mod' | 'admin';

// ─── Password utilities ────────────────────────────────────
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plain, hashed);
}

// ─── JWT utilities ─────────────────────────────────────────
export function signToken(payload: { sub: string; userId: number }): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn as any });
}

export function verifyToken(token: string): { sub: string; userId: number } {
  return jwt.verify(token, config.jwtSecret) as { sub: string; userId: number };
}

// ─── Auth middleware ───────────────────────────────────────
export interface AuthRequest extends Request {
  user?: { id: number; username: string; role: Role };
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ detail: 'Missing or invalid Authorization header' });
    return;
  }

  try {
    const token = header.slice(7);
    const decoded = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user?.isActive) {
      res.status(401).json({ detail: 'User not found or inactive' });
      return;
    }
    req.user = { id: user.id, username: user.username, role: (user.role as Role) ?? 'user' };
    next();
  } catch {
    res.status(401).json({ detail: 'Invalid or expired token' });
  }
}

// ─── Role gate (mod or admin allowed when minimum is 'mod') ─
export function requireRole(min: 'mod' | 'admin') {
  const allowed: Role[] = min === 'admin' ? ['admin'] : ['mod', 'admin'];
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    await requireAuth(req, res, () => {
      if (!req.user || !allowed.includes(req.user.role)) {
        res.status(403).json({ detail: 'Insufficient privileges' });
        return;
      }
      next();
    });
  };
}
