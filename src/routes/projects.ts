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

const SaveSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  data: z.string().min(1), // JSON-serialized payload
  is_public: z.boolean().optional(),
});

// POST /projects/save  upsert latest project for the user
router.post('/save', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const parsed = SaveSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ detail: 'Invalid body' }); return; }
  const userId = req.user!.id;
  const existing = await prisma.project.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } });
  let proj;
  if (existing) {
    proj = await prisma.project.update({
      where: { id: existing.id },
      data: {
        name: parsed.data.name ?? existing.name,
        data: parsed.data.data,
        isPublic: parsed.data.is_public ?? existing.isPublic,
      },
    });
  } else {
    proj = await prisma.project.create({
      data: {
        userId,
        name: parsed.data.name ?? 'Mi finca',
        data: parsed.data.data,
        isPublic: parsed.data.is_public ?? false,
      },
    });
  }
  res.json({
    id: proj.id, name: proj.name, is_public: proj.isPublic,
    public_slug: proj.publicSlug, updated_at: proj.updatedAt,
  });
}));

// GET /projects/mine  fetch the most recent saved project
router.get('/mine', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const proj = await prisma.project.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' } });
  if (!proj) { res.json(null); return; }
  res.json({
    id: proj.id, name: proj.name, data: proj.data,
    is_public: proj.isPublic, public_slug: proj.publicSlug,
    created_at: proj.createdAt, updated_at: proj.updatedAt,
  });
}));

// POST /projects/:id/share  toggle public + ensure slug
router.post('/:id/share', requireAuth, asyncH(async (req: AuthRequest, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid id' }); return; }
  const proj = await prisma.project.findUnique({ where: { id } });
  if (!proj || proj.userId !== req.user!.id) { res.status(404).json({ detail: 'Not found' }); return; }
  const next = !proj.isPublic;
  let slug = proj.publicSlug;
  if (next && !slug) {
    slug = `${proj.userId}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const updated = await prisma.project.update({
    where: { id }, data: { isPublic: next, publicSlug: slug },
  });
  res.json({ id: updated.id, is_public: updated.isPublic, public_slug: updated.publicSlug });
}));

// GET /projects/public/:slug  unauthenticated read-only
router.get('/public/:slug', asyncH(async (req, res: Response) => {
  const slug = String(req.params.slug);
  const proj = await prisma.project.findUnique({ where: { publicSlug: slug } });
  if (!proj || !proj.isPublic) { res.status(404).json({ detail: 'Not found' }); return; }
  res.json({
    id: proj.id, name: proj.name, data: proj.data,
    updated_at: proj.updatedAt,
  });
}));

export default router;
