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
  const fake = { ws: { readyState: 1 }, name: 'me', queue: [], ack: 0, lastSeq: 0, send() {}, sendBinary() {}, sendRaw: (s) => sent.push(s) };
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

test('server is authoritative and matches client-side prediction exactly', { timeout: 30000 }, async () => {
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

    // Send one input per tick, alternating turns, and record them.
    const turns = new Map();
    let seq = start.seq;
    const timer = setInterval(() => {
      seq++;
      const turn = [1, 1, 1, 0, -1, -1, 0][seq % 7];
      turns.set(seq, turn);
      ws.send(encodeInput(seq, turn));
    }, 1000 / TICK_RATE);

    let prev = null, prevAck = start.seq, checked = 0, died = false, lastTurn = 0;
    await new Promise((resolve) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const d = decodeTick(data);
        const e = d.entries.find((x) => x.id === start.you);
        if (!e) { if (prev) { died = true; resolve(); } return; }
        assert.ok(d.ack >= prevAck, 'ack never goes backwards');
        const turn = d.ack !== prevAck ? turns.get(d.ack) : lastTurn;
        if (prev && d.tick > start.playTick && !(e.flags & FLAG_DIED)) {
          const s = { x: prev.x, y: prev.y, a: prev.a };
          stepSnake(s, turn);
          assert.equal(s.x, e.x);
          assert.equal(s.y, e.y);
          assert.equal(s.a, e.a);
          checked++;
        }
        lastTurn = turn;
        prevAck = d.ack;
        prev = e;
        if (e.flags & FLAG_DIED) { died = true; resolve(); }
        if (checked >= 90) resolve();
      });
    });
    clearInterval(timer);
    console.log(`verified ${checked} ticks, died=${died}`);
    assert.ok(checked > 10 || died, `checked ${checked} ticks`);
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
