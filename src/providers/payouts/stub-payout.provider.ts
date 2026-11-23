import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Bank, PayoutProvider, TransferResult } from './payout.interface';

const BANKS: Bank[] = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '50211', name: 'Kuda Bank' },
  { code: '999992', name: 'OPay' },
  { code: '999991', name: 'PalmPay' },
  { code: '076', name: 'Polaris Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank For Africa' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
];

/**
 * Simulated payouts (no Paystack key, or PAYOUT_MODE is not "live").
 * Accounts "resolve" to the student's own name and transfers succeed
 * at once. No real money moves.
 */
export class StubPayoutProvider implements PayoutProvider {
  readonly live = false;
  private readonly logger = new Logger('Payouts(stub)');

  async listBanks(): Promise<Bank[]> {
    return BANKS;
  }

  async resolveAccount(accountNumber: string, bankCode: string, nameHint?: string) {
    if (!/^\d{10}$/.test(accountNumber)) throw new Error('Account number must be 10 digits');
    if (!BANKS.some((b) => b.code === bankCode)) throw new Error('Unknown bank');
    return { accountName: (nameHint || 'Test Account Holder').toUpperCase() };
  }

  async createRecipient(): Promise<string> {
    return `RCP_stub_${randomUUID().slice(0, 12)}`;
  }

  async transfer(input: { amountCents: number; reference: string }): Promise<TransferResult> {
    this.logger.log(`💸 simulated transfer ₦${(input.amountCents / 100).toFixed(2)} ref=${input.reference}`);
    return { transferCode: `TRF_stub_${randomUUID().slice(0, 12)}`, status: 'success' };
  }

  verifyWebhook(): boolean {
    return false; // the stub never sends webhooks
  }
}
