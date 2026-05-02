import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAuth, type AuthRequest } from '../middleware/auth';

const router = Router();

const ConsultantCreateSchema = z.object({
  name: z.string().min(1).max(100),
  specialty: z.string().min(1).max(100),
  description: z.string().min(1),
  contact: z.string().min(1).max(200),
});

// ─── GET /api/consultants ──────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  const skip = Number.parseInt(req.query.skip as string, 10) || 0;
  const limit = Math.min(Number.parseInt(req.query.limit as string, 10) || 100, 200);

  const consultants = await prisma.consultant.findMany({
    skip,
    take: limit,
    orderBy: { endorsements: 'desc' },
  });

  res.json(consultants.map(c => ({
    id: c.id,
    name: c.name,
    specialty: c.specialty,
    description: c.description,
    contact: c.contact,
    endorsements: c.endorsements,
    created_at: c.createdAt,
  })));
});

// ─── POST /api/consultants ─────────────────────────────────
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const parsed = ConsultantCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Invalid request body', errors: parsed.error.flatten() });
    return;
  }

  const consultant = await prisma.consultant.create({
    data: parsed.data,
  });

  res.status(201).json({
    id: consultant.id,
    name: consultant.name,
    specialty: consultant.specialty,
    description: consultant.description,
    contact: consultant.contact,
    endorsements: consultant.endorsements,
    created_at: consultant.createdAt,
  });
});

// ─── POST /api/consultants/:id/endorse ─────────────────────
router.post('/:id/endorse', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid ID' }); return; }

  const updated = await prisma.consultant.update({
    where: { id },
    data: { endorsements: { increment: 1 } },
  }).catch(() => null);

  if (!updated) { res.status(404).json({ detail: 'Consultant not found' }); return; }

  res.json({ success: true, endorsements: updated.endorsements });
});

export default router;
