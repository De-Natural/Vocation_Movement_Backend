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
  // Stub mode only: the test-card outcome chosen on the mock checkout
  // ("decline" = 4000 0000 0000 0002). Ignored in live mode.
  simulate: z.enum(['success', 'decline']).default('success'),
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

// ── Guest checkout (no sponsor account) ──
// A visitor can give a one-time gift with just a name + email; the receipt
// goes to that email. Recurring gifts stay account-only.

// POST /api/payments/guest/intent
export const guestIntentSchema = z.object({
  billId: z.string().min(1, 'A bill must be selected'),
  amount: money,
  anonymous: z.boolean().optional(),
  method,
  name: z
    .string()
    .trim()
    .min(2, 'Please enter your name')
    .max(120, 'Name is too long'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Please enter a valid email address')
    .max(254),
});
export type GuestIntentInputDto = z.infer<typeof guestIntentSchema>;

// POST /api/payments/guest/confirm — the clientSecret returned by the guest
// intent proves the caller is the one who started this payment.
export const guestConfirmSchema = z.object({
  paymentId: z.string().min(1),
  clientSecret: z.string().min(1),
  simulate: z.enum(['success', 'decline']).default('success'),
});
export type GuestConfirmInputDto = z.infer<typeof guestConfirmSchema>;
