// Network connection: a WebSocket (reliable, always) plus, when the server
// supports it, a WebRTC data channel (UDP: unordered, no retransmits). Game
// state then arrives over both; whichever copy comes first wins. A Wi-Fi blip
// only loses the UDP packets sent during it, instead of stalling the whole
// stream while TCP waits to re-send.
export class Net {
  constructor() {
    this.ws = null;
    this.pc = null;
    this.dc = null;
    this.udpOpen = false;
    this.pendingCands = [];
    this.onJson = () => {};
    this.onBinary = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
    this.rtt = 0;
    this.rttMax = 0;   // worst ping since last read (for the diagnostics panel)
    this.rttSamples = [];
    this.rttMedian = 0; // robust ping for timing: one slow ping (a Wi-Fi blip) doesn't move it
    this._pingTimer = null;
  }

  /** Called when the server says it supports WebRTC. */
  async startRtc() {
    this.stopRtc();
    if (typeof RTCPeerConnection === 'undefined') return;
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      const dc = pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
      dc.binaryType = 'arraybuffer';
      this.pc = pc;
      this.dc = dc;
      this.remoteSet = false;
      this.pendingCands = [];
      dc.onopen = () => { this.udpOpen = true; };
      dc.onclose = () => { this.udpOpen = false; };
      dc.onmessage = (ev) => { if (typeof ev.data !== 'string') this.onBinary(ev.data, 'udp'); };
      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate) this.send({ t: 'rtc', type: 'cand', cand: e.candidate.candidate, mid: e.candidate.sdpMid });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.udpOpen = false;
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.send({ t: 'rtc', type: 'offer', sdp: pc.localDescription.sdp });
      // Networks that block UDP: give up quietly and stay on WebSocket only.
      setTimeout(() => { if (this.pc === pc && !this.udpOpen) this.stopRtc(); }, 8000);
    } catch {
      this.stopRtc();
    }
  }

  async onRtc(m) {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (m.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        this.remoteSet = true;
        for (const c of this.pendingCands) await pc.addIceCandidate(c);
        this.pendingCands = [];
      } else if (m.type === 'cand' && m.cand) {
        const c = { candidate: m.cand, sdpMid: m.mid };
        if (this.remoteSet) await pc.addIceCandidate(c);
        else this.pendingCands.push(c);
      }
    } catch {
      // a bad candidate is not fatal; ICE uses the others
    }
  }

  stopRtc() {
    this.udpOpen = false;
    try { this.dc && this.dc.close(); } catch {}
    try { this.pc && this.pc.close(); } catch {}
    this.pc = null;
    this.dc = null;
  }

  /** Send over UDP if available (unreliable). Returns false if not sent. */
  sendUdp(buf) {
    if (!this.udpOpen || !this.dc || this.dc.bufferedAmount > 16384) return false;
    try { this.dc.send(buf); return true; } catch { return false; }
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect() {
    // The game server is wherever the page's files come from (on a game portal
    // the page itself lives on the portal, with <base href> pointing here).
    const url = new URL('/ws', document.baseURI);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url.href);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.onOpen();
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 1000);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'rtc') { this.onRtc(msg); return; }
        if (msg.t === 'pong') {
          const sample = performance.now() - msg.c;
          this.rtt = this.rtt ? this.rtt * 0.7 + sample * 0.3 : sample;
          this.rttMax = Math.max(this.rttMax, sample);
          this.rttSamples.push(sample);
          if (this.rttSamples.length > 11) this.rttSamples.shift();
          const sorted = this.rttSamples.slice().sort((a, b) => a - b);
          this.rttMedian = sorted[sorted.length >> 1];
          return;
        }
        this.onJson(msg);
      } else {
        this.onBinary(ev.data, 'ws');
      }
    };
    ws.onclose = () => {
      clearInterval(this._pingTimer);
      this.stopRtc();
      this.onClose();
      setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => {};
  }

  send(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
  }

  sendBinary(buf) {
    if (this.connected) this.ws.send(buf);
  }
}
