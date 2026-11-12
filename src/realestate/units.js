// Procedural floor plates: splits a building footprint into apartment units.
// Tower plates -> radial units around a central core; slab blocks -> double-loaded corridor.
import { signedArea, centroid, pointInRing, rng } from '../core/util.js';

const SQFT = 10.7639;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// keep the side where dot(p - o, n) >= 0
function clipHalf(poly, o, n) {
  const out = [];
  const f = (p) => (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
const area = (r) => Math.abs(signedArea(r));
const perimeter = (r) => r.reduce((s, p, i) => s + Math.hypot(r[(i + 1) % r.length][0] - p[0], r[(i + 1) % r.length][1] - p[1]), 0);

function orientedBox(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], v = [-u[1], u[0]];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) { const pu = p[0] * u[0] + p[1] * u[1], pv = p[0] * v[0] + p[1] * v[1]; u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv); }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, u, v, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { u, v, u0, u1, v0, v1 } = best;
  if (v1 - v0 > u1 - u0) { [u, v] = [v, [-u[0], -u[1]]]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { u, v, len: u1 - u0, wid: v1 - v0, center: [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv] };
}

function interiorPoint(ring) {
  const c = centroid(ring);
  if (pointInRing(c, ring)) return c;
  // fallback: best of a coarse grid
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  let best = ring[0], bd = -1;
  for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
    const p = [x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * j) / 12];
    if (!pointInRing(p, ring)) continue;
    let d = Infinity;
    for (let k = 0; k < ring.length; k++) { const a = ring[k], b = ring[(k + 1) % ring.length]; d = Math.min(d, segDist(p, a, b)); }
    if (d > bd) { bd = d; best = p; }
  }
  return best;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

// exterior facade of a unit: longest edge of the unit polygon that lies on the plate outline
function facadeOf(poly, outer) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1.2) continue;
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let d = Infinity;
    for (let k = 0; k < outer.length; k++) d = Math.min(d, segDist(m, outer[k], outer[(k + 1) % outer.length]));
    if (d > 0.8) continue;
    if (!best || L > best.len) {
      // outward normal: polygon is CCW -> right-hand normal
      const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L;
      best = { a, b, mid: m, len: L, normal: [nx, ny] };
    }
  }
  return best;
}

const ensureCCW = (r) => (signedArea(r) < 0 ? r.slice().reverse() : r);

export function floorLayout(plate, info, floor, floors) {
  const outer = ensureCCW(plate[0]);
  const A = area(outer);
  const obb = orientedBox(outer);
  const r = rng((info.index + 1) * 7919 + floor * 104729);
  const penthouse = floor >= floors - 2 && floors > 12;
  const units = [];
  let core = null, corridor = null;

  if (obb && obb.len / Math.max(1, obb.wid) > 2.1 && obb.wid > 13 && A > 400) {
    // ---- slab block: double-loaded corridor along the long axis
    const { u, v, center: c, len } = obb;
    const half = 1.15;
    const sides = [clipHalf(outer, [c[0] + v[0] * half, c[1] + v[1] * half], v), clipHalf(outer, [c[0] - v[0] * half, c[1] - v[1] * half], [-v[0], -v[1]])];
    const M = Math.max(2, Math.min(12, Math.round(len / (penthouse ? 16 : 9.5))));
    for (const side of sides) {
      if (side.length < 3) continue;
      for (let k = 0; k < M; k++) {
        const t0 = -len / 2 + (len * k) / M, t1 = -len / 2 + (len * (k + 1)) / M;
        let p = clipHalf(side, [c[0] + u[0] * t0, c[1] + u[1] * t0], u);
        p = clipHalf(p, [c[0] + u[0] * t1, c[1] + u[1] * t1], [-u[0], -u[1]]);
        if (p.length >= 3 && area(p) > 22) units.push(ensureCCW(p));
      }
    }
    const cw = 7, cl = Math.min(10, len * 0.18);
    core = [[-cl / 2, -cw / 2], [cl / 2, -cw / 2], [cl / 2, cw / 2], [-cl / 2, cw / 2]].map(([a, b]) => [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b]);
    corridor = [[-len / 2, -half], [len / 2, -half], [len / 2, half], [-len / 2, half]].map(([a, b]) => [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b]);
  } else {
    // ---- tower: radial units around a core
    const c = interiorPoint(outer);
    let N = Math.max(2, Math.min(12, Math.round(A / 110)));
    if (A < 260) N = Math.max(2, Math.min(4, Math.round(A / 70)));
    if (penthouse) N = Math.max(2, Math.round(N / 2.5));
    const P = perimeter(outer);
    // start at the beginning of the longest edge so cuts land on corners more often
    let start = 0, bestL = 0, acc = 0, s0 = 0;
    for (let i = 0; i < outer.length; i++) { const L = Math.hypot(outer[(i + 1) % outer.length][0] - outer[i][0], outer[(i + 1) % outer.length][1] - outer[i][1]); if (L > bestL) { bestL = L; start = i; s0 = acc; } acc += L; }
    void start;
    // walk the perimeter collecting cut points
    const cum = [0]; for (let i = 0; i < outer.length; i++) cum.push(cum[i] + Math.hypot(outer[(i + 1) % outer.length][0] - outer[i][0], outer[(i + 1) % outer.length][1] - outer[i][1]));
    const at = (s) => {
      s = ((s % P) + P) % P;
      let i = 0; while (i < outer.length - 1 && cum[i + 1] < s) i++;
      const a = outer[i], b = outer[(i + 1) % outer.length], t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], i };
    };
    for (let k = 0; k < N; k++) {
      const sa = s0 + (P * k) / N, sb = s0 + (P * (k + 1)) / N;
      const pa = at(sa), pb = at(sb);
      const poly = [c, pa.p];
      // vertices strictly between sa and sb along the perimeter
      let s = sa;
      for (let guard = 0; guard < outer.length + 2; guard++) {
        const idx = (pa.i + 1 + guard) % outer.length;
        let vs = cum[idx]; while (vs <= s - 1e-6) vs += P;
        if (vs >= sb - 1e-6) break;
        poly.push(outer[idx]); s = vs;
      }
      poly.push(pb.p);
      if (area(poly) > 8) units.push(ensureCCW(poly));
    }
    const rc = Math.max(3.2, Math.min(8, Math.sqrt(A) * 0.15));
    core = Array.from({ length: 8 }, (_, i) => [c[0] + Math.cos((i / 8) * Math.PI * 2 + Math.PI / 8) * rc, c[1] + Math.sin((i / 8) * Math.PI * 2 + Math.PI / 8) * rc]);
  }

  const coreShare = core ? area(core) / Math.max(1, units.length) : 0;
  const out = units.map((poly, k) => {
    const m2 = Math.max(18, area(poly) - (corridor ? 0 : coreShare) - perimeter(poly) * 0.12);
    const sqft = m2 * SQFT;
    const beds = penthouse && m2 > 160 ? 'Penthouse' : m2 < 48 ? 'Studio' : m2 < 82 ? '1 Bedroom' : m2 < 128 ? '2 Bedroom' : m2 < 185 ? '3 Bedroom' : '4 Bedroom';
    const fac = facadeOf(poly, outer);
    const facing = fac ? COMPASS[Math.round(((Math.atan2(fac.normal[0], fac.normal[1]) * 180) / Math.PI + 360) % 360 / 45) % 8] : '—';
    const x = r();
    const status = x < 0.42 ? 'sold' : x < 0.56 ? 'reserved' : 'available';
    return {
      id: `${info.index}-${floor}-${k}`, k, floor,
      number: `${floor}${String(k + 1).padStart(2, '0')}`,
      poly, centroid: centroid(poly), m2, sqft, beds, facade: fac, facing, status,
      priceSeed: r(),
    };
  });
  return { units: out, core, corridor, plate: outer };
}

// Indicative pricing: area x AED/sqft with floor, height and view premiums
export function priceUnit(u, info, floors, view) {
  let psf = 1450 + 420 * Math.min(1, info.height / 300) + (info.year && info.year >= 2018 ? 250 : 0);
  psf *= 1 + 0.003 * u.floor;
  if (u.beds === 'Penthouse') psf *= 1.25;
  if (view) psf *= 1 + 0.2 * view.sea + 0.09 * view.marina + 0.07 * view.golf + 0.05 * view.lake - 0.12 * view.blocked + (view.landmarks.length ? 0.03 : 0);
  psf *= 0.93 + 0.14 * u.priceSeed;
  const price = Math.round((psf * u.sqft) / 5000) * 5000;
  return { price, psf: Math.round(price / u.sqft) };
}
