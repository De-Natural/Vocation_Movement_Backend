import { z } from 'zod';

/**
 * Sponsor DTOs (PRD 3.4 / ARCHITECTURE §7.8, §7.4).
 * The sponsor Settings form edits name, country, currency, and the
 * anonymous-by-default preference; the derived aggregates (totalGiven,
 * studentsSponsored, activeRecurring, monthlyCommitment) are computed.
 */

export const upsertSponsorProfileSchema = z.object({
  fullName: z.string().min(2).max(160).optional(),
  country: z.string().max(120).optional(),
  currency: z.enum(['USD', 'NGN', 'GHS', 'EUR']).optional(),
  anonymousByDefault: z.boolean().optional(),
});
export type UpsertSponsorProfileInput = z.infer<
  typeof upsertSponsorProfileSchema
>;

// Sent-payments history filters (sponsor dashboard / PaymentHistoryTable).
export const sentPaymentsQuerySchema = z.object({
  from: z.string().optional(), // YYYY-MM-DD
  to: z.string().optional(),
  page: z.union([z.string(), z.number()]).optional(),
  perPage: z.union([z.string(), z.number()]).optional(),
});
export type SentPaymentsQuery = z.infer<typeof sentPaymentsQuerySchema>;
