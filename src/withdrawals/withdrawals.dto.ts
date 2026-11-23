import { z } from 'zod';

const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const sendPhoneOtpSchema = z.object({ phone: z.string().trim().min(7).max(20) });
export const codeSchema = z.object({ code });
export const accountSchema = z.object({
  bankCode: z.string().trim().min(2).max(20),
  accountNumber: z.string().trim().regex(/^\d{10}$/, 'Account number must be 10 digits'),
});
export const startWithdrawalSchema = z.object({
  amount: z.union([z.number(), z.string()]).transform(Number).refine((n) => Number.isFinite(n) && n > 0, {
    message: 'Enter an amount greater than 0',
  }),
});

export type SendPhoneOtpInput = z.infer<typeof sendPhoneOtpSchema>;
export type CodeInput = z.infer<typeof codeSchema>;
export type AccountInput = z.infer<typeof accountSchema>;
export type StartWithdrawalInput = z.infer<typeof startWithdrawalSchema>;
