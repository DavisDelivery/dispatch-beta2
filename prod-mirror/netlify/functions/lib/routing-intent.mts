// lib/routing-intent.mts
//
// PURE parsing/validation for the Opus "parseIntent" output and the objective
// controls. The model call lives in netlify/functions/anthropic-routing.mts; this
// module turns whatever it returns (or nothing) into a validated, defaulted
// { strategy, objectiveWeights, extraConstraints }. ANY malformed/absent response
// degrades to the dispatcher's chosen strategy + defaults — never throws.

import {
  STRATEGIES, DEFAULT_STRATEGY, DEFAULT_OBJECTIVE_WEIGHTS,
  type Strategy, type ObjectiveWeights,
} from './routing-types.mts';

export interface ParsedIntent {
  strategy: Strategy;
  objectiveWeights: ObjectiveWeights;
  extraConstraints: Record<string, unknown>;
  source: 'model' | 'fallback';
}

export function coerceStrategy(v: unknown, fallback: Strategy = DEFAULT_STRATEGY): Strategy {
  const s = String(v ?? '').toUpperCase().trim();
  return (STRATEGIES as string[]).includes(s) ? (s as Strategy) : fallback;
}

function coerceWeights(v: any): ObjectiveWeights {
  const w = v && typeof v === 'object' ? v : {};
  const num = (x: any, d: number) => {
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    distance: num(w.distance, DEFAULT_OBJECTIVE_WEIGHTS.distance),
    time: num(w.time, DEFAULT_OBJECTIVE_WEIGHTS.time),
    balance: num(w.balance, DEFAULT_OBJECTIVE_WEIGHTS.balance),
  };
}

// Parse a model response (string JSON or already-parsed object) into a ParsedIntent.
// `chosenStrategy` is the dispatcher's dropdown selection — the fallback floor.
export function parseIntentResponse(raw: unknown, chosenStrategy?: Strategy): ParsedIntent {
  const fallback: ParsedIntent = {
    strategy: coerceStrategy(chosenStrategy),
    objectiveWeights: { ...DEFAULT_OBJECTIVE_WEIGHTS },
    extraConstraints: {},
    source: 'fallback',
  };
  if (raw == null) return fallback;

  let obj: any = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return fallback;
    // Tolerate prose around the JSON or ```json fences — extract the first object.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return fallback;
    try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return fallback; }
  }
  if (!obj || typeof obj !== 'object') return fallback;

  return {
    // model strategy wins if valid; else dispatcher's choice; else default.
    strategy: coerceStrategy(obj.strategy, coerceStrategy(chosenStrategy)),
    objectiveWeights: coerceWeights(obj.objectiveWeights),
    extraConstraints: (obj.extraConstraints && typeof obj.extraConstraints === 'object') ? obj.extraConstraints : {},
    source: 'model',
  };
}

// Parse a geometry-assist model response → { linearFeetIn?, oversize? } or null.
export function parseGeometryAssist(raw: unknown): { linearFeetIn?: number; oversize?: boolean } | null {
  if (raw == null) return null;
  let obj: any = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const out: { linearFeetIn?: number; oversize?: boolean } = {};
  const n = Number(obj.linearFeetIn);
  if (Number.isFinite(n) && n >= 0) out.linearFeetIn = n;
  if (typeof obj.oversize === 'boolean') out.oversize = obj.oversize;
  return Object.keys(out).length ? out : null;
}
