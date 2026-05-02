import express from 'express';
import cors from 'cors';
import { config } from './config';
import prisma from './prisma';
import path from 'node:path';
import fs from 'node:fs';

// ─── Routes ────────────────────────────────────────────────
import authRouter from './routes/auth';
import postsRouter from './routes/posts';
import commentsRouter from './routes/comments';
import eventsRouter from './routes/events';
import consultantsRouter from './routes/consultants';
import adminRouter from './routes/admin';

const app = express();

// ─── Middleware ─────────────────────────────────────────────
app.use('/token', (req, _res, next) => {
  // Fix for cached frontends that send url-encoded bodies as JSON
  if (req.headers['content-type'] === 'application/json') {
    req.headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const corsOrigins = config.corsOrigins === '*'
  ? '*'
  : config.corsOrigins.split(',').map(s => s.trim());

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Admin Dashboard (static HTML) ─────────────────────────
app.get('/admin', (_req, res) => {
  const adminPath = path.join(__dirname, 'admin', 'admin.html');
  if (fs.existsSync(adminPath)) {
    res.sendFile(adminPath);
  } else {
    res.sendFile(path.join(__dirname, '..', 'src', 'admin', 'admin.html'));
  }
});

app.get('/users', async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, username: true, email: true, isActive: true, createdAt: true }
  });
  res.json(users);
});

// ─── API Routes ────────────────────────────────────────────
app.use('/', authRouter);
app.use('/posts', postsRouter);
app.use('/comments', commentsRouter);
app.use('/events', eventsRouter);
app.use('/consultants', consultantsRouter);
app.use('/admin/api', adminRouter);

// ─── 404 handler ───────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ detail: 'Not found' });
});

// ─── Error handler ─────────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ detail: 'Invalid JSON payload' });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({
    detail: config.isDev ? err.message : 'Internal server error',
  });
});

// ─── Start ─────────────────────────────────────────────────
async function start() {
  try {
    await prisma.$connect();
    console.log('📦 Database connected');
  } catch (e) {
    console.error('❌ Database connection failed:', e);
    process.exit(1);
  }

  // Auto-seed admin user on first startup, ensure role = admin
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@kuxtal.com';
  const adminExists = await prisma.user.findUnique({ where: { username: adminUsername } }).catch(() => null);
  if (!adminExists) {
    const { hashPassword } = await import('./middleware/auth');
    await prisma.user.create({
      data: {
        username: adminUsername,
        email: adminEmail,
        hashedPassword: await hashPassword(adminPassword),
        isActive: true,
        role: 'admin',
      },
    });
    console.log(`🌱 Admin user created (${adminUsername})`);
  } else if (adminExists.role !== 'admin') {
    await prisma.user.update({ where: { id: adminExists.id }, data: { role: 'admin' } });
    console.log('🌱 Existing admin user promoted to role=admin');
  }

  app.listen(config.port, () => {
    console.log(`🌿 Kuxtal API running at http://localhost:${config.port}`);
    console.log(`   Environment: ${config.nodeEnv}`);
    console.log(`   Health:      http://localhost:${config.port}/health`);
    console.log(`   Admin UI:    http://localhost:${config.port}/admin`);
  });
}

start();

export default app;
