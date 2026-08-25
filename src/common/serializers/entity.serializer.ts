/**
 * Entity serializers: Prisma records → frontend `types.ts` shapes.
 *
 * Every controller runs its DB results through these before returning,
 * so the API contract exactly matches what the Next.js frontend expects.
 *
 * Anonymity (PRD §4.2) is enforced HERE, at the serialisation layer —
 * the DB always retains the real sponsor identity for audit; these
 * functions decide what a given audience is allowed to see.
 */
import type {
  Bill as DbBill,
  Payment as DbPayment,
  PaymentSplit as DbPaymentSplit,
  ReligiousProfile,
  SponsorProfile,
  User,
  Message as DbMessage,
  MessageReply as DbMessageReply,
  Sponsorship as DbSponsorship,
  ContactInquiry as DbInquiry,
} from '@prisma/client';
import {
  Bill,
  Contribution,
  Student,
  Sponsor,
  ThankYouMessage,
  MessageReply,
  RecurringSponsorship,
  ContactInquiry,
} from './api-types';
import {
  billStatusToApi,
  categoryToApi,
  centsToUnits,
  paymentStatusToApi,
  stageToApi,
  verificationToApi,
} from './enum-maps';

const iso = (d: Date | null | undefined): string =>
  d ? new Date(d).toISOString() : '';

// ────────────────────────── Contribution ──────────────────────────
// A Contribution (frontend) is one payment-split flattened with its
// parent payment's metadata. `viewerIsAdmin` reveals the true donor.
type SplitWithPayment = DbPaymentSplit & {
  payment: DbPayment & { sponsor?: (SponsorProfile & { user?: User }) | null };
};

export function serializeContribution(
  split: SplitWithPayment,
  opts: { viewerIsAdmin?: boolean } = {},
): Contribution {
  const p = split.payment;
  const donorName = resolveDonorName(
    p.isAnonymous,
    p.sponsor?.fullName,
    opts.viewerIsAdmin,
  );
  return {
    id: split.id,
    billId: split.billId,
    donorName,
    anonymous: p.isAnonymous,
    amount: centsToUnits(split.amountCents),
    date: iso(p.confirmedAt ?? p.createdAt),
    transactionId: p.gatewayTxId,
    status: paymentStatusToApi[p.status],
    recurring: p.isRecurring,
  };
}

/** PRD §4.2 anonymity: hide donor unless the viewer is an admin. */
export function resolveDonorName(
  anonymous: boolean,
  realName: string | undefined | null,
  viewerIsAdmin?: boolean,
): string {
  if (!anonymous) return realName ?? 'Unknown';
  return viewerIsAdmin ? `${realName ?? 'Unknown'} (hidden)` : 'Anonymous';
}

// ────────────────────────── Bill ──────────────────────────
type BillWithSplits = DbBill & {
  paymentSplits?: SplitWithPayment[];
};

export function serializeBill(
  bill: BillWithSplits,
  opts: { viewerIsAdmin?: boolean } = {},
): Bill {
  const contributions = (bill.paymentSplits ?? [])
    .filter((s) => s.payment) // guard
    .map((s) => serializeContribution(s, opts));
  return {
    id: bill.id,
    studentId: bill.religiousId,
    name: bill.name,
    category: categoryToApi[bill.category],
    total: centsToUnits(bill.totalCents),
    raised: centsToUnits(bill.raisedCents),
    dueDate: iso(bill.dueDate),
    description: bill.description ?? undefined,
    status: billStatusToApi[bill.status],
    contributions,
  };
}

// ────────────────────────── Student ──────────────────────────
type ReligiousWithRelations = ReligiousProfile & {
  bills?: BillWithSplits[];
};

export function serializeStudent(
  profile: ReligiousWithRelations,
  opts: { viewerIsAdmin?: boolean } = {},
): Student {
  return {
    id: profile.id,
    slug: profile.slug,
    name: profile.fullName,
    photo: profile.photoUrl ?? '',
    formationStage: stageToApi[profile.formationStage],
    congregation: profile.congregationName,
    school: profile.schoolName,
    country: profile.country,
    location: profile.location,
    dateOfBirth: profile.dateOfBirth ? iso(profile.dateOfBirth) : undefined,
    gender: profile.gender ?? undefined,
    yearOfFormation:
      profile.yearOfFormation != null
        ? `Year ${profile.yearOfFormation}`
        : undefined,
    expectedYear:
      profile.expectedYear != null ? String(profile.expectedYear) : undefined,
    biography: profile.biography,
    verification: verificationToApi[profile.verificationState],
    createdAt: iso(profile.createdAt),
    bills: (profile.bills ?? []).map((b) => serializeBill(b, opts)),
    sponsorCount: profile.sponsorCount,
    profileCompletion: profile.profileCompletion,
  };
}

// ────────────────────────── Sponsor ──────────────────────────
type SponsorWithAggregates = SponsorProfile & {
  user?: User;
  _agg?: {
    totalGivenCents: number;
    studentsSponsored: number;
    activeRecurring: number;
    monthlyCommitmentCents: number;
  };
};

export function serializeSponsor(sponsor: SponsorWithAggregates): Sponsor {
  const agg = sponsor._agg;
  return {
    id: sponsor.id,
    name: sponsor.fullName,
    email: sponsor.user?.email ?? '',
    country: sponsor.country,
    currency: sponsor.currency,
    anonymousByDefault: sponsor.anonymousByDefault,
    totalGiven: centsToUnits(agg?.totalGivenCents ?? 0),
    studentsSponsored: agg?.studentsSponsored ?? 0,
    activeRecurring: agg?.activeRecurring ?? 0,
    monthlyCommitment: centsToUnits(agg?.monthlyCommitmentCents ?? 0),
  };
}

// ────────────────────────── Recurring sponsorship ──────────────────────────
type SponsorshipWithStudent = DbSponsorship & {
  religious?: ReligiousProfile | null;
  bill?: DbBill | null;
};

export function serializeRecurring(
  s: SponsorshipWithStudent,
): RecurringSponsorship {
  return {
    id: s.id,
    studentId: s.religiousId,
    studentName: s.religious?.fullName ?? '',
    studentPhoto: s.religious?.photoUrl ?? '',
    amount: centsToUnits(s.amountCents),
    billName: s.bill?.name ?? '',
    active: s.status === 'ACTIVE',
    nextDate: iso(s.nextChargeDate),
  };
}

// ────────────────────────── Message ──────────────────────────
type MessageWithRelations = DbMessage & {
  student?: ReligiousProfile | null;
  sponsor?: (SponsorProfile & { user?: User }) | null;
  replies?: DbMessageReply[];
};

export function serializeMessageReply(r: DbMessageReply): MessageReply {
  return {
    id: r.id,
    from: r.from === 'STUDENT' ? 'student' : 'sponsor',
    body: r.body,
    date: iso(r.createdAt),
  };
}

/**
 * Serialize a thank-you message. When the donor is anonymous, the
 * platform proxies the note so the student never learns the identity —
 * sponsorName becomes "Anonymous (via Admin)". Admins see the real name.
 */
export function serializeMessage(
  m: MessageWithRelations,
  opts: { viewerIsAdmin?: boolean } = {},
): ThankYouMessage {
  let sponsorName: string;
  if (m.anonymousDonor) {
    sponsorName = opts.viewerIsAdmin
      ? `${m.sponsor?.fullName ?? 'Unknown'} (via Admin)`
      : 'Anonymous (via Admin)';
  } else {
    sponsorName = m.sponsor?.fullName ?? 'Unknown';
  }
  return {
    id: m.id,
    studentId: m.studentId,
    studentName: m.student?.fullName ?? '',
    studentPhoto: m.student?.photoUrl ?? '',
    sponsorName,
    anonymousDonor: m.anonymousDonor,
    subject: m.subject,
    body: m.body,
    date: iso(m.createdAt),
    read: m.read,
    photoAttachment: m.photoAttachment ?? undefined,
    replies: (m.replies ?? []).map(serializeMessageReply),
  };
}

// ────────────────────────── Contact inquiry ──────────────────────────
export function serializeInquiry(i: DbInquiry): ContactInquiry {
  return {
    id: i.id,
    name: i.name,
    email: i.email,
    phone: i.phone ?? undefined,
    message: i.message,
    date: iso(i.createdAt),
    read: i.status !== 'UNREAD',
  };
}
