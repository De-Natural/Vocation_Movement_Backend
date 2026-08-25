import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from './jwt-payload';

/**
 * Extracts the authenticated user from the request.
 * Usage:  someHandler(@CurrentUser() user: AuthUser) { … }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthUser;
  },
);

// ─── Role-based access ───
export const ROLES_KEY = 'roles';
/**
 * Restrict a route to one or more roles (PRD auth column, e.g.
 * JWT:RELIGIOUS). Combine with JwtAuthGuard + RolesGuard.
 * Usage:  @Roles('ADMIN')  /  @Roles('RELIGIOUS')
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

// ─── Public route marker ───
export const IS_PUBLIC_KEY = 'isPublic';
/** Marks a route as public — skips the global JWT guard. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
