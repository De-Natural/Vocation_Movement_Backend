import { Global, Inject, Injectable, Module, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import {
  EMAIL_PROVIDER,
  EmailProvider,
  SendEmailInput,
} from '../providers/email/email.interface';

/**
 * Central place to (a) persist an in-app notification and (b) fire a
 * transactional email. Modules call these instead of touching the email
 * provider directly, keeping PRD §7 triggers in one auditable spot.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /** Create an in-app notification row for a user. */
  async notify(params: {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.notification.create({
      data: {
        userId: params.userId,
        type: params.type,
        title: params.title,
        body: params.body,
        meta: params.meta as object | undefined,
      },
    });
  }

  /**
   * Send a templated email (via the configured provider) in the
   * background: the request returns at once instead of waiting 1-3 s for
   * the mail server. Failures are logged and never break the request.
   */
  async sendEmail(input: SendEmailInput): Promise<void> {
    void this.email.send(input).catch((err: unknown) => {
      this.logger.error(
        `Email send failed (${input.template} → ${input.to}): ${(err as Error)?.message ?? err}`,
      );
    });
  }
}

@Global()
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
