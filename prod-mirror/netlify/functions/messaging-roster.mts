// messaging-roster.mts
//
// Read-only contact roster for the Messages window's "New message" picker. Returns
// the messageable people from the MarginIQ `employees` collection — drivers,
// contractors (owner-operators / carriers) and office team — each with a name,
// 10-digit phone and a `group` so the UI can show them in labeled sections.
//
//   GET /.netlify/functions/messaging-roster
//   → { ok, generated, count, contacts: [{ id, name, phone, role, group }] }
//
// The browser needs the phone↔name mapping to (a) start a new conversation by
// tapping a contact and (b) label inbound replies (which arrive keyed only by
// phone) with the right name. Customer contacts come from customer_notes on the
// client; this endpoint covers the employee side.
//
// NOTE: like send-sms, there is no app-level auth yet — the roster is only as
// private as the app URL. Lock this behind real auth (Firebase App Check / signed
// request) before exposing the app widely.

import { listEmployees } from './lib/marginiq.mts';
import { isFirestoreEnabled } from './lib/firestore.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  if (!isFirestoreEnabled()) {
    // Degrade gracefully: the client still has customer contacts + existing threads.
    return new Response(JSON.stringify({ ok: true, count: 0, contacts: [], note: 'firestore off' }), { status: 200, headers: cors });
  }

  try {
    const contacts = await listEmployees();
    return new Response(JSON.stringify({ ok: true, generated: new Date().toISOString(), count: contacts.length, contacts }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || 'roster failed', contacts: [] }), { status: 200, headers: cors });
  }
};
