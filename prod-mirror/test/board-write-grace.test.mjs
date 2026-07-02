// test/board-write-grace.test.mjs — board write-through (#361).
//
// After a CONFIRMED live Save, patchBoardPlan stamps the day's cache docs with the verified
// plan (board_write_at). applyBoardWriteGrace is the scan-side half: it holds that confirmed
// write over a DISAGREEING fresh list row (NuVizz's list lags async imports by minutes) and
// releases the moment the list agrees or the grace expires.
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyBoardWriteGrace, BOARD_WRITE_GRACE_MIN } from '../netlify/functions/lib/nuvizz-list.mts';
import { boardWritePlannedFields, boardWriteUnplannedFields } from '../netlify/functions/lib/firestore.mts';

const NOW = Date.parse('2026-07-02T12:00:00Z');
const mins = (n) => new Date(NOW - n * 60_000).toISOString();

// A fresh list row (what the scan just read) and a prior cache doc (what a Save confirmed).
const freshUnplanned = () => ({ stopNbr: '007141834', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null, routeSeq: null, driverName: null });
const freshPlannedOn = (name, seq = 1) => ({ stopNbr: '007141834', status: '20', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false, loadNbr: name, routeName: name, routeSeq: seq, driverName: null });
const priorWrite = (fields, agoMin) => ({ stopNbr: '007141834', ...fields, board_write_at: mins(agoMin) });

test('planned write HOLDS over a lagging unplanned list row within the grace window', () => {
  const fresh = freshUnplanned();
  const prior = priorWrite(boardWritePlannedFields('SUW 2', 3, null, mins(5)), 5);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), true);
  assert.equal(fresh.isPlanned, true);
  assert.equal(fresh.loadNbr, 'SUW 2');
  assert.equal(fresh.routeSeq, 3);
  assert.equal(fresh.normalizedStatus, 'SCHEDULED');
  assert.ok(fresh.board_write_at);   // stamp carried → keeps holding on the next scan too
});

test('unplanned write (omission-unplan) HOLDS over a list row still showing the OLD load', () => {
  const fresh = freshPlannedOn('SUW 2', 4);
  const prior = priorWrite(boardWriteUnplannedFields(mins(3)), 3);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), true);
  assert.equal(fresh.isPlanned, false);
  assert.equal(fresh.loadNbr, null);
  assert.equal(fresh.normalizedStatus, 'UNPLANNED');
});

test('cross-load move HOLDS: both planned but the list still shows the OLD load', () => {
  const fresh = freshPlannedOn('SUW 2', 2);           // list lagging: still on the old load
  const prior = priorWrite(boardWritePlannedFields('SUW 5', 1, null, mins(2)), 2);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), true);
  assert.equal(fresh.loadNbr, 'SUW 5');
});

test('RELEASES when the list agrees (no disagreement → stamp not carried; list authoritative)', () => {
  const fresh = freshPlannedOn('SUW 2', 7);           // list caught up (its own seq wins)
  const prior = priorWrite(boardWritePlannedFields('SUW 2', 3, null, mins(5)), 5);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), false);
  assert.equal(fresh.routeSeq, 7);                    // untouched — the list's fresher seq stands
  assert.equal(fresh.board_write_at, undefined);      // stamp dropped
});

test('RELEASES after the grace expires — the list wins again even if it still disagrees', () => {
  const fresh = freshUnplanned();
  const prior = priorWrite(boardWritePlannedFields('SUW 2', 3, null, mins(BOARD_WRITE_GRACE_MIN + 1)), BOARD_WRITE_GRACE_MIN + 1);
  assert.equal(applyBoardWriteGrace(fresh, prior, NOW), false);
  assert.equal(fresh.isPlanned, false);
});

test('no stamp on the prior doc → never interferes', () => {
  const fresh = freshUnplanned();
  assert.equal(applyBoardWriteGrace(fresh, { stopNbr: '007141834', isPlanned: true, loadNbr: 'SUW 2' }, NOW), false);
  assert.equal(fresh.isPlanned, false);
});

test('field builders mirror the board shapes exactly (loadNbr = route NAME; 20/SCHEDULED, 10/UNPLANNED)', () => {
  const p = boardWritePlannedFields('SUW 2', 5, 'Ben Paintsil', '2026-07-02T11:20:00Z');
  assert.equal(p.status, '20');
  assert.equal(p.normalizedStatus, 'SCHEDULED');
  assert.equal(p.loadNbr, 'SUW 2');       // the board's loadNbr IS the route name (list feed shape)
  assert.equal(p.routeName, 'SUW 2');
  assert.equal(p.routeSeq, 5);
  assert.equal(p.driverName, 'Ben Paintsil');
  assert.equal(p.board_write_planned, true);
  const u = boardWriteUnplannedFields('2026-07-02T11:20:00Z');
  assert.equal(u.status, '10');
  assert.equal(u.isUnplanned, true);
  assert.equal(u.loadNbr, null);
  assert.equal(u.board_write_planned, false);
});
