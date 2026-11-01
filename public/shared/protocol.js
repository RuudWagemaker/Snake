// Binary messages for the hot path (inputs up, state down). Everything else is JSON.
//
// INPUT  (client -> server), 6 bytes:
//   u8 type=1 | u32 tick | i8 turn
//   `tick` is the server tick this input is for. The server applies it on that
//   tick and drops it if it arrives too late.
// INPUTS (client -> server over UDP), 6 + n bytes:
//   u8 type=3 | u32 lastTick | u8 n | n * i8 turn (for ticks lastTick-n+1 .. lastTick)
//   Every UDP packet repeats the recent inputs, so a lost packet costs nothing.
// TICK   (server -> client), 11 + 18*n bytes:
//   u8 type=2 | u32 tick | u32 lastInput | u8 flags | u8 count | count * entry
//   lastInput: newest input tick received from this client
//   flags: bit7 = this client's input for `tick` was missing (arrived late)
//   entry: u8 id | f32 x | f32 y | f32 angle | u8 flags (bit0 gap, bit1 died this tick)
//          | u8 n | u16 turns: the snake's next n turns (n <= 8, 2 bits each, turn+1),
//            already decided (bots plan ahead, players' inputs arrive early). Lets
//            clients draw other snakes slightly ahead in time without guessing.
//          | u8 width*10: line width on this tick (power-ups change it)

export const MSG_INPUT = 1;
export const MSG_TICK = 2;
export const MSG_INPUTS = 3;
export const FLAG_GAP = 1;
export const FLAG_DIED = 2;
export const TICK_HEADER = 11;
export const TICK_ENTRY = 18;
export const MAX_FUTURE = 8;

export function encodeInput(tick, turn) {
  const buf = new ArrayBuffer(6);
  const v = new DataView(buf);
  v.setUint8(0, MSG_INPUT);
  v.setUint32(1, tick);
  v.setInt8(5, turn);
  return buf;
}

export function decodeInput(u8) {
  if (u8.byteLength !== 6) return null;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (v.getUint8(0) !== MSG_INPUT) return null;
  const turn = v.getInt8(5);
  return { tick: v.getUint32(1), turn: turn < 0 ? -1 : turn > 0 ? 1 : 0 };
}

export function encodeInputs(lastTick, turns) {
  const n = Math.min(255, turns.length);
  const buf = new ArrayBuffer(6 + n);
  const v = new DataView(buf);
  v.setUint8(0, MSG_INPUTS);
  v.setUint32(1, lastTick);
  v.setUint8(5, n);
  for (let i = 0; i < n; i++) v.setInt8(6 + i, turns[turns.length - n + i]);
  return buf;
}

/** Decodes either input message type into a list of {tick, turn}. */
export function decodeInputList(u8) {
  if (u8.byteLength < 6) return null;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const type = v.getUint8(0);
  const clamp = (t) => (t < 0 ? -1 : t > 0 ? 1 : 0);
  if (type === MSG_INPUT) {
    const one = decodeInput(u8);
    return one ? [one] : null;
  }
  if (type !== MSG_INPUTS) return null;
  const last = v.getUint32(1), n = v.getUint8(5);
  if (u8.byteLength !== 6 + n || n === 0 || last < n - 1) return null;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { tick: last - n + 1 + i, turn: clamp(v.getInt8(6 + i)) };
  return out;
}

/** Writes the shared per-snake part of a tick message. Returns a Uint8Array. */
export function encodeTickBody(entries) {
  const out = new Uint8Array(TICK_HEADER + entries.length * TICK_ENTRY);
  const v = new DataView(out.buffer);
  v.setUint8(0, MSG_TICK);
  v.setUint8(10, entries.length);
  let o = TICK_HEADER;
  for (const e of entries) {
    v.setUint8(o, e.id);
    v.setFloat32(o + 1, e.x);
    v.setFloat32(o + 5, e.y);
    v.setFloat32(o + 9, e.a);
    v.setUint8(o + 13, e.flags);
    const fut = e.future || [];
    const n = Math.min(MAX_FUTURE, fut.length);
    let packed = 0;
    for (let i = 0; i < n; i++) packed |= (fut[i] + 1) << (2 * i);
    v.setUint8(o + 14, n);
    v.setUint16(o + 15, packed);
    v.setUint8(o + 17, Math.max(0, Math.min(255, Math.round((e.width ?? 6) * 10))));
    o += TICK_ENTRY;
  }
  return out;
}

/** Fill in the per-client header fields (in place). */
export function writeTickHeader(u8, tick, lastInput, starved = false) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  v.setUint32(1, tick);
  v.setUint32(5, Math.max(0, lastInput));
  v.setUint8(9, starved ? 0x80 : 0);
}

export function decodeTick(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  if (v.getUint8(0) !== MSG_TICK) return null;
  const n = v.getUint8(10);
  const entries = new Array(n);
  let o = TICK_HEADER;
  for (let i = 0; i < n; i++) {
    entries[i] = {
      id: v.getUint8(o),
      x: v.getFloat32(o + 1),
      y: v.getFloat32(o + 5),
      a: v.getFloat32(o + 9),
      flags: v.getUint8(o + 13),
      future: null,
      width: v.getUint8(o + 17) / 10,
    };
    const n = Math.min(MAX_FUTURE, v.getUint8(o + 14));
    if (n) {
      const packed = v.getUint16(o + 15);
      const fut = new Array(n);
      for (let k = 0; k < n; k++) fut[k] = ((packed >> (2 * k)) & 3) - 1;
      entries[i].future = fut;
    }
    o += TICK_ENTRY;
  }
  return { tick: v.getUint32(1), lastInput: v.getUint32(5), starved: (v.getUint8(9) & 0x80) !== 0, entries };
}
