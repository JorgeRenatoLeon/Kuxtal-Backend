import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../prisma';
import { requireAuth, type AuthRequest } from '../middleware/auth';

const router = Router();

function asyncH(fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: any, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function serialize(r: {
  id: number; entityA: string; entityB: string; relationshipType: string;
  message: string; createdAt: Date; author?: { username: string } | null;
}) {
  return {
    id: r.id,
    entity_a: r.entityA,
    entity_b: r.entityB,
    relationship_type: r.relationshipType,
    message: r.message,
    author: r.author?.username ?? null,
    created_at: r.createdAt,
  };
}

// ─── GET /shared-rules ── public, paginated ──
router.get('/', asyncH(async (req: Request, res: Response) => {
  const skip = Number.parseInt(req.query.skip as string, 10) || 0;
  const limit = Math.min(Number.parseInt(req.query.limit as string, 10) || 100, 200);
  const rules = await prisma.sharedRule.findMany({
    skip, take: limit,
    orderBy: { createdAt: 'desc' },
    include: { author: { select: { username: true } } },
  });
  res.json(rules.map(serialize));
}));

const RuleCreateSchema = z.object({
  entity_a: z.string().min(1).max(120),
  entity_b: z.string().min(1).max(120),
  relationship_type: z.enum(['companion', 'beneficial', 'incompatible', 'harmful', 'neutral']),
  message: z.string().min(1).max(500),
});

// ─── POST /shared-rules ── auth required ──
router.post('/', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const parsed = RuleCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Invalid request body', errors: parsed.error.flatten() });
    return;
  }
  const d = parsed.data;
  const rule = await prisma.sharedRule.create({
    data: {
      entityA: d.entity_a,
      entityB: d.entity_b,
      relationshipType: d.relationship_type,
      message: d.message,
      authorId: req.user!.id,
    },
    include: { author: { select: { username: true } } },
  });
  res.status(201).json(serialize(rule));
}));

// ─── POST /shared-rules/:id/import ── returns payload for local insert ──
router.post('/:id/import', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid ID' }); return; }
  const rule = await prisma.sharedRule.findUnique({
    where: { id },
    include: { author: { select: { username: true } } },
  });
  if (!rule) { res.status(404).json({ detail: 'Shared rule not found' }); return; }
  res.json(serialize(rule));
}));

export default router;
