import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { Room } from '../server/room.js';
import { InputBuffer } from '../server/inputs.js';
import { stepSnake, modsAt } from '../public/shared/sim.js';
import { encodeInput, decodeTick, FLAG_DIED } from '../public/shared/protocol.js';
import { TICK_RATE } from '../public/shared/constants.js';

test('a bot-filled round always ends with a ranking', () => {
  const server = { clients: new Set(), removeRoom() {} };
  const sent = [];
  const fake = { ws: { readyState: 1 }, name: 'me', inputs: new InputBuffer(), send() {}, sendBinary() {}, sendRaw: (s) => sent.push(s) };
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

test('server applies tick-stamped inputs exactly as the client predicts (with power-ups)', { timeout: 40000 }, async () => {
  process.env.SIM_ITEMS = '400'; // lots of power-ups, so effects happen during the test
  const srv = await startServer({ port: 0 });
  try {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    ws.binaryType = 'arraybuffer';
    const hello = await new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
    assert.equal(hello.t, 'hello');
    ws.send(JSON.stringify({ t: 'join', name: '<b>Tester</b>', build: hello.build }));

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
    const effects = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(data.toString());
      if (m.t === 'pickup' && m.targets.length) effects.push(m);
    });
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
          const m = modsAt(effects, start.you, d.tick);
          stepSnake(s, m.reverse ? -turn : turn, m.speed);
          assert.equal(s.x, e.x, `x at tick ${d.tick}`);
          assert.equal(s.y, e.y);
          assert.equal(s.a, e.a);
          checked++;
        }
        lastTurn = turn;
        prev = e;
        if (e.flags & FLAG_DIED) { died = true; resolve(); }
        if (checked >= 240) resolve();
      });
    });
    const onMe = effects.filter((e) => e.targets.includes(start.you));
    console.log(`verified ${checked} ticks, died=${died}, late=${lateInputSeen}, power-ups picked ${effects.length}, affecting me ${onMe.length} (${onMe.map((e) => e.type).join(',')})`);
    assert.ok(checked > 10 || died, `checked ${checked} ticks`);
    ws.close();
  } finally {
    delete process.env.SIM_ITEMS;
    await srv.close();
  }
});

test('late inputs are dropped and never build up a delay', () => {
  const server = { clients: new Set(), removeRoom() {} };
  const fake = { ws: { readyState: 1 }, name: 'me', inputs: new InputBuffer(), send() {}, sendBinary() {}, sendRaw() {} };
  const room = new Room(server, 1);
  room.addClient(fake);
  while (room.state !== 'playing') room.step();
  const r = room.round;
  const p = fake.player;
  // Network stall: no inputs for 20 ticks...
  for (let i = 0; i < 20; i++) room.step();
  // ...then they all arrive at once, plus fresh ones for upcoming ticks.
  const now = r.tick;
  for (let t = now - 19; t <= now + 3; t++) fake.inputs.receive(t, t > now ? 1 : -1, now);
  room.step();
  assert.equal(p.turn, 1, 'the input for this tick is used');
  assert.equal(fake.inputs.applied, now + 1);
});

test('input buffer: out of order, duplicates, late and far-future inputs', () => {
  const b = new InputBuffer();
  b.receive(12, 1, 10);
  b.receive(11, -1, 10);
  b.receive(12, -1, 10);          // a second copy can't change it (first copy wins)
  b.receive(500, 1, 10);          // nonsense
  assert.equal(b.last, 12);
  assert.deepEqual(b.upcoming(10, 8), [-1, 1]); // ticks 11, 12 known
  assert.equal(b.take(11), -1);
  assert.equal(b.missing, false);
  assert.equal(b.take(12), 1);
  assert.equal(b.take(13), null);  // missing: keep previous turn
  assert.equal(b.missing, true);
  b.receive(13, -1, 13);          // arrives after tick 13 ran
  assert.equal(b.take(14), -1);    // ...becomes the latest intent
  assert.equal(b.missing, true);
});

test('a page from an older deploy is told to reload instead of joining', async () => {
  const srv = await startServer({ port: 0 });
  try {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    const hello = await new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
    ws.send(JSON.stringify({ t: 'join', name: 'old' })); // old pages send no build
    const reply = await new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
    assert.equal(reply.t, 'error');
    assert.equal(reply.reload, true);
    assert.equal(srv.game.rooms.size, 0);
    // The page itself carries the same build the server announces.
    const html = await (await fetch(`http://localhost:${srv.port}/`)).text();
    assert.ok(html.includes(`content="${hello.build}"`));
    assert.ok(html.includes(`main.js?v=${hello.build}`));
    ws.close();
  } finally {
    await srv.close();
  }
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
