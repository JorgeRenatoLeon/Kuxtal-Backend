import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { hashPassword, verifyPassword, signToken, requireAuth, type AuthRequest } from '../middleware/auth';

const router = Router();

function asyncH(fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: any, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ─── Schemas ───────────────────────────────────────────────
const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const RegisterSchema = z.object({
  username: z.string().min(2).max(50),
  email: z.string().email(),
  password: z.string().min(4).max(128),
});

const ProfileUpdateSchema = z.object({
  email: z.string().email().optional(),
  bio: z.string().max(500).optional().nullable(),
  location: z.string().max(120).optional().nullable(),
  current_password: z.string().min(1).optional(),
  new_password: z.string().min(4).max(128).optional(),
});

// ─── POST /token ──────────────────────────────────
router.post('/token', asyncH(async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Invalid request body', errors: parsed.error.flatten() });
    return;
  }

  const { username, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { username } });

  if (!user || !(await verifyPassword(password, user.hashedPassword))) {
    res.status(401).json({ detail: 'Incorrect username or password' });
    return;
  }

  if (!user.isActive) {
    res.status(403).json({ detail: 'Account is disabled' });
    return;
  }

  const token = signToken({ sub: user.username, userId: user.id });
  res.json({ access_token: token, token_type: 'bearer', role: user.role });
}));

// ─── POST /users/ ───────────────────────────────
router.post('/users/', asyncH(async (req: Request, res: Response) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Invalid request body', errors: parsed.error.flatten() });
    return;
  }

  const { username, email, password } = parsed.data;

  const existing = await prisma.user.findFirst({
    where: { OR: [{ username }, { email }] },
  });
  if (existing) {
    res.status(400).json({ detail: 'Username or email already registered' });
    return;
  }

  const hashed = await hashPassword(password);
  const user = await prisma.user.create({
    data: { username, email, hashedPassword: hashed },
  });

  res.status(201).json({
    id: user.id,
    username: user.username,
    email: user.email,
    is_active: user.isActive,
    role: user.role,
    created_at: user.createdAt,
  });
}));

// ─── GET /users/me/ ──────────────────────────────────────
router.get('/users/me/', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) {
    res.status(404).json({ detail: 'User not found' });
    return;
  }

  const [postCount, commentCount, eventCount, sharedRulesCount, attendeeCount] = await Promise.all([
    prisma.post.count({ where: { authorId: user.id } }),
    prisma.comment.count({ where: { authorId: user.id } }),
    prisma.event.count({ where: { organizerId: user.id } }),
    prisma.post.count({ where: { authorId: user.id, sourceType: { not: null } } }),
    prisma.eventAttendee.count({ where: { userId: user.id } }),
  ]);

  res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    is_active: user.isActive,
    role: user.role,
    bio: user.bio,
    location: user.location,
    created_at: user.createdAt,
    stats: {
      posts: postCount,
      comments: commentCount,
      events: eventCount,
      shared: sharedRulesCount,
      attending: attendeeCount,
    },
  });
}));

// ─── PATCH /users/me/ — edit profile ─────────────
router.patch('/users/me/', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const parsed = ProfileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Invalid request body', errors: parsed.error.flatten() });
    return;
  }
  const { email, bio, location, current_password, new_password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) { res.status(404).json({ detail: 'User not found' }); return; }

  const data: { email?: string; bio?: string | null; location?: string | null; hashedPassword?: string } = {};

  if (email && email !== user.email) {
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) { res.status(400).json({ detail: 'Email already in use' }); return; }
    data.email = email;
  }
  if (bio !== undefined) data.bio = bio ?? null;
  if (location !== undefined) data.location = location ?? null;

  if (new_password) {
    if (!current_password || !(await verifyPassword(current_password, user.hashedPassword))) {
      res.status(403).json({ detail: 'Current password incorrect' });
      return;
    }
    data.hashedPassword = await hashPassword(new_password);
  }

  const updated = await prisma.user.update({ where: { id: user.id }, data });
  res.json({
    id: updated.id,
    username: updated.username,
    email: updated.email,
    bio: updated.bio,
    location: updated.location,
    role: updated.role,
  });
}));

export default router;
