import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { AppException } from '../http/app-exception';
import { ROLES_KEY } from './decorators';
import { AuthUser } from './jwt-payload';
import { isSuperAdmin } from './staff';

/**
 * Enforces @Roles(...) on a route. Runs after JwtAuthGuard, so
 * `req.user` is already populated. A suspended-user check is included
 * here since every authenticated route should reject suspended accounts.
 *
 * SUPERADMIN inherits every ADMIN route, so @Roles('ADMIN') also admits it.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = req.user;
    if (!user) {
      throw AppException.unauthorized();
    }
    const allowed =
      required.includes(user.role) ||
      (isSuperAdmin(user.role) && required.includes('ADMIN'));
    if (!allowed) {
      throw AppException.forbidden(
        'Your account role does not have access to this resource',
      );
    }
    return true;
  }
}
