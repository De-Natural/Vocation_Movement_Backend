import { z } from 'zod';

/**
 * Messaging DTOs (PRD 3.6 / ARCHITECTURE §7.6).
 *
 * A religious student composes a thank-you note to a sponsor who has funded
 * them. The recipient is identified either by a specific gift (`paymentId` —
 * the natural entry point from the student's Payment History) or directly by
 * `sponsorId`. When the donor gave anonymously the note is relayed through the
 * platform admin; the student never learns the sponsor's identity.
 */

// Compose a thank-you note (student → sponsor). Body capped at 1000 chars to
// match the frontend composer's CHAR_LIMIT.
export const sendMessageSchema = z
  .object({
    paymentId: z.string().min(1).optional(),
    sponsorId: z.string().min(1).optional(),
    subject: z.string().trim().max(160).optional(), // defaults to "Thank you"
    body: z
      .string()
      .trim()
      .min(1, 'Please write your message first.')
      .max(1000, 'Message is too long (max 1000 characters).'),
    photoAttachment: z.string().max(512).optional(), // uploaded file key/url
  })
  .refine((d) => Boolean(d.paymentId || d.sponsorId), {
    message: 'A recipient is required',
    path: ['sponsorId'],
  });
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

// Reply within an existing thread (either party).
export const replySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Reply cannot be empty.')
    .max(1000, 'Reply is too long (max 1000 characters).'),
});
export type ReplyInput = z.infer<typeof replySchema>;

// GET /api/messages?role=student|sponsor — informational; the authenticated
// user's own role/profile is what actually scopes the query.
export const listMessagesQuerySchema = z.object({
  role: z.enum(['student', 'sponsor']).optional(),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
