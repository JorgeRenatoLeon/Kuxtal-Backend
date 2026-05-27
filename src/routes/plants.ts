import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../prisma';
import { requireRole, type AuthRequest } from '../middleware/auth';

const router = Router();

function asyncH(fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: any, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ─── GET /plants/version ── public; clients compare to bundled version ──
router.get('/version', asyncH(async (_req: Request, res: Response) => {
  const meta = await prisma.plantCatalogMeta.findFirst({ orderBy: { version: 'desc' } });
  const count = await prisma.plant.count();
  res.json({
    version: meta?.version ?? 0,
    count,
    publishedAt: meta?.publishedAt ?? null,
  });
}));

// ─── GET /plants ── public; full catalog (or [] if caller is current) ──
router.get('/', asyncH(async (req: Request, res: Response) => {
  const since = Number.parseInt(req.query.since as string, 10);
  const meta = await prisma.plantCatalogMeta.findFirst({ orderBy: { version: 'desc' } });
  const current = meta?.version ?? 0;
  if (Number.isFinite(since) && since === current) {
    res.json({ version: current, plants: [] });
    return;
  }
  const plants = await prisma.plant.findMany();
  res.json({ version: current, plants: plants.map((p) => p.data) });
}));

const SeedSchema = z.object({
  schemaVersion: z.number().int().positive(),
  plants: z.array(z.object({ id: z.string().min(1), sci: z.string().min(1) }).passthrough()).min(1),
});

// ─── POST /plants/admin/seed ── admin only; replace catalog, bump version ──
router.post('/admin/seed', requireRole('admin'), asyncH(async (req: AuthRequest, res: Response) => {
  const parsed = SeedSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ detail: 'Invalid request body', errors: parsed.error.flatten() });
    return;
  }
  const { plants, schemaVersion } = parsed.data;

  await prisma.$transaction([
    ...plants.map((p) =>
      prisma.plant.upsert({
        where: { id: p.id },
        create: { id: p.id, scientificName: p.sci, data: p as Prisma.InputJsonValue, schemaVersion },
        update: { scientificName: p.sci, data: p as Prisma.InputJsonValue, schemaVersion },
      })
    ),
    prisma.plantCatalogMeta.create({ data: { version: schemaVersion } }),
  ]);

  res.status(201).json({ version: schemaVersion, count: plants.length });
}));

export default router;
