/**
 * Idempotent seed: the three roles, the nine courses originally loaded into edupulse_lms,
 * and the first admin. Run with `npm run db:seed`. Never overwrites existing rows.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { mariaDbConfigFromUrl } from '../src/prisma/mariadb-config.js';

const roles = [
  { id: 1, code: 'ADMIN', label: 'Administrator' },
  { id: 2, code: 'FACULTY', label: 'Faculty' },
  { id: 3, code: 'STUDENT', label: 'Student' },
];

const courses = [
  { code: 'AISSEE-6', slug: 'aissee-class-6', title: 'AISSEE Class 6' },
  { code: 'AISSEE-9', slug: 'aissee-class-9', title: 'AISSEE Class 9' },
  { code: 'AMU', slug: 'amu-entrance', title: 'AMU Entrance' },
  { code: 'CUET', slug: 'cuet', title: 'CUET' },
  { code: 'NDA-CDS', slug: 'nda-cds', title: 'NDA / CDS' },
  { code: 'JEE', slug: 'jee', title: 'JEE' },
  { code: 'NEET', slug: 'neet', title: 'NEET' },
  { code: 'IMU-CET', slug: 'imu-cet', title: 'IMU-CET' },
  {
    code: 'SCHOOL-TUITION',
    slug: 'school-tuition',
    title: 'School Tuition Programmes',
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb(mariaDbConfigFromUrl(url)),
  });

  try {
    for (const role of roles) {
      await prisma.roles.upsert({
        where: { code: role.code },
        update: {},
        create: role,
      });
    }
    for (const course of courses) {
      await prisma.courses.upsert({
        where: { code: course.code },
        update: {},
        create: course,
      });
    }
    console.log(
      `Roles: ${roles.length}, courses: ${courses.length} ensured (existing rows left unchanged)`,
    );

    const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (!email || !password) {
      console.log(
        'SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set; skipping admin',
      );
      return;
    }
    if (await prisma.users.findUnique({ where: { email } })) {
      console.log(`Admin ${email} already exists; left unchanged`);
      return;
    }
    await prisma.users.create({
      data: {
        public_id: randomUUID(),
        full_name: 'EduPulse Admin',
        email,
        status: 'ACTIVE',
        password_hash: await bcrypt.hash(
          password,
          Number(process.env.BCRYPT_ROUNDS ?? 10),
        ),
        user_roles: { create: [{ roles: { connect: { code: 'ADMIN' } } }] },
      },
    });
    console.log(`Admin ${email} created. Log in and change the password.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
