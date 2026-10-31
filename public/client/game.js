// Client-side game state.
//
// Netcode model:
//  * The server is authoritative: it runs the simulation and decides every death.
//  * Own snake: client-side prediction. Every client tick we send our input
//    (one input per simulation tick) and immediately simulate it locally with
//    the shared rules. When the server state arrives we rewind to it and replay
//    the inputs the server has not processed yet (reconciliation). Any small
//    difference is smoothed out visually instead of snapping.
//  * Other snakes: rendered a few ticks in the past and interpolated between
//    server ticks, so they move smoothly regardless of network jitter.
import { TICK_MS } from '../shared/constants.js';
import { stepSnake, GapSchedule, makeZonePlan, zoneAt, SegGrid, checkHit } from '../shared/sim.js';
import { FLAG_GAP, FLAG_DIED, encodeInput } from '../shared/protocol.js';

const INTERP_TICKS = 2.5;   // how far in the past remote snakes are shown
const MAX_PENDING = 90;

export class Snake {
  constructor(info) {
    this.id = info.id;
    this.name = info.name;
    this.color = info.color;
    this.bot = info.bot;
    this.cap = 512;
    this.xs = new Float32Array(this.cap);
    this.ys = new Float32Array(this.cap);
    this.as = new Float32Array(this.cap);
    this.fl = new Uint8Array(this.cap);
    this.n = 0;
    this.firstTick = 0;
    this.alive = true;
    this.deathTick = Infinity;
    this.killer = null;
    this.place = 0;
    this.kills = 0;
    this.chunks = [];      // cached Path2D pieces, owned by the renderer
    this.burstAt = 0;      // when the death effect started (ms)
  }

  get lastTick() { return this.firstTick + this.n - 1; }

  push(tick, x, y, a, f) {
    if (this.n === 0) this.firstTick = tick;
    else {
      if (tick <= this.lastTick) return false;
      while (this.lastTick < tick - 1) {
        const i = this.n - 1;
        this._append(this.xs[i], this.ys[i], this.as[i], this.fl[i]);
      }
    }
    this._append(x, y, a, f);
    return true;
  }

  _append(x, y, a, f) {
    if (this.n === this.cap) {
      this.cap *= 2;
      for (const k of ['xs', 'ys', 'as']) {
        const arr = new Float32Array(this.cap);
        arr.set(this[k]);
        this[k] = arr;
      }
      const fl = new Uint8Array(this.cap);
      fl.set(this.fl);
      this.fl = fl;
    }
    const i = this.n++;
    this.xs[i] = x; this.ys[i] = y; this.as[i] = a; this.fl[i] = f;
  }

  /** Interpolated head at fractional tick (clamped to known data). */
  headAt(tick, out) {
    let f = tick - this.firstTick;
    if (f < 0) f = 0;
    if (f > this.n - 1) f = this.n - 1;
    const i = Math.floor(f), k = f - i;
    const j = Math.min(i + 1, this.n - 1);
    out.x = this.xs[i] + (this.xs[j] - this.xs[i]) * k;
    out.y = this.ys[i] + (this.ys[j] - this.ys[i]) * k;
    out.a = k < 0.5 ? this.as[i] : this.as[j];
    return out;
  }
}

export class ClientGame {
  constructor(net) {
    this.net = net;
    this.seq = 0;
    this.active = false;
    this.onEvent = () => {};
  }

  start(msg) {
    this.active = true;
    this.ended = false;
    this.endInfo = null;
    this.myId = msg.you;
    this.seed = msg.seed;
    this.R0 = msg.R0;
    this.playTick = msg.playTick;
    this.plan = makeZonePlan(msg.seed, msg.R0);
    this.snakes = new Map();
    for (const p of msg.players) {
      const s = new Snake(p);
      s.push(msg.tick, p.x, p.y, p.a, 0);
      this.snakes.set(p.id, s);
    }
    this.list = [...this.snakes.values()];
    this.total = this.list.length;
    this.aliveCount = this.total;
    this.me = this.snakes.get(this.myId);
    this.grid = new SegGrid();
    this.latestTick = msg.tick;
    this.seq = Math.max(this.seq, msg.seq || 0);

    // prediction state
    this.controlling = !!this.me;
    this.myGaps = new GapSchedule(msg.seed, this.myId);
    this.pending = [];
    this.pred = { x: this.me.xs[0], y: this.me.ys[0], a: this.me.as[0] };
    this.path = [];
    this.predStopped = false;
    this.offset = { x: 0, y: 0 };
    this.myDeath = null;
    this.stats = { reconciles: 0, corrections: 0, maxErr: 0 };

    // clock + input pacing
    this.clockOffset = null;
    this.bufferedAvg = 2;
    this.tickScale = 1;
  }

  // ---- server messages -------------------------------------------------

  onTick(d) {
    if (d.tick <= this.latestTick) return;
    let mine = null;
    for (const e of d.entries) {
      const s = this.snakes.get(e.id);
      if (!s || !s.push(d.tick, e.x, e.y, e.a, e.flags)) continue;
      const i = s.n - 1;
      if (d.tick > this.playTick && i > 0 && !(s.fl[i] & FLAG_GAP) && !(s.fl[i - 1] & FLAG_GAP)) {
        this.grid.add(s.xs[i - 1], s.ys[i - 1], s.xs[i], s.ys[i], s.id, d.tick);
      }
      if (e.flags & FLAG_DIED) {
        s.alive = false;
        s.deathTick = d.tick;
      }
      if (e.id === this.myId) mine = e;
    }
    this.latestTick = d.tick;

    // Clock sync: estimate which server tick "now" corresponds to. Biased toward
    // the earliest arrivals so late packets don't drag the estimate around.
    const sample = d.tick - performance.now() / TICK_MS;
    if (this.clockOffset === null || sample - this.clockOffset > 15 || sample - this.clockOffset < -15) this.clockOffset = sample;
    else if (sample > this.clockOffset) this.clockOffset += (sample - this.clockOffset) * 0.25;
    else this.clockOffset += (sample - this.clockOffset) * 0.02;

    // Input pacing: keep ~1-2 inputs buffered on the server.
    this.bufferedAvg = this.bufferedAvg * 0.9 + d.buffered * 0.1;
    this.tickScale = this.bufferedAvg < 0.8 ? 0.94 : this.bufferedAvg > 2.5 ? 1.06 : 1;

    if (mine) {
      if (mine.flags & FLAG_DIED) this.controlling = false;
      else if (this.controlling) this.reconcile(d.ack, mine, d.tick);
    }
  }

  onDeath(m) {
    const s = this.snakes.get(m.id);
    if (!s) return;
    s.alive = false;
    s.deathTick = Math.min(s.deathTick, m.tick);
    s.killer = m.killer;
    s.place = m.place;
    this.aliveCount = m.alive;
    const k = this.snakes.get(m.killer);
    if (k && k !== s) k.kills++;
    if (m.id === this.myId) {
      this.controlling = false;
      this.myDeath = m;
    }
    this.onEvent({ type: 'death', snake: s, killer: k || null, killerId: m.killer, msg: m });
  }

  onEnd(m) {
    this.ended = true;
    this.controlling = false;
    this.endInfo = m;
    for (const r of m.ranking) {
      const s = this.snakes.get(r.id);
      if (s) { s.place = r.place; s.kills = r.kills; }
    }
  }

  // ---- prediction ------------------------------------------------------

  /** Called at the fixed client tick rate while we control a live snake. */
  clientTick(turn) {
    if (!this.controlling) return;
    this.seq++;
    this.net.sendBinary(encodeInput(this.seq, turn));
    this.pending.push({ seq: this.seq, turn });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.advance(this.latestTick + this.pending.length, turn);
  }

  advance(t, turn) {
    const p = this.pred;
    if (!this.predStopped && t > this.playTick) {
      stepSnake(p, turn);
      // Stop at an obvious crash instead of sliding through a line while we
      // wait for the server's verdict.
      if (checkHit(this.grid, zoneAt(this.plan, t - this.playTick), p.x, p.y, this.myId, t) !== null) {
        this.predStopped = true;
      }
    }
    this.path.push({ x: p.x, y: p.y, a: p.a, t, solid: t <= this.playTick || !this.myGaps.isGap(t - this.playTick) });
  }

  reconcile(ack, e, tick) {
    const oldX = this.pred.x, oldY = this.pred.y;
    let i = 0;
    while (i < this.pending.length && this.pending[i].seq <= ack) i++;
    if (i) this.pending.splice(0, i);
    this.pred.x = e.x; this.pred.y = e.y; this.pred.a = e.a;
    this.path.length = 0;
    this.predStopped = false;
    for (let j = 0; j < this.pending.length; j++) this.advance(tick + j + 1, this.pending[j].turn);
    // Smooth visual correction
    const dx = oldX - this.pred.x, dy = oldY - this.pred.y;
    this.stats.reconciles++;
    if (dx * dx + dy * dy > 0.01) { this.stats.corrections++; this.stats.maxErr = Math.max(this.stats.maxErr, Math.hypot(dx, dy)); }
    if (dx * dx + dy * dy < 80 * 80) { this.offset.x += dx; this.offset.y += dy; }
    else { this.offset.x = 0; this.offset.y = 0; }
  }

  decayOffset(dtMs) {
    const k = Math.exp(-dtMs / 90);
    this.offset.x *= k;
    this.offset.y *= k;
  }

  // ---- queries for rendering ------------------------------------------------

  serverTickNow(now = performance.now()) {
    if (this.clockOffset === null) return this.latestTick;
    return now / TICK_MS + this.clockOffset;
  }

  renderTick(now) {
    let t = this.serverTickNow(now) - INTERP_TICKS;
    if (t > this.latestTick) t = this.latestTick;
    if (t < this.latestTick - 8) t = this.latestTick - 8;
    return t;
  }

  /** Predicted own head, interpolated between client ticks (alpha 0..1). */
  myHead(alpha, out) {
    const P = this.path;
    const n = P.length;
    const me = this.me;
    const last = me.n - 1;
    let ax, ay, bx, by, a;
    if (n === 0) {
      out.x = me.xs[last] + this.offset.x; out.y = me.ys[last] + this.offset.y; out.a = me.as[last];
      return out;
    }
    if (n === 1) { ax = me.xs[last]; ay = me.ys[last]; }
    else { ax = P[n - 2].x; ay = P[n - 2].y; }
    bx = P[n - 1].x; by = P[n - 1].y; a = P[n - 1].a;
    out.x = ax + (bx - ax) * alpha + this.offset.x;
    out.y = ay + (by - ay) * alpha + this.offset.y;
    out.a = a;
    return out;
  }

  zone(now) {
    return zoneAt(this.plan, this.serverTickNow(now) - this.playTick);
  }
}
