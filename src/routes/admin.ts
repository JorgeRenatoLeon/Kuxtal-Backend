import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireRole, type AuthRequest, hashPassword } from '../middleware/auth';

const router = Router();

// All admin routes require mod or admin
router.use(requireRole('mod'));

// ─── GET /admin/stats ──────────────────────────────
router.get('/stats', async (_req: AuthRequest, res: Response) => {
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
});

// ─── GET /admin/users ──────────────────────────────
router.get('/users', async (_req: AuthRequest, res: Response) => {
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
});

// ─── PATCH /admin/users/:id — toggle active / change role ─
const UserPatchSchema = z.object({
  is_active: z.boolean().optional(),
  role: z.enum(['user', 'mod', 'admin']).optional(),
});
router.patch('/users/:id', async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid user ID' }); return; }
  const parsed = UserPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid body' }); return; }
  // Only admins may promote/demote
  if (parsed.data.role !== undefined && req.user!.role !== 'admin') {
    res.status(403).json({ detail: 'Only admins may change roles' }); return;
  }
  // Don't let a user demote themselves below admin if they are the only admin
  if (parsed.data.role && parsed.data.role !== 'admin' && id === req.user!.id) {
    const admins = await prisma.user.count({ where: { role: 'admin' } });
    if (admins <= 1) { res.status(400).json({ detail: 'Cannot remove the last admin' }); return; }
  }
  const data: { isActive?: boolean; role?: string } = {};
  if (parsed.data.is_active !== undefined) data.isActive = parsed.data.is_active;
  if (parsed.data.role !== undefined) data.role = parsed.data.role;
  const updated = await prisma.user.update({ where: { id }, data });
  res.json({ id: updated.id, role: updated.role, is_active: updated.isActive });
});

// ─── POST /admin/users/:id/reset-password ─────────
const ResetPasswordSchema = z.object({ new_password: z.string().min(4).max(128) });
router.post('/users/:id/reset-password', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'admin') { res.status(403).json({ detail: 'Admins only' }); return; }
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid user ID' }); return; }
  const parsed = ResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid body' }); return; }
  const hashed = await hashPassword(parsed.data.new_password);
  await prisma.user.update({ where: { id }, data: { hashedPassword: hashed } });
  res.json({ success: true });
});

// ─── GET /admin/posts ──────────────────────────────
router.get('/posts', async (req: AuthRequest, res: Response) => {
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
    author_username: p.author.username,
    created_at: p.createdAt,
    upvotes: p.upvotes,
    flagged: p.flagged,
    status: p.status,
    source_type: p.sourceType,
  })));
});

// ─── PATCH /admin/posts/:id — flag/unflag ────────
const PostPatchSchema = z.object({
  flagged: z.boolean().optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});
router.patch('/posts/:id', async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid post ID' }); return; }
  const parsed = PostPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid body' }); return; }
  const data: { flagged?: boolean; status?: string } = {};
  if (parsed.data.flagged !== undefined) data.flagged = parsed.data.flagged;
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  const updated = await prisma.post.update({ where: { id }, data });
  res.json({ id: updated.id, flagged: updated.flagged, status: updated.status });
});

// ─── GET /admin/events ─────────────────────────
router.get('/events', async (req: AuthRequest, res: Response) => {
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
    organizer_username: e.organizer.username,
    status: e.status,
    attendee_count: e._count.attendees,
    created_at: e.createdAt,
  })));
});

// ─── PATCH /admin/events/:id — approve/reject ──────
const EventPatchSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']),
});
router.patch('/events/:id', async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid event ID' }); return; }
  const parsed = EventPatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid body' }); return; }
  const updated = await prisma.event.update({
    where: { id }, data: { status: parsed.data.status },
  });
  res.json({ id: updated.id, status: updated.status });
});

// ─── GET /admin/comments ───────────────────────
router.get('/comments', async (_req: AuthRequest, res: Response) => {
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
    post_title: c.post.title,
    author_id: c.authorId,
    author_username: c.author.username,
    created_at: c.createdAt,
  })));
});

// ─── GET /admin/consultants ────────────────────
router.get('/consultants', async (_req: AuthRequest, res: Response) => {
  const list = await prisma.consultant.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(list.map(c => ({
    id: c.id, name: c.name, specialty: c.specialty,
    description: c.description, contact: c.contact,
    endorsements: c.endorsements, created_at: c.createdAt,
  })));
});

// ─── DELETE /admin/consultants/:id ─────────────
router.delete('/consultants/:id', async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid consultant ID' }); return; }
  await prisma.consultant.delete({ where: { id } }).catch(() => null);
  res.json({ success: true });
});

export default router;
