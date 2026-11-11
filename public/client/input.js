// Unified input: keyboard, mouse/touch/pen (pointer events) and gamepads.
// The most recently pressed control wins, which feels natural on touch screens
// when a second thumb lands before the first one lifts.

const KEYS = {
  ArrowLeft: -1, KeyA: -1, KeyQ: -1, Comma: -1,
  ArrowRight: 1, KeyD: 1, KeyE: 1, Period: 1,
};
const FIRE_KEYS = new Set(['Space', 'ArrowUp', 'KeyW']);
const FIRE_BUTTONS = [0, 1, 2, 3, 12]; // gamepad A/B/X/Y and d-pad up

export class Input {
  constructor(surface) {
    this.stack = [];      // [{src, dir}]
    this.padTurn = 0;
    this.enabled = true;  // pointer steering only while playing
    this.onFire = null;   // rocket: Space / up / W, or a gamepad face button
    this.padFireWas = false;

    addEventListener('keydown', (e) => {
      if (FIRE_KEYS.has(e.code) && this.enabled && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        if (!e.repeat && this.onFire) this.onFire();
        return;
      }
      const dir = KEYS[e.code];
      if (dir === undefined || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      if (!e.repeat) this.press('k' + e.code, dir);
    });
    addEventListener('keyup', (e) => {
      if (KEYS[e.code] !== undefined) this.release('k' + e.code);
    });

    const side = (e) => (e.clientX < innerWidth / 2 ? -1 : 1);
    surface.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      try { surface.setPointerCapture(e.pointerId); } catch {}
      this.press('p' + e.pointerId, side(e));
    });
    surface.addEventListener('pointermove', (e) => {
      const entry = this.stack.find((s) => s.src === 'p' + e.pointerId);
      if (entry) entry.dir = side(e);
    });
    const up = (e) => this.release('p' + e.pointerId);
    surface.addEventListener('pointerup', up);
    surface.addEventListener('pointercancel', up);
    surface.addEventListener('lostpointercapture', up);
    surface.addEventListener('contextmenu', (e) => e.preventDefault());

    addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.clear(); });
  }

  press(src, dir) {
    this.release(src);
    this.stack.push({ src, dir });
  }

  release(src) {
    const i = this.stack.findIndex((s) => s.src === src);
    if (i >= 0) this.stack.splice(i, 1);
  }

  clear() {
    this.stack.length = 0;
  }

  get pointerActive() {
    return this.stack.some((s) => s.src[0] === 'p');
  }

  pollGamepads() {
    this.padTurn = 0;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let fire = false;
    for (const gp of pads) {
      if (gp && FIRE_BUTTONS.some((i) => gp.buttons[i] && gp.buttons[i].pressed)) fire = true;
    }
    if (fire && !this.padFireWas && this.enabled && this.onFire) this.onFire();
    this.padFireWas = fire;
    for (const gp of pads) {
      if (!gp) continue;
      const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
      const x = gp.axes[0] || 0;
      const left = x < -0.4 || b(14) || b(4) || b(6);
      const right = x > 0.4 || b(15) || b(5) || b(7);
      const t = (right ? 1 : 0) - (left ? 1 : 0);
      if (t) { this.padTurn = t; break; }
    }
  }

  get turn() {
    if (this.stack.length) return this.stack[this.stack.length - 1].dir;
    return this.padTurn;
  }
}
