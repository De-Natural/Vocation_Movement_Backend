import { z } from 'zod';

/**
 * Bill DTOs (PRD 3.3). The frontend BillFormModal sends `total` as a
 * decimal-dollar string and `category` as a display label; the service
 * converts to integer-cents + DB enum.
 */

const billCategory = z.enum([
  'School Fees',
  'Clothing',
  'Feeding',
  'Books',
  'Medical',
  'Miscellaneous',
]);

// Accept "1200", 1200, or "1200.50" for money entered in major units.
const money = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n) && n > 0, {
    message: 'Total amount must be greater than 0',
  });

// The form's <input type="date"> yields YYYY-MM-DD; also allow full ISO.
const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'Please choose a valid due date');

export const createBillSchema = z.object({
  name: z.string().min(2).max(160),
  category: billCategory,
  total: money,
  dueDate,
  description: z.string().max(2000).optional(),
});
export type CreateBillInput = z.infer<typeof createBillSchema>;

// Edit: all optional, but at least the same shape. `total` still > 0 if sent.
export const updateBillSchema = z.object({
  name: z.string().min(2).max(160).optional(),
  category: billCategory.optional(),
  total: money.optional(),
  dueDate: dueDate.optional(),
  description: z.string().max(2000).optional(),
});
export type UpdateBillInput = z.infer<typeof updateBillSchema>;
