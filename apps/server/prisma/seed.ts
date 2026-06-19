import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.info('🌱 Seeding database...');

  // Create initial health check record
  await prisma.healthCheck.upsert({
    where: { id: 'initial-health-check' },
    update: {},
    create: {
      id: 'initial-health-check',
      status: 'ok',
    },
  });

  console.info('✅ Database seeded successfully');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('❌ Seed failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
