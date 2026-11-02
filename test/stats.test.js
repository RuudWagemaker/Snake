import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Stats, matchPoints, levelFor, periodKeys } from '../server/stats.js';
import { cleanName } from '../server/names.js';
import { Room } from '../server/room.js';
import { InputBuffer } from '../server/inputs.js';
import { startServer } from '../server/index.js';
import { TICK_RATE } from '../public/shared/constants.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32);

test('match points and levels', () => {
  assert.equal(matchPoints(1, 10, 2), 9 + 6 + 5);
  assert.equal(matchPoints(10, 10, 0), 0);
  assert.equal(levelFor(0), 1);
  assert.equal(levelFor(24), 1);
  assert.equal(levelFor(25), 2);
  assert.equal(levelFor(100), 3);
});

test('day and week keys use Amsterdam time, weeks start on Monday', () => {
  // Sunday 2026-11-01 23:30 UTC is already Monday 00:30 in Amsterdam
  const k = periodKeys(Date.parse('2026-11-01T23:30:00Z'));
  assert.equal(k.day, '2026-11-02');
  assert.equal(k.week, 'w2026-11-02');
  assert.equal(periodKeys(Date.parse('2026-11-08T12:00:00Z')).week, 'w2026-11-02');
});

test('leaderboards per period, without leaking tokens', () => {
  const s = new Stats();
  const day1 = Date.parse('2026-11-02T12:00:00Z'), day2 = Date.parse('2026-11-03T12:00:00Z');
  s.record(A, 'Ann', 1, 10, 3, day1);   // 23 points
  s.record(B, 'Bob', 2, 10, 0, day1);   // 8 points
  s.record(B, 'Bob', 1, 10, 0, day2);   // 14 points
  const today = s.leaderboard('day', B, day2);
  assert.deepEqual(today.top.map((e) => e.name), ['Bob']);
  assert.equal(today.me.rank, 1);
  const week = s.leaderboard('week', B, day2);
  assert.deepEqual(week.top.map((e) => [e.name, e.points]), [['Ann', 23], ['Bob', 22]]);
  assert.equal(week.me.rank, 2);
  assert.ok(!JSON.stringify(week).includes(A) && !JSON.stringify(week).includes(B));
  assert.equal(s.leaderboard('all', 'nope', day2).me, null);
  assert.equal(s.summary(A).wins, 1);
  assert.equal(s.summary('x').games, 0);
});

test('stats survive a restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cr-stats-'));
  try {
    const file = path.join(dir, 'sub', 'stats.json');
    const s = new Stats(file);
    s.record(A, 'Ann', 3, 12, 1);
    s.saveNow();
    const again = new Stats(file);
    assert.equal(again.summary(A).games, 1);
    assert.equal(again.summary(A).kills, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nicknames: bad characters and abuse are removed', () => {
  assert.equal(cleanName('  Ruud  '), 'Ruud');
  assert.equal(cleanName('<b>x</b>'), 'bxb');
  assert.equal(cleanName('F.u.c.k'), 'Player');
  assert.equal(cleanName('k4nk3r'), 'Player');
  assert.equal(cleanName('Hitchcock'), 'Hitchcock');
  assert.equal(cleanName(''), 'Player');
});

test('a finished round records the human and tells them what they earned', () => {
  const stats = new Stats();
  const server = { clients: new Set(), removeRoom() {}, stats };
  const sent = [];
  const fake = {
    ws: { readyState: 1 }, name: 'me', token: A, inputs: new InputBuffer(),
    send: (o) => sent.push(o), sendBinary() {}, sendRaw() {},
  };
  const room = new Room(server, 1);
  room.addClient(fake);
  let ticks = 0;
  while (room.state !== 'ended' && ticks < TICK_RATE * 400) { room.step(); ticks++; }
  assert.equal(room.state, 'ended');
  const res = sent.find((m) => m.t === 'result');
  assert.ok(res);
  assert.equal(res.points, matchPoints(res.place, res.n, res.kills));
  assert.equal(stats.summary(A).games, 1);
  assert.equal(stats.leaderboard('all', A).players, 1); // bots don't count
});

test('profile and leaderboard over the WebSocket', { timeout: 10000 }, async () => {
  const srv = await startServer({ port: 0 });
  try {
    srv.game.stats.record(A, 'Ann', 1, 10, 2);
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    const msgs = [];
    const next = (t) => new Promise((resolve) => {
      const check = () => { const m = msgs.find((x) => x.t === t); if (m) resolve(m); else setTimeout(check, 10); };
      check();
    });
    ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    await next('hello');
    ws.send(JSON.stringify({ t: 'profile', token: A }));
    const p = await next('profile');
    assert.equal(p.games, 1);
    assert.equal(p.wins, 1);
    ws.send(JSON.stringify({ t: 'lb', period: 'all' }));
    const lb = await next('lb');
    assert.equal(lb.top[0].name, 'Ann');
    assert.equal(lb.top[0].me, true);
    ws.close();
  } finally {
    await srv.close();
  }
});
