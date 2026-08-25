import { Injectable, Logger } from '@nestjs/common';
import { Gateway } from '@prisma/client';
import { createHmac, randomUUID } from 'crypto';
import {
  CreateIntentInput,
  CreateIntentResult,
  CreateSubscriptionInput,
  CreateSubscriptionResult,
  NormalizedWebhookEvent,
  PaymentGateway,
} from './gateway.interface';

/**
 * Simulated gateway shared by the Stripe & Paystack stubs. It:
 *  - returns a fake client_secret + gateway tx id on createIntent
 *  - can build a self-signed webhook payload (see buildTestWebhook) so
 *    the confirm flow is exercisable without a real gateway
 *  - verifies that self-signed HMAC on the way back in
 *
 * The signing secret defaults to a constant in stub mode so a developer
 * can POST a test webhook locally.
 */
export class StubGateway implements PaymentGateway {
  private readonly logger: Logger;

  constructor(
    public readonly name: Gateway,
    private readonly webhookSecret = 'stub-webhook-secret',
  ) {
    this.logger = new Logger(`${name}(stub)`);
  }

  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    const gatewayTxId = `${this.name.toLowerCase()}_${randomUUID()}`;
    this.logger.log(
      `createIntent ${input.amountCents} ${input.currency} → ${gatewayTxId}`,
    );
    return {
      gateway: this.name,
      gatewayTxId,
      clientSecret: `${gatewayTxId}_secret_${randomUUID().slice(0, 8)}`,
    };
  }

  async createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<CreateSubscriptionResult> {
    const gatewaySubId = `${this.name.toLowerCase()}_sub_${randomUUID()}`;
    this.logger.log(
      `createSubscription ${input.amountCents} ${input.currency}/mo → ${gatewaySubId}`,
    );
    return {
      gateway: this.name,
      gatewaySubId,
      clientSecret: `${gatewaySubId}_secret`,
    };
  }

  async cancelSubscription(id: string): Promise<void> {
    this.logger.log(`cancelSubscription ${id}`);
  }
  async pauseSubscription(id: string): Promise<void> {
    this.logger.log(`pauseSubscription ${id}`);
  }
  async resumeSubscription(id: string): Promise<void> {
    this.logger.log(`resumeSubscription ${id}`);
  }

  verifyAndParseWebhook(
    rawBody: Buffer,
    signature: string,
  ): NormalizedWebhookEvent {
    const expected = createHmac('sha512', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
    if (signature !== expected) {
      throw new Error('Invalid webhook signature');
    }
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      type: NormalizedWebhookEvent['type'];
      gatewayTxId: string;
      paymentId?: string;
      sponsorshipId?: string;
      amountCents?: number;
      currency?: string;
    };
    return { ...payload, raw: payload };
  }

  /**
   * Test helper — builds a { body, signature } pair a developer can POST
   * to the webhook endpoint to simulate a gateway callback. Not part of
   * the PaymentGateway contract; used by the stub-webhook dev route.
   */
  buildTestWebhook(event: Omit<NormalizedWebhookEvent, 'raw'>): {
    body: string;
    signature: string;
  } {
    const body = JSON.stringify(event);
    const signature = createHmac('sha512', this.webhookSecret)
      .update(Buffer.from(body))
      .digest('hex');
    return { body, signature };
  }
}
