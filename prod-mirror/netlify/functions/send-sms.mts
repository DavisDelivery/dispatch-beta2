// send-sms.mts
//
// Client-facing endpoint to send SMS via SimpleTexting (the browser can't hold
// the API key). Accepts a single message or a batch (bulk-to-selection).
//
//   POST /.netlify/functions/send-sms
//   Body: { to, text }  OR  { text, recipients: [{ to, label? }] }
//   → { ok, sent, failed, capped, results: [{ to, label, ok, id?, error? }] }
//
// Guardrails (this endpoint sends billable SMS and has no user auth):
//   • SMS_DAILY_CAP (default 500) — a per-ET-day ceiling tracked in Firestore so
//     a bug or abuse can't blast unlimited texts / cost. Overflow is "capped".
//   • Per-request batch limit (200).
// NOTE: there is no app-level auth yet; the cap bounds blast radius. Add real
// auth (Firebase App Check / signed request) before exposing this widely.

import { smsEnabled, sendSms } from './lib/sms.mts';
import { resolveDriverPhone } from './lib/marginiq.mts';
import { recordSmsMessage } from './lib/sms-store.mts';
import { isFirestoreEnabled, getDoc, setDoc, etDayString } from './lib/firestore.mts';

const OPS = 'nuvizz_ops';
const BATCH_LIMIT = 200;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'POST only' }), { status: 405, headers: cors });

  if (!smsEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'SMS not configured (SIMPLETEXTING_API_KEY unset)' }), { status: 503, headers: cors });
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, error: 'invalid JSON' }), { status: 400, headers: cors }); }

  const text = String(body?.text ?? '').trim();
  // Recipients carry a phone (`to`) and/or a `driverName` to resolve server-side
  // from the MarginIQ employee roster (so driver numbers never reach the browser).
  const raw: { to: string; driverName?: string; label?: string }[] = Array.isArray(body?.recipients)
    ? body.recipients.map((r: any) => ({ to: String(r?.to ?? ''), driverName: r?.driverName ? String(r.driverName) : undefined, label: r?.label }))
    : (body?.to || body?.driverName ? [{ to: String(body?.to ?? ''), driverName: body?.driverName, label: body?.label }] : []);

  if (!text) return new Response(JSON.stringify({ ok: false, error: 'text required' }), { status: 400, headers: cors });
  if (!raw.length) return new Response(JSON.stringify({ ok: false, error: 'no recipients' }), { status: 400, headers: cors });
  if (raw.length > BATCH_LIMIT) return new Response(JSON.stringify({ ok: false, error: `too many recipients (max ${BATCH_LIMIT})` }), { status: 400, headers: cors });

  // Resolve driver names → phones; collect unresolved as failures (reported back).
  const unresolved: any[] = [];
  const seen = new Set<string>();
  const recipients: { to: string; label?: string; driverName?: string }[] = [];
  for (const r of raw) {
    let to = r.to;
    const label = r.label || r.driverName;
    if (!to && r.driverName) {
      const resolved = await resolveDriverPhone(r.driverName);
      if (!resolved) { unresolved.push({ to: '', label, ok: false, error: `no phone on file for ${r.driverName}` }); continue; }
      to = resolved;
    }
    if (!to || seen.has(to)) continue;
    seen.add(to);
    recipients.push({ to, label, driverName: r.driverName });
  }
  if (!recipients.length) {
    return new Response(JSON.stringify({ ok: false, error: 'no deliverable recipients', sent: 0, failed: unresolved.length, capped: 0, results: unresolved }), { status: 200, headers: cors });
  }

  // Daily cap (best-effort; skipped if Firestore is off).
  const cap = Number(process.env.SMS_DAILY_CAP) || 500;
  const day = etDayString();
  const capPath = `${OPS}/sms__${day}`;
  let used = 0;
  if (isFirestoreEnabled()) {
    try { const d = (await getDoc(capPath)) as any; used = Number(d?.count) || 0; } catch { /* treat as 0 */ }
  }
  const remaining = Math.max(0, cap - used);

  const results: any[] = [...unresolved];
  let sent = 0, failed = unresolved.length, capped = 0;
  for (const r of recipients) {
    if (sent >= remaining) { capped++; results.push({ to: r.to, label: r.label, ok: false, error: 'daily cap reached' }); continue; }
    const res = await sendSms({ to: r.to, text });
    if (res.ok) {
      sent++; results.push({ to: r.to, label: r.label, ok: true, id: res.id });
      // Record the outbound message so the conversation thread shows both sides.
      await recordSmsMessage({ direction: 'out', contactPhone: r.to, text, driverName: r.driverName || null, label: r.label || null, messageId: res.id || null });
    } else { failed++; results.push({ to: r.to, label: r.label, ok: false, error: res.error }); }
  }

  if (isFirestoreEnabled() && sent > 0) {
    try { await setDoc(capPath, { count: used + sent, day, updated_at: new Date().toISOString() }); } catch { /* best-effort */ }
  }

  return new Response(JSON.stringify({ ok: failed === 0 && capped === 0, sent, failed, capped, cap, results }), { status: 200, headers: cors });
};
