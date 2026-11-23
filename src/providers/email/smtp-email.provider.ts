import { Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { EmailProvider, SendEmailInput } from './email.interface';
import { renderEmail } from './templates';

/**
 * Sends real email over SMTP. Works with Gmail (an app password),
 * Zoho, Resend's SMTP relay, or any other SMTP server.
 */
export class SmtpEmailProvider implements EmailProvider {
  private readonly logger = new Logger('Email(smtp)');
  private readonly transport: nodemailer.Transporter;

  constructor(
    smtp: { host: string; port: number; secure: boolean; user: string; pass: string },
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      // Reuse connections: much faster when several emails go out together.
      pool: true,
      maxConnections: 3,
    });
  }

  async send(input: SendEmailInput): Promise<void> {
    const { subject, html, text } = renderEmail(input);
    await this.transport.sendMail({ from: this.from, to: input.to, subject, html, text });
    this.logger.log(`✉  [${input.template}] → ${input.to}`);
  }
}
