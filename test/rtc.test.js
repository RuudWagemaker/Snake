// End-to-end WebRTC: a node-datachannel peer plays the browser's role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { decodeTick, encodeInputs } from '../public/shared/protocol.js';

process.env.RTC_PORT = '40917';
const { startServer } = await import('../server/index.js');
let ndc = null;
try { ndc = (await import('node-datachannel')).default; } catch {}

test('game state arrives over UDP and UDP inputs are applied', { skip: !ndc && 'node-datachannel not installed', timeout: 30000 }, async () => {
  const srv = await startServer({ port: 0 });
  const pc = new ndc.PeerConnection('test-client', { iceServers: [] });
  try {
    const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
    const msgs = [];
    let onMsg = () => {};
    ws.on('message', (d, bin) => { if (!bin) { const m = JSON.parse(d.toString()); msgs.push(m); onMsg(m); } });
    const waitFor = (pred) => new Promise((resolve) => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      onMsg = (m) => { if (pred(m)) resolve(m); };
    });
    const hello = await waitFor((m) => m.t === 'hello');
    assert.equal(hello.rtc, true);

    pc.onLocalDescription((sdp, type) => ws.send(JSON.stringify({ t: 'rtc', type: type.toLowerCase(), sdp })));
    pc.onLocalCandidate((cand, mid) => ws.send(JSON.stringify({ t: 'rtc', type: 'cand', cand, mid })));
    const dc = pc.createDataChannel('game', { unordered: true, maxRetransmits: 0 });
    const udpTicks = [];
    dc.onMessage((m) => { if (typeof m !== 'string') udpTicks.push(decodeTick(new Uint8Array(m).buffer.slice(0))); });
    const opened = new Promise((r) => dc.onOpen(r));
    ws.on('message', (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      if (m.t !== 'rtc') return;
      if (m.type === 'answer') pc.setRemoteDescription(m.sdp, 'answer');
      else if (m.type === 'cand') pc.addRemoteCandidate(m.cand, m.mid);
    });
    await opened;

    ws.send(JSON.stringify({ t: 'join', name: 'udp', build: hello.build }));
    const start = await waitFor((m) => m.t === 'start');
    // Wait for ticks over UDP, then steer only via UDP (redundant packets).
    while (udpTicks.length < 20) await new Promise((r) => setTimeout(r, 50));
    const t0 = udpTicks[udpTicks.length - 1].tick;
    const target = t0 + 5;
    dc.sendMessageBinary(new Uint8Array(encodeInputs(target, [1, 1, 1, 1, 1])));
    while (!udpTicks.some((d) => d.tick >= target)) await new Promise((r) => setTimeout(r, 20));
    const d = udpTicks.find((x) => x.tick === target) || udpTicks.find((x) => x.tick > target);
    assert.ok(d.lastInput >= target, 'server received the UDP inputs');
    assert.ok(start.you > 0);
    console.log(`received ${udpTicks.length} ticks over UDP`);
    ws.close();
  } finally {
    pc.close();
    await srv.close();
  }
});

test.after(() => { try { ndc && ndc.cleanup(); } catch {} });
