import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { notify } from './notifications';
import { sendPushToUser } from './push';

const router = Router();

const CommentCreateSchema = z.object({
  content: z.string().min(1),
  post_id: z.number().int().positive(),
});

function asyncH(fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: any, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ─── POST /comments ────────────────────────────────────
router.post('/', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const parsed = CommentCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Invalid request body', errors: parsed.error.flatten() });
    return;
  }

  const post = await prisma.post.findUnique({ where: { id: parsed.data.post_id } });
  if (!post) { res.status(404).json({ detail: 'Post not found' }); return; }

  const comment = await prisma.comment.create({
    data: {
      content: parsed.data.content,
      postId: parsed.data.post_id,
      authorId: req.user!.id,
    },
    include: { author: { select: { username: true } } },
  });

  res.status(201).json({
    id: comment.id,
    content: comment.content,
    post_id: comment.postId,
    author_id: comment.authorId,
    author_username: comment.author?.username ?? `user-${comment.authorId}`,
    created_at: comment.createdAt,
  });

  if (post.authorId !== req.user!.id) {
    const commenter = comment.author?.username ?? `user-${comment.authorId}`;
    const title = 'Nuevo comentario en tu publicación';
    const body = `${commenter} comentó en "${post.title}"`;
    notify(post.authorId, 'comment', title, body, `/posts/${post.id}`).catch(() => null);
    sendPushToUser(post.authorId, title, body).catch(() => null);
  }
}));

// ─── DELETE /comments/:id — author or mod ────────────
router.delete('/:id', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid comment ID' }); return; }
  const comment = await prisma.comment.findUnique({ where: { id } });
  if (!comment) { res.status(404).json({ detail: 'Comment not found' }); return; }
  const isOwner = comment.authorId === req.user!.id;
  const canModerate = req.user!.role === 'admin' || req.user!.role === 'mod';
  if (!isOwner && !canModerate) {
    res.status(403).json({ detail: 'Not allowed' });
    return;
  }
  await prisma.comment.delete({ where: { id } });
  res.json({ success: true });
}));

export default router;
