import { PaginationMeta } from '../http/response';

/** Parse & clamp page / perPage query params. */
export function parsePagination(
  page?: string | number,
  perPage?: string | number,
  maxPerPage = 100,
): { page: number; perPage: number; skip: number; take: number } {
  const p = Math.max(1, parseInt(String(page ?? 1), 10) || 1);
  const pp = Math.min(
    maxPerPage,
    Math.max(1, parseInt(String(perPage ?? 20), 10) || 20),
  );
  return { page: p, perPage: pp, skip: (p - 1) * pp, take: pp };
}

export function paginationMeta(
  page: number,
  perPage: number,
  total: number,
): PaginationMeta {
  return {
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}
