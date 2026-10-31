import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepSnake, GapSchedule, makeZonePlan, zoneAt, SegGrid, checkHit, mulberry32 } from '../public/shared/sim.js';
import { encodeInput, decodeInput, encodeTickBody, writeTickHeader, decodeTick } from '../public/shared/protocol.js';
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

test('binary protocol round trip', () => {
  const inp = decodeInput(new Uint8Array(encodeInput(123456, -1)));
  assert.deepEqual(inp, { seq: 123456, turn: -1 });
  const body = encodeTickBody([{ id: 5, x: 1.5, y: -2.25, a: 0.5, flags: 3 }, { id: 9, x: 100, y: 200, a: -1, flags: 0 }]);
  writeTickHeader(body, 777, 555, 2);
  const d = decodeTick(body.buffer);
  assert.equal(d.tick, 777);
  assert.equal(d.ack, 555);
  assert.equal(d.buffered, 2);
  assert.deepEqual(d.entries[0], { id: 5, x: 1.5, y: -2.25, a: 0.5, flags: 3 });
  assert.equal(d.entries[1].id, 9);
});

test('rng is deterministic', () => {
  const a = mulberry32(9), b = mulberry32(9);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});
