import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAuth, type AuthRequest } from '../middleware/auth';

const router = Router();

function asyncH(fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: any, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

let webpush: typeof import('web-push') | null = null;

async function getWebPush() {
  if (webpush) return webpush;
  try {
    webpush = await import('web-push');
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@kuxtal.com';
    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
    } else {
      console.warn('[push] VAPID keys not set — push notifications disabled');
      webpush = null;
    }
  } catch {
    console.warn('[push] web-push not installed — push notifications disabled');
    webpush = null;
  }
  return webpush;
}

// GET /push/vapid-public-key — client needs this to subscribe
router.get('/vapid-public-key', (_req, res: Response) => {
  const key = process.env.VAPID_PUBLIC_KEY || null;
  res.json({ key });
});

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});

// POST /push/subscribe — store a push subscription for the auth user
router.post('/subscribe', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const parsed = SubscribeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid subscription' }); return; }
  const userId = req.user!.id;
  const { endpoint, keys } = parsed.data;

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    update: { userId, p256dh: keys.p256dh, auth: keys.auth },
  });
  res.json({ success: true });
}));

// DELETE /push/subscribe — remove subscription (user opt-out)
router.delete('/subscribe', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint) { res.status(400).json({ detail: 'endpoint required' }); return; }
  await prisma.pushSubscription.deleteMany({
    where: { userId: req.user!.id, endpoint },
  });
  res.json({ success: true });
}));

export async function sendPushToUser(userId: number, title: string, body: string): Promise<void> {
  const wp = await getWebPush();
  if (!wp) return;

  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  for (const sub of subs) {
    try {
      await wp.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title, body }),
      );
    } catch (err: any) {
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => null);
      } else {
        console.warn('[push] sendNotification failed', err?.statusCode);
      }
    }
  }
}

export default router;
