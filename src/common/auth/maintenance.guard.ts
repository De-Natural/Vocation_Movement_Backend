import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AppException } from '../http/app-exception';
import { SettingsService } from '../../settings/settings.service';
import { AuthUser, JwtPayload } from './jwt-payload';
import { isStaff } from './staff';

/**
 * Routes that stay open while the platform is in maintenance: signing in
 * (staff need it; non-staff are refused inside login), token refresh/logout,
 * the public settings the site uses to show the maintenance page, and
 * gateway webhooks (payments already in flight must still settle).
 * Registration is NOT open.
 */
const OPEN_DURING_MAINTENANCE = [
  /^\/api\/auth\/(login|refresh|logout|me)\b/,
  /^\/api\/settings\/public\b/,
  /^\/api\/payments\/webhooks\//,
];

export const MAINTENANCE_MESSAGE =
  'Vocation Movement is undergoing scheduled maintenance. Please check back shortly.';

/**
 * When the Super-Admin turns on maintenance mode, every request from anyone
 * other than staff (ADMIN / SUPERADMIN) is answered with 503
 * MAINTENANCE_MODE. Runs after JwtAuthGuard; on @Public routes (where
 * JwtAuthGuard doesn't decode the token) it reads the Bearer token itself so
 * signed-in staff can still preview public pages.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(
    private readonly settings: SettingsService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (OPEN_DURING_MAINTENANCE.some((re) => re.test(path))) return true;

    const { maintenanceMode } = await this.settings.effective();
    if (!maintenanceMode) return true;

    const role = req.user?.role ?? (await this.roleFromToken(req));
    if (isStaff(role)) return true;

    throw AppException.serviceUnavailable(MAINTENANCE_MESSAGE, 'MAINTENANCE_MODE');
  }

  private async roleFromToken(req: Request): Promise<string | undefined> {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        publicKey: this.config.jwt.publicKey,
        algorithms: ['RS256'],
      });
      return payload.type === 'access' ? payload.role : undefined;
    } catch {
      return undefined;
    }
  }
}
