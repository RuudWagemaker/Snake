// Per-player input store. Inputs are stamped with the tick they're for and may
// arrive out of order or more than once (UDP sends each input several times),
// so they're kept in a small ring indexed by tick.
const SIZE = 128;
const MAX_AHEAD = 90; // ignore inputs stamped more than 3 s in the future

export class InputBuffer {
  constructor() {
    this.ticks = new Int32Array(SIZE);
    this.turns = new Int8Array(SIZE);
    this.reset();
  }

  reset() {
    this.ticks.fill(-1);
    this.last = -1;      // newest input tick received
    this.lateTick = -1;  // newest input that arrived after its tick ran
    this.lateTurn = 0;
    this.applied = -1;   // newest input tick whose turn the simulation used
  }

  /** Returns true if this input is new and newer than any before (for stats). */
  receive(tick, turn, currentTick) {
    if (tick > currentTick + MAX_AHEAD) return false; // nonsense, or from an old round
    if (tick <= currentTick) {
      // Too late for its tick. Its turn is still the freshest known intent.
      if (tick > this.lateTick) { this.lateTick = tick; this.lateTurn = turn; }
      return false;
    }
    const slot = tick & (SIZE - 1);
    this.ticks[slot] = tick;
    this.turns[slot] = turn;
    if (tick > this.last) { this.last = tick; return true; }
    return false;
  }

  /**
   * The turn to use on tick t. `missing` is set when the input for t hadn't
   * arrived; the result is then the latest known intent, or null to keep the
   * previous turn.
   */
  take(t) {
    const slot = t & (SIZE - 1);
    if (this.ticks[slot] === t) {
      this.missing = false;
      this.applied = t;
      return this.turns[slot];
    }
    this.missing = true;
    if (this.lateTick > this.applied) {
      this.applied = this.lateTick;
      return this.lateTurn;
    }
    return null;
  }
}
