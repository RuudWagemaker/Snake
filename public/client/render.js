import { LINE_WIDTH } from '../shared/constants.js';
import { FLAG_GAP } from '../shared/protocol.js';

const CHUNK = 64;          // trail points per cached Path2D
const TAU = Math.PI * 2;

function buildChunk(s, i0, i1) {
  const path = new Path2D();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let prevSolid = false;
  for (let i = i0; i <= i1; i++) {
    const x = s.xs[i], y = s.ys[i];
    const solid = !(s.fl[i] & FLAG_GAP);
    if (i > i0 && solid && prevSolid) path.lineTo(x, y);
    else path.moveTo(x, y);
    prevSolid = solid;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const pad = LINE_WIDTH;
  return { path, x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

// Blend a #rrggbb colour toward the arena floor. Used for dead snakes' trails:
// an opaque colour avoids bright spots where semi-transparent strokes overlap.
function dim(hex, k = 0.5) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c, bg) => Math.round(c * k + bg * (1 - k));
  return `rgb(${mix(n >> 16, 0x0e)},${mix((n >> 8) & 255, 0x14)},${mix(n & 255, 0x21)})`;
}

export class Renderer {
  constructor(canvas, minimap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.mm = minimap;
    this.mmctx = minimap.getContext('2d');
    this.tmp = { x: 0, y: 0, a: 0 };
    this.resize();
    addEventListener('resize', () => this.resize());
    addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    // Same field of view (by screen diagonal) on every device.
    this.baseScale = Math.min(2.2, Math.max(0.45, Math.hypot(this.w, this.h) / 1400));
    const mmCss = this.mm.clientWidth || 120;
    this.mm.width = this.mm.height = Math.round(mmCss * this.dpr);
  }

  drawIdle(now) {
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0f17';
    ctx.fillRect(0, 0, w, h);
    const step = 60, off = (now * 0.01) % step;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = -step + off; x < w + step; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = -step + off; y < h + step; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  /**
   * f: { now, renderTick, serverTick, alpha, myHead, cam:{x,y,scale}, zone }
   */
  draw(game, f) {
    const { ctx, w, h, dpr } = this;
    const cam = f.cam, s = cam.scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#06080d';
    ctx.fillRect(0, 0, w, h);

    const v = {
      x0: cam.x - w / 2 / s, y0: cam.y - h / 2 / s,
      x1: cam.x + w / 2 / s, y1: cam.y + h / 2 / s,
    };
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (w / 2 - cam.x * s), dpr * (h / 2 - cam.y * s));

    const zone = f.zone;

    // Arena floor (inside the original field) + grid
    ctx.fillStyle = '#0e1421';
    ctx.beginPath();
    ctx.arc(0, 0, game.R0, 0, TAU);
    ctx.fill();
    this.drawGrid(v, s);

    // Trails
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = LINE_WIDTH;
    const rt = f.renderTick;
    for (const sn of game.list) {
      if (sn.n === 0) continue;
      if (sn === game.me && game.controlling) {
        this.drawTrail(sn, sn.n - 1, this.predictedExtra(game, f.myHead), v, sn.color);
      } else {
        const ft = rt - sn.firstTick;
        let limit = Math.floor(ft);
        let extra = null;
        if (limit >= sn.n - 1) {
          limit = sn.n - 1;
          // No data yet for this moment: keep it moving along its curve.
          const ex = game.extrapolate(sn, rt);
          if (ex) { extra = ex.pts; sn.exHead = ex.head; }
        }
        else if (limit < 0) limit = 0;
        else {
          const k = ft - limit;
          if (k > 0) {
            const j = limit + 1;
            extra = [{
              x: sn.xs[limit] + (sn.xs[j] - sn.xs[limit]) * k,
              y: sn.ys[limit] + (sn.ys[j] - sn.ys[limit]) * k,
              solid: !(sn.fl[j] & FLAG_GAP),
            }];
          }
        }
        const dead = sn.deathTick <= rt;
        this.drawTrail(sn, limit, extra, v, dead ? (sn.dimColor ||= dim(sn.color)) : sn.color);
      }
    }
    // Outside the zone
    ctx.beginPath();
    ctx.rect(v.x0 - 50, v.y0 - 50, v.x1 - v.x0 + 100, v.y1 - v.y0 + 100);
    ctx.arc(zone.x, zone.y, Math.max(zone.r, 0.01), 0, TAU);
    ctx.fillStyle = 'rgba(255, 40, 70, 0.16)';
    ctx.fill('evenodd');
    if (zone.next && zone.next.r > 0) {
      ctx.setLineDash([14 / s, 12 / s]);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 2 / s;
      ctx.beginPath();
      ctx.arc(zone.next.x, zone.next.y, zone.next.r, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (zone.r > 0) {
      ctx.strokeStyle = '#ff4d6d';
      ctx.lineWidth = 4 / s;
      ctx.beginPath();
      ctx.arc(zone.x, zone.y, zone.r, 0, TAU);
      ctx.stroke();
    }

    // Heads
    const countdown = f.serverTick < game.playTick;
    const labels = [];
    for (const sn of game.list) {
      let hx, hy, ha, alive;
      if (sn === game.me && game.controlling) {
        hx = f.myHead.x; hy = f.myHead.y; ha = f.myHead.a; alive = true;
      } else {
        alive = sn.deathTick > rt;
        const p = alive && rt > sn.lastTick && sn.exHead ? sn.exHead : sn.headAt(alive ? rt : sn.lastTick, this.tmp);
        sn.exHead = null;
        hx = p.x; hy = p.y; ha = p.a;
      }
      if (hx < v.x0 - 100 || hx > v.x1 + 100 || hy < v.y0 - 100 || hy > v.y1 + 100) {
        if (!alive && !sn.burstAt) sn.burstAt = f.now; // don't replay old bursts later
        continue;
      }
      if (alive) {
        if (countdown) this.drawArrow(sn, hx, hy, ha, sn === game.me, f.now);
        ctx.fillStyle = sn.color;
        ctx.beginPath();
        ctx.arc(hx, hy, LINE_WIDTH * 0.85, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(hx + Math.cos(ha) * 1.6, hy + Math.sin(ha) * 1.6, LINE_WIDTH * 0.32, 0, TAU);
        ctx.fill();
        if (sn !== game.me || countdown) labels.push({ sn, x: hx, y: hy });
      } else {
        if (!sn.burstAt) sn.burstAt = f.now;
        const age = f.now - sn.burstAt;
        if (age < 800) {
          const k = age / 800;
          ctx.globalAlpha = 1 - k;
          ctx.strokeStyle = sn.color;
          ctx.lineWidth = 3 * (1 - k) + 0.5;
          ctx.beginPath();
          ctx.arc(hx, hy, 6 + k * 40, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1.5;
        const r = 3.5;
        ctx.beginPath();
        ctx.moveTo(hx - r, hy - r); ctx.lineTo(hx + r, hy + r);
        ctx.moveTo(hx + r, hy - r); ctx.lineTo(hx - r, hy + r);
        ctx.stroke();
      }
    }

    // Labels in screen space (crisp text at any zoom)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const l of labels) {
      const sx = (l.x - cam.x) * s + w / 2, sy = (l.y - cam.y) * s + h / 2;
      const isMe = l.sn === game.me;
      ctx.fillStyle = isMe ? '#fff' : 'rgba(255,255,255,0.7)';
      ctx.font = isMe ? '800 14px system-ui, sans-serif' : '600 12px system-ui, sans-serif';
      ctx.fillText(isMe ? 'YOU' : l.sn.name, sx, sy - 14);
    }

    this.drawMinimap(game, zone, f);
  }

  predictedExtra(game, head) {
    const P = game.path;
    const n = P.length;
    const out = [];
    const ox = game.offset.x, oy = game.offset.y;
    for (let j = 0; j < n - 1; j++) {
      const k = (j + 1) / n;
      out.push({ x: P[j].x + ox * k, y: P[j].y + oy * k, solid: P[j].solid });
    }
    out.push({ x: head.x, y: head.y, solid: n ? P[n - 1].solid : !(game.me.fl[game.me.n - 1] & FLAG_GAP) });
    return out;
  }

  drawTrail(sn, limit, extra, v, color) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    const full = Math.floor(limit / CHUNK);
    for (let k = 0; k < full; k++) {
      let ch = sn.chunks[k];
      if (!ch) ch = sn.chunks[k] = buildChunk(sn, k * CHUNK, (k + 1) * CHUNK);
      if (ch.x1 < v.x0 || ch.x0 > v.x1 || ch.y1 < v.y0 || ch.y0 > v.y1) continue;
      ctx.stroke(ch.path);
    }
    const i0 = full * CHUNK;
    ctx.beginPath();
    let prevSolid = false;
    for (let i = i0; i <= limit; i++) {
      const solid = !(sn.fl[i] & FLAG_GAP);
      if (i > i0 && solid && prevSolid) ctx.lineTo(sn.xs[i], sn.ys[i]);
      else ctx.moveTo(sn.xs[i], sn.ys[i]);
      prevSolid = solid;
    }
    if (extra) {
      for (const p of extra) {
        if (p.solid && prevSolid) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
        prevSolid = p.solid;
      }
    }
    ctx.stroke();
  }

  drawArrow(sn, x, y, a, isMe, now) {
    const ctx = this.ctx;
    const len = isMe ? 46 : 28;
    const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
    ctx.strokeStyle = sn.color;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.moveTo(ex + Math.cos(a + 2.5) * 9, ey + Math.sin(a + 2.5) * 9);
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex + Math.cos(a - 2.5) * 9, ey + Math.sin(a - 2.5) * 9);
    ctx.stroke();
    if (isMe) {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 18 + Math.sin(now / 120) * 4, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawGrid(v, s) {
    const ctx = this.ctx;
    const step = 100;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1 / s;
    ctx.beginPath();
    for (let x = Math.floor(v.x0 / step) * step; x <= v.x1; x += step) { ctx.moveTo(x, v.y0); ctx.lineTo(x, v.y1); }
    for (let y = Math.floor(v.y0 / step) * step; y <= v.y1; y += step) { ctx.moveTo(v.x0, y); ctx.lineTo(v.x1, y); }
    ctx.stroke();
  }

  drawMinimap(game, zone, f) {
    const c = this.mmctx, S = this.mm.width;
    const k = (S / 2 - 3) / game.R0;
    const mx = (x) => S / 2 + x * k, my = (y) => S / 2 + y * k;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, S, S);
    c.fillStyle = 'rgba(8,12,20,0.75)';
    c.beginPath(); c.arc(S / 2, S / 2, S / 2 - 1, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.15)';
    c.lineWidth = 1;
    c.stroke();
    if (zone.r > 0) {
      c.fillStyle = 'rgba(255,255,255,0.08)';
      c.strokeStyle = '#ff4d6d';
      c.lineWidth = 1.5 * this.dpr;
      c.beginPath(); c.arc(mx(zone.x), my(zone.y), zone.r * k, 0, TAU); c.fill(); c.stroke();
    }
    if (zone.next && zone.next.r > 0) {
      c.setLineDash([3 * this.dpr, 3 * this.dpr]);
      c.strokeStyle = 'rgba(255,255,255,0.7)';
      c.lineWidth = this.dpr;
      c.beginPath(); c.arc(mx(zone.next.x), my(zone.next.y), zone.next.r * k, 0, TAU); c.stroke();
      c.setLineDash([]);
    }
    const p = f.cam;
    c.fillStyle = game.controlling ? '#fff' : 'rgba(255,255,255,0.5)';
    c.beginPath(); c.arc(mx(p.x), my(p.y), 3 * this.dpr, 0, TAU); c.fill();
  }
}
