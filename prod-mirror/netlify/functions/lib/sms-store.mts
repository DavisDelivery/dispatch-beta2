// lib/sms-store.mts
//
// One place to persist SMS messages (both directions) into Firestore `sms_messages`
// so the app can show two-way conversation threads. Inbound is written by the
// SimpleTexting webhook; outbound by send-sms after a successful send.
//
// Doc shape: { direction:'in'|'out', contactPhone (the OTHER party, normalized),
//   accountPhone, text, driverName?, label?, messageId?, at (ISO, used for ordering) }.

import { setDoc } from './firestore.mts';
import { normalizePhone } from './sms.mts';

const COLLECTION = 'sms_messages';

export async function recordSmsMessage(m: {
  direction: 'in' | 'out';
  contactPhone: any;
  accountPhone?: any;
  text?: string;
  driverName?: string | null;
  label?: string | null;
  messageId?: string | null;
  at?: string;
}): Promise<void> {
  const contactPhone = normalizePhone(m.contactPhone);
  const at = m.at || new Date().toISOString();
  // Stable id: prefer the vendor messageId; else direction+phone+time so a retry
  // of the same inbound webhook de-dupes but distinct sends don't collide.
  const id = String(m.messageId || `${m.direction}_${contactPhone}_${Date.parse(at) || Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  try {
    await setDoc(`${COLLECTION}/${id}`, {
      direction: m.direction,
      contactPhone: contactPhone || null,
      accountPhone: normalizePhone(m.accountPhone) || null,
      text: m.text || '',
      driverName: m.driverName || null,
      label: m.label || null,
      messageId: m.messageId || null,
      at,
    });
  } catch (e: any) { console.warn(`[sms-store] record failed: ${e?.message}`); }
}
