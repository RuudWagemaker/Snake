// Unified input: keyboard, mouse/touch/pen (pointer events) and gamepads.
// The most recently pressed control wins.
//
// Touch screens: one thumb steers with a stick. Put it down anywhere on the
// screen (outside the skill buttons) and drag toward where you want to go; the
// snake turns toward that direction as fast as it can. The other thumb uses
// the skill buttons. A mouse still steers by holding the left or right half.

const KEYS = {
  ArrowLeft: -1, KeyA: -1, KeyQ: -1, Comma: -1,
  ArrowRight: 1, KeyD: 1, KeyE: 1, Period: 1,
};
// skill slot 1 and 2
const SKILL_KEYS = { Space: 0, ArrowUp: 0, KeyW: 0, ShiftLeft: 1, ShiftRight: 1, ArrowDown: 1, KeyS: 1 };
const SKILL_BUTTONS = [[0, 2, 12], [1, 3, 13]]; // gamepad A/X/d-pad up, B/Y/d-pad down
const STICK_DEAD = 14;       // px: closer to where the thumb landed = go straight
const STICK_MAX = 60;        // px: the knob doesn't go further than this
const AIM_TOL = 0.05;        // rad: close enough to the stick's direction (half a tick of turning)

export class Input {
  constructor(surface) {
    this.stack = [];      // [{src, dir}]
    this.padTurn = 0;
    this.enabled = true;  // pointer steering only while playing
    this.onSkill = null;  // (slot 0 or 1): Space / W / up, Shift / S / down, or gamepad buttons
    this.padSkillWas = [false, false];
    this.stick = null;    // touch steering: {id, x0, y0, x, y, aim (angle) | null}
    this.sticks = [];     // all thumbs down on the canvas; the newest steers, the previous takes over when it lifts
    this.onStick = null;  // (stick) when it moves, for drawing it

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
    surface.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      try { surface.setPointerCapture(e.pointerId); } catch {}
      if (e.pointerType === 'mouse') { this.press('p' + e.pointerId, side(e)); return; }
      // touch / pen: a new stick where the thumb landed (the newest thumb steers)
      this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, aim: null };
      this.sticks.push(this.stick);
      this.onStick?.(this.stick);
    });
    surface.addEventListener('pointermove', (e) => {
      const st = this.sticks.find((s) => s.id === e.pointerId);
      if (st) {
        let dx = e.clientX - st.x0, dy = e.clientY - st.y0;
        const d = Math.hypot(dx, dy);
        if (d > STICK_MAX) {
          // drag the stick's centre along, so turning back is quick
          st.x0 += (dx / d) * (d - STICK_MAX); st.y0 += (dy / d) * (d - STICK_MAX);
          dx = e.clientX - st.x0; dy = e.clientY - st.y0;
        }
        st.x = e.clientX; st.y = e.clientY;
        st.aim = Math.hypot(dx, dy) > STICK_DEAD ? Math.atan2(dy, dx) : st.aim;
        if (st === this.stick) this.onStick?.(st);
        return;
      }
      const entry = this.stack.find((s) => s.src === 'p' + e.pointerId);
      if (entry) entry.dir = side(e);
    });
    const up = (e) => {
      const i = this.sticks.findIndex((s) => s.id === e.pointerId);
      if (i >= 0) {
        const wasActive = this.sticks[i] === this.stick;
        this.sticks.splice(i, 1);
        if (wasActive) {
          this.stick = this.sticks[this.sticks.length - 1] || null; // a thumb still down takes over
          this.onStick?.(this.stick);
        }
      }
      this.release('p' + e.pointerId);
    };
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
    this.sticks.length = 0;
    if (this.stick) { this.stick = null; this.onStick?.(null); }
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

  /**
   * This tick's steering: -1, 0 or 1, or (touch stick) a function of the snake's
   * heading that turns toward where the stick points.
   */
  get turn() {
    if (this.stack.length) return this.stack[this.stack.length - 1].dir;
    if (this.stick) {
      const aim = this.stick.aim;
      if (aim === null) return 0;
      return (heading) => {
        let d = aim - heading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        return Math.abs(d) < AIM_TOL ? 0 : Math.sign(d);
      };
    }
    return this.padTurn;
  }
}
