import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireRole, type AuthRequest, hashPassword } from '../middleware/auth';
import { notify } from './notifications';
import { sendPushToUser } from './push';

const router = Router();

function asyncH(fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: any, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// All admin routes require mod or admin
router.use(requireRole('mod'));

// ─── GET /admin/stats ──────────────────────────────
router.get('/stats', asyncH(async (_req: AuthRequest, res: Response) => {
  const [users, posts, comments, events, consultants, pendingEvents, flaggedPosts] = await Promise.all([
    prisma.user.count(),
    prisma.post.count(),
    prisma.comment.count(),
    prisma.event.count(),
    prisma.consultant.count(),
    prisma.event.count({ where: { status: 'pending' } }),
    prisma.post.count({ where: { flagged: true } }),
  ]);
  res.json({ users, posts, comments, events, consultants, pendingEvents, flaggedPosts });
}));

// ─── GET /admin/users ──────────────────────────────
router.get('/users', asyncH(async (_req: AuthRequest, res: Response) => {
  const users = await prisma.user.findMany({
    select: {
      id: true, username: true, email: true, isActive: true,
      role: true, createdAt: true, bio: true, location: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(users.map(u => ({
    id: u.id,
    username: u.username,
    email: u.email,
    is_active: u.isActive,
    role: u.role,
    bio: u.bio,
    location: u.location,
    created_at: u.createdAt,
  })));
}));

// ─── PATCH /admin/users/:id — toggle active / change role ─
const UserPatchSchema = z.object({
  is_active: z.boolean().optional(),
  role: z.enum(['user', 'mod', 'admin']).optional(),
});
router.patch('/users/:id', asyncH(async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid user ID' }); return; }
  const parsed = UserPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid body' }); return; }
  if (parsed.data.role !== undefined && req.user!.role !== 'admin') {
    res.status(403).json({ detail: 'Only admins may change roles' }); return;
  }
  if (parsed.data.role && parsed.data.role !== 'admin' && id === req.user!.id) {
    const admins = await prisma.user.count({ where: { role: 'admin' } });
    if (admins <= 1) { res.status(400).json({ detail: 'Cannot remove the last admin' }); return; }
  }
  const data: { isActive?: boolean; role?: string } = {};
  if (parsed.data.is_active !== undefined) data.isActive = parsed.data.is_active;
  if (parsed.data.role !== undefined) data.role = parsed.data.role;
  const updated = await prisma.user.update({ where: { id }, data });
  res.json({ id: updated.id, role: updated.role, is_active: updated.isActive });
}));

// ─── POST /admin/users/:id/reset-password ─────────
const ResetPasswordSchema = z.object({ new_password: z.string().min(4).max(128) });
router.post('/users/:id/reset-password', asyncH(async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'admin') { res.status(403).json({ detail: 'Admins only' }); return; }
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid user ID' }); return; }
  const parsed = ResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid body' }); return; }
  const hashed = await hashPassword(parsed.data.new_password);
  await prisma.user.update({ where: { id }, data: { hashedPassword: hashed } });
  res.json({ success: true });
}));

// ─── GET /admin/posts ──────────────────────────────
router.get('/posts', asyncH(async (req: AuthRequest, res: Response) => {
  const flaggedOnly = req.query.flagged === '1';
  const posts = await prisma.post.findMany({
    where: flaggedOnly ? { flagged: true } : {},
    orderBy: { createdAt: 'desc' },
    include: { author: { select: { username: true } } },
  });
  res.json(posts.map(p => ({
    id: p.id,
    title: p.title,
    content: p.content,
    category: p.category,
    author_id: p.authorId,
    author_username: p.author?.username ?? `user-${p.authorId}`,
    created_at: p.createdAt,
    upvotes: p.upvotes,
    flagged: p.flagged,
    status: p.status,
    source_type: p.sourceType,
  })));
}));

// ─── PATCH /admin/posts/:id — flag/unflag ────────
const PostPatchSchema = z.object({
  flagged: z.boolean().optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});
router.patch('/posts/:id', asyncH(async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid post ID' }); return; }
  const parsed = PostPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid body' }); return; }
  const data: { flagged?: boolean; status?: string } = {};
  if (parsed.data.flagged !== undefined) data.flagged = parsed.data.flagged;
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  const updated = await prisma.post.update({ where: { id }, data });
  res.json({ id: updated.id, flagged: updated.flagged, status: updated.status });
}));

// ─── GET /admin/events ─────────────────────────
router.get('/events', asyncH(async (req: AuthRequest, res: Response) => {
  const statusFilter = (req.query.status as string) || undefined;
  const events = await prisma.event.findMany({
    where: statusFilter ? { status: statusFilter } : {},
    orderBy: { createdAt: 'desc' },
    include: { organizer: { select: { username: true } }, _count: { select: { attendees: true } } },
  });
  res.json(events.map(e => ({
    id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    event_date: e.eventDate,
    organizer_id: e.organizerId,
    organizer_username: e.organizer?.username ?? `user-${e.organizerId}`,
    status: e.status,
    attendee_count: e._count.attendees,
    created_at: e.createdAt,
  })));
}));

// ─── PATCH /admin/events/:id — approve/reject ──────
const EventPatchSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']),
});
router.patch('/events/:id', asyncH(async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid event ID' }); return; }
  const parsed = EventPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid body' }); return; }
  const prev = await prisma.event.findUnique({ where: { id } });
  const updated = await prisma.event.update({
    where: { id }, data: { status: parsed.data.status },
  });
  if (prev && prev.status !== parsed.data.status && prev.status === 'pending') {
    const approved = parsed.data.status === 'approved';
    const title = approved ? 'Evento aprobado' : 'Evento rechazado';
    const body = approved
      ? `Tu evento "${updated.title}" fue aprobado y ya está visible.`
      : `Tu evento "${updated.title}" fue rechazado.`;
    notify(updated.organizerId, 'event_status', title, body, `/events`).catch(() => null);
    sendPushToUser(updated.organizerId, title, body).catch(() => null);
  }
  res.json({ id: updated.id, status: updated.status });
}));

// ─── GET /admin/comments ───────────────────────
router.get('/comments', asyncH(async (_req: AuthRequest, res: Response) => {
  const comments = await prisma.comment.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      author: { select: { username: true } },
      post: { select: { id: true, title: true } },
    },
  });
  res.json(comments.map(c => ({
    id: c.id,
    content: c.content,
    post_id: c.postId,
    post_title: c.post?.title ?? '(deleted post)',
    author_id: c.authorId,
    author_username: c.author?.username ?? `user-${c.authorId}`,
    created_at: c.createdAt,
  })));
}));

// ─── GET /admin/consultants ────────────────────
router.get('/consultants', asyncH(async (_req: AuthRequest, res: Response) => {
  const list = await prisma.consultant.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(list.map(c => ({
    id: c.id, name: c.name, specialty: c.specialty,
    description: c.description, contact: c.contact,
    endorsements: c.endorsements, created_at: c.createdAt,
  })));
}));

// ─── DELETE /admin/consultants/:id ─────────────
router.delete('/consultants/:id', asyncH(async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid consultant ID' }); return; }
  await prisma.consultant.delete({ where: { id } }).catch(() => null);
  res.json({ success: true });
}));

// ─── POST /admin/consultants ─── create new consultant
const ConsultantCreateSchema = z.object({
  name: z.string().min(1).max(100),
  specialty: z.string().min(1).max(100),
  description: z.string().min(1),
  contact: z.string().min(1).max(200),
});
router.post('/consultants', asyncH(async (req: AuthRequest, res: Response) => {
  const parsed = ConsultantCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Invalid body', errors: parsed.error.flatten() });
    return;
  }
  const c = await prisma.consultant.create({ data: parsed.data });
  res.status(201).json({
    id: c.id, name: c.name, specialty: c.specialty,
    description: c.description, contact: c.contact,
    endorsements: c.endorsements, created_at: c.createdAt,
  });
}));

// ─── PATCH /admin/consultants/:id ─── edit consultant
const ConsultantPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  specialty: z.string().min(1).max(100).optional(),
  description: z.string().min(1).optional(),
  contact: z.string().min(1).max(200).optional(),
});
router.patch('/consultants/:id', asyncH(async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid consultant ID' }); return; }
  const parsed = ConsultantPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid body' }); return; }
  const c = await prisma.consultant.update({ where: { id }, data: parsed.data });
  res.json({
    id: c.id, name: c.name, specialty: c.specialty,
    description: c.description, contact: c.contact,
    endorsements: c.endorsements, created_at: c.createdAt,
  });
}));

export default router;
