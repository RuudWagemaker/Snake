import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepSnake, GapSchedule, makeZonePlan, zoneAt, SegGrid, checkHit, mulberry32, modsAt } from '../public/shared/sim.js';
import { encodeInput, decodeInput, encodeInputs, decodeInputList, encodeTickBody, writeTickHeader, decodeTick } from '../public/shared/protocol.js';
import { SPEED, DT, GAP_LEN_TICKS, KILLER_ZONE, fieldRadius } from '../public/shared/constants.js';

test('stepSnake moves at constant speed and keeps float32 state', () => {
  const s = { x: 0, y: 0, a: 0 };
  stepSnake(s, 0);
  assert.ok(Math.abs(s.x - SPEED * DT) < 1e-4);
  assert.equal(s.y, 0);
  for (let i = 0; i < 500; i++) stepSnake(s, 1);
  assert.equal(s.x, Math.fround(s.x));
  assert.ok(s.a <= Math.PI && s.a >= -Math.PI);
});

test('gap schedule is deterministic and gaps have the right length', () => {
  const a = new GapSchedule(1234, 3), b = new GapSchedule(1234, 3);
  let run = 0, runs = [];
  for (let t = 1; t < 2000; t++) {
    const g = a.isGap(t);
    assert.equal(g, b.isGap(t));
    if (g) run++; else if (run) { runs.push(run); run = 0; }
  }
  assert.ok(runs.length > 5);
  assert.ok(runs.every((r) => r === GAP_LEN_TICKS));
  // random access (client replays can go backwards) gives the same answer
  const c = new GapSchedule(1234, 3);
  c.isGap(1999);
  for (let t = 1; t < 2000; t++) assert.equal(c.isGap(t), a.isGap(t));
});

test('zone plan shrinks monotonically to zero and nests circles', () => {
  const plan = makeZonePlan(42, fieldRadius(10));
  let prev = Infinity;
  for (let t = 0; t < 30 * 300; t += 15) {
    const z = zoneAt(plan, t);
    assert.ok(z.r <= prev + 1e-9);
    prev = z.r;
  }
  assert.equal(zoneAt(plan, 1e9).r, 0);
  for (const ph of plan.phases) {
    const d = Math.hypot(ph.to.x - ph.from.x, ph.to.y - ph.from.y);
    assert.ok(d + ph.to.r <= ph.from.r + 1e-6, 'next zone must lie inside the current one');
  }
});

test('collision: trails, own neck, zone', () => {
  const g = new SegGrid();
  g.add(-50, 0, 50, 0, 7, 100);
  const zone = { x: 0, y: 0, r: 1000 };
  assert.equal(checkHit(g, zone, 0, 3, 1, 200), 7);
  assert.equal(checkHit(g, zone, 0, 20, 1, 200), null);
  // own fresh segment is ignored, old one is not
  assert.equal(checkHit(g, zone, 0, 2, 7, 102), null);
  assert.equal(checkHit(g, zone, 0, 2, 7, 200), 7);
  assert.equal(checkHit(g, zone, 999, 0, 1, 200), KILLER_ZONE);
});

test('power-up modifiers: timing, targets and stacking', () => {
  const fx = [
    { type: 'speed', start: 10, end: 20, targets: [1] },
    { type: 'fast', start: 15, end: 30, targets: [1, 2] },
    { type: 'fat', start: 10, end: 20, targets: [2] },
    { type: 'fat', start: 10, end: 20, targets: [2] },
    { type: 'fat', start: 10, end: 20, targets: [2] },
    { type: 'reverse', start: 12, end: 14, targets: [2] },
    { type: 'ghost', start: 5, end: 6, targets: [1] },
  ];
  assert.equal(modsAt(fx, 1, 9).speed, 1);
  assert.equal(modsAt(fx, 1, 10).speed, 1.6);
  assert.ok(Math.abs(modsAt(fx, 1, 16).speed - 2.56) < 1e-9); // stacked
  assert.equal(modsAt(fx, 1, 20).speed, 1.6);                // end is exclusive
  assert.equal(modsAt(fx, 2, 11).width, 18);                 // 6*2*2*2 capped
  assert.equal(modsAt(fx, 2, 13).reverse, true);
  assert.equal(modsAt(fx, 2, 14).reverse, false);
  assert.equal(modsAt(fx, 1, 5).ghost, true);
  assert.equal(modsAt(fx, 3, 15).speed, 1);                  // not a target
});

test('collisions respect line width and ghosts', () => {
  const g = new SegGrid();
  g.add(-50, 0, 50, 0, 7, 100, 18);  // a fat line
  const zone = { x: 0, y: 0, r: 1000 };
  assert.equal(checkHit(g, zone, 0, 10, 1, 200), 7);              // fat line reaches further
  assert.equal(checkHit(g, zone, 0, 14, 1, 200), null);
  assert.equal(checkHit(g, zone, 0, 3, 1, 200, 6, true), null);   // ghosts pass through
  assert.equal(checkHit(g, zone, 999, 0, 1, 200, 6, true), -1);   // ...but not through the zone
});

test('binary protocol round trip', () => {
  const inp = decodeInput(new Uint8Array(encodeInput(123456, -1)));
  assert.deepEqual(inp, { tick: 123456, turn: -1 });
  const body = encodeTickBody([{ id: 5, x: 1.5, y: -2.25, a: 0.5, flags: 3, future: [1, 0, -1, -1] }, { id: 9, x: 100, y: 200, a: -1, flags: 0 }]);
  writeTickHeader(body, 777, 780, false);
  const d = decodeTick(body.buffer);
  assert.equal(d.tick, 777);
  assert.equal(d.lastInput, 780);
  assert.equal(d.starved, false);
  assert.deepEqual(d.entries[0], { id: 5, x: 1.5, y: -2.25, a: 0.5, flags: 3, future: [1, 0, -1, -1], width: 6 });
  assert.equal(d.entries[1].future, null);
  assert.equal(d.entries[1].id, 9);
  writeTickHeader(body, 778, 779, true);
  assert.equal(decodeTick(body.buffer).starved, true);
});

test('redundant UDP input packets decode to consecutive ticks', () => {
  const list = decodeInputList(new Uint8Array(encodeInputs(100, [1, 0, -1])));
  assert.deepEqual(list, [{ tick: 98, turn: 1 }, { tick: 99, turn: 0 }, { tick: 100, turn: -1 }]);
  assert.deepEqual(decodeInputList(new Uint8Array(encodeInput(7, 1))), [{ tick: 7, turn: 1 }]);
  assert.equal(decodeInputList(new Uint8Array([3, 0, 0, 0, 1, 5, 0])), null); // length mismatch
});

test('rng is deterministic', () => {
  const a = mulberry32(9), b = mulberry32(9);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});

test('rocket holes: lines are gone from the blast tick on, later lines stay solid', () => {
  const g = new SegGrid();
  // a wall along x = 100, drawn at ticks 1..40
  for (let i = 0; i < 40; i++) g.add(100, i * 5 - 100, 100, i * 5 - 95, 7, i + 1);
  const zone = { x: 0, y: 0, r: 1000 };
  assert.equal(checkHit(g, zone, 100, 0, 1, 100), 7);
  g.blast(100, 0, 30, 50);
  assert.equal(checkHit(g, zone, 100, 0, 1, 49), 7, 'still there before the blast tick');
  assert.equal(checkHit(g, zone, 100, 0, 1, 50), null, 'gone from the blast tick on');
  assert.equal(checkHit(g, zone, 100, 40, 1, 50), 7, 'outside the hole stays');
  g.add(90, 0, 110, 0, 8, 45);   // drawn before the blast tick, inside: cut too
  assert.equal(checkHit(g, zone, 105, 0, 1, 50), null);
  g.add(80, 10, 120, 10, 9, 60); // drawn after the blast: solid
  assert.equal(checkHit(g, zone, 100, 10, 1, 61), 9);
  g.pruneBlasts(70);
  assert.equal(g.blasts.length, 0);
});
