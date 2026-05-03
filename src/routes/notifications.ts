import { Router, Response, NextFunction } from 'express';
import prisma from '../prisma';
import { requireAuth, type AuthRequest } from '../middleware/auth';

const router = Router();

function asyncH(fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: any, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// GET /notifications  list latest notifications for the user
router.get('/', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const onlyUnread = req.query.unread === '1';
  const items = await prisma.notification.findMany({
    where: onlyUnread ? { userId, read: false } : { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const unreadCount = await prisma.notification.count({ where: { userId, read: false } });
  res.json({
    unread_count: unreadCount,
    items: items.map(n => ({
      id: n.id, type: n.type, title: n.title, body: n.body,
      link: n.link, read: n.read, created_at: n.createdAt,
    })),
  });
}));

// GET /notifications/unread_count
router.get('/unread_count', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const unreadCount = await prisma.notification.count({ where: { userId: req.user!.id, read: false } });
  res.json({ unread_count: unreadCount });
}));

// POST /notifications/:id/read
router.post('/:id/read', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid id' }); return; }
  const n = await prisma.notification.findUnique({ where: { id } });
  if (!n || n.userId !== req.user!.id) { res.status(404).json({ detail: 'Not found' }); return; }
  await prisma.notification.update({ where: { id }, data: { read: true } });
  res.json({ success: true });
}));

// POST /notifications/read_all
router.post('/read_all', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  await prisma.notification.updateMany({ where: { userId: req.user!.id, read: false }, data: { read: true } });
  res.json({ success: true });
}));

export async function notify(userId: number, type: string, title: string, body?: string | null, link?: string | null): Promise<void> {
  try {
    await prisma.notification.create({
      data: { userId, type, title, body: body ?? null, link: link ?? null },
    });
  } catch (err) {
    console.warn('[notify] failed', err);
  }
}

export default router;
