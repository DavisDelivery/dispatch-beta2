// lib/sms.mts
//
// SimpleTexting API v2 client for sending SMS. The browser can't hold the API
// key, so the client posts to the send-sms function which calls this.
//
//   POST https://api-app2.simpletexting.com/v2/api/messages
//   Auth: Authorization: Bearer <SIMPLETEXTING_API_KEY>
//   Body (required): { contactPhone, mode, text }
//     mode: AUTO | SINGLE_SMS_STRICTLY | MMS_PREFERRED
//     accountPhone (optional): the sending number; blank ⇒ account's primary.
//
// Env:
//   SIMPLETEXTING_API_KEY  — required; absent ⇒ smsEnabled() false (no-op).
//   SIMPLETEXTING_FROM     — optional accountPhone to send from.

const ST_BASE = process.env.SIMPLETEXTING_BASE_URL || 'https://api-app2.simpletexting.com/v2';

export function smsEnabled(): boolean {
  return !!process.env.SIMPLETEXTING_API_KEY;
}

// US 10-digit normalization: strip non-digits; drop a leading country-code 1.
// SimpleTexting's examples use bare 10-digit numbers (e.g. "1234567890").
export function normalizePhone(raw: any): string {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d;
}

export function validUsPhone(p: string): boolean {
  return /^\d{10}$/.test(p);
}

export interface SendSmsArgs {
  to: string;          // raw or normalized phone
  text: string;
  accountPhone?: string;
}

// Sends one SMS. Best-effort: returns {ok} and never throws.
export async function sendSms(args: SendSmsArgs): Promise<{ ok: boolean; id?: string; error?: string }> {
  const key = process.env.SIMPLETEXTING_API_KEY;
  if (!key) return { ok: false, error: 'SIMPLETEXTING_API_KEY not set' };
  const contactPhone = normalizePhone(args.to);
  if (!validUsPhone(contactPhone)) return { ok: false, error: `invalid phone: ${args.to}` };
  const text = String(args.text ?? '').trim();
  if (!text) return { ok: false, error: 'empty text' };
  const accountPhone = args.accountPhone || process.env.SIMPLETEXTING_FROM || undefined;
  try {
    const resp = await fetch(`${ST_BASE}/api/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ contactPhone, mode: 'AUTO', text, ...(accountPhone ? { accountPhone } : {}) }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `SimpleTexting HTTP ${resp.status} ${body.slice(0, 200)}` };
    }
    const data: any = await resp.json().catch(() => ({}));
    return { ok: true, id: data?.id || data?.messageId };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'send failed' };
  }
}
