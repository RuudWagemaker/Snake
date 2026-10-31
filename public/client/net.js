// Thin WebSocket wrapper with automatic reconnect.
export class Net {
  constructor() {
    this.ws = null;
    this.onJson = () => {};
    this.onBinary = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
    this.rtt = 0;
    this._pingTimer = null;
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.onOpen();
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'pong') {
          const sample = performance.now() - msg.c;
          this.rtt = this.rtt ? this.rtt * 0.7 + sample * 0.3 : sample;
          return;
        }
        this.onJson(msg);
      } else {
        this.onBinary(ev.data);
      }
    };
    ws.onclose = () => {
      clearInterval(this._pingTimer);
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
