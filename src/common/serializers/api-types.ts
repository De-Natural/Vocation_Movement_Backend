/**
 * Canonical API response types — MUST mirror the frontend's
 * `src/lib/types.ts` exactly. These are the shapes every controller
 * returns (inside the standard { success, data, ... } envelope).
 *
 * The database stores PRD-native enums & integer-cents money; the
 * serializers in this folder convert DB records into these shapes.
 */

export type UserRole = 'student' | 'sponsor' | 'admin';

export type FormationStage = 'Seminarian' | 'Novice' | 'Postulant';

export type BillCategory =
  | 'School Fees'
  | 'Clothing'
  | 'Feeding'
  | 'Books'
  | 'Medical'
  | 'Miscellaneous';

export type BillStatus = 'Active' | 'Fully Funded' | 'Overdue' | 'Archived';

export type PaymentStatus = 'Confirmed' | 'Pending' | 'Failed';

export type VerificationStatus =
  | 'Pending Verification'
  | 'Verified'
  | 'Rejected'
  | 'Suspended';

export interface Contribution {
  id: string;
  billId: string;
  donorName: string; // "Anonymous" when anonymous
  anonymous: boolean;
  amount: number;
  date: string; // ISO
  transactionId: string;
  status: PaymentStatus;
  recurring?: boolean;
}

export interface Bill {
  id: string;
  studentId: string;
  name: string;
  category: BillCategory;
  total: number;
  raised: number;
  dueDate: string; // ISO
  description?: string;
  status: BillStatus;
  contributions: Contribution[];
}

export interface Student {
  id: string;
  slug: string;
  name: string;
  photo: string;
  formationStage: FormationStage;
  congregation: string;
  school: string;
  country: string;
  location: string;
  dateOfBirth?: string;
  gender?: string;
  yearOfFormation?: string;
  expectedYear?: string;
  biography: string;
  verification: VerificationStatus;
  createdAt: string;
  bills: Bill[];
  sponsorCount: number;
  profileCompletion: number; // 0-100
}

export interface Sponsor {
  id: string;
  name: string;
  email: string;
  country: string;
  currency: string;
  anonymousByDefault: boolean;
  totalGiven: number;
  studentsSponsored: number;
  activeRecurring: number;
  monthlyCommitment: number;
}

export interface RecurringSponsorship {
  id: string;
  studentId: string;
  studentName: string;
  studentPhoto: string;
  amount: number;
  billName: string;
  active: boolean;
  nextDate: string;
}

export interface MessageReply {
  id: string;
  from: 'student' | 'sponsor';
  body: string;
  date: string;
}

export interface ThankYouMessage {
  id: string;
  studentId: string;
  studentName: string;
  studentPhoto: string;
  sponsorName: string; // may be "Anonymous (via Admin)"
  anonymousDonor: boolean;
  subject: string;
  body: string;
  date: string;
  read: boolean;
  photoAttachment?: string;
  replies: MessageReply[];
}

export interface PlatformStats {
  studentsSupported: number;
  fundsRaised: number;
  sponsors: number;
  activeSponsorships: number;
}

export interface ContactInquiry {
  id: string;
  name: string;
  email: string;
  phone?: string;
  message: string;
  date: string;
  read: boolean;
}
