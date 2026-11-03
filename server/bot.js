import { stepSnake, zoneAt, checkHit } from '../public/shared/sim.js';

const NAMES = [
  'Noodle', 'Zigzag', 'Squiggle', 'Viper', 'Slinky', 'Wiggles', 'Kurve', 'Lasso',
  'Spiral', 'Sidewinder', 'Mamba', 'Doodle', 'Scribble', 'Comet', 'Ribbon', 'Loop',
  'Twister', 'Cobra', 'Swoosh', 'Pretzel', 'Neon', 'Streak', 'Hiss', 'Drift',
];

export function botName(rng, used) {
  for (let i = 0; i < 20; i++) {
    const n = NAMES[Math.floor(rng() * NAMES.length)];
    if (!used.has(n)) { used.add(n); return n; }
  }
  const n = 'Bot' + Math.floor(rng() * 1000);
  used.add(n);
  return n;
}

// Candidate manoeuvres: [turn, ticks to hold the turn before going straight]
const SIM = { x: 0, y: 0, a: 0 };
const OPTIONS = [[0, 0], [-1, 999], [1, 999], [-1, 8], [1, 8], [-1, 18], [1, 18]];

/**
 * Simple look-ahead AI: simulate each manoeuvre a short time into the future,
 * prefer the one that survives longest, and lean towards the safe zone.
 */
export function botThink(p, round, zone, zt, t) {
  let b = p.brain;
  if (!b) {
    // Room skill k (0 = beginners, 1 = experienced players) sets how good the
    // bots are, so new players aren't thrown in with the sharpest bots.
    const k = round.botSkill ?? 1;
    b = p.brain = {
      next: 0,
      turn: 0,
      horizon: Math.round(14 + 8 * k + Math.random() * (18 + 8 * k)), // how far it looks ahead
      react: 2 + Math.floor(Math.random() * 3) + (k < 0.4 ? 1 : 0),   // how often it thinks
      wander: 0,
      wanderUntil: 0,
      spin: 0, // decaying sum of recent turning; large = about to close a loop
    };
    b.next = t + (p.id % b.react); // spread bots' thinking over different ticks
  }
  b.spin = b.spin * 0.97 + b.turn;
  if (t < b.next) return b.turn;
  b.next = t + b.react;

  if (t >= b.wanderUntil) {
    const r = Math.random();
    b.wander = r < 0.5 ? 0 : r < 0.75 ? -1 : 1;
    b.wanderUntil = t + 8 + Math.floor(Math.random() * 30);
  }

  const target = zone.next && zone.ticksLeft < 300 ? zone.next : zone;
  const safeR = Math.max(target.r * 0.55, 1);
  // The zone only shrinks and each circle sits inside the previous one, so the
  // zone at the end of the look-ahead is the strictest. One lookup per decision
  // instead of one per simulated step keeps the server cheap.
  const zEnd = zoneAt(round.plan, zt + b.horizon);
  const s = SIM;
  let bestScore = -Infinity, bestTurn = 0;

  for (const [turn, hold] of OPTIONS) {
    s.x = p.x; s.y = p.y; s.a = p.a;
    let survived = b.horizon;
    for (let k = 1; k <= b.horizon; k++) {
      stepSnake(s, k <= hold ? turn : 0, p.speed || 1);
      if (k <= 4 || (k & 1) === 0) {
        if (checkHit(round.grid, zEnd, s.x, s.y, p.id, t + k) !== null) { survived = k; break; }
      }
    }
    let score = survived * 10;
    if (survived === b.horizon) {
      // Reward paths that end up facing open space.
      const tt = t + b.horizon + 10; // far enough ahead that our own neck counts as an obstacle
      score += 0.06 * (ray(round, zEnd, s.x, s.y, s.a, p.id, tt) +
        0.6 * ray(round, zEnd, s.x, s.y, s.a - 0.7, p.id, tt) +
        0.6 * ray(round, zEnd, s.x, s.y, s.a + 0.7, p.id, tt));
    }
    const d = Math.hypot(s.x - target.x, s.y - target.y);
    if (d > safeR) score -= ((d - safeR) / safeR) * 25;
    // Go for nearby power-ups (survival still matters far more).
    if (survived === b.horizon) {
      let best = 260;
      for (const it of round.items) {
        const dd = Math.hypot(s.x - it.x, s.y - it.y);
        if (dd < best) best = dd;
      }
      if (best < 260) score += (1 - best / 260) * 12;
    }
    if (turn === b.turn) score += 2;
    if (turn !== 0 && Math.sign(b.spin) === turn && Math.abs(b.spin) > 16) score -= 15;
    if (turn === b.wander) score += 3;
    score += Math.random();
    if (score > bestScore) { bestScore = score; bestTurn = turn; }
  }
  b.turn = bestTurn;
  return bestTurn;
}

const RAY_STEP = 12;
const RAY_MAX = 180;
function ray(round, zone, x, y, a, id, t) {
  const dx = Math.cos(a) * RAY_STEP, dy = Math.sin(a) * RAY_STEP;
  for (let d = RAY_STEP; d <= RAY_MAX; d += RAY_STEP) {
    x += dx; y += dy;
    if (checkHit(round.grid, zone, x, y, id, t) !== null) return d;
  }
  return RAY_MAX;
}
