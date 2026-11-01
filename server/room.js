import {
  TICK_RATE, MIN_PLAYERS, MAX_PLAYERS, LOBBY_SECONDS, NEXT_ROUND_LOBBY_SECONDS,
  COUNTDOWN_SECONDS, END_SECONDS, HIT_DIST, KILLER_LEFT, COLORS, fieldRadius,
} from '../public/shared/constants.js';
import {
  mulberry32, stepSnake, GapSchedule, makeZonePlan, zoneAt, SegGrid, checkHit,
} from '../public/shared/sim.js';
import { encodeTickBody, writeTickHeader, FLAG_GAP, FLAG_DIED } from '../public/shared/protocol.js';
import { botThink, botName } from './bot.js';

const LOBBY_TICKS = LOBBY_SECONDS * TICK_RATE;
const COUNTDOWN_TICKS = COUNTDOWN_SECONDS * TICK_RATE;
const END_TICKS = END_SECONDS * TICK_RATE;

function makeSpawns(rng, n, R0) {
  const spawns = [];
  const maxR = R0 * 0.72;
  let minDist = Math.min(260, (maxR * 1.6) / Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    let best = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      const ang = rng() * Math.PI * 2;
      const d = Math.sqrt(rng()) * maxR;
      const x = Math.cos(ang) * d, y = Math.sin(ang) * d;
      let nearest = Infinity;
      for (const s of spawns) nearest = Math.min(nearest, Math.hypot(s.x - x, s.y - y));
      if (!best || nearest > best.nearest) best = { x, y, nearest };
      if (nearest >= minDist) break;
    }
    // Face roughly toward the centre so nobody starts heading into the wall.
    const toCenter = Math.atan2(-best.y, -best.x);
    const a = toCenter + (rng() - 0.5) * Math.PI * 0.9;
    spawns.push({ x: Math.fround(best.x), y: Math.fround(best.y), a: Math.fround(Math.atan2(Math.sin(a), Math.cos(a))) });
  }
  return spawns;
}

export class Room {
  constructor(server, id) {
    this.server = server;
    this.id = id;
    this.clients = new Set();
    this.state = 'lobby';   // lobby -> playing -> ended -> lobby ...
    this.timer = LOBBY_TICKS;
    this.round = null;
  }

  canJoin() {
    return this.state === 'lobby' && this.clients.size < MAX_PLAYERS;
  }

  addClient(c) {
    c.room = this;
    c.player = null;
    c.queue = [];
    this.clients.add(c);
    if (this.clients.size === 1) this.timer = LOBBY_TICKS;
    if (this.clients.size >= MAX_PLAYERS) this.timer = Math.min(this.timer, TICK_RATE);
    this.broadcastLobby();
  }

  removeClient(c) {
    this.clients.delete(c);
    const p = c.player;
    if (p) {
      p.client = null;
      if (p.alive && this.round && this.state === 'playing') {
        const placeAfter = this.round.aliveCount - 1;
        this.kill(p, KILLER_LEFT, placeAfter + 1, this.round.tick);
      }
    }
    c.room = null;
    c.player = null;
    c.queue = [];
    if (this.clients.size === 0) {
      this.server.removeRoom(this);
    } else if (this.state === 'lobby') {
      this.broadcastLobby();
    }
  }

  abort() {
    for (const c of [...this.clients]) {
      c.send({ t: 'error', msg: 'Room closed' });
      this.removeClient(c);
    }
    this.server.removeRoom(this);
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const c of this.clients) c.sendRaw(s);
  }

  broadcastLobby() {
    this.broadcast({
      t: 'lobby',
      room: this.id,
      players: this.clients.size,
      max: MAX_PLAYERS,
      startsIn: Math.ceil(this.timer / TICK_RATE),
      online: this.server.clients.size,
    });
  }

  step() {
    switch (this.state) {
      case 'lobby':
        if (this.clients.size === 0) return;
        this.timer--;
        if (this.timer <= 0) this.startRound();
        else if (this.timer % TICK_RATE === 0) this.broadcastLobby();
        break;
      case 'playing':
        this.simulate();
        break;
      case 'ended':
        if (--this.timer <= 0) {
          this.state = 'lobby';
          this.timer = NEXT_ROUND_LOBBY_SECONDS * TICK_RATE;
          this.round = null;
          for (const c of this.clients) c.player = null;
          this.broadcastLobby();
        }
        break;
    }
  }

  startRound() {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const rng = mulberry32(seed);
    const humans = [...this.clients];
    const n = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, humans.length));
    const R0 = fieldRadius(n);
    const spawns = makeSpawns(rng, n, R0);
    const colorOffset = Math.floor(rng() * COLORS.length);
    const usedNames = new Set(humans.map((c) => c.name));

    const players = [];
    for (let i = 0; i < n; i++) {
      const id = i + 1;
      const client = humans[i] || null;
      const sp = spawns[i];
      const p = {
        id,
        name: client ? client.name : botName(rng, usedNames),
        color: COLORS[(colorOffset + i) % COLORS.length],
        bot: !client,
        client,
        x: sp.x, y: sp.y, a: sp.a,
        alive: true,
        solid: true,
        turn: 0,
        kills: 0,
        place: 0,
        deathTick: -1,
        gaps: new GapSchedule(seed, id),
        brain: null,
      };
      players.push(p);
      if (client) {
        client.player = p;
        client.queue = [];
        client.lastInput = -1;
        client.lastInputAt = 0;
      }
    }

    this.round = {
      seed, R0, n,
      plan: makeZonePlan(seed, R0),
      players,
      grid: new SegGrid(),
      tick: 0,
      playTick: COUNTDOWN_TICKS,
      aliveCount: n,
    };
    this.state = 'playing';

    const info = players.map((p) => ({ id: p.id, name: p.name, color: p.color, bot: p.bot, x: p.x, y: p.y, a: p.a }));
    for (const c of this.clients) {
      c.send({ t: 'start', you: c.player.id, seed, R0, playTick: this.round.playTick, tick: 0, players: info });
    }
  }

  simulate() {
    const r = this.round;
    const t = r.tick + 1;
    const moving = t > r.playTick;
    const zt = t - r.playTick;
    const zone = zoneAt(r.plan, zt);

    // 1. Inputs
    for (const p of r.players) {
      if (!p.alive) continue;
      if (p.client) {
        // Each input is stamped with the tick it's for. Inputs for ticks that
        // already ran are too late: their turn still becomes the latest known
        // intent, but they can't change the past, so they never pile up.
        const q = p.client.queue;
        while (q.length && q[0].tick < t) p.turn = q.shift().turn;
        if (q.length && q[0].tick === t) p.turn = q.shift().turn;
        else p.client.starved = true; // missing: keep the previous turn, tell the client
      } else if (moving) {
        p.turn = botThink(p, r, zone, zt, t);
      }
    }

    // 2. Movement + trail
    const deaths = new Map();
    if (moving) {
      for (const p of r.players) {
        if (!p.alive) continue;
        const px = p.x, py = p.y;
        stepSnake(p, p.turn);
        const solid = !p.gaps.isGap(zt);
        if (solid && p.solid) r.grid.add(px, py, p.x, p.y, p.id, t);
        p.solid = solid;
      }

      // 3. Collisions (after everyone moved, so head-on crashes kill both)
      for (const p of r.players) {
        if (!p.alive) continue;
        const k = checkHit(r.grid, zone, p.x, p.y, p.id, t);
        if (k !== null) deaths.set(p, k);
      }
      const alive = r.players.filter((p) => p.alive);
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i], b = alive[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          if (dx * dx + dy * dy < HIT_DIST * HIT_DIST) {
            if (!deaths.has(a)) deaths.set(a, b.id);
            if (!deaths.has(b)) deaths.set(b, a.id);
          }
        }
      }
    }

    r.tick = t;
    for (const p of deaths.keys()) p.deathTick = t;
    this.broadcastTick(t);

    if (deaths.size) {
      const place = r.aliveCount - deaths.size + 1;
      for (const [p, killer] of deaths) this.kill(p, killer, place, t);
    }

    if (moving && r.aliveCount <= 1) this.endRound();
  }

  kill(p, killer, place, t) {
    const r = this.round;
    if (!p.alive) return;
    p.alive = false;
    p.place = place;
    p.deathTick = t;
    r.aliveCount--;
    if (killer > 0 && killer !== p.id) {
      const k = r.players[killer - 1];
      if (k) k.kills++;
    }
    if (p.client) p.client.queue = [];
    this.broadcast({ t: 'death', id: p.id, killer, tick: t, place, alive: r.aliveCount });
  }

  broadcastTick(t) {
    const r = this.round;
    const entries = [];
    for (const p of r.players) {
      if (p.alive || p.deathTick === t) {
        entries.push({
          id: p.id, x: p.x, y: p.y, a: p.a,
          flags: (p.solid ? 0 : FLAG_GAP) | (p.deathTick === t ? FLAG_DIED : 0),
        });
      }
    }
    const body = encodeTickBody(entries);
    for (const c of this.clients) {
      const msg = new Uint8Array(body); // copy, header differs per client
      writeTickHeader(msg, t, c.player ? c.lastInput : 0, c.starved);
      c.starved = false;
      c.sendBinary(msg);
    }
  }

  endRound() {
    const r = this.round;
    const winner = r.players.find((p) => p.alive) || null;
    if (winner) {
      winner.place = 1;
      winner.alive = false;
    }
    this.state = 'ended';
    this.timer = END_TICKS;
    const ranking = [...r.players]
      .sort((a, b) => a.place - b.place || b.kills - a.kills)
      .map((p) => ({ id: p.id, name: p.name, place: p.place, kills: p.kills, bot: p.bot }));
    this.broadcast({ t: 'end', winner: winner ? winner.id : null, ranking, next: END_SECONDS + NEXT_ROUND_LOBBY_SECONDS });
  }
}
