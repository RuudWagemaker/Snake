// Player profiles, match points and leaderboards.
//
// There are no accounts: each browser makes up a random token and keeps it in
// localStorage. The server keeps one profile per token, in memory, and saves
// them all to a JSON file (STATS_FILE) at most every few seconds.
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cleanName } from './names.js';
import { addMatch, missionList } from './missions.js';

const SAVE_DELAY_MS = 10000;
const LB_SIZE = 20;
const LB_CACHE_MS = 5000;
const PRUNE_DAYS = 60;          // forget one-off visitors after this long
const TZ = 'Europe/Amsterdam';  // when "today" and "this week" start
const DAILY_DAYS = 60;          // days of usage numbers kept for the admin page
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
    this.daily = new Map();     // day -> usage numbers for the admin page (see usage())
    this.accounts = new Map();  // Google account id (sub) -> token of its profile
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
      for (const [sub, token] of Object.entries(data.accounts || {})) {
        if (validToken(token)) this.accounts.set(sub, token);
      }
      for (const [day, d] of Object.entries(data.daily || {})) {
        if (d && typeof d === 'object') this.daily.set(day, { ...d, visitors: new Set(d.visitors || []), players: new Set(d.players || []) });
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
      const daily = {};
      for (const [day, d] of this.daily) daily[day] = { ...d, visitors: [...d.visitors], players: [...d.players] };
      writeFileSync(tmp, JSON.stringify({ v: 1, profiles: Object.fromEntries(this.profiles), daily, accounts: Object.fromEntries(this.accounts) }));
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
      if (!p.account && p.games < 3 && now - (p.last || 0) > PRUNE_DAYS * 86400000) this.profiles.delete(token);
    }
  }

  // ------------------------------------------------------------ usage numbers

  /** Today's usage record (created on first use; old days dropped). */
  day(now = Date.now()) {
    const key = periodKeys(now).day;
    let d = this.daily.get(key);
    if (!d) {
      d = { visitors: new Set(), players: new Set(), newPlayers: 0, matches: 0, roomMatches: 0, matchSecs: 0, humanSlots: 0, peakOnline: 0 };
      this.daily.set(key, d);
      const keys = [...this.daily.keys()].sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - DAILY_DAYS))) this.daily.delete(k);
    }
    return d;
  }

  /** Someone opened the game (or came back to the menu). */
  visit(token, now = Date.now(), region = null) {
    if (!validToken(token)) return;
    const d = this.day(now);
    if (d.visitors.has(token)) return;
    d.visitors.add(token);
    if (region) {
      d.regions ||= {};
      d.regions[region] = (d.regions[region] || 0) + 1;
    }
  }

  /** Players online right now per region ({region: n}): keeps each region's peak for the day. */
  regionOnline(counts, now = Date.now()) {
    const d = this.day(now);
    d.regionPeak ||= {};
    for (const [r, n] of Object.entries(counts)) if (n > (d.regionPeak[r] || 0)) d.regionPeak[r] = n;
  }

  /** Per region: visitors today, visitors over the last `days` days (added up per day), and the highest online. */
  regionUsage(days = 30, now = Date.now()) {
    const today = periodKeys(now).day;
    const out = {};
    const row = (r) => (out[r] ||= { region: r, today: 0, visitors: 0, peakOnline: 0 });
    const keys = [...this.daily.keys()].sort().slice(-days);
    for (const k of keys) {
      const d = this.daily.get(k);
      for (const [r, n] of Object.entries(d.regions || {})) {
        row(r).visitors += n;
        if (k === today) row(r).today += n;
      }
      for (const [r, n] of Object.entries(d.regionPeak || {})) row(r).peakOnline = Math.max(row(r).peakOnline, n);
    }
    return Object.values(out).sort((a, b) => b.visitors - a.visitors || b.peakOnline - a.peakOnline);
  }

  online(n, now = Date.now()) {
    const d = this.day(now);
    if (n > d.peakOnline) d.peakOnline = n;
  }

  /** A match with at least one human ended. */
  matchPlayed({ room = false, secs = 0, humans = 0 }, now = Date.now()) {
    const d = this.day(now);
    d.matches++;
    if (room) d.roomMatches++;
    d.matchSecs += secs;
    d.humanSlots += humans;
    this.scheduleSave();
  }

  /** Numbers per day, newest first, for the admin page. */
  usage(days = 30) {
    return [...this.daily.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, days).map(([day, d]) => ({
      day,
      visitors: d.visitors.size,
      players: d.players.size,
      newPlayers: d.newPlayers,
      matches: d.matches,
      roomMatches: d.roomMatches,
      avgMatchSecs: d.matches ? Math.round(d.matchSecs / d.matches) : 0,
      matchesPerPlayer: d.players.size ? Math.round((10 * d.humanSlots) / d.players.size) / 10 : 0,
      peakOnline: d.peakOnline,
    }));
  }

  newProfile(token, name, now = Date.now()) {
    const p = { name, games: 0, wins: 0, kills: 0, best: 0, xp: 0, points: 0, created: now, last: now, day: null, week: null };
    this.profiles.set(token, p);
    return p;
  }

  // ------------------------------------------------------------ Google accounts

  /**
   * A verified Google sign-in. Returns the token this browser should use from now on.
   * - New account: this browser's guest progress becomes the account's.
   * - Known account: always the account's own profile. A guest profile on the
   *   other device is left alone (the browser gets it back when signing out), so
   *   progress is never split or handed to someone else on a borrowed phone.
   */
  login(sub, token, now = Date.now()) {
    if (typeof sub !== 'string' || !sub) return null;
    const linked = this.accounts.get(sub) || null;
    let cur = validToken(token) ? token : null;
    if (cur && cur !== linked) {
      for (const [s, t] of this.accounts) if (t === cur && s !== sub) { cur = null; break; } // belongs to another account
    }
    const use = linked || cur || randomBytes(16).toString('hex');
    this.accounts.set(sub, use);
    const p = this.profiles.get(use) || this.newProfile(use, 'Player', now);
    p.account = true;
    p.last = now;
    this.scheduleSave();
    return use;
  }

  get(token) {
    return validToken(token) ? this.profiles.get(token) || null : null;
  }

  /** What the client shows in the menu. */
  summary(token, now = Date.now()) {
    const p = this.get(token);
    const s = p || { games: 0, wins: 0, kills: 0, best: 0, xp: 0 };
    return { games: s.games, wins: s.wins, kills: s.kills, best: s.best, ...levelInfo(s.xp), missions: missionList(p, periodKeys(now).day) };
  }

  /**
   * Record a finished match for one human. Returns what they earned, for the
   * end screen. Unranked matches (friends' rooms) only give XP (missions count too).
   * `picks`: counts from this match: fuel picked up, skills used, lines blasted.
   */
  record(token, name, place, n, kills, now = Date.now(), ranked = true, picks = {}) {
    if (!validToken(token)) return null;
    let p = this.profiles.get(token);
    if (!p) {
      this.day(now).newPlayers++;
      p = this.newProfile(token, name, now);
    }
    const points = matchPoints(place, n, kills);
    const xp = matchXp(points);
    const before = levelFor(p.xp);
    const win = place === 1 ? 1 : 0;
    p.name = name;
    p.last = now;
    this.day(now).players.add(token);
    const day = periodKeys(now).day;
    const missionsDone = addMatch(p, day, { place, n, kills, picks });
    const missionXp = missionsDone.reduce((s, m) => s + m.xp, 0);
    p.xp += xp + missionXp;
    this.scheduleSave();
    const extra = { missionsDone, missionXp, missions: missionList(p, day) };
    if (!ranked) {
      const info = levelInfo(p.xp);
      return { points, xpGained: xp, ranked: false, levelUp: info.level > before, ...info, ...extra };
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
    return { points, xpGained: xp, ranked: true, levelUp: info.level > before, ...info, ...extra };
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
