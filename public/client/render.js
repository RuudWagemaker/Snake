import { LINE_WIDTH, MAX_WIDTH, FUEL_RADIUS, ROCKET_SPEED, TICK_RATE } from '../shared/constants.js';
import { FLAG_GAP, FLAG_CUT } from '../shared/protocol.js';
import { CHUNK } from './game.js';

const TAU = Math.PI * 2;
const GOOD = '#2ecc71', BRAKE = '#74c0fc', FUEL_COL = '#ff922b';

/** Collects line segments into one Path2D per line width (power-ups change width). */
class Runs {
  constructor() { this.runs = []; this.cur = null; this.lx = NaN; this.ly = NaN; }
  seg(x0, y0, x1, y1, w) {
    if (!this.cur || this.cur.w !== w) {
      this.cur = { path: new Path2D(), w };
      this.runs.push(this.cur);
      this.cur.path.moveTo(x0, y0);
    } else if (this.lx !== x0 || this.ly !== y0) {
      this.cur.path.moveTo(x0, y0);
    }
    this.cur.path.lineTo(x1, y1);
    this.lx = x1; this.ly = y1;
  }
  stroke(ctx, mul = 1, add = 0) {
    for (const r of this.runs) { ctx.lineWidth = r.w * mul + add; ctx.stroke(r.path); }
  }
}

function buildChunk(s, i0, i1) {
  const runs = new Runs();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const x = s.xs[i], y = s.ys[i];
    if (i > i0 && !(s.fl[i] & (FLAG_GAP | FLAG_CUT)) && !(s.fl[i - 1] & FLAG_GAP)) runs.seg(s.xs[i - 1], s.ys[i - 1], x, y, s.width(i));
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const pad = MAX_WIDTH;
  return { runs, x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
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
        this.drawTrail(sn, sn.n - 1, this.predictedExtra(game, f.myHead), v, this.liveColor(sn, f.now));
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
        if (extra && (sn.vox || sn.voy)) for (const p of extra) { p.x += sn.vox; p.y += sn.voy; }
        this.drawTrail(sn, limit, extra, v, dead ? (sn.dimColor ||= dim(sn.color)) : this.liveColor(sn, f.now), sn.vox || sn.voy ? sn : null, dead);
      }
    }
    this.drawItems(game, v, f.now);
    this.drawRockets(game, v, f.now, rt);

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
        hx = p.x + sn.vox; hy = p.y + sn.voy; ha = p.a;
      }
      sn.drawnX = hx; sn.drawnY = hy;
      if (hx < v.x0 - 100 || hx > v.x1 + 100 || hy < v.y0 - 100 || hy > v.y1 + 100) {
        if (!alive && !sn.burstAt) sn.burstAt = f.now; // don't replay old bursts later
        continue;
      }
      if (alive) {
        if (countdown) this.drawArrow(sn, hx, hy, ha, sn === game.me, f.now);
        const tick = sn === game.me && game.controlling ? game.lastTarget - 1 + game.alpha : rt;
        const m = game.modsNow(sn, tick, this.mods || (this.mods = {}));
        // jumping: a bigger head over a shadow, as if it's in the air
        const hr = Math.max(LINE_WIDTH, m.width) * 0.85 * (m.ghost ? 1.5 : 1);
        if (m.ghost) {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = '#000';
          ctx.beginPath(); ctx.arc(hx + 5, hy + 8, hr * 0.8, 0, TAU); ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = this.liveColor(sn, f.now);
        ctx.beginPath();
        ctx.arc(hx, hy, hr, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(hx + Math.cos(ha) * hr * 0.3, hy + Math.sin(ha) * hr * 0.3, hr * 0.38, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (m.speed !== 1) {
          // a ring shows a skill is on: green = boost, blue = brake
          ctx.strokeStyle = m.speed < 1 ? BRAKE : GOOD;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.arc(hx, hy, hr + 5, 0, TAU); ctx.stroke();
          ctx.setLineDash([]);
        }
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
      out.push({ x: P[j].x + ox * k, y: P[j].y + oy * k, w: P[j].w, solid: P[j].solid });
    }
    const me = game.me;
    out.push({ x: head.x, y: head.y, w: n ? P[n - 1].w : me.width(me.n - 1), solid: n ? P[n - 1].solid : !(me.fl[me.n - 1] & FLAG_GAP) });
    return out;
  }

  /** Colour of a living snake right now ("rainbow" trails cycle through hues). */
  liveColor(sn, now) {
    return sn.style === 'rainbow' ? `hsl(${Math.round(now / 12 + sn.id * 47) % 360},90%,62%)` : sn.color;
  }

  /**
   * Trail styles are drawn as extra strokes of the same paths: "neon" adds a
   * soft glow underneath, "core" a bright centre line on top.
   */
  drawTrail(sn, limit, extra, v, color, glide = null, dead = false) {
    const style = dead ? 'plain' : sn.style;
    if (style === 'neon') {
      this.ctx.globalAlpha = 0.28;
      this.strokeTrail(sn, limit, extra, v, color, glide, 1, 9);
      this.ctx.globalAlpha = 1;
    }
    this.strokeTrail(sn, limit, extra, v, color, glide);
    if (style === 'core') this.strokeTrail(sn, limit, extra, v, 'rgba(255,255,255,0.8)', glide, 0.33, 0);
  }

  /** `glide`: a snake whose newest points get its visual offset (fading along the tail). */
  strokeTrail(sn, limit, extra, v, color, glide = null, mul = 1, add = 0) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    const full = Math.floor(limit / CHUNK);
    for (let k = 0; k < full; k++) {
      let ch = sn.chunks[k];
      if (!ch) ch = sn.chunks[k] = buildChunk(sn, k * CHUNK, (k + 1) * CHUNK);
      if (ch.x1 < v.x0 || ch.x0 > v.x1 || ch.y1 < v.y0 || ch.y0 > v.y1) continue;
      ch.runs.stroke(ctx, mul, add);
    }
    // The newest part (and predicted/projected points) is drawn fresh each frame.
    const i0 = full * CHUNK;
    const runs = new Runs();
    let px = 0, py = 0, prevSolid = false, prevW = LINE_WIDTH;
    for (let i = i0; i <= limit; i++) {
      const solid = !(sn.fl[i] & FLAG_GAP);
      let x = sn.xs[i], y = sn.ys[i];
      if (glide && limit - i < 8) {
        const w = 1 - (limit - i) / 8;
        x += glide.vox * w; y += glide.voy * w;
      }
      prevW = sn.width(i);
      if (i > i0 && solid && prevSolid && !(sn.fl[i] & FLAG_CUT)) runs.seg(px, py, x, y, prevW);
      px = x; py = y; prevSolid = solid;
    }
    if (extra) {
      for (const p of extra) {
        const w = p.w || prevW;
        if (p.solid && prevSolid) runs.seg(px, py, p.x, p.y, w);
        px = p.x; py = p.y; prevSolid = p.solid; prevW = w;
      }
    }
    runs.stroke(ctx, mul, add);
  }

  drawItems(game, v, now) {
    const ctx = this.ctx;
    const pulse = 1 + Math.sin(now / 250) * 0.08;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const it of game.items.values()) {
      if (it.x < v.x0 - 30 || it.x > v.x1 + 30 || it.y < v.y0 - 30 || it.y > v.y1 + 30) continue;
      if (it.localPick && now - it.localPick < 800) continue; // we're picking it up
      if (it.type === 'fuel') {
        // small glowing dot
        // pops in when it appears, then twinkles
        const age = it.bornAt ? Math.max(0, (now - it.bornAt) / 350) : 1;
        const pop = age >= 1 ? 1 : age < 0.7 ? (age / 0.7) * 1.4 : 1.4 - ((age - 0.7) / 0.3) * 0.4;
        const tw = (1 + Math.sin(now / 300 + it.id) * 0.15) * pop;
        if (age < 1) {
          ctx.globalAlpha = (1 - age) * 0.6;
          ctx.strokeStyle = '#ffd8a8';
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(it.x, it.y, FUEL_RADIUS * (1 + 3 * age), 0, TAU); ctx.stroke();
        }
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = FUEL_COL;
        ctx.beginPath(); ctx.arc(it.x, it.y, FUEL_RADIUS * 1.8 * tw, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffd8a8';
        ctx.beginPath(); ctx.arc(it.x, it.y, FUEL_RADIUS * 0.8 * pop, 0, TAU); ctx.fill();
      }
    }
    // Floating "+SPEED" texts where something was picked up
    game.popups = game.popups.filter((p) => now - p.at < 1200);
    for (const p of game.popups) {
      const k = (now - p.at) / 1200;
      ctx.globalAlpha = 1 - k;
      ctx.font = '800 16px system-ui, sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(6,8,13,0.8)';
      ctx.strokeText(p.text, p.x, p.y - 20 - k * 30);
      ctx.fillStyle = p.color || GOOD;
      ctx.fillText(p.text, p.x, p.y - 20 - k * 30);
    }
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
  }

  /** Flying rockets (straight line at ROCKET_SPEED from launch) and blast flashes. */
  drawRockets(game, v, now, rt) {
    const ctx = this.ctx;
    const perTick = ROCKET_SPEED / TICK_RATE;
    for (const rk of game.rockets.values()) {
      if (rt < rk.tick) continue;
      const d = (rt - rk.tick + 1) * perTick; // the server moves it one step on its launch tick
      // Stop at the line: the server's hit point, or until that arrives, our own prediction.
      const max = rk.end ? Math.hypot(rk.end.x - rk.x, rk.end.y - rk.y) : rk.predEnd.d;
      const c = Math.cos(rk.a), s = Math.sin(rk.a);
      if (d >= max) {
        if (!rk.impactAt) {
          rk.impactAt = now;
          rk.ix = rk.x + c * max; rk.iy = rk.y + s * max;
          rk.blew = rk.end ? rk.end.r > 0 : rk.predEnd.hit;
        }
        continue;
      }
      const x = rk.x + c * d, y = rk.y + s * d;
      if (x < v.x0 - 60 || x > v.x1 + 60 || y < v.y0 - 60 || y > v.y1 + 60) continue;
      const tail = Math.min(d, 46);
      const g = ctx.createLinearGradient(x - c * tail, y - s * tail, x, y);
      g.addColorStop(0, 'rgba(255,146,43,0)');
      g.addColorStop(1, 'rgba(255,190,90,0.9)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(x - c * tail, y - s * tail); ctx.lineTo(x, y); ctx.stroke();
      const sn = game.snakes.get(rk.by);
      ctx.fillStyle = sn ? sn.color : '#fff';
      ctx.beginPath();
      ctx.moveTo(x + c * 9, y + s * 9);
      ctx.lineTo(x - c * 5 - s * 5, y - s * 5 + c * 5);
      ctx.lineTo(x - c * 5 + s * 5, y - s * 5 - c * 5);
      ctx.closePath(); ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
    // Explosion where the rocket reached the line (the hole opens a moment later, inside it)
    for (const rk of game.rockets.values()) {
      if (!rk.impactAt || !rk.blew) continue;
      if (rk.end && rk.end.r && !rk.moved) { rk.ix = rk.end.x; rk.iy = rk.end.y; rk.moved = true; } // server's spot
      // Fades out over 650 ms, but holds until the hole opens (later with lag).
      let k = (now - rk.impactAt) / 650;
      if (rk.hole) k = Math.min(k, rk.hole.shown ? 0.6 + (now - rk.hole.shownAt) / 700 : 0.6);
      if (k > 1 || rk.ix < v.x0 - 80 || rk.ix > v.x1 + 80 || rk.iy < v.y0 - 80 || rk.iy > v.y1 + 80) continue;
      const grow = 1 - (1 - k) * (1 - k);
      ctx.globalAlpha = (1 - k) * 0.6;
      ctx.fillStyle = '#ffd8a8';
      ctx.beginPath(); ctx.arc(rk.ix, rk.iy, 8 + 26 * grow, 0, TAU); ctx.fill();
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.fillStyle = '#fff4e6';
      ctx.beginPath(); ctx.arc(rk.ix, rk.iy, 5 + 10 * (1 - k), 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    }
    for (const h of game.holes) {
      if (!h.shown) continue;
      const k = (now - h.shownAt) / 450;
      if (k > 1 || h.x < v.x0 - 80 || h.x > v.x1 + 80 || h.y < v.y0 - 80 || h.y > v.y1 + 80) continue;
      ctx.globalAlpha = (1 - k) * 0.55;
      ctx.fillStyle = '#ffd8a8';
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r * (0.4 + 0.8 * k), 0, TAU); ctx.fill();
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = FUEL_COL;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r * (0.7 + 0.7 * k), 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    }
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
