// netlify/functions/ai-search.mts
//
// M6 — AI Order Search. Server proxy for the two natural-language surfaces in the
// dispatch map: the smart search box ("parse" mode) and the chat panel ("chat"
// mode). Holds ANTHROPIC_API_KEY (functions scope, server-only — NEVER shipped to
// the client) and calls the Anthropic Messages API via plain fetch (no SDK).
//
//   mode "parse" → claude-haiku-4-5-20251001, max_tokens 1024.
//       Translates the dispatcher's plain-English query into a STRICT JSON filter
//       spec over the known stop/customer_notes fields. Returns JSON only; the
//       client applies the spec locally over the currently-loaded stops.
//
//   mode "chat"  → claude-sonnet-4-6, max_tokens 1500.
//       Answers the dispatcher's question using ONLY the TrimmedStop[] the client
//       sends (currently-loaded day's stops). Ends its answer with one line
//       "MATCHED_PRO_IDS: <comma-separated stopNbr>" so the client can highlight
//       the referenced stops on the map + list.
//
// All errors are caught and returned as structured JSON ({error}) — never a stack
// trace. The key is never logged and never echoed back to the client.

import { fetchWithTimeout } from './lib/async-util.mts';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const PARSE_MODEL = process.env.ANTHROPIC_PARSE_MODEL || 'claude-haiku-4-5-20251001';
const CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL || 'claude-sonnet-4-6';
// Parse is a tight, cheap call; chat reasons over up to 400 stops, so give it room.
const PARSE_TIMEOUT_MS = 12000;
const CHAT_TIMEOUT_MS = 25000;

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function isEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Low-level Messages call. Returns the concatenated text blocks, or throws.
async function callMessages(model: string, system: string, user: string, maxTokens: number, timeoutMs: number): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ai_key_missing');
  const resp = await fetchWithTimeout(MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  }, timeoutMs);
  if (!resp.ok) {
    // Surface the status but not the key; trim the body so we never leak much.
    throw new Error(`anthropic_${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data: any = await resp.json();
  return (data?.content || [])
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
}

// Strip ```json fences / stray prose and return the JSON substring, or null.
function extractJson(text: string): any | null {
  if (!text) return null;
  let t = text.trim();
  // Remove markdown fences if the model added them despite instructions.
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

const PARSE_SYSTEM = [
  'You convert a freight dispatcher\'s plain-English search into a STRICT JSON filter spec.',
  'Return JSON ONLY — no prose, no markdown fences.',
  '',
  'Schema:',
  '{',
  '  "predicates": [ {"field": <field>, "op": <op>, "value": <string>} ],',
  '  "text_match": <string, free text fuzzy-matched against business name + dock_notes; "" if none>,',
  '  "logic": "AND" | "OR"',
  '}',
  '',
  'Fields:',
  '  closed_days        — op "includes"; value one of Mon,Tue,Wed,Thu,Fri,Sat,Sun',
  '  receiving_open     — op "<=", ">=", "==" ; value "HH:MM" 24h (the open time)',
  '  receiving_close    — op "<=", ">=", "==" ; value "HH:MM" 24h (the close time)',
  '  restrictions       — op "includes"; value one canonical kind:',
  '                       no_tractor_trailer, box_truck_only (alias straight_truck_only),',
  '                       liftgate, appointment_required, no_overhead_clearance,',
  '                       tractor_trailer_friendly (a POSITIVE kind: the stop CAN take a tractor trailer)',
  '  business           — op "includes"; value substring of the customer name',
  '  city               — op "includes"; value city name',
  '  zip5               — op "==" or "includes"; value 5-digit ZIP',
  '  priority_flag      — op "==" ; value red,yellow,green,or any',
  '  dock_notes         — op "includes"; value substring',
  '',
  'Rules:',
  '- Use "logic":"AND" unless the query clearly means OR.',
  '- Map weekday words to the 3-letter value (Friday->Fri).',
  '- "before 9am" on opening hours -> receiving_open "<=" "09:00". "after 3pm" on closing -> receiving_close ">=" "15:00".',
  '- "liftgate" -> restrictions includes liftgate. "no tractor trailer"/"no semi" -> restrictions includes no_tractor_trailer.',
  '- "straight truck only"/"box truck only" -> restrictions includes box_truck_only.',
  '- "appointment"/"by appointment" -> restrictions includes appointment_required.',
  '- Put genuinely free-form text (a customer name fragment, a phrase) in text_match.',
  '- If you cannot extract any structured predicate, return an empty predicates array and put the words in text_match.',
].join('\n');

const CHAT_SYSTEM = [
  'You are a dispatch assistant for a freight delivery board. Answer the dispatcher\'s',
  'question using ONLY the stops provided in the user message (JSON array of stops for',
  'the currently-loaded day). Each stop has: pro (the stopNbr id), business, address,',
  'city, zip5, hours_summary, closed_days, restrictions, dock_notes, appointment_notes,',
  'instructions (raw NuVizz order-instruction text), priority_flag.',
  '',
  'IMPORTANT about receiving / delivery hours: hours_summary holds STRUCTURED hours, but',
  'many stops record hours only as FREE TEXT inside dock_notes, appointment_notes, or the',
  'raw instructions field — in arbitrary phrasing such as "RH 7-11AM", "RECEIVING HOURS',
  '8AM-12PM", "deliver before noon", "appt M-F 7am-2pm" (RH = receiving hours). When the',
  'question is about hours, scan hours_summary AND dock_notes AND appointment_notes AND',
  'instructions, and report a stop if hours appear in ANY of them.',
  'Show all clock times in 12-hour AM/PM format (e.g. 8:00 AM, 3:00 PM); keep hours_summary',
  'values as given (already AM/PM) and convert any 24-hour times you find in free text.',
  '',
  'Be concise and practical — a dispatcher is reading this on a phone between calls.',
  'Do not invent stops or facts not present in the data. If nothing matches, say so.',
  '',
  'FORMATTING (important, keep it skimmable):',
  '- Open with one short sentence summarizing the result (e.g. "5 stops close before 2 PM:").',
  '- Then ONE bullet per stop, each starting with "- ". Do NOT use markdown tables.',
  '- Bullet format: "- PRO <pro> — <BUSINESS> (<City>): <the key detail>". Put the PRO',
  '  number early in each bullet and verbatim (preserve leading zeros).',
  '- Keep each bullet to one line. Use **bold** only for the business name. No headers.',
  '- All clock times in 12-hour AM/PM.',
  '',
  'At the very END output exactly one final line:',
  'MATCHED_PRO_IDS: <comma-separated pro values for every stop you referenced>',
  '(If none, output "MATCHED_PRO_IDS:" with nothing after.) The PROs also appear in your',
  'bullets, so the board can still highlight them even if this line is cut off.',
].join('\n');

async function handleParse(query: string): Promise<Response> {
  try {
    const text = await callMessages(PARSE_MODEL, PARSE_SYSTEM, `Query: ${query}`, 1024, PARSE_TIMEOUT_MS);
    const spec = extractJson(text);
    if (!spec || !Array.isArray(spec.predicates)) {
      // Defensive: hand back an empty-but-valid spec so the client can fall back
      // to literal keyword search without treating this as a hard error.
      return json({ spec: { predicates: [], text_match: query, logic: 'AND' }, fallback: true });
    }
    return json({
      spec: {
        predicates: spec.predicates,
        text_match: typeof spec.text_match === 'string' ? spec.text_match : '',
        logic: spec.logic === 'OR' ? 'OR' : 'AND',
      },
    });
  } catch (e: any) {
    const msg = e?.message || 'ai_error';
    return json({ error: msg === 'ai_key_missing' ? 'ai_key_missing' : msg }, msg === 'ai_key_missing' ? 500 : 502);
  }
}

async function handleChat(query: string, context: any[]): Promise<Response> {
  try {
    const stops = Array.isArray(context) ? context : [];
    const user = `Dispatcher question: ${query}\n\nStops (JSON):\n${JSON.stringify(stops).slice(0, 120000)}`;
    const text = await callMessages(CHAT_MODEL, CHAT_SYSTEM, user, 1500, CHAT_TIMEOUT_MS);
    // Split the trailing MATCHED_PRO_IDS line from the prose answer.
    const m = text.match(/MATCHED_PRO_IDS:\s*([^\n]*)\s*$/i);
    let matchedProIds: string[] = [];
    let answer = text;
    if (m) {
      matchedProIds = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      answer = text.slice(0, m.index).trim();
    }
    return json({ answer, matchedProIds });
  } catch (e: any) {
    const msg = e?.message || 'ai_error';
    return json({ error: msg === 'ai_key_missing' ? 'ai_key_missing' : msg }, msg === 'ai_key_missing' ? 500 : 502);
  }
}

export default async function handler(req: Request): Promise<Response> {
  // GET → availability probe (lets the client hide the AI affordance gracefully).
  if (req.method === 'GET') return json({ available: isEnabled() });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!isEnabled()) return json({ error: 'ai_key_missing' }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const query = String(body?.query || '').trim();
  if (!query) return json({ error: 'empty_query' }, 400);

  if (body?.mode === 'parse') return handleParse(query);
  if (body?.mode === 'chat') return handleChat(query, body?.context || []);
  return json({ error: 'unknown_mode' }, 400);
}
