// Sound effects made with Web Audio (no audio files) and phone vibration.
// Browsers only allow audio after a tap or key press, so the audio context is
// created on the first one. On/off is saved in localStorage ('cr-sound').

let ctx = null;
let master = null;
let enabled = true;
try { enabled = localStorage.getItem('cr-sound') !== 'off'; } catch {}

function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}
// iOS only counts touchend / pointerup / click as a gesture that may start audio.
for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click', 'keydown']) addEventListener(ev, unlock, { capture: true, passive: true });

/** One tone: frequency slides from f0 to f1 over `dur` seconds, starting `at` seconds from now. */
function tone(f0, f1, dur, { type = 'sine', vol = 1, at = 0 } = {}) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const SOUNDS = {
  count: () => tone(660, 660, 0.09, { type: 'square', vol: 0.25 }),
  go: () => tone(990, 990, 0.22, { type: 'square', vol: 0.3 }),
  pickup: () => tone(600, 1300, 0.14, { type: 'triangle', vol: 0.7 }),
  hit: () => { tone(220, 110, 0.3, { type: 'sawtooth', vol: 0.35 }); tone(233, 116, 0.3, { type: 'sawtooth', vol: 0.25 }); },
  kill: () => { tone(880, 880, 0.12, { vol: 0.6 }); tone(1320, 1320, 0.25, { vol: 0.6, at: 0.09 }); },
  death: () => { tone(180, 45, 0.5, { type: 'triangle', vol: 0.9 }); tone(90, 40, 0.5, { type: 'sawtooth', vol: 0.2 }); },
  zone: () => { tone(440, 440, 0.12, { type: 'square', vol: 0.2 }); tone(440, 440, 0.12, { type: 'square', vol: 0.2, at: 0.2 }); },
  launch: () => { tone(300, 900, 0.25, { type: 'sawtooth', vol: 0.18 }); tone(150, 500, 0.25, { type: 'triangle', vol: 0.3 }); },
  boom: () => { tone(120, 35, 0.45, { type: 'sawtooth', vol: 0.35 }); tone(70, 30, 0.5, { type: 'triangle', vol: 0.8 }); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, f, i === 3 ? 0.5 : 0.16, { type: 'triangle', vol: 0.6, at: i * 0.12 })),
};

export const sound = {
  get enabled() { return enabled; },
  toggle() {
    enabled = !enabled;
    try { localStorage.setItem('cr-sound', enabled ? 'on' : 'off'); } catch {}
    if (enabled) { unlock(); ctx?.resume().then(() => this.play('pickup')).catch(() => {}); }
    return enabled;
  },
  play(name) {
    if (!enabled || !ctx || ctx.state !== 'running' || document.hidden) return;
    try { SOUNDS[name]?.(); } catch {}
  },
  /** Short buzz on phones that support it (Android; iPhones ignore it). Follows the sound setting. */
  vibrate(pattern) {
    if (!enabled || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch {}
  },
};
