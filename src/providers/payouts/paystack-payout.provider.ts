import { createHmac, timingSafeEqual } from 'crypto';
import { Bank, PayoutProvider, TransferResult } from './payout.interface';

/**
 * Paystack Transfers (https://paystack.com/docs/transfers). Requires a
 * live secret key, a funded Paystack balance, and "OTP for transfers"
 * turned off in the Paystack dashboard so API transfers go through.
 */
export class PaystackPayoutProvider implements PayoutProvider {
  readonly live = true;
  private banksCache: { at: number; banks: Bank[] } | null = null;

  constructor(private readonly secretKey: string) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`https://api.paystack.co${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (!res.ok || body.status === false) {
      throw new Error(body.message || `Paystack request failed (${res.status})`);
    }
    return body.data as T;
  }

  async listBanks(): Promise<Bank[]> {
    // The bank list rarely changes: cache it for 12 hours.
    if (this.banksCache && Date.now() - this.banksCache.at < 12 * 3600_000) return this.banksCache.banks;
    const data = await this.call<{ name: string; code: string; active?: boolean }[]>(
      '/bank?country=nigeria&currency=NGN&perPage=200',
    );
    const banks = data.filter((b) => b.active !== false).map((b) => ({ code: b.code, name: b.name }));
    this.banksCache = { at: Date.now(), banks };
    return banks;
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<{ accountName: string }> {
    const data = await this.call<{ account_name: string }>(
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );
    return { accountName: data.account_name };
  }

  async createRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<string> {
    const data = await this.call<{ recipient_code: string }>('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify({
        type: 'nuban',
        name: input.name,
        account_number: input.accountNumber,
        bank_code: input.bankCode,
        currency: 'NGN',
      }),
    });
    return data.recipient_code;
  }

  async transfer(input: {
    amountCents: number;
    recipientCode: string;
    reference: string;
    reason: string;
  }): Promise<TransferResult> {
    const data = await this.call<{ transfer_code: string; status: string }>('/transfer', {
      method: 'POST',
      body: JSON.stringify({
        source: 'balance',
        amount: input.amountCents,
        recipient: input.recipientCode,
        reference: input.reference,
        reason: input.reason,
        currency: 'NGN',
      }),
    });
    const status = data.status === 'success' ? 'success' : data.status === 'failed' ? 'failed' : 'pending';
    return { transferCode: data.transfer_code, status };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
