import { Inject, Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { RedisService } from '../../redis/redis.module';
import { AppException } from '../http/app-exception';
import { AuthUser } from './jwt-payload';
import { SetMetadata } from '@nestjs/common';

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  /** Key by 'ip' (default) or 'user'. */
  by?: 'ip' | 'user';
  /** Namespace so different routes don't share a counter. */
  name?: string;
}

export const RATE_LIMIT_KEY = 'rateLimit';
/**
 * Per-route rate limiting backed by Redis (PRD §5.2).
 *   @RateLimit({ limit: 10, windowSeconds: 900 })  // login: 10 / 15min
 */
export const RateLimit = (opts: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, opts);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!opts) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();

    const subject =
      opts.by === 'user' && req.user
        ? `user:${req.user.userId}`
        : `ip:${req.ip}`;
    const routeName = opts.name ?? `${req.method}:${req.baseUrl}${req.path}`;
    const key = `ratelimit:${routeName}:${subject}`;

    const count = await this.redis.incrWithWindow(key, opts.windowSeconds);
    if (count > opts.limit) {
      throw AppException.tooManyRequests(
        'Too many requests — please slow down and try again shortly.',
      );
    }
    return true;
  }
}
