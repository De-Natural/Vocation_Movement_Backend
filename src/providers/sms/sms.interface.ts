/** SMS provider abstraction (phone OTP codes). */
export interface SmsProvider {
  /** `to` is an international number without "+", e.g. 2348012345678. */
  send(to: string, message: string): Promise<void>;
}

export const SMS_PROVIDER = 'SMS_PROVIDER';

/**
 * Normalise a phone number to international digits without "+".
 * Nigerian local numbers (080…, 70…, 81…) become 234…; others must
 * already carry their country code. Returns null when it can't be valid.
 */
export function normalizePhone(raw: string): string | null {
  let d = (raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = `234${d.slice(1)}`; // 0803… → 234803…
  else if (d.length === 10 && /^[789]/.test(d)) d = `234${d}`; // 803… → 234803…
  if (!/^\d{10,15}$/.test(d)) return null;
  if (d.startsWith('234') && d.length !== 13) return null;
  return d;
}

/** "2348031234567" → "+234 803 *** 4567" for showing which number a code went to. */
export function maskPhone(intl: string): string {
  if (intl.length < 8) return intl;
  return `+${intl.slice(0, 3)} ${intl.slice(3, 6)} *** ${intl.slice(-4)}`;
}
