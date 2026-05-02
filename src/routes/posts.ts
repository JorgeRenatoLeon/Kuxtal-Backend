import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAuth, type AuthRequest } from '../middleware/auth';

const router = Router();

const PostCreateSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  category: z.string().min(1).max(50),
  source_type: z.enum(['rule', 'saber']).optional().nullable(),
  source_payload: z.string().max(20000).optional().nullable(),
});

function serialise(p: any, currentUserId?: number) {
  return {
    id: p.id,
    title: p.title,
    content: p.content,
    category: p.category,
    author_id: p.authorId,
    author_username: p.author?.username,
    created_at: p.createdAt,
    upvotes: p.upvotes,
    source_type: p.sourceType,
    source_payload: p.sourcePayload,
    status: p.status,
    flagged: p.flagged,
    has_upvoted: currentUserId
      ? Array.isArray(p.postUpvotes) && p.postUpvotes.some((u: any) => u.userId === currentUserId)
      : false,
  };
}

// ─── GET /posts ─────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  const skip = Number.parseInt(req.query.skip as string, 10) || 0;
  const limit = Math.min(Number.parseInt(req.query.limit as string, 10) || 100, 200);
  const sourceType = (req.query.source_type as string) || undefined;

  // Detect optional logged-in user without forcing auth
  let currentUserId: number | undefined;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const { verifyToken } = await import('../middleware/auth');
      const decoded = verifyToken(auth.slice(7));
      currentUserId = decoded.userId;
    } catch { /* anonymous */ }
  }

  const where: any = { status: 'approved' };
  if (sourceType) where.sourceType = sourceType;

  const posts = await prisma.post.findMany({
    where,
    skip,
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      author: { select: { id: true, username: true } },
      postUpvotes: currentUserId ? { where: { userId: currentUserId }, select: { userId: true } } : false,
    },
  });

  res.json(posts.map(p => serialise(p, currentUserId)));
});

// ─── GET /posts/:id ─────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid post ID' }); return; }
  const post = await prisma.post.findUnique({
    where: { id },
    include: { author: { select: { id: true, username: true } } },
  });
  if (!post) { res.status(404).json({ detail: 'Post not found' }); return; }
  res.json(serialise(post));
});

// ─── POST /posts ────────────────────────────────────────
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = PostCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Invalid request body', errors: parsed.error.flatten() });
    return;
  }

  const { title, content, category, source_type, source_payload } = parsed.data;

  const post = await prisma.post.create({
    data: {
      title,
      content,
      category,
      authorId: req.user!.id,
      sourceType: source_type ?? null,
      sourcePayload: source_payload ?? null,
      status: 'approved', // posts are auto-approved; events require approval
    },
    include: { author: { select: { id: true, username: true } } },
  });

  res.status(201).json(serialise(post, req.user!.id));
});

// ─── POST /posts/:id/upvote — toggle ────────────────────
router.post('/:id/upvote', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid post ID' }); return; }

  const post = await prisma.post.findUnique({ where: { id } });
  if (!post) { res.status(404).json({ detail: 'Post not found' }); return; }

  const userId = req.user!.id;
  const existing = await prisma.postUpvote.findUnique({
    where: { postId_userId: { postId: id, userId } },
  });

  if (existing) {
    await prisma.postUpvote.delete({ where: { id: existing.id } });
    const updated = await prisma.post.update({
      where: { id }, data: { upvotes: { decrement: 1 } },
    });
    res.json({ success: true, upvotes: updated.upvotes, has_upvoted: false });
    return;
  }

  await prisma.postUpvote.create({ data: { postId: id, userId } });
  const updated = await prisma.post.update({
    where: { id }, data: { upvotes: { increment: 1 } },
  });
  res.json({ success: true, upvotes: updated.upvotes, has_upvoted: true });
});

// ─── DELETE /posts/:id — author or mod ─────────────────
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid post ID' }); return; }
  const post = await prisma.post.findUnique({ where: { id } });
  if (!post) { res.status(404).json({ detail: 'Post not found' }); return; }
  const isOwner = post.authorId === req.user!.id;
  const canModerate = req.user!.role === 'admin' || req.user!.role === 'mod';
  if (!isOwner && !canModerate) {
    res.status(403).json({ detail: 'Not allowed' });
    return;
  }
  await prisma.post.delete({ where: { id } });
  res.json({ success: true });
});

// ─── GET /posts/:id/comments ────────────────────────────
router.get('/:id/comments', async (req: Request, res: Response) => {
  const postId = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(postId)) { res.status(400).json({ detail: 'Invalid post ID' }); return; }

  const comments = await prisma.comment.findMany({
    where: { postId },
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { id: true, username: true } } },
  });

  res.json(comments.map(c => ({
    id: c.id,
    content: c.content,
    post_id: c.postId,
    author_id: c.authorId,
    author_username: c.author.username,
    created_at: c.createdAt,
  })));
});

export default router;
