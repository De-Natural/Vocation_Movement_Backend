/**
 * Create (or promote) the Super-Admin account — idempotent, safe to re-run.
 *
 *   npm run db:superadmin
 *
 * Reads SEED_SUPERADMIN_EMAIL / SEED_SUPERADMIN_PASSWORD / SEED_SUPERADMIN_NAME
 * from the environment. If the account exists it is promoted to SUPERADMIN and
 * re-activated; its password is only set when the account is first created.
 * Unlike `npm run db:seed`, this touches nothing else in the database.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Load ../.env into process.env (without overriding real env vars). */
function loadEnvFile() {
  const file = join(__dirname, '..', '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnvFile();

async function main() {
  const email = process.env.SEED_SUPERADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_SUPERADMIN_PASSWORD;
  const name = process.env.SEED_SUPERADMIN_NAME?.trim() || 'Super Administrator';
  if (!email || !password) {
    throw new Error('Set SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD in .env first.');
  }
  if (password.length < 12) {
    throw new Error('SEED_SUPERADMIN_PASSWORD must be at least 12 characters.');
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.role !== 'ADMIN' && existing.role !== 'SUPERADMIN') {
      throw new Error(`${email} belongs to a ${existing.role} account — use a different email.`);
    }
    await prisma.user.upsert({
      where: { email },
      update: { role: 'SUPERADMIN', isSuspended: false, name: existing?.name ?? name },
      create: {
        email,
        passwordHash: await bcrypt.hash(password, 12),
        role: 'SUPERADMIN',
        name,
        isVerified: true,
        isApproved: true,
      },
    });
    console.log(`✔ Super-Admin ${existing ? 'updated' : 'created'}: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`✖ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
