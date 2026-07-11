import { PrismaClient } from '../src/generated/client/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
const pool = new pg.Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false,
  },
});
const adapter = new PrismaPg(pool as any);

const prisma = new PrismaClient({ adapter });

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
