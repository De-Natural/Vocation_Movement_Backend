/** Bank payouts for student withdrawals (NGN, Nigerian banks). */
export interface Bank {
  code: string;
  name: string;
}

export interface TransferResult {
  transferCode: string;
  /** success = settled now; pending = the gateway will confirm by webhook. */
  status: 'success' | 'pending' | 'failed';
  message?: string;
}

export interface PayoutProvider {
  readonly live: boolean;
  listBanks(): Promise<Bank[]>;
  /** Ask the bank for the account holder's name. Throws if the account doesn't exist. */
  resolveAccount(accountNumber: string, bankCode: string, nameHint?: string): Promise<{ accountName: string }>;
  createRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<string>;
  transfer(input: {
    amountCents: number;
    recipientCode: string;
    reference: string;
    reason: string;
  }): Promise<TransferResult>;
  /** Check a webhook really came from the gateway. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
}

export const PAYOUT_PROVIDER = 'PAYOUT_PROVIDER';
