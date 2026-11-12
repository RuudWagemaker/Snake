// Unified input: keyboard, mouse/touch/pen (pointer events) and gamepads.
// The most recently pressed control wins.
//
// Touch screens: one thumb steers with the ◀ ▶ pad, the other uses the skill
// buttons. A mouse steers by holding the left or right half of the screen.

const KEYS = {
  ArrowLeft: -1, KeyA: -1, KeyQ: -1, Comma: -1,
  ArrowRight: 1, KeyD: 1, KeyE: 1, Period: 1,
};
// skill slot 1 and 2
const SKILL_KEYS = { Space: 0, ArrowUp: 0, KeyW: 0, ShiftLeft: 1, ShiftRight: 1, ArrowDown: 1, KeyS: 1 };
const SKILL_BUTTONS = [[0, 2, 12], [1, 3, 13]]; // gamepad A/X/d-pad up, B/Y/d-pad down

export class Input {
  constructor(surface, pad = null) {
    this.stack = [];      // [{src, dir}]
    this.padTurn = 0;
    this.enabled = true;  // pointer steering only while playing
    this.onSkill = null;  // (slot 0 or 1): Space / W / up, Shift / S / down, or gamepad buttons
    this.padSkillWas = [false, false];

    addEventListener('keydown', (e) => {
      if (SKILL_KEYS[e.code] !== undefined && this.enabled && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        if (!e.repeat && this.onSkill) this.onSkill(SKILL_KEYS[e.code]);
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
    // Mouse (and pen): pointer events, hold the left or right half.
    surface.addEventListener('pointerdown', (e) => {
      if (!this.enabled || e.pointerType === 'touch') return;
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

    // Touch: the ◀ ▶ steering pad (bottom left). Hold a side; slide the thumb
    // across to switch sides. Touch events, cancelled so the browser never takes
    // a held thumb over for a gesture.
    if (pad) {
      const opts = { passive: false };
      const dirAt = (x) => { const r = pad.getBoundingClientRect(); return x < r.left + r.width / 2 ? -1 : 1; };
      const sync = (e) => {
        if (e.cancelable) e.preventDefault();
        const down = new Set();
        for (const t of e.targetTouches) {
          down.add('s' + t.identifier);
          const entry = this.stack.find((s) => s.src === 's' + t.identifier);
          if (entry) entry.dir = dirAt(t.clientX);
          else if (this.enabled) this.press('s' + t.identifier, dirAt(t.clientX));
        }
        // thumbs that lifted (or that the browser dropped) stop steering
        for (const s of this.stack.slice()) if (s.src[0] === 's' && !down.has(s.src)) this.release(s.src);
      };
      for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) pad.addEventListener(ev, sync, opts);
      pad.addEventListener('contextmenu', (e) => e.preventDefault());
    }
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
    for (let slot = 0; slot < 2; slot++) {
      let on = false;
      for (const gp of pads) {
        if (gp && SKILL_BUTTONS[slot].some((i) => gp.buttons[i] && gp.buttons[i].pressed)) on = true;
      }
      if (on && !this.padSkillWas[slot] && this.enabled && this.onSkill) this.onSkill(slot);
      this.padSkillWas[slot] = on;
    }
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

  /** This tick's steering: -1, 0 or 1. */
  get turn() {
    if (this.stack.length) return this.stack[this.stack.length - 1].dir;
    return this.padTurn;
  }
}
