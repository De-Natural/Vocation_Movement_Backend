/**
 * Payment gateway abstraction (PRD §3.5, §4). Two gateways in production:
 *   STRIPE   → international cards (USD/EUR/GBP), subscriptions
 *   PAYSTACK → African payments (NGN/GHS/KES/ZAR)
 *
 * The stub simulates the full flow — create-intent returns a fake
 * client_secret, and a helper builds a signed-looking webhook event so
 * the confirm path can be exercised end-to-end with no real gateway.
 */
import { Gateway } from '@prisma/client';

export interface CreateIntentInput {
  amountCents: number;
  currency: string;
  /** Our internal payment id, echoed back on the webhook for correlation. */
  paymentId: string;
  sponsorEmail: string;
  metadata?: Record<string, string>;
}

export interface CreateIntentResult {
  gateway: Gateway;
  /** Opaque id of the gateway-side charge/intent. */
  gatewayTxId: string;
  /** Client secret / access code the frontend needs to collect the card. */
  clientSecret: string;
}

export interface CreateSubscriptionInput {
  amountCents: number;
  currency: string;
  sponsorshipId: string;
  sponsorEmail: string;
  metadata?: Record<string, string>;
}

export interface CreateSubscriptionResult {
  gateway: Gateway;
  gatewaySubId: string;
  clientSecret: string;
}

/** Normalised webhook event after signature verification. */
export interface NormalizedWebhookEvent {
  type: 'payment.succeeded' | 'payment.failed' | 'subscription.charged' | 'unknown';
  gatewayTxId: string;
  paymentId?: string; // from metadata
  sponsorshipId?: string;
  amountCents?: number;
  currency?: string;
  raw: unknown;
}

export interface PaymentGateway {
  readonly name: Gateway;
  createIntent(input: CreateIntentInput): Promise<CreateIntentResult>;
  createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<CreateSubscriptionResult>;
  cancelSubscription(gatewaySubId: string): Promise<void>;
  pauseSubscription(gatewaySubId: string): Promise<void>;
  resumeSubscription(gatewaySubId: string): Promise<void>;
  /**
   * Verify the webhook signature and normalise the event. Throws if the
   * signature is invalid (PRD §5.2 webhook verification).
   */
  verifyAndParseWebhook(
    rawBody: Buffer,
    signature: string,
  ): NormalizedWebhookEvent;
}

export const STRIPE_GATEWAY = 'STRIPE_GATEWAY';
export const PAYSTACK_GATEWAY = 'PAYSTACK_GATEWAY';
