import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missionsFor, addMatch, missionList, POOL, DAILY } from '../server/missions.js';
import { Stats } from '../server/stats.js';

const A = 'a'.repeat(32);

test('missions: same three for everyone on a day, different groups', () => {
  const day = '2026-11-03';
  assert.deepEqual(missionsFor(day), missionsFor(day));
  assert.equal(missionsFor(day).length, DAILY);
  const days = Array.from({ length: 30 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
  const seen = new Set();
  for (const d of days) {
    const ids = missionsFor(d);
    ids.forEach((id) => seen.add(id));
    const groups = ids.map((id) => POOL.find((m) => m.id === id).group);
    assert.equal(new Set(groups).size, DAILY);
  }
  assert.ok(seen.size >= POOL.length - 3, 'most missions show up within a month');
});

test('missions: progress, bonus once, reset next day', () => {
  // Find a day with a "play" mission, so every match counts.
  let day = null;
  for (let i = 1; i <= 28 && !day; i++) {
    const d = `2026-02-${String(i).padStart(2, '0')}`;
    if (missionsFor(d).includes('play3')) day = d;
  }
  assert.ok(day);
  const idx = missionsFor(day).indexOf('play3');
  const p = {};
  const m = { place: 9, n: 10, kills: 0, picks: {} };
  addMatch(p, day, m);
  addMatch(p, day, m);
  assert.equal(missionList(p, day)[idx].have, 2);
  const done = addMatch(p, day, m);
  assert.ok(done.some((d) => d.text === 'Play 3 matches'));
  assert.ok(!addMatch(p, day, m).some((d) => d.text === 'Play 3 matches'), 'bonus only once');
  assert.equal(missionList(p, day)[idx].have, 3);
  assert.ok(missionList(p, '2099-01-01').every((x) => x.have === 0), 'fresh on a new day');
});

test('missions: bonus XP is added by stats.record', () => {
  const s = new Stats();
  const now = Date.UTC(2026, 1, 10, 12);
  const res = s.record(A, 'Ann', 1, 10, 6, now, true, { shield: 1, slow: 1, speed: 2 });
  // A win with 6 kills and 4 pick-ups finishes every mission except "play"/"twice" ones.
  assert.ok(res.missionsDone.length > 0);
  assert.equal(res.missionXp, res.missionsDone.reduce((t, d) => t + d.xp, 0));
  assert.equal(s.get(A).xp, res.xpGained + res.missionXp);
  assert.equal(s.summary(A, now).missions.length, DAILY);
});
