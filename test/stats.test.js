import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
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

test('stats file is backed up once a day, last 14 days kept', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cr-stats-'));
  try {
    const file = path.join(dir, 'stats.json');
    const bdir = path.join(dir, 'backups');
    const s = new Stats(file);
    s.record(A, 'Ann', 3, 12, 1);
    const day0 = Date.UTC(2026, 0, 1, 12);
    s.saveNow(day0);
    s.saveNow(day0 + 3600000); // same day: no second copy
    assert.deepEqual(readdirSync(bdir), ['stats-2026-01-01.json']);
    for (let d = 1; d < 20; d++) s.saveNow(day0 + d * 86400000);
    const files = readdirSync(bdir).sort();
    assert.equal(files.length, 14);
    assert.equal(files[0], 'stats-2026-01-07.json');
    assert.equal(files[13], 'stats-2026-01-20.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('names saved before the filter are cleaned on load', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cr-stats-'));
  try {
    const file = path.join(dir, 'stats.json');
    writeFileSync(file, JSON.stringify({ v: 1, profiles: { [A]: { name: 'fuck', games: 1, wins: 0, kills: 0, best: 1, xp: 10, points: 1, last: Date.now() } } }));
    assert.equal(new Stats(file).get(A).name, 'Player');
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

test("friends' rooms: joined by code, never by matchmaking, XP only", { timeout: 15000 }, async () => {
  const srv = await startServer({ port: 0 });
  try {
    const connect = async () => {
      const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
      const msgs = [];
      ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
      const next = (pred) => new Promise((resolve) => {
        const check = () => { const m = msgs.find(pred); if (m) resolve(m); else setTimeout(check, 10); };
        check();
      });
      const hello = await next((m) => m.t === 'hello');
      return { ws, msgs, next, build: hello.build };
    };
    const a = await connect(), b = await connect(), c = await connect();
    a.ws.send(JSON.stringify({ t: 'join', name: 'Ann', build: a.build, token: A, room: 'abc12' }));
    await a.next((m) => m.t === 'lobby' && m.code === 'abc12');
    b.ws.send(JSON.stringify({ t: 'join', name: 'Bob', build: b.build, token: B, room: 'abc12' }));
    const lobby = await b.next((m) => m.t === 'lobby' && m.players === 2);
    assert.deepEqual(lobby.names, ['Ann', 'Bob']);
    assert.ok(lobby.startsIn > 20); // friends get time to join
    c.ws.send(JSON.stringify({ t: 'join', name: 'Cat', build: c.build })); // public matchmaking
    const pub = await c.next((m) => m.t === 'lobby');
    assert.equal(pub.code, null);
    assert.equal(pub.players, 1);
    b.ws.send(JSON.stringify({ t: 'go' }));
    await a.next((m) => m.t === 'start');
    for (const x of [a, b, c]) x.ws.close();
  } finally {
    await srv.close();
  }
  const s = new Stats();
  const res = s.record(A, 'Ann', 1, 10, 2, Date.now(), false);
  assert.equal(res.ranked, false);
  assert.ok(s.summary(A).xp > 0);
  assert.equal(s.leaderboard('all', A).players, 0);
});

test('skins: only what your level has unlocked, and no two snakes share a colour', async () => {
  const { GameServer } = await import('../server/game.js');
  const { COLORS } = await import('../public/shared/constants.js');
  const stats = new Stats();
  const gs = new GameServer('t', stats);
  assert.deepEqual(gs.allowedSkin(A, { color: 3, style: 'neon' }), { color: 3, style: 'plain' }); // level 1
  assert.deepEqual(gs.allowedSkin(A, { color: 20, style: 'x' }), { color: -1, style: 'plain' });
  assert.deepEqual(gs.allowedSkin(A, { color: 3, style: '__proto__' }), { color: 3, style: 'plain' });
  stats.profiles.set(A, { name: 'a', games: 1, wins: 0, kills: 0, best: 1, xp: 2025, points: 0 }); // level 10
  assert.deepEqual(gs.allowedSkin(A, { color: 23, style: 'rainbow' }), { color: 23, style: 'rainbow' });

  const server = { clients: new Set(), removeRoom() {}, stats };
  const room = new Room(server, 1);
  const mk = (name, color) => ({ ws: { readyState: 1 }, name, skin: { color, style: 'plain' }, inputs: new InputBuffer(), send() {}, sendBinary() {}, sendRaw() {} });
  room.addClient(mk('a', 5));
  room.addClient(mk('b', 5));
  room.startRound();
  const cols = room.round.players.map((p) => p.color);
  assert.equal(cols[0], COLORS[5]);
  assert.notEqual(cols[1], COLORS[5]);
  assert.equal(new Set(cols).size, cols.length);
});
