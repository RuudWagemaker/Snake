// Binary messages for the hot path (inputs up, state down). Everything else is JSON.
//
// INPUT  (client -> server), 6 bytes:
//   u8 type=1 | u32 tick | i8 turn
//   `tick` is the server tick this input is for. The server applies it on that
//   tick and drops it if it arrives too late.
// TICK   (server -> client), 11 + 14*n bytes:
//   u8 type=2 | u32 tick | u32 lastInput | u8 flags | u8 count | count * entry
//   lastInput: newest input tick received from this client
//   flags: bit7 = this client's input for `tick` was missing (arrived late)
//   entry: u8 id | f32 x | f32 y | f32 angle | u8 flags (bit0 gap, bit1 died this tick)

export const MSG_INPUT = 1;
export const MSG_TICK = 2;
export const FLAG_GAP = 1;
export const FLAG_DIED = 2;
export const TICK_HEADER = 11;
export const TICK_ENTRY = 14;

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
    };
    o += TICK_ENTRY;
  }
  return { tick: v.getUint32(1), lastInput: v.getUint32(5), starved: (v.getUint8(9) & 0x80) !== 0, entries };
}
