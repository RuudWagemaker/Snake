import { TICK_MS, TICK_RATE, KILLER_ZONE, KILLER_LEFT, COLORS, TRAIL_STYLES, colorLevel, MAX_FUEL, SKILLS, SKILL_IDS, SKILL_SLOTS, validSkills } from '../shared/constants.js';
import { decodeTick } from '../shared/protocol.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { ClientGame } from './game.js';
import { Renderer } from './render.js';
import { sound } from './sound.js';
import { platform } from './platform.js';

// On CrazyGames: start their SDK first (a few seconds at most; a no-op on lineclash.com).
await platform.init();
platform.loading(true);

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ui = {
  menu: $('menu'), lobby: $('lobby'), dead: $('dead'), end: $('end'), hud: $('hud'), lb: $('lb'),
  me: $('me'), lbList: $('lb-list'), lbMe: $('lb-me'), result: $('result'),
  skin: $('skin'), roomInfo: $('room-info'), lobbyRoom: $('lobby-room'), inviteMsg: $('invite-msg'), shareMsg: $('share-msg'),
  name: $('name'), play: $('play'), status: $('status'),
  lobbyText: $('lobby-text'), lobbySub: $('lobby-sub'),
  deadTitle: $('dead-title'), deadSub: $('dead-sub'),
  endTitle: $('end-title'), ranking: $('ranking'), endSub: $('end-sub'),
  tip: $('tip'), alive: $('alive'), kills: $('kills'), zoneInfo: $('zone-info'), feed: $('feed'), effects: $('effects'),
  center: $('center-msg'),
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
// ---------------------------------------------------------------- ads
// Only when the server is set up for AdSense (a <meta name="ads"> tag): one ad on
// the "starting soon" screen. A new ad element each time; Google fills it.
const adCfg = (document.querySelector('meta[name="ads"]')?.content || '').split('|');
function showLobbyAd() {
  const box = document.getElementById('ad-lobby');
  const [client, slot] = adCfg;
  if (!client || !slot || !window.adsbygoogle) { show(box, false); return; }
  box.innerHTML = `<ins class="adsbygoogle" style="display:block" data-ad-client="${client}" data-ad-slot="${slot}" data-ad-format="horizontal" data-full-width-responsive="true"></ins>`;
  show(box);
  try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch {}
}

// ---------------------------------------------------------------- skills
// Two skills, picked in the menu (saved in localStorage), used with the buttons
// on the right (touch), Space / Shift (keyboard) or A / B (gamepad).
let mySkills = ['rocket', 'jump'];
try { mySkills = validSkills(JSON.parse(localStorage.getItem('cr-skills') || 'null')); } catch {}
const skillBar = document.getElementById('skillbar');
const skillBtns = [...document.querySelectorAll('.skillbar .skill')];
function useSlot(slot) {
  if (mode !== 'game' || !game.active || !game.me) return;
  if (game.useSkill(game.me.skills[slot])) {
    for (const btn of skillBtns) if (Number(btn.dataset.slot) === slot) {
      btn.classList.add('bang');
      setTimeout(() => btn.classList.remove('bang'), 140);
    }
    showSkillBar();
  }
}
input.onSkill = useSlot;
for (const b of skillBtns) {
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); useSlot(Number(b.dataset.slot)); });
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}
if (isTouch) { skillBar.classList.add('touch'); document.documentElement.classList.add('touch'); }

// Touch: faint ◀ ▶ in the bottom corners, lit while that half is held
const steerL = document.getElementById('steer-l'), steerR = document.getElementById('steer-r');
const game = new ClientGame(net);
const renderer = new Renderer(canvas, $('minimap'));

let mode = 'menu';        // menu | lobby | game
let deadTimer = null;
let endTimer = null;
let spectateId = null;
const cam = { x: 0, y: 0, scale: renderer.baseScale };

// ---------------------------------------------------------------- UI helpers

function show(el, on = true) { el.hidden = !on; }
function hidePanels() { for (const p of [ui.menu, ui.lobby, ui.dead, ui.end, ui.lb, ui.skin, $('skills')]) show(p, false); }

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
  requestProfile();
}

function savedName() {
  try { return localStorage.getItem('cr-name') || ''; } catch { return ''; }
}
function saveName(n) {
  try { localStorage.setItem('cr-name', n); } catch {}
}

/** Anonymous id for this browser: it's how the server keeps your stats. */
function token() {
  let t = '';
  try { t = localStorage.getItem('cr-token') || ''; } catch {}
  if (!/^[a-f0-9]{32}$/.test(t)) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    t = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('cr-token', t); } catch {}
  }
  return t;
}
let TOKEN = token();

// ---------------------------------------------------------------- Google sign-in
// Optional: only offered when the server has a Google client id. Signing in
// links this browser's progress to the Google account, or (on another device)
// switches to the account's progress. Signing out starts a fresh guest.

let googleReady = false;
function googleExpected() {
  try { return localStorage.getItem('cr-google') === '1'; } catch { return false; }
}
function accountName() {
  try { return localStorage.getItem('cr-account'); } catch { return null; }
}
function showAccount() {
  const el = $('account');
  const name = accountName();
  if (name !== null) {
    el.innerHTML = `Signed in${name ? ' as <b>' + esc(name) + '</b>' : ''}<a id="sign-out">sign out</a>`;
    $('sign-out').addEventListener('click', signOut);
    show(el);
  } else if (googleReady || googleExpected()) {
    // Until Google's script has loaded, keep the button's space free (no jump later).
    el.innerHTML = '<div id="gbtn"></div><div class="small">Sign in to keep your level on every device</div>';
    if (googleReady) window.google.accounts.id.renderButton($('gbtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 240 });
    show(el);
  } else {
    show(el, false);
  }
}
function setupGoogle(clientId) {
  try { localStorage.setItem('cr-google', '1'); } catch {}
  if (googleReady || document.getElementById('gsi')) return;
  const s = document.createElement('script');
  s.id = 'gsi';
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (r) => { if (r && r.credential) net.send({ t: 'login', credential: r.credential, token: TOKEN }); },
    });
    googleReady = true;
    showAccount();
  };
  document.head.appendChild(s);
}
function onLogin(m) {
  if (!m.ok || !/^[a-f0-9]{32}$/.test(m.token || '')) {
    ui.status.textContent = m.busy ? 'Too many sign-in attempts. Try again in a minute.' : 'Sign-in failed. Please try again.';
    return;
  }
  try {
    // Keep this browser's guest progress, to get it back when signing out.
    if (accountName() === null && TOKEN !== m.token) localStorage.setItem('cr-guest', TOKEN);
    localStorage.setItem('cr-token', m.token);
    localStorage.setItem('cr-account', m.name || '');
  } catch {}
  TOKEN = m.token;
  showAccount();
  requestProfile();
}
function signOut() {
  try {
    const guest = localStorage.getItem('cr-guest');
    if (guest && /^[a-f0-9]{32}$/.test(guest)) localStorage.setItem('cr-token', guest); // back to this browser's guest progress
    else localStorage.removeItem('cr-token');
    localStorage.removeItem('cr-guest');
    localStorage.removeItem('cr-account');
    localStorage.removeItem('cr-profile');
  } catch {}
  try { window.google?.accounts.id.disableAutoSelect(); } catch {}
  location.reload(); // the guest token (or a fresh one) on the next load
}
showAccount();

function requestProfile() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  net.send({ t: 'profile', token: TOKEN, tz });
}

function xpBar(p) {
  return `<div class="xpbar"><i style="width:${Math.round((100 * p.into) / Math.max(1, p.need))}%"></i></div>`;
}

let myLevel = 1, lastProfile = null;
function showMissions(list) {
  const el = $('missions');
  show(el, !!(list && list.length));
  if (!list || !list.length) return;
  el.innerHTML = '<div class="mt">Daily missions</div>' + list.map((m) => {
    const done = m.have >= m.goal;
    const prog = done ? '\u2713' : m.goal > 1 ? `${m.have}/${m.goal}` : '';
    return `<div class="m${done ? ' done' : ''}"><span>${esc(m.text)}</span><b>${prog}</b><i>+${m.xp} XP</i></div>`;
  }).join('');
}
function showProfile(p) {
  lastProfile = p;
  try { localStorage.setItem('cr-profile', JSON.stringify(p)); } catch {} // shown right away next time
  myLevel = p.level;
  if (!p.games && !p.xp) {
    ui.me.innerHTML = roomCode ? "Rooms give XP, not leaderboard points." : 'Play a match to get on the leaderboard.';
  } else if (!p.games) {
    ui.me.innerHTML = `<b>Level ${p.level}</b> · ${p.into} / ${p.need} XP${xpBar(p)}` + (roomCode ? '<div class="small">Rooms give XP, not leaderboard points.</div>' : '');
  } else {
    ui.me.innerHTML = `<b>Level ${p.level}</b> · ${p.into} / ${p.need} XP${xpBar(p)}` +
      `${p.games} game${p.games === 1 ? '' : 's'} · ${p.wins} win${p.wins === 1 ? '' : 's'} · ${p.kills} kill${p.kills === 1 ? '' : 's'} · best #${p.best}` +
      (roomCode ? '<div class="small">Rooms give XP, not leaderboard points.</div>' : '');
  }
  showMissions(p.missions);
  show(ui.me);
  if (mode === 'menu') ui.status.textContent = p.online > 1 ? `${p.online} players online` : '';
}

// ---------------------------------------------------------------- leaderboard

let lbPeriod = 'day';
function openLeaderboard(period = lbPeriod) {
  lbPeriod = period;
  for (const b of ui.lb.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.period === period);
  ui.lbList.innerHTML = '<li class="empty">Loading…</li>';
  ui.lbMe.textContent = '';
  hidePanels();
  show(ui.lb);
  net.send({ t: 'lb', period });
}
function showLeaderboard(m) {
  if (m.period !== lbPeriod || ui.lb.hidden) return;
  ui.lbList.innerHTML = m.top.length
    ? m.top.map((e) => `<li class="${e.me ? 'me' : ''}">${esc(e.name)}<span class="lv">lv ${e.level}</span>` +
      `<span class="k">${e.points} pts</span></li>`).join('')
    : '<li class="empty">Nobody yet. Be the first!</li>';
  const when = { day: 'today', week: 'this week', all: 'so far' }[m.period];
  ui.lbMe.textContent = m.me
    ? `You're #${m.me.rank} of ${m.players} ${when} with ${m.me.points} point${m.me.points === 1 ? '' : 's'} (${m.me.games} game${m.me.games === 1 ? '' : 's'}).`
    : `You haven't played ${when === 'so far' ? 'yet' : when}.`;
}
$('lb-open').addEventListener('click', () => openLeaderboard());
$('lb-close').addEventListener('click', () => toMenu());
for (const b of ui.lb.querySelectorAll('.tabs button')) b.addEventListener('click', () => openLeaderboard(b.dataset.period));

let lastResult = null;
function showResult(m) {
  lastResult = m;
  if (mode === 'lobby') {
    // left the match after crashing ("Play again"): its points and XP still count
    const el = $('lobby-xp');
    el.innerHTML = `Last match: ${m.ranked ? `+${m.points} point${m.points === 1 ? '' : 's'} · ` : ''}+${m.xpGained} XP` +
      (m.levelUp ? `<div class="up">\u2B06 Level&nbsp;${m.level}!</div>` : '') +
      (m.missionsDone || []).map((d) => `<div>\u2713 ${esc(d.text)} · +${d.xp} XP</div>`).join('');
    show(el);
    if (m.levelUp) sound.play('win');
  }
  ui.result.innerHTML = (m.ranked
    ? `<div class="pts">+${m.points} point${m.points === 1 ? '' : 's'} · +${m.xpGained} XP</div>`
    : `<div class="pts">+${m.xpGained} XP</div><div class="small">Friends' rooms don't count for the leaderboard</div>`) +
    (m.missionsDone || []).map((d) => `<div class="mdone">\u2713 ${esc(d.text)} · +${d.xp} XP</div>`).join('') +
    (m.levelUp ? `<div class="up">\u2B06 Level ${m.level}!</div>` : `<div>Level ${m.level} · ${m.into} / ${m.need} XP</div>`) +
    xpBar(m);
}

// ---------------------------------------------------------------- style (unlockables)
// Colour and trail style, unlocked by level. The server checks the level too.

let skin = { color: -1, style: 'plain' };
try { skin = { ...skin, ...JSON.parse(localStorage.getItem('cr-skin') || '{}') }; } catch {}

function renderSkin() {
  const lock = (lv) => `<span class="lk">\u{1F512}${lv}</span>`;
  $('swatches').innerHTML =
    `<button data-c="-1" class="${skin.color === -1 ? 'on' : ''}" title="Any colour">?</button>` +
    COLORS.map((c, i) => {
      const lv = colorLevel(i), locked = lv > myLevel;
      return `<button data-c="${i}" class="${skin.color === i ? 'on' : ''}${locked ? ' locked' : ''}" ` +
        `style="background:${c}" title="${locked ? 'Level ' + lv : ''}">${locked ? lock(lv) : ''}</button>`;
    }).join('');
  $('styles').innerHTML = Object.entries(TRAIL_STYLES).map(([k, st]) => {
    const locked = st.level > myLevel;
    return `<button data-s="${k}" class="${skin.style === k ? 'on' : ''}${locked ? ' locked' : ''}">${st.label}${locked ? lock(st.level) : ''}</button>`;
  }).join('');
}
function pickSkin(next, lv) {
  if (lv > myLevel) { $('skin-msg').textContent = `Reach level ${lv} to unlock this (you're level ${myLevel}).`; return; }
  skin = { ...skin, ...next };
  try { localStorage.setItem('cr-skin', JSON.stringify(skin)); } catch {}
  $('skin-msg').textContent = 'Saved. You get this colour unless someone in the match already has it.';
  renderSkin();
}
$('swatches').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const c = Number(b.dataset.c);
  pickSkin({ color: c }, c < 0 ? 1 : colorLevel(c));
});
$('styles').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) pickSkin({ style: b.dataset.s }, TRAIL_STYLES[b.dataset.s].level);
});
$('skin-open').addEventListener('click', () => { renderSkin(); $('skin-msg').textContent = 'Level up to unlock more.'; hidePanels(); show(ui.skin); });
$('skin-close').addEventListener('click', () => toMenu());

// Skills panel: tap a card to pick it; a third pick replaces the oldest one.
function skillsLine() {
  $('skills-open').innerHTML = 'Skills: ' + mySkills.map((k) => `${SKILLS[k].icon} ${SKILLS[k].label}`).join(' &middot; ') + ' <span>change</span>';
}
function renderSkills() {
  $('skill-cards').innerHTML = SKILL_IDS.map((k) => {
    const d = SKILLS[k], on = mySkills.includes(k);
    return `<button data-k="${k}" class="${on ? 'on' : ''}"><span>${d.icon}</span><b>${d.label}</b><i>${d.cost} fuel</i><small>${d.help}</small></button>`;
  }).join('');
  $('skills-msg').textContent = `Picked: ${mySkills.map((k) => SKILLS[k].label).join(' + ')}`;
}
$('skill-cards').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || mySkills.includes(b.dataset.k)) return;
  mySkills = [...mySkills.slice(1 - SKILL_SLOTS + mySkills.length), b.dataset.k].slice(-SKILL_SLOTS);
  try { localStorage.setItem('cr-skills', JSON.stringify(mySkills)); } catch {}
  renderSkills();
  skillsLine();
});
$('skills-open').addEventListener('click', () => { renderSkills(); hidePanels(); show($('skills')); });
$('skills-close').addEventListener('click', () => toMenu());
skillsLine();

// ---------------------------------------------------------------- friends' rooms
// A room is just a short code in the link (?room=abc12). Everyone who opens the
// link plays in the same room; bots still fill the empty seats.

const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const validCode = (s) => typeof s === 'string' && /^[a-z0-9]{4,10}$/.test(s);
let roomCode = platform.crazy ? platform.inviteRoom() : new URLSearchParams(location.search).get('room');
if (!validCode(roomCode)) roomCode = null;
// "Play with friends" on CrazyGames: straight into a new friends' room once connected.
let autoJoin = !!roomCode && platform.crazy;
if (platform.crazy && !roomCode && platform.instantMultiplayer) { roomCode = newRoomCode(); autoJoin = true; }
function newRoomCode() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return [...b].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

function setRoom(code) {
  roomCode = code;
  platform.room(code);
  if (platform.crazy) { showRoomInfo(); return; }
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
  showRoomInfo();
}
async function roomLink() {
  if (platform.crazy) return (roomCode && (await platform.inviteLink(roomCode))) || '';
  const url = new URL(location.origin + location.pathname);
  if (roomCode) url.searchParams.set('room', roomCode);
  return url.toString();
}
function showRoomInfo() {
  show(ui.roomInfo, !!roomCode);
  ui.roomInfo.innerHTML = roomCode ? `&#128101; Friends' room <b>${roomCode}</b><a id="leave-room">leave</a>` : '';
  if (roomCode) $('leave-room').addEventListener('click', () => setRoom(null));
  if (!ui.play.disabled) ui.play.textContent = roomCode ? 'JOIN ROOM' : 'PLAY';
  $('friends').textContent = roomCode ? '\u{1F517} Invite' : '\u{1F465} Friends';
  if (lastProfile) showProfile(lastProfile);
}

/** Native share sheet on phones, otherwise copy to the clipboard. */
async function share(text, url, msgEl) {
  const say = (s) => { msgEl.textContent = s; show(msgEl); };
  url = await url;
  if (!url) { say('Could not make a link. Try again in a moment.'); return; }
  if (navigator.share) {
    try { await navigator.share({ title: 'Line Clash', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    say('Link copied. Send it to your friends!');
  } catch {
    say(url);
  }
}

function invite(msgEl) {
  share('Come play Line Clash with me!', roomLink(), msgEl);
}

$('friends').addEventListener('click', () => {
  if (roomCode) { invite(ui.status); return; }
  setRoom(newRoomCode());
  join();
});
$('invite').addEventListener('click', () => invite(ui.inviteMsg));
$('go').addEventListener('click', () => net.send({ t: 'go' }));
// Hidden trick: tap the spinner 3 times quickly to skip the wait (only when you're alone in the lobby).
let spinTaps = [];
$('spinner').addEventListener('pointerdown', () => {
  const now = performance.now();
  spinTaps = spinTaps.filter((t) => now - t < 1500).concat(now);
  if (spinTaps.length >= 3) { spinTaps = []; net.send({ t: 'go' }); }
});
$('share').addEventListener('click', () => {
  const r = lastResult;
  const text = r
    ? (r.place === 1 ? `I won a round of Line Clash against ${r.n - 1} others with ${r.kills} kill${r.kills === 1 ? '' : 's'}! Can you beat me?`
      : `I came #${r.place} of ${r.n} in Line Clash with ${r.kills} kill${r.kills === 1 ? '' : 's'}. Can you beat me?`)
    : 'Play Line Clash with me!';
  share(text, roomLink(), ui.shareMsg);
});
platform.onJoinRoom((code) => {
  if (!validCode(code)) return;
  if (mode !== 'menu') net.send({ t: 'leave' });
  setRoom(code);
  if (!ui.play.disabled) join(); else autoJoin = true;
});
showRoomInfo();
// Last known level and missions straight away (fresh ones replace them in a moment).
try {
  const cached = JSON.parse(localStorage.getItem('cr-profile') || 'null');
  if (cached && typeof cached === 'object' && cached.level) showProfile({ ...cached, online: 0 });
} catch {}

async function goFullscreen() {
  if (!isTouch || platform.crazy) return; // the CrazyGames app is fullscreen already
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

// A match was played since the last join: on CrazyGames, the next join may show a video ad first.
let adDue = false;
let adBusy = false;
/** Join a match. {fresh: true}: start a new game instead of waiting for a running match to end. */
function join(opts) {
  if (adBusy) return;
  const fresh = opts?.fresh === true;
  const name = ui.name.value.trim();
  saveName(name);
  hidePanels();
  setMode('lobby');
  show(ui.lobby);
  ui.lobbyText.textContent = 'Finding a match…';
  ui.lobbySub.textContent = '';
  show(ui.lobbyRoom, false);
  show($('fresh'), false);
  show($('lobby-xp'), false);
  ui.inviteMsg.textContent = '';
  if (adDue && platform.ready) {
    adDue = false;
    adBusy = true;
    net.send({ t: 'leave' }); // out of any match while the ad plays
    platform.midgameAd({ started: () => sound.hold(true), done: () => sound.hold(false) }).then(() => {
      adBusy = false;
      if (mode === 'lobby') join(opts);
    });
    return;
  }
  net.send({ t: 'join', name, build: BUILD, token: TOKEN, room: roomCode, skin, skills: mySkills, fresh: fresh || undefined });
  goFullscreen();
  keepAwake();
}

ui.name.value = savedName();
// On CrazyGames, players are known by their CrazyGames name (until they type another).
if (platform.crazy && !ui.name.value) platform.username().then((n) => { if (n && !ui.name.value) ui.name.value = n.slice(0, 16); });
sound.blockWhen(() => platform.muted);
$('version').textContent = BUILD && !BUILD.includes('%') ? `version ${BUILD.slice(0, 7)}` : '';
ui.play.addEventListener('click', join);
ui.name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ui.play.disabled) join(); });
$('again').addEventListener('click', join);
$('fresh').addEventListener('click', () => join({ fresh: true }));
$('to-menu').addEventListener('click', () => { net.send({ t: 'leave' }); toMenu(); });
addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && mode === 'menu' && !ui.menu.hidden && document.activeElement !== ui.name && !ui.play.disabled) join();
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

// Multi-kills: kills by the same snake within 3 s. "First blood" for the first kill of a round.
let streaks = new Map(), firstBlood = false;
function killTag(killer, tick) {
  if (!firstBlood) { firstBlood = true; return 'FIRST BLOOD'; }
  const st = streaks.get(killer.id);
  const n = st && tick - st.tick <= 3 * TICK_RATE ? st.n + 1 : 1;
  streaks.set(killer.id, { n, tick });
  return n === 2 ? 'DOUBLE KILL' : n === 3 ? 'TRIPLE KILL' : n >= 4 ? 'RAMPAGE' : '';
}

// Tips during the first few matches (until the player has seen them all).
const TIPS = [
  { at: 2, text: 'Gaps open in every line now and then. You can slip through them!' },
  { at: 9, text: 'The zone is shrinking soon. Stay inside the circle!' },
  { at: 17, text: isTouch ? 'Orange dots are fuel. Spend it on your skills with the buttons on the right.' : 'Orange dots are fuel. Spend it on your skills: Space and Shift.' },
  { at: 27, text: 'Cut others off: make them crash into your line to score kills.' },
  // `first`: when it's the first tip of a match (players who saw the others already)
  { at: 40, first: 6, text: 'A crashed snake drops all its fuel. Go and grab it!' },
];
let tipsSeen = 0;
try { tipsSeen = Number(localStorage.getItem('cr-tips')) || 0; } catch {}
let tipUntil = 0, tipsThisMatch = 0;
function updateTip(serverTick, now) {
  if (tipsSeen < TIPS.length && game.controlling) {
    const t = TIPS[tipsSeen];
    if ((serverTick - game.playTick) / TICK_RATE >= (tipsThisMatch === 0 && t.first ? t.first : t.at)) {
      tipsThisMatch++;
      ui.tip.textContent = t.text;
      show(ui.tip);
      tipUntil = now + 5000;
      tipsSeen++;
      try { localStorage.setItem('cr-tips', String(tipsSeen)); } catch {}
    }
  }
  if (!ui.tip.hidden && (now > tipUntil || !game.controlling)) show(ui.tip, false);
}

let flashUntil = 0;
let lastBeat = -1, zoneWarned = false;
game.onEvent = (ev) => {
  if (ev.type === 'pickup') {
    if (ev.by === game.me) sound.play('fuel');
    return;
  }
  if (ev.type === 'skill') {
    if (ev.mine) { sound.play(ev.k); sound.vibrate(15); }
    return;
  }
  if (ev.type === 'rocket') return; // our own launch sound plays when we press (skill event)
  if (ev.type === 'hole') {
    const h = ev.hole, me = game.me;
    const near = me && Math.hypot(me.xs[me.n - 1] - h.x, me.ys[me.n - 1] - h.y) < 700;
    if (near || h.by === game.myId) sound.play('boom');
    return;
  }
  if (ev.type !== 'death') return;
  const s = ev.snake;
  const me = s === game.me;
  if (ev.killerId === KILLER_ZONE) feed(`${nameHtml(s)} was caught by the zone`);
  else if (ev.killerId === KILLER_LEFT) feed(`${nameHtml(s)} left`);
  else if (ev.killer === s) feed(`${nameHtml(s)} crashed into their own line`);
  else if (ev.killer) {
    const tag = killTag(ev.killer, ev.msg.tick);
    if (ev.killer === game.me && !me) { sound.play('kill'); sound.vibrate(40); }
    feed(`${nameHtml(ev.killer)} cut off ${nameHtml(s)}${tag ? `<span class="tag">${tag}</span>` : ''}`);
    if (tag && ev.killer === game.me && !me) {
      ui.center.innerHTML = `<span style="color:#ffd43b;font-size:0.55em">${tag}!</span>`;
      flashUntil = performance.now() + 1200;
    }
  }

  if (me) {
    sound.play('death');
    sound.vibrate([90, 50, 180]);
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
  platform.loading(false);
  if (autoJoin && mode === 'menu') { autoJoin = false; setTimeout(join, 0); }
  ui.play.textContent = roomCode ? 'JOIN ROOM' : 'PLAY';
  if (mode === 'menu') ui.status.textContent = '';
  requestProfile();
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
      if (m.google && !platform.crazy) setupGoogle(m.google);
      ui.status.textContent = m.online > 1 ? `${m.online} players online` : '';
      break;
    case 'lobby':
      if (mode === 'menu') return;
      if (mode === 'game' && game.ended && !ui.end.hidden) {
        // still showing results; the end panel shows the countdown
        ui.endSub.textContent = `Next round in ${m.startsIn}s`;
        return;
      }
      if (mode !== 'lobby') showLobbyAd(); // a fresh ad each time the waiting screen opens
      hidePanels();
      setMode('lobby');
      game.active = false;
      show(ui.lobby);
      show(ui.lobbyRoom, !!m.code);
      show($('fresh'), !m.code && !!m.waiting);
      if (!m.code && m.waiting) {
        // a public match is nearly over: play its next round with that group
        ui.lobbyText.textContent = 'Joining the next round';
        ui.lobbySub.textContent = `A match is finishing${m.alive > 1 ? ` (${m.alive} snakes left)` : ''}\u00a0·\u00a0about ${m.endsIn}s`;
      } else if (m.code) {
        ui.lobbyText.textContent = m.waiting ? 'A match is being played' : `Friends' room · starting in ${m.startsIn}s`;
        ui.lobbySub.innerHTML = (m.waiting ? "You'll join the next round." : 'Invite friends with the link&nbsp;·&nbsp;bots fill the rest') +
          `<div class="names">${m.names.map(esc).join(' · ')}</div>`;
        show($('go'), !m.waiting && m.startsIn > 1);
      } else {
        ui.lobbyText.textContent = `Starting in ${m.startsIn}s`;
        ui.lobbySub.textContent = m.players > 1
          ? `${m.players} players in this match\u00a0·\u00a0bots fill the rest`
          : 'Waiting for players\u00a0·\u00a0bots fill the rest';
      }
      break;
    case 'start':
      if (mode === 'menu') return;
      show($('lobby-xp'), false);
      clearTimeout(deadTimer);
      clearTimeout(endTimer);
      hidePanels();
      game.start(m);
      spectateId = null;
      ui.feed.innerHTML = '';
      ui.effects.innerHTML = '';
      streaks = new Map();
      firstBlood = false;
      show(ui.tip, false);
      tipsThisMatch = 0;
      ui.result.innerHTML = '';
      lastResult = null;
      show(ui.shareMsg, false);
      flashUntil = 0;
      setMode('game');
      adDue = true;
      cam.x = game.me.xs[0];
      cam.y = game.me.ys[0];
      cam.scale = renderer.baseScale;
      break;
    case 'profile':
      showProfile(m);
      break;
    case 'login':
      onLogin(m);
      break;
    case 'lb':
      showLeaderboard(m);
      break;
    case 'result':
      showResult(m);
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
    case 'rocket':
      if (game.active) game.onRocket(m);
      break;
    case 'blast':
      if (game.active) game.onBlast(m);
      break;
    case 'skill':
      if (game.active) game.onSkill(m);
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
  if (winner && winner === game.me) { ui.endTitle.textContent = '\u{1F3C6} You win!'; sound.play('win'); platform.happytime(); }
  else if (winner) ui.endTitle.innerHTML = `\u{1F3C6} ${nameHtml(winner)} wins`;
  else ui.endTitle.textContent = 'Draw!';
  ui.ranking.innerHTML = m.ranking.slice(0, 10).map((r) => {
    const s = game.snakes.get(r.id);
    const me = r.id === game.myId;
    return `<li class="${me ? 'me' : ''}">${s ? nameHtml(s) : esc(r.name)}${me ? ' (you)' : ''}<span class="k">${r.kills} kill${r.kills === 1 ? '' : 's'}</span></li>`;
  }).join('');
  const mine = m.ranking.find((r) => r.id === game.myId);
  if (mine && mine.place > 10) {
    ui.ranking.innerHTML += `<li class="me" value="${mine.place}">You<span class="k">${mine.kills} kill${mine.kills === 1 ? '' : 's'}</span></li>`;
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
  platform.gameplay(mode === 'game' && game.active && game.controlling && !document.hidden);

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
  const beat = toGo > 0 ? Math.ceil(toGo) : toGo > -0.8 ? 0 : -1;
  if (beat !== lastBeat) {
    if (beat > 0 && beat <= 3) sound.play('count');
    else if (beat === 0 && lastBeat > 0) sound.play('go');
    lastBeat = beat;
  }
  if (toGo > 0) ui.center.innerHTML = `${Math.ceil(toGo)}<small>${isTouch ? 'hold the left or right half to steer' : '← → steer · Space / Shift skills'}</small>`;
  else if (toGo > -0.8) ui.center.textContent = 'GO!';
  else if (now < flashUntil) { /* showing a power-up warning */ }
  else if (ui.center.innerHTML) ui.center.innerHTML = '';
  if (isTouch && !steerL.hidden) {
    const t = input.turn;
    steerL.classList.toggle('on', t < 0);
    steerR.classList.toggle('on', t > 0);
  }


  if (now - hudAt > 200) {
    hudAt = now;
    updateHud(zone, serverTick);
    updateTip(serverTick, now);
    diag.render(now);
  }
}

/** Fuel pill and the two skill buttons (ready = enough fuel; a bar while one runs). */
let skillShown = '';
function showSkillBar() {
  const me = game.me && game.controlling ? game.me : null;
  const now = performance.now();
  const fx = me ? game.myEffects(now) : [];
  const fuel = me ? game.myFuel : 0;
  const key = me ? `${Math.round(fuel * 20)}|${me.skills}|${me.skills.map((k) => game.canUse(k)).join()}|${fx.map((e) => e.type + Math.ceil(e.left * 5)).join()}` : '-';
  if (key === skillShown) return;
  skillShown = key;
  const el = $('fuel');
  show(el, !!me);
  show(skillBar, !!me);
  for (const el of [steerL, steerR]) show(el, !!me && isTouch);
  if (!me) return;
  el.innerHTML = `<span class="ok">\u26FD ${Math.floor(fuel)}</span><span class="fbar"><i style="width:${Math.round((100 * fuel) / MAX_FUEL)}%"></i></span>`;
  el.title = 'Fuel: collect the orange dots, spend it on your skills';
  skillBtns.forEach((b) => {
    const k = me.skills[Number(b.dataset.slot)], def = SKILLS[k];
    const on = def.effect ? fx.find((e) => e.type === def.effect && !e.pending) : null;
    b.querySelector('span').textContent = def.icon;
    b.querySelector('b').textContent = def.cost;
    b.title = `${def.label} (${def.cost} fuel): ${def.help}`;
    b.classList.toggle('ready', game.canUse(k));
    b.classList.toggle('on', !!on);
    // fill: how much of the cost we have, or how long the skill still runs
    b.querySelector('i').style.height = `${Math.round(100 * (on ? on.left / on.total : Math.min(1, fuel / def.cost)))}%`;
  });
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
  showSkillBar();
  let txt = '', warn = false;
  if (serverTick < game.playTick) txt = 'Get ready';
  else if (game.ended) txt = 'Round over';
  else if (zone.r <= 0) { txt = 'Zone closed'; warn = true; }
  else if (zone.shrinking) { txt = `Zone closing! ${Math.ceil(zone.ticksLeft / TICK_RATE)}s`; warn = true; }
  else if (zone.next) txt = `Zone shrinks in ${Math.ceil(zone.ticksLeft / TICK_RATE)}s`;
  ui.zoneInfo.textContent = txt;
  ui.zoneInfo.classList.toggle('warn', warn);
  const closing = zone.shrinking && game.controlling && !game.ended;
  if (closing && !zoneWarned) sound.play('zone');
  zoneWarned = closing;
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
const soundBtn = $('sound');
function showSoundBtn() {
  soundBtn.textContent = sound.enabled ? '\u{1F50A}' : '\u{1F507}';
  soundBtn.title = sound.enabled ? 'Sound on (M)' : 'Sound off (M)';
  soundBtn.setAttribute('aria-label', soundBtn.title);
}
soundBtn.addEventListener('click', () => { sound.toggle(); showSoundBtn(); soundBtn.blur(); });
showSoundBtn();
addEventListener('keydown', (e) => { if (e.code === 'KeyM' && !e.repeat && !(e.target instanceof HTMLInputElement)) { sound.toggle(); showSoundBtn(); } });
addEventListener('keydown', (e) => { if (e.code === 'KeyN' && !(e.target instanceof HTMLInputElement)) diag.toggle(); });
try { if (localStorage.getItem('cr-net') || new URLSearchParams(location.search).has('net')) diag.toggle(true); } catch {}

if (new URLSearchParams(location.search).has('debug')) window.__cr = { game, net, input };

requestAnimationFrame(frame);
net.connect();
