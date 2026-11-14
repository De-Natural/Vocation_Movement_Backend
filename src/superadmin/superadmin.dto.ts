import { z } from 'zod';

/** POST /superadmin/admins — provision a new (normal) admin account. */
export const createAdminSchema = z.object({
  name: z.string().trim().min(2, "Please enter the admin's name").max(120),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
  // Initial password the super-admin shares with the new admin.
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});
export type CreateAdminInput = z.infer<typeof createAdminSchema>;

/** Reason recorded in the audit log for suspend / reactivate / delete. */
export const reasonSchema = z.object({
  reason: z.string().trim().min(3, 'Please give a reason (at least 3 characters)').max(2000),
});
export type ReasonInput = z.infer<typeof reasonSchema>;

/** GET /superadmin/users — student & sponsor directory. */
export const usersQuerySchema = z.object({
  role: z.enum(['student', 'sponsor', 'all']).default('all'),
  status: z.enum(['active', 'suspended', 'all']).default('all'),
  search: z.string().trim().max(120).optional(),
  page: z.union([z.string(), z.number()]).optional(),
  perPage: z.union([z.string(), z.number()]).optional(),
});
export type UsersQuery = z.infer<typeof usersQuerySchema>;

/** GET /superadmin/activity — audit log. */
export const activityQuerySchema = z.object({
  actorId: z.string().optional(),
  page: z.union([z.string(), z.number()]).optional(),
  perPage: z.union([z.string(), z.number()]).optional(),
});
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
