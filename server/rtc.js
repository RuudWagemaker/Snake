// WebRTC data channel per player: game state and inputs travel over UDP, where
// a lost packet is simply skipped instead of stalling everything behind it
// (TCP/WebSocket). Enabled when RTC_PORT is set and node-datachannel is
// installed. All peers share that one UDP port.
const RTC_PORT = Number(process.env.RTC_PORT) || 0;
// Set when the server is behind 1:1 NAT (its interface has a private IP).
const RTC_PUBLIC_IP = process.env.RTC_PUBLIC_IP || '';

let ndc = null;

export async function initRtc() {
  if (!RTC_PORT) return false;
  try {
    const mod = await import('node-datachannel');
    ndc = mod.default || mod;
    console.log(`WebRTC (UDP) enabled on port ${RTC_PORT}${RTC_PUBLIC_IP ? `, public IP ${RTC_PUBLIC_IP}` : ''}`);
    return true;
  } catch (err) {
    console.warn(`WebRTC disabled: ${err.message}`);
    return false;
  }
}

export const rtcEnabled = () => !!ndc;

function publicIp(text) {
  if (!RTC_PUBLIC_IP) return text;
  // candidate:<foundation> <component> <proto> <priority> <ip> <port> typ host
  return text.replace(/(candidate:\S+ \d+ (?:udp|UDP) \d+ )(\d+\.\d+\.\d+\.\d+)( \d+ typ host)/g, `$1${RTC_PUBLIC_IP}$3`);
}

export class RtcPeer {
  constructor(id, send, onMessage) {
    this.open = false;
    this.dc = null;
    this.pc = new ndc.PeerConnection(`p${id}`, {
      iceServers: [],
      enableIceUdpMux: true,
      portRangeBegin: RTC_PORT,
      portRangeEnd: RTC_PORT,
    });
    this.pc.onLocalDescription((sdp, type) => send({ t: 'rtc', type: type.toLowerCase(), sdp: publicIp(sdp) }));
    this.pc.onLocalCandidate((cand, mid) => send({ t: 'rtc', type: 'cand', cand: publicIp(cand), mid }));
    this.pc.onStateChange((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.open = false;
    });
    this.pc.onDataChannel((dc) => {
      this.dc = dc;
      this.open = dc.isOpen();
      dc.onOpen(() => { this.open = true; });
      dc.onClosed(() => { this.open = false; });
      dc.onMessage((msg) => { if (typeof msg !== 'string') onMessage(new Uint8Array(msg)); });
    });
  }

  handle(msg) {
    try {
      if (msg.type === 'offer' && typeof msg.sdp === 'string') this.pc.setRemoteDescription(msg.sdp, 'offer');
      else if (msg.type === 'cand' && typeof msg.cand === 'string' && msg.cand) this.pc.addRemoteCandidate(msg.cand, String(msg.mid ?? '0'));
    } catch {
      // malformed signaling from the client: ignore
    }
  }

  send(u8) {
    if (!this.open || !this.dc) return;
    try {
      if (this.dc.bufferedAmount() < 64 * 1024) this.dc.sendMessageBinary(u8);
    } catch {
      this.open = false;
    }
  }

  close() {
    this.open = false;
    try { this.dc?.close(); } catch {}
    try { this.pc.close(); } catch {}
  }
}
