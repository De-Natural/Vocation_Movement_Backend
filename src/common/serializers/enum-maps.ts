/**
 * Bidirectional maps between DB-native enums (PRD §2) and the
 * frontend's `types.ts` string unions. Money helpers convert between
 * integer-cents (DB) and decimal units (frontend).
 */
import {
  Role,
  Stage,
  BillCategory as DbBillCategory,
  BillStatus as DbBillStatus,
  PaymentStatus as DbPaymentStatus,
  VerificationState,
} from '@prisma/client';
import {
  UserRole,
  FormationStage,
  BillCategory,
  BillStatus,
  PaymentStatus,
  VerificationStatus,
} from './api-types';

// ─── Role ───
export const roleToApi: Record<Role, UserRole> = {
  RELIGIOUS: 'student',
  SPONSOR: 'sponsor',
  ADMIN: 'admin',
};
export const roleFromApi: Record<UserRole, Role> = {
  student: 'RELIGIOUS',
  sponsor: 'SPONSOR',
  admin: 'ADMIN',
};

// ─── Formation stage ───
export const stageToApi: Record<Stage, FormationStage> = {
  SEMINARIAN: 'Seminarian',
  NOVICE: 'Novice',
  POSTULANT: 'Postulant',
};
export const stageFromApi: Record<FormationStage, Stage> = {
  Seminarian: 'SEMINARIAN',
  Novice: 'NOVICE',
  Postulant: 'POSTULANT',
};

// ─── Bill category ───
export const categoryToApi: Record<DbBillCategory, BillCategory> = {
  SCHOOL_FEES: 'School Fees',
  CLOTHING: 'Clothing',
  FEEDING: 'Feeding',
  BOOKS: 'Books',
  MEDICAL: 'Medical',
  MISC: 'Miscellaneous',
};
export const categoryFromApi: Record<BillCategory, DbBillCategory> = {
  'School Fees': 'SCHOOL_FEES',
  Clothing: 'CLOTHING',
  Feeding: 'FEEDING',
  Books: 'BOOKS',
  Medical: 'MEDICAL',
  Miscellaneous: 'MISC',
};

// ─── Bill status ───
export const billStatusToApi: Record<DbBillStatus, BillStatus> = {
  ACTIVE: 'Active',
  FUNDED: 'Fully Funded',
  OVERDUE: 'Overdue',
  ARCHIVED: 'Archived',
};

// ─── Payment status ───
// DB has REFUNDED which the frontend union lacks — map it to "Failed"
// for display purposes (a refunded contribution no longer counts as funded).
export const paymentStatusToApi: Record<DbPaymentStatus, PaymentStatus> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  FAILED: 'Failed',
  REFUNDED: 'Failed',
};

// ─── Verification status ───
export const verificationToApi: Record<VerificationState, VerificationStatus> = {
  PENDING: 'Pending Verification',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  SUSPENDED: 'Suspended',
};

// ─── Money ───
/** DB integer-cents → frontend decimal units. */
export const centsToUnits = (cents: number): number =>
  Math.round(cents) / 100;
/** Frontend decimal units → DB integer-cents. */
export const unitsToCents = (units: number): number =>
  Math.round(units * 100);
