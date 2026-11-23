import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { FxRatesService, LiveFxRates } from './fx-rates.service';

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
  /** Super-Admin's maintenance notice (null = the default wording). */
  maintenanceMessage: string | null;
  /**
   * The rates in force: naira per 1 unit of each foreign currency, e.g.
   * { USD: 1367.64 }. The live rate, unless the Super-Admin set an override.
   */
  payoutFxRates: Record<string, number>;
  /** The Super-Admin's overrides only (stored in PlatformSettings). */
  fxOverrides: Record<string, number>;
  /** Today's live rates (refreshed daily), or null before the first fetch. */
  liveFx: LiveFxRates | null;
}

/** Keep only well-formed { "USD": 1550 } entries from the stored JSON. */
export function cleanFxRates(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = Number(v);
      if (/^[A-Z]{3}$/.test(k) && k !== 'NGN' && Number.isFinite(n) && n > 0) out[k] = n;
    }
  }
  return out;
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
  /**
   * Short-lived cache: the maintenance guard reads settings on every request.
   * The admin writer calls `invalidate()` so changes apply immediately on this
   * instance (and within CACHE_MS on any other instance).
   */
  private cache: { value: EffectiveSettings; at: number } | null = null;
  private static readonly CACHE_MS = 5_000;

  /** Drop the cached settings (call after writing PlatformSettings). */
  invalidate(): void {
    this.cache = null;
  }

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly fx: FxRatesService,
  ) {}

  /**
   * The effective settings governing runtime behaviour. Reads the singleton
   * row (no write) and falls back to configured/schema defaults so a missing
   * row or column never throws.
   */
  async effective(): Promise<EffectiveSettings> {
    if (this.cache && Date.now() - this.cache.at < SettingsService.CACHE_MS) {
      return this.cache.value;
    }
    const value = await this.read();
    this.cache = { value, at: Date.now() };
    return value;
  }

  private async read(): Promise<EffectiveSettings> {
    const [row, liveFx] = await Promise.all([
      this.prisma.platformSettings.findUnique({ where: { id: 'singleton' } }),
      this.fx.current(),
    ]);
    const fxOverrides = cleanFxRates(row?.payoutFxRates);
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
      maintenanceMessage: row?.maintenanceMessage?.trim() || null,
      // Live rate per currency, replaced by the Super-Admin's override where set.
      payoutFxRates: { ...cleanFxRates(liveFx?.rates), ...fxOverrides },
      fxOverrides,
      liveFx,
    };
  }

  /**
   * Apply the platform fee to a gift (Fee Model A — the fee is *deducted from
   * the gift*): the sponsor is charged the full gift, and the student's
   * progress bar advances by the net.
   *
   * `feeCents = round(gift × fee%)`, clamped to `[0, gift]`;
   * `chargeCents = gift`; `netCents = gift − feeCents`.
   * The default is 5% (platform upkeep); the Super-Admin can change it. With
   * `feePercent = 0` the fee is 0 and `net == gross`.
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
