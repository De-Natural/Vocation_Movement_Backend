import { z } from 'zod';

/**
 * Admin DTOs (PRD 3.7 / ARCHITECTURE §7.5, §7.9).
 */

// Verification decisions that require a reason (emailed to the student).
export const rejectSchema = z.object({
  reason: z.string().min(3, 'A reason is required — it is emailed to the student').max(2000),
});
export type RejectInput = z.infer<typeof rejectSchema>;

export const requestInfoSchema = z.object({
  reason: z.string().min(3, 'Describe what the student must provide').max(2000),
});
export type RequestInfoInput = z.infer<typeof requestInfoSchema>;

export const suspendSchema = z.object({
  reason: z.string().min(3, 'A reason is required').max(2000),
});
export type SuspendInput = z.infer<typeof suspendSchema>;

// Transactions feed filters (admin/transactions/page.tsx).
export const transactionsQuerySchema = z.object({
  congregation: z.string().optional(),
  donorType: z.enum(['all', 'named', 'anonymous']).default('all'),
  status: z.enum(['Confirmed', 'Pending', 'Failed']).optional(),
  from: z.string().optional(), // YYYY-MM-DD
  to: z.string().optional(),
  page: z.union([z.string(), z.number()]).optional(),
  perPage: z.union([z.string(), z.number()]).optional(),
});
export type TransactionsQuery = z.infer<typeof transactionsQuerySchema>;

// Verification queue filter (?status=).
export const verificationsQuerySchema = z.object({
  status: z
    .enum(['Pending Verification', 'Verified', 'Rejected', 'Suspended', 'all'])
    .default('Pending Verification'),
});
export type VerificationsQuery = z.infer<typeof verificationsQuerySchema>;

// Platform settings update (all optional; admin/settings/page.tsx).
export const updateSettingsSchema = z.object({
  organizationName: z.string().min(2).max(160).optional(),
  supportEmail: z.string().email().optional(),
  defaultCurrency: z.enum(['USD', 'NGN', 'GHS', 'EUR']).optional(),
  platformFeePercent: z.number().min(0).max(100).optional(),
  minGift: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined ? undefined : Number(v))),
  autoApprove: z.boolean().optional(),
  maintenanceMode: z.boolean().optional(),
  anonymousDefault: z.boolean().optional(),
  emailReceipts: z.boolean().optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

// Report generation (admin/reports/page.tsx).
export const generateReportSchema = z.object({
  kind: z.enum(['congregation', 'platform', 'monthly']).default('platform'),
  congregation: z.string().optional(),
  month: z.string().optional(), // YYYY-MM
});
export type GenerateReportInput = z.infer<typeof generateReportSchema>;
