import { z } from 'zod';

/**
 * Zod schemas for auth payloads (PRD §3.1, §5.2). Admins can NOT be
 * created here — registration is restricted to student|sponsor
 * (ARCHITECTURE.md access rule).
 */

export const registerSchema = z
  .object({
    email: z.string().email(),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128),
    role: z.enum(['student', 'sponsor']), // NEVER "admin"
    fullName: z.string().min(2).max(120),
    // Optional profile fields captured at registration
    country: z.string().max(80).optional(),
    // Student-only formation basics (further details via profile endpoint)
    formationStage: z.enum(['Seminarian', 'Novice', 'Postulant']).optional(),
    congregation: z.string().max(160).optional(),
    school: z.string().max(160).optional(),
  })
  .refine(
    (d) =>
      d.role !== 'student' ||
      (!!d.formationStage && !!d.congregation && !!d.school),
    {
      message:
        'Students must provide formationStage, congregation and school at registration',
      path: ['formationStage'],
    },
  );
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // Optional expected role tab from the sign-in page (student/sponsor/admin)
  role: z.enum(['student', 'sponsor', 'admin']).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(10).optional(), // may also come from cookie
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8).max(128),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(10),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
