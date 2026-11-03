import os from 'node:os';
import { WebSocket } from 'ws';
import { TICK_MS, COLORS, TRAIL_STYLES, colorLevel } from '../public/shared/constants.js';
import { decodeInputList } from '../public/shared/protocol.js';
import { Room } from './room.js';
import { InputBuffer } from './inputs.js';
import { RtcPeer, rtcEnabled } from './rtc.js';
import { cleanName } from './names.js';
import { Stats, validToken } from './stats.js';

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

// Development aid: simulate a bad network. SIM_LAG_MS is one-way delay in each
// direction, SIM_JITTER_MS adds random extra delay (order is preserved, like TCP).
const SIM_LAG_MS = Number(process.env.SIM_LAG_MS) || 0;
const SIM_JITTER_MS = Number(process.env.SIM_JITTER_MS) || 0;
// SIM_SPIKE_MS + SIM_SPIKE_EVERY_MS: the connection goes silent (both ways) for
// SIM_SPIKE_MS every SIM_SPIKE_EVERY_MS, like Wi-Fi pausing to scan.
const SIM_SPIKE_MS = Number(process.env.SIM_SPIKE_MS) || 0;
const SIM_SPIKE_EVERY_MS = Number(process.env.SIM_SPIKE_EVERY_MS) || 15000;
// SIM_STALL_MS freezes the whole server for that long every 4 s, like a CPU-starved host.
const SIM_STALL_MS = Number(process.env.SIM_STALL_MS) || 0;
// SIM_TCP_RTO=1: during a spike, TCP-like retransmission backoff (re-sends at
// 200, 600, 1400 ms after the first loss), instead of releasing at the end.
const SIM_TCP_RTO = !!process.env.SIM_TCP_RTO;
// SIM_UDP_LOSS: fraction of UDP packets dropped at random (both directions).
const SIM_UDP_LOSS = Number(process.env.SIM_UDP_LOSS) || 0;
const inSpike = (at) => SIM_SPIKE_MS && at % SIM_SPIKE_EVERY_MS < SIM_SPIKE_MS;
function spikeRelease(at) {
  if (!SIM_SPIKE_MS) return at;
  const phase = at % SIM_SPIKE_EVERY_MS;
  if (phase >= SIM_SPIKE_MS) return at;
  const start = at - phase, end = start + SIM_SPIKE_MS;
  if (!SIM_TCP_RTO) return end;
  let t = at, rto = 200;
  while (t < end) { t += rto; rto *= 2; }
  return t;
}
/** UDP: delayed like the TCP path, but packets in a spike (or randomly) are lost, never queued. */
function udpSim(fn) {
  if (!SIM_LAG_MS && !SIM_JITTER_MS && !SIM_SPIKE_MS && !SIM_UDP_LOSS) return fn();
  if (Math.random() < SIM_UDP_LOSS) return;
  const at = performance.now() + SIM_LAG_MS + Math.random() * SIM_JITTER_MS;
  if (inSpike(at)) return;
  setTimeout(fn, at - performance.now());
}
/** Friends' rooms: short lowercase codes, made up by the browser that opens one. */
export const validRoomCode = (s) => typeof s === 'string' && /^[a-z0-9]{4,10}$/.test(s);

function makeDelayer() {
  if (!SIM_LAG_MS && !SIM_JITTER_MS && !SIM_SPIKE_MS) return null;
  // Strict FIFO with one timer, so messages are never reordered (TCP never does).
  const queue = [];
  let timer = null;
  const flush = () => {
    timer = null;
    const now = performance.now();
    while (queue.length && queue[0].at <= now) queue.shift().fn();
    if (queue.length) timer = setTimeout(flush, queue[0].at - now);
  };
  return (fn) => {
    const last = queue.length ? queue[queue.length - 1].at : 0;
    const at = spikeRelease(performance.now() + SIM_LAG_MS + Math.random() * SIM_JITTER_MS);
    queue.push({ at: Math.max(last, at), fn });
    if (!timer) timer = setTimeout(flush, queue[0].at - performance.now());
  };
}

class Client {
  constructor(ws, server) {
    this.ws = ws;
    this.server = server;
    this.id = server.nextClientId++;
    this.name = 'Player';
    this.token = null;    // anonymous profile id from the browser (see stats.js)
    this.skin = { color: -1, style: 'plain' }; // chosen colour (-1 = any) and trail style
    this.room = null;
    this.player = null;   // current round's player object
    this.inputs = new InputBuffer();
    this.starved = false; // input for the current tick was missing
    this.rtc = null;      // WebRTC peer (UDP), if the browser set one up
    this.lastMsgAt = performance.now();  // liveness: the client pings every second
    this.lastInputAt = 0;
    this.maxInputGap = 0;  // longest gap between inputs in the current stats window (ms)
    this.delayIn = makeDelayer();
    this.delayOut = makeDelayer();

    ws.on('message', (data, isBinary) => {
      const handle = () => {
        this.lastMsgAt = performance.now();
        if (isBinary) this.onInput(data);
        else this.onJson(data);
      };
      if (this.delayIn) this.delayIn(handle);
      else handle();
    });
    ws.on('close', () => { this.rtc?.close(); this.rtc = null; server.onClose(this); });
    ws.on('error', () => {});
  }

  /** Inputs arrive over WebSocket and (if set up) UDP; duplicates are fine. */
  onInput(data) {
    const list = decodeInputList(data);
    if (!list || !this.player || !this.player.alive || !this.room || !this.room.round) return;
    const cur = this.room.round.tick;
    let newest = false;
    for (const m of list) if (this.inputs.receive(m.tick, m.turn, cur)) newest = true;
    if (newest) {
      const now = performance.now();
      if (this.lastInputAt) this.maxInputGap = Math.max(this.maxInputGap, now - this.lastInputAt);
      this.lastInputAt = now;
    }
  }

  onUdp(u8) {
    this.lastMsgAt = performance.now();
    udpSim(() => this.onInput(u8));
  }

  onJson(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'join':
        if (msg.build !== this.server.build) {
          // A page from an older deploy: its input format may not match.
          this.send({ t: 'error', msg: 'A new version of the game is available. Please refresh the page.', reload: true });
          return;
        }
        this.name = cleanName(msg.name);
        if (validToken(msg.token)) this.token = msg.token;
        this.skin = this.server.allowedSkin(this.token, msg.skin);
        this.server.join(this, validRoomCode(msg.room) ? msg.room : null);
        break;
      case 'leave':
        if (this.room) this.room.removeClient(this);
        break;
      case 'go':
        // "Start now" in a friends' room lobby
        if (this.room && this.room.code) this.room.startSoon();
        break;
      case 'profile':
        // Sent once after connecting: who am I, and how am I doing?
        if (validToken(msg.token)) this.token = msg.token;
        this.server.stats.visit(this.token);
        this.send({ t: 'profile', ...this.server.stats.summary(this.token), online: this.server.clients.size });
        break;
      case 'lb':
        this.send({ t: 'lb', ...this.server.stats.leaderboard(msg.period, this.token) });
        break;
      case 'ping':
        this.send({ t: 'pong', c: msg.c });
        break;
      case 'rtc':
        if (!rtcEnabled()) return;
        if (msg.type === 'offer') {
          this.rtc?.close();
          this.rtc = new RtcPeer(this.id, (m) => this.send(m), (u8) => this.onUdp(u8));
        }
        this.rtc?.handle(msg);
        break;
    }
  }

  send(obj) {
    this.sendRaw(JSON.stringify(obj));
  }

  sendRaw(data) {
    if (this.delayOut) {
      this.delayOut(() => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data); });
    } else if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  sendBinary(u8) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.ws.terminate(); // hopelessly behind; drop the connection
      return;
    }
    // Over UDP for speed (lost packets are skipped) and over the WebSocket too,
    // which guarantees delivery and fills in anything UDP dropped.
    if (this.rtc && this.rtc.open) udpSim(() => this.rtc && this.rtc.send(u8));
    this.sendRaw(u8);
  }
}

export class GameServer {
  constructor(build = 'dev', stats = new Stats()) {
    this.build = build;
    this.stats = stats;
    this.rooms = new Set();
    this.clients = new Set();
    this.nextClientId = 1;
    this.nextRoomId = 1;
    this.timer = null;
    this.heartbeat = null;
    // Health stats: how late the game loop ran (server hiccups) and tick cost.
    this.maxLag = 0;
    this.maxStep = 0;
    this.stepTotal = 0;
    this.stepCount = 0;
    this.lastWarn = 0;
    this.lastCpuWarn = 0;
    this.cpuMark = { at: performance.now(), proc: process.cpuUsage(), sys: machineTimes() };
  }

  /**
   * CPU since the last call, in Hetzner's units (100% = one core): this game
   * process, and the whole machine (all processes; /proc/stat isn't namespaced,
   * so this works inside Docker too).
   */
  measureCpu() {
    const now = performance.now(), proc = process.cpuUsage(), sys = machineTimes();
    const m = this.cpuMark;
    const ms = Math.max(1, now - m.at);
    const game = ((proc.user - m.proc.user + proc.system - m.proc.system) / 1000 / ms) * 100;
    const total = sys.total - m.sys.total, idle = sys.idle - m.sys.idle;
    const cores = os.cpus().length;
    const machine = total > 0 ? ((total - idle) / total) * 100 * cores : 0;
    this.cpuMark = { at: now, proc, sys };
    return { game: Math.round(game), machine: Math.round(machine), cores };
  }

  onConnection(ws) {
    const c = new Client(ws, this);
    this.clients.add(c);
    this.stats?.online(this.clients.size);
    c.send({ t: 'hello', online: this.clients.size, build: this.build, rtc: rtcEnabled() });
  }

  onClose(c) {
    this.clients.delete(c);
    if (c.room) c.room.removeClient(c);
  }

  /** The skin a player asked for, minus anything their level hasn't unlocked. */
  allowedSkin(token, skin) {
    const level = this.stats.summary(token).level;
    const out = { color: -1, style: 'plain' };
    if (!skin || typeof skin !== 'object') return out;
    const c = skin.color;
    if (Number.isInteger(c) && c >= 0 && c < COLORS.length && colorLevel(c) <= level) out.color = c;
    if (Object.hasOwn(TRAIL_STYLES, skin.style) && TRAIL_STYLES[skin.style].level <= level) out.style = skin.style;
    return out;
  }

  /** Public matchmaking, or a friends' room when `code` is given. */
  join(c, code = null) {
    if (c.room) c.room.removeClient(c);
    let room = null;
    for (const r of this.rooms) {
      if (code ? r.code === code : r.canJoin()) { room = r; break; }
    }
    if (room && code && room.full()) {
      c.send({ t: 'error', msg: 'That room is full.' });
      return;
    }
    if (!room) {
      room = new Room(this, this.nextRoomId++, code);
      this.rooms.add(room);
    }
    room.addClient(c);
  }

  removeRoom(room) {
    this.rooms.delete(room);
  }

  step() {
    const t0 = performance.now();
    for (const room of this.rooms) {
      try {
        room.step();
      } catch (err) {
        console.error(`room ${room.id} crashed`, err);
        room.abort();
      }
    }
    const dt = performance.now() - t0;
    this.stepTotal += dt;
    this.stepCount++;
    if (dt > this.maxStep) this.maxStep = dt;
  }

  /** Every 2 s: tell players how healthy the server is, and log hiccups. */
  reportStats() {
    const lag = Math.round(this.maxLag);
    const cpu = this.measureCpu();
    if (cpu.machine > 80 && cpu.machine > cpu.game * 3 && Date.now() - this.lastCpuWarn > 60000) {
      this.lastCpuWarn = Date.now();
      console.warn(`[cpu] the server is busy (${cpu.machine}% of ${cpu.cores * 100}%) but the game itself uses only ${cpu.game}%: something else on this machine is using the CPU.`);
    }
    const stats = {
      cpu: cpu.game,          // this game server, % of one core
      cpuAll: cpu.machine,    // whole machine, % of one core (max cores*100)
      cores: cpu.cores,
      t: 'stats',
      lag,                                                     // worst loop delay (ms)
      step: +(this.stepTotal / Math.max(1, this.stepCount)).toFixed(2), // avg tick cost (ms)
      maxStep: +this.maxStep.toFixed(1),
      rooms: this.rooms.size,
      online: this.clients.size,
    };
    if (lag > 80 && Date.now() - this.lastWarn > 10000) {
      this.lastWarn = Date.now();
      console.warn(`[hiccup] game loop ran ${lag} ms late (avg tick ${stats.step} ms, worst ${stats.maxStep} ms, ` +
        `${stats.rooms} rooms, ${stats.online} players). If this repeats, the server is short on CPU.`);
    }
    for (const c of this.clients) {
      if (!c.room) continue;
      // Personal: longest gap between this player's inputs (upload direction).
      c.send({ ...stats, up: Math.round(c.maxInputGap) });
      c.maxInputGap = 0;
    }
    this.maxLag = 0;
    this.maxStep = 0;
    this.stepTotal = 0;
    this.stepCount = 0;
  }

  start() {
    // Fixed-rate loop that catches up if a timer fires late.
    let next = performance.now();
    const loop = () => {
      const now = performance.now();
      if (now - next > this.maxLag) this.maxLag = now - next;
      let n = 0;
      while (now >= next && n < 5) {
        this.step();
        next += TICK_MS;
        n++;
      }
      if (now - next > 250) next = now; // too far behind, skip ahead
      this.timer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    loop();
    this.statsTimer = setInterval(() => this.reportStats(), 2000);
    if (SIM_STALL_MS) {
      this.stallTimer = setInterval(() => {
        const until = performance.now() + SIM_STALL_MS;
        while (performance.now() < until) { /* busy-wait: block the event loop */ }
      }, 4000);
    }
    // Drop connections that have been silent for 20 s. The client sends an
    // app-level ping every second, so no WebSocket ping frames are needed.
    this.heartbeat = setInterval(() => {
      const now = performance.now();
      for (const c of this.clients) if (now - c.lastMsgAt > 20000) c.ws.terminate();
    }, 5000);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    clearInterval(this.statsTimer);
    clearInterval(this.stallTimer);
  }
}

function machineTimes() {
  let total = 0, idle = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}
