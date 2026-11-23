import { Logger } from '@nestjs/common';
import { SmsProvider } from './sms.interface';

/** Logs SMS messages instead of sending them (no Termii key set). */
export class StubSmsProvider implements SmsProvider {
  private readonly logger = new Logger('Sms(stub)');

  async send(to: string, message: string): Promise<void> {
    this.logger.log(`📱 → ${to} | "${message}"`);
  }
}
