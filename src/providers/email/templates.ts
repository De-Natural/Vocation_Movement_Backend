import { EmailTemplate, SendEmailInput } from './email.interface';

/**
 * Turns a templated email (template name + data) into subject/HTML/text.
 * One plain, mobile-friendly layout for every email; each template only
 * decides its lines and an optional button.
 */
interface Rendered {
  subject: string;
  html: string;
  text: string;
}

interface Body {
  greeting?: string;
  lines: string[];
  /** A large code shown on its own (OTP emails). */
  code?: string;
  cta?: { label: string; url: string };
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

function bodyFor(template: EmailTemplate, d: Record<string, unknown>): Body {
  const hi = d.name ? `Dear ${str(d.name)},` : 'Hello,';
  const link = typeof d.link === 'string' ? d.link : undefined;
  const front = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const dashboard = link ?? `${front}/dashboard/student`;
  switch (template) {
    case 'email-otp':
      return {
        greeting: hi,
        lines: [
          'Use this code to verify your email address:',
          `It expires in ${str(d.expiresInMinutes || 10)} minutes. If you did not create an account, you can ignore this email.`,
        ],
        code: str(d.code),
      };
    case 'email-verify':
      return {
        greeting: hi,
        lines: ['Please confirm your email address to finish setting up your account.'],
        cta: link ? { label: 'Verify my email', url: link } : undefined,
      };
    case 'password-reset':
      return {
        greeting: hi,
        lines: [
          'We received a request to reset your password.',
          `This link expires in ${str(d.expiresInMinutes || 60)} minutes. If you did not ask for it, you can ignore this email.`,
        ],
        cta: link ? { label: 'Reset my password', url: link } : undefined,
      };
    case 'profile-approved':
      return {
        greeting: hi,
        lines: [
          'Good news: your profile has been verified and approved by the administrator.',
          'Your profile is now visible to sponsors, and you can start receiving support for your bills.',
        ],
        cta: { label: 'Go to my dashboard', url: dashboard },
      };
    case 'profile-rejected':
      return {
        greeting: hi,
        lines: [
          'After review, your profile could not be approved at this time.',
          d.reason ? `Reason: ${str(d.reason)}` : '',
          'You may update your profile and documents, then submit again.',
        ],
        cta: { label: 'Update my profile', url: dashboard },
      };
    case 'info-requested':
      return {
        greeting: hi,
        lines: [
          'The administrator needs a little more information before approving your profile.',
          d.reason ? `Request: ${str(d.reason)}` : '',
        ],
        cta: { label: 'Update my profile', url: dashboard },
      };
    case 'new-student-submission':
      return {
        greeting: 'Hello,',
        lines: [
          `${str(d.studentName) || 'A new student'} has submitted a profile that is waiting for your approval.`,
          'Please review their details and documents.',
        ],
        cta: link ? { label: 'Review verifications', url: link } : undefined,
      };
    case 'withdrawal-paid':
      return {
        greeting: hi,
        lines: [
          `Your withdrawal of ${str(d.amount)} has been sent to ${str(d.bank)} (${str(d.account)}).`,
          'It may take a few minutes to reflect, depending on your bank.',
          `Reference: ${str(d.reference)}`,
        ],
      };
    case 'withdrawal-failed':
      return {
        greeting: hi,
        lines: [
          `Your withdrawal of ${str(d.amount)} could not be completed, and the money is back in your available balance.`,
          d.reason ? `Reason: ${str(d.reason)}` : '',
          `Reference: ${str(d.reference)}`,
        ],
      };
    case 'payment-receipt':
      return {
        greeting: hi,
        lines: [
          `Thank you for your gift of ${str(d.amount)} to ${str(d.studentName)}${d.billName ? ` toward ${str(d.billName)}` : ''}.`,
          `Transaction ID: ${str(d.transactionId)}`,
          d.date ? `Date: ${new Date(str(d.date)).toUTCString()}` : '',
          'Please keep this email as your receipt.',
          d.guest
            ? 'Want to follow their progress and keep all your receipts in one place? Create a free sponsor account with this email address.'
            : '',
        ],
        cta: d.guest
          ? { label: 'Create a sponsor account', url: `${front}/register?role=sponsor` }
          : { label: 'View my giving', url: `${front}/dashboard/sponsor` },
      };
    case 'maintenance-notice':
      return {
        greeting: hi,
        lines: [
          str(d.message) || 'Vocation Movement is undergoing scheduled maintenance.',
          'You have been signed out while we work. Your gifts, profile and messages are safe.',
          'Once the site is back, please sign in again.',
        ],
        cta: { label: 'Visit Vocation Movement', url: front },
      };
    case 'account-suspended':
      return {
        greeting: 'Hello,',
        lines: ['Your account has been suspended.', d.reason ? `Reason: ${str(d.reason)}` : ''],
      };
    default: {
      // Generic fallback: readable key/value lines.
      const lines = Object.entries(d)
        .filter(([k, v]) => k !== 'link' && v !== undefined && v !== null && typeof v !== 'object')
        .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}: ${str(v)}`);
      return { greeting: hi, lines, cta: link ? { label: 'Open', url: link } : undefined };
    }
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderEmail(input: SendEmailInput): Rendered {
  const b = bodyFor(input.template, input.data ?? {});
  const lines = b.lines.filter(Boolean);

  const html = `<!doctype html><html><body style="margin:0;background:#f6f1e7;font-family:Arial,Helvetica,sans-serif;color:#1d2a44">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td style="font-size:20px;font-weight:bold;color:#b8862f;padding-bottom:16px">Vocation Movement</td></tr>
<tr><td style="font-size:18px;font-weight:bold;padding-bottom:12px">${esc(input.subject)}</td></tr>
${b.greeting ? `<tr><td style="font-size:15px;padding-bottom:12px">${esc(b.greeting)}</td></tr>` : ''}
${lines
  .slice(0, b.code ? 1 : lines.length)
  .map((l) => `<tr><td style="font-size:15px;line-height:1.5;padding-bottom:10px">${esc(l)}</td></tr>`)
  .join('')}
${b.code ? `<tr><td style="font-size:32px;font-weight:bold;letter-spacing:8px;padding:12px 0 16px">${esc(b.code)}</td></tr>` : ''}
${b.code ? lines.slice(1).map((l) => `<tr><td style="font-size:14px;color:#5b6475;padding-bottom:10px">${esc(l)}</td></tr>`).join('') : ''}
${b.cta ? `<tr><td style="padding:12px 0 4px"><a href="${esc(b.cta.url)}" style="display:inline-block;background:#b8862f;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px">${esc(b.cta.label)}</a></td></tr>` : ''}
<tr><td style="font-size:12px;color:#8a8f99;padding-top:24px">This is an automated message from Vocation Movement.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    input.subject,
    '',
    b.greeting ?? '',
    ...lines.slice(0, b.code ? 1 : lines.length),
    b.code ? `\n    ${b.code}\n` : '',
    ...(b.code ? lines.slice(1) : []),
    b.cta ? `${b.cta.label}: ${b.cta.url}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return { subject: input.subject, html, text };
}
