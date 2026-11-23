import PDFDocument from 'pdfkit';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

/**
 * Real PDF reports (admin Reports page). Rendered on demand from live data
 * every time they are downloaded, so nothing depends on files kept on the
 * server's disk (which hosting providers wipe on each deploy).
 */
export interface ReportParams {
  kind: 'congregation' | 'platform' | 'monthly';
  congregation?: string;
  month?: string; // YYYY-MM
}

const GOLD = '#b8862f';
const NAVY = '#1d2a44';
const MUTED = '#5b6475';

const money = (cents: number, currency: string) =>
  `${currency} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "USD 120.00 · NGN 5,000.00" from per-currency sums. */
const perCurrency = (rows: { currency: string; cents: number }[]) =>
  rows.length ? rows.map((r) => money(r.cents, r.currency)).join('  ·  ') : '—';

const day = (d: Date) => d.toISOString().slice(0, 10);

interface Column {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

/** Build the PDF for a report and return it as a Buffer. */
export async function renderReportPdf(
  prisma: PrismaService,
  params: ReportParams,
  meta: { title: string; organizationName: string; generatedAt: Date },
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // ── Header ──
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(18).text(meta.organizationName, left);
  doc.moveDown(0.3);
  doc.fillColor(NAVY).fontSize(15).text(meta.title);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9)
    .text(`Generated ${meta.generatedAt.toUTCString()}`);
  doc.moveDown(1);

  const heading = (t: string) => {
    ensureSpace(40);
    doc.moveDown(0.6);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12).text(t, left);
    doc.moveDown(0.3);
  };
  const line = (label: string, value: string) => {
    ensureSpace(16);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(`${label}: `, left, doc.y, { continued: true });
    doc.fillColor(NAVY).text(value);
  };
  const note = (t: string) => {
    ensureSpace(16);
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(t, left);
  };
  function ensureSpace(h: number) {
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
  }
  const table = (cols: Column[], rows: string[][]) => {
    const scale = usable / cols.reduce((s, c) => s + c.width, 0);
    const widths = cols.map((c) => c.width * scale);
    const drawRow = (cells: string[], bold: boolean) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      const h = Math.max(...cells.map((c, i) => doc.heightOfString(c || ' ', { width: widths[i] - 6 }))) + 6;
      if (doc.y + h > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        if (!bold) drawRow(cols.map((c) => c.label), true);
      }
      const y = doc.y;
      let x = left;
      cells.forEach((c, i) => {
        doc.fillColor(bold ? NAVY : '#222222').text(c || ' ', x + 3, y + 3, {
          width: widths[i] - 6,
          align: cols[i].align ?? 'left',
        });
        x += widths[i];
      });
      doc.moveTo(left, y + h).lineTo(left + usable, y + h).strokeColor('#e5e0d5').lineWidth(0.5).stroke();
      doc.y = y + h;
      doc.x = left;
    };
    drawRow(cols.map((c) => c.label), true);
    if (!rows.length) {
      note('No records.');
      return;
    }
    rows.forEach((r) => drawRow(r, false));
  };

  // ── Body ──
  if (params.kind === 'monthly') {
    const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month! : new Date().toISOString().slice(0, 7);
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const where: Prisma.PaymentWhereInput = { status: 'CONFIRMED', confirmedAt: { gte: start, lt: end } };
    const [payments, sums] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { confirmedAt: 'asc' },
        take: 2000,
        include: {
          sponsor: { select: { fullName: true } },
          religious: { select: { fullName: true } },
          splits: { include: { bill: { select: { name: true } } } },
        },
      }),
      prisma.payment.groupBy({ by: ['currency'], where, _sum: { amountCents: true, feeCents: true, netAmountCents: true }, _count: { _all: true } }),
    ]);
    heading(`Summary for ${month}`);
    line('Confirmed gifts', String(sums.reduce((s, g) => s + g._count._all, 0)));
    line('Total given', perCurrency(sums.map((g) => ({ currency: g.currency, cents: g._sum.amountCents ?? 0 }))));
    line('Platform commission', perCurrency(sums.map((g) => ({ currency: g.currency, cents: g._sum.feeCents ?? 0 }))));
    line('Credited to students', perCurrency(sums.map((g) => ({ currency: g.currency, cents: g._sum.netAmountCents ?? 0 }))));
    heading('Gifts');
    table(
      [
        { label: 'Date', width: 70 },
        { label: 'Student', width: 110 },
        { label: 'Bill', width: 110 },
        { label: 'Donor', width: 110 },
        { label: 'Amount', width: 90, align: 'right' },
      ],
      payments.map((p) => [
        day(p.confirmedAt ?? p.createdAt),
        p.religious.fullName,
        p.splits.map((s) => s.bill.name).join(', '),
        `${p.sponsor?.fullName ?? p.guestName ?? 'Guest'}${p.sponsorId ? '' : ' (guest)'}${p.isAnonymous ? ' — anonymous' : ''}`,
        money(p.amountCents, p.currency),
      ]),
    );
    if (payments.length === 2000) note('Showing the first 2,000 gifts of the month.');
  } else if (params.kind === 'congregation') {
    const congregation = params.congregation ?? '';
    const students = await prisma.religiousProfile.findMany({
      where: { congregationName: congregation },
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, formationStage: true, verificationState: true, sponsorCount: true, totalNeededCents: true },
    });
    const ids = students.map((s) => s.id);
    const [byStudent, sums, recent] = await Promise.all([
      prisma.payment.groupBy({ by: ['religiousId', 'currency'], where: { religiousId: { in: ids }, status: 'CONFIRMED' }, _sum: { netAmountCents: true } }),
      prisma.payment.groupBy({ by: ['currency'], where: { religiousId: { in: ids }, status: 'CONFIRMED' }, _sum: { netAmountCents: true }, _count: { _all: true } }),
      prisma.payment.findMany({
        where: { religiousId: { in: ids }, status: 'CONFIRMED' },
        orderBy: { confirmedAt: 'desc' },
        take: 50,
        include: { religious: { select: { fullName: true } }, splits: { include: { bill: { select: { name: true } } } } },
      }),
    ]);
    heading(`Congregation: ${congregation || '—'}`);
    line('Students', String(students.length));
    line('Confirmed gifts', String(sums.reduce((s, g) => s + g._count._all, 0)));
    line('Raised (after commission)', perCurrency(sums.map((g) => ({ currency: g.currency, cents: g._sum.netAmountCents ?? 0 }))));
    heading('Students');
    table(
      [
        { label: 'Student', width: 130 },
        { label: 'Stage', width: 70 },
        { label: 'Status', width: 70 },
        { label: 'Supporters', width: 60, align: 'right' },
        { label: 'Raised', width: 120, align: 'right' },
      ],
      students.map((s) => [
        s.fullName,
        String(s.formationStage).toLowerCase(),
        String(s.verificationState).toLowerCase(),
        String(s.sponsorCount),
        perCurrency(byStudent.filter((b) => b.religiousId === s.id).map((b) => ({ currency: b.currency, cents: b._sum.netAmountCents ?? 0 }))),
      ]),
    );
    heading('Latest gifts');
    table(
      [
        { label: 'Date', width: 70 },
        { label: 'Student', width: 130 },
        { label: 'Bill', width: 130 },
        { label: 'Amount', width: 100, align: 'right' },
      ],
      recent.map((p) => [
        day(p.confirmedAt ?? p.createdAt),
        p.religious.fullName,
        p.splits.map((s) => s.bill.name).join(', '),
        money(p.amountCents, p.currency),
      ]),
    );
  } else {
    const [students, verified, sums, sponsors, guests, byCong, congStudents] = await Promise.all([
      prisma.religiousProfile.count(),
      prisma.religiousProfile.count({ where: { verificationState: 'VERIFIED' } }),
      prisma.payment.groupBy({ by: ['currency'], where: { status: 'CONFIRMED' }, _sum: { amountCents: true, feeCents: true, netAmountCents: true }, _count: { _all: true } }),
      prisma.sponsorProfile.count(),
      prisma.payment.findMany({ where: { status: 'CONFIRMED', sponsorId: null }, distinct: ['guestEmail'], select: { guestEmail: true } }),
      prisma.payment.groupBy({ by: ['religiousId', 'currency'], where: { status: 'CONFIRMED' }, _sum: { netAmountCents: true } }),
      prisma.religiousProfile.findMany({ select: { id: true, congregationName: true } }),
    ]);
    heading('Platform overview');
    line('Students registered', String(students));
    line('Students verified', String(verified));
    line('Sponsor accounts', String(sponsors));
    line('Guest donors', String(guests.length));
    line('Confirmed gifts', String(sums.reduce((s, g) => s + g._count._all, 0)));
    line('Total given', perCurrency(sums.map((g) => ({ currency: g.currency, cents: g._sum.amountCents ?? 0 }))));
    line('Platform commission', perCurrency(sums.map((g) => ({ currency: g.currency, cents: g._sum.feeCents ?? 0 }))));
    line('Credited to students', perCurrency(sums.map((g) => ({ currency: g.currency, cents: g._sum.netAmountCents ?? 0 }))));

    // Raised per congregation, per currency.
    const congOf = new Map(congStudents.map((s) => [s.id, s.congregationName]));
    const agg = new Map<string, { students: number; sums: Map<string, number> }>();
    for (const s of congStudents) {
      const e = agg.get(s.congregationName) ?? { students: 0, sums: new Map() };
      e.students += 1;
      agg.set(s.congregationName, e);
    }
    for (const b of byCong) {
      const e = agg.get(congOf.get(b.religiousId) ?? '');
      if (e) e.sums.set(b.currency, (e.sums.get(b.currency) ?? 0) + (b._sum.netAmountCents ?? 0));
    }
    heading('By congregation');
    table(
      [
        { label: 'Congregation', width: 180 },
        { label: 'Students', width: 60, align: 'right' },
        { label: 'Raised (after commission)', width: 180, align: 'right' },
      ],
      [...agg.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, e]) => [
          name || '—',
          String(e.students),
          perCurrency([...e.sums.entries()].map(([currency, cents]) => ({ currency, cents }))),
        ]),
    );
  }

  // ── Footer with page numbers ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
      `${meta.organizationName} · ${meta.title} · Page ${i - range.start + 1} of ${range.count}`,
      left,
      doc.page.height - 32,
      { width: usable, align: 'center' },
    );
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}
