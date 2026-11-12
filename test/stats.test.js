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
import { TICK_RATE, FUEL_PER_ROCKET } from '../public/shared/constants.js';

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
    assert.equal(again.usage()[0].players, 1); // usage numbers survive too
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

test('usage numbers per day for the admin page', () => {
  const s = new Stats();
  const now = Date.UTC(2026, 3, 1, 12);
  s.visit(A, now); s.visit(A, now); s.visit(B, now);
  s.online(3, now); s.online(2, now);
  s.record(A, 'Ann', 1, 10, 2, now);
  s.record(A, 'Ann', 2, 10, 0, now);
  s.matchPlayed({ secs: 60, humans: 1 }, now);
  s.matchPlayed({ room: true, secs: 120, humans: 1 }, now);
  const [d] = s.usage();
  assert.deepEqual(d, { day: '2026-04-01', visitors: 2, players: 1, newPlayers: 1, matches: 2, roomMatches: 1, avgMatchSecs: 90, matchesPerPlayer: 2, peakOnline: 3 });
});

test('admin page needs the key', { timeout: 10000 }, async () => {
  const srv = await startServer({ port: 0, adminKey: 'secret-key' });
  try {
    const base = `http://localhost:${srv.port}/admin`;
    assert.equal((await fetch(base)).status, 404);
    assert.equal((await fetch(base + '?key=wrong')).status, 404);
    const ok = await fetch(base + '?key=secret-key');
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Online now/);
  } finally {
    await srv.close();
  }
  const off = await startServer({ port: 0 });
  try {
    assert.equal((await fetch(`http://localhost:${off.port}/admin?key=`)).status, 404);
  } finally {
    await off.close();
  }
});

test('Google accounts: link, other device, keep the better profile', () => {
  const s = new Stats();
  const C = 'c'.repeat(32);
  s.record(A, 'Ann', 1, 10, 3);                       // phone: some progress
  assert.equal(s.login('g1', A), A);                  // first sign-in links it
  assert.equal(s.get(A).account, true);
  assert.equal(s.login('g1', B), A);                  // laptop: switch to the account's profile
  s.record(C, 'Cee', 1, 24, 10); s.record(C, 'Cee', 1, 24, 10); // tablet guest with more XP
  assert.equal(s.login('g1', C), A);                  // still the account's profile: never split
  s.login('g2', C);                                   // the tablet's guest becomes another account
  assert.equal(s.accounts.get('g2'), C);
  assert.notEqual(s.login('g4', C), C, "another account can't take a linked profile");
  assert.match(s.login('g3', null), /^[a-f0-9]{32}$/); // no token: a fresh one
  s.prune(Date.now() + 365 * 86400000);
  assert.ok(s.get(C), 'linked profiles are never pruned');
});

test('sign in over the WebSocket (Google check stubbed)', { timeout: 10000 }, async () => {
  const verifyGoogle = async (cred, clientId) => (cred === 'a.b.c' && clientId === 'cid' ? { sub: 'g1', name: 'Ann' } : null);
  const srv = await startServer({ port: 0, googleClientId: 'cid', verifyGoogle });
  try {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    const msgs = [];
    const next = (t, n = 1) => new Promise((resolve) => {
      const check = () => { const m = msgs.filter((x) => x.t === t); if (m.length >= n) resolve(m[n - 1]); else setTimeout(check, 10); };
      check();
    });
    ws.on('message', (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
    const hello = await next('hello');
    assert.equal(hello.google, 'cid');
    ws.send(JSON.stringify({ t: 'login', credential: 'x.y.z', token: A }));
    assert.equal((await next('login')).ok, false);
    ws.send(JSON.stringify({ t: 'login', credential: 'a.b.c', token: A }));
    const ok = await next('login', 2);
    assert.deepEqual(ok, { t: 'login', ok: true, token: A, name: 'Ann' });
    assert.equal(srv.game.stats.accounts.get('g1'), A);
    ws.close();
  } finally {
    await srv.close();
  }
});

test('rockets: fuel, firing and a hole in a line', () => {
  const server = { clients: new Set(), removeRoom() {}, stats: null };
  const sent = [];
  const fake = {
    ws: { readyState: 1 }, name: 'me', token: A, inputs: new InputBuffer(),
    send: (o) => sent.push(o), sendBinary() {}, sendRaw: (raw) => { if (typeof raw === 'string') sent.push(JSON.parse(raw)); },
  };
  const room = new Room(server, 1);
  room.addClient(fake);
  while (room.state !== 'playing') room.step();
  const r = room.round;
  while (r.tick <= r.playTick + 10) room.step(); // countdown over: snakes move a bit
  const me = fake.player;
  const t0 = r.tick;
  const wx = me.x + Math.cos(me.a) * 200, wy = me.y + Math.sin(me.a) * 200;
  const nx = -Math.sin(me.a), ny = Math.cos(me.a);
  for (let i = -20; i < 20; i++) r.grid.add(wx + nx * i * 5, wy + ny * i * 5, wx + nx * (i + 1) * 5, wy + ny * (i + 1) * 5, 99, t0);
  me.wantFire = true;            // no fuel: nothing happens
  me.fireTick = r.tick + 1;
  room.step();
  assert.ok(!sent.some((m) => m.t === 'rocket'));
  me.fuel = FUEL_PER_ROCKET;
  me.wantFire = true;
  me.fireTick = r.tick - 5;      // stamped a little in the past (lag): starts where it was aimed
  const aimed = { ...me.hist[(r.tick - 5) % 32] };
  room.step();
  const launch = sent.find((m) => m.t === 'rocket');
  assert.ok(launch, 'rocket launched');
  assert.equal(launch.tick, aimed.t);
  assert.ok(Math.hypot(launch.x - aimed.x, launch.y - aimed.y) < 20, 'from the aimed head position');
  assert.ok(me.fuel < 0.05, `fuel used (${me.fuel})`);
  let blast = null;
  for (let i = 0; i < 30 && !blast; i++) { room.step(); blast = sent.find((m) => m.t === 'blast'); }
  assert.ok(blast && blast.r > 0, 'hit the wall');
  assert.ok(Math.hypot(blast.x - wx, blast.y - wy) < 15);
  assert.equal(me.picks.blast, 1);
  assert.notEqual(r.grid.hit(wx, wy, 6, -1, 0, blast.at - 1), -2);
  assert.equal(r.grid.hit(wx, wy, 6, -1, 0, blast.at), -2);
});

test('fuel: only fuel dots on the field, more pop up during the match', () => {
  const server = { clients: new Set(), removeRoom() {}, stats: null };
  const fake = { ws: { readyState: 1 }, name: 'me', token: A, inputs: new InputBuffer(), send() {}, sendBinary() {}, sendRaw() {} };
  const room = new Room(server, 1);
  room.addClient(fake);
  while (room.state !== 'playing') room.step();
  const count = () => room.round.items.filter((it) => it.type === 'fuel').length;
  const atStart = count();
  assert.ok(atStart >= 15, `some fuel dots at the start (${atStart})`);
  assert.equal(room.round.items.length, atStart, 'no power-ups any more');
  for (let i = 0; i < TICK_RATE * 10 && room.state === 'playing'; i++) room.step();
  assert.ok(count() >= atStart + 15, `more pop up during the match (${count()})`);
});

test('skills cost fuel, start on their stamped tick, and a crash drops fuel', () => {
  const server = { clients: new Set(), removeRoom() {}, stats: null };
  const sent = [];
  const fake = {
    ws: { readyState: 1 }, name: 'me', token: A, inputs: new InputBuffer(), skills: ['boost', 'jump'],
    send: (o) => sent.push(o), sendBinary() {}, sendRaw: (raw) => { if (typeof raw === 'string') sent.push(JSON.parse(raw)); },
  };
  const room = new Room(server, 1);
  room.addClient(fake);
  while (room.state !== 'playing') room.step();
  const r = room.round;
  while (r.tick <= r.playTick + 5) room.step();
  const me = fake.player;
  assert.deepEqual(me.skills, ['boost', 'jump']);
  assert.ok(me.fuel >= 3 && me.fuel < 3.3, `start fuel + a little refill (${me.fuel})`);
  const stamp = r.tick + 3;
  me.wantSkills.push({ k: 'boost', tick: stamp });
  room.step();
  assert.ok(!sent.some((m) => m.t === 'skill'), 'waits for its tick');
  while (r.tick < stamp) room.step();
  const used = sent.find((m) => m.t === 'skill');
  assert.ok(used && used.ok);
  assert.equal(used.start, stamp);
  assert.ok(me.fuel < 0.3, `boost paid (${me.fuel})`);
  assert.equal(me.mods.speed > 1, true);
  me.wantSkills.push({ k: 'jump', tick: r.tick + 1 });   // no fuel left: refused
  room.step(); room.step();
  assert.ok(sent.some((m) => m.t === 'skill' && m.k === 'jump' && !m.ok));
  me.wantSkills.push({ k: 'rocket', tick: r.tick + 1 }); // not one of my skills: ignored
  room.step();
  assert.ok(!sent.some((m) => m.t === 'skill' && m.k === 'rocket'));
  // a crash drops its fuel plus the extra dots
  me.fuel = 4;
  const before = r.items.length;
  room.kill(me, -1, 5, r.tick);
  assert.equal(r.items.length, before + 4 + 3);
  assert.equal(me.fuel, 0);
});

test('fuel refills slowly by itself, up to the maximum', () => {
  const server = { clients: new Set(), removeRoom() {}, stats: null };
  const fake = { ws: { readyState: 1 }, name: 'me', token: A, inputs: new InputBuffer(), send() {}, sendBinary() {}, sendRaw() {} };
  const room = new Room(server, 1);
  room.addClient(fake);
  while (room.state !== 'playing') room.step();
  const r = room.round;
  while (r.tick <= r.playTick) room.step();
  const me = fake.player;
  me.fuel = 0;
  r.items = []; // no dots: only the refill
  for (let i = 0; i < TICK_RATE * 4 && me.alive; i++) room.step();
  if (me.alive) assert.ok(Math.abs(me.fuel - 1) < 0.05, `about 1 fuel after 4 s (${me.fuel})`);
  me.fuel = 9.99;
  room.step(); room.step();
  if (me.alive) assert.equal(me.fuel, 10);
});

test('fuel magnet: a dot next to the path is collected without an exact hit', () => {
  const server = { clients: new Set(), removeRoom() {}, stats: null };
  const fake = { ws: { readyState: 1 }, name: 'me', token: A, inputs: new InputBuffer(), send() {}, sendBinary() {}, sendRaw() {} };
  const room = new Room(server, 1);
  room.addClient(fake);
  while (room.state !== 'playing') room.step();
  const r = room.round;
  while (r.tick <= r.playTick) room.step();
  const me = fake.player;
  me.fuel = 0;
  r.items = [];
  // 30 units ahead, 18 to the side: the snake (going straight) passes 18 units from it
  const nx = -Math.sin(me.a), ny = Math.cos(me.a);
  r.items.push({ id: 999, type: 'fuel', x: me.x + Math.cos(me.a) * 30 + nx * 18, y: me.y + Math.sin(me.a) * 30 + ny * 18 });
  for (let i = 0; i < 20 && me.alive; i++) room.step();
  if (me.alive) assert.ok(!r.items.some((it) => it.id === 999) && me.fuel >= 1, 'collected');
});

test('a rocket fired right before a line saves you: the hole is there in time', () => {
  for (const dist of [6, 12, 25]) {
    const server = { clients: new Set(), removeRoom() {}, stats: null };
    const fake = { ws: { readyState: 1 }, name: 'me', token: A, inputs: new InputBuffer(), skills: ['rocket', 'jump'], send() {}, sendBinary() {}, sendRaw() {} };
    const room = new Room(server, 1);
    room.addClient(fake);
    while (room.state !== 'playing') room.step();
    const r = room.round;
    while (r.tick <= r.playTick + 10) room.step();
    const me = fake.player;
    // a long wall across our path, `dist` units in front of the head
    const wx = me.x + Math.cos(me.a) * (dist + 3), wy = me.y + Math.sin(me.a) * (dist + 3);
    const nx = -Math.sin(me.a), ny = Math.cos(me.a);
    for (let i = -30; i < 30; i++) r.grid.add(wx + nx * i * 5, wy + ny * i * 5, wx + nx * (i + 1) * 5, wy + ny * (i + 1) * 5, 99, r.tick);
    me.fuel = 10;
    me.wantSkills.push({ k: 'rocket', tick: r.tick + 1 });
    for (let i = 0; i < 20; i++) room.step();
    assert.ok(me.alive, `survived a line ${dist} units ahead`);
  }
});
