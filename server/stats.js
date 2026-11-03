// Player profiles, match points and leaderboards.
//
// There are no accounts: each browser makes up a random token and keeps it in
// localStorage. The server keeps one profile per token, in memory, and saves
// them all to a JSON file (STATS_FILE) at most every few seconds.
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { cleanName } from './names.js';

const SAVE_DELAY_MS = 10000;
const LB_SIZE = 20;
const LB_CACHE_MS = 5000;
const PRUNE_DAYS = 60;          // forget one-off visitors after this long
const TZ = 'Europe/Amsterdam';  // when "today" and "this week" start
const BACKUP_DAYS = 14;         // daily copies of the stats file kept in backups/

export const PERIODS = ['day', 'week', 'all'];

export function validToken(t) {
  return typeof t === 'string' && /^[a-f0-9]{16,64}$/.test(t);
}

/**
 * Points for one match: one per player you outlasted, 3 per kill, 5 extra for
 * a win. XP is the same plus 5 for playing.
 */
export function matchPoints(place, n, kills) {
  const outlasted = Math.max(0, n - place);
  return outlasted + 3 * kills + (place === 1 ? 5 : 0);
}
export const matchXp = (points) => points + 5;

/** Level 1 at 0 XP, then each level needs a bit more: 2 at 25, 3 at 100, 5 at 400, 10 at 2025. */
export function levelFor(xp) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 25)) + 1;
}
export const xpForLevel = (level) => 25 * (level - 1) ** 2;

export function levelInfo(xp) {
  const level = levelFor(xp);
  const from = xpForLevel(level), to = xpForLevel(level + 1);
  return { level, xp, into: xp - from, need: to - from };
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** Keys for the current day and week (Monday start) in the game's time zone. */
export function periodKeys(now = Date.now()) {
  const day = dayFmt.format(now); // YYYY-MM-DD
  const d = new Date(day + 'T00:00:00Z');
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
  return { day, week: 'w' + monday.toISOString().slice(0, 10) };
}

const emptyTally = (key) => ({ key, points: 0, games: 0, wins: 0, kills: 0 });

export class Stats {
  constructor(file = null) {
    this.file = file;
    this.profiles = new Map();  // token -> profile
    this.saveTimer = null;
    this.lbCache = new Map();   // period -> {at, list}
    if (file) this.load();
  }

  load() {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [token, p] of Object.entries(data.profiles || {})) {
        if (!validToken(token) || !p || typeof p !== 'object') continue;
        p.name = cleanName(p.name); // names saved before the filter existed
        this.profiles.set(token, p);
      }
      console.log(`[stats] loaded ${this.profiles.size} profiles from ${this.file}`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[stats] could not read ${this.file}:`, err.message);
    }
    this.prune();
  }

  /** Write the file soon (several matches ending close together give one write). */
  scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  saveNow(now = Date.now()) {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify({ v: 1, profiles: Object.fromEntries(this.profiles) }));
      renameSync(tmp, this.file); // atomic: a crash never leaves half a file
    } catch (err) {
      console.error(`[stats] could not save ${this.file}:`, err.message);
      return;
    }
    this.backup(now);
  }

  /** Once a day, keep a copy of the saved file in backups/ (the last BACKUP_DAYS days). */
  backup(now = Date.now()) {
    try {
      const dir = path.join(path.dirname(this.file), 'backups');
      const name = `stats-${periodKeys(now).day}.json`;
      if (existsSync(path.join(dir, name))) return;
      mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, name + '.tmp');
      writeFileSync(tmp, readFileSync(this.file));
      renameSync(tmp, path.join(dir, name));
      const old = readdirSync(dir).filter((f) => /^stats-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -BACKUP_DAYS);
      for (const f of old) unlinkSync(path.join(dir, f));
    } catch (err) {
      console.error('[stats] backup failed:', err.message);
    }
  }

  prune(now = Date.now()) {
    for (const [token, p] of this.profiles) {
      if (p.games < 3 && now - (p.last || 0) > PRUNE_DAYS * 86400000) this.profiles.delete(token);
    }
  }

  get(token) {
    return validToken(token) ? this.profiles.get(token) || null : null;
  }

  /** What the client shows in the menu. */
  summary(token) {
    const p = this.get(token);
    const s = p || { games: 0, wins: 0, kills: 0, best: 0, xp: 0 };
    return { games: s.games, wins: s.wins, kills: s.kills, best: s.best, ...levelInfo(s.xp) };
  }

  /**
   * Record a finished match for one human. Returns what they earned, for the
   * end screen. Unranked matches (friends' rooms) only give XP.
   */
  record(token, name, place, n, kills, now = Date.now(), ranked = true) {
    if (!validToken(token)) return null;
    let p = this.profiles.get(token);
    if (!p) {
      p = { name, games: 0, wins: 0, kills: 0, best: 0, xp: 0, points: 0, created: now, last: now, day: null, week: null };
      this.profiles.set(token, p);
    }
    const points = matchPoints(place, n, kills);
    const xp = matchXp(points);
    const before = levelFor(p.xp);
    const win = place === 1 ? 1 : 0;
    p.name = name;
    p.last = now;
    p.xp += xp;
    this.scheduleSave();
    if (!ranked) {
      const info = levelInfo(p.xp);
      return { points, xpGained: xp, ranked: false, levelUp: info.level > before, ...info };
    }
    p.games++;
    p.wins += win;
    p.kills += kills;
    p.points += points;
    p.best = p.best ? Math.min(p.best, place) : place;
    const keys = periodKeys(now);
    for (const per of ['day', 'week']) {
      if (!p[per] || p[per].key !== keys[per]) p[per] = emptyTally(keys[per]);
      const t = p[per];
      t.points += points; t.games++; t.wins += win; t.kills += kills;
    }
    this.lbCache.clear();
    const info = levelInfo(p.xp);
    return { points, xpGained: xp, ranked: true, levelUp: info.level > before, ...info };
  }

  /** Points etc. of a profile for one period (null if nothing this period). */
  tally(p, period, keys) {
    if (period === 'all') return p.games ? { points: p.points, games: p.games, wins: p.wins, kills: p.kills } : null;
    const t = p[period];
    return t && t.key === keys[period] && t.games ? t : null;
  }

  ranked(period, now = Date.now()) {
    const c = this.lbCache.get(period);
    if (c && now - c.at < LB_CACHE_MS) return c.list;
    const keys = periodKeys(now);
    const list = [];
    for (const [token, p] of this.profiles) {
      const t = this.tally(p, period, keys);
      if (t) list.push({ token, name: p.name, level: levelFor(p.xp), points: t.points, games: t.games, wins: t.wins, kills: t.kills });
    }
    list.sort((a, b) => b.points - a.points || b.wins - a.wins || a.games - b.games);
    this.lbCache.set(period, { at: now, list });
    return list;
  }

  /** Top players for a period, plus where `token` stands. Tokens are never sent out. */
  leaderboard(period, token, now = Date.now()) {
    if (!PERIODS.includes(period)) period = 'day';
    const list = this.ranked(period, now);
    const strip = (e, i) => ({ rank: i + 1, name: e.name, level: e.level, points: e.points, games: e.games, wins: e.wins, kills: e.kills });
    const top = list.slice(0, LB_SIZE).map((e, i) => ({ ...strip(e, i), me: e.token === token }));
    const i = validToken(token) ? list.findIndex((e) => e.token === token) : -1;
    return { period, top, me: i >= 0 ? strip(list[i], i) : null, players: list.length };
  }
}
