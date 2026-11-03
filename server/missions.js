// Daily missions: three small goals a day that give bonus XP. Everyone gets the
// same three, picked from POOL with the date as the random seed. Missions from
// the same `group` never show up on the same day.

// count(m) says how much one match adds. m = { place, n, kills, picks: {type: count} }
export const POOL = [
  { id: 'kills2', group: 'kills', text: 'Get 2 kills', goal: 2, xp: 20, count: (m) => m.kills },
  { id: 'kills5', group: 'kills', text: 'Get 5 kills', goal: 5, xp: 35, count: (m) => m.kills },
  { id: 'multi', group: 'kills', text: 'Get 2 kills in one match', goal: 1, xp: 30, count: (m) => (m.kills >= 2 ? 1 : 0) },
  { id: 'top3', group: 'place', text: 'Finish in the top 3', goal: 1, xp: 20, count: (m) => (m.place <= 3 ? 1 : 0) },
  { id: 'top3x2', group: 'place', text: 'Finish in the top 3 twice', goal: 2, xp: 30, count: (m) => (m.place <= 3 ? 1 : 0) },
  { id: 'win', group: 'place', text: 'Win a match', goal: 1, xp: 35, count: (m) => (m.place === 1 ? 1 : 0) },
  { id: 'play3', group: 'play', text: 'Play 3 matches', goal: 3, xp: 15, count: () => 1 },
  { id: 'play5', group: 'play', text: 'Play 5 matches', goal: 5, xp: 25, count: () => 1 },
  { id: 'outlast25', group: 'outlast', text: 'Outlast 25 players', goal: 25, xp: 20, count: (m) => Math.max(0, m.n - m.place) },
  { id: 'power3', group: 'power', text: 'Pick up 3 power-ups', goal: 3, xp: 15, count: (m) => sum(m.picks) },
  { id: 'shield', group: 'power', text: 'Pick up a Shield', goal: 1, xp: 15, count: (m) => (m.picks && m.picks.shield) || 0 },
  { id: 'slow', group: 'power', text: 'Pick up a Slow for your rivals', goal: 1, xp: 15, count: (m) => (m.picks && m.picks.slow) || 0 },
];
const BY_ID = new Map(POOL.map((d) => [d.id, d]));
export const DAILY = 3;

function sum(o) {
  let s = 0;
  for (const v of Object.values(o || {})) s += v;
  return s;
}

function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ids of the missions for one day (YYYY-MM-DD). */
export function missionsFor(day) {
  const rand = rng(seedFrom('missions:' + day));
  const pool = [...POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = [], groups = new Set();
  for (const d of pool) {
    if (groups.has(d.group)) continue;
    groups.add(d.group);
    picked.push(d.id);
    if (picked.length === DAILY) break;
  }
  return picked;
}

/** The mission state of a profile for `day` ({day, have: {id: n}}), fresh on a new day. */
export function stateFor(p, day) {
  const m = p.missions;
  if (!m || m.day !== day || !m.have || typeof m.have !== 'object' || Array.isArray(m.have)) p.missions = { day, have: {} };
  return p.missions;
}

/** Add one match. Returns the missions finished by it: [{text, xp}]. */
export function addMatch(p, day, match) {
  const st = stateFor(p, day);
  const done = [];
  for (const id of missionsFor(day)) {
    const d = BY_ID.get(id);
    const before = Number(st.have[id]) || 0;
    if (before >= d.goal) continue;
    st.have[id] = Math.min(d.goal, before + Math.max(0, d.count(match) || 0));
    if (st.have[id] >= d.goal) done.push({ text: d.text, xp: d.xp });
  }
  return done;
}

/** What the client shows: [{text, have, goal, xp}]. Doesn't change the profile. */
export function missionList(p, day) {
  const m = p && p.missions;
  const have = m && m.day === day && m.have && !Array.isArray(m.have) ? m.have : {};
  return missionsFor(day).map((id) => {
    const d = BY_ID.get(id);
    return { text: d.text, have: Math.min(d.goal, Number(have[id]) || 0), goal: d.goal, xp: d.xp };
  });
}
