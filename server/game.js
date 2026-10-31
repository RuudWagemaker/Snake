import { WebSocket } from 'ws';
import { TICK_MS } from '../public/shared/constants.js';
import { decodeInput } from '../public/shared/protocol.js';
import { Room } from './room.js';

const MAX_QUEUE = 32;         // max buffered inputs per player (~1 s); bursts on bad connections must fit
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

// Development aid: simulate a bad network. SIM_LAG_MS is one-way delay in each
// direction, SIM_JITTER_MS adds random extra delay (order is preserved, like TCP).
const SIM_LAG_MS = Number(process.env.SIM_LAG_MS) || 0;
const SIM_JITTER_MS = Number(process.env.SIM_JITTER_MS) || 0;
function makeDelayer() {
  if (!SIM_LAG_MS && !SIM_JITTER_MS) return null;
  // Strict FIFO with one timer, so messages are never reordered (TCP never does).
  const queue = [];
  let timer = null;
  const flush = () => {
    timer = null;
    const now = performance.now();
    while (queue.length && queue[0].at <= now) queue.shift().fn();
    if (queue.length) timer = setTimeout(flush, queue[0].at - now);
  };
  return (fn) => {
    const last = queue.length ? queue[queue.length - 1].at : 0;
    queue.push({ at: Math.max(last, performance.now() + SIM_LAG_MS + Math.random() * SIM_JITTER_MS), fn });
    if (!timer) timer = setTimeout(flush, queue[0].at - performance.now());
  };
}

function cleanName(s) {
  const n = String(s ?? '').replace(/[^\p{L}\p{N} _\-.!?]/gu, '').trim().slice(0, 16);
  return n || 'Player';
}

class Client {
  constructor(ws, server) {
    this.ws = ws;
    this.server = server;
    this.id = server.nextClientId++;
    this.name = 'Player';
    this.room = null;
    this.player = null;   // current round's player object
    this.queue = [];      // pending inputs {seq, turn}
    this.ack = 0;         // last input seq applied by the simulation
    this.lastSeq = 0;     // last seq received
    this.starved = false; // input queue ran dry this tick
    this.isAlive = true;  // heartbeat
    this.delayIn = makeDelayer();
    this.delayOut = makeDelayer();

    ws.on('message', (data, isBinary) => {
      const handle = () => (isBinary ? this.onInput(data) : this.onJson(data));
      if (this.delayIn) this.delayIn(handle);
      else handle();
    });
    ws.on('pong', () => { this.isAlive = true; });
    ws.on('close', () => server.onClose(this));
    ws.on('error', () => {});
  }

  onInput(data) {
    const msg = decodeInput(data);
    if (!msg || !this.player || !this.player.alive) return;
    if (msg.seq <= this.lastSeq) return;
    this.lastSeq = msg.seq;
    this.queue.push(msg);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
  }

  onJson(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'join':
        this.name = cleanName(msg.name);
        this.server.join(this);
        break;
      case 'leave':
        if (this.room) this.room.removeClient(this);
        break;
      case 'ping':
        this.send({ t: 'pong', c: msg.c });
        break;
    }
  }

  send(obj) {
    this.sendRaw(JSON.stringify(obj));
  }

  sendRaw(data) {
    if (this.delayOut) {
      this.delayOut(() => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data); });
    } else if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  sendBinary(u8) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.ws.terminate(); // hopelessly behind; drop the connection
      return;
    }
    this.sendRaw(u8);
  }
}

export class GameServer {
  constructor() {
    this.rooms = new Set();
    this.clients = new Set();
    this.nextClientId = 1;
    this.nextRoomId = 1;
    this.timer = null;
    this.heartbeat = null;
  }

  onConnection(ws) {
    const c = new Client(ws, this);
    this.clients.add(c);
    c.send({ t: 'hello', online: this.clients.size });
  }

  onClose(c) {
    this.clients.delete(c);
    if (c.room) c.room.removeClient(c);
  }

  join(c) {
    if (c.room) c.room.removeClient(c);
    let room = null;
    for (const r of this.rooms) {
      if (r.canJoin()) { room = r; break; }
    }
    if (!room) {
      room = new Room(this, this.nextRoomId++);
      this.rooms.add(room);
    }
    room.addClient(c);
  }

  removeRoom(room) {
    this.rooms.delete(room);
  }

  step() {
    for (const room of this.rooms) {
      try {
        room.step();
      } catch (err) {
        console.error(`room ${room.id} crashed`, err);
        room.abort();
      }
    }
  }

  start() {
    // Fixed-rate loop that catches up if a timer fires late.
    let next = performance.now();
    const loop = () => {
      const now = performance.now();
      let n = 0;
      while (now >= next && n < 5) {
        this.step();
        next += TICK_MS;
        n++;
      }
      if (now - next > 250) next = now; // too far behind, skip ahead
      this.timer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    loop();
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) {
        if (!c.isAlive) { c.ws.terminate(); continue; }
        c.isAlive = false;
        c.ws.ping();
      }
    }, 15000);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
  }
}
