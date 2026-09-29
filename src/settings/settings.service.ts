import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { APP_CONFIG, AppConfig } from '../config/configuration';

/**
 * The fully-resolved platform settings that actually govern runtime
 * behaviour. Read from the admin-editable `PlatformSettings` singleton and
 * backfilled from `config.defaults` / schema defaults when a value (or the
 * whole row) is missing. This is the shape every consumer works against so
 * the admin Settings screen is authoritative.
 */
export interface EffectiveSettings {
  organizationName: string;
  supportEmail: string;
  defaultCurrency: string;
  platformFeePercent: number;
  minGiftCents: number;
  autoApprove: boolean;
  maintenanceMode: boolean;
  anonymousDefault: boolean;
  emailReceipts: boolean;
}

/** Result of applying the platform fee to a gift under Fee Model A. */
export interface FeeBreakdown {
  /** What the sponsor is charged at the gateway (== the gift under Model A). */
  chargeCents: number;
  /** Platform fee deducted from the gift. */
  feeCents: number;
  /** Amount credited to the bill / progress bar (gift − fee). */
  netCents: number;
}

/**
 * Single reader for platform settings (ARCHITECTURE §7.3/§7.9).
 *
 * The admin module owns the *writer* (`PATCH /admin/settings` upserts the
 * singleton); this service is the *reader* every other module shares, plus
 * the one place the Fee Model A math lives. `@Global` so payments, auth and
 * the maintenance guard can inject it without importing the module.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The effective settings governing runtime behaviour. Reads the singleton
   * row (no write) and falls back to configured/schema defaults so a missing
   * row or column never throws.
   */
  async effective(): Promise<EffectiveSettings> {
    const row = await this.prisma.platformSettings.findUnique({
      where: { id: 'singleton' },
    });
    const d = this.config.defaults;
    return {
      organizationName: row?.organizationName ?? 'Vocation Movement',
      supportEmail: row?.supportEmail ?? 'support@vocationmovement.org',
      defaultCurrency: row?.defaultCurrency ?? d.currency,
      platformFeePercent: row?.platformFeePercent ?? d.platformFeePercent,
      minGiftCents: row?.minGiftCents ?? d.minGiftCents,
      autoApprove: row?.autoApprove ?? false,
      maintenanceMode: row?.maintenanceMode ?? false,
      anonymousDefault: row?.anonymousDefault ?? false,
      emailReceipts: row?.emailReceipts ?? true,
    };
  }

  /**
   * Apply the platform fee to a gift (Fee Model A — the fee is *deducted from
   * the gift*): the sponsor is charged the full gift, and the student's
   * progress bar advances by the net.
   *
   * `feeCents = round(gift × fee%)`, clamped to `[0, gift]`;
   * `chargeCents = gift`; `netCents = gift − feeCents`.
   * With `feePercent = 0` (the default) the fee is 0 and `net == gross`, so
   * existing/seeded numbers are unchanged.
   */
  computeFee(giftCents: number, feePercent: number): FeeBreakdown {
    const pct =
      Number.isFinite(feePercent) && feePercent > 0 ? feePercent : 0;
    const rawFee = Math.round(giftCents * (pct / 100));
    const feeCents = Math.min(Math.max(rawFee, 0), Math.max(giftCents, 0));
    return {
      chargeCents: giftCents,
      feeCents,
      netCents: giftCents - feeCents,
    };
  }
}
