import {
  Global,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/configuration';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * Thin wrapper over ioredis exposing the helpers used across the app:
 * refresh-token storage, rate-limit counters, and generic key/value.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    this.client.on('error', (err) =>
      this.logger.error(`Redis error: ${err.message}`),
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.log('Connected to Redis');
    } catch (err) {
      this.logger.error(
        'Failed to connect to Redis. Is `docker compose up` running?',
        err as Error,
      );
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  // ─── Generic helpers ───
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Fixed-window rate-limit counter. Returns the current hit count for
   * the window; the first hit sets the expiry.
   */
  async incrWithWindow(key: string, windowSeconds: number): Promise<number> {
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, windowSeconds);
    }
    return count;
  }
}

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
