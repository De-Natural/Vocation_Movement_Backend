/**
 * Email provider abstraction (PRD §7). Templated transactional emails.
 * The stub logs the email instead of sending — no Resend/SendGrid needed.
 */

export type EmailTemplate =
  | 'welcome'
  | 'email-verify'
  | 'profile-approved'
  | 'profile-rejected'
  | 'info-requested'
  | 'account-suspended'
  | 'payment-received'
  | 'payment-receipt'
  | 'thankyou-received'
  | 'message-reply'
  | 'recurring-success'
  | 'recurring-failed'
  | 'sponsorship-cancelled'
  | 'password-reset'
  | 'new-student-submission'
  | 'contact-inquiry';

export interface SendEmailInput {
  to: string;
  template: EmailTemplate;
  subject: string;
  data: Record<string, unknown>;
}

export interface EmailProvider {
  send(input: SendEmailInput): Promise<void>;
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
