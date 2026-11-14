import { Role } from '@prisma/client';

/** Admin-level staff: ADMIN and SUPERADMIN (SUPERADMIN has every ADMIN power). */
export const STAFF_ROLES: readonly Role[] = ['ADMIN', 'SUPERADMIN'];

export const isStaff = (role: Role | string | undefined): boolean =>
  role === 'ADMIN' || role === 'SUPERADMIN';

export const isSuperAdmin = (role: Role | string | undefined): boolean =>
  role === 'SUPERADMIN';
