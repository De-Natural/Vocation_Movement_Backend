import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AppException } from '../http/app-exception';
import { IS_PUBLIC_KEY } from './decorators';
import { AuthUser, JwtPayload } from './jwt-payload';

/**
 * Verifies the RS256 Bearer access token and attaches `req.user`.
 * Routes marked @Public() are skipped. Applied globally in AppModule,
 * so every route is protected unless explicitly public.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(req);
    if (!token) {
      throw AppException.unauthorized('Missing authentication token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        publicKey: this.config.jwt.publicKey,
        algorithms: ['RS256'],
      });
    } catch {
      throw AppException.unauthorized('Invalid or expired token');
    }

    if (payload.type !== 'access') {
      throw AppException.unauthorized('Invalid token type');
    }

    const user: AuthUser = {
      userId: payload.sub,
      role: payload.role,
      isApproved: payload.isApproved,
    };
    (req as Request & { user: AuthUser }).user = user;
    return true;
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value;
}
