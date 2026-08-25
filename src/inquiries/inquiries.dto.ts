import { z } from 'zod';

/**
 * Contact inquiry DTOs (ARCHITECTURE §7.7).
 * The public contact form collects name, email, phone and a message; the
 * frontend requires all four, so we validate them here. Admins later filter
 * the inbox by read/unread.
 */

export const createInquirySchema = z.object({
  name: z.string().trim().min(1, 'Please enter your name.').max(160),
  email: z
    .string()
    .trim()
    .min(1, 'Please enter your email.')
    .email('Please enter a valid email address.')
    .max(200),
  phone: z.string().trim().min(1, 'Please enter a phone number.').max(40),
  message: z
    .string()
    .trim()
    .min(1, 'Please tell us how we can help.')
    .max(5000),
});
export type CreateInquiryInput = z.infer<typeof createInquirySchema>;

// Admin inbox filter (mirrors the "All" / "Unread" tabs).
export const listInquiriesQuerySchema = z.object({
  filter: z.enum(['all', 'unread']).optional(),
});
export type ListInquiriesQuery = z.infer<typeof listInquiriesQuerySchema>;
