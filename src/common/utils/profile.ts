/** Slugify a name into a URL-safe, unique-ish slug (matches frontend). */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Compute profile completion 0-100 from a religious profile's filled
 * fields. Used to keep `profileCompletion` in sync on profile updates.
 */
export function computeProfileCompletion(p: {
  photoUrl?: string | null;
  biography?: string | null;
  formationStage?: unknown;
  congregationName?: string | null;
  schoolName?: string | null;
  country?: string | null;
  location?: string | null;
  phoneNumber?: string | null;
  dateOfBirth?: Date | null;
  gender?: string | null;
  yearOfFormation?: number | null;
  expectedYear?: number | null;
}): number {
  const checks = [
    !!p.photoUrl,
    !!p.biography && p.biography.length > 20,
    !!p.formationStage,
    !!p.congregationName,
    !!p.schoolName,
    !!p.country,
    !!p.location,
    !!p.phoneNumber,
    !!p.dateOfBirth,
    !!p.gender,
    p.yearOfFormation != null,
    p.expectedYear != null,
  ];
  const filled = checks.filter(Boolean).length;
  return Math.round((filled / checks.length) * 100);
}
