/**
 * Database seed — mirrors the frontend's `src/lib/mock-data.ts` so the
 * UI renders real data immediately, and provisions the bootstrap ADMIN
 * (admins are NEVER self-registered — access rule from ARCHITECTURE.md).
 *
 * Run: npm run db:seed   (or automatically via `prisma migrate reset`)
 */
import { PrismaClient, Stage, BillCategory, Gateway } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Frozen "now" matching the frontend mock for deterministic overdue logic.
const NOW = new Date('2026-08-18T00:00:00.000Z');

const CONGREGATIONS = [
  'Consoler of the Agonizing Jesus Christ',
  'Two heart of Love',
  'Sisters of the Sacred Heart',
  'Little Lilies of Christ Sisters',
  'Order of Preachers (Dominicans)',
  'Missionary Society of St. Paul (MSP)',
  'Spiritans / Holy Ghost Fathers (CSSp)',
  'Franciscan Friars Minor',
  'Daughters of Divine Love (DDL)',
  'Eucharistic Heart of Jesus (EHJ)',
  'Immaculate Heart of Mary Sisters',
];

const SCHOOLS = [
  'St. Joseph Major Seminary',
  'Bigard Memorial Seminary',
  'SS. Peter & Paul Seminary',
  'Sacred Heart Novitiate',
  'St. Thomas Aquinas Major Seminary',
  'Veritas University',
  'St. Augustine Formation House',
];

const NAMES = [
  'Brother Emeka Okonkwo',
  'Sister Maria Adeyemi',
  'Brother Thomas Mensah',
  'Sister Grace Nwosu',
  'Brother Peter Achebe',
  'Sister Cecilia Okafor',
  'Brother John Baptiste',
  'Sister Anne Chukwu',
  'Brother Michael Eze',
  'Sister Rose Abara',
];

const STAGES: Stage[] = ['SEMINARIAN', 'NOVICE', 'POSTULANT'];

const BIOS = [
  'I entered formation three years ago after finishing my studies in the sciences. My heart was drawn to serve the poor and to preach the mercy of God. Each day of study and prayer deepens my conviction. With your support I can continue my journey toward the priesthood and one day serve a rural parish that has waited many years for a resident priest.',
  'From a young age I felt called to religious life through the example of the sisters who taught in my village. I am now in my novitiate year, learning to live in community, in prayer, and in service to children who have no one. Your generosity helps me stay in formation and become the sister God is calling me to be.',
  'I am the first in my family to pursue religious formation. The road has not been easy — my parents are farmers and cannot cover the seminary fees. Yet I trust in Providence and in the kindness of benefactors like you. I dream of becoming a missionary priest bringing the sacraments to remote communities.',
];

const P = (id: string, sig: number) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=800&q=70&sig=${sig}`;
const PHOTOS = [
  P('photo-1507003211169-0a1dd7228f2d', 1),
  P('photo-1500648767791-00dcc994a43e', 2),
  P('photo-1531384441138-2736e62e0919', 3),
  P('photo-1519085360753-af0119f7cbe7', 4),
  P('photo-1506794778202-cad84cf45f1d', 5),
  P('photo-1544005313-94ddf0286df2', 6),
  P('photo-1502823403499-6ccfcf4fb453', 7),
  P('photo-1521119989659-a83eee488004', 8),
  P('photo-1500649297466-74794c70acfc', 9),
  P('photo-1487412720507-e7ab37603c6f', 10),
];

const cents = (units: number) => Math.round(units * 100);
const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

interface BillDef {
  name: string;
  category: BillCategory;
  total: number;
  raised: number;
  due: string;
  desc: string;
}

function billDefs(seed: number): BillDef[] {
  return [
    {
      name: 'School Fees — Session 2026',
      category: 'SCHOOL_FEES',
      total: 1200,
      raised: [1200, 640, 300, 980][seed % 4],
      due: '2026-10-15',
      desc: 'Tuition and boarding for the current formation session.',
    },
    {
      name: 'Medical & Health Cover',
      category: 'MEDICAL',
      total: 400,
      raised: [120, 400, 45, 210][seed % 4],
      due: '2026-09-01',
      desc: 'Annual health insurance and clinic visits.',
    },
    {
      name: 'Books & Study Materials',
      category: 'BOOKS',
      total: 260,
      raised: [260, 130, 60, 200][seed % 4],
      due: '2026-09-20',
      desc: 'Theology and philosophy texts for the semester.',
    },
    {
      name: 'Cassock & Clothing Allowance',
      category: 'CLOTHING',
      total: 180,
      raised: [90, 180, 30, 150][seed % 4],
      due: '2026-08-30',
      desc: 'Liturgical vestments and everyday clothing.',
    },
    {
      name: 'Feeding — Quarterly',
      category: 'FEEDING',
      total: 300,
      raised: [150, 300, 75, 240][seed % 4],
      due: '2026-08-10',
      desc: 'Meals within the formation house.',
    },
  ];
}

async function main() {
  console.log('🌱 Seeding Vocation Movement database…');

  // ─── Platform settings singleton ───
  await prisma.platformSettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });

  // ─── Bootstrap admin (never self-registered) ───
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@vocationmovement.org';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!Admin123';
  const adminHash = await bcrypt.hash(adminPassword, 12);
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: adminHash,
      role: 'ADMIN',
      isVerified: true,
      isApproved: true,
    },
  });
  console.log(`  ✔ Admin account: ${adminEmail}`);

  // ─── Sponsor demo account ───
  const sponsorHash = await bcrypt.hash('Sponsor!Demo123', 12);
  const sponsorUser = await prisma.user.upsert({
    where: { email: 'onyeka.a@example.com' },
    update: {},
    create: {
      email: 'onyeka.a@example.com',
      passwordHash: sponsorHash,
      role: 'SPONSOR',
      isVerified: true,
      isApproved: true,
      sponsorProfile: {
        create: {
          fullName: 'Mrs. Onyeka Adeleke',
          country: 'Nigeria',
          currency: 'USD',
          anonymousByDefault: false,
        },
      },
    },
    include: { sponsorProfile: true },
  });
  const sponsorProfile = sponsorUser.sponsorProfile!;
  console.log('  ✔ Sponsor demo: onyeka.a@example.com / Sponsor!Demo123');

  // ─── Students + bills + contributions ───
  const studentPassword = await bcrypt.hash('Student!Demo123', 12);
  const createdStudents: { id: string; bills: { id: string; name: string; raised: number }[] }[] =
    [];

  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[i];
    const email = `${slugify(name)}@example.com`;
    const isPending = i === 9;

    const defs = billDefs(i);
    const totalNeeded = defs
      .filter((d) => d.raised < d.total || true)
      .reduce((sum, d) => sum + d.total, 0);
    const totalRaised = defs.reduce((sum, d) => sum + d.raised, 0);

    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: {
        email,
        passwordHash: studentPassword,
        role: 'RELIGIOUS',
        isVerified: true,
        isApproved: !isPending,
        religiousProfile: {
          create: {
            slug: slugify(name),
            fullName: name,
            photoUrl: PHOTOS[i],
            biography: BIOS[i % BIOS.length],
            formationStage: STAGES[i % 3],
            congregationName: CONGREGATIONS[i % CONGREGATIONS.length],
            schoolName: SCHOOLS[i % SCHOOLS.length],
            country: ['Nigeria', 'Ghana', 'Kenya', 'Uganda'][i % 4],
            location: ['Enugu, Nigeria', 'Accra, Ghana', 'Nairobi, Kenya', 'Kampala, Uganda'][i % 4],
            phoneNumber: '+234 800 000 0000',
            dateOfBirth: new Date('1999-04-12'),
            gender: i % 2 === 0 ? 'Male' : 'Female',
            yearOfFormation: (i % 4) + 1,
            expectedYear: 2027 + (i % 3),
            verificationState: isPending ? 'PENDING' : 'VERIFIED',
            totalNeededCents: cents(totalNeeded),
            totalRaisedCents: cents(totalRaised),
            sponsorCount: 3 + ((i * 7) % 24),
            profileCompletion: [100, 85, 100, 70, 90, 100, 60, 95, 100, 45][i],
          },
        },
      },
      include: { religiousProfile: true },
    });
    const profile = user.religiousProfile!;

    const billRecords: { id: string; name: string; raised: number }[] = [];
    for (const d of defs) {
      const percent = Math.round((d.raised / d.total) * 100);
      const overdue = new Date(d.due).getTime() < NOW.getTime();
      const status =
        percent >= 100 ? 'FUNDED' : overdue ? 'OVERDUE' : 'ACTIVE';
      const bill = await prisma.bill.create({
        data: {
          religiousId: profile.id,
          name: d.name,
          category: d.category,
          totalCents: cents(d.total),
          raisedCents: cents(d.raised),
          dueDate: new Date(d.due),
          status,
          description: d.desc,
        },
      });
      billRecords.push({ id: bill.id, name: d.name, raised: d.raised });

      // A couple of illustrative confirmed contributions per funded bill.
      if (d.raised > 0) {
        const first = Math.round(d.raised * 0.6);
        const second = d.raised - first;
        for (const [idx, amt, anon] of [
          [0, first, i % 2 === 0],
          [1, second, i % 2 === 1],
        ] as [number, number, boolean][]) {
          if (amt <= 0) continue;
          const payment = await prisma.payment.create({
            data: {
              sponsorId: sponsorProfile.id,
              religiousId: profile.id,
              amountCents: cents(amt),
              // Seeded gifts predate any platform fee: net == gross so the
              // seeded `raised` history is preserved when recomputeBill (which
              // sums netAmountCents) next runs.
              feeCents: 0,
              netAmountCents: cents(amt),
              currency: 'USD',
              isAnonymous: anon,
              status: 'CONFIRMED',
              gateway: Gateway.STRIPE,
              gatewayTxId: `SEED-TXN-${i}-${d.category}-${idx}`,
              confirmedAt: new Date('2026-08-03'),
              splits: {
                create: [
                  {
                    billId: bill.id,
                    amountCents: cents(amt),
                    netAmountCents: cents(amt),
                  },
                ],
              },
            },
          });
          void payment;
        }
      }
    }
    createdStudents.push({ id: profile.id, bills: billRecords });
  }
  console.log(`  ✔ ${NAMES.length} students with bills + contributions`);

  // ─── Recurring sponsorships ───
  const recurringDefs = [
    { studentIdx: 0, amount: 80, billName: 'School Fees — Session 2026', active: true, next: '2026-09-03' },
    { studentIdx: 2, amount: 60, billName: 'Feeding — Quarterly', active: true, next: '2026-09-05' },
    { studentIdx: 4, amount: 40, billName: 'Books & Study Materials', active: false, next: '2026-09-10' },
  ];
  for (const r of recurringDefs) {
    const student = createdStudents[r.studentIdx];
    const bill = student.bills.find((b) => b.name === r.billName) ?? student.bills[0];
    await prisma.sponsorship.create({
      data: {
        sponsorId: sponsorProfile.id,
        religiousId: student.id,
        billId: bill.id,
        amountCents: cents(r.amount),
        currency: 'USD',
        status: r.active ? 'ACTIVE' : 'PAUSED',
        gateway: Gateway.STRIPE,
        nextChargeDate: new Date(r.next),
      },
    });
  }
  console.log(`  ✔ ${recurringDefs.length} recurring sponsorships`);

  // ─── Thank-you messages ───
  const firstStudent = createdStudents[0];
  await prisma.message.create({
    data: {
      studentId: firstStudent.id,
      sponsorId: sponsorProfile.id,
      anonymousDonor: false,
      subject: 'Thank you for funding my school fees',
      body: 'Dear Mrs. Onyeka, words cannot express my gratitude. Your gift toward my school fees means I can continue my studies without interruption this session. I remember you in my daily prayers. May God bless you abundantly.',
      read: false,
      createdAt: new Date('2026-08-04'),
      replies: {
        create: [
          {
            from: 'SPONSOR',
            body: 'You are most welcome, Brother Emeka. It is my joy to support your vocation. Keep up your studies!',
            createdAt: new Date('2026-08-05'),
          },
        ],
      },
    },
  });
  await prisma.message.create({
    data: {
      studentId: firstStudent.id,
      sponsorId: sponsorProfile.id,
      anonymousDonor: true,
      subject: 'Gratitude for the medical cover',
      body: 'To my anonymous benefactor — thank you for covering my medical needs. I was able to see the doctor and I am now well. Your kindness, though hidden, is seen by God.',
      read: true,
      createdAt: new Date('2026-07-21'),
    },
  });
  console.log('  ✔ Thank-you messages');

  // ─── Sample contact inquiry ───
  await prisma.contactInquiry.create({
    data: {
      name: 'Rev. Fr. Anthony',
      email: 'anthony@parish.org',
      phone: '+234 801 234 5678',
      message: 'I would like to learn how our parish can partner with the Vocation Movement.',
      status: 'UNREAD',
    },
  });
  console.log('  ✔ Sample contact inquiry');

  console.log('✅ Seed complete.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
