import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.module';

/**
 * Live exchange rates into naira (naira per 1 unit of each currency).
 *
 * Fetched once a day from ExchangeRate-API's free open endpoint (no account
 * needed; attribution shown on the Settings page), with a second free source
 * as backup. Kept in Redis so every server instance shares the same rates and
 * a restart doesn't need a new fetch. The Super-Admin can override any
 * currency on Settings; an override always wins over the live rate.
 */
export interface LiveFxRates {
  /** e.g. { USD: 1367.64, GBP: 1791.1, EUR: 1501.04, GHS: 115.88 } */
  rates: Record<string, number>;
  /** When the provider last updated these rates (ISO). */
  updatedAt: string;
  /** When we fetched them (ISO). */
  fetchedAt: string;
  source: string;
}

const REDIS_KEY = 'fx:live:ngn';
/** Kept a week so a provider outage never wipes rates; refreshed daily. */
const KEEP_SECONDS = 7 * 24 * 3600;
/** Refetch when older than this. */
const STALE_MS = 12 * 3600 * 1000;
/** Rates we keep (gift currencies the platform supports). */
const CURRENCIES = ['USD', 'GBP', 'EUR', 'GHS', 'CAD', 'ZAR', 'KES'];

@Injectable()
export class FxRatesService {
  private readonly logger = new Logger(FxRatesService.name);
  private memo: { value: LiveFxRates | null; at: number } | null = null;

  constructor(private readonly redis: RedisService) {}

  /** The stored live rates (memoised for a minute), or null if never fetched. */
  async current(): Promise<LiveFxRates | null> {
    if (this.memo && Date.now() - this.memo.at < 60_000) return this.memo.value;
    let value: LiveFxRates | null = null;
    try {
      const raw = await this.redis.get(REDIS_KEY);
      value = raw ? (JSON.parse(raw) as LiveFxRates) : null;
    } catch (err) {
      this.logger.warn(`Could not read live rates: ${(err as Error).message}`);
    }
    this.memo = { value, at: Date.now() };
    return value;
  }

  /** Refetch when missing or older than 12 h. Never throws. */
  async refreshIfStale(): Promise<LiveFxRates | null> {
    const cur = await this.current();
    if (cur && Date.now() - new Date(cur.fetchedAt).getTime() < STALE_MS) return cur;
    return this.refresh();
  }

  /** Fetch fresh rates (primary source, then backup) and store them. Never throws. */
  async refresh(): Promise<LiveFxRates | null> {
    for (const fetcher of [() => this.fromExchangeRateApi(), () => this.fromCurrencyApi()]) {
      try {
        const value = await fetcher();
        await this.redis.set(REDIS_KEY, JSON.stringify(value), KEEP_SECONDS);
        this.memo = { value, at: Date.now() };
        this.logger.log(
          `Live rates updated from ${value.source}: ${Object.entries(value.rates)
            .map(([c, r]) => `${c} ₦${r}`)
            .join(', ')}`,
        );
        return value;
      } catch (err) {
        this.logger.warn(`Live rate source failed: ${(err as Error).message}`);
      }
    }
    this.logger.error('All live rate sources failed; keeping the last stored rates');
    return this.current();
  }

  /** ExchangeRate-API open access: rates per 1 USD. */
  private async fromExchangeRateApi(): Promise<LiveFxRates> {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { result?: string; rates?: Record<string, number>; time_last_update_unix?: number };
    if (!res.ok || j.result !== 'success' || !j.rates) throw new Error(`ExchangeRate-API: HTTP ${res.status}`);
    return this.build(j.rates, j.time_last_update_unix ? new Date(j.time_last_update_unix * 1000) : new Date(), 'ExchangeRate-API');
  }

  /** fawazahmed0 currency-api (backup): rates per 1 USD, lower-case codes. */
  private async fromCurrencyApi(): Promise<LiveFxRates> {
    const res = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', {
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { date?: string; usd?: Record<string, number> };
    if (!res.ok || !j.usd) throw new Error(`currency-api: HTTP ${res.status}`);
    const perUsd = Object.fromEntries(Object.entries(j.usd).map(([k, v]) => [k.toUpperCase(), v]));
    return this.build(perUsd, j.date ? new Date(`${j.date}T00:00:00Z`) : new Date(), 'currency-api');
  }

  /** Turn "units per 1 USD" into "naira per 1 unit", with sanity checks. */
  private build(perUsd: Record<string, number>, updated: Date, source: string): LiveFxRates {
    const ngnPerUsd = Number(perUsd.NGN);
    // Guard against a broken feed: the naira has been far inside this range.
    if (!(ngnPerUsd > 100 && ngnPerUsd < 100_000)) throw new Error(`${source}: implausible NGN rate ${perUsd.NGN}`);
    const rates: Record<string, number> = {};
    for (const c of CURRENCIES) {
      const perUnit = Number(perUsd[c]);
      if (perUnit > 0) rates[c] = Math.round((ngnPerUsd / perUnit) * 100) / 100;
    }
    if (!rates.USD) throw new Error(`${source}: no USD rate`);
    return { rates, updatedAt: updated.toISOString(), fetchedAt: new Date().toISOString(), source };
  }
}
