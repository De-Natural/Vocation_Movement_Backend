/**
 * Standard API response envelope (PRD §10.1).
 *
 *   SUCCESS → { success: true, data, message?, meta? }
 *   ERROR   → { success: false, error: { code, message, statusCode } }
 */

export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface SuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
  meta?: PaginationMeta | Record<string, unknown>;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    statusCode: number;
    details?: unknown;
  };
}

export function ok<T>(
  data: T,
  message?: string,
  meta?: PaginationMeta | Record<string, unknown>,
): SuccessResponse<T> {
  return { success: true, data, ...(message ? { message } : {}), ...(meta ? { meta } : {}) };
}
