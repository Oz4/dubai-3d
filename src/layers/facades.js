// Procedurally painted facade & roof textures (a 2D texture array).
// Colour layer: rgb = albedo (neutral where the building tint applies), a = glass amount.
// Mask layer:   r = window interior that can light up at night, g = how much the building tint applies.
import * as THREE from 'three';
import { rng } from '../core/util.js';

const S = 256;
const g = (v) => { const c = Math.round(Math.max(0, Math.min(1, v)) * 255); return `rgb(${c},${c},${c})`; };
const rgb = (r, gg, b) => `rgb(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)})`;

function painter(gc, gm, L, rnd) {
  const bw = S / L.bays, fh = S / L.rows;
  const mfill = (m) => `rgb(${Math.round(m[0] * 255)},${Math.round(m[1] * 255)},${Math.round(m[2] * 255)})`;
  return {
    S, bw, fh, bays: L.bays, rows: L.rows, rnd, gc,
    // m = [glass, lit, tint]
    fill(x, y, w, h, color, m) { gc.fillStyle = color; gc.fillRect(x, y, w, h); if (m) { gm.fillStyle = mfill(m); gm.fillRect(x, y, w, h); } },
    vgrad(x, y, w, h, c0, c1, m) {
      const gr = gc.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, c0); gr.addColorStop(1, c1);
      gc.fillStyle = gr; gc.fillRect(x, y, w, h); if (m) { gm.fillStyle = mfill(m); gm.fillRect(x, y, w, h); }
    },
    shape(build, color, m) {
      gc.beginPath(); build(gc); gc.fillStyle = color; gc.fill();
      if (m) { gm.beginPath(); build(gm); gm.fillStyle = mfill(m); gm.fill(); }
    },
    stroke(build, color, width, m) {
      gc.beginPath(); build(gc); gc.strokeStyle = color; gc.lineWidth = width; gc.stroke();
      if (m) { gm.beginPath(); build(gm); gm.strokeStyle = mfill(m); gm.lineWidth = width; gm.stroke(); }
    },
    // soft reflection streak across a glass panel (colour only)
    streak(x, y, w, h, a) {
      const gr = gc.createLinearGradient(x, y + h, x + w, y);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.45, `rgba(255,255,255,${a})`); gr.addColorStop(0.6, 'rgba(255,255,255,0)');
      gc.fillStyle = gr; gc.fillRect(x, y, w, h);
    },
    noise(x, y, w, h, amount, size = 2) {
      for (let i = 0; i < (w * h) / (size * size * 6); i++) {
        const v = rnd(); gc.fillStyle = `rgba(${v > 0.5 ? '255,255,255' : '0,0,0'},${amount * rnd()})`;
        gc.fillRect(x + rnd() * w, y + rnd() * h, size, size);
      }
    },
  };
}

// ---------------------------------------------------------------- wall styles
function curtain(P, opts) {
  const { S, bw, fh, rows, bays, rnd } = P;
  const span = opts.spandrel ?? 0.14;
  for (let f = 0; f < rows; f++) {
    const y0 = f * fh;
    for (let b = 0; b < bays; b++) {
      const x0 = b * bw, tone = 0.84 + rnd() * 0.16;
      P.vgrad(x0, y0, bw, fh * (1 - span), g(1.0 * tone), g(0.62 * tone), [1, 1, 1]);
      if (rnd() < 0.4) P.streak(x0, y0, bw, fh * (1 - span), 0.14);
      if (rnd() < 0.14) P.fill(x0 + 3, y0 + fh * 0.06, bw - 6, fh * (0.18 + rnd() * 0.42), g(0.97), [0.35, 0.85, 1]);
    }
    P.vgrad(0, y0 + fh * (1 - span), S, fh * span, g(0.5), g(0.36), [0.7, 0, 1]);
  }
  const mw = opts.fins ? 6 : 3;
  for (let b = 0; b <= bays; b++) {
    P.fill(b * bw - mw / 2, 0, mw, S, opts.fins ? '#eef1f4' : '#d4dade', [0, 0, 0.12]);
    if (opts.fins) P.fill(b * bw + mw / 2, 0, 2, S, 'rgba(0,0,0,0.18)', null);
  }
  for (let f = 0; f <= rows; f++) {
    P.fill(0, f * fh - 1.5, S, 3, '#cfd6db', [0, 0, 0.12]);
    P.fill(0, f * fh + fh * (1 - span) - 1, S, 2, '#c3cbd1', [0, 0, 0.12]);
  }
}
function balconies(P, staggered) {
  const { S, bw, fh, rows, bays, rnd } = P;
  // recessed facade: wall + tall windows
  P.fill(0, 0, S, S, g(0.92), [0, 0, 1]);
  for (let f = 0; f < rows; f++) for (let b = 0; b < bays; b++) {
    const y0 = f * fh, x0 = b * bw;
    P.vgrad(x0 + bw * 0.1, y0 + fh * 0.16, bw * 0.8, fh * 0.76, rgb(0.42, 0.5, 0.58), rgb(0.2, 0.26, 0.32), [1, 1, 0]);
    P.fill(x0 + bw * 0.5 - 1, y0 + fh * 0.16, 2, fh * 0.76, '#9aa4ad', [0, 0, 0]);
    if (rnd() < 0.25) P.fill(x0 + bw * 0.12, y0 + fh * 0.18, bw * 0.36, fh * 0.5, rgb(0.9, 0.87, 0.8), [0.2, 0.9, 0]);
  }
  for (let f = 0; f < rows; f++) {
    const y0 = f * fh;
    // shadow cast by the balcony slab above
    const gr = P.gc.createLinearGradient(0, y0, 0, y0 + fh * 0.35);
    gr.addColorStop(0, 'rgba(0,0,0,0.42)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    for (let b = 0; b < bays; b++) {
      if (staggered && (b + f) % 2) continue;
      const x0 = b * bw;
      P.gc.fillStyle = gr; P.gc.fillRect(x0, y0, bw, fh * 0.35);
      // glass balustrade + handrail
      P.fill(x0 + 2, y0 + fh * 0.6, bw - 4, fh * 0.3, 'rgba(178,214,228,0.55)', [0.6, 0.5, 0]);
      P.fill(x0 + 2, y0 + fh * 0.6, bw - 4, 2, '#e8edf0', [0, 0, 0]);
      // slab edge (tinted)
      P.fill(x0, y0 + fh * 0.9, bw, fh * 0.1, g(0.98), [0, 0, 1]);
      P.fill(x0, y0 + fh * 0.9 - 1, bw, 1, 'rgba(255,255,255,0.8)', null);
    }
    if (staggered) for (let b = 0; b < bays; b++) if ((b + f) % 2) P.fill(b * bw, y0 + fh * 0.92, bw, fh * 0.08, g(0.9), [0, 0, 1]);
  }
  // vertical fins every two bays
  for (let b = 0; b <= bays; b += 2) P.fill(b * bw - 3, 0, 6, S, g(0.99), [0, 0, 1]);
}
function punched(P) {
  const { S, bw, fh, rows, bays, rnd } = P;
  P.fill(0, 0, S, S, g(0.95), [0, 0, 1]); P.noise(0, 0, S, S, 0.04, 2);
  for (let f = 0; f < rows; f++) {
    P.fill(0, f * fh + fh - 6, S, 6, g(0.99), [0, 0, 0.85]);
    P.fill(0, f * fh + fh, S, 2, 'rgba(0,0,0,0.12)', null);
    for (let b = 0; b < bays; b++) {
      const x0 = b * bw + bw * 0.16, y0 = f * fh + fh * 0.2, w = bw * 0.68, h = fh * 0.62;
      P.fill(x0 - 2, y0 - 2, w + 4, h + 4, g(1), [0, 0, 0.4]);
      P.vgrad(x0, y0, w, h, rgb(0.62, 0.72, 0.8), rgb(0.32, 0.4, 0.48), [0.9, 1, 0]);
      if (rnd() < 0.4) P.streak(x0, y0, w, h, 0.18);
      P.fill(x0 + w / 2 - 1, y0, 2, h, '#e1e5e8', [0, 0, 0]);
      if (rnd() < 0.22) P.fill(x0 + 2, y0 + 2, w * 0.45, h * (0.3 + rnd() * 0.5), rgb(0.93, 0.9, 0.84), [0.2, 0.9, 0]);
      if ((b + f) % 3 === 0) { // small balcony railing
        P.fill(x0 - 4, y0 + h * 0.62, w + 8, 2, '#f6f6f4', [0, 0, 0]);
        P.fill(x0 - 4, y0 + h * 0.62, w + 8, h * 0.38, 'rgba(210,228,236,0.45)', null);
      }
    }
  }
}
function jbr(P) {
  // JBR: sandstone towers with deep horizontal balcony bands
  const { S, bw, fh, rows, bays, rnd } = P;
  P.fill(0, 0, S, S, g(0.94), [0, 0, 1]); P.noise(0, 0, S, S, 0.05, 2);
  for (let f = 0; f < rows; f++) {
    const y0 = f * fh;
    // recessed glazing behind the balconies
    for (let b = 0; b < bays; b++) {
      const x0 = b * bw + bw * 0.08, w = bw * 0.84, top = y0 + fh * 0.12, h = fh * 0.62;
      P.vgrad(x0, top, w, h, rgb(0.5, 0.56, 0.6), rgb(0.26, 0.3, 0.34), [0.75, 1, 0]);
      P.fill(x0 + w * 0.33, top, 2, h, '#d9d2c4', [0, 0, 0]); P.fill(x0 + w * 0.66, top, 2, h, '#d9d2c4', [0, 0, 0]);
      if (rnd() < 0.2) P.fill(x0 + 3, top + 2, w * 0.3, h * 0.6, rgb(0.92, 0.88, 0.8), [0.2, 0.9, 0]);
      // arched opening head on alternate bays (the "Arabesque" touch)
      if ((b + f) % 2 === 0) P.shape((c) => { c.moveTo(x0, top); c.quadraticCurveTo(x0 + w / 2, top + h * 0.28, x0 + w, top); c.lineTo(x0 + w, top - 2); c.lineTo(x0, top - 2); c.closePath(); }, g(0.97), [0, 0, 1]);
    }
    // shadow under the slab above
    const gr = P.gc.createLinearGradient(0, y0, 0, y0 + fh * 0.3);
    gr.addColorStop(0, 'rgba(40,24,10,0.45)'); gr.addColorStop(1, 'rgba(40,24,10,0)');
    P.gc.fillStyle = gr; P.gc.fillRect(0, y0, S, fh * 0.3);
    // balcony parapet (solid, tinted) + handrail
    P.fill(0, y0 + fh * 0.72, S, fh * 0.2, g(0.99), [0, 0, 1]);
    P.fill(0, y0 + fh * 0.72, S, 2, 'rgba(255,255,255,0.9)', null);
    for (let b = 0; b < bays; b++) P.fill(b * bw + bw * 0.2, y0 + fh * 0.76, bw * 0.6, fh * 0.1, g(0.88), [0, 0, 1]); // recessed panel
    P.fill(0, y0 + fh * 0.92, S, fh * 0.08, g(0.84), [0, 0, 1]);
  }
  for (let b = 0; b <= bays; b++) P.fill(b * bw - 3, 0, 6, S, g(0.9), [0, 0, 1]);
}
function stoneGlass(P) {
  const { S, bw, fh, rows, bays } = P;
  for (let b = 0; b < bays; b++) {
    P.vgrad(b * bw + bw * 0.28, 0, bw * 0.72, S, rgb(0.5, 0.64, 0.76), rgb(0.27, 0.38, 0.5), [1, 1, 0]);
    P.fill(b * bw, 0, bw * 0.28, S, g(0.96), [0, 0, 1]);
    P.fill(b * bw + bw * 0.28, 0, 2, S, 'rgba(0,0,0,0.25)', null);
  }
  for (let f = 0; f < rows; f++) { P.fill(0, f * fh + fh * 0.88, S, fh * 0.12, g(0.97), [0, 0, 1]); P.fill(0, f * fh + fh, S, 2, 'rgba(0,0,0,0.2)', null); }
  for (let b = 0; b < bays; b++) for (let k = 1; k < 3; k++) P.fill(b * bw + bw * 0.28 + (bw * 0.72 * k) / 3, 0, 2, S, '#c5ced6', [0, 0, 0]);
}
function officeBand(P) {
  const { S, bw, fh, rows, bays, rnd } = P;
  P.fill(0, 0, S, S, g(0.95), [0, 0, 1]);
  for (let f = 0; f < rows; f++) {
    const y0 = f * fh;
    P.vgrad(0, y0 + fh * 0.12, S, fh * 0.6, rgb(0.42, 0.52, 0.6), rgb(0.2, 0.27, 0.33), [1, 1, 0]);
    for (let b = 0; b < bays; b++) { if (rnd() < 0.3) P.streak(b * bw, y0 + fh * 0.12, bw, fh * 0.6, 0.12); P.fill(b * bw - 1, y0 + fh * 0.12, 2, fh * 0.6, '#b8c2ca', [0, 0, 0]); }
    P.fill(0, y0 + fh * 0.72, S, 3, 'rgba(0,0,0,0.25)', null);
  }
}
function villa(P) {
  const { S, bw, fh, rows, bays, rnd } = P;
  P.fill(0, 0, S, S, g(0.95), [0, 0, 1]); P.noise(0, 0, S, S, 0.07, 3);
  for (let f = 0; f < rows; f++) {
    const y0 = f * fh;
    P.fill(0, y0 + fh - 10, S, 10, g(0.99), [0, 0, 0.55]); P.fill(0, y0 + fh, S, 3, 'rgba(0,0,0,0.18)', null);
    for (let b = 0; b < bays; b++) {
      if (rnd() < 0.18) continue; // blank wall bay
      const wide = rnd() < 0.3;
      const w = bw * (wide ? 0.66 : 0.42), x0 = b * bw + (bw - w) / 2, top = y0 + fh * 0.22, h = fh * 0.6;
      const arch = rnd() < 0.55;
      P.fill(x0 - 4, top - 4, w + 8, h + 8, g(1), [0, 0, 0.4]);
      P.shape((c) => { if (arch) { c.moveTo(x0, top + h); c.lineTo(x0, top + w * 0.25); c.quadraticCurveTo(x0 + w / 2, top - w * 0.2, x0 + w, top + w * 0.25); c.lineTo(x0 + w, top + h); c.closePath(); } else c.rect(x0, top, w, h); },
        rgb(0.22, 0.27, 0.32), [0.8, 1, 0]);
      P.fill(x0 + w / 2 - 1.5, top, 3, h, '#e9e4da', [0, 0, 0]);
      if (rnd() < 0.3) P.fill(x0 + 3, top + 3, w - 6, h * 0.35, rgb(0.92, 0.9, 0.84), [0.2, 0.9, 0]);
      P.fill(x0 - 6, top + h + 2, w + 12, 5, g(0.98), [0, 0, 0.4]);
    }
  }
}
function townhouse(P) {
  const { S, bw, fh, rows, bays, rnd } = P;
  P.fill(0, 0, S, S, g(0.97), [0, 0, 1]); P.noise(0, 0, S, S, 0.05, 3);
  for (let f = 0; f < rows; f++) for (let b = 0; b < bays; b++) {
    const y0 = f * fh, x0 = b * bw + bw * 0.18, w = bw * 0.64, top = y0 + fh * 0.2, h = fh * 0.66;
    P.vgrad(x0, top, w, h, rgb(0.34, 0.4, 0.46), rgb(0.15, 0.19, 0.23), [0.85, 1, 0]);
    P.fill(x0 + w / 3, top, 2, h, '#d8d8d4', [0, 0, 0]); P.fill(x0 + (2 * w) / 3, top, 2, h, '#d8d8d4', [0, 0, 0]);
    if (rnd() < 0.25) P.fill(x0, top, w, h * 0.3, rgb(0.92, 0.9, 0.86), [0.2, 0.9, 0]);
    P.fill(x0 - 3, top - 5, w + 6, 5, rgb(0.42, 0.36, 0.3), [0, 0, 0]); // dark canopy line
  }
}
function industrial(P) {
  const { S, fh, rows } = P;
  for (let x = 0; x < S; x += 6) { P.fill(x, 0, 3, S, g(0.96), [0, 0, 1]); P.fill(x + 3, 0, 3, S, g(0.84), [0, 0, 1]); }
  for (let f = 0; f < rows; f++) {
    P.vgrad(0, f * fh + fh * 0.08, S, fh * 0.12, rgb(0.4, 0.48, 0.55), rgb(0.25, 0.3, 0.35), [0.6, 0.5, 0]);
    P.fill(0, f * fh + fh * 0.2, S, 2, 'rgba(0,0,0,0.2)', null);
  }
}
function podium(P) {
  const { S, fh, rows, bw, bays } = P;
  P.fill(0, 0, S, S, g(0.9), [0, 0, 1]);
  for (let f = 0; f < rows; f++) {
    const y0 = f * fh;
    for (let y = y0 + fh * 0.12; y < y0 + fh * 0.86; y += 7) { P.fill(0, y, S, 4, g(0.99), [0, 0, 1]); P.fill(0, y + 4, S, 3, rgb(0.3, 0.32, 0.34), [0, 0.3, 0]); }
    P.fill(0, y0 + fh * 0.88, S, fh * 0.12, g(0.96), [0, 0, 1]);
  }
  for (let b = 0; b <= bays; b++) P.fill(b * bw - 4, 0, 8, S, g(0.95), [0, 0, 1]);
}
function construction(P) {
  const { S, fh, rows, bw, bays, rnd } = P;
  P.fill(0, 0, S, S, rgb(0.17, 0.17, 0.18), [0, 0, 0]);
  for (let f = 0; f < rows; f++) P.fill(0, f * fh + fh * 0.85, S, fh * 0.15, g(0.78), [0, 0, 0.6]);
  for (let b = 0; b <= bays; b++) P.fill(b * bw - 5, 0, 10, S, g(0.74), [0, 0, 0.6]);
  for (let i = 0; i < 4; i++) if (rnd() < 0.7) P.fill(rnd() * S * 0.7, rnd() * S * 0.7, 40 + rnd() * 60, 30 + rnd() * 40, 'rgba(46,120,70,0.75)', [0, 0, 0]);
}

// white exoskeleton frames over recessed dark glass (Cayan-style)
function frame(P) {
  const { S, bw, fh, rows, bays, rnd } = P;
  for (let f = 0; f < rows; f++) for (let b = 0; b < bays; b++) {
    const t = 0.85 + rnd() * 0.15;
    P.vgrad(b * bw, f * fh, bw, fh, rgb(0.42 * t, 0.52 * t, 0.6 * t), rgb(0.2, 0.26, 0.32), [1, 1, 0]);
    if (rnd() < 0.3) P.streak(b * bw, f * fh, bw, fh, 0.14);
  }
  for (let f = 0; f <= rows; f++) {
    P.fill(0, f * fh - fh * 0.1, S, fh * 0.2, g(0.98), [0, 0, 1]);
    P.fill(0, f * fh + fh * 0.1, S, 3, 'rgba(0,0,0,0.3)', null);
  }
  for (let b = 0; b <= bays; b++) { P.fill(b * bw - bw * 0.08, 0, bw * 0.16, S, g(0.96), [0, 0, 1]); P.fill(b * bw + bw * 0.08, 0, 3, S, 'rgba(0,0,0,0.25)', null); }
}

// horizontal ribbon glazing: a tinted glass band over a bright aluminium spandrel on every floor (Emirates Towers,
// Address Downtown)
function ribbons(P) {
  const { S, bw, fh, rows, bays, rnd } = P;
  const span = 0.34;
  for (let f = 0; f < rows; f++) {
    const y0 = f * fh;
    for (let b = 0; b < bays; b++) {
      const x0 = b * bw, tone = 0.86 + rnd() * 0.14;
      P.vgrad(x0, y0, bw, fh * (1 - span), g(1.0 * tone), g(0.64 * tone), [1, 1, 1]);
      if (rnd() < 0.35) P.streak(x0, y0, bw, fh * (1 - span), 0.16);
      if (rnd() < 0.12) P.fill(x0 + 3, y0 + fh * 0.08, bw - 6, fh * 0.3, g(0.97), [0.35, 0.85, 1]);
    }
    P.vgrad(0, y0 + fh * (1 - span), S, fh * span, g(0.98), g(0.82), [0, 0, 0.12]);
    P.fill(0, y0 + fh * (1 - span), S, 2, 'rgba(255,255,255,0.9)', null);
    P.fill(0, y0 + fh - 2, S, 2, 'rgba(0,0,0,0.2)', null);
  }
  for (let b = 0; b <= bays; b++) P.fill(b * bw - 1, 0, 2, S, '#c9d0d6', [0, 0, 0.1]);
}
// bold vertical fins over dark glass (the Address towers, Il Primo)
function finGlass(P) {
  const { S, bw, fh, rows, bays, rnd } = P;
  for (let f = 0; f < rows; f++) for (let b = 0; b < bays; b++) {
    const x0 = b * bw, y0 = f * fh, t = 0.85 + rnd() * 0.15;
    P.vgrad(x0, y0, bw, fh * 0.88, g(0.95 * t), g(0.58 * t), [1, 1, 1]);
    if (rnd() < 0.3) P.streak(x0, y0, bw, fh * 0.88, 0.14);
    if (rnd() < 0.12) P.fill(x0 + 5, y0 + fh * 0.1, bw - 10, fh * 0.35, g(0.97), [0.35, 0.85, 1]);
    P.fill(x0, y0 + fh * 0.88, bw, fh * 0.12, g(0.45), [0.6, 0, 1]);
  }
  for (let f = 0; f <= rows; f++) P.fill(0, f * fh - 1.5, S, 3, '#e6e9eb', [0, 0, 0.05]);
  for (let b = 0; b <= bays; b++) {
    P.fill(b * bw - 5, 0, 10, S, '#f3f3f0', [0, 0, 0]);
    P.fill(b * bw + 5, 0, 4, S, 'rgba(0,0,0,0.24)', null);
  }
}
// glass behind horizontal sun-shading louvres (Index Tower's long faces)
function louvres(P) {
  const { S, bw, fh, rows, bays, rnd } = P;
  for (let f = 0; f < rows; f++) for (let b = 0; b < bays; b++) {
    const x0 = b * bw, y0 = f * fh, t = 0.85 + rnd() * 0.15;
    P.vgrad(x0, y0, bw, fh * 0.86, g(0.9 * t), g(0.56 * t), [1, 1, 1]);
    if (rnd() < 0.12) P.fill(x0 + 3, y0 + fh * 0.1, bw - 6, fh * 0.4, g(0.97), [0.35, 0.85, 1]);
    P.fill(x0, y0 + fh * 0.86, bw, fh * 0.14, g(0.5), [0.5, 0, 1]);
  }
  for (let y = 0; y < S; y += 9) { P.fill(0, y, S, 3, '#eef0ee', [0, 0, 0]); P.fill(0, y + 3, S, 2, 'rgba(0,0,0,0.25)', null); }
  for (let b = 0; b <= bays; b++) P.fill(b * bw - 2, 0, 4, S, '#d9dcdc', [0, 0, 0]);
}
// tall pointed arches in a pale precast grid (the 1979 Dubai World Trade Centre tower)
function arches(P) {
  const { S, bw, fh, rows, bays } = P;
  P.fill(0, 0, S, S, g(0.96), [0, 0, 1]); P.noise(0, 0, S, S, 0.03, 2);
  for (let f = 0; f < rows; f++) for (let b = 0; b < bays; b++) {
    const x0 = b * bw + bw * 0.24, w = bw * 0.52, top = f * fh + fh * 0.16, h = fh * 0.76;
    P.shape((c) => { c.moveTo(x0, top + h); c.lineTo(x0, top + w * 0.55); c.quadraticCurveTo(x0, top + w * 0.05, x0 + w / 2, top - w * 0.12); c.quadraticCurveTo(x0 + w, top + w * 0.05, x0 + w, top + w * 0.55); c.lineTo(x0 + w, top + h); c.closePath(); }, rgb(0.3, 0.36, 0.42), [0.8, 1, 0]);
    P.fill(x0 - 2, top + h, w + 4, 3, 'rgba(0,0,0,0.25)', null);
  }
}

// a mall's stone elevation in one full-height tile: cornice, recessed carved panels, a string course and an arcade
// of tall arched shopfronts at street level (The Dubai Mall)
function mallStone(P) {
  const { S, bw, bays } = P;
  P.fill(0, 0, S, S, g(0.95), [0, 0, 1]); P.noise(0, 0, S, S, 0.035, 2);
  P.fill(0, 0, S, S * 0.07, g(1.0), [0, 0, 0.6]);
  P.fill(0, S * 0.07, S, 3, 'rgba(0,0,0,0.22)', null);
  for (let b = 0; b < bays; b++) {
    const x0 = b * bw;
    P.fill(x0 + bw * 0.14, S * 0.14, bw * 0.72, S * 0.38, g(0.87), [0, 0, 1]);
    P.fill(x0 + bw * 0.14, S * 0.14, bw * 0.72, 3, 'rgba(0,0,0,0.2)', null);
    for (let k = 0; k < 3; k++) P.fill(x0 + bw * 0.2 + k * bw * 0.22, S * 0.22, bw * 0.16, S * 0.2, rgb(0.42, 0.46, 0.5), [0.6, 1, 0]);
    const ax = x0 + bw * 0.16, aw = bw * 0.68, at = S * 0.6;
    P.shape((c) => { c.moveTo(ax, S); c.lineTo(ax, at + aw * 0.3); c.quadraticCurveTo(ax + aw / 2, at - aw * 0.22, ax + aw, at + aw * 0.3); c.lineTo(ax + aw, S); c.closePath(); }, rgb(0.28, 0.34, 0.4), [0.85, 1, 0]);
    P.fill(ax + aw / 2 - 2, at + aw * 0.08, 4, S, '#d9d2c4', [0, 0, 0]);
    P.fill(ax, S * 0.86, aw, 3, '#d9d2c4', [0, 0, 0]);
  }
  P.fill(0, S * 0.555, S, S * 0.03, g(0.8), [0, 0, 1]);
  for (let b = 0; b <= bays; b++) { P.fill(b * bw - 5, S * 0.07, 10, S, g(1.0), [0, 0, 1]); P.fill(b * bw + 5, S * 0.07, 3, S, 'rgba(0,0,0,0.16)', null); }
}

// ---------------------------------------------------------------- roofs (tile sizes in metres)
function roofConcrete(P) {
  const { S, rnd } = P;
  const n = 8, t = S / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P.fill(i * t, j * t, t, t, g(0.84 + rnd() * 0.1), [0, 0, 1]);
  for (let i = 0; i <= n; i++) { P.fill(i * t - 1, 0, 2, S, 'rgba(0,0,0,0.12)', null); P.fill(0, i * t - 1, S, 2, 'rgba(0,0,0,0.12)', null); }
  for (let k = 0; k < 6; k++) { const r = 10 + rnd() * 30; const gr = P.gc.createRadialGradient(0, 0, 0, 0, 0, r); gr.addColorStop(0, 'rgba(60,50,40,0.12)'); gr.addColorStop(1, 'rgba(60,50,40,0)'); P.gc.save(); P.gc.translate(rnd() * S, rnd() * S); P.gc.fillStyle = gr; P.gc.fillRect(-r, -r, 2 * r, 2 * r); P.gc.restore(); }
}
function roofTiles(P) {
  const { S, rnd } = P;
  const rowsN = 12, colsN = 16, rh = S / rowsN, cw = S / colsN;
  for (let r = 0; r < rowsN; r++) for (let c = 0; c < colsN; c++) {
    const x = c * cw + (r % 2) * cw * 0.5, y = r * rh, v = 0.86 + rnd() * 0.12;
    const gr = P.gc.createLinearGradient(x, 0, x + cw, 0);
    gr.addColorStop(0, g(v * 0.72)); gr.addColorStop(0.45, g(v)); gr.addColorStop(1, g(v * 0.7));
    P.gc.fillStyle = gr; P.gc.fillRect(x, y, cw, rh); P.gc.fillRect(x - S, y, cw, rh);
  }
  P.gm.fillStyle = 'rgb(0,0,255)'; P.gm.fillRect(0, 0, S, S);
  for (let r = 0; r <= rowsN; r++) P.fill(0, r * rh - 1.5, S, 3, 'rgba(0,0,0,0.28)', null);
}
function roofDeck(P) {
  const { S, rnd } = P;
  const n = 12, t = S / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P.fill(i * t, j * t, t, t, g(0.82 + rnd() * 0.14), [0, 0, 1]);
  for (let i = 0; i <= n; i++) { P.fill(i * t - 1, 0, 2, S, 'rgba(0,0,0,0.2)', null); P.fill(0, i * t - 1, S, 2, 'rgba(0,0,0,0.2)', null); }
}
function roofMetal(P) {
  const { S } = P;
  for (let x = 0; x < S; x += 8) { P.fill(x, 0, 4, S, g(0.97), [0, 0, 1]); P.fill(x + 4, 0, 4, S, g(0.86), [0, 0, 1]); }
  for (let y = 0; y < S; y += 64) P.fill(0, y, S, 2, 'rgba(0,0,0,0.12)', null);
}
function roofPodium(P) {
  const { S, rnd } = P;
  const n = 16, t = S / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P.fill(i * t, j * t, t, t, rgb(0.86 + rnd() * 0.06, 0.82 + rnd() * 0.05, 0.74 + rnd() * 0.05), [0, 0, 0.35]);
  for (let i = 0; i <= n; i++) { P.fill(i * t - 0.5, 0, 1, S, 'rgba(0,0,0,0.1)', null); P.fill(0, i * t - 0.5, S, 1, 'rgba(0,0,0,0.1)', null); }
  // a few round planters (lawns are added procedurally in the shader so they don't repeat)
  for (let k = 0; k < 5; k++) { const x = rnd() * S, y = rnd() * S, rr = 4 + rnd() * 5; P.shape((c) => c.arc(x, y, rr, 0, Math.PI * 2), rgb(0.62, 0.58, 0.5), [0, 0, 0]); P.shape((c) => c.arc(x, y, rr - 1.5, 0, Math.PI * 2), rgb(0.24, 0.45, 0.2), [0, 0, 0]); }
}

// tileW / tileH in metres for roofs; walls use bays & rows (floors) per tile
export const LAYERS = [
  { key: 'curtainA', tileW: 6.4, bays: 4, rows: 2, refl: 1.0, paint: (P) => curtain(P, {}) },
  { key: 'curtainB', tileW: 6.8, bays: 4, rows: 2, refl: 1.0, paint: (P) => curtain(P, { fins: true }) },
  { key: 'curtainC', tileW: 6.4, bays: 4, rows: 2, refl: 0.9, paint: (P) => curtain(P, { spandrel: 0.36 }) },
  { key: 'balconyA', tileW: 12, bays: 4, rows: 2, refl: 0.65, paint: (P) => balconies(P, false) },
  { key: 'balconyB', tileW: 12, bays: 4, rows: 2, refl: 0.65, paint: (P) => balconies(P, true) },
  { key: 'punched', tileW: 10, bays: 4, rows: 2, refl: 0.5, paint: punched },
  { key: 'jbr', tileW: 12, bays: 4, rows: 2, refl: 0.45, paint: jbr },
  { key: 'stoneGlass', tileW: 9, bays: 3, rows: 2, refl: 0.8, paint: stoneGlass },
  { key: 'office', tileW: 8, bays: 4, rows: 2, refl: 0.8, paint: officeBand },
  { key: 'villa', tileW: 9, bays: 3, rows: 1, refl: 0.4, paint: villa },
  { key: 'townhouse', tileW: 7, bays: 2, rows: 1, refl: 0.45, paint: townhouse },
  { key: 'industrial', tileW: 8, bays: 4, rows: 1, refl: 0.2, paint: industrial },
  { key: 'podium', tileW: 8, bays: 2, rows: 1, refl: 0.3, paint: podium },
  { key: 'construction', tileW: 8, bays: 2, rows: 2, refl: 0, paint: construction },
  { key: 'roofConcrete', tileW: 8, tileH: 8, bays: 8, rows: 8, refl: 0, paint: roofConcrete },
  { key: 'roofTiles', tileW: 3.6, tileH: 3.6, bays: 16, rows: 12, refl: 0, paint: roofTiles },
  { key: 'roofDeck', tileW: 7, tileH: 7, bays: 12, rows: 12, refl: 0, paint: roofDeck },
  { key: 'roofMetal', tileW: 6, tileH: 6, bays: 8, rows: 4, refl: 0.3, paint: roofMetal },
  { key: 'roofPodium', tileW: 22, tileH: 22, bays: 16, rows: 16, refl: 0, paint: roofPodium },
  { key: 'frame', tileW: 9, bays: 3, rows: 2, refl: 0.85, paint: frame },
  { key: 'ribbon', tileW: 7.2, bays: 4, rows: 2, refl: 1.0, paint: ribbons },
  { key: 'finGlass', tileW: 9, bays: 3, rows: 2, refl: 1.0, paint: finGlass },
  { key: 'louvre', tileW: 6, bays: 2, rows: 2, refl: 0.75, paint: louvres },
  { key: 'arches', tileW: 6, bays: 3, rows: 2, refl: 0.4, paint: arches },
  { key: 'mallStone', tileW: 15, bays: 2, rows: 1, refl: 0.35, paint: mallStone },
];
export const L = Object.fromEntries(LAYERS.map((l, i) => [l.key, i]));

export function createFacadeTextures(renderer) {
  const N = LAYERS.length;
  const color = new Uint8Array(S * S * 4 * N), mask = new Uint8Array(S * S * 4 * N);
  const cc = document.createElement('canvas'); cc.width = cc.height = S;
  const mc = document.createElement('canvas'); mc.width = mc.height = S;
  const gc = cc.getContext('2d', { willReadFrequently: true }), gm = mc.getContext('2d', { willReadFrequently: true });
  LAYERS.forEach((layer, li) => {
    gc.globalAlpha = 1; gm.globalAlpha = 1;
    gc.fillStyle = '#ffffff'; gc.fillRect(0, 0, S, S);
    gm.fillStyle = 'rgb(0,0,0)'; gm.fillRect(0, 0, S, S);
    const P = painter(gc, gm, layer, rng(1000 + li * 17));
    P.gm = gm;
    layer.paint(P);
    const cd = gc.getImageData(0, 0, S, S).data, md = gm.getImageData(0, 0, S, S).data;
    const base = li * S * S * 4;
    for (let y = 0; y < S; y++) {
      const src = (S - 1 - y) * S * 4, dst = base + y * S * 4; // flip: texture v = 0 at the tile bottom
      for (let x = 0; x < S * 4; x += 4) {
        color[dst + x] = cd[src + x]; color[dst + x + 1] = cd[src + x + 1]; color[dst + x + 2] = cd[src + x + 2];
        color[dst + x + 3] = md[src + x];          // glass
        mask[dst + x] = md[src + x + 1];           // lit-able
        mask[dst + x + 1] = md[src + x + 2];       // tint weight
        mask[dst + x + 2] = 0; mask[dst + x + 3] = 255;
      }
    }
  });
  const mk = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, S, S, N);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const info = LAYERS.map((l) => new THREE.Vector4(l.tileW, l.bays, l.rows, l.refl));
  return { color: mk(color, true), mask: mk(mask, false), info, count: N };
}
