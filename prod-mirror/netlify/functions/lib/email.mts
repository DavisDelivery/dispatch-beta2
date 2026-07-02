// lib/email.mts
//
// Minimal transactional-email sender via Resend (https://resend.com). Used by the
// scan to alert customer service when an opted-in ("notify CS") customer first
// appears on a day's board.
//
// Env:
//   RESEND_API_KEY  — Resend API key (required; absent ⇒ emailEnabled() false).
//   RESEND_FROM     — verified sender, e.g. "Davis Dispatch <no-reply@davisdelivery.com>".
//                     Must be on a domain verified in the Resend account.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function emailEnabled(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM;
}

export interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
}

// Sends one email. Best-effort: returns {ok} and never throws, so a mail failure
// can never break a scan. Caller decides whether to record dedup state on ok.
export async function sendEmail(args: SendEmailArgs): Promise<{ ok: boolean; id?: string; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) return { ok: false, error: 'RESEND_API_KEY/RESEND_FROM not set' };
  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: Array.isArray(args.to) ? args.to : [args.to],
        subject: args.subject,
        ...(args.html ? { html: args.html } : {}),
        ...(args.text ? { text: args.text } : {}),
        ...(args.replyTo ? { reply_to: args.replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `Resend HTTP ${resp.status} ${body.slice(0, 200)}` };
    }
    const data: any = await resp.json().catch(() => ({}));
    return { ok: true, id: data?.id };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'send failed' };
  }
}
