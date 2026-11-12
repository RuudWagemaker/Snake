// Shared game constants. Imported by both the server and the browser client,
// so the client's prediction runs the exact same rules as the server.

export const TICK_RATE = 30;              // simulation ticks per second
export const DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

export const SPEED = 100;                 // world units per second
export const TURN_RATE = 2.9;             // radians per second
export const LINE_WIDTH = 6;              // trail thickness in world units
export const HIT_DIST = LINE_WIDTH * 0.9; // head-to-trail distance that counts as a crash
export const SELF_IGNORE_TICKS = 8;       // ignore own freshest trail (the neck)

// Gaps ("holes") in the trail, like Curve Fever.
export const GAP_LEN_TICKS = 8;
export const GAP_FIRST_MIN = 45;
export const GAP_FIRST_MAX = 90;
export const GAP_INTERVAL_MIN = 50;
export const GAP_INTERVAL_MAX = 110;

// Match flow
export const MIN_PLAYERS = 10;            // rooms are topped up with bots to this size
export const MAX_PLAYERS = 24;
export const LOBBY_SECONDS = 5;           // wait for more humans after the first one joins
export const PRIVATE_LOBBY_SECONDS = 45;  // friends' rooms wait longer (or until someone taps Start)
export const NEXT_ROUND_LOBBY_SECONDS = 4;
export const COUNTDOWN_SECONDS = 3;       // snakes are frozen and shown before moving
export const END_SECONDS = 6;

// Field size grows with the number of players.
export const fieldRadius = (n) => Math.round(800 + 300 * Math.sqrt(n));

// Zone shrink schedule (seconds). Each phase waits `hold`, then shrinks over
// `shrink` to `f` times the previous radius. The last phase closes completely,
// so every match is guaranteed to end: at most 100 s after the start.
export const ZONE_PHASES = [
  { hold: 15, shrink: 15, f: 0.6 },
  { hold: 10, shrink: 12, f: 0.55 },
  { hold: 8, shrink: 10, f: 0.5 },
  { hold: 6, shrink: 9, f: 0.45 },
  { hold: 5, shrink: 10, f: 0 },
];

export const GRID_CELL = 48;

// Power-ups. Green ones help the picker; red ones hit opponents near the picker.
// Effects start EFFECT_DELAY ticks after the pickup, so every client knows about
// them before they kick in (keeps prediction exact).
export const POWERUPS = {
  speed:   { good: true,  secs: 5,   label: 'Speed',   icon: '\u26A1' },
  ghost:   { good: true,  secs: 3,   label: 'Ghost',   icon: '\u{1F47B}' },
  thin:    { good: true,  secs: 6,   label: 'Thin',    icon: '\u2502' },
  shield:  { good: true,  secs: 4,   label: 'Shield',  icon: '\u{1F6E1}' },
  fast:    { good: false, secs: 4,   label: 'Fast',    icon: '\u00BB' },
  fat:     { good: false, secs: 5,   label: 'Fat',     icon: '\u25AC' },
  reverse: { good: false, secs: 3.5, label: 'Reverse', icon: '\u21C4' },
  slow:    { good: false, secs: 4,   label: 'Slow',    icon: '\u{1F40C}' },
};
export const POWERUP_TYPES = Object.keys(POWERUPS);

// Rockets: collect fuel dots on the field; FUEL_PER_ROCKET dots make one rocket.
// A rocket flies straight ahead and blasts a hole (radius BLAST_R) in the first
// line it hits. The hole opens EFFECT_DELAY ticks after the hit, so every
// client knows about it in time (same trick as the power-ups).
export const FUEL = { good: true, label: 'Fuel', icon: '\u26FD' };
export const FUEL_RADIUS = 6;             // fuel is small dots, many of them
export const FUEL_PICK_R = 38;            // ...collected anywhere this close to a head (a small magnet), then they fly into it
export const fuelTarget = (n) => Math.max(40, Math.min(120, n * 6)); // dots on the field at the start
export const FUEL_PER_ROCKET = 5;
export const MAX_FUEL = 10;
export const START_FUEL = 3;              // enough for one small skill right away
export const FUEL_REGEN = 0.25;           // fuel per second that refills by itself (a full tank in 40 s)
export const DEATH_DROP_EXTRA = 3;        // a crashed snake drops its fuel plus this many dots

// Skills: each player picks 2 in the menu and spends fuel to use them in a match.
// `effect` is the modifier it puts on your own snake (see modsAt in sim.js):
// jump = ghost (no line, passes over lines), boost = speed, brake = slow (tighter turns).
export const SKILLS = {
  rocket: { label: 'Rocket', icon: '\u{1F680}', cost: FUEL_PER_ROCKET, help: 'Blasts a hole in the first line it hits' },
  jump:   { label: 'Jump',   icon: '\u{1F998}', cost: 3, effect: 'ghost', secs: 0.45, help: 'Hop over lines for a moment' },
  boost:  { label: 'Boost',  icon: '\u26A1',     cost: 3, effect: 'speed', secs: 2.5,  help: 'Go faster for 2.5 s' },
  brake:  { label: 'Brake',  icon: '\u{1F422}', cost: 2, effect: 'slow',  secs: 2,    help: 'Slow down for 2 s to turn much tighter' },
};
export const SKILL_IDS = Object.keys(SKILLS);
export const SKILL_SLOTS = 2;
export const DEFAULT_SKILLS = ['rocket', 'jump'];
/** A valid pick of SKILL_SLOTS different skills, or the default. */
export function validSkills(list) {
  if (!Array.isArray(list) || list.length !== SKILL_SLOTS) return DEFAULT_SKILLS.slice();
  if (new Set(list).size !== SKILL_SLOTS || !list.every((k) => Object.hasOwn(SKILLS, k))) return DEFAULT_SKILLS.slice();
  return list.slice();
}
/** Labels for effects on the HUD (from skills). */
export const EFFECT_INFO = {
  ghost: { label: 'Jump', icon: SKILLS.jump.icon, good: true },
  speed: { label: 'Boost', icon: SKILLS.boost.icon, good: true },
  slow:  { label: 'Brake', icon: SKILLS.brake.icon, good: true },
};
export const ROCKET_SPEED = 600;          // world units per second
export const ROCKET_RANGE = 900;          // flies this far, then fizzles
export const ROCKET_WIDTH = 4;            // for hitting lines
export const BLAST_R = 30;
export const FIRE_LATE_TICKS = 12;        // a fire stamped this far in the past still starts there
export const FIRE_AHEAD_TICKS = 60;       // ...and at most this far in the future
export const EFFECT_DELAY = 8;            // ticks between pickup and effect
export const ITEM_RADIUS = 13;
export const OTHERS_RANGE = 900;          // red effects hit opponents within this distance
export const SPEED_MUL = 1.6;
export const SLOW_MUL = 0.6;
export const MIN_WIDTH = 2;
export const MAX_WIDTH = 18;

// Special "killer" ids in death events
export const KILLER_ZONE = -1;
export const KILLER_LEFT = -3;

export const COLORS = [
  '#ff4d6d', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b',
  '#22b8cf', '#f06595', '#94d82d', '#845ef7', '#ffd43b', '#20c997',
  '#ff6b6b', '#74c0fc', '#69db7c', '#ffa94d', '#e599f7', '#3bc9db',
  '#faa2c1', '#c0eb75', '#9775fa', '#ffe066', '#63e6be', '#ffc078',
];

// Unlockables (cosmetic only). Colours are indexes into COLORS: the first 8 are
// free, then 2 more per level (all 24 at level 9). Trail styles unlock by level.
export const FREE_COLORS = 8;
export const colorLevel = (i) => (i < FREE_COLORS ? 1 : 2 + Math.floor((i - FREE_COLORS) / 2));
export const TRAIL_STYLES = {
  plain:   { level: 1,  label: 'Plain' },
  neon:    { level: 3,  label: 'Neon' },
  core:    { level: 5,  label: 'Core' },
  rainbow: { level: 8,  label: 'Rainbow' },
};
