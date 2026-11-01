// Client-side game state.
//
// Netcode model:
//  * The server is authoritative: it runs the simulation and decides every death.
//  * Inputs are stamped with the server tick they are meant for. The client aims
//    them to arrive just before that tick (lead = round trip + a small margin
//    that adapts to jitter). The server applies each input on exactly its tick
//    and drops inputs that arrive too late, so a network stall can never build
//    up a permanent input delay.
//  * Own snake: client-side prediction. Each input is simulated locally right
//    away with the shared rules. When the server state for tick T arrives, we
//    rewind to it and replay our inputs for ticks after T (reconciliation).
//    Small differences are blended out instead of snapping.
//  * Other snakes: shown a few ticks in the past and interpolated. If updates
//    stop for a moment, they keep moving along their current curve
//    (extrapolation) instead of freezing.
import { TICK_MS, TURN_RATE, DT } from '../shared/constants.js';
import { stepSnake, GapSchedule, makeZonePlan, zoneAt, SegGrid, checkHit } from '../shared/sim.js';
import { FLAG_GAP, FLAG_DIED, encodeInput } from '../shared/protocol.js';

const MIN_INTERP = 2;       // remote snakes are shown at least this many ticks in the past
const MAX_INTERP = 6;       // bigger gaps are bridged by extrapolation instead
const MAX_EXTRAP = 15;      // keep other snakes moving for up to 0.5 s without updates
const MAX_PENDING = 120;
const WINDOW = 150;         // ticks of history used to measure jitter (5 s)
const MIN_LEAD_MARGIN = 1;
const MAX_LEAD_MARGIN = 6;

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
      s.gaps = new GapSchedule(msg.seed, p.id);
      s.push(msg.tick, p.x, p.y, p.a, 0);
      this.snakes.set(p.id, s);
    }
    this.list = [...this.snakes.values()];
    this.total = this.list.length;
    this.aliveCount = this.total;
    this.me = this.snakes.get(this.myId);
    this.grid = new SegGrid();
    this.latestTick = msg.tick;

    // prediction state
    this.controlling = !!this.me;
    this.myGaps = this.me.gaps;
    this.pending = [];        // [{tick, turn}] sent but not yet confirmed
    this.lastTarget = null;   // tick of the newest input we generated
    this.lastTurn = 0;
    this.pred = { x: this.me.xs[0], y: this.me.ys[0], a: this.me.as[0] };
    this.predTick = msg.tick;
    this.path = [];
    this.predStopped = false;
    this.offset = { x: 0, y: 0 };
    this.alpha = 0;
    this.myDeath = null;
    this.stats = { reconciles: 0, corrections: 0, maxErr: 0, late: 0 };

    // clock, input lead, jitter
    this.clockOffset = null;
    this.margin = 2;          // extra ticks of lead on top of the round trip
    this.lead = null;         // smoothed lead actually used (ticks)
    this.slackHist = [];
    this.starvedAt = -1e9;
    this.marginChangedAt = -1e9;
    this.lateHist = [];
    this.interpTarget = MIN_INTERP + 1;
    this.interp = MIN_INTERP + 1;
    this.lastRenderNow = 0;
    this.lastFrameNow = 0;
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
    if (this.clockOffset === null || sample - this.clockOffset > 15 || sample - this.clockOffset < -90) this.clockOffset = sample;
    else if (sample > this.clockOffset) this.clockOffset += (sample - this.clockOffset) * 0.25;
    else this.clockOffset += (sample - this.clockOffset) * 0.01;

    // Jitter: how late was this message compared to the earliest arrivals?
    // Remote snakes are delayed enough to cover normal jitter (90th percentile).
    // Rare long stalls are bridged by extrapolation, not by more delay.
    pushWindow(this.lateHist, Math.max(0, this.clockOffset - sample));
    if ((d.tick & 7) === 0) {
      const sorted = this.lateHist.slice().sort((a, b) => a - b);
      const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
      this.interpTarget = Math.min(MAX_INTERP, Math.max(MIN_INTERP, 1 + p90 * 1.2));
    }

    if (this.controlling) {
      this.adaptLead(d);
      if (mine) {
        if (mine.flags & FLAG_DIED) this.controlling = false;
        else this.reconcile(mine, d.tick);
      }
    }
  }

  /**
   * Input lead control. The server reports the newest input tick it has
   * received; "slack" is how many ticks early our inputs arrive. If an input
   * was missing when its tick ran, add a tick of margin. After 5 quiet seconds
   * with plenty of slack, take margin away again.
   */
  adaptLead(d) {
    if (d.tick <= 30) return; // the first second: our first inputs are still on the way
    const slack = d.lastInput - d.tick;
    pushWindow(this.slackHist, slack);
    if (d.starved) {
      this.stats.late++;
      this.starvedAt = d.tick;
      if (d.tick - this.marginChangedAt > 30) {
        this.margin = Math.min(MAX_LEAD_MARGIN, this.margin + 1);
        this.marginChangedAt = d.tick;
      }
    } else if (d.tick - this.starvedAt > 150 && d.tick - this.marginChangedAt > 60) {
      const minSlack = Math.min(...this.slackHist);
      if (minSlack >= 2.5) {
        this.margin = Math.max(MIN_LEAD_MARGIN, this.margin - 0.5);
        this.marginChangedAt = d.tick;
      }
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

  // ---- input + prediction ------------------------------------------------

  /**
   * Called every frame while we control a live snake. Generates one input per
   * server tick, stamped with the tick it should arrive for.
   */
  generateInputs(now, turn, rttMs) {
    const dtMs = this.lastFrameNow ? Math.min(250, now - this.lastFrameNow) : 0;
    this.lastFrameNow = now;
    if (!this.controlling || this.clockOffset === null) return;

    // Lead = round trip + margin. Changes are eased in so the snake never jumps.
    const want = (rttMs > 0 ? rttMs / TICK_MS : 4) + this.margin;
    if (this.lead === null) this.lead = want;
    const maxStep = (want > this.lead ? 3 : 0.5) * dtMs / 1000; // ticks per second
    this.lead += Math.max(-maxStep, Math.min(maxStep, want - this.lead));

    const targetF = this.serverTickNow(now) + this.lead;
    const target = Math.floor(targetF);
    if (this.lastTarget === null || target - this.lastTarget > 30 || this.lastTarget - target > 30) {
      // first input, or the clock jumped (e.g. the tab was asleep): resync
      this.lastTarget = Math.max(this.latestTick, target - 1);
    }
    while (this.lastTarget < target) {
      const t = ++this.lastTarget;
      this.net.sendBinary(encodeInput(t, turn));
      this.pending.push({ tick: t, turn });
      if (this.pending.length > MAX_PENDING) this.pending.shift();
      this.advanceTo(t, turn);
    }
    this.alpha = Math.max(0, Math.min(1, targetF - target));
  }

  /** Tab is going to the background: make sure the server doesn't keep a held turn. */
  goStraight() {
    if (!this.controlling || this.lastTarget === null) return;
    const t = ++this.lastTarget;
    this.net.sendBinary(encodeInput(t, 0));
    this.pending.push({ tick: t, turn: 0 });
    this.advanceTo(t, 0);
  }

  /** Step the prediction forward to tick t, using `turn` for that tick. */
  advanceTo(t, turn) {
    const p = this.pred;
    while (this.predTick < t) {
      const tt = ++this.predTick;
      // A skipped tick (rare: after a resync) repeats the previous turn, like the server does.
      const tr = tt === t ? turn : this.lastTurn;
      if (!this.predStopped && tt > this.playTick) {
        stepSnake(p, tr);
        // Stop at an obvious crash instead of sliding through a line while we
        // wait for the server's verdict.
        if (checkHit(this.grid, zoneAt(this.plan, tt - this.playTick), p.x, p.y, this.myId, tt) !== null) {
          this.predStopped = true;
        }
      }
      this.path.push({ x: p.x, y: p.y, a: p.a, t: tt, solid: tt <= this.playTick || !this.myGaps.isGap(tt - this.playTick) });
    }
    this.lastTurn = turn;
  }

  reconcile(e, tick) {
    const oldX = this.pred.x, oldY = this.pred.y;
    let i = 0;
    while (i < this.pending.length && this.pending[i].tick <= tick) i++;
    if (i) this.pending.splice(0, i);
    this.pred.x = e.x; this.pred.y = e.y; this.pred.a = e.a;
    this.predTick = tick;
    this.path.length = 0;
    this.predStopped = false;
    // The server's turn at `tick` is unknown here, but only matters for skipped
    // ticks; our own last pending turn before the replay is the best guess.
    for (const p of this.pending) this.advanceTo(p.tick, p.turn);
    const dx = oldX - this.pred.x, dy = oldY - this.pred.y;
    this.stats.reconciles++;
    if (dx * dx + dy * dy > 0.01) { this.stats.corrections++; this.stats.maxErr = Math.max(this.stats.maxErr, Math.hypot(dx, dy)); }
    if (dx * dx + dy * dy < 80 * 80) { this.offset.x += dx; this.offset.y += dy; }
    else { this.offset.x = 0; this.offset.y = 0; }
  }

  decayOffset(dtMs) {
    const k = Math.exp(-dtMs / 120);
    this.offset.x *= k;
    this.offset.y *= k;
  }

  // ---- queries for rendering ------------------------------------------------

  serverTickNow(now = performance.now()) {
    if (this.clockOffset === null) return this.latestTick;
    return now / TICK_MS + this.clockOffset;
  }

  renderTick(now) {
    // Ease the interpolation delay toward what the measured jitter needs.
    const dt = Math.min(100, Math.max(0, now - this.lastRenderNow));
    this.lastRenderNow = now;
    // Grow fast (avoid stutter), shrink slowly (avoid visible speed changes).
    const rate = this.interpTarget > this.interp ? 1 / 500 : 1 / 3000;
    this.interp += (this.interpTarget - this.interp) * Math.min(1, dt * rate);
    let t = this.serverTickNow(now) - this.interp;
    if (t > this.latestTick + MAX_EXTRAP) t = this.latestTick + MAX_EXTRAP;
    if (t < this.latestTick - MAX_INTERP - 3) t = this.latestTick - MAX_INTERP - 3;
    return t;
  }

  /**
   * Where a remote snake probably is at tick `rt` when we have no data yet:
   * keep its current turn, respect its (deterministic) gaps, and stop at
   * anything it would crash into. Returns {pts, head} or null.
   */
  extrapolate(s, rt) {
    const k = Math.min(rt - s.lastTick, MAX_EXTRAP);
    if (k <= 0 || !s.alive) return null;
    const i = s.n - 1;
    let turn = 0;
    if (i > 0) {
      let da = s.as[i] - s.as[i - 1];
      if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) > TURN_RATE * DT * 0.5) turn = Math.sign(da);
    }
    const st = { x: s.xs[i], y: s.ys[i], a: s.as[i] };
    const pts = [];
    const whole = Math.floor(k);
    const solidAt = (t) => t <= this.playTick || !s.gaps.isGap(t - this.playTick);
    for (let j = 1; j <= whole + 1; j++) {
      const t = s.lastTick + j;
      const nx = { x: st.x, y: st.y, a: st.a };
      if (t > this.playTick) stepSnake(nx, turn);
      if (t > this.playTick && checkHit(this.grid, zoneAt(this.plan, t - this.playTick), nx.x, nx.y, s.id, t) !== null) {
        return { pts, head: st };
      }
      if (j > whole) {
        // fractional last step
        const f = k - whole;
        const head = { x: st.x + (nx.x - st.x) * f, y: st.y + (nx.y - st.y) * f, a: nx.a };
        if (f > 0) pts.push({ x: head.x, y: head.y, solid: solidAt(t) });
        return { pts, head };
      }
      st.x = nx.x; st.y = nx.y; st.a = nx.a;
      pts.push({ x: st.x, y: st.y, solid: solidAt(t) });
    }
    return { pts, head: st };
  }

  /** Predicted own head, interpolated between ticks. */
  myHead(out) {
    const P = this.path;
    const n = P.length;
    const me = this.me;
    const last = me.n - 1;
    const alpha = this.alpha;
    let ax, ay;
    if (n === 0) {
      out.x = me.xs[last] + this.offset.x; out.y = me.ys[last] + this.offset.y; out.a = me.as[last];
      return out;
    }
    if (n === 1) { ax = me.xs[last]; ay = me.ys[last]; }
    else { ax = P[n - 2].x; ay = P[n - 2].y; }
    const b = P[n - 1];
    out.x = ax + (b.x - ax) * alpha + this.offset.x;
    out.y = ay + (b.y - ay) * alpha + this.offset.y;
    out.a = b.a;
    return out;
  }

  zone(now) {
    return zoneAt(this.plan, this.serverTickNow(now) - this.playTick);
  }
}

function pushWindow(arr, v) {
  arr.push(v);
  if (arr.length > WINDOW) arr.shift();
}
