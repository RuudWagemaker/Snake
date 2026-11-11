import {
  TICK_RATE, MIN_PLAYERS, MAX_PLAYERS, LOBBY_SECONDS, NEXT_ROUND_LOBBY_SECONDS, PRIVATE_LOBBY_SECONDS,
  COUNTDOWN_SECONDS, END_SECONDS, KILLER_LEFT, COLORS, fieldRadius,
  POWERUPS, POWERUP_TYPES, EFFECT_DELAY, ITEM_RADIUS, OTHERS_RANGE, LINE_WIDTH,
  FUEL_SHARE, FUEL_PER_ROCKET, MAX_FUEL, ROCKET_SPEED, ROCKET_RANGE, ROCKET_WIDTH, BLAST_R, DT, FIRE_LATE_TICKS,
} from '../public/shared/constants.js';
import {
  mulberry32, stepSnake, GapSchedule, makeZonePlan, zoneAt, SegGrid, checkHit, modsAt, hitDist,
} from '../public/shared/sim.js';
import { encodeTickBody, writeTickHeader, FLAG_GAP, FLAG_DIED, MAX_FUTURE } from '../public/shared/protocol.js';
import { botThink, botName, botWantsRocket } from './bot.js';

const LOBBY_TICKS = LOBBY_SECONDS * TICK_RATE;
const PRIVATE_LOBBY_TICKS = PRIVATE_LOBBY_SECONDS * TICK_RATE;
const COUNTDOWN_TICKS = COUNTDOWN_SECONDS * TICK_RATE;
const END_TICKS = END_SECONDS * TICK_RATE;
// Bots decide their steering this many ticks ahead. Their path is then known in
// advance, so clients can draw them "in the present" exactly, without guessing.
const BOT_AHEAD = 8;
const ITEM_CHECK_TICKS = 15;    // how often items are topped up / removed outside the zone
const HIST = 32;                // ticks of head positions kept per player (> FIRE_LATE_TICKS)

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
  constructor(server, id, code = null) {
    this.server = server;
    this.id = id;
    this.code = code;       // set for a friends' room (joined by link, not matchmaking)
    this.clients = new Set();
    this.state = 'lobby';   // lobby -> playing -> ended -> lobby ...
    this.timer = this.firstLobbyTicks();
    this.round = null;
  }

  firstLobbyTicks() {
    return this.code ? PRIVATE_LOBBY_TICKS : LOBBY_TICKS;
  }

  /** Public matchmaking only fills public rooms that haven't started. */
  canJoin() {
    return !this.code && this.state === 'lobby' && this.clients.size < MAX_PLAYERS;
  }

  full() {
    return this.clients.size >= MAX_PLAYERS;
  }

  /** Someone in a friends' room tapped "Start now". */
  startSoon() {
    if (this.state !== 'lobby' || this.timer <= TICK_RATE) return;
    this.timer = TICK_RATE;
    this.broadcastLobby();
  }

  addClient(c) {
    c.room = this;
    c.player = null;
    c.inputs.reset();
    this.clients.add(c);
    if (this.clients.size === 1) this.timer = this.firstLobbyTicks();
    if (this.clients.size >= MAX_PLAYERS) this.timer = Math.min(this.timer, TICK_RATE);
    if (this.state === 'lobby') this.broadcastLobby();
    else c.send({ ...this.lobbyInfo(), waiting: true }); // friends' room mid-match: joins the next round
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
    c.inputs.reset();
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

  lobbyInfo() {
    return {
      t: 'lobby',
      room: this.id,
      code: this.code,
      players: this.clients.size,
      names: this.code ? [...this.clients].map((c) => c.name) : undefined,
      max: MAX_PLAYERS,
      startsIn: Math.ceil(this.timer / TICK_RATE),
      online: this.server.clients.size,
    };
  }

  broadcastLobby() {
    this.broadcast(this.lobbyInfo());
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
    // Humans get the colour they picked (first come, first served), everyone
    // else the next free colour.
    const colors = new Array(n).fill(null);
    const usedColors = new Set();
    humans.slice(0, n).forEach((c, i) => {
      const want = c.skin && c.skin.color >= 0 ? COLORS[c.skin.color] : null;
      if (want && !usedColors.has(want)) { colors[i] = want; usedColors.add(want); }
    });
    for (let i = 0, k = 0; i < n; i++) {
      if (colors[i]) continue;
      let col;
      do { col = COLORS[(colorOffset + k++) % COLORS.length]; } while (usedColors.has(col) && k < COLORS.length * 2);
      colors[i] = col;
      usedColors.add(col);
    }

    const players = [];
    for (let i = 0; i < n; i++) {
      const id = i + 1;
      const client = humans[i] || null;
      const sp = spawns[i];
      const p = {
        id,
        name: client ? client.name : botName(rng, usedNames),
        color: colors[i],
        style: client && client.skin ? client.skin.style : 'plain',
        bot: !client,
        client,
        token: client ? client.token : null, // kept if they leave, so the match still counts
        x: sp.x, y: sp.y, a: sp.a,
        alive: true,
        solid: true,
        turn: 0,
        kills: 0,
        picks: {},              // power-ups picked up, for daily missions
        // fuel cans (FUEL_PER_ROCKET make a rocket). SIM_FUEL: dev/testing start amount
        fuel: Math.min(MAX_FUEL, Number(process.env.SIM_FUEL) || 0),
        wantFire: false,        // the player pressed fire: launched at fireTick
        fireTick: 0,
        hist: [],               // recent heads by tick % HIST, so a late fire starts where it was aimed
        place: 0,
        deathTick: -1,
        gaps: new GapSchedule(seed, id),
        brain: null,
        width: LINE_WIDTH,
        ghost: false,
        mods: {},
        botQueue: client ? null : new Array(BOT_AHEAD).fill(0), // decided turns for the next ticks
      };
      players.push(p);
      if (client) {
        client.player = p;
        client.inputs.reset();
        client.lastInputAt = 0;
      }
    }

    // Bot strength follows the humans' average level: 0 at level 1, full at level 8.
    const stats = this.server.stats;
    const avgLevel = humans.length && stats
      ? humans.reduce((sum, c) => sum + stats.summary(c.token).level, 0) / humans.length : 8;
    this.round = {
      seed, R0, n,
      botSkill: Math.max(0, Math.min(1, (avgLevel - 1) / 7)),
      plan: makeZonePlan(seed, R0),
      players,
      grid: new SegGrid(),
      tick: 0,
      playTick: COUNTDOWN_TICKS,
      aliveCount: n,
      items: [],          // power-ups on the field: {id, type, x, y}
      nextItemId: 1,
      effects: [],        // active power-up effects: {type, start, end, targets}
      rockets: [],        // flying rockets: {id, by, x, y, a, dist}
      nextRocketId: 1,
      // SIM_ITEMS: dev/testing override for the number of power-ups on the field
      itemTarget: Number(process.env.SIM_ITEMS) || Math.max(8, Math.min(24, Math.round(n * 1.3))),
      rng: mulberry32(seed ^ 0x51ed27),
    };
    this.state = 'playing';
    const zone0 = zoneAt(this.round.plan, 0);
    for (let i = 0; i < this.round.itemTarget; i++) this.spawnItem(zone0);

    const info = players.map((p) => ({ id: p.id, name: p.name, color: p.color, style: p.style, bot: p.bot, x: p.x, y: p.y, a: p.a, fuel: p.fuel || undefined }));
    for (const c of this.clients) {
      c.send({ t: 'start', you: c.player.id, seed, R0, playTick: this.round.playTick, tick: 0, players: info, items: this.round.items });
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
        // Each input is stamped with the tick it's for. Inputs that arrive after
        // their tick ran can't change the past (so they never pile up); their
        // turn just becomes the latest known intent.
        const inp = p.client.inputs;
        const turn = inp.take(t);
        if (turn !== null) p.turn = turn;
        if (inp.missing) p.client.starved = true; // tell the client
      } else if (moving) {
        p.turn = p.botQueue.length ? p.botQueue.shift() : 0;
      }
    }
    // Power-up modifiers for this tick (speed, line width, reversed steering, ghost)
    for (const p of r.players) if (p.alive) modsAt(r.effects, p.id, t, p.mods);

    // 2. Movement + trail
    const deaths = new Map();
    if (moving) {
      for (const p of r.players) {
        if (!p.alive) continue;
        const px = p.x, py = p.y, m = p.mods;
        stepSnake(p, m.reverse ? -p.turn : p.turn, m.speed);
        const solid = !p.gaps.isGap(zt) && !m.ghost;
        if (solid && p.solid) r.grid.add(px, py, p.x, p.y, p.id, t, m.width);
        p.solid = solid;
        const h = p.hist[t % HIST] || (p.hist[t % HIST] = {});
        h.t = t; h.x = p.x; h.y = p.y; h.a = p.a;
        p.width = m.width;
        p.ghost = m.ghost;
        p.shield = m.shield;
      }

      // 3. Collisions (after everyone moved, so head-on crashes kill both)
      for (const p of r.players) {
        if (!p.alive) continue;
        const k = checkHit(r.grid, zone, p.x, p.y, p.id, t, p.width, p.ghost || p.shield);
        if (k !== null) deaths.set(p, k);
      }
      const alive = r.players.filter((p) => p.alive);
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i], b = alive[j];
          if (a.ghost || b.ghost) continue;
          const dx = a.x - b.x, dy = a.y - b.y, d = hitDist(a.width, b.width);
          if (dx * dx + dy * dy < d * d) {
            // head-on: both crash, unless shielded
            if (!a.shield && !deaths.has(a)) deaths.set(a, b.id);
            if (!b.shield && !deaths.has(b)) deaths.set(b, a.id);
          }
        }
      }
    }

    if (moving) {
      this.rockets(deaths, zone, t);
      this.pickups(deaths, t);
      if (t % ITEM_CHECK_TICKS === 0) this.maintainItems(zone, t);
      this.planBots(deaths, t);
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

  /** Each bot decides its turn for the tick after its queue, from where it will be then. */
  planBots(deaths, t) {
    const r = this.round;
    for (const p of r.players) {
      if (!p.bot || !p.alive || deaths.has(p)) continue;
      const v = { id: p.id, x: p.x, y: p.y, a: p.a, brain: p.brain, speed: 1 };
      const m = {};
      for (let k = 0; k < p.botQueue.length; k++) {
        modsAt(r.effects, p.id, t + 1 + k, m);
        stepSnake(v, m.reverse ? -p.botQueue[k] : p.botQueue[k], m.speed);
      }
      const T = t + p.botQueue.length + 1;
      const zt = T - r.playTick;
      modsAt(r.effects, p.id, T, m);
      v.speed = m.speed;
      const intended = botThink(v, r, zoneAt(r.plan, zt), zt, T);
      // Steering is reversed for everyone under "reverse"; bots compensate.
      p.botQueue.push(m.reverse ? -intended : intended);
      p.brain = v.brain;
    }
  }

  // ---- rockets -------------------------------------------------------------

  /** Launch rockets for players who pressed fire, then move all rockets one tick. */
  rockets(deaths, zone, t) {
    const r = this.round;
    for (const p of r.players) {
      if (p.bot && p.alive && !deaths.has(p) && p.fuel >= FUEL_PER_ROCKET && botWantsRocket(p, r, zone, t)) {
        p.wantFire = true;
        p.fireTick = t;
      }
      if (!p.wantFire || t < p.fireTick) continue; // stamped for a tick that hasn't come yet
      p.wantFire = false;
      if (!p.alive || deaths.has(p) || p.fuel < FUEL_PER_ROCKET) continue;
      p.fuel -= FUEL_PER_ROCKET;
      // From the head as it was on the stamped tick (what the player saw), just in
      // front of it so it never hits its own neck. A late one catches up below.
      const ft = Math.max(p.fireTick, t - FIRE_LATE_TICKS);
      const h = p.hist[ft % HIST];
      const from = h && h.t === ft ? h : { t, x: p.x, y: p.y, a: p.a };
      const off = 8 + p.width;
      const rk = {
        id: r.nextRocketId++, by: p.id, from: from.t, catchUp: t - from.t, dist: 0, a: from.a,
        x: Math.fround(from.x + Math.cos(from.a) * off), y: Math.fround(from.y + Math.sin(from.a) * off),
      };
      r.rockets.push(rk);
      this.broadcast({ t: 'rocket', id: rk.id, by: p.id, x: rk.x, y: rk.y, a: rk.a, tick: from.t, fuel: p.fuel });
    }
    r.grid.pruneBlasts(t);
    if (!r.rockets.length) return;
    const step = ROCKET_SPEED * DT, sub = 4;
    const keep = [];
    for (const rk of r.rockets) {
      const cx = Math.cos(rk.a) * (step / sub), cy = Math.sin(rk.a) * (step / sub);
      let end = null;
      const steps = sub * (1 + rk.catchUp);
      rk.catchUp = 0;
      for (let k = 0; k < steps && !end; k++) {
        rk.x += cx; rk.y += cy; rk.dist += step / sub;
        // the shooter's own line drawn after the shot is ignored (it runs right behind the rocket)
        if (r.grid.hit(rk.x, rk.y, ROCKET_WIDTH, rk.by, rk.from, t) !== -2) end = { r: BLAST_R };
        else if (Math.hypot(rk.x - zone.x, rk.y - zone.y) > zone.r || rk.dist >= ROCKET_RANGE) end = { r: 0 };
      }
      if (!end) { keep.push(rk); continue; }
      const at = t + EFFECT_DELAY;
      const x = Math.fround(rk.x), y = Math.fround(rk.y);
      if (end.r) {
        r.grid.blast(x, y, end.r, at);
        const shooter = r.players[rk.by - 1];
        if (shooter) shooter.picks.blast = (shooter.picks.blast || 0) + 1; // for missions
      }
      this.broadcast({ t: 'blast', id: rk.id, by: rk.by, x, y, r: end.r, at });
    }
    r.rockets = keep;
  }

  // ---- power-ups -----------------------------------------------------------

  spawnItem(zone) {
    const r = this.round;
    for (let attempt = 0; attempt < 20; attempt++) {
      const ang = r.rng() * Math.PI * 2;
      const d = Math.sqrt(r.rng()) * zone.r * 0.85;
      const x = zone.x + Math.cos(ang) * d, y = zone.y + Math.sin(ang) * d;
      // not on a line, not right in front of anyone, not on another item
      if (r.grid.hit(x, y, ITEM_RADIUS * 3, -1, 0) !== -2) continue;
      if (r.players.some((p) => p.alive && Math.hypot(p.x - x, p.y - y) < 120)) continue;
      if (r.items.some((it) => Math.hypot(it.x - x, it.y - y) < 150)) continue;
      const type = r.rng() < FUEL_SHARE ? 'fuel' : POWERUP_TYPES[Math.floor(r.rng() * POWERUP_TYPES.length)];
      const item = { id: r.nextItemId++, type, x: Math.round(x), y: Math.round(y) };
      r.items.push(item);
      return item;
    }
    return null;
  }

  /** Remove items the zone has swallowed, and top up to the target count. */
  maintainItems(zone, t) {
    const r = this.round;
    const rem = [];
    r.items = r.items.filter((it) => {
      const inside = Math.hypot(it.x - zone.x, it.y - zone.y) < zone.r - ITEM_RADIUS;
      if (!inside) rem.push(it.id);
      return inside;
    });
    // fewer items as the field shrinks
    const target = Math.min(r.itemTarget, Math.max(1, Math.round(r.itemTarget * zone.r / r.R0)));
    const add = [];
    if (r.items.length < target && zone.r > 150) {
      const it = this.spawnItem(zone);
      if (it) add.push(it);
    }
    r.effects = r.effects.filter((e) => e.end > t);
    if (add.length || rem.length) this.broadcast({ t: 'items', add, rem });
  }

  pickups(deaths, t) {
    const r = this.round;
    for (let i = r.items.length - 1; i >= 0; i--) {
      const it = r.items[i];
      const fuel = it.type === 'fuel';
      const p = r.players.find((q) => q.alive && !deaths.has(q) && (!fuel || q.fuel < MAX_FUEL) &&
        Math.hypot(q.x - it.x, q.y - it.y) < ITEM_RADIUS + q.width / 2);
      if (!p) continue;
      r.items.splice(i, 1);
      p.picks[it.type] = (p.picks[it.type] || 0) + 1;
      if (fuel) {
        p.fuel++;
        this.broadcast({ t: 'pickup', item: it.id, type: it.type, by: p.id, x: it.x, y: it.y, start: t, end: t, targets: [], fuel: p.fuel });
        continue;
      }
      const def = POWERUPS[it.type];
      const targets = def.good
        ? [p.id]
        : r.players.filter((q) => q !== p && q.alive && !deaths.has(q) && Math.hypot(q.x - p.x, q.y - p.y) < OTHERS_RANGE).map((q) => q.id);
      const start = t + EFFECT_DELAY, end = start + Math.round(def.secs * TICK_RATE);
      if (targets.length) r.effects.push({ type: it.type, start, end, targets });
      this.broadcast({ t: 'pickup', item: it.id, type: it.type, by: p.id, x: it.x, y: it.y, start, end, targets });
    }
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
          future: !p.alive ? null : p.bot ? p.botQueue.slice(0, MAX_FUTURE) : p.client ? p.client.inputs.upcoming(t, MAX_FUTURE) : null,
          width: p.width,
        });
      }
    }
    const body = encodeTickBody(entries);
    for (const c of this.clients) {
      const msg = new Uint8Array(body); // copy, header differs per client
      writeTickHeader(msg, t, c.player ? c.inputs.last : 0, c.starved);
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
    this.recordStats();
  }

  /** Points, XP and leaderboards for the humans in this match (bots don't count). */
  recordStats() {
    const stats = this.server.stats;
    if (!stats) return;
    const r = this.round;
    const humans = r.players.filter((p) => !p.bot && p.token).length;
    if (humans) stats.matchPlayed({ room: !!this.code, secs: Math.max(0, Math.round((r.tick - r.playTick) / TICK_RATE)), humans });
    for (const p of r.players) {
      if (p.bot || !p.token) continue;
      // Friends' rooms earn XP but don't count for the leaderboards.
      const res = stats.record(p.token, p.name, p.place, r.n, p.kills, Date.now(), !this.code, p.picks);
      if (res && p.client && p.client.room === this) p.client.send({ t: 'result', place: p.place, n: r.n, kills: p.kills, ...res });
    }
  }
}
