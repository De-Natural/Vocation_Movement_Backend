import { Logger } from '@nestjs/common';
import { SmsProvider } from './sms.interface';

/** Sends SMS through Termii (https://termii.com), a Nigerian SMS provider. */
export class TermiiSmsProvider implements SmsProvider {
  private readonly logger = new Logger('Sms(termii)');

  constructor(
    private readonly apiKey: string,
    private readonly senderId: string,
    private readonly channel: string,
  ) {}

  async send(to: string, message: string): Promise<void> {
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        to,
        from: this.senderId,
        sms: message,
        type: 'plain',
        channel: this.channel,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    if (!res.ok || (body.code && body.code !== 'ok')) {
      throw new Error(`Termii send failed (${res.status}): ${body.message ?? 'unknown error'}`);
    }
    this.logger.log(`SMS → ${to.slice(0, 6)}****`);
  }
}
