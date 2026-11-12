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
//  * Other snakes: while you play, they're shown at the same moment as your own
//    (predicted) snake, projected forward along their current curve. So what
//    you see matches what the server decides when lines cross. Corrections
//    glide in. While spectating they're shown slightly in the past and
//    interpolated (smoothest). Either way, if updates stop for a moment they
//    keep moving instead of freezing.
import { TICK_MS, TURN_RATE, DT, LINE_WIDTH, FUEL_PICK_R, FUEL, FUEL_PER_ROCKET, MAX_FUEL, FUEL_REGEN, SELF_IGNORE_TICKS, ROCKET_RANGE, ROCKET_SPEED, ROCKET_WIDTH, BLAST_R, SKILLS, EFFECT_INFO, DEFAULT_SKILLS } from '../shared/constants.js';
import { stepSnake, GapSchedule, makeZonePlan, zoneAt, SegGrid, checkHit, modsAt, distSqPointSeg } from '../shared/sim.js';
import { FLAG_GAP, FLAG_DIED, FLAG_CUT, encodeInput, encodeInputs } from '../shared/protocol.js';

const MIN_INTERP = 2;       // remote snakes are shown at least this many ticks in the past
const MAX_INTERP = 6;       // bigger gaps are bridged by extrapolation instead
const MAX_EXTRAP = 30;      // project other snakes up to 1 s past the newest update
const MAX_PENDING = 120;
const WINDOW = 150;         // ticks of history used to measure jitter (5 s)
export const CHUNK = 64;    // trail points per cached Path2D (renderer)
const UDP_REDUNDANCY = 12;  // each UDP input packet repeats this many recent inputs
// How other snakes are shown (tunable via the URL for experiments, e.g. ?shift=0.5):
//  shift:   0 = in the past (smooth), 1 = at the moment of your own snake (fair)
//  turnavg: ticks of turning history used to project a snake forward
//  glide:   ms over which corrections of projected snakes fade out
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const num = (k, d) => (params.has(k) && !Number.isNaN(Number(params.get(k))) ? Number(params.get(k)) : d);
export const VIEW = { shift: num('shift', 1), turnavg: num('turnavg', 1), glide: num('glide', 200) };
const MIN_LEAD_MARGIN = 1;
const MAX_LEAD_MARGIN = 6;

export class Snake {
  constructor(info) {
    this.id = info.id;
    this.name = info.name;
    this.color = info.color;
    this.style = info.style || 'plain';  // trail style (cosmetic)
    this.bot = info.bot;
    this.cap = 512;
    this.xs = new Float32Array(this.cap);
    this.ys = new Float32Array(this.cap);
    this.as = new Float32Array(this.cap);
    this.fl = new Uint8Array(this.cap);
    this.prov = new Uint8Array(this.cap); // 1 = estimated point, real data still on its way
    this.ws = new Uint8Array(this.cap);   // line width x10 of the segment ending at this point
    this.n = 0;
    this.firstTick = 0;
    this.alive = true;
    this.deathTick = Infinity;
    this.killer = null;
    this.place = 0;
    this.kills = 0;
    this.fuelV = info.fuel || 0;  // fuel (fractional) as of tick fuelT; it refills by itself (ClientGame.fuelOf)
    this.fuelT = info.ft || 0;
    this.skills = info.skills || DEFAULT_SKILLS; // the 2 skills this snake has
    this.chunks = [];      // cached Path2D pieces, owned by the renderer
    this.burstAt = 0;      // when the death effect started (ms)
    this.vox = 0;          // visual offset after extrapolation was corrected (glides to 0)
    this.voy = 0;
  }

  get lastTick() { return this.firstTick + this.n - 1; }

  /** Append the point for the next tick (ticks are contiguous). */
  append(tick, x, y, a, f, prov = 0, w = LINE_WIDTH) {
    if (this.n === 0) this.firstTick = tick;
    if (this.n === this.cap) {
      this.cap *= 2;
      for (const k of ['xs', 'ys', 'as']) {
        const arr = new Float32Array(this.cap);
        arr.set(this[k]);
        this[k] = arr;
      }
      for (const k of ['fl', 'prov', 'ws']) {
        const arr = new Uint8Array(this.cap);
        arr.set(this[k]);
        this[k] = arr;
      }
    }
    const i = this.n++;
    this.xs[i] = x; this.ys[i] = y; this.as[i] = a; this.fl[i] = f; this.prov[i] = prov;
    this.ws[i] = Math.round(w * 10);
  }

  width(i) { return this.ws[i] / 10; }

  /** Replace an estimated point with real data. Returns true if it changed something. */
  fill(i, x, y, a, f, w = LINE_WIDTH) {
    if (!this.prov[i]) return false;
    this.xs[i] = x; this.ys[i] = y; this.as[i] = a; this.fl[i] = f; this.prov[i] = 0;
    this.ws[i] = Math.round(w * 10);
    this.dirty(i);
    return true;
  }

  /** Cached trail pieces containing point i must be rebuilt. */
  dirty(i) {
    delete this.chunks[Math.floor(i / CHUNK)];
    if (i % CHUNK === 0 && i > 0) delete this.chunks[i / CHUNK - 1];
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
      s.append(msg.tick, p.x, p.y, p.a, 0);
      this.snakes.set(p.id, s);
    }
    this.list = [...this.snakes.values()];
    this.total = this.list.length;
    this.aliveCount = this.total;
    this.me = this.snakes.get(this.myId);
    this.grid = new SegGrid();
    this.latestTick = msg.tick;
    this.items = new Map((msg.items || []).map((it) => [it.id, it]));
    this.effects = [];        // power-up effects {type, start, end, targets}
    this.popups = [];         // floating pickup texts {x, y, text, good, at}
    this.flyers = [];         // collected fuel dots flying into a head {x, y, sn, at}
    this.rockets = new Map(); // id -> {by, x, y, a, tick, end: {x, y, tick} | null}
    this.holes = [];          // rocket holes {x, y, r, at, shown}: drawn once the server reaches `at`
    this.lastFireAt = 0;
    this.skillAt = {};
    this.pendingCost = 0;     // fuel of skills sent that the server hasn't answered yet
    this.tmpMods = {};

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
    this.stats = { reconciles: 0, corrections: 0, maxErr: 0, late: 0, viaUdp: 0, viaWs: 0, filled: 0 };

    // clock, input lead, jitter
    this.clockOffset = null;
    this.margin = 2;          // extra ticks of lead on top of the round trip
    this.lead = null;         // smoothed lead actually used (ticks)
    this.slackHist = [];
    this.starvedAt = -1e9;
    this.starveRun = 0;       // consecutive ticks our input was missing
    this.marginChangedAt = -1e9;
    this.offsetTau = 120;     // ms to blend out the current correction
    this.lateHist = [];
    this.interpTarget = MIN_INTERP + 1;
    this.interp = MIN_INTERP + 1;
    this.lastRenderNow = 0;
    this.lastFrameNow = 0;
    this.lastRt = 0;
    this.shift = 0;           // ticks remote snakes are shown ahead of the interpolation time
  }

  // ---- server messages -------------------------------------------------

  /**
   * A tick message from the server, via UDP or WebSocket (usually both: the
   * first copy wins). Returns true if it was the newest tick so far.
   */
  onTick(d, via = 'ws') {
    if (d.tick <= this.latestTick) {
      this.fillLate(d);
      return false;
    }
    if (via === 'udp') this.stats.viaUdp++; else this.stats.viaWs++;

    // Remote snakes we were extrapolating: remember where we showed them, so the
    // switch to real data can glide instead of jump.
    const rt = this.lastRt;
    const shown = [];
    for (const s of this.list) {
      if (s !== this.me && s.alive && rt > s.lastTick) {
        const ex = this.extrapolate(s, rt);
        if (ex) shown.push([s, ex.head.x, ex.head.y]);
      }
    }

    let mine = null;
    for (const e of d.entries) {
      const s = this.snakes.get(e.id);
      if (!s || d.tick <= s.lastTick) continue;
      // Ticks that UDP lost: estimate them now; the WebSocket copy fixes them soon.
      const gap = d.tick - s.lastTick;
      for (let k = 1; k < gap; k++) {
        const i = s.n - 1, f = 1 / (gap - k + 1);
        const t = s.lastTick + 1;
        let da = e.a - s.as[i];
        if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
        const fl = t > this.playTick && s.gaps.isGap(t - this.playTick) ? FLAG_GAP : 0;
        s.append(t, s.xs[i] + (e.x - s.xs[i]) * f, s.ys[i] + (e.y - s.ys[i]) * f, s.as[i] + da * f, fl, 1, s.width(i));
        this.addSegment(s, t);
      }
      s.append(d.tick, e.x, e.y, e.a, e.flags, 0, e.width || LINE_WIDTH);
      this.addSegment(s, d.tick);
      s.future = e.future;          // turns for ticks d.tick+1 ... (may be null)
      s.futureFrom = d.tick + 1;
      if (e.flags & FLAG_DIED) {
        s.alive = false;
        s.deathTick = d.tick;
      }
      if (e.id === this.myId) mine = e;
    }
    this.latestTick = d.tick;

    for (const [s, x, y] of shown) {
      const real = rt <= s.lastTick ? s.headAt(rt, { x: 0, y: 0, a: 0 }) : this.extrapolate(s, rt)?.head;
      if (!real) continue;
      const dx = x - real.x, dy = y - real.y;
      if (dx * dx + dy * dy < 100 * 100) { s.vox += dx; s.voy += dy; }
    }

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
    if (this.holes.length || this.rockets.size || this.pendingCost) this.applyHoles();
    return true;
  }

  addSegment(s, tick) {
    const i = s.n - 1;
    this.cutPoint(s, i, tick);
    if (tick > this.playTick && i > 0 && !(s.fl[i] & FLAG_GAP) && !(s.fl[i - 1] & FLAG_GAP)) {
      this.grid.add(s.xs[i - 1], s.ys[i - 1], s.xs[i], s.ys[i], s.id, tick, s.width(i));
    }
  }

  /** A copy of an older tick: replace estimated points with the real ones. */
  fillLate(d) {
    for (const e of d.entries) {
      const s = this.snakes.get(e.id);
      if (!s) continue;
      const i = d.tick - s.firstTick;
      if (i === s.n) {
        // a snake that just died: its final tick only came through this copy
        s.append(d.tick, e.x, e.y, e.a, e.flags, 0, e.width || LINE_WIDTH);
      } else if (i >= 0 && i < s.n && s.fill(i, e.x, e.y, e.a, e.flags, e.width || LINE_WIDTH)) {
        this.stats.filled++;
        this.cutPoint(s, i, d.tick);
      }
      if (e.flags & FLAG_DIED) {
        s.alive = false;
        s.deathTick = Math.min(s.deathTick, d.tick);
      }
    }
  }

  /**
   * Input lead control. The server reports the newest input tick it has
   * received; "slack" is how many ticks early our inputs arrive. If an input
   * was missing for a tick or a few (jitter), add a tick of margin. A long
   * blackout (connection silent for a fraction of a second) is ignored: no
   * sensible margin covers it, extra margin would only add delay. After 5 quiet
   * seconds with plenty of slack, take margin away again.
   */
  adaptLead(d) {
    if (d.tick <= 30) return; // the first second: our first inputs are still on the way
    const slack = d.lastInput - d.tick;
    pushWindow(this.slackHist, slack);
    if (d.starved) {
      this.stats.late++;
      this.starvedAt = d.tick;
      this.starveRun++;
      return;
    }
    if (this.starveRun) {
      if (this.starveRun <= 4 && d.tick - this.marginChangedAt > 30) {
        this.margin = Math.min(MAX_LEAD_MARGIN, this.margin + 1);
        this.marginChangedAt = d.tick;
      }
      this.starveRun = 0;
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

  // ---- rockets -----------------------------------------------------------

  /** Can we use skill `k` right now? */
  canUse(k) {
    const def = SKILLS[k];
    if (!def || !this.controlling || !this.me || !this.me.skills.includes(k) || this.myFuel < def.cost) return false;
    if (this.lastTarget === null || this.lastTarget <= this.playTick) return false; // countdown
    if (def.effect) {
      // not while the same one is still running
      const t = this.lastTarget + 1;
      if (this.effects.some((e) => e.type === def.effect && e.end > t && e.targets.includes(this.myId))) return false;
    }
    return true;
  }

  /**
   * Use a skill. Jump, boost and brake start on the next tick we simulate, right
   * away in our own prediction; the server starts them on that same tick (the
   * message is stamped with it), so nothing needs correcting. Returns true if used.
   */
  useSkill(k) {
    const now = performance.now();
    if (!this.canUse(k) || now - (this.skillAt[k] || 0) < 250) return false;
    this.skillAt[k] = now;
    if (k === 'rocket') return this.fire();
    const def = SKILLS[k];
    const start = this.lastTarget + 1;
    this.net.send({ t: 'skill', k, tick: start });
    this.effects.push({ type: def.effect, start, end: start + Math.round(def.secs * 30), targets: [this.myId], local: k, at: now });
    this.spend(def.cost);
    this.onEvent({ type: 'skill', k, by: this.me, mine: true });
    return true;
  }

  // Our fuel = the server's amount minus skills it hasn't answered yet, so a
  // pickup message in between doesn't make a used skill look ready again.
  spend(cost) { this.pendingCost += cost; }
  settled(cost) { this.pendingCost = Math.max(0, this.pendingCost - cost); }
  /** The server's fuel for a snake on tick `ft` (it refills by itself from there). */
  setFuel(s, fuel, ft) {
    if (!s || typeof fuel !== 'number') return;
    s.fuelV = fuel;
    s.fuelT = ft ?? this.latestTick;
  }
  /** Fuel of a snake now (our own: at the tick we show it at, minus skills not answered yet). */
  fuelOf(s) {
    if (!s) return 0;
    const mine = s === this.me;
    const tick = mine && this.controlling && this.lastTarget !== null ? this.lastTarget : this.latestTick;
    const ticks = Math.max(0, tick - Math.max(s.fuelT, this.playTick));
    const v = Math.min(MAX_FUEL, s.fuelV + (FUEL_REGEN / 30) * ticks);
    return mine ? Math.max(0, v - this.pendingCost) : v;
  }
  get myFuel() { return this.fuelOf(this.me); }

  /** The server used (or refused) a skill. */
  onSkill(m) {
    const s = this.snakes.get(m.by);
    if (m.by === this.myId) {
      // replace our local copy (the oldest one for this skill)
      const i = this.effects.findIndex((e) => e.local === m.k);
      if (i >= 0) this.effects.splice(i, 1);
      if (!m.ok && m.k === 'rocket') for (const [id, rk] of this.rockets) if (rk.local) { this.rockets.delete(id); break; }
      this.pendingCost = Math.max(0, this.pendingCost - SKILLS[m.k].cost);
    }
    this.setFuel(s, m.fuel, m.ft);
    if (m.ok && m.k !== 'rocket') {
      this.effects.push({ type: SKILLS[m.k].effect, start: m.start, end: m.end, targets: [m.by] });
      if (m.by !== this.myId) this.onEvent({ type: 'skill', k: m.k, by: s, mine: false });
    }
    this.effects = this.effects.filter((e) => e.end > this.latestTick - 30);
  }

  /** Fire a rocket. Returns true if one is on its way. */
  fire() {
    const now = performance.now();
    this.lastFireAt = now;
    this.spend(SKILLS.rocket.cost);
    this.onEvent({ type: 'skill', k: 'rocket', by: this.me, mine: true });
    // Stamped with the tick we're showing our snake at, so it leaves from there.
    const tick = this.lastTarget;
    this.net.send({ t: 'skill', k: 'rocket', tick });
    // Draw it right away from our predicted head (the server's copy takes over when it arrives).
    const p = this.pred, w = modsAt(this.effects, this.myId, tick, {}).width;
    void w;
    const local = { by: this.myId, x: p.x + Math.cos(p.a) * 2, y: p.y + Math.sin(p.a) * 2, a: p.a, tick, end: null, local: true, firedAt: now };
    local.predEnd = this.predictRocket(local);
    // Our own prediction: open the hole where we expect the hit, so our snake doesn't
    // stop at the line while the server's answer is on its way.
    if (local.predEnd.hit) {
      const d = local.predEnd.d, hitTick = tick + Math.max(0, Math.ceil(d / (ROCKET_SPEED * DT)) - 1);
      this.grid.blast(local.x + Math.cos(p.a) * d, local.y + Math.sin(p.a) * d, BLAST_R, hitTick);
    }
    this.rockets.set('local:' + tick, local);
    return true;
  }

  onRocket(m) {
    const s = this.snakes.get(m.by);
    if (m.by === this.myId) this.pendingCost = Math.max(0, this.pendingCost - SKILLS.rocket.cost);
    this.setFuel(s, m.fuel, m.ft);
    const rk = { by: m.by, x: m.x, y: m.y, a: m.a, tick: m.tick, end: null, predEnd: this.predictRocket(m) };
    // Our own shot: it replaces the oldest local copy, keeping what's already on
    // screen (e.g. an explosion that started).
    let localKey = null;
    if (m.by === this.myId) {
      for (const [k, r] of this.rockets) if (r.local && (localKey === null || r.tick < this.rockets.get(localKey).tick)) localKey = k;
    }
    const local = localKey !== null ? this.rockets.get(localKey) : null;
    if (local) {
      this.rockets.delete(localKey);
      for (const k of ['impactAt', 'ix', 'iy', 'blew']) if (local[k] !== undefined) rk[k] = local[k];
    }
    this.rockets.set(m.id, rk);
    this.onEvent({ type: 'rocket', msg: m, by: s });
  }

  /**
   * Where a rocket will hit, from the lines we know about (same checks as the
   * server). Lets us stop it right at the line instead of flying on until the
   * server's verdict arrives. Returns {d: distance flown, hit: true if it hits a line}.
   */
  predictRocket(m) {
    const zone = zoneAt(this.plan, m.tick - this.playTick);
    const step = 5, cx = Math.cos(m.a) * step, cy = Math.sin(m.a) * step;
    let x = m.x, y = m.y;
    for (let d = step; d <= ROCKET_RANGE; d += step) {
      x += cx; y += cy;
      if (this.grid.hit(x, y, ROCKET_WIDTH, m.by, m.tick - SELF_IGNORE_TICKS, m.tick + Math.round(d / (ROCKET_SPEED * DT))) !== -2) return { d, hit: true };
      if (Math.hypot(x - zone.x, y - zone.y) > zone.r) return { d, hit: false };
    }
    return { d: ROCKET_RANGE, hit: false };
  }

  onBlast(m) {
    const rk = this.rockets.get(m.id);
    if (rk) rk.end = { x: m.x, y: m.y, r: m.r, tick: m.at };
    if (m.r > 0) {
      this.grid.blast(m.x, m.y, m.r, m.at); // collisions: gone from tick `at` on, like on the server
      const hole = { x: m.x, y: m.y, r: m.r, at: m.at, by: m.by, shown: false };
      this.holes.push(hole);
      if (rk) rk.hole = hole;
      this.applyHoles(); // snake data (UDP) may already be past `at`
    }
  }

  /** Once the server has reached a hole's tick, cut it out of the drawn trails too. */
  applyHoles() {
    for (const h of this.holes) {
      if (h.shown || this.latestTick < h.at) continue;
      h.shown = true;
      h.shownAt = performance.now();
      for (const s of this.list) {
        const last = Math.min(s.n - 1, h.at - s.firstTick);
        for (let i = 1; i <= last; i++) this.cutOne(s, i, h);
      }
      this.onEvent({ type: 'hole', hole: h });
    }
    // forget old ones (rockets after their flight, holes once nothing new can be cut)
    if (this.holes.length > 8) this.holes = this.holes.filter((h) => !h.shown || h.at > this.latestTick - 60);
    const now = performance.now();
    for (const [id, rk] of this.rockets) {
      if (rk.local && now - rk.firedAt > 1500) { this.rockets.delete(id); this.settled(SKILLS.rocket.cost); } // never answered
      else if (rk.end && rk.end.tick < this.latestTick - 60) this.rockets.delete(id);
    }
    // a skill the server never answered (lost message): undo it
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      if (e.local && now - e.at > 1500) { this.effects.splice(i, 1); this.settled(SKILLS[e.local].cost); }
    }
    this.grid.pruneBlasts(this.latestTick - 60);
  }

  /** A point that arrives (or is corrected) after a hole was cut. */
  cutPoint(s, i, tick) {
    if (!this.holes.length || i < 1) return;
    for (const h of this.holes) if (h.shown && tick <= h.at) this.cutOne(s, i, h);
  }

  cutOne(s, i, h) {
    if (s.fl[i] & FLAG_CUT) return;
    if (distSqPointSeg(h.x, h.y, s.xs[i - 1], s.ys[i - 1], s.xs[i], s.ys[i]) < h.r * h.r) {
      s.fl[i] |= FLAG_CUT;
      s.dirty(i);
    }
  }

  onItems(m) {
    for (const id of m.rem || []) this.items.delete(id);
    const now = performance.now();
    for (const it of m.add || []) { it.bornAt = now; this.items.set(it.id, it); } // pops in
  }

  onPickup(m) {
    const it = this.items.get(m.item);
    const by0 = this.snakes.get(m.by);
    if (by0 && !(it && it.localPick && m.by === this.myId)) this.flyers.push({ x: m.x, y: m.y, sn: by0, at: performance.now() });
    this.items.delete(m.item);
    const by = this.snakes.get(m.by);
    this.setFuel(by, m.fuel, m.ft);
    this.onEvent({ type: 'pickup', msg: m, def: FUEL, by });
  }

  /** Skill effects on our snake right now: [{type, def, left (s), total (s), pending}] */
  myEffects(now) {
    // our own snake runs ahead of the server: use the tick we're showing it at
    const t = this.controlling && this.lastTarget !== null ? this.lastTarget + this.alpha : this.serverTickNow(now);
    const byType = new Map(); // one entry per type (picking up the same one twice stacks)
    for (const e of this.effects) {
      if (e.end <= t || !e.targets.includes(this.myId)) continue;
      const left = (e.end - Math.max(t, e.start)) / 30;
      const cur = byType.get(e.type);
      if (!cur || left > cur.left) byType.set(e.type, { type: e.type, def: EFFECT_INFO[e.type] || { label: e.type, icon: '', good: true }, left, total: (e.end - e.start) / 30, pending: t < e.start });
    }
    return [...byType.values()];
  }

  /** Current modifiers of any snake (for drawing). */
  modsNow(s, tick, out) { return modsAt(this.effects, s.id, tick, out); }

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
    let sent = false;
    while (this.lastTarget < target) {
      const t = ++this.lastTarget;
      // `turn` can be a function of our heading (the phone's steering stick)
      const tr = typeof turn === 'function' ? turn(this.pred.a) : turn;
      this.net.sendBinary(encodeInput(t, tr));
      this.pending.push({ tick: t, turn: tr });
      if (this.pending.length > MAX_PENDING) this.pending.shift();
      this.advanceTo(t, tr);
      sent = true;
    }
    if (sent) this.sendUdpInputs();
    this.alpha = Math.max(0, Math.min(1, targetF - target));
  }

  /** Over UDP, every packet repeats the recent inputs: losing one costs nothing. */
  sendUdpInputs() {
    const P = this.pending;
    if (!P.length || !this.net.udpOpen) return;
    const turns = [];
    let expect = P[P.length - 1].tick;
    for (let i = P.length - 1; i >= 0 && turns.length < UDP_REDUNDANCY && P[i].tick === expect; i--, expect--) {
      turns.unshift(P[i].turn);
    }
    this.net.sendUdp(encodeInputs(P[P.length - 1].tick, turns));
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
      const m = modsAt(this.effects, this.myId, tt, this.tmpMods);
      if (!this.predStopped && tt > this.playTick) {
        stepSnake(p, m.reverse ? -tr : tr, m.speed);
        // Stop at an obvious crash instead of sliding through a line while we
        // wait for the server's verdict.
        if (checkHit(this.grid, zoneAt(this.plan, tt - this.playTick), p.x, p.y, this.myId, tt, m.width, m.ghost || m.shield) !== null) {
          this.predStopped = true;
        }
        // Hide a power-up we're about to collect (the server confirms it shortly).
        for (const it of this.items.values()) {
          if (it.type === 'fuel' && this.myFuel >= MAX_FUEL - 0.5) continue; // (nearly) full: the server leaves it
          if ((!it.localPick || performance.now() - it.localPick > 800) && Math.hypot(it.x - p.x, it.y - p.y) < FUEL_PICK_R + m.width / 2) {
            // we're about to collect it (the server confirms shortly): it flies into our head now
            it.localPick = performance.now();
            this.flyers.push({ x: it.x, y: it.y, sn: this.me, at: it.localPick });
          }
        }
      }
      this.path.push({ x: p.x, y: p.y, a: p.a, t: tt, w: m.width, solid: !m.ghost && (tt <= this.playTick || !this.myGaps.isGap(tt - this.playTick)) });
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
    if (dx * dx + dy * dy < 150 * 150) {
      this.offset.x += dx; this.offset.y += dy;
      // Small corrections vanish quickly; big ones (after a blackout) glide
      // over up to ~0.4 s so the snake never visibly jumps.
      const size = Math.hypot(this.offset.x, this.offset.y);
      this.offsetTau = Math.min(400, Math.max(this.offsetTau, 100 + size * 6));
    } else { this.offset.x = 0; this.offset.y = 0; }
  }

  decayOffset(dtMs) {
    const k = Math.exp(-dtMs / this.offsetTau);
    this.offset.x *= k;
    this.offset.y *= k;
    if (Math.hypot(this.offset.x, this.offset.y) < 1) this.offsetTau = 120;
    const kr = Math.exp(-dtMs / VIEW.glide);
    for (const s of this.list) {
      if (s.vox || s.voy) {
        s.vox *= kr; s.voy *= kr;
        if (Math.abs(s.vox) + Math.abs(s.voy) < 0.05) s.vox = s.voy = 0;
      }
    }
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
    // While we control a snake, show the others at the moment our own snake is
    // shown (lead - 1 ticks ahead of server time), instead of in the past. The
    // shift eases in and out so nobody visibly jumps or runs backwards.
    const want = this.controlling && this.lead !== null ? (this.lead - 1 + this.interp) * VIEW.shift : 0;
    const maxStep = 10 * dt / 1000;
    this.shift += Math.max(-maxStep, Math.min(maxStep, want - this.shift));
    let t = this.serverTickNow(now) - this.interp + this.shift;
    if (t > this.latestTick + MAX_EXTRAP) t = this.latestTick + MAX_EXTRAP;
    if (t < this.latestTick - MAX_INTERP - 3) t = this.latestTick - MAX_INTERP - 3;
    this.lastRt = t;
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
    // Known upcoming turns (from the server) are exact. Past those, assume the
    // snake keeps its last known turn.
    const fut = s.future && s.futureFrom === s.lastTick + 1 ? s.future : null;
    const guess = fut && fut.length ? fut[fut.length - 1] : this.recentTurn(s, i);
    const turnAt = (j) => (fut && j - 1 < fut.length ? fut[j - 1] : guess);
    const st = { x: s.xs[i], y: s.ys[i], a: s.as[i] };
    const pts = [];
    const whole = Math.floor(k);
    const m = this.tmpExMods || (this.tmpExMods = {});
    const solidAt = (t) => !m.ghost && (t <= this.playTick || !s.gaps.isGap(t - this.playTick));
    // One zone lookup: the zone at the end is the strictest (it only shrinks).
    const zone = zoneAt(this.plan, s.lastTick + whole + 1 - this.playTick);
    for (let j = 1; j <= whole + 1; j++) {
      const t = s.lastTick + j;
      const nx = { x: st.x, y: st.y, a: st.a };
      modsAt(this.effects, s.id, t, m);
      if (t > this.playTick) stepSnake(nx, m.reverse ? -turnAt(j) : turnAt(j), m.speed);
      if (t > this.playTick && checkHit(this.grid, zone, nx.x, nx.y, s.id, t, m.width, m.ghost || m.shield) !== null) {
        return { pts, head: st };
      }
      if (j > whole) {
        // fractional last step
        const f = k - whole;
        const head = { x: st.x + (nx.x - st.x) * f, y: st.y + (nx.y - st.y) * f, a: nx.a };
        if (f > 0) pts.push({ x: head.x, y: head.y, w: m.width, solid: solidAt(t) });
        return { pts, head };
      }
      st.x = nx.x; st.y = nx.y; st.a = nx.a;
      pts.push({ x: st.x, y: st.y, w: m.width, solid: solidAt(t) });
    }
    return { pts, head: st };
  }

  /**
   * Which way a snake is turning, for projecting it forward. With turnavg > 1
   * this is a recency-weighted average of its last ticks (a fraction between -1
   * and 1): a snake that zig-zags is projected nearly straight, which is what
   * it does on average, instead of flipping left/right with every update.
   */
  recentTurn(s, i) {
    const n = Math.max(1, Math.round(VIEW.turnavg));
    if (i < 1) return 0;
    if (n === 1) {
      let da = s.as[i] - s.as[i - 1];
      if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
      return Math.abs(da) > TURN_RATE * DT * 0.5 ? Math.sign(da) : 0;
    }
    let sum = 0, wsum = 0, w = 1;
    for (let j = 0; j < n && i - j > 0; j++, w *= 0.75) {
      if (s.firstTick + i - j <= this.playTick) break;
      let da = s.as[i - j] - s.as[i - j - 1];
      if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
      sum += w * Math.max(-1, Math.min(1, da / (TURN_RATE * DT)));
      wsum += w;
    }
    return wsum ? sum / wsum : 0;
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
