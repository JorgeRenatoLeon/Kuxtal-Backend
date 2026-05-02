import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAuth, type AuthRequest, verifyToken } from '../middleware/auth';

const router = Router();

const EventCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  location: z.string().min(1).max(200),
  event_date: z.string().datetime(),
});

function serialise(e: any, currentUserId?: number, attendeeCount = 0, attending = false) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    event_date: e.eventDate,
    organizer_id: e.organizerId,
    organizer_username: e.organizer?.username,
    created_at: e.createdAt,
    status: e.status,
    attendee_count: attendeeCount,
    attending,
    can_manage: currentUserId === e.organizerId,
  };
}

// ─── GET /events ───────────────────────────────────────
// Public list: only approved events. ?mine=1 to include organizer's pending too.
// ?status=pending|approved|rejected for moderators.
router.get('/', async (req: Request, res: Response) => {
  const skip = Number.parseInt(req.query.skip as string, 10) || 0;
  const limit = Math.min(Number.parseInt(req.query.limit as string, 10) || 100, 200);
  const statusFilter = (req.query.status as string) || undefined;
  const mine = req.query.mine === '1' || req.query.mine === 'true';

  let currentUserId: number | undefined;
  let role: string | undefined;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const decoded = verifyToken(auth.slice(7));
      const u = await prisma.user.findUnique({ where: { id: decoded.userId } });
      if (u) { currentUserId = u.id; role = u.role; }
    } catch { /* anon */ }
  }

  const where: any = {};
  if (statusFilter && (role === 'admin' || role === 'mod')) {
    where.status = statusFilter;
  } else if (mine && currentUserId) {
    where.OR = [{ status: 'approved' }, { organizerId: currentUserId }];
  } else {
    where.status = 'approved';
  }

  const events = await prisma.event.findMany({
    where,
    skip,
    take: limit,
    orderBy: { eventDate: 'asc' },
    include: {
      organizer: { select: { id: true, username: true } },
      attendees: { select: { userId: true } },
    },
  });

  res.json(events.map(e => {
    const attending = currentUserId ? e.attendees.some(a => a.userId === currentUserId) : false;
    return serialise(e, currentUserId, e.attendees.length, attending);
  }));
});

// ─── POST /events — creates pending; admins auto-approve ──
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = EventCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Invalid request body', errors: parsed.error.flatten() });
    return;
  }

  const initialStatus = req.user!.role === 'admin' || req.user!.role === 'mod' ? 'approved' : 'pending';

  const event = await prisma.event.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      location: parsed.data.location,
      eventDate: new Date(parsed.data.event_date),
      organizerId: req.user!.id,
      status: initialStatus,
    },
    include: { organizer: { select: { id: true, username: true } } },
  });

  res.status(201).json(serialise(event, req.user!.id, 0, false));
});

// ─── DELETE /events/:id — organizer or mod ─────────────
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid event ID' }); return; }
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) { res.status(404).json({ detail: 'Event not found' }); return; }
  const isOwner = event.organizerId === req.user!.id;
  const canModerate = req.user!.role === 'admin' || req.user!.role === 'mod';
  if (!isOwner && !canModerate) {
    res.status(403).json({ detail: 'Not allowed' });
    return;
  }
  await prisma.event.delete({ where: { id } });
  res.json({ success: true });
});

// ─── POST /events/:id/rsvp — toggle ────────────────────
router.post('/:id/rsvp', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid event ID' }); return; }
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) { res.status(404).json({ detail: 'Event not found' }); return; }
  if (event.status !== 'approved') {
    res.status(400).json({ detail: 'Event is not yet approved' });
    return;
  }
  const userId = req.user!.id;
  const existing = await prisma.eventAttendee.findUnique({
    where: { eventId_userId: { eventId: id, userId } },
  });
  if (existing) {
    await prisma.eventAttendee.delete({ where: { id: existing.id } });
    const count = await prisma.eventAttendee.count({ where: { eventId: id } });
    res.json({ success: true, attending: false, attendee_count: count });
    return;
  }
  await prisma.eventAttendee.create({ data: { eventId: id, userId } });
  const count = await prisma.eventAttendee.count({ where: { eventId: id } });
  res.json({ success: true, attending: true, attendee_count: count });
});

export default router;
