// test/routing-intent.test.mjs — defensive parsing of model output with fallback.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseIntentResponse, parseGeometryAssist, coerceStrategy,
} from '../netlify/functions/lib/routing-intent.mts';

test('valid JSON intent parses; model strategy wins', () => {
  const p = parseIntentResponse('{"strategy":"MIN_TIME","objectiveWeights":{"distance":2,"time":1,"balance":0}}', 'MIN_DISTANCE');
  assert.equal(p.strategy, 'MIN_TIME');
  assert.deepEqual(p.objectiveWeights, { distance: 2, time: 1, balance: 0 });
  assert.equal(p.source, 'model');
});

test('JSON wrapped in prose / code fences is still extracted', () => {
  const raw = 'Sure! Here you go:\n```json\n{"strategy":"FARTHEST_FIRST"}\n```\nHope that helps.';
  const p = parseIntentResponse(raw, 'MIN_DISTANCE');
  assert.equal(p.strategy, 'FARTHEST_FIRST');
});

test('malformed JSON falls back to the dispatcher-chosen strategy + defaults', () => {
  const p = parseIntentResponse('{not valid json', 'CLOSEST_FIRST');
  assert.equal(p.strategy, 'CLOSEST_FIRST');
  assert.deepEqual(p.objectiveWeights, { distance: 1, time: 1, balance: 0.5 });
  assert.equal(p.source, 'fallback');
});

test('null / empty response → fallback', () => {
  assert.equal(parseIntentResponse(null, 'MIN_TIME').strategy, 'MIN_TIME');
  assert.equal(parseIntentResponse('   ', 'MIN_TIME').source, 'fallback');
});

test('invalid strategy in otherwise-valid JSON falls back to chosen', () => {
  const p = parseIntentResponse('{"strategy":"TELEPORT"}', 'MIN_DISTANCE');
  assert.equal(p.strategy, 'MIN_DISTANCE');
  assert.equal(p.source, 'model');
});

test('coerceStrategy validates against the enum', () => {
  assert.equal(coerceStrategy('min_time'), 'MIN_TIME');
  assert.equal(coerceStrategy('garbage'), 'MIN_DISTANCE');
  assert.equal(coerceStrategy(undefined, 'CLOSEST_FIRST'), 'CLOSEST_FIRST');
});

test('parseGeometryAssist: valid, malformed, partial', () => {
  assert.deepEqual(parseGeometryAssist('{"linearFeetIn":120,"oversize":true}'), { linearFeetIn: 120, oversize: true });
  assert.equal(parseGeometryAssist('nope'), null);
  assert.deepEqual(parseGeometryAssist('{"oversize":false}'), { oversize: false });
  assert.equal(parseGeometryAssist('{"linearFeetIn":-5}'), null); // negative rejected, nothing else → null
});
