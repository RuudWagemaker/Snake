import { TICK_MS, TICK_RATE, KILLER_ZONE, KILLER_LEFT } from '../shared/constants.js';
import { decodeTick } from '../shared/protocol.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { ClientGame } from './game.js';
import { Renderer } from './render.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ui = {
  menu: $('menu'), lobby: $('lobby'), dead: $('dead'), end: $('end'), hud: $('hud'),
  name: $('name'), play: $('play'), status: $('status'),
  lobbyText: $('lobby-text'), lobbySub: $('lobby-sub'),
  deadTitle: $('dead-title'), deadSub: $('dead-sub'),
  endTitle: $('end-title'), ranking: $('ranking'), endSub: $('end-sub'),
  alive: $('alive'), kills: $('kills'), zoneInfo: $('zone-info'), feed: $('feed'), effects: $('effects'),
  center: $('center-msg'), touchL: $('touch-left'), touchR: $('touch-right'),
};

// Build fingerprint the server put into index.html; used to detect a stale page.
const BUILD = document.querySelector('meta[name="build"]')?.content || '';

/** The server runs a newer version than this page: reload (but never in a loop). */
function reloadForNewVersion() {
  let last = 0;
  try { last = Number(sessionStorage.getItem('cr-reload-at')) || 0; } catch {}
  if (Date.now() - last > 30000) {
    try { sessionStorage.setItem('cr-reload-at', String(Date.now())); } catch {}
    location.reload();
    return true;
  }
  return false;
}

const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const net = new Net();
const input = new Input(canvas);
const game = new ClientGame(net);
const renderer = new Renderer(canvas, $('minimap'));

let mode = 'menu';        // menu | lobby | game
let deadTimer = null;
let endTimer = null;
let spectateId = null;
const cam = { x: 0, y: 0, scale: renderer.baseScale };

// ---------------------------------------------------------------- UI helpers

function show(el, on = true) { el.hidden = !on; }
function hidePanels() { for (const p of [ui.menu, ui.lobby, ui.dead, ui.end]) show(p, false); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nameHtml(sn) {
  return `<b style="color:${sn.color}">${esc(sn.name)}</b>`;
}

function setMode(m) {
  mode = m;
  input.enabled = m === 'game';
  show(ui.hud, m === 'game');
  const touchHints = m === 'game' && isTouch;
  show(ui.touchL, touchHints);
  show(ui.touchR, touchHints);
  if (m !== 'game') ui.center.innerHTML = '';
}

function toMenu(status = '') {
  clearTimeout(deadTimer);
  clearTimeout(endTimer);
  hidePanels();
  game.active = false;
  setMode('menu');
  show(ui.menu);
  ui.status.textContent = status;
}

function savedName() {
  try { return localStorage.getItem('cr-name') || ''; } catch { return ''; }
}
function saveName(n) {
  try { localStorage.setItem('cr-name', n); } catch {}
}

async function goFullscreen() {
  if (!isTouch) return;
  try {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
  } catch {}
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  if (wakeLock) wakeLock.addEventListener?.('release', () => { wakeLock = null; });
}

function join() {
  const name = ui.name.value.trim();
  saveName(name);
  hidePanels();
  setMode('lobby');
  show(ui.lobby);
  ui.lobbyText.textContent = 'Finding a match…';
  ui.lobbySub.textContent = '';
  net.send({ t: 'join', name, build: BUILD });
  goFullscreen();
  keepAwake();
}

ui.name.value = savedName();
$('version').textContent = BUILD && !BUILD.includes('%') ? `version ${BUILD.slice(0, 7)}` : '';
ui.play.addEventListener('click', join);
ui.name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ui.play.disabled) join(); });
$('again').addEventListener('click', join);
$('to-menu').addEventListener('click', () => { net.send({ t: 'leave' }); toMenu(); });
addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && mode === 'menu' && document.activeElement !== ui.name && !ui.play.disabled) join();
  if ((e.code === 'Space' || e.code === 'Enter') && mode === 'game' && !game.controlling && !ui.dead.hidden) join();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && mode !== 'menu') keepAwake();
  // Animation frames stop in background tabs; send "straight" so the server
  // doesn't keep repeating a held turn while we're away.
  if (document.hidden && game.active && game.controlling) game.goStraight();
});

// Tap/click while spectating cycles through the surviving snakes.
canvas.addEventListener('pointerdown', () => {
  if (mode !== 'game' || game.controlling || !game.active) return;
  const alive = game.list.filter((s) => s.alive);
  if (!alive.length) return;
  const i = alive.findIndex((s) => s.id === spectateId);
  spectateId = alive[(i + 1) % alive.length].id;
});

// ---------------------------------------------------------------- kill feed

function feed(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  ui.feed.appendChild(div);
  while (ui.feed.children.length > 5) ui.feed.firstChild.remove();
  setTimeout(() => { div.style.opacity = '0'; }, 4500);
  setTimeout(() => div.remove(), 5000);
}

let flashUntil = 0;
game.onEvent = (ev) => {
  if (ev.type === 'pickup') {
    if (ev.hitsMe && !ev.def.good) {
      // an opponent's red power-up hit us: make it impossible to miss
      ui.center.innerHTML = `<span style="color:#ff6b81;font-size:0.6em">${ev.def.icon} ${ev.def.label.toUpperCase()}!</span><small>from ${esc(ev.by ? ev.by.name : '?')}</small>`;
      flashUntil = performance.now() + 1300;
    }
    return;
  }
  if (ev.type !== 'death') return;
  const s = ev.snake;
  const me = s === game.me;
  if (ev.killerId === KILLER_ZONE) feed(`${nameHtml(s)} was caught by the zone`);
  else if (ev.killerId === KILLER_LEFT) feed(`${nameHtml(s)} left`);
  else if (ev.killer === s) feed(`${nameHtml(s)} crashed into their own line`);
  else if (ev.killer) feed(`${nameHtml(ev.killer)} cut off ${nameHtml(s)}`);

  if (me) {
    spectateId = ev.killer && ev.killer !== s && ev.killer.alive ? ev.killer.id : null;
    clearTimeout(deadTimer);
    deadTimer = setTimeout(() => {
      if (game.ended || mode !== 'game') return;
      ui.deadTitle.textContent = `#${ev.msg.place} of ${game.total}`;
      let why;
      if (ev.killerId === KILLER_ZONE) why = 'Caught by the zone.';
      else if (ev.killer === s) why = 'You crashed into your own line.';
      else if (ev.killer) why = `Cut off by ${ev.killer.name}.`;
      else why = 'You crashed.';
      const k = game.me.kills;
      ui.deadSub.textContent = `${why} ${k} kill${k === 1 ? '' : 's'}.`;
      show(ui.dead);
    }, 900);
  } else if (spectateId === s.id) {
    spectateId = ev.killer && ev.killer.alive ? ev.killer.id : null;
  }
};

// ---------------------------------------------------------------- network

net.onOpen = () => {
  ui.play.disabled = false;
  ui.play.textContent = 'PLAY';
  if (mode === 'menu') ui.status.textContent = '';
};

net.onClose = () => {
  ui.play.disabled = true;
  ui.play.textContent = 'Connecting…';
  toMenu('Connection lost. Reconnecting…');
};

net.onJson = (m) => {
  switch (m.t) {
    case 'hello':
      if (m.build && BUILD && m.build !== BUILD && reloadForNewVersion()) return;
      if (m.rtc) net.startRtc();
      ui.status.textContent = m.online > 1 ? `${m.online} players online` : '';
      break;
    case 'lobby':
      if (mode === 'menu') return;
      if (mode === 'game' && game.ended && !ui.end.hidden) {
        // still showing results; the end panel shows the countdown
        ui.endSub.textContent = `Next round in ${m.startsIn}s`;
        return;
      }
      hidePanels();
      setMode('lobby');
      game.active = false;
      show(ui.lobby);
      ui.lobbyText.textContent = `Starting in ${m.startsIn}s`;
      ui.lobbySub.textContent = m.players > 1
        ? `${m.players} players in this match · bots fill the rest`
        : 'Waiting for players · bots fill the rest';
      break;
    case 'start':
      if (mode === 'menu') return;
      clearTimeout(deadTimer);
      clearTimeout(endTimer);
      hidePanels();
      game.start(m);
      spectateId = null;
      ui.feed.innerHTML = '';
      ui.effects.innerHTML = '';
      flashUntil = 0;
      setMode('game');
      cam.x = game.me.xs[0];
      cam.y = game.me.ys[0];
      cam.scale = renderer.baseScale;
      break;
    case 'death':
      if (game.active) game.onDeath(m);
      break;
    case 'items':
      if (game.active) game.onItems(m);
      break;
    case 'pickup':
      if (game.active) game.onPickup(m);
      break;
    case 'end':
      if (!game.active) return;
      game.onEnd(m);
      clearTimeout(deadTimer);
      show(ui.dead, false);
      // Let the final crash play out before showing results.
      endTimer = setTimeout(() => showEnd(m), 1200);
      break;
    case 'stats':
      diag.server(m);
      break;
    case 'error':
      if (m.reload && reloadForNewVersion()) return;
      toMenu(m.msg || 'Something went wrong');
      break;
  }
};

net.onBinary = (buf, via) => {
  if (!game.active) return;
  const d = decodeTick(buf);
  if (d && game.onTick(d, via)) diag.update();
};

function showEnd(m) {
  if (mode !== 'game') return;
  const winner = m.winner ? game.snakes.get(m.winner) : null;
  if (winner && winner === game.me) ui.endTitle.textContent = '\u{1F3C6} You win!';
  else if (winner) ui.endTitle.innerHTML = `\u{1F3C6} ${nameHtml(winner)} wins`;
  else ui.endTitle.textContent = 'Draw!';
  ui.ranking.innerHTML = m.ranking.slice(0, 10).map((r) => {
    const s = game.snakes.get(r.id);
    const me = r.id === game.myId;
    return `<li class="${me ? 'me' : ''}">${s ? nameHtml(s) : esc(r.name)}${me ? ' (you)' : ''}<span class="k">${r.kills} kill${r.kills === 1 ? '' : 's'}</span></li>`;
  }).join('');
  const mine = m.ranking.find((r) => r.id === game.myId);
  if (mine && mine.place > 10) {
    ui.ranking.innerHTML += `<li class="me" value="${mine.place}">You<span class="k">${mine.kills} kills</span></li>`;
  }
  ui.endSub.textContent = 'Next round starting soon…';
  show(ui.end);
}

// ---------------------------------------------------------------- main loop

const myHead = { x: 0, y: 0, a: 0 };
const spec = { x: 0, y: 0, a: 0 };
let last = performance.now();
let hudAt = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = now - last;
  const dt = Math.min(250, rawDt);
  last = now;
  diag.frame(rawDt);

  if (!game.active) {
    renderer.drawIdle(now);
    return;
  }

  input.pollGamepads();
  game.generateInputs(now, input.turn, net.rttMedian);
  game.decayOffset(dt);

  const renderTick = game.renderTick(now);
  const serverTick = game.serverTickNow(now);
  const zone = game.zone(now);

  // Camera
  let targetScale = renderer.baseScale;
  if (game.controlling) {
    game.myHead(myHead);
    cam.x = myHead.x;
    cam.y = myHead.y;
  } else {
    let target = spectateId ? game.snakes.get(spectateId) : null;
    if (!target || target.deathTick <= renderTick) {
      target = game.me && game.me.deathTick > renderTick ? game.me : null;
      if (!target && !game.ended) {
        // follow the leader: most kills among the living
        let best = null;
        for (const s of game.list) if (s.alive && (!best || s.kills > best.kills)) best = s;
        if (best) { spectateId = best.id; target = best; }
      }
    }
    if (target) {
      const ex = target.deathTick > renderTick && renderTick > target.lastTick ? game.extrapolate(target, renderTick) : null;
      if (ex) { spec.x = ex.head.x; spec.y = ex.head.y; }
      else target.headAt(target.deathTick <= renderTick ? target.lastTick : renderTick, spec);
    } else {
      spec.x = cam.x; spec.y = cam.y;
    }
    const k = 1 - Math.exp(-dt / 180);
    cam.x += (spec.x - cam.x) * k;
    cam.y += (spec.y - cam.y) * k;
    targetScale = renderer.baseScale * 0.8;
  }
  cam.scale += (targetScale - cam.scale) * (1 - Math.exp(-dt / 300));

  renderer.draw(game, { now, renderTick, serverTick, myHead, cam, zone });

  // Countdown / center message (every frame, cheap)
  const toGo = (game.playTick - serverTick) / TICK_RATE;
  if (toGo > 0) ui.center.innerHTML = `${Math.ceil(toGo)}<small>${isTouch ? 'hold left / right to steer' : '← → to steer'}</small>`;
  else if (toGo > -0.8) ui.center.textContent = 'GO!';
  else if (now < flashUntil) { /* showing a power-up warning */ }
  else if (ui.center.innerHTML) ui.center.innerHTML = '';

  // Touch hints
  if (isTouch) {
    const t = input.turn;
    ui.touchL.classList.toggle('on', game.controlling && t < 0);
    ui.touchR.classList.toggle('on', game.controlling && t > 0);
  }

  if (now - hudAt > 200) {
    hudAt = now;
    updateHud(zone, serverTick);
    diag.render(now);
  }
}

function updateHud(zone, serverTick) {
  const fx = game.controlling ? game.myEffects(performance.now()) : [];
  ui.effects.innerHTML = fx.map((e) =>
    `<div class="fx ${e.def.good ? 'good' : 'bad'}${e.pending ? ' pending' : ''}">${e.def.icon} ${e.def.label} ${Math.ceil(e.left)}s` +
    `<i style="width:${Math.max(0, Math.min(100, (100 * e.left) / e.total))}%"></i></div>`).join('');
  ui.alive.textContent = `\u{1F40D} ${game.aliveCount} / ${game.total} alive`;
  const k = game.me ? game.me.kills : 0;
  const ms = Math.round(net.rtt);
  const col = ms > 150 ? '#ff6b6b' : ms > 80 ? '#ffd43b' : '#69db7c';
  const rtt = ms ? ` · <span style="color:${col}">${ms} ms</span>` : '';
  ui.kills.innerHTML = `⚔ ${k} kill${k === 1 ? '' : 's'}${rtt}`;
  let txt = '', warn = false;
  if (serverTick < game.playTick) txt = 'Get ready';
  else if (game.ended) txt = 'Round over';
  else if (zone.r <= 0) { txt = 'Zone closed'; warn = true; }
  else if (zone.shrinking) { txt = `Zone closing! ${Math.ceil(zone.ticksLeft / TICK_RATE)}s`; warn = true; }
  else if (zone.next) txt = `Zone shrinks in ${Math.ceil(zone.ticksLeft / TICK_RATE)}s`;
  ui.zoneInfo.textContent = txt;
  ui.zoneInfo.classList.toggle('warn', warn);
}

// ---------------------------------------------------------------- diagnostics
// Tap the kills/ping pill (or press N) to show where lag spikes come from:
// your device (slow frames), the network (gaps between updates) or the server.

const diag = {
  el: $('net'),
  on: false,
  win: { frame: 0, gap: 0, frames: 0 },   // current 2 s window
  shown: { fps: 0, frame: 0, gap: 0, ping: 0 },
  lastUpdateAt: 0,
  upGapAt: -1e9,
  srv: { lag: 0, step: 0, maxStep: 0, up: 0 },
  spikes: [],                              // recent spikes {at, what, ms}
  winStart: performance.now(),

  toggle(force) {
    this.on = force ?? !this.on;
    show(this.el, this.on);
    try { localStorage.setItem('cr-net', this.on ? '1' : ''); } catch {}
  },
  spike(what, ms, now = performance.now()) {
    const last = this.spikes[this.spikes.length - 1];
    if (last && last.what === what && now - last.at < 500) { last.ms = Math.max(last.ms, ms); return; }
    this.spikes.push({ at: now, what, ms: Math.round(ms) });
    if (this.spikes.length > 4) this.spikes.shift();
  },
  frame(dt) {
    this.win.frames++;
    if (dt > this.win.frame) this.win.frame = dt;
    if (dt > 100 && dt < 2000 && mode === 'game' && !document.hidden) this.spike('device', dt);
  },
  update() {
    const now = performance.now();
    if (this.lastUpdateAt) {
      const gap = now - this.lastUpdateAt;
      if (gap > this.win.gap) this.win.gap = gap;
      // Normal gap is ~33 ms. A long gap is blamed on the network unless the
      // server reported a hiccup, or our own device froze, around that time.
      if (gap > 150 && gap < 5000 && !document.hidden) {
        setTimeout(() => {
          const explained = this.spikes.some((s) => !s.what.startsWith('network') && Math.abs(s.at - now) < 2500);
          // Did the server also stop hearing from us? Then the connection was silent both ways.
          const both = Math.abs(this.upGapAt - now) < 3000;
          if (!explained) this.spike(both ? 'network, both ways' : 'network, download', gap, now);
        }, 2200);
      }
    }
    this.lastUpdateAt = now;
  },
  server(m) {
    this.srv = m;
    if (m.up > 150) this.upGapAt = performance.now();
    if (m.lag > 80) this.spike('server', m.lag);
  },
  render(now) {
    if (now - this.winStart >= 2000) {
      const secs = (now - this.winStart) / 1000;
      this.shown = { fps: Math.round(this.win.frames / secs), frame: Math.round(this.win.frame), gap: Math.round(this.win.gap), ping: Math.round(net.rttMax) };
      net.rttMax = 0;
      this.win = { frame: 0, gap: 0, frames: 0 };
      this.winStart = now;
    }
    if (!this.on) return;
    const c = (v, bad) => `<span class="${v > bad ? 'bad' : 'ok'}">${v}</span>`;
    const st = game.stats || { late: 0, corrections: 0 };
    const sh = this.shown;
    const pingMax = sh.ping || 0;
    let out =
      `<b>Version</b> ${BUILD.slice(0, 7)}\n` +
      `<b>Device </b> ${sh.fps} fps, slowest frame ${c(sh.frame, 100)} ms\n` +
      `<b>Network</b> ${net.udpOpen ? 'UDP' : 'WebSocket'}, ping ${Math.round(net.rtt)} ms (worst ${c(pingMax, 150)})\n` +
      `<b>Gaps   </b> download ${c(sh.gap, 150)} ms, upload ${c(this.srv.up || 0, 150)} ms\n` +
      `<b>Server </b> hiccup ${c(this.srv.lag, 80)} ms, tick ${this.srv.step} ms (worst ${this.srv.maxStep})\n` +
      (this.srv.cores ? `<b>CPU    </b> game ${c(this.srv.cpu, 50)}%, whole server ${c(this.srv.cpuAll, 70 * this.srv.cores)}% of ${this.srv.cores * 100}%\n` : '') +
      `<b>You    </b> late inputs ${st.late}, corrections ${st.corrections}, lead ${game.lead ? Math.round(game.lead) : 0} (+${game.margin || 0})` +
      (net.udpOpen ? `\n<b>UDP    </b> ${Math.round(100 * st.viaUdp / Math.max(1, st.viaUdp + st.viaWs))}% of updates first via UDP, ${st.filled} filled in` : '');
    if (this.spikes.length) {
      out += '\n<b>Recent spikes</b>';
      for (const s of this.spikes.slice().reverse()) {
        out += `\n  ${String(s.ms).padStart(4)} ms ${s.what}, ${Math.round((now - s.at) / 1000)}s ago`;
      }
    }
    this.el.innerHTML = out;
  },
};
ui.kills.addEventListener('click', () => diag.toggle());
addEventListener('keydown', (e) => { if (e.code === 'KeyN' && !(e.target instanceof HTMLInputElement)) diag.toggle(); });
try { if (localStorage.getItem('cr-net') || new URLSearchParams(location.search).has('net')) diag.toggle(true); } catch {}

if (new URLSearchParams(location.search).has('debug')) window.__cr = { game, net, input };

requestAnimationFrame(frame);
net.connect();
