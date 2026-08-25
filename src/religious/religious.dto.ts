import { z } from 'zod';

/**
 * Religious (student) profile DTOs (PRD 3.2).
 *
 * The frontend speaks in display strings (formationStage "Seminarian",
 * "Year 2" etc.); these schemas accept the wire shape and the service
 * maps them to DB-native enums via the serializer enum-maps.
 */

const formationStage = z.enum(['Seminarian', 'Novice', 'Postulant']);

// A tolerant year parser: the frontend sends "Year 2" (yearOfFormation)
// and "2028" (expectedYear); accept plain numbers too.
const yearFromLabel = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const digits = String(v).match(/\d+/);
    return digits ? parseInt(digits[0], 10) : undefined;
  });

/**
 * Upsert the caller's own religious profile. All fields optional so the
 * multi-step register wizard and the profile-edit page can PATCH slices.
 * `fullName` is required only when no profile exists yet (checked in the
 * service against the seeded row from registration).
 */
export const upsertReligiousProfileSchema = z.object({
  fullName: z.string().min(2).max(120).optional(),
  biography: z.string().max(5000).optional(),
  formationStage: formationStage.optional(),
  congregation: z.string().min(2).max(160).optional(),
  school: z.string().min(2).max(160).optional(),
  country: z.string().min(2).max(80).optional(),
  location: z.string().max(160).optional(),
  phoneNumber: z.string().max(40).optional(),
  dateOfBirth: z
    .string()
    .datetime({ offset: true })
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .optional(),
  gender: z.string().max(24).optional(),
  yearOfFormation: yearFromLabel,
  expectedYear: yearFromLabel,
});
export type UpsertReligiousProfileInput = z.infer<
  typeof upsertReligiousProfileSchema
>;

/** Attach a verification document record after its file is uploaded. */
export const addVerificationDocSchema = z.object({
  label: z.string().min(2).max(80), // "Admission Letter", "Formation ID", …
});
export type AddVerificationDocInput = z.infer<typeof addVerificationDocSchema>;

/** Query params for the public browse/search list (matches students/page.tsx). */
export const listReligiousQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  congregation: z.string().optional(),
  stage: formationStage.optional(),
  school: z.string().optional(),
  country: z.string().optional(),
  billType: z
    .enum(['School Fees', 'Clothing', 'Feeding', 'Books', 'Medical', 'Miscellaneous'])
    .optional(),
  hideFunded: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1'),
  sort: z.enum(['urgent', 'newest', 'alpha', 'sponsored']).default('urgent'),
  page: z.union([z.string(), z.number()]).optional(),
  perPage: z.union([z.string(), z.number()]).optional(),
});
export type ListReligiousQuery = z.infer<typeof listReligiousQuerySchema>;
