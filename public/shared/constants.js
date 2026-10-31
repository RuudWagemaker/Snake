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
export const NEXT_ROUND_LOBBY_SECONDS = 4;
export const COUNTDOWN_SECONDS = 3;       // snakes are frozen and shown before moving
export const END_SECONDS = 6;

// Field size grows with the number of players.
export const fieldRadius = (n) => Math.round(800 + 300 * Math.sqrt(n));

// Zone shrink schedule (seconds). Each phase waits `hold`, then shrinks over
// `shrink` to `f` times the previous radius. The last phase closes completely,
// so every match is guaranteed to end.
export const ZONE_PHASES = [
  { hold: 25, shrink: 25, f: 0.6 },
  { hold: 15, shrink: 20, f: 0.55 },
  { hold: 12, shrink: 16, f: 0.5 },
  { hold: 10, shrink: 14, f: 0.45 },
  { hold: 8, shrink: 16, f: 0 },
];

export const GRID_CELL = 48;

// Special "killer" ids in death events
export const KILLER_ZONE = -1;
export const KILLER_LEFT = -3;

export const COLORS = [
  '#ff4d6d', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b',
  '#22b8cf', '#f06595', '#94d82d', '#845ef7', '#ffd43b', '#20c997',
  '#ff6b6b', '#74c0fc', '#69db7c', '#ffa94d', '#e599f7', '#3bc9db',
  '#faa2c1', '#c0eb75', '#9775fa', '#ffe066', '#63e6be', '#ffc078',
];
