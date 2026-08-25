import { z } from 'zod';

/**
 * Payment DTOs (PRD §3.5, §4). The frontend ContributionPanel sends:
 *   billId, amount (decimal dollars), anonymous (bool), a recurring flag,
 *   and method 'card' (Stripe) | 'paystack'. The service converts amount
 *   to integer-cents and maps the method to a DB Gateway enum.
 *
 * Card data NEVER reaches this API — the client collects it directly with
 * the gateway using the returned clientSecret (PRD §5.2 / PCI).
 */

// Accept "50", 50, or "50.00" for money entered in major units.
const money = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n) && n > 0, {
    message: 'Amount must be greater than 0',
  });

// The panel's payment-method dropdown → which gateway collects the card.
const method = z.enum(['card', 'paystack']).default('card');

// ── POST /api/payments/intent — start a one-time gift ──
export const createIntentSchema = z.object({
  billId: z.string().min(1, 'A bill must be selected'),
  amount: money,
  anonymous: z.boolean().optional(),
  method,
});
export type CreateIntentInputDto = z.infer<typeof createIntentSchema>;

// ── POST /api/payments/confirm — finalise a collected gift ──
// In stub mode this self-drives the gateway callback so the demo flow
// completes end-to-end; in live mode confirmation arrives via webhook and
// this simply reports the current status.
export const confirmSchema = z.object({
  paymentId: z.string().min(1),
});
export type ConfirmInputDto = z.infer<typeof confirmSchema>;

// ── POST /api/payments/recurring — start a monthly sponsorship ──
export const recurringSchema = z.object({
  billId: z.string().min(1, 'A bill must be selected'),
  amount: money,
  anonymous: z.boolean().optional(),
  method,
});
export type RecurringInputDto = z.infer<typeof recurringSchema>;
