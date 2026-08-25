import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { RedisService } from '../redis/redis.module';
import { JwtPayload } from '../common/auth/jwt-payload';
import { AppException } from '../common/http/app-exception';

/**
 * Issues RS256 access tokens (15m) and opaque refresh tokens stored in
 * Redis with a 7-day TTL, rotated on every use (PRD §5.1). Refresh
 * tokens are keyed `refresh:<userId>:<tokenId>` so logout can revoke all.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private refreshKey(userId: string, tokenId: string): string {
    return `refresh:${userId}:${tokenId}`;
  }

  async signAccessToken(user: Pick<User, 'id' | 'role' | 'isApproved'>): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      role: user.role,
      isApproved: user.isApproved,
      type: 'access',
    };
    return this.jwt.signAsync(payload, {
      privateKey: this.config.jwt.privateKey,
      algorithm: 'RS256',
      expiresIn: this.config.jwt.accessTtl,
    });
  }

  /** Create + persist a new refresh token; returns the opaque value. */
  async issueRefreshToken(userId: string): Promise<string> {
    const tokenId = randomUUID();
    const secret = randomUUID();
    const value = `${tokenId}.${secret}`;
    await this.redis.set(
      this.refreshKey(userId, tokenId),
      secret,
      this.config.jwt.refreshTtlSeconds,
    );
    // Prefix with userId so we can locate it on refresh without decoding.
    return `${userId}.${value}`;
  }

  /**
   * Validate a refresh token, rotate it (delete old, issue new), and
   * return the new token. Throws if invalid/expired/reused.
   */
  async rotateRefreshToken(raw: string): Promise<{ userId: string; refreshToken: string }> {
    const parts = raw.split('.');
    if (parts.length !== 3) {
      throw AppException.unauthorized('Invalid refresh token');
    }
    const [userId, tokenId, secret] = parts;
    const stored = await this.redis.get(this.refreshKey(userId, tokenId));
    if (!stored || stored !== secret) {
      throw AppException.unauthorized('Refresh token expired or reused');
    }
    // Rotate: invalidate the old token immediately (PRD §5.1).
    await this.redis.del(this.refreshKey(userId, tokenId));
    const refreshToken = await this.issueRefreshToken(userId);
    return { userId, refreshToken };
  }

  /** Revoke a single refresh token (logout). */
  async revokeRefreshToken(raw: string): Promise<void> {
    const parts = raw.split('.');
    if (parts.length !== 3) return;
    const [userId, tokenId] = parts;
    await this.redis.del(this.refreshKey(userId, tokenId));
  }
}
