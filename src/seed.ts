import prisma from './prisma';
import { hashPassword } from './middleware/auth';

async function main() {
  console.log('🌱 Seeding database...');

  // ─── Admin user ──────────────────────────────────────────
  const adminExists = await prisma.user.findUnique({ where: { username: 'admin' } });
  if (!adminExists) {
    await prisma.user.create({
      data: {
        username: 'admin',
        email: 'admin@kuxtal.com',
        hashedPassword: await hashPassword('admin'),
        isActive: true,
      },
    });
    console.log('  ✅ Admin user created (admin / admin)');
  } else {
    console.log('  ⏭  Admin user already exists');
  }

  // ─── Sample consultant ───────────────────────────────────
  const consultantCount = await prisma.consultant.count();
  if (consultantCount === 0) {
    await prisma.consultant.create({
      data: {
        name: 'María Gutiérrez',
        specialty: 'Permacultura tropical',
        description: 'Experta en diseño de fincas integrales en el trópico andino.',
        contact: 'maria@ejemplo.com',
        endorsements: 5,
      },
    });
    console.log('  ✅ Sample consultant created');
  }

  console.log('🌿 Seed complete.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
