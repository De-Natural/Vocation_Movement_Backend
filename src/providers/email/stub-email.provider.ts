import { Injectable, Logger } from '@nestjs/common';
import { EmailProvider, SendEmailInput } from './email.interface';

/**
 * Stub email provider — logs the email to the console instead of
 * sending. Every trigger in PRD §7 flows through here in dev/test.
 */
@Injectable()
export class StubEmailProvider implements EmailProvider {
  private readonly logger = new Logger('Email(stub)');

  async send(input: SendEmailInput): Promise<void> {
    this.logger.log(
      `✉  [${input.template}] → ${input.to} | "${input.subject}" | ${JSON.stringify(
        input.data,
      )}`,
    );
  }
}
