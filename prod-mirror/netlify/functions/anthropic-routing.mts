// netlify/functions/anthropic-routing.mts
//
// Server proxy for the Opus brain (Section 11). Holds ANTHROPIC_API_KEY (functions
// scope, server-only — never shipped to the client) and calls the Anthropic
// Messages API via plain fetch (no SDK dependency). The model string is
// env-configurable (ANTHROPIC_MODEL) with a current-Opus default so it isn't brittle.
//
// Three structured/free-text uses, each ONE call per build (never per-stop in a loop):
//   parseIntentModel  → raw JSON text { strategy, objectiveWeights, extraConstraints }
//   geometryAssistModel → raw JSON text { linearFeetIn, oversize }  (ambiguous stops only)
//   explainModel      → parsed { rationale, riskFlags[] }
// All callers parse defensively (lib/routing-intent.mts) and fall back to
// deterministic behavior on any malformed/absent response. Keys absent → disabled.

import { parseGeometryAssist } from './lib/routing-intent.mts';
import type { Strategy } from './lib/routing-types.mts';
import { fetchWithTimeout } from './lib/async-util.mts';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-8';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_TIMEOUT_MS = 8000;  // hard cap per call — a stalled call aborts and falls back

export function isAnthropicEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
function model(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

// Low-level call. Returns the concatenated text, or throws.
async function callMessages(system: string, user: string, maxTokens = 700): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const resp = await fetchWithTimeout(MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  }, ANTHROPIC_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data: any = await resp.json();
  return (data?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim();
}

const INTENT_SYSTEM =
  'You convert a freight dispatcher\'s plain-English routing intent into a strict JSON object. ' +
  'Return ONLY JSON, no prose. Schema: {"strategy": one of CLOSEST_FIRST|FARTHEST_FIRST|MIN_DISTANCE|MIN_TIME, ' +
  '"objectiveWeights": {"distance": number>=0, "time": number>=0, "balance": number>=0}, ' +
  '"extraConstraints": object }. If unsure, omit a field.';

// Returns raw model text; lib/routing-intent.parseIntentResponse validates it.
export async function parseIntentModel(text: string, chosenStrategy: Strategy): Promise<string | null> {
  try {
    return await callMessages(INTENT_SYSTEM, `Dispatcher chose strategy ${chosenStrategy}. Intent: "${text}"`, 400);
  } catch (e: any) { console.error('parseIntentModel:', e?.message); return null; }
}

const GEOMETRY_SYSTEM =
  'You estimate the physical footprint of an ambiguous freight stop. Return ONLY JSON: ' +
  '{"linearFeetIn": number (the floor LENGTH in inches consumed by long/oversize items, 0 if none), ' +
  '"oversize": boolean}. Base it only on the provided text. No prose.';

export async function geometryAssistModel(stop: any): Promise<string | null> {
  const desc = [
    stop?.businessName && `Customer: ${stop.businessName}`,
    stop?.signalSources?.orderInstructions && `Instructions: ${stop.signalSources.orderInstructions}`,
    stop?.addr2 && `Addr2: ${stop.addr2}`,
    Array.isArray(stop?.stopDetails) && stop.stopDetails.length && `Items: ${stop.stopDetails.map((d: any) => d?.product).filter(Boolean).join('; ')}`,
  ].filter(Boolean).join('\n');
  try { return await callMessages(GEOMETRY_SYSTEM, desc || 'No detail.', 200); }
  catch (e: any) { console.error('geometryAssistModel:', e?.message); return null; }
}

const EXPLAIN_SYSTEM =
  'You are a dispatch routing assistant. Given a built plan, write a concise plain-English rationale ' +
  '(2-4 sentences) and a short list of risk flags (tight fits, tight windows, equipment confirmations). ' +
  'Return ONLY JSON: {"rationale": string, "riskFlags": string[]}. No prose outside the JSON.';

export async function explainModel(plan: any): Promise<{ rationale?: string; riskFlags?: string[] } | null> {
  try {
    const text = await callMessages(EXPLAIN_SYSTEM, JSON.stringify(plan).slice(0, 6000), 700);
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(text.slice(start, end + 1));
    return {
      rationale: typeof obj.rationale === 'string' ? obj.rationale : undefined,
      riskFlags: Array.isArray(obj.riskFlags) ? obj.riskFlags.filter((x: any) => typeof x === 'string') : undefined,
    };
  } catch (e: any) { console.error('explainModel:', e?.message); return null; }
}

// HTTP handler for the client (used mainly so the UI can detect availability).
// action: 'status' | 'parseIntent' | 'explain'. Never returns the key.
export default async function handler(req: Request): Promise<Response> {
  const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method === 'GET') return json({ available: isAnthropicEnabled(), model: isAnthropicEnabled() ? model() : null });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!isAnthropicEnabled()) return json({ available: false });
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  try {
    if (body.action === 'parseIntent') return json({ available: true, raw: await parseIntentModel(String(body.text || ''), body.strategy || 'MIN_DISTANCE') });
    if (body.action === 'explain') return json({ available: true, result: await explainModel(body.plan || {}) });
    if (body.action === 'geometryAssist') return json({ available: true, result: parseGeometryAssist(await geometryAssistModel(body.stop || {})) });
    return json({ error: 'unknown action' }, 400);
  } catch (e: any) { return json({ error: e?.message }, 500); }
}
