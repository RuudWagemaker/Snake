import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { Room } from '../server/room.js';
import { stepSnake } from '../public/shared/sim.js';
import { encodeInput, decodeTick, FLAG_DIED } from '../public/shared/protocol.js';
import { TICK_RATE } from '../public/shared/constants.js';

test('a bot-filled round always ends with a ranking', () => {
  const server = { clients: new Set(), removeRoom() {} };
  const sent = [];
  const fake = { ws: { readyState: 1 }, name: 'me', queue: [], lastInput: -1, send() {}, sendBinary() {}, sendRaw: (s) => sent.push(s) };
  const room = new Room(server, 1);
  room.addClient(fake);
  let ticks = 0;
  while (room.state !== 'ended' && ticks < TICK_RATE * 400) { room.step(); ticks++; }
  assert.equal(room.state, 'ended');
  const end = sent.map((s) => (typeof s === 'string' ? JSON.parse(s) : null)).find((m) => m && m.t === 'end');
  assert.ok(end);
  assert.equal(end.ranking.length, room.round.n);
  assert.equal(new Set(end.ranking.map((r) => r.id)).size, room.round.n);
});

test('server applies tick-stamped inputs exactly as the client predicts', { timeout: 30000 }, async () => {
  const srv = await startServer({ port: 0 });
  try {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    ws.binaryType = 'arraybuffer';
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', name: '<b>Tester</b>' }));

    const start = await new Promise((resolve) => {
      ws.on('message', function onMsg(data, isBinary) {
        if (isBinary) return;
        const m = JSON.parse(data.toString());
        if (m.t === 'start') { ws.off('message', onMsg); resolve(m); }
      });
    });
    const me = start.players.find((p) => p.id === start.you);
    assert.equal(me.name, 'bTesterb'); // sanitised

    const pattern = (t) => [1, 1, 1, 0, -1, -1, 0][t % 7];
    let sentUpTo = 0;
    let prev = null, checked = 0, died = false, lastTurn = 0, lateInputSeen = false;
    await new Promise((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const d = decodeTick(data);
        // Aim inputs a few ticks ahead of the newest state, like the client does.
        while (sentUpTo < d.tick + 4) { sentUpTo++; ws.send(encodeInput(sentUpTo, pattern(sentUpTo))); }
        if (sentUpTo === d.tick + 4 && d.tick === 1) {
          // A stale input for a tick that already ran must be ignored.
          ws.send(encodeInput(1, -1));
        }
        const e = d.entries.find((x) => x.id === start.you);
        if (!e) { if (prev) { died = true; resolve(); } return; }
        assert.ok(d.lastInput <= sentUpTo);
        // The server applied our input for this tick, or kept the previous turn if it was missing.
        const turn = d.starved ? lastTurn : pattern(d.tick);
        if (d.starved) lateInputSeen = true;
        if (prev && d.tick > start.playTick && !(e.flags & FLAG_DIED)) {
          const s = { x: prev.x, y: prev.y, a: prev.a };
          stepSnake(s, turn);
          assert.equal(s.x, e.x, `x at tick ${d.tick}`);
          assert.equal(s.y, e.y);
          assert.equal(s.a, e.a);
          checked++;
        }
        lastTurn = turn;
        prev = e;
        if (e.flags & FLAG_DIED) { died = true; resolve(); }
        if (checked >= 90) resolve();
      });
    });
    console.log(`verified ${checked} ticks, died=${died}, late=${lateInputSeen}`);
    assert.ok(checked > 10 || died, `checked ${checked} ticks`);
    ws.close();
  } finally {
    await srv.close();
  }
});

test('late inputs are dropped and never build up a delay', () => {
  const server = { clients: new Set(), removeRoom() {} };
  const fake = { ws: { readyState: 1 }, name: 'me', queue: [], lastInput: -1, send() {}, sendBinary() {}, sendRaw() {} };
  const room = new Room(server, 1);
  room.addClient(fake);
  while (room.state !== 'playing') room.step();
  const r = room.round;
  const p = fake.player;
  // Network stall: the inputs for the next 20 ticks are missing...
  for (let i = 0; i < 20; i++) room.step();
  assert.equal(fake.queue.length, 0);
  // ...then they all arrive at once, plus fresh ones for upcoming ticks.
  const now = r.tick;
  for (let t = now - 19; t <= now + 3; t++) fake.queue.push({ tick: t, turn: t > now ? 1 : -1 });
  room.step();
  // Stale ones were discarded; only the 2 inputs for future ticks remain queued.
  assert.equal(fake.queue.length, 2);
  assert.equal(p.turn, 1);
});

test('static files are served and paths cannot escape public/', async () => {
  const srv = await startServer({ port: 0 });
  try {
    const ok = await fetch(`http://localhost:${srv.port}/`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Curve/);
    const js = await fetch(`http://localhost:${srv.port}/shared/sim.js`);
    assert.equal(js.status, 200);
    const bad = await fetch(`http://localhost:${srv.port}/%2e%2e/package.json`);
    assert.notEqual(bad.status, 200);
  } finally {
    await srv.close();
  }
});
