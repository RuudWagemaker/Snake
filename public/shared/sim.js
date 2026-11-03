// Deterministic simulation rules shared by server and client.
import {
  DT, SPEED, TURN_RATE, LINE_WIDTH, SELF_IGNORE_TICKS, GRID_CELL, SPEED_MUL, SLOW_MUL, MIN_WIDTH, MAX_WIDTH,
  GAP_LEN_TICKS, GAP_FIRST_MIN, GAP_FIRST_MAX, GAP_INTERVAL_MIN, GAP_INTERVAL_MAX,
  ZONE_PHASES, TICK_RATE, KILLER_ZONE,
} from './constants.js';

const TAU = Math.PI * 2;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Advance a snake head one tick. `turn` is -1 (left), 0 or 1 (right).
 * Values are rounded to float32 so the client can replay from the exact
 * state the server sends over the wire (which is float32).
 */
export function stepSnake(s, turn, speed = 1) {
  let a = s.a + turn * TURN_RATE * DT;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  a = Math.fround(a);
  s.a = a;
  s.x = Math.fround(s.x + Math.cos(a) * SPEED * speed * DT);
  s.y = Math.fround(s.y + Math.sin(a) * SPEED * speed * DT);
}

/**
 * Active power-up modifiers for snake `id` on tick `t`. `effects` is a list of
 * {type, start, end, targets: [ids]}; an effect is active for start <= t < end.
 * Writes into and returns `out` ({speed, width, reverse, ghost}).
 */
export function modsAt(effects, id, t, out = {}) {
  let speed = 1, width = LINE_WIDTH, reverse = false, ghost = false, shield = false;
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    if (t < e.start || t >= e.end || !e.targets.includes(id)) continue;
    switch (e.type) {
      case 'speed': case 'fast': speed *= SPEED_MUL; break;
      case 'ghost': ghost = true; break;
      case 'shield': shield = true; break;   // lines can't kill you, but you still draw one
      case 'slow': speed *= SLOW_MUL; break;
      case 'thin': width *= 0.5; break;
      case 'fat': width *= 2; break;
      case 'reverse': reverse = !reverse; break;
    }
  }
  out.speed = Math.min(speed, SPEED_MUL * SPEED_MUL);
  out.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
  out.reverse = reverse;
  out.ghost = ghost;
  out.shield = shield;
  return out;
}

/** Contact distance between a head (width hw) and a line (width lw). */
export const hitDist = (hw, lw) => 0.45 * (hw + lw);

/**
 * Gap timing is a pure function of (round seed, player id, ticks moved), so the
 * client can predict its own gaps exactly instead of waiting for the server.
 */
export class GapSchedule {
  constructor(seed, id) {
    this.rng = mulberry32((seed ^ Math.imul(id + 1, 0x9e3779b1)) >>> 0);
    this.starts = [GAP_FIRST_MIN + Math.floor(this.rng() * (GAP_FIRST_MAX - GAP_FIRST_MIN))];
  }
  // t = ticks since movement started (1 = first moving tick)
  isGap(t) {
    const st = this.starts;
    while (st[st.length - 1] <= t) {
      const iv = GAP_INTERVAL_MIN + Math.floor(this.rng() * (GAP_INTERVAL_MAX - GAP_INTERVAL_MIN));
      st.push(st[st.length - 1] + GAP_LEN_TICKS + iv);
    }
    // binary search for the last start <= t
    let lo = 0, hi = st.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (st[mid] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx >= 0 && t < st[idx] + GAP_LEN_TICKS;
  }
}

/** Build the zone plan for a round. Same seed => same plan on server and client. */
export function makeZonePlan(seed, R0) {
  const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  let c = { x: 0, y: 0, r: R0 };
  const phases = [];
  let t = 0;
  for (const ph of ZONE_PHASES) {
    const r2 = c.r * ph.f;
    const maxOff = (c.r - r2) * 0.85;
    const ang = rng() * TAU;
    const d = Math.sqrt(rng()) * maxOff;
    const n = { x: c.x + Math.cos(ang) * d, y: c.y + Math.sin(ang) * d, r: r2 };
    const shrinkStart = t + ph.hold * TICK_RATE;
    const end = shrinkStart + ph.shrink * TICK_RATE;
    phases.push({ from: c, to: n, shrinkStart, end });
    t = end;
    c = n;
  }
  return { R0, phases };
}

/** Zone circle at `t` ticks after movement started (fractional ok). */
export function zoneAt(plan, t) {
  if (t < 0) t = 0;
  for (let i = 0; i < plan.phases.length; i++) {
    const ph = plan.phases[i];
    if (t < ph.shrinkStart) {
      return { x: ph.from.x, y: ph.from.y, r: ph.from.r, next: ph.to, shrinking: false, ticksLeft: ph.shrinkStart - t, phase: i };
    }
    if (t < ph.end) {
      const k = (t - ph.shrinkStart) / (ph.end - ph.shrinkStart);
      return {
        x: ph.from.x + (ph.to.x - ph.from.x) * k,
        y: ph.from.y + (ph.to.y - ph.from.y) * k,
        r: ph.from.r + (ph.to.r - ph.from.r) * k,
        next: ph.to, shrinking: true, ticksLeft: ph.end - t, phase: i,
      };
    }
  }
  const last = plan.phases[plan.phases.length - 1].to;
  return { x: last.x, y: last.y, r: 0, next: null, shrinking: false, ticksLeft: 0, phase: plan.phases.length };
}

/** Spatial hash of trail segments for fast collision checks. */
export class SegGrid {
  constructor(cell = GRID_CELL) {
    this.cell = cell;
    this.cells = new Map();
    this.x1 = []; this.y1 = []; this.x2 = []; this.y2 = [];
    this.owner = []; this.tick = []; this.w = [];
  }
  get size() { return this.owner.length; }
  _key(cx, cy) { return (cx + 32768) * 65536 + (cy + 32768); }
  add(x1, y1, x2, y2, owner, tick, width = LINE_WIDTH) {
    const i = this.owner.length;
    this.x1.push(x1); this.y1.push(y1); this.x2.push(x2); this.y2.push(y2);
    this.owner.push(owner); this.tick.push(tick); this.w.push(width);
    const c = this.cell;
    const cx0 = Math.floor(Math.min(x1, x2) / c), cx1 = Math.floor(Math.max(x1, x2) / c);
    const cy0 = Math.floor(Math.min(y1, y2) / c), cy1 = Math.floor(Math.max(y1, y2) / c);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = this._key(cx, cy);
        let arr = this.cells.get(k);
        if (!arr) { arr = []; this.cells.set(k, arr); }
        arr.push(i);
      }
    }
  }
  /**
   * Returns the owner of the first segment touching a head of width `hw` at
   * (px,py), or -2 if none. Segments owned by `selfId` newer than `selfMinTick`
   * are ignored (the neck).
   */
  hit(px, py, hw, selfId, selfMinTick) {
    const c = this.cell, r = hitDist(hw, MAX_WIDTH);
    const cx0 = Math.floor((px - r) / c), cx1 = Math.floor((px + r) / c);
    const cy0 = Math.floor((py - r) / c), cy1 = Math.floor((py + r) / c);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const arr = this.cells.get(this._key(cx, cy));
        if (!arr) continue;
        for (let j = 0; j < arr.length; j++) {
          const i = arr[j];
          if (this.owner[i] === selfId && this.tick[i] > selfMinTick) continue;
          const d = hitDist(hw, this.w[i]);
          if (distSqPointSeg(px, py, this.x1[i], this.y1[i], this.x2[i], this.y2[i]) < d * d) return this.owner[i];
        }
      }
    }
    return -2;
  }
}

export function distSqPointSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = x1 + dx * t - px, ey = y1 + dy * t - py;
  return ex * ex + ey * ey;
}

/**
 * Collision check for a head at (x,y) on tick `t`.
 * Returns null if safe, KILLER_ZONE for the zone, or the owner id of the trail hit.
 */
export function checkHit(grid, zone, x, y, id, t, width = LINE_WIDTH, ghost = false) {
  const dx = x - zone.x, dy = y - zone.y;
  const rr = zone.r - width / 2;
  if (rr <= 0 || dx * dx + dy * dy > rr * rr) return KILLER_ZONE;
  if (ghost) return null; // ghosts pass through lines (not through the zone)
  const o = grid.hit(x, y, width, id, t - SELF_IGNORE_TICKS);
  return o === -2 ? null : o;
}
