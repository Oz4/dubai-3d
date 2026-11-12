// Hand-modelled signature buildings. Each builder receives the modelling toolkit (T) and the building
// context (B) and writes its own geometry into the shared building mesh (so selection, filters and
// floor exploration keep working). Shapes follow published descriptions (CTBUH / Wikipedia / architects).
import * as THREE from 'three';

const C = (h) => new THREE.Color(h);
const WHITE = C('#f3f2ee');

// regular n-gon fitted to an area, oriented along angle a0
function polygonByArea(c, area, n, a0 = 0) {
  const R = Math.sqrt((2 * area) / (n * Math.sin((2 * Math.PI) / n)));
  return Array.from({ length: n }, (_, k) => [c[0] + Math.cos(a0 + (k / n) * Math.PI * 2) * R, c[1] + Math.sin(a0 + (k / n) * Math.PI * 2) * R]);
}
function chamfer(ring, f = 0.22) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
    out.push([p[0] + (a[0] - p[0]) * f, p[1] + (a[1] - p[1]) * f], [p[0] + (b[0] - p[0]) * f, p[1] + (b[1] - p[1]) * f]);
  }
  return out;
}
function ellipse(c, a, b, ang, n = 40) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return Array.from({ length: n }, (_, k) => { const t = (k / n) * Math.PI * 2, x = Math.cos(t) * a, y = Math.sin(t) * b; return [c[0] + x * ca - y * sa, c[1] + x * sa + y * ca]; });
}
// Burj Khalifa's mechanical floors (levels 17-18, 40-42, 73-75, 109-111, 136-138 and 155), in metres
const MECH_FLOORS = [[70, 77], [160, 171], [289, 299], [423, 434], [527, 537], [584, 590]];
const angleOf = (T, ring) => { const ob = T.orientedBox(ring); return ob ? Math.atan2(ob.u[1], ob.u[0]) : 0; };
const largestPart = (T, b) => b.parts.slice().sort((p, q) => Math.abs(T.signedArea(q.p[0])) - Math.abs(T.signedArea(p.p[0])))[0];
const shaftO = (B, wall, top, extra = {}) => ({ ...B.o, wall: C(wall), base: 0, top, ...extra });
// keep the part of a ring on the positive side of a line through c with normal n (Sutherland-Hodgman)
function clipHalf(ring, c, n) {
  const out = [], d = (p) => (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], da = d(a), db = d(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out.length >= 3 ? out : null;
}
// slice of a footprint between two offsets a0 < a1 along the unit axis u from c
function slab(ring, c, u, a0, a1) {
  let r = clipHalf(ring, [c[0] + u[0] * a0, c[1] + u[1] * a0], u);
  if (r) r = clipHalf(r, [c[0] + u[0] * a1, c[1] + u[1] * a1], [-u[0], -u[1]]);
  return r;
}
// converging ribs from a ring of corners to a point above (23 Marina / Elite Residence crowns)
function ribs(T, o, ring, y0, apexC, y1, w, color, inset = 0.12) {
  for (const p of ring) T.beam([p[0], p[1], y0], [apexC[0] + (p[0] - apexC[0]) * inset, apexC[1] + (p[1] - apexC[1]) * inset, y1], w, o, color, T.codes.SOLID);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const norm = (a) => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// the three corners of a (near-)triangular outline: the vertex triple enclosing the largest area
function triCorners(ring) {
  let best = null, A = -1;
  for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) for (let k = j + 1; k < ring.length; k++) {
    const a = ring[i], b = ring[j], c = ring[k];
    const s = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    if (s > A) { A = s; best = [a, b, c]; }
  }
  return best;
}
// setbacks: each [height, scale] tier rises from the terrace left on top of the one below
function setbacks(T, o, ring, c, y, list, code, color, terrace) {
  let prev = ring;
  for (const [h, s] of list) {
    const r = T.scaleRing(ring, c, s);
    T.cap([prev], y, o, T.codes.ROOF + T.L.roofConcrete, terrace);
    T.walls(r, y, y + h, o, code, { color });
    prev = r; y += h;
  }
  return { ring: prev, y };
}
// a stone podium under a tower: landscaped deck, and a pool placed on the deck as far from the tower as fits
function podiumDeck(T, B, ring, h, { tower, pool = true, wall = '#e6dfd2', poolSize = [15, 6] } = {}) {
  const pc = T.centroid(ring);
  const o = { ...B.o, base: 0, top: h, fh: h / Math.max(1, Math.round(h / 4.5)), center: pc };
  T.walls(ring, 0, h, o, T.L.podium, { color: C(wall) });
  const inner = T.parapetRoof(ring, h, 1.1, o, T.codes.ROOF + T.L.roofPodium, C('#d8cfbf'), C('#efe9de'));
  if (!pool || !tower) return inner;
  const tc = T.centroid(tower);
  const far = inner.reduce((m, p) => (dist(p, tc) > dist(m, tc) ? p : m), inner[0]);
  const ang = Math.atan2(far[1] - tc[1], far[0] - tc[0]) + Math.PI / 2;
  for (let k = 1; k <= 16; k++) {
    const q = lerp2(far, tc, k / 18);
    const pool = ellipse(q, poolSize[0], poolSize[1], ang, 24);
    if (pool.every((p) => T.pointInRing(p, inner) && !T.pointInRing(p, tower))) {
      T.cap([T.ccw(ellipse(q, poolSize[0] + 2.2, poolSize[1] + 2.2, ang, 24))], h + 0.06, o, T.codes.SOLID, C('#f1ede4'));
      T.cap([T.ccw(pool)], h + 0.14, o, T.codes.POOL, C('#3fcde0'));
      break;
    }
  }
  return inner;
}
// a disc standing on a wall face (clock faces): centre m (east, north), outward normal n, height y, radius r
function wallDisc(T, o, m, n, y, r, color, code) {
  const t = [-n[1], n[0]];
  T.surface((u, v) => {
    const a = u * Math.PI * 2, rr = r * (0.16 + 0.84 * v);
    return [m[0] + n[0] * 0.35 + t[0] * Math.cos(a) * rr, m[1] + n[1] * 0.35 + t[1] * Math.cos(a) * rr, y + Math.sin(a) * rr];
  }, 28, 1, o, color, code, { flip: true });
}
// Emirates Towers (2000): two triangular towers on a shared podium. Two faces of each are ribbon-glazed in pale
// silver-blue glass between aluminium bands and the third is solid aluminium; each top is cut by a steep plane rising
// to a peak at the corner facing the twin tower, which carries a pair of needles.
function emiratesTower(T, B, { toward, baseH, roofLow, peak, spire }) {
  const tri = triCorners(T.ccw(B.outer[0])); if (!tri) return false;
  const c = T.centroid(tri);
  let pi = 0; for (let i = 1; i < 3; i++) if (dot(sub(tri[i], c), toward) > dot(sub(tri[pi], c), toward)) pi = i;
  const P = tri[pi], Q = tri[(pi + 1) % 3], R = tri[(pi + 2) % 3];
  const M = lerp2(Q, R, 0.5), alt = dist(P, M), dir = norm(sub(P, M));
  const glass = C('#a9c2d0'), alu = C('#dfe3e6');
  const o = shaftO(B, '#a9c2d0', spire, { center: c, fh: 4.4 });
  const ring = T.ccw([P, Q, R]);
  const back = (a, b) => a !== P && b !== P;
  T.slantTop(ring, baseH, { c: M, dir, y0: roofLow, slope: (peak - roofLow) / alt }, { ...o, base: baseH }, T.L.ribbon, T.codes.SOLID, C('#d3dade'),
    { codeFor: (a, b) => (back(a, b) ? T.codes.ALU : T.L.ribbon), colorFor: (a, b) => (back(a, b) ? alu : glass) });
  if (baseH > 0.5) {
    // the triangle overhangs a glazed drum lobby; the aluminium back wall runs down to the ground
    T.cap([ring], baseH, o, T.codes.SOLID, alu.clone().multiplyScalar(0.85), true);
    const drum = (B.b.parts || []).find((p) => (p.mh || 0) < 1 && p.h <= baseH + 1 && p.p[0].length >= 12);
    const a = dist(Q, R), b = dist(R, P), cc = dist(P, Q);
    const inc = [(a * P[0] + b * Q[0] + cc * R[0]) / (a + b + cc), (a * P[1] + b * Q[1] + cc * R[1]) / (a + b + cc)];
    const inR = (2 * Math.abs(T.signedArea(ring))) / (a + b + cc);
    const dc = drum ? T.centroid(drum.p[0]) : inc, dr = drum ? Math.sqrt(Math.abs(T.signedArea(drum.p[0])) / Math.PI) : inR * 0.86;
    T.cone(dc, dr, dr, 0, baseH, { ...o, base: 0, top: baseH }, C('#7fb1ba'), T.codes.GLASSY, { segs: 32, cap: false });
    const t = Math.min(0.3, 8 / alt);
    T.prism(T.ccw([Q, R, lerp2(R, P, t), lerp2(Q, P, t)]), 0, baseH, { ...o, base: 0 }, T.codes.ALU, alu);
  }
  const side = [-dir[1], dir[0]];
  for (const s of [-1, 1]) {
    const q = [P[0] - dir[0] * 3.2 + side[0] * s * 1.5, P[1] - dir[1] * 3.2 + side[1] * s * 1.5];
    T.cone(q, 0.65, 0.06, peak - 6, s > 0 ? spire : spire - 9, o, alu, T.codes.METAL, { segs: 8 });
  }
  B.plate = [ring]; B.plateBase = baseH; B.plateTop = roofLow;
  return true;
}
// distance from p to the nearest edge of a ring
function edgeDist(p, ring) {
  let m = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    m = Math.min(m, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
  }
  return m;
}
// the stretches of the line o0 + dir * t (0..L) that lie inside a ring, at least `margin` from its edges
function insideRuns(T, ring, o0, dir, L, step, margin) {
  const out = []; let cur = null;
  for (let t = 0; t <= L; t += step) {
    const p = [o0[0] + dir[0] * t, o0[1] + dir[1] * t];
    if (T.pointInRing(p, ring) && edgeDist(p, ring) > margin) { if (!cur) cur = [t, t]; else cur[1] = t; } else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}
// a glazed barrel vault on a roof from A to B (radius r, rise h) with half-round gable ends
function vault(T, o, A, Bp, y, r, h, color) {
  const d = norm(sub(Bp, A)), n = [-d[1], d[0]], L = dist(A, Bp);
  T.surface((u, v) => { const a = Math.PI * v; return [A[0] + d[0] * L * u + n[0] * r * Math.cos(a), A[1] + d[1] * L * u + n[1] * r * Math.cos(a), y + h * Math.sin(a)]; },
    Math.max(2, Math.round(L / 8)), 8, o, color, T.codes.SKY, { flip: true, uLen: L, vLen: Math.PI * r });
  for (const [P0, flip] of [[A, false], [Bp, true]]) {
    T.surface((u, v) => { const a = Math.PI * u, k = 0.06 + 0.94 * v; return [P0[0] + n[0] * r * Math.cos(a) * k, P0[1] + n[1] * r * Math.cos(a) * k, y + h * Math.sin(a) * k]; },
      8, 1, o, color, T.codes.SKY, { flip, uLen: Math.PI * r, vLen: r });
  }
}
// a barrel roof of any finish from A to B (half-width r, rise h): the curved shell and its two end walls
function barrel(T, o, A, Bp, y, r, h, color, code, ends = true) {
  const d = norm(sub(Bp, A)), n = [-d[1], d[0]], L = dist(A, Bp);
  T.surface((u, v) => { const a = Math.PI * v; return [A[0] + d[0] * L * u + n[0] * r * Math.cos(a), A[1] + d[1] * L * u + n[1] * r * Math.cos(a), y + h * Math.sin(a)]; },
    Math.max(2, Math.round(L / 8)), 10, o, color, code, { flip: true, uLen: L, vLen: Math.PI * r });
  if (ends) for (const [P0, flip] of [[A, false], [Bp, true]]) {
    T.surface((u, v) => { const a = Math.PI * u, k = 0.06 + 0.94 * v; return [P0[0] + n[0] * r * Math.cos(a) * k, P0[1] + n[1] * r * Math.cos(a) * k, y + h * Math.sin(a) * k]; },
      10, 1, o, color, code, { flip, uLen: Math.PI * r, vLen: r });
  }
}
// points along a quadratic curve from p0 to p2 bent toward p1
const bend = (p0, p1, p2, n = 8) => Array.from({ length: n + 1 }, (_, k) => { const t = k / n; return [(1 - t) * (1 - t) * p0[0] + 2 * t * (1 - t) * p1[0] + t * t * p2[0], (1 - t) * (1 - t) * p0[1] + 2 * t * (1 - t) * p1[1] + t * t * p2[1]]; });
// a ribbed glazed vault swept along a curved line of points (half-width r, rise h), closed by gable ends
function sweptVault(T, o, pts, y, r, h, color, code) {
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const L = cum[cum.length - 1]; if (L < 2) return;
  const frame = (u) => {
    const sLen = Math.max(0, Math.min(1, u)) * L; let i = 1; while (i < pts.length - 1 && cum[i] < sLen) i++;
    const t = (sLen - cum[i - 1]) / (cum[i] - cum[i - 1] || 1), P = lerp2(pts[i - 1], pts[i], t);
    const d0 = norm(sub(pts[i], pts[i - 1])), dPrev = i > 1 ? norm(sub(pts[i - 1], pts[i - 2])) : d0, dNext = i < pts.length - 1 ? norm(sub(pts[i + 1], pts[i])) : d0;
    const d = norm(t < 0.5 ? lerp2(lerp2(dPrev, d0, 0.5), d0, t * 2) : lerp2(d0, lerp2(d0, dNext, 0.5), t * 2 - 1));
    return { P, n: [-d[1], d[0]] };
  };
  T.surface((u, v) => { const f = frame(u), a = Math.PI * v; return [f.P[0] + f.n[0] * r * Math.cos(a), f.P[1] + f.n[1] * r * Math.cos(a), y + h * Math.sin(a)]; },
    Math.max(3, Math.round(L / 6)), 8, o, color, code, { flip: true, uLen: L, vLen: Math.PI * r });
  for (const [u0, flip] of [[0, false], [1, true]]) {
    const f = frame(u0);
    T.surface((u, v) => { const a = Math.PI * u, k = 0.06 + 0.94 * v; return [f.P[0] + f.n[0] * r * Math.cos(a) * k, f.P[1] + f.n[1] * r * Math.cos(a) * k, y + h * Math.sin(a) * k]; },
      8, 1, o, color, code, { flip, uLen: Math.PI * r, vLen: r });
  }
}
function starRing(c, r0, r1, n, a0 = 0) {
  return Array.from({ length: n * 2 }, (_, k) => { const r = k % 2 ? r1 : r0, a = a0 + (k / (n * 2)) * Math.PI * 2; return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]; });
}
// Arabian-style low-rise (Souk Al Bahar, the Palace, the Old Town): sand-coloured walls with arched windows, a
// parapet, a terracotta-brown roof deck and wind towers (barjeel); optional domed corner pavilions
function arabesque(T, B, { wall = '#dcc29c', roof = '#cbb591', towers = 3, pavilions = false } = {}) {
  const ring = T.ccw(B.outer[0]), holes = B.outer.slice(1), H = B.b.h, y0 = B.b.mh || 0;
  const wc = C(wall), rc = C(roof), cap = C('#8a6248');
  const o = shaftO(B, wall, H + 9, { fh: 4.2 });
  o.base = y0;
  T.walls(ring, y0, H, o, T.L.villa, { color: wc });
  if (y0 > 0.5) T.cap([ring], y0, o, T.codes.SOLID, wc, true);
  let inner;
  if (holes.length) {
    // courtyards (the souk's palm courts): the block is a ring of wings round them
    for (const h of holes) { T.walls(h, y0, H + 1.2, o, T.L.villa, { color: wc }); }
    T.walls(ring, H, H + 1.2, o, T.codes.SOLID, { color: wc.clone().multiplyScalar(1.04) });
    T.cap([ring, ...holes], H + 0.02, o, T.codes.ROOF + T.L.roofDeck, rc);
    inner = T.insetRing(ring, 0.8);
  } else inner = T.parapetRoof(ring, H, 1.3, o, T.codes.ROOF + T.L.roofDeck, rc, wc.clone().multiplyScalar(1.04));
  const onRoof = (q) => T.pointInRing(q, inner) && !holes.some((h) => T.pointInRing(q, h) || edgeDist(q, h) < 2.5);
  // a low pyramid of brown tiles on a square
  const pyramid = (sq, ya, yb) => { const c = T.centroid(sq); for (let k = 0; k < sq.length; k++) { const a = sq[k], b = sq[(k + 1) % sq.length]; T.quad([a[0], a[1], ya], [b[0], b[1], ya], [c[0], c[1], yb], [c[0], c[1], yb], o, cap, T.codes.SOLID); } };
  const xs = inner.map((p) => p[0]), ys = inner.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), yA = Math.min(...ys), yB = Math.max(...ys);
  const ang = angleOf(T, ring), r = B.r;
  let n = 0;
  for (let k = 0; k < 120 && n < towers; k++) {
    const p = [x0 + r() * (x1 - x0), yA + r() * (yB - yA)];
    const sq = T.ccw(T.rectRing(p[0], p[1], 3.6, 3.6, ang));
    if (!sq.every(onRoof)) continue;
    T.prism(sq, H, H + 6.5, { ...o, base: H }, T.codes.SOLID, wc, T.codes.SOLID, wc);
    T.walls(T.ccw(T.rectRing(p[0], p[1], 3.7, 3.7, ang)), H + 3.6, H + 5.6, { ...o, base: H }, T.codes.SOLID, { color: C('#5a4636') }); // the slatted vents
    pyramid(T.ccw(T.rectRing(p[0], p[1], 4.6, 4.6, ang)), H + 6.5, H + 8.6);
    n++;
  }
  // a few broad pyramid roofs over the larger halls
  for (let k = 0, m = 0; k < 80 && m < Math.ceil(towers / 2); k++) {
    const p = [x0 + r() * (x1 - x0), yA + r() * (yB - yA)], w = 9 + r() * 5;
    const sq = T.ccw(T.rectRing(p[0], p[1], w, w, ang));
    if (!sq.every(onRoof)) continue;
    T.prism(sq, H, H + 1.6, { ...o, base: H }, T.codes.SOLID, wc); pyramid(sq, H + 1.6, H + 1.6 + w * 0.3); m++;
  }
  if (pavilions) {
    const ob = T.orientedBox(inner);
    if (ob) for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [ob.c[0] + ob.u[0] * sx * (ob.len / 2 - 5) + ob.v[0] * sy * (ob.wid / 2 - 5), ob.c[1] + ob.u[1] * sx * (ob.len / 2 - 5) + ob.v[1] * sy * (ob.wid / 2 - 5)];
      const sq = T.ccw(T.rectRing(p[0], p[1], 7, 7, ang));
      if (!sq.every(onRoof)) continue;
      T.prism(sq, H, H + 7, { ...o, base: H }, T.L.villa, wc, T.codes.SOLID, wc);
      T.dome(p, 3.1, 3.1, H + 7, 3.4, o, C('#e8d8b8'), T.codes.GLOW, { segs: 16, rings: 6 });
    }
  }
  return inner;
}

// ---------------------------------------------------------------- shopping malls
// A mall on its OSM outline, described by a short specification taken from the research
// (data-raw/research/malls): wall and roof colours, height, and what stands on the roof and at the doors. Positions
// are given in the outline's own axes as fractions: a from -1 to 1 along its length (toward S.axis, a rough compass
// direction as [east, north]), b from -1 to 1 across it (to the left of that direction). They are arranged from
// photographs and site maps, not measured; OSM gives only the outline.
//   vaults  [a0, b0, a1, b1, halfWidth, rise, kind]   glazed barrel vaults (kind 'metal' for a solid one)
//   domes   [a, b, radius, rise, colour, kind]         kind 'glass' (lit at night), 'gold', 'solid'
//   blocks  [a0, a1, b0, b1, height, colour, roof]     parts that rise above (or sit lower than) the main roof
//   decks   [a0, a1, b0, b1]                           rooftop car parks: dark asphalt with painted bays
//   doors   [a, b, kind, width]                        on the nearest wall: 'canopy', 'arch', 'drum', 'tower', 'glass'
function mallKit(T, B, S) {
  const ring = T.ccw(B.outer[0]), ob = T.orientedBox(ring); if (!ob) return null;
  const K = T.codes, lite = T.lite, r = B.r, H = S.h || B.b.h || 16;
  let u = ob.u; if (dot(u, S.axis || [1, 0]) < 0) u = [-u[0], -u[1]];
  const v = [-u[1], u[0]], c = ob.c, hl = ob.len / 2, hw = ob.wid / 2;
  const at = (a, b) => [c[0] + u[0] * a * hl + v[0] * b * hw, c[1] + u[1] * a * hl + v[1] * b * hw];
  const rect = (a0, a1, b0, b1) => T.ccw([at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)]);
  const wall = C(S.wall || '#e6dccb'), trim = C(S.trim || '#f3ede0'), roofC = C(S.roof || '#cfcbc2'), white = C('#e9e7e1');
  const o = { ...B.o, wall, base: 0, top: H + 12, fh: S.fh || 6, center: c };
  const inR = (q, m = 0) => T.pointInRing(q, ring) && (m <= 0 || edgeDist(q, ring) > m);
  T.walls(ring, 0, H, o, S.layer != null ? S.layer : T.L.mallStone, { color: wall });
  const holes = B.outer.slice(1);
  let inner;
  if (holes.length) {
    // open courts inside the outline: walled round, the roof cut away over them
    for (const h of holes) T.walls(h, 0, H + 1.4, o, K.SOLID, { color: wall });
    T.walls(ring, H, H + 1.4, o, K.SOLID, { color: trim });
    T.cap([ring, ...holes], H + 0.02, o, K.ROOF + T.L.roofConcrete, roofC);
    inner = T.insetRing(ring, 0.8);
  } else inner = T.parapetRoof(ring, H, 1.4, o, K.ROOF + T.L.roofConcrete, roofC, trim);
  const y = H + 0.1, keep = [];
  for (const h of holes) { const hc = T.centroid(h); keep.push([hc, Math.max(...h.map((q) => dist(q, hc))) + 4]); }
  for (const [a0, a1, b0, b1, hb, col, roofCol] of S.blocks || []) {
    const rr = rect(a0, a1, b0, b1); if (!rr.some((q) => inR(q))) continue;
    T.prism(rr, hb > H ? H : 0, hb, { ...o, base: hb > H ? H : 0 }, K.SOLID, C(col || S.wall || '#e6dccb'), K.ROOF + T.L.roofConcrete, C(roofCol || S.roof || '#cfcbc2'));
    keep.push([at((a0 + a1) / 2, (b0 + b1) / 2), Math.hypot((a1 - a0) * hl, (b1 - b0) * hw) / 2 + 4]);
  }
  // hips: pavilions under a hipped tile roof [a0, a1, b0, b1, eaves height, wall colour, tile colour, rise]
  for (const [a0, a1, b0, b1, hb, col, tcol, rise = 5] of S.hips || []) {
    let rr = rect(a0, a1, b0, b1); if (!rr.some((q) => inR(q))) continue;
    const base = hb > H ? H : 0;
    T.prism(rr, base, hb, { ...o, base }, K.SOLID, C(col || S.wall || '#e6dccb'), K.SOLID, C(tcol || S.tile || '#b06a48'));
    if (dist(rr[0], rr[1]) < dist(rr[1], rr[2])) rr = [rr[1], rr[2], rr[3], rr[0]];
    const half = dist(rr[1], rr[2]) / 2, L = dist(rr[0], rr[1]), m0 = lerp2(rr[0], rr[3], 0.5), m1 = lerp2(rr[1], rr[2], 0.5);
    const t = Math.min(0.5, half / L), R0 = lerp2(m0, m1, t), R1 = lerp2(m0, m1, 1 - t), zt = hb + rise, tc = C(tcol || S.tile || '#b06a48');
    const P = (q, z) => [q[0], q[1], z];
    T.quad(P(rr[0], hb), P(rr[1], hb), P(R1, zt), P(R0, zt), o, tc, K.SOLID);
    T.quad(P(rr[1], hb), P(rr[2], hb), P(R1, zt), P(R1, zt), o, tc, K.SOLID);
    T.quad(P(rr[2], hb), P(rr[3], hb), P(R0, zt), P(R1, zt), o, tc, K.SOLID);
    T.quad(P(rr[3], hb), P(rr[0], hb), P(R0, zt), P(R0, zt), o, tc, K.SOLID);
    keep.push([at((a0 + a1) / 2, (b0 + b1) / 2), Math.hypot((a1 - a0) * hl, (b1 - b0) * hw) / 2 + 4]);
  }
  for (const [a0, a1, b0, b1] of S.decks || []) {
    const rr = rect(a0, a1, b0, b1); if (!rr.every((q) => inR(q))) continue;
    T.cap([rr], y + 0.22, o, K.SOLID, C('#70757a'));
    if (!lite) {
      // rows of painted bays either side of the aisles
      const L = Math.abs(a1 - a0) * hl, Wd = Math.abs(b1 - b0) * hw, nRow = Math.max(1, Math.floor(Wd / 16));
      for (let k = 0; k < nRow; k++) {
        const bb = Math.min(b0, b1) + ((k + 0.5) / nRow) * Math.abs(b1 - b0);
        for (let x = 3; x < L - 3; x += 2.7) { const aa = Math.min(a0, a1) + (x / L) * Math.abs(a1 - a0), q0 = at(aa, bb - 5 / hw), q1 = at(aa, bb + 5 / hw); T.beam([q0[0], q0[1], y + 0.28], [q1[0], q1[1], y + 0.28], 0.14, o, C('#e8e6df'), K.SOLID); }
      }
    }
    keep.push([at((a0 + a1) / 2, (b0 + b1) / 2), Math.hypot((a1 - a0) * hl, (b1 - b0) * hw) / 2 + 3]);
  }
  for (const [a0, b0, a1, b1, rw, rise, kind] of S.vaults || []) {
    const A = at(a0, b0), Bp = at(a1, b1); if (!inR(A, 3) || !inR(Bp, 3)) continue;
    if (kind === 'metal') barrel(T, o, A, Bp, y, rw, rise, C('#c9c8c0'), K.METAL); else vault(T, o, A, Bp, y, rw, rise, white);
    const n = Math.max(1, Math.round(dist(A, Bp) / 14)); for (let k = 0; k <= n; k++) keep.push([lerp2(A, Bp, k / n), rw + 5]);
  }
  for (const [a, b, R, rise, col, kind] of S.domes || []) {
    const q = at(a, b); if (!inR(q, R * 0.5)) continue;
    const oo = { ...o, center: q };
    T.cone(q, R + 1, R + 1, y, y + 2.2, oo, white, K.SOLID, { segs: lite ? 16 : 32, cap: false });
    T.dome(q, R, R, y + 2.2, rise || R * 0.6, oo, C(col || '#e9e7e1'), kind === 'gold' ? K.METAL : kind === 'solid' ? K.SOLID : K.SKY, { segs: lite ? 16 : 32, rings: 8 });
    keep.push([q, R + 6]);
  }
  // lights: a row of small pyramid rooflights [a0, b0, a1, b1, spacing, size]
  for (const [a0, b0, a1, b1, step = 14, sz = 5] of S.lights || []) {
    const A = at(a0, b0), Bp = at(a1, b1), n = Math.max(1, Math.round(dist(A, Bp) / step)), ang = Math.atan2(u[1], u[0]);
    for (let k = 0; k <= n; k++) {
      const q = lerp2(A, Bp, k / n); if (!inR(q, sz) || holes.some((h) => T.pointInRing(q, h)) || keep.some(([kq, R]) => dist(q, kq) < R)) continue;
      const sq = T.ccw(T.rectRing(q[0], q[1], sz, sz, ang)), z0 = y + 0.7, z1 = z0 + sz * 0.42;
      T.prism(sq, y, z0, { ...o, base: H }, K.SOLID, white);
      if (!lite) for (let e = 0; e < 4; e++) { const p0 = sq[e], p1 = sq[(e + 1) % 4]; T.quad([p0[0], p0[1], z0], [p1[0], p1[1], z0], [q[0], q[1], z1], [q[0], q[1], z1], o, C('#cfe0ea'), K.SKY); }
      keep.push([q, sz]);
    }
  }
  // rim: a ridge of roof tiles round the whole parapet [inset, rise, colour]
  if (S.rim && !lite) {
    const [ri = 5, rz = 3, rc] = S.rim, r1 = T.insetRing(ring, ri), r2 = T.insetRing(ring, ri * 2), tc = C(rc || S.tile || '#b06a48'), ze = H + 1.45;
    if (r1 && r2 && r1.length === ring.length && r2.length === ring.length) for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      T.quad([ring[i][0], ring[i][1], ze], [ring[j][0], ring[j][1], ze], [r1[j][0], r1[j][1], ze + rz], [r1[i][0], r1[i][1], ze + rz], o, tc, K.SOLID);
      T.quad([r1[i][0], r1[i][1], ze + rz], [r1[j][0], r1[j][1], ze + rz], [r2[j][0], r2[j][1], H + 0.2], [r2[i][0], r2[i][1], H + 0.2], o, tc, K.SOLID);
    }
  }
  // doors: built on the stretch of wall nearest the given point
  for (const [a, b, kind, w = 16] of S.doors || []) {
    const q = at(a, b); let best = null;
    for (let i = 0; i < ring.length; i++) {
      const p0 = ring[i], p1 = ring[(i + 1) % ring.length], dx = p1[0] - p0[0], dy = p1[1] - p0[1], L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((q[0] - p0[0]) * dx + (q[1] - p0[1]) * dy) / L2)), m = [p0[0] + dx * t, p0[1] + dy * t], dd = dist(m, q);
      if (!best || dd < best.dd) best = { dd, m, d: norm([dx, dy]) };
    }
    if (!best) continue;
    const d = best.d, n = [d[1], -d[0]], m = best.m, W = (sx, tx) => [m[0] + d[0] * sx + n[0] * tx, m[1] + d[1] * sx + n[1] * tx];
    const box = (s0, s1, t0, t1) => T.ccw([W(s0, t0), W(s1, t0), W(s1, t1), W(s0, t1)]);
    if (kind === 'canopy') {
      T.prism(box(-w / 2, w / 2, 0, 9), 5.2, 5.9, o, K.SOLID, trim);
      if (!lite) for (const sx of [-w / 2 + 0.6, w / 2 - 0.6]) T.cone(W(sx, 8.2), 0.35, 0.3, 0, 5.2, o, trim, K.SOLID, { segs: 8 });
      if (!lite) { const g0 = W(-w * 0.35, 0.12), g1 = W(w * 0.35, 0.12); T.quad([g0[0], g0[1], 0.2], [g1[0], g1[1], 0.2], [g1[0], g1[1], 4.8], [g0[0], g0[1], 4.8], o, C('#35505c'), K.GLASSY); }
    } else if (kind === 'arch') {
      T.prism(box(-w / 2, w / 2, -3, 3.5), 0, H + 5, o, K.STONE, C(S.portal || S.wall || '#e6dccb'));
      if (!lite) { const g0 = W(-w * 0.3, 3.6), g1 = W(w * 0.3, 3.6), gm = W(0, 3.6), zs = (H + 5) * 0.55, zt = (H + 5) * 0.86; T.quad([g0[0], g0[1], 0], [g1[0], g1[1], 0], [g1[0], g1[1], zs], [g0[0], g0[1], zs], o, C('#3a4a55'), K.GLASSY); T.quad([g0[0], g0[1], zs], [g1[0], g1[1], zs], [gm[0], gm[1], zt], [gm[0], gm[1], zt], o, C('#3a4a55'), K.GLASSY); }
    } else if (kind === 'drum' || kind === 'glass') {
      const qc = W(0, kind === 'drum' ? -w * 0.15 : 0);
      T.cone(qc, w / 2, w / 2, 0, H + 4, { ...o, center: qc }, kind === 'glass' ? C('#7fa2b3') : C(S.portal || S.wall || '#e6dccb'), kind === 'glass' ? K.GLASSY : K.SOLID, { segs: lite ? 16 : 32 });
      keep.push([qc, w / 2 + 4]);
    } else if (kind === 'tower') {
      const sq = box(-w / 2, w / 2, -w / 2, w / 2), ht = H + 13, cq = W(0, 0);
      T.prism(sq, 0, ht, o, K.STONE, C(S.portal || S.wall || '#e6dccb'));
      for (let k = 0; k < 4; k++) { const p0 = sq[k], p1 = sq[(k + 1) % 4]; T.quad([p0[0], p0[1], ht], [p1[0], p1[1], ht], [cq[0], cq[1], ht + w * 0.5], [cq[0], cq[1], ht + w * 0.5], o, C(S.tile || '#b06a48'), K.SOLID); }
      keep.push([cq, w]);
    }
  }
  if (!lite && inner) {
    const free = (q, m) => T.pointInRing(q, inner) && edgeDist(q, ring) > m + 3 && !keep.some(([k, R]) => dist(q, k) < R + m);
    const ang = Math.atan2(u[1], u[0]), want = S.plant != null ? S.plant : Math.min(90, Math.round(B.area / 1800));
    if (!S.solar && S.bays !== false) {
      // the roof membrane laid in bays between expansion joints: some lighter, some greyer, some left as they are
      const bx = 44, by = 30, tones = [roofC.clone().multiplyScalar(0.84), roofC.clone().lerp(C('#ffffff'), 0.55), roofC.clone().lerp(C('#a9b0b5'), 0.6)];
      const okq = (q) => inR(q, 2.5) && !holes.some((h) => T.pointInRing(q, h) || edgeDist(q, h) < 2.5);
      for (let ax = -hl, i = 0; ax < hl; ax += bx, i++) for (let bb = -hw, j = 0; bb < hw; bb += by, j++) {
        const k = (i * 7 + j * 13 + ((i * j) % 3)) % 5; if (k > 2) continue;
        const a0 = (ax + 0.8) / hl, a1 = (ax + bx - 0.8) / hl, b0 = (bb + 0.8) / hw, b1 = (bb + by - 0.8) / hw;
        let ok = true; for (let m = 0; m <= 3 && ok; m++) for (let n = 0; n <= 3 && ok; n++) ok = okq(at(a0 + ((a1 - a0) * m) / 3, b0 + ((b1 - b0) * n) / 3));
        if (ok) T.cap([rect(a0, a1, b0, b1)], y, o, K.ROOF + T.L.roofConcrete, tones[k]);
      }
    }
    if (S.solar) {
      // a roof gridded with dark solar-panel blocks between pale strips
      const pw = 30, pd = 13, gx = 38, gy = 19;
      for (let ax = -hl + 20; ax < hl - 20; ax += gx) for (let bx = -hw + 16; bx < hw - 16; bx += gy) {
        const q = at(ax / hl, bx / hw); if (!free(q, 20)) continue;
        T.prism(T.ccw(T.rectRing(q[0], q[1], pw, pd, ang)), y, y + 0.7, { ...o, base: H }, K.SOLID, C('#2f3a46'));
      }
    }
    for (let k = 0, n = 0; k < want * 14 && n < want; k++) {
      const q = at((r() - 0.5) * 2, (r() - 0.5) * 2); if (!free(q, 6)) continue;
      T.prism(T.ccw(T.rectRing(q[0], q[1], 4 + r() * 5, 3 + r() * 3, ang)), y, y + 1.5 + r() * 2, { ...o, base: H }, K.SOLID, C(r() < 0.5 ? '#b9b6ad' : '#a8a79f'));
      keep.push([q, 5]); n++;
    }
    // duct runs between the plant
    for (let k = 0, n = 0, wantD = Math.round(want / 3); k < wantD * 14 && n < wantD; k++) {
      const q = at((r() - 0.5) * 2, (r() - 0.5) * 2); if (!free(q, 12)) continue;
      T.prism(T.ccw(T.rectRing(q[0], q[1], 14 + r() * 14, 1.3, ang + (r() < 0.5 ? 0 : Math.PI / 2))), y + 0.3, y + 1.2, { ...o, base: H }, K.SOLID, C('#c2c4c1'));
      keep.push([q, 6]); n++;
    }
  }
  B.plate = B.outer; B.plateTop = H;
  return { ring, ob, u, v, c, hl, hw, at, rect, o, y, H, inR, keep, wall, trim, white };
}

// The round parts of an outline: every evenly curving convex run of it (seven points or more), with the circle that
// fits it best. Roof drums are set on these, so a drum's roof sits exactly over its wall.
function fitArcs(ringIn) {
  const ring = ringIn.slice(); if (dist(ring[0], ring[ring.length - 1]) < 0.01) ring.pop();
  const n = ring.length, wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a)), arcs = [];
  let run = null;
  const close = () => {
    if (run && run.pts.length >= 7) {
      const P = run.pts, m = P.length, mx = P.reduce((t, q) => t + q[0], 0) / m, my = P.reduce((t, q) => t + q[1], 0) / m;
      let Suu = 0, Suv = 0, Svv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
      for (const q of P) { const x = q[0] - mx, y = q[1] - my; Suu += x * x; Suv += x * y; Svv += y * y; Suuu += x * x * x; Svvv += y * y * y; Suvv += x * y * y; Svuu += y * x * x; }
      const det = Suu * Svv - Suv * Suv, e1 = 0.5 * (Suuu + Suvv), e2 = 0.5 * (Svvv + Svuu);
      if (Math.abs(det) > 1e-6) { const uc = (e1 * Svv - e2 * Suv) / det, vc = (e2 * Suu - e1 * Suv) / det; arcs.push({ c: [mx + uc, my + vc], R: Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / m), sweep: run.sweep }); }
    }
    run = null;
  };
  for (let k = 0; k < n * 2; k++) {
    const a = ring[(k - 1 + n) % n], q = ring[k % n], e = ring[(k + 1) % n], turn = wrapA(Math.atan2(e[1] - q[1], e[0] - q[0]) - Math.atan2(q[1] - a[1], q[0] - a[0]));
    if (dist(a, q) < 14 && dist(q, e) < 14 && turn > 0.05 && turn < 0.3) { if (!run) run = { pts: [a], sweep: 0 }; run.pts.push(q); run.last = e; run.sweep += turn; if (run.pts.length > n) break; } else if (run) { run.pts.push(run.last); close(); if (k >= n) break; }
  }
  return arcs;
}

export const LANDMARKS = {
  // ---------------------------------------------------------------- Cayan Tower: hexagonal plates, 1.2°/floor, 90° twist
  'Cayan Tower': (T, B) => {
    const H = B.b.h, c = B.cen;
    const hex = chamfer(polygonByArea(c, B.area * 0.95, 6, angleOf(T, B.outer[0])), 0.12);
    const N = 40;
    const o = shaftO(B, '#c7ccd0', H, { center: c, roofLayer: T.L.roofConcrete, roof: C('#b9bec2') });
    T.loft(hex, Array.from({ length: N + 1 }, (_, k) => ({ y: (H * k) / N, r: ((Math.PI / 2) * k) / N })), o, T.L.frame, { center: c });
    B.plate = [hex]; B.plateTop = H;
    return true;
  },

  // ---------------------------------------------------------------- Princess Tower: dome on an observation drum + 22 m spire
  'Princess Tower': (T, B) => {
    const { b, o } = B;
    B.ap.layer = T.L.balconyA; B.ap.wall = C('#dccfb8'); o.wall = B.ap.wall;
    T.defaultParts(B, { skip: (p) => (p.mh || 0) >= 300, noPodium: true });
    const body = b.parts.find((p) => !(p.mh > 1)) || { h: 357, p: B.outer };
    const top = body.h;
    const deck = b.parts.find((p) => Math.abs((p.mh || 0) - top) < 2);
    const ring = deck ? deck.p[0] : T.scaleRing(B.outer[0], B.cen, 0.75);
    const c = T.centroid(ring), r = Math.sqrt(Math.abs(T.signedArea(ring)) / Math.PI);
    const co = { ...o, base: top, top: 414 };
    T.cone(c, r, r, top, top + 13, co, C('#8fb0c2'), T.codes.GLASSY, { segs: 32 });           // observation deck
    T.cone(c, r * 1.04, r * 1.04, top + 13, top + 15, co, C('#e9e3d6'), T.codes.SOLID, { segs: 32 }); // cornice
    T.dome(c, r * 0.97, r * 0.97, top + 15, r * 1.12, co, C('#d9cdb2'), T.codes.GLOW, { segs: 36, rings: 14, rib: 2.4 });
    const domeTop = top + 15 + r * 1.12;
    T.dome(c, 2.4, 2.4, domeTop - 0.8, 2.6, co, C('#e7ddc6'), T.codes.GLOW, { segs: 12, rings: 4 });
    T.cone(c, 1.5, 0.12, domeTop + 1.5, 414, co, C('#ece6d8'), T.codes.GLOW, { segs: 10 });
    B.plateTop = top;
    return true;
  },

  // ---------------------------------------------------------------- 23 Marina: octagon, white ribs converging into a pointed crown
  '23 Marina': (T, B) => {
    const main = largestPart(T, B.b);
    const c = T.centroid(main.p[0]);
    const oct = polygonByArea(c, Math.abs(T.signedArea(main.p[0])) * 0.97, 8, angleOf(T, main.p[0]) + Math.PI / 8);
    T.defaultParts(B, { skip: () => true }); // podium only
    const shaft = 350;
    const o = shaftO(B, '#f1f0eb', 393, { center: c });
    T.loft(oct, [{ y: 0 }, { y: shaft }], o, T.L.frame, { center: c, capColor: C('#d8d6cf') });
    T.loft(oct, [{ y: shaft, s: 0.82 }, { y: shaft + 16, s: 0.66 }, { y: 378, s: 0.2 }], { ...o, base: shaft }, T.codes.GLASSY, { center: c, color: C('#6f9cc0'), capCode: T.codes.GLASSY, capColor: C('#6f9cc0') });
    ribs(T, o, oct, shaft, c, 384, 2.3, WHITE, 0.1);
    T.cone(c, 1.1, 0.08, 378, 393, o, WHITE, T.codes.GLOW, { segs: 8 });
    B.plate = [oct]; B.plateTop = shaft;
    return true;
  },

  // ---------------------------------------------------------------- Elite Residence: richly crowned slender tower + spire
  'Elite Residences': (T, B) => {
    const c = B.cen;
    const plan = chamfer(B.outer[0], 0.18);
    const shaft = 342;
    const o = shaftO(B, '#cfd9e0', 380, { center: c });
    T.loft(plan, [{ y: 0 }, { y: shaft }], o, T.L.frame, { center: c, capColor: C('#d0d4d6') });
    T.loft(plan, [{ y: shaft, s: 0.86 }, { y: shaft + 14, s: 0.72 }, { y: 368, s: 0.24 }], { ...o, base: shaft }, T.codes.GLASSY, { center: c, color: C('#7fa6c4'), capCode: T.codes.GLASSY, capColor: C('#7fa6c4') });
    const corners = T.scaleRing(B.outer[0], c, 0.82);
    ribs(T, o, corners, shaft, c, 372, 2.6, C('#e9edf0'), 0.08);
    T.dome(c, 4.2, 4.2, 366, 5, o, C('#d7c9a2'), T.codes.GLOW, { segs: 16, rings: 6 });
    T.cone(c, 0.9, 0.08, 370, 380.5, o, C('#e9e4d6'), T.codes.GLOW, { segs: 8 });
    B.plate = [plan]; B.plateTop = shaft;
    return true;
  },

  // ---------------------------------------------------------------- The Torch: three sections, flame-like twisting glass crown
  'The Torch': (T, B) => {
    const main = largestPart(T, B.b);
    const ring = T.ccw(main.p[0]);
    const c = T.centroid(ring);
    T.defaultParts(B, { skip: () => true }); // podium
    const roof = 318, wall = '#8fb3cf';
    const o = shaftO(B, wall, roof, { center: c });
    const h1 = roof * 0.36, h2 = roof * 0.69;
    for (const [y0, y1] of [[0, h1], [h1 + 5, h2], [h2 + 5, roof]]) T.walls(ring, y0, y1, { ...o, base: y0 }, T.L.curtainC);
    for (const y of [h1, h2]) T.walls(ring, y, y + 5, { ...o, base: y, fh: 5 }, T.L.podium, { color: C('#c9cfd3') });
    T.parapetRoof(ring, roof, 1.2, o, T.codes.ROOF + T.L.roofConcrete, C('#c3c6c8'), C('#e1e6ea'));
    const flame = T.scaleRing(ring, c, 0.8);
    T.loft(flame, [{ y: roof, s: 1 }, { y: roof + 10, s: 0.9, r: 0.35 }, { y: roof + 20, s: 0.62, r: 0.8 }, { y: 344, s: 0.22, r: 1.3 }], { ...o, base: roof }, T.codes.GLASSY, { center: c, color: C('#8db8d8'), capCode: T.codes.GLASSY, capColor: C('#8db8d8') });
    T.cone(c, 1.4, 0.1, 336, 352, o, C('#e8ecef'), T.codes.GLOW, { segs: 8 });
    B.plate = main.p; B.plateTop = roof;
    return true;
  },

  // ---------------------------------------------------------------- Ocean Heights: shrinking, twisting, curving profile with a slanted roof
  'Ocean Heights': (T, B) => {
    const c = B.cen, a0 = angleOf(T, B.outer[0]);
    const plan = chamfer(B.outer[0], 0.2);
    const o = shaftO(B, '#5f8dbd', 310, { center: c });
    const ux = Math.cos(a0), uy = Math.sin(a0);
    const N = 16, top = 288;
    const secs = Array.from({ length: N + 1 }, (_, k) => {
      const t = k / N, e = t * t;
      return { y: top * t, s: 1 - 0.3 * e, r: 0.38 * e, dx: ux * 9 * e, dy: uy * 9 * e };
    });
    const last = T.loft(plan, secs, o, T.L.curtainA, { center: c, cap: false });
    const lc = T.centroid(last);
    T.slantTop(last, top, { c: lc, dir: [ux, uy], y0: 299, slope: 0.45 }, { ...o, base: top }, T.L.curtainA, T.codes.GLASSY, C('#6f9cc0'));
    B.plate = [plan]; B.plateTop = top;
    return true;
  },

  // ---------------------------------------------------------------- DAMAC Heights: blade-like elliptical tower curving into a glazed summit
  'DAMAC Heights': (T, B) => {
    const ob = T.orientedBox(B.outer[0]); const c = ob ? ob.c : B.cen;
    const a = (ob ? ob.len : 60) * 0.5, bb = (ob ? ob.wid : 60) * 0.34;
    const plan = ellipse(c, a, bb, ob ? Math.atan2(ob.u[1], ob.u[0]) : 0);
    const o = shaftO(B, '#f2f1ec', 335, { center: c });
    T.loft(plan, [{ y: 0 }, { y: 120, s: 1.02 }, { y: 240, s: 1.0 }, { y: 296, s: 0.95 }], o, T.L.balconyA, { center: c, cap: false });
    T.loft(plan, [{ y: 296, s: 0.95 }, { y: 314, s: 0.82 }, { y: 328, s: 0.55 }, { y: 335, s: 0.2 }], { ...o, base: 296 }, T.codes.GLASSY, { center: c, color: C('#7fa9c8'), capCode: T.codes.GLASSY, capColor: C('#7fa9c8') });
    B.plate = [plan]; B.plateTop = 296;
    return true;
  },

  // ---------------------------------------------------------------- Marina 101: 45 m sky-blue faceted crown, four-point pinnacle
  'Marina 101': (T, B) => {
    const main = largestPart(T, B.b);
    const ring = T.ccw(main.p[0]); const c = T.centroid(ring);
    T.defaultParts(B, { skip: () => true }); // podium
    const shaft = 380;
    const o = shaftO(B, '#9fb4c4', 425, { center: c });
    T.walls(ring, 0, shaft, { ...o, base: 0 }, T.L.curtainB);
    T.cap([ring], shaft, o, T.codes.SOLID, C('#c8d4dc'));
    const sky = C('#8fc3e6');
    const top = T.loft(ring, [{ y: shaft, s: 1 }, { y: shaft + 14, s: 0.86 }, { y: shaft + 32, s: 0.5 }], { ...o, base: shaft }, T.codes.GLOW, { center: c, color: sky, capColor: sky, capCode: T.codes.GLOW });
    const ob = T.orientedBox(top);
    if (ob) for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [ob.c[0] + ob.u[0] * sx * ob.len * 0.36 + ob.v[0] * sy * ob.wid * 0.36, ob.c[1] + ob.u[1] * sx * ob.len * 0.36 + ob.v[1] * sy * ob.wid * 0.36];
      T.cone(p, 1.3, 0.08, shaft + 32, 420, o, sky, T.codes.GLOW, { segs: 6 });
    }
    T.cone(c, 1.0, 0.06, shaft + 32, 425, o, C('#e8f0f5'), T.codes.GLOW, { segs: 6 });
    B.plate = main.p; B.plateTop = shaft;
    return true;
  },

  // ---------------------------------------------------------------- Address Beach Resort: twin towers + sky bridge with the infinity pool
  'Address Jumeirah Resort': (T, B) => {
    B.ap.layer = T.L.curtainB; B.ap.wall = C('#c9dae4'); B.o.wall = B.ap.wall;
    T.defaultParts(B, { noPodium: true, wall: B.ap.wall });
    const bridge = B.b.parts.find((p) => (p.mh || 0) > 200);
    if (bridge) {
      const ring = T.insetRing(T.ccw(bridge.p[0]), 2.2);
      T.cap([ring], bridge.h + 0.25, { ...B.o, top: bridge.h }, T.codes.POOL, C('#3fcfe0'));
    }
    return true;
  },

  // ---------------------------------------------------------------- Almas Tower: ovals sliced at an angle (roof ~306 m) + 54 m mast
  'Almas Tower': (T, B) => {
    const main = largestPart(T, B.b);
    const ring = T.ccw(main.p[0]); const c = T.centroid(ring);
    T.defaultParts(B, { skip: () => true }); // island podium
    const ob = T.orientedBox(ring); const dir = ob ? ob.u : [1, 0];
    const o = shaftO(B, '#5f9ea6', 360, { center: c });
    T.slantTop(ring, 0, { c, dir, y0: 300, slope: 0.32 }, o, T.L.curtainB, T.codes.ROOF + T.L.roofConcrete, C('#bfc5c8'));
    T.cone(c, 1.8, 0.15, 296, 360, o, C('#dfe6ea'), T.codes.GLOW, { segs: 8 });
    B.plate = main.p; B.plateTop = 290;
    return true;
  },

  // ---------------------------------------------------------------- Uptown Dubai Tower 1: faceted "diamond" massing + steel crown
  'Uptown Dubai Tower 1': (T, B) => {
    const c = B.cen;
    const plan = chamfer(B.outer[0], 0.24);
    const o = shaftO(B, '#a8bccb', 340, { center: c });
    const top = T.loft(plan, [{ y: 0, s: 1 }, { y: 105, s: 1.05, r: 0.1 }, { y: 215, s: 0.97, r: -0.05 }, { y: 329, s: 0.82, r: 0.12 }], o, T.L.curtainA, { center: c, capColor: C('#c4ccd2') });
    const steel = C('#d9dee2');
    ribs(T, o, top, 329, c, 340, 1.1, steel, 0.04);
    B.plate = [plan]; B.plateTop = 329;
    return true;
  },

  // ---------------------------------------------------------------- Ciel Tower: slim tapered tower, sky deck and rooftop infinity pool
  'Ciel Tower': (T, B) => {
    const tower = largestPart(T, { parts: B.b.parts.filter((p) => p.h > 100) });
    T.defaultParts(B, { skip: (p) => p.h > 100, noPodium: true }); // the 30 m podium part
    if (!tower) return true;
    const ring = T.ccw(tower.p[0]); const c = T.centroid(ring);
    const o = shaftO(B, '#c4d6e0', 377, { center: c });
    T.loft(ring, [{ y: 0, s: 1 }, { y: 355, s: 0.9 }], o, T.L.curtainC, { center: c, cap: false });
    T.loft(ring, [{ y: 355, s: 0.98 }, { y: 362, s: 0.98 }], { ...o, base: 355 }, T.codes.GLASSY, { center: c, color: C('#7fa7c2'), cap: false });
    T.loft(ring, [{ y: 362, s: 0.9 }, { y: 377, s: 0.9 }], { ...o, base: 362 }, T.L.frame, { center: c, capCode: T.codes.POOL, capColor: C('#46d0e2') });
    B.plate = tower.p; B.plateTop = 355;
    return true;
  },

  // ---------------------------------------------------------------- Emirates Crown: glass shaft with a stylised crown
  'Emirates Crown': (T, B) => {
    const c = B.cen, ring = T.ccw(B.outer[0]);
    const shaft = 272;
    const o = shaftO(B, '#8fbcd8', 296, { center: c });
    T.walls(ring, 0, shaft, { ...o, base: 0 }, T.L.curtainC);
    T.parapetRoof(ring, shaft, 1.2, o, T.codes.ROOF + T.L.roofConcrete, C('#c6c9cb'), C('#e7ebee'));
    T.loft(T.scaleRing(ring, c, 0.55), [{ y: shaft, s: 1 }, { y: 288, s: 0.7 }], { ...o, base: shaft }, T.codes.GLASSY, { center: c, color: C('#7fb0d0'), capCode: T.codes.GLOW, capColor: C('#e7dcc0') });
    const pts = T.circleRing(c[0], c[1], Math.sqrt(B.area) * 0.42, 8);
    for (const p of pts) T.beam([p[0], p[1], shaft], [c[0] + (p[0] - c[0]) * 0.9, c[1] + (p[1] - c[1]) * 0.9, 296], 2.0, o, C('#efe8d6'), T.codes.GLOW);
    B.plate = B.outer; B.plateTop = shaft;
    return true;
  },

  // ---------------------------------------------------------------- Pier 7: seven stacked restaurant levels on the marina
  'pier 7': (T, B) => {
    const c = B.cen; const r = Math.sqrt(B.area / Math.PI);
    const o = { ...B.o, top: 27 };
    for (let k = 0; k < 7; k++) {
      const y0 = k * 3.85;
      T.cone(c, r * 0.9, r * 0.9, y0, y0 + 3.2, { ...o, base: y0 }, C('#8fb5c8'), T.codes.GLASSY, { segs: 28 });
      const rs = r * (k % 2 ? 1.02 : 1.12);
      T.cone(c, rs, rs, y0 + 3.2, y0 + 3.85, { ...o, base: y0 }, WHITE, T.codes.SOLID, { segs: 28 });
    }
    return true;
  },

  // the DMCC metro station is modelled by the stations layer
  DMCC: () => true,

  // ---------------------------------------------------------------- Atlantis The Palm: coral wings either side of the
  // twin Royal Towers, joined high over the arch by the Royal Bridge Suite; Arabian crowns with domes and spires
  'Atlantis Hotel': (T, B) => {
    const ring = T.ccw(B.outer[0]);
    const ob = T.orientedBox(ring); if (!ob) return false;
    const u = ob.u, c = ob.c, L2 = ob.len / 2;
    const coral = C('#e4a88e'), cream = C('#f2e4cc'), domeC = C('#efd8b5'), roofC = C('#d8c6ab');
    const o = shaftO(B, '#e4a88e', 114, { center: c });
    const block = (a0, a1, y0, y1, opt = {}) => {
      const r = slab(ring, c, u, a0, a1); if (!r) return null;
      const rr = T.ccw(r);
      const oo = { ...o, base: y0, top: y1 };
      T.walls(rr, y0, y1, oo, T.L.punched, { color: opt.color || coral });
      if (y0 > 0.5) T.cap([rr], y0, oo, T.codes.SOLID, cream, true);
      T.parapetRoof(rr, y1, opt.par ?? 1.4, oo, T.codes.ROOF + T.L.roofConcrete, roofC, cream);
      return rr;
    };
    // wings step down toward their ends
    block(-L2 - 2, -112, 0, 44); block(-112, -40, 0, 58); block(40, 112, 0, 58); block(112, L2 + 2, 0, 44);
    // the Royal Towers with their crowns
    for (const [a0, a1] of [[-40, -16], [16, 40]]) {
      const rr = block(a0, a1, 0, 92, { par: 2.2 }); if (!rr) continue;
      const tc = T.centroid(rr), tob = T.orientedBox(rr);
      T.cone(tc, 9.5, 9.5, 92, 96, { ...o, base: 92 }, cream, T.codes.SOLID, { segs: 24 });
      T.dome(tc, 8.6, 8.6, 96, 9.5, o, domeC, T.codes.GLOW, { segs: 28, rings: 9, rib: 2.2 });
      T.cone(tc, 1.1, 0.08, 104, 117, o, cream, T.codes.GLOW, { segs: 8 });
      if (tob) for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = [tob.c[0] + tob.u[0] * sx * tob.len * 0.4 + tob.v[0] * sy * tob.wid * 0.4, tob.c[1] + tob.u[1] * sx * tob.len * 0.4 + tob.v[1] * sy * tob.wid * 0.4];
        T.cone(p, 1.5, 1.5, 92, 98, o, cream, T.codes.SOLID, { segs: 10 });
        T.cone(p, 1.6, 0.15, 98, 104, o, domeC, T.codes.GLOW, { segs: 10 });
      }
    }
    // the arch: lobby below, the Royal Bridge Suite spanning the top
    block(-16, 16, 0, 26, { par: 1.0 });
    block(-16, 16, 72, 92, { par: 1.8 });
    B.plate = B.outer; B.plateTop = 58;
    return true;
  },

  // ---------------------------------------------------------------- The Palm Tower: glass shaft, a cantilevered crown ring
  // holding the 360-degree Aura Skypool (level 50) and The View at the Palm on top (level 52)
  'The Palm Tower': (T, B) => {
    const ring = T.ccw(B.outer[0]), c = B.cen;
    const plan = chamfer(ring, 0.16);
    const o = shaftO(B, '#9db7c9', 242, { center: c });
    T.walls(plan, 0, 196, { ...o, base: 0, top: 196 }, T.L.curtainC);
    const deck = T.scaleRing(plan, c, 1.18);
    T.prism(deck, 196, 202, { ...o, base: 196, top: 202 }, T.L.frame, C('#e9edf0'), T.codes.SOLID, C('#e9edf0'));
    T.cap([deck], 202.2, { ...o, top: 202 }, T.codes.POOL, C('#3fcde0'));
    const upper = T.scaleRing(plan, c, 0.9);
    T.loft(upper, [{ y: 202 }, { y: 230 }], { ...o, base: 202 }, T.codes.GLASSY, { center: c, color: C('#86b1cb'), capCode: T.codes.ROOF + T.L.roofConcrete, capColor: C('#d6dbde') });
    // crown fins framing the observation deck
    for (const p of T.scaleRing(plan, c, 0.98)) T.beam([p[0], p[1], 228], [c[0] + (p[0] - c[0]) * 0.84, c[1] + (p[1] - c[1]) * 0.84, 242], 1.1, o, C('#eef1f3'), T.codes.GLOW);
    B.plate = [plan]; B.plateTop = 196;
    return true;
  },

  // ---------------------------------------------------------------- Atlantis The Royal: KPF's stacked blocks (OSM parts) in
  // pale stone and glass, with the infinity pool across the top of the Sky Bridge
  'Atlantis The Royal': (T, B) => {
    B.ap.layer = T.L.balconyA; B.ap.wall = C('#efebe3'); B.o.wall = B.ap.wall;
    T.defaultParts(B, { noPodium: true, wall: B.ap.wall });
    return true;
  },
  // ---------------------------------------------------------------- Burj Al Arab: a dhow's sail on its own island. The plan
  // is a V: the mast stands at its seaward apex, the two bedroom wings run out from it (blue glass behind white
  // balcony bands, double-height suites) and the white fabric sail closes the V on the shore side, leaning back
  // toward the mast as it rises and crossed by its horizontal trusses. Outside the wings stands the white steel
  // exoskeleton: a leg up each wing end, the great bows that arc from the wing ends up to the mast, and diagonal
  // braces between. Helipad and the Al Muntaha restaurant cantilever near the top.
  'Burj Al Arab Jumeirah': (T, B) => {
    const ring = T.ccw(B.outer[0]), n = ring.length;
    // mast: the vertex where the two longest straight edges meet
    let mi = 0, best = -1;
    for (let i = 0; i < n; i++) {
      const p = ring[i], a = ring[(i + n - 1) % n], b = ring[(i + 1) % n];
      const l = Math.hypot(a[0] - p[0], a[1] - p[1]) + Math.hypot(b[0] - p[0], b[1] - p[1]);
      if (l > best) { best = l; mi = i; }
    }
    const M = ring[mi];
    const top = 197, white = C('#f6f4ee'), steel = C('#f1f3f4'), glass = C('#3f8fd0');
    const o = shaftO(B, '#f6f4ee', 321, { center: M });
    o.fh = 7.4; // double-height suites
    const secs = [{ y: 0, s: 1 }, { y: 40, s: 1 }, { y: 90, s: 0.97 }, { y: 130, s: 0.9 }, { y: 165, s: 0.78 }, { y: 185, s: 0.66 }, { y: top, s: 0.56 }];
    // the two wing faces are the base edges that touch the mast; the rest is the sail
    const wingEdge = (i) => i === mi || (i + 1) % n === mi;
    const last = T.loft(ring, secs, o, T.codes.FABRIC, {
      center: M, color: white, capColor: C('#e6e2da'),
      edge: (i) => (wingEdge(i) ? { code: T.L.balconyA, color: glass } : null),
    });
    const A = ring[(mi + 1) % n], Bv = ring[(mi + n - 1) % n];
    const at = (e, s, k, y) => [M[0] + (e[0] - M[0]) * s * k, M[1] + (e[1] - M[1]) * s * k, y];
    // the sail's horizontal trusses: a white bow across the fabric at every third of each section
    const sailPts = []; for (let i = (mi + 1) % n; i !== (mi + n - 1) % n; i = (i + 1) % n) sailPts.push(ring[i]); sailPts.push(Bv);
    for (let y = 16; y < top - 4; y += 16) {
      let k = 0; while (k < secs.length - 2 && secs[k + 1].y < y) k++;
      const t = (y - secs[k].y) / (secs[k + 1].y - secs[k].y), sc = secs[k].s + (secs[k + 1].s - secs[k].s) * t;
      for (let i = 0; i < sailPts.length - 1; i++) T.beam(at(sailPts[i], sc, 1.012, y), at(sailPts[i + 1], sc, 1.012, y), 1.5, o, steel, T.codes.SOLID);
    }
    for (const end of [A, Bv]) {
      // the leg up the wing end
      let prev = null;
      for (const sec of secs) { const p = at(end, sec.s, 1.05, sec.y); if (prev) T.beam(prev, p, 4.2, o, steel, T.codes.SOLID); prev = p; }
      // the bow: from the foot of the wing end, swinging outward, up to the mast above the roof
      const out = [end[0] - M[0], end[1] - M[1]];
      const bow = (t) => { const k = 1.1 + 0.34 * Math.sin(Math.PI * t) - 1.02 * t * t * t; return [M[0] + out[0] * Math.max(0.03, k * (1 - t * 0.16)), M[1] + out[1] * Math.max(0.03, k * (1 - t * 0.16)), 4 + 244 * t]; };
      for (let k = 0; k < 14; k++) T.beam(bow(k / 14), bow((k + 1) / 14), 3.4, o, steel, T.codes.SOLID);
      // diagonal braces between the leg and the mast, over the wing's glass
      for (let k = 0; k < secs.length - 1; k++) {
        const s0 = secs[k], s1 = secs[k + 1];
        T.beam(at(end, s0.s, 1.05, s0.y), at(end, s1.s, 0.36, s1.y), 2.4, o, steel, T.codes.SOLID);
        T.beam(at(end, s0.s, 0.36, s0.y), at(end, s1.s, 1.05, s1.y), 2.4, o, steel, T.codes.SOLID);
      }
    }
    // mast / spire
    T.cone(M, 4.2, 0.4, 0, 321, o, steel, T.codes.GLOW, { segs: 10 });
    // helipad off one wing, Al Muntaha cantilevered from the other
    const lc = T.centroid(last);
    const outOf = (e, d) => { const mx = (M[0] + e[0]) / 2, my = (M[1] + e[1]) / 2; const vx = mx - lc[0], vy = my - lc[1], l = Math.hypot(vx, vy) || 1; return [mx + (vx / l) * d, my + (vy / l) * d]; };
    const hp = outOf(A, 16);
    T.cone(hp, 12, 12, 210, 211.2, o, C('#d9dde0'), T.codes.SOLID, { segs: 28, cap: false });
    T.cap([T.circleRing(hp[0], hp[1], 12, 28)], 211.25, { ...o, center: hp, top: 12 }, T.codes.HELI, C('#9ea3a6'));
    T.beam([hp[0], hp[1], 205], [(M[0] + A[0]) / 2, (M[1] + A[1]) / 2, 196], 2.2, o, steel, T.codes.SOLID);
    T.beam([hp[0], hp[1], 208], [M[0], M[1], 214], 1.6, o, steel, T.codes.SOLID);
    const mu = outOf(Bv, 13), ang = Math.atan2(Bv[1] - M[1], Bv[0] - M[0]);
    T.loft(ellipse(mu, 17, 6.5, ang, 20), [{ y: 192 }, { y: 200 }], o, T.codes.GLASSY, { center: mu, color: C('#4f9fd8'), capColor: white });
    B.plate = B.outer; B.plateTop = top;
    return true;
  },

  // ---------------------------------------------------------------- Jumeirah Beach Hotel: a breaking wave. Stepped slices
  // of the curved plan rise from the beach end to the 104 m crest, which curls down at the seaward end.
  'Jumeirah Beach Hotel': (T, B) => {
    const ring = T.ccw(B.outer[0]);
    const ob = T.orientedBox(ring); if (!ob) return false;
    const o = shaftO(B, '#7fb3d4', 104, { center: ob.c });
    // the taller end is the one further from the shore (nearer the Burj): pick the end nearer the sea side
    const ends = [-1, 1].map((sg) => [ob.c[0] + ob.u[0] * sg * ob.len * 0.5, ob.c[1] + ob.u[1] * sg * ob.len * 0.5]);
    const crestSign = ends[1][1] >= ends[0][1] ? 1 : -1; // the north end is the seaward one on this coast
    const N = 16, L2 = ob.len / 2;
    for (let k = 0; k < N; k++) {
      const a0 = -L2 - 1 + ((ob.len + 2) * k) / N, a1 = -L2 - 1 + ((ob.len + 2) * (k + 1)) / N;
      const t = (((a0 + a1) / 2) * crestSign + L2) / ob.len; // 0 at the beach end, 1 at the crest end
      const h = t < 0.88 ? 26 + 78 * Math.pow(t / 0.88, 1.35) : 104 - ((t - 0.88) / 0.12) * 26;
      const r = slab(ring, ob.c, ob.u, a0, a1); if (!r) continue;
      const rr = T.ccw(r);
      T.walls(rr, 0, h, { ...o, base: 0, top: h }, T.L.curtainB, { color: C('#7fb3d4') });
      T.parapetRoof(rr, h, 1.2, { ...o, top: h }, T.codes.ROOF + T.L.roofConcrete, C('#d9dee2'), C('#f3f5f6'));
    }
    B.plate = B.outer; B.plateTop = 60;
    return true;
  },

  // ---------------------------------------------------------------- Burj Khalifa: OSM maps the tower as ~35 parts (the three wings of
  // the Y plan stepping back in a spiral round the hexagonal core, the top sections and the spire). Each is raised as
  // reflective glass with vertical stainless fins and the lobby wings in stone; the slim pinnacle sections and the
  // telescopic spire, tapering to 828 m, are steel.
  'Burj Khalifa': (T, B) => {
    const parts = (B.b.parts || []).slice().sort((p, q) => p.h - q.h);
    if (parts.length < 6) return false;
    const glass = C('#a7bccb'), steel = C('#dfe4e8'), stone = C('#e6e1d8'), louvre = C('#5d6870');
    const top = Math.max(...parts.map((p) => p.h));
    const o = shaftO(B, '#a7bccb', top, { center: T.centroid(B.outer[0]) });
    let spireBase = null;
    for (const part of parts) {
      const ring = T.ccw(part.p[0]);
      const area = Math.abs(T.signedArea(ring));
      if (area < 4) continue; // the needle: drawn as the spire below
      const y0 = part.mh || 0, y1 = part.h;
      if (y1 <= 20) { // lobby wings and podium
        T.walls(ring, y0, y1, { ...o, wall: stone, base: y0, top: y1, fh: 5 }, T.L.podium, { color: stone });
        T.cap([ring], y1, o, T.codes.ROOF + T.L.roofPodium, C('#d8d2c6'));
        continue;
      }
      const crown = y1 > 700 && area < 60; // the slim pinnacle sections below the spire
      T.walls(ring, y0, y1, { ...o, base: 0, top }, crown ? T.codes.METAL : T.L.curtainB, { color: crown ? steel : glass });
      // mechanical and refuge floors: darker louvred bands ringing the tower
      if (!crown) {
        const pc = T.centroid(ring), band = T.scaleRing(ring, pc, 1 + 0.12 / Math.sqrt(area / Math.PI));
        for (const [b0, b1] of MECH_FLOORS) if (b0 > y0 + 1 && b1 < y1 - 1) T.walls(band, b0, b1, { ...o, base: b0, top, fh: 2.4 }, T.codes.ALU, { color: louvre });
      }
      T.cap([ring], y1, o, crown ? T.codes.METAL : T.codes.ROOF + T.L.roofConcrete, crown ? steel : C('#cfd6dc'));
      if (y1 > 700 && (!spireBase || y1 > spireBase.h)) spireBase = { c: T.centroid(ring), h: y1 };
    }
    const sb = spireBase || { c: T.centroid(B.outer[0]), h: Math.min(760, top - 60) };
    T.cone(sb.c, 2.2, 0.15, sb.h, 828, o, steel, T.codes.METAL, { segs: 12 });
    B.plate = B.outer; B.plateTop = 585; // highest occupied floor
    return true;
  },

  // ---------------------------------------------------------------- Museum of the Future: a stainless-steel torus, 77 m high, on a
  // green mound; its long axis follows the outline and the elliptical "eye" opens through the middle. The ring is
  // thicker at its ends (where the floors are) than across the top and bottom.
  'Museum Of The Future': (T, B) => {
    const ring = T.ccw(B.outer[0]);
    const ob = T.orientedBox(ring); if (!ob) return false;
    const steel = C('#c6ccd0');
    const o = shaftO(B, '#c6ccd0', 77, { center: ob.c });
    const mound = 8;
    T.walls(ring, 0, mound, { ...o, wall: C('#d9d2c2'), base: 0, top: mound, fh: 4 }, T.L.podium, { color: C('#d9d2c2') });
    T.cap([ring], mound, o, T.codes.ROOF + T.L.roofPodium, C('#cfc8b6'));
    const A = (ob.len / 2) * 0.97, D = (ob.wid / 2) * 0.92;  // half length and half depth of the ring
    const Hc = (77 - mound) / 2, zc = mound + Hc;           // half height and centre of the ring
    const th = 0.225 * A, tv = 0.29 * Hc;                   // ring thickness at the ends and across the top
    const a = A - th, bz = Hc - tv;
    T.surface((u, v) => {
      const U = u * Math.PI * 2, V = v * Math.PI * 2;
      const cu = Math.cos(U), su = Math.sin(U);
      let nx = bz * cu, nz = a * su; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
      const t = tv + (th - tv) * cu * cu;
      const r = t * Math.cos(V), d = D * Math.sin(V);
      const along = a * cu + nx * r, up = zc + bz * su + nz * r;
      return [ob.c[0] + ob.u[0] * along + ob.v[0] * d, ob.c[1] + ob.u[1] * along + ob.v[1] * d, up];
    }, 96, 28, o, steel, T.codes.CALLIG);
    B.plate = B.outer; B.plateTop = 70;
    return true;
  },

  // ---------------------------------------------------------------- Emirates Towers: the office tower's peak faces east to the hotel,
  // the hotel's west. OSM's parts give the office tower its drum lobby under the overhanging triangle.
  'Emirates Office Tower': (T, B) => emiratesTower(T, B, { toward: [1, 0], baseH: 57, roofLow: 262, peak: 309, spire: B.b.h }),
  'Jumeirah Emirates Towers Hotel': (T, B) => emiratesTower(T, B, { toward: [-1, 0], baseH: 0, roofLow: 226, peak: 266, spire: B.b.h }),

  // ---------------------------------------------------------------- Address Downtown: dark glass banded by white floor lines; the
  // crown curls up like a hood to a needle at the north-north-east end. Stone podium with the pool deck facing the lake.
  'The Address - Downtown Dubai': (T, B) => {
    const tower = largestPart(T, B.b); if (!tower) return false;
    const ring = T.ccw(tower.p[0]), ob = T.orientedBox(ring); if (!ob) return false;
    const podH = B.b.oh || 20;
    podiumDeck(T, B, T.ccw(B.outer[0]), podH, { tower: ring, poolSize: [22, 8] });
    const sg = ob.u[1] >= 0 ? 1 : -1, u = [ob.u[0] * sg, ob.u[1] * sg], c = ob.c, L2 = ob.len / 2;
    const glass = C('#3f5f7b');
    const o = shaftO(B, '#3f5f7b', B.b.h, { center: c, fh: 4.3 });
    const shaft = 236;
    T.walls(ring, podH, shaft, { ...o, base: podH }, T.L.ribbon, { color: glass });
    const secs = [[shaft, 1], [252, 0.95], [266, 0.85], [278, 0.7], [287, 0.5], [292, 0.3]]
      .map(([y, s]) => ({ y, s, dx: u[0] * (1 - s) * L2 * 0.92, dy: u[1] * (1 - s) * L2 * 0.92 }));
    T.loft(ring, secs, { ...o, base: podH }, T.L.ribbon, { center: c, color: glass, capCode: T.codes.METAL, capColor: C('#dfe4e8') });
    const tip = [c[0] + u[0] * (L2 - 7), c[1] + u[1] * (L2 - 7)];
    T.cone(tip, 1.6, 0.1, 286, B.b.h, o, C('#e9edf0'), T.codes.GLOW, { segs: 10 });
    B.plate = [ring]; B.plateBase = podH; B.plateTop = shaft;
    return true;
  },

  // ---------------------------------------------------------------- Address Boulevard: blue-grey glass behind white fins, finishing in
  // an Art Deco crown of four setbacks with needles at their corners and a central spire
  'Address Boulevard': (T, B) => {
    const tower = largestPart(T, B.b); if (!tower) return false;
    const ring = T.ccw(tower.p[0]), c = T.centroid(ring), ob = T.orientedBox(ring); if (!ob) return false;
    const podH = B.b.oh || 20;
    podiumDeck(T, B, T.ccw(B.outer[0]), podH, { tower: ring });
    const glass = C('#56728a'), white = C('#eef0f0');
    const o = shaftO(B, '#56728a', B.b.h, { center: c, fh: 4.0 });
    const shaft = 298;
    T.walls(ring, podH, shaft, { ...o, base: podH }, T.L.finGlass, { color: glass });
    const tiers = [[13, 0.86], [11, 0.72], [9, 0.58], [8, 0.44]];
    const top = setbacks(T, { ...o, base: podH }, ring, c, shaft, tiers, T.L.finGlass, glass, C('#d9dde0'));
    let y = shaft;
    for (const [h, s] of tiers) {
      y += h;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = [c[0] + ob.u[0] * sx * ob.len * 0.33 * s + ob.v[0] * sy * ob.wid * 0.29 * s, c[1] + ob.u[1] * sx * ob.len * 0.33 * s + ob.v[1] * sy * ob.wid * 0.29 * s];
        T.cone(p, 0.75, 0.06, y - 2, y + 7, o, white, T.codes.GLOW, { segs: 6 });
      }
    }
    T.cap([top.ring], top.y, o, T.codes.METAL, white);
    T.cone(c, 2.2, 0.1, top.y, B.b.h, o, white, T.codes.GLOW, { segs: 10 });
    B.plate = [ring]; B.plateBase = podH; B.plateTop = shaft;
    return true;
  },

  // ---------------------------------------------------------------- The Address Dubai Mall: a slim crescent of gold glass with a sloped top
  'The Address - Dubai Mall': (T, B) => {
    const ring = T.ccw(B.outer[0]), ob = T.orientedBox(ring); if (!ob) return false;
    const sg = ob.u[1] >= 0 ? 1 : -1, H = B.b.h;
    const o = shaftO(B, '#cfb488', H, { center: ob.c, fh: 4.2 });
    T.slantTop(ring, 0, { c: ob.c, dir: [ob.u[0] * sg, ob.u[1] * sg], y0: H - 13, slope: 13 / (ob.len / 2) }, o, T.L.curtainC, T.codes.GLASSY, C('#b89a66'));
    B.plateTop = H - 28;
    return true;
  },

  // ---------------------------------------------------------------- Index Tower (Foster + Partners): the concrete cores close the east and
  // west ends, the long north and south faces are glass behind sun-shading louvres; OSM maps it as 31 parts
  'Index Tower': (T, B) => {
    const parts = B.b.parts || []; if (parts.length < 6) return false;
    const concrete = C('#d4c9b9'), glass = C('#5f7a88');
    let body = null;
    for (const part of parts) {
      const ring = T.ccw(part.p[0]), y0 = part.mh || 0, y1 = part.h;
      const core = String(part.c || '').toUpperCase() === '#BBAC9B';
      const oo = { ...B.o, base: y0, top: y1, wall: core ? concrete : glass, center: T.centroid(ring), fh: 4.0 };
      if (y1 - y0 < 5) { T.prism(ring, y0, y1, oo, T.codes.SOLID, C('#cbc5ba')); continue; }
      T.walls(ring, y0, y1, oo, core ? T.codes.SOLID : T.L.louvre, { color: core ? concrete : glass });
      T.cap([ring], y1, oo, core ? T.codes.SOLID : T.codes.ROOF + T.L.roofConcrete, core ? concrete : C('#cfd2d2'));
      if (y0 > 0.5) T.cap([ring], y0, oo, T.codes.SOLID, concrete, true);
      const a = Math.abs(T.signedArea(ring));
      if (!core && y1 > 300 && (!body || a > body.a)) body = { ring, a };
    }
    if (body) { B.plate = [body.ring]; B.plateTop = 300; }
    return true;
  },

  // ---------------------------------------------------------------- Rose Rayhaan: slim blue-glass tower tapering into a glass pyramid and spire
  'Rose Rayhaan by Rotana': (T, B) => {
    const ring = T.ccw(B.outer[0]), c = B.cen, H = B.b.h, glass = C('#7ea4c0');
    const o = shaftO(B, '#7ea4c0', H, { center: c, fh: 3.9 });
    const shaft = H - 52;
    T.walls(ring, 0, shaft, o, T.L.curtainB, { color: glass });
    T.loft(ring, [{ y: shaft, s: 1 }, { y: shaft + 12, s: 0.84 }, { y: shaft + 24, s: 0.58 }, { y: shaft + 32, s: 0.3 }], o, T.L.curtainB, { center: c, color: glass, capCode: T.codes.GLOW, capColor: C('#e8eef2') });
    T.cone(c, 1.3, 0.08, shaft + 30, H, o, C('#e8eef2'), T.codes.GLOW, { segs: 8 });
    B.plate = [ring]; B.plateTop = shaft;
    return true;
  },

  // ---------------------------------------------------------------- Gevora Hotel: gold glass, a stepped crown, a glass lantern and spire
  'Gevora Hotel': (T, B) => {
    const ring = T.ccw(B.outer[0]), c = B.cen, H = B.b.h, gold = C('#c8a05a');
    const o = shaftO(B, '#c8a05a', H, { center: c, fh: 3.9 });
    const shaft = H - 56;
    T.walls(ring, 0, shaft, o, T.L.curtainA, { color: gold });
    const top = setbacks(T, o, ring, c, shaft, [[12, 0.86], [10, 0.72], [8, 0.56]], T.L.curtainA, gold, C('#d9d2c0'));
    T.loft(top.ring, [{ y: top.y }, { y: top.y + 6, s: 0.8 }], o, T.codes.GLASSY, { center: c, color: C('#d8b878'), capCode: T.codes.GLOW, capColor: C('#efe2c2') });
    T.cone(c, 1.5, 0.08, top.y + 5, H, o, C('#efe2c2'), T.codes.GLOW, { segs: 8 });
    B.plate = [ring]; B.plateTop = shaft;
    return true;
  },

  // ---------------------------------------------------------------- Il Primo: pale glass between white fins; a glass lantern inside a
  // crown of fins that light up at night
  'Il Primo': (T, B) => {
    const tower = largestPart(T, B.b); if (!tower) return false;
    const ring = T.ccw(tower.p[0]), c = T.centroid(ring), H = B.b.h, podH = B.b.oh || 16;
    podiumDeck(T, B, T.ccw(B.outer[0]), podH, { tower: ring });
    const o = shaftO(B, '#86a8c0', H, { center: c, fh: 4.2 });
    const shaft = H - 22;
    T.walls(ring, podH, shaft, { ...o, base: podH }, T.L.finGlass, { color: C('#86a8c0') });
    T.parapetRoof(ring, shaft, 1.4, o, T.codes.ROOF + T.L.roofConcrete, C('#d6dadc'), C('#f1f1ee'));
    T.loft(T.scaleRing(ring, c, 0.6), [{ y: shaft }, { y: H - 6 }], o, T.codes.GLASSY, { center: c, color: C('#9cc2d8'), capCode: T.codes.GLOW, capColor: C('#eef0ee') });
    T.scaleRing(ring, c, 0.97).forEach((p, i) => { if (i % 2 === 0) T.beam([p[0], p[1], shaft], [p[0], p[1], H], 0.9, o, C('#f3f3f0'), T.codes.GLOW); });
    B.plate = [ring]; B.plateBase = podH; B.plateTop = shaft;
    return true;
  },

  // ---------------------------------------------------------------- Al Yaqoub Tower: modelled on London's Elizabeth Tower (Big Ben): a
  // stone shaft, a clock stage with a face on every side (lit at night), a steep slate spire with gilded pinnacles
  'Al Yaqoub Tower': (T, B) => {
    const ring = T.ccw(B.outer[0]), c = B.cen, H = B.b.h;
    const stone = C('#e4d5b8'), slate = C('#5a6670'), gold = C('#d2ad62');
    const o = shaftO(B, '#e4d5b8', H, { center: c, fh: 3.6 });
    const shaft = 246, st = shaft + 20;
    T.walls(ring, 0, shaft, o, T.L.stoneGlass, { color: stone });
    const stage = T.scaleRing(ring, c, 1.05);
    T.prism(stage, shaft, st, o, T.codes.SOLID, stone, T.codes.SOLID, stone);
    for (let i = 0; i < stage.length; i++) {
      const a = stage[i], b = stage[(i + 1) % stage.length], e = norm(sub(b, a));
      wallDisc(T, o, lerp2(a, b, 0.5), [e[1], -e[0]], shaft + 10, Math.min(7, dist(a, b) * 0.22), C('#f6ecd2'), T.codes.GLOW);
    }
    T.loft(stage, [{ y: st, s: 1 }, { y: st + 9, s: 0.8 }, { y: H - 24, s: 0.12 }], o, T.codes.METAL, { center: c, color: slate, capCode: T.codes.METAL, capColor: slate });
    for (const p of T.scaleRing(stage, c, 0.9)) T.cone(p, 1.4, 0.1, st, st + 17, o, gold, T.codes.GLOW, { segs: 8 });
    T.cone(c, 1.0, 0.06, H - 27, H, o, gold, T.codes.GLOW, { segs: 8 });
    B.plateTop = shaft;
    return true;
  },

  // ---------------------------------------------------------------- Dusit Thani: an inverted Y like hands joined in the Thai greeting:
  // two legs, then a body whose long faces fold up into a ridge under a gilded needle
  'Dusit Thani': (T, B) => {
    const ring = T.ccw(B.outer[0]), ob = T.orientedBox(ring); if (!ob) return false;
    const c = ob.c, v = ob.v, H = B.b.h, glass = C('#4e87a6');
    const o = shaftO(B, '#4e87a6', H, { center: c, fh: 3.7 });
    const legTop = 46, ridge = H - 8, w2 = ob.wid / 2, gap = 5, eave = 112;
    for (const [a0, a1] of [[-w2 - 1, -gap], [gap, w2 + 1]]) { const r = slab(ring, c, v, a0, a1); if (r) T.walls(T.ccw(r), 0, legTop, { ...o, base: 0 }, T.L.curtainC, { color: glass }); }
    const mid = slab(ring, c, v, -gap, gap); if (mid) T.cap([T.ccw(mid)], legTop, o, T.codes.SOLID, C('#b8c4cc'), true);
    for (const [a0, a1, sg] of [[-w2 - 1, 0, 1], [0, w2 + 1, -1]]) {
      const r = slab(ring, c, v, a0, a1); if (!r) continue;
      T.slantTop(T.ccw(r), legTop, { c, dir: v, y0: ridge, slope: (sg * (ridge - eave)) / w2 }, { ...o, base: 0 }, T.L.curtainC, T.codes.GLASSY, C('#5f97b5'));
    }
    T.cone(c, 1.1, 0.06, ridge - 2, H, o, C('#d9c28a'), T.codes.GLOW, { segs: 8 });
    B.plate = [ring]; B.plateBase = legTop; B.plateTop = eave;
    return true;
  },

  // ---------------------------------------------------------------- Sheikh Rashid Tower (Dubai World Trade Centre, 1979): tall pointed
  // arches in a pale precast grid, a plant storey and the mast
  'Sheikh Rashid Tower': (T, B) => {
    const ring = T.ccw(B.outer[0]), c = B.cen, H = B.b.h;
    const o = shaftO(B, '#efe7d8', H, { center: c, fh: 3.5 });
    const roof = H - 12;
    T.walls(ring, 0, roof, o, T.L.arches, { color: C('#efe7d8') });
    T.parapetRoof(ring, roof, 2.2, o, T.codes.ROOF + T.L.roofConcrete, C('#cfc9bd'), C('#f2ece0'));
    T.prism(T.ccw(T.scaleRing(ring, c, 0.45)), roof, roof + 6, { ...o, base: roof }, T.codes.SOLID, C('#e8e1d3'));
    T.cone(c, 0.8, 0.08, roof + 6, H, o, C('#e0e3e5'), T.codes.METAL, { segs: 6 });
    B.plateTop = roof;
    return true;
  },

  // ---------------------------------------------------------------- One Za'abeel's The Link: the horizontal block joining the two towers
  // 100 m up and cantilevering past them, an infinity pool running out along the cantilever
  'The Link': (T, B) => {
    const ring = T.ccw(B.outer[0]), ob = T.orientedBox(ring); if (!ob) return false;
    const y0 = B.b.mh || 100, y1 = B.b.h;
    const o = { ...B.o, base: y0, top: y1, center: ob.c, fh: 4.6 };
    T.walls(ring, y0, y1, o, T.L.ribbon, { color: C('#9fbfd2') });
    T.cap([ring], y0, o, T.codes.METAL, C('#c9cfd3'), true);
    const inner = T.parapetRoof(ring, y1, 1.2, o, T.codes.ROOF + T.L.roofDeck, C('#cfc7b8'), C('#eef0f0'));
    const sg = ob.u[0] <= 0 ? 1 : -1, u = [ob.u[0] * sg, ob.u[1] * sg]; // the cantilever runs out to the north-west
    const pool = slab(inner, ob.c, u, ob.len * 0.2, ob.len / 2 - 2);
    if (pool) T.cap([T.insetRing(T.ccw(pool), 2.5)], y1 + 0.2, o, T.codes.POOL, C('#3fcde0'));
    B.plate = B.outer; B.plateBase = y0; B.plateTop = y1;
    return true;
  },

  // ---------------------------------------------------------------- Dubai Opera: a dhow. The glazed prow faces Burj Khalifa and the
  // roof rises toward it; the hull is clad in ribbed metal
  'Dubai Opera': (T, B) => {
    const ring = T.ccw(B.outer[0]), ob = T.orientedBox(ring); if (!ob) return false;
    const sg = dot(ob.u, [0.78, 0.63]) >= 0 ? 1 : -1, u = [ob.u[0] * sg, ob.u[1] * sg];
    const L2 = ob.len / 2, H = B.b.h;
    const o = shaftO(B, '#c3ccd2', H, { center: ob.c, fh: 6 });
    const prow = (a, b) => (dot(sub(a, ob.c), u) + dot(sub(b, ob.c), u)) / 2 > L2 * 0.35;
    T.slantTop(ring, 0, { c: ob.c, dir: u, y0: H - 12, slope: 12 / L2 }, o, T.codes.METAL, T.codes.METAL, C('#d4d9dc'),
      { codeFor: (a, b) => (prow(a, b) ? T.codes.GLASSY : T.codes.METAL), colorFor: (a, b) => (prow(a, b) ? C('#86abc0') : C('#c3ccd2')) });
    B.plateTop = 20;
    return true;
  },

  // ---------------------------------------------------------------- The Dubai Mall (DP Architects, 2008)
  // On its OSM outline, with the roof laid out as it is seen from Burj Khalifa (data-raw/research/malls/dubai-mall):
  // a pale roof plate crossed by three ribbed skylight arcs that run from the road side at the Fashion Avenue end,
  // through a ringed disc and the Star Atrium's disc with its dark eight-pointed star, and on along the lake front;
  // the largest drum at the Fashion Avenue end, the waterfront drum beside the Souk Al Bahar bridge, a dark glass
  // slot between them; the central barrel vault from the Grand Drive drum; four round skylights; the gold Souk dome
  // in its pyramid roof; a square of small domes; the wavy five-vault hall over the cinema end. On the road front:
  // the gold cylinder under its white disc canopy, the pointed-arch Souk portal and the red box.
  // Positions are in the mall's own axes (a: metres from the centre toward the cinema end; b: toward the road
  // front), arranged from the photographs and the mall's floor map, not measured: OSM gives only the outline. The
  // height (28 m) is an estimate; none is published.
  'The Dubai Mall': (T, B) => {
    const ring = T.ccw(B.outer[0]), ob = T.orientedBox(ring); if (!ob) return false;
    const H = 28, K = T.codes, lite = T.lite, r = B.r;
    let u = ob.u; if (dot(u, [0.88, -0.48]) < 0) u = [-u[0], -u[1]];
    const v = [-u[1], u[0]], c = ob.c;
    const at = (a, b) => [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b];
    const rect = (a0, a1, b0, b1) => T.ccw([at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)]);
    const stone = C('#e3c9ab'), plate = C('#cbc5b8'), white = C('#e6e4de'), discC = C('#d3d5d8'), metal = C('#c2c1b9'), dark = C('#1d2a37'), gold = C('#d7b27e');
    const o = { ...B.o, wall: stone, base: 0, top: H + 14, fh: 7, center: c };
    const inR = (q, m = 0) => T.pointInRing(q, ring) && (m <= 0 || edgeDist(q, ring) > m);
    // drums that stand on a round part of the outline take that part's own centre and radius
    const roundParts = fitArcs(ring).filter((q) => q.sweep > 1 && q.R > 12 && q.R < 80);
    const onArc = (a, b, R) => { const q = at(a, b); let best = null, bd = 62; for (const k of roundParts) { const e = dist(q, k.c); if (e < bd) { bd = e; best = k; } } return best ? [dot(sub(best.c, c), u), dot(sub(best.c, c), v), best.R] : [a, b, R]; };
    T.walls(ring, 0, H, o, K.STONE, { color: stone }); // plain precast: the lake front is dressed by layers/burjLake.js
    const inner = T.parapetRoof(ring, H, 1.6, o, K.ROOF + T.L.roofConcrete, plate, C('#e6dcc8'));
    const y = H + 0.1, keep = []; // keep: discs of roof that plant must stay off
    // drums and discs: a low cylinder under a white roof (flat, or a very shallow cone)
    const drum = (a, b, R, h, { wall = white, top = discC, flat = false, y0 = y } = {}) => {
      const q = at(a, b); keep.push([q, R + 6]);
      const oo = { ...o, center: q };
      T.cone(q, R, R, y0, y0 + h, oo, wall, K.SOLID, { segs: lite ? 20 : 48, cap: flat });
      if (!flat) T.cone(q, R, R * 0.1, y0 + h, y0 + h + R * 0.07, oo, top, K.SOLID, { segs: lite ? 20 : 48 });
      return q;
    };
    // ---- the wavy hall over the cinema end: one roof of five waves, on a raised block
    {
      const a0 = 246, a1 = 356, b0 = -52, b1 = 176, zb = H + 6, amp = 4.6;
      if ([at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)].every((q) => inR(q))) {
        T.prism(rect(a0, a1, b0, b1), H, zb, { ...o, base: H }, K.SOLID, C('#d2c8b6'));
        const wave = (t) => zb + 0.4 + amp * (1 - Math.cos(2 * Math.PI * 5 * t));
        T.surface((sx, t) => { const q = at(a0 + (a1 - a0) * sx, b0 + (b1 - b0) * t); return [q[0], q[1], wave(t)]; }, 2, lite ? 30 : 70, o, metal, K.METAL, { uLen: a1 - a0, vLen: 0 });
        for (const [aa, flip] of [[a0, true], [a1, false]]) T.surface((sx, t) => { const q = at(aa, b0 + (b1 - b0) * t); return [q[0], q[1], zb + sx * (wave(t) - zb)]; }, 1, lite ? 30 : 70, o, C('#b9b8b0'), K.SOLID, { flip });
        keep.push([at((a0 + a1) / 2, (b0 + b1) / 2), 130]);
      }
      // beside it on the lake side: a low free-form roof of two rounded lobes
      drum(268, -122, 34, 3, { top: C('#c5c4bc') }); drum(322, -104, 27, 3, { top: C('#c5c4bc') });
    }
    // ---- the three ribbed skylight arcs and the discs they run through
    const ringDisc = at(-176, -30), star = at(-38, -102);
    const arcs = [
      bend(at(-218, 104), at(-222, 30), at(-190, -16)),
      bend(at(-160, -42), at(-110, -84), at(-66, -98)),
      bend(at(-8, -104), at(90, -128), at(206, -130), 10),
    ];
    for (const pts of arcs) if (pts.every((q) => inR(q, 6))) { sweptVault(T, o, pts, y, 11, 6.5, white, K.SKY); for (const q of pts) keep.push([q, 16]); }
    drum(-176, -30, 21, 3.2, { flat: true });
    if (!lite) for (const [R0, R1] of [[15, 18], [8, 11]]) T.cap([T.ccw(T.circleRing(ringDisc[0], ringDisc[1], R1, 32)), T.circleRing(ringDisc[0], ringDisc[1], R0, 32).reverse()], y + 3.25, { ...o, center: ringDisc }, K.SOLID, C('#8f9894'));
    drum(-38, -102, 28, 4, { flat: true });
    T.cap([T.ccw(starRing(star, 18, 5.5, 8, Math.atan2(u[1], u[0])))], y + 4.06, { ...o, center: star }, K.SOLID, dark);
    { const [a, b, R] = onArc(-218, 122, 20); drum(a, b, R, 3, {}); }
    // ---- the largest drum (Fashion Avenue end), the waterfront drum by the bridge, the dark glass slot between
    { const [a, b, R] = onArc(-206, -140, 56); drum(a, b, R, 2.4, { wall: C('#dccfb8') }); const q = drum(a, b, R * 0.8, 6, {}); T.cone(q, 4, 1.2, y + 6 + R * 0.8 * 0.07, y + 8.6 + R * 0.8 * 0.07, { ...o, center: q }, dark, K.GLASSY, { segs: 16 }); }
    { const [a, b, R] = onArc(8, -158, 40); const q = drum(a, b, R, 5, { wall: C('#c6beb0') }); T.cone(q, 6.5, 3, y + 5 + R * 0.07, y + 7.4 + R * 0.07, { ...o, center: q }, dark, K.GLASSY, { segs: 16 }); }
    { const sl = rect(-150, -52, -134, -102); if (sl.every((q) => inR(q))) { T.prism(sl, y, y + 1.2, { ...o, base: H }, K.SOLID, white, K.GLASSY, dark); keep.push([at(-101, -118), 56]); } }
    // ---- the central barrel vault from the Grand Drive drum, and the long vault down the Fashion Avenue tip
    barrel(T, o, at(-56, 132), at(-56, -44), y, 25, 15, white, K.SOLID); keep.push([at(-56, 44), 92]);
    T.prism(rect(-84, -28, 132, 158), y, y + 5, { ...o, base: H }, K.SOLID, C('#d6d0c4'));
    if ([at(-372, -18), at(-262, -18)].every((q) => inR(q, 10))) { vault(T, o, at(-372, -18), at(-262, -18), y, 9, 6, white); keep.push([at(-317, -18), 60]); }
    // ---- four round skylights, the Souk's gold dome in its pyramid roof, the square of small domes
    for (const b of [78, 48, 18, -12]) { const q = at(-126, b); keep.push([q, 16]); T.cone(q, 11.5, 11.5, y, y + 1.1, { ...o, center: q }, white, K.SOLID, { segs: 28, cap: false }); T.cap([T.ccw(T.circleRing(q[0], q[1], 10.6, 28))], y + 1.0, { ...o, center: q }, K.SKY, white); }
    {
      const pc = [72, 42], hb = 42, ht = 15, z1 = y + 8.5, base = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const Bq = T.ccw(base.map(([i2, j2]) => at(pc[0] + i2 * hb, pc[1] + j2 * hb))), cq = at(pc[0], pc[1]);
      const Tq = Bq.map((q) => [cq[0] + (q[0] - cq[0]) * (ht / hb), cq[1] + (q[1] - cq[1]) * (ht / hb)]);
      for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4; T.quad([Bq[k][0], Bq[k][1], y], [Bq[k2][0], Bq[k2][1], y], [Tq[k2][0], Tq[k2][1], z1], [Tq[k][0], Tq[k][1], z1], { ...o, center: cq }, C('#d2c9b6'), K.SOLID); }
      T.cap([Tq], z1, { ...o, center: cq }, K.SOLID, C('#bfb6a2'));
      T.dome(cq, 12.5, 12.5, z1, 8.5, { ...o, center: cq }, gold, K.METAL, { segs: lite ? 16 : 28, rings: 7 });
      keep.push([cq, 64]);
    }
    {
      const pc = [150, 88], hs = 38, z1 = y + 2.2;
      T.prism(rect(pc[0] - hs, pc[0] + hs, pc[1] - hs, pc[1] + hs), y, z1, { ...o, base: H }, K.SOLID, C('#d8d4ca'));
      for (let i2 = -2; i2 <= 2; i2++) for (let j2 = -2; j2 <= 2; j2++) { if (Math.abs(i2) === 2 && Math.abs(j2) === 2) continue; const q = at(pc[0] + i2 * 14, pc[1] + j2 * 14); T.dome(q, 3.8, 3.8, z1, 2.6, { ...o, center: q }, white, K.SKY, { segs: lite ? 8 : 12, rings: 4 }); }
      keep.push([at(pc[0], pc[1]), 58]);
    }
    // ---- the road front: gold cylinder under a white disc canopy, the pointed-arch Souk portal, the red box,
    // a glazed bow at the Fashion Avenue corner
    {
      const edgeB = (a) => { let m = 0; for (let b = 120; b < 260; b += 2) if (inR(at(a, b))) m = b; return m; }; // the road front at a
      const gq = at(-56, edgeB(-56) - 10);
      T.cone(gq, 22, 22, 0, H + 7, { ...o, center: gq }, C('#e4ab5a'), K.METAL, { segs: lite ? 20 : 40 });
      T.cone(at(-56, edgeB(-56) + 6), 34, 34, 6.4, 7.4, { ...o, center: gq }, C('#f0ebe2'), K.SOLID, { segs: lite ? 20 : 40 });
      T.cone(gq, 26, 26, H + 7, H + 8, { ...o, center: gq }, C('#f0ebe2'), K.SOLID, { segs: lite ? 20 : 40 });
      keep.push([gq, 34]);
      const pb = edgeB(34), rb = edgeB(96);
      T.prism(rect(20, 48, pb - 8, pb + 4), 0, H + 6, o, K.STONE, C('#cfa671'));
      if (!lite) { const q0 = at(26, pb + 4.1), q1 = at(42, pb + 4.1), qm = at(34, pb + 4.1); T.quad([q1[0], q1[1], 0], [q0[0], q0[1], 0], [q0[0], q0[1], 16], [q1[0], q1[1], 16], o, C('#3a2c20'), K.SCREEN); T.quad([q1[0], q1[1], 16], [q0[0], q0[1], 16], [qm[0], qm[1], 25], [qm[0], qm[1], 25], o, C('#3a2c20'), K.SCREEN); }
      T.prism(rect(82, 112, rb - 12, rb + 3), 0, H + 3, o, K.SOLID, C('#9d0315'));
      const bq = at(-132, edgeB(-132) - 4); T.cone(bq, 17, 17, 0, H - 3, { ...o, center: bq }, C('#7c9aa8'), K.GLASSY, { segs: lite ? 16 : 32 });
    }
    // ---- roof plant and solar arrays, kept off the skylights
    if (!lite && inner) {
      const free = (q, m) => T.pointInRing(q, inner) && edgeDist(q, ring) > m + 4 && !keep.some(([k, R]) => dist(q, k) < R + m);
      for (const [pa, pb2] of [[196, 28], [12, 110], [150, -40]]) { const pr = rect(pa - 26, pa + 26, pb2 - 15, pb2 + 15); if (pr.every((q) => free(q, 0))) T.prism(pr, y, y + 0.9, { ...o, base: H }, K.SOLID, C('#3b424a')); }
      let n = 0; const ang = Math.atan2(u[1], u[0]);
      for (let k = 0; k < 1400 && n < 110; k++) {
        const q = at((r() - 0.5) * ob.len, (r() - 0.5) * ob.wid), w = 4 + r() * 6, d2 = 3 + r() * 4;
        if (!free(q, 7)) continue;
        T.prism(T.ccw(T.rectRing(q[0], q[1], w, d2, ang)), y, y + 1.6 + r() * 2.2, { ...o, base: H }, K.SOLID, C(r() < 0.5 ? '#b9b6ad' : '#a8a79f'));
        keep.push([q, 5]); n++;
      }
    }
    B.plate = B.outer; B.plateTop = H;
    return true;
  },

  // ---------------------------------------------------------------- the other malls (data-raw/research/malls/others)
  // Heights of the mall bodies are estimates from storey counts and photographs (none is published); colours were
  // sampled from the photographs; what stands where on each roof is arranged from photographs and descriptions.

  // Mall of the Emirates (2005): terracotta-pink walls with cream trims, a long pale-green glazed vault down the spine
  // and a dark glass dome; the multi-storey car park on its OSM part; and Ski Dubai (sourced: an 85 m indoor mountain
  // with a 400 m run): a straight silver tube of rounded section rising from behind the Kempinski hotel to a head
  // carried high on slab legs.
  'Mall of the Emirates': (T, B) => {
    const kit = mallKit(T, B, { h: 22, axis: [1, 0.1], wall: '#c98a66', trim: '#e9dcc0', roof: '#d9d6cc', portal: '#b6704a', tile: '#9a5a3c',
      vaults: [[-0.5, 0.42, 0.45, 0.42, 11, 8]], domes: [[0.12, 0.72, 15, 10, '#2b3c4e', 'glass']], doors: [[0.05, 1, 'arch', 34], [-0.22, 1, 'tower', 9]] });
    if (!kit) return false;
    const K = T.codes, { o, y } = kit;
    const parts = (B.b.parts || []).map((q) => T.ccw(q.p[0])).sort((x, z) => Math.abs(T.signedArea(x)) - Math.abs(T.signedArea(z)));
    if (parts[1]) T.cap([parts[1]], y + 0.22, o, K.SOLID, C('#777b7f'));
    const ski = parts[0], ob = ski && T.orientedBox(ski);
    if (ob) {
      let u = ob.u; if (dot(u, sub(ob.c, [5860, 4327])) < 0) u = [-u[0], -u[1]]; // the tube climbs away from the hotel at its foot
      const n = [-u[1], u[0]], L = ob.len, hwid = Math.min(36, ob.wid / 2), hh = 11, silver = C('#a9b2ae');
      const A = [ob.c[0] - u[0] * L / 2, ob.c[1] - u[1] * L / 2], zc = (t) => 15 + 59 * t;
      const P = (t, a, k = 1) => { const q = [A[0] + u[0] * L * t, A[1] + u[1] * L * t]; return [q[0] + n[0] * hwid * Math.cos(a) * k, q[1] + n[1] * hwid * Math.cos(a) * k, zc(t) + hh * Math.sin(a) * k]; };
      T.surface((t, w) => P(t, 2 * Math.PI * w), T.lite ? 8 : 20, T.lite ? 12 : 24, { ...o, top: 86 }, silver, K.METAL, { flip: true, uLen: L, vLen: 150 });
      for (const [t, flip] of [[0, false], [1, true]]) T.surface((w, k) => P(t, 2 * Math.PI * w, 0.04 + 0.96 * k), T.lite ? 12 : 24, 1, { ...o, top: 86 }, C('#98a19d'), K.METAL, { flip });
      for (const t of [0.62, 0.9]) {
        const q = [A[0] + u[0] * L * t, A[1] + u[1] * L * t], hx = hwid * 0.7;
        T.prism(T.ccw([[q[0] - n[0] * hx - u[0] * 3, q[1] - n[1] * hx - u[1] * 3], [q[0] + n[0] * hx - u[0] * 3, q[1] + n[1] * hx - u[1] * 3], [q[0] + n[0] * hx + u[0] * 3, q[1] + n[1] * hx + u[1] * 3], [q[0] - n[0] * hx + u[0] * 3, q[1] - n[1] * hx + u[1] * 3]]), 0, zc(t) - hh + 2, o, K.SOLID, C('#c9c6bd'));
      }
    }
    return true;
  },
  // (the Kempinski at the foot of the slope: dusty-pink render)
  'Kempinski Hotel': (T, B) => { B.ap.layer = T.L.punched; B.ap.wall = C('#c9a58c'); B.o.wall = B.ap.wall; B.ap.roof = C('#9a5a3c'); return false; },

  // Ibn Battuta Mall (2005): a single-storey strip of six themed courts, Andalusia at the south-west end to China at
  // the north-east: flat cream roof, the turquoise Persia dome and the white India dome with corner turrets,
  // sandstone Andalusia towers under tile pyramids, the Egypt Court's limestone pylons, the China Court's red walls
  // under yellow tiles.
  'Ibn Battuta Mall': (T, B) => {
    // +a runs from the Andalusia end (south-west) to the China end (north-east); +b is toward Sheikh Zayed Road.
    // The courts sit along the spine at b = -0.4 (arranged from the architect's order and the scale model, not measured).
    const kit = mallKit(T, B, { h: 11, axis: [0.7, 0.7], wall: '#dcc79d', trim: '#efe3c8', roof: '#ded5c0', portal: '#cba46b', tile: '#aa7a56', layer: T.codes.STONE,
      vaults: [[-0.68, -0.4, -0.6, -0.4, 5, 3.5], [-0.42, -0.4, -0.26, -0.4, 5, 3.5], [-0.06, -0.4, 0.1, -0.4, 5, 3.5], [0.3, -0.4, 0.42, -0.4, 5, 3.5], [0.62, -0.4, 0.8, -0.4, 5, 3.5], [0.06, 0.08, 0.06, 0.86, 7, 4.5]],
      domes: [[0.2, -0.42, 20, 17, '#2aa7b8', 'solid'], [0.52, -0.38, 13, 10, '#f4f1ea', 'solid'], [0.47, -0.48, 4, 3.5, '#f4f1ea', 'solid'], [0.57, -0.48, 4, 3.5, '#f4f1ea', 'solid'], [0.47, -0.28, 4, 3.5, '#f4f1ea', 'solid'], [0.57, -0.28, 4, 3.5, '#f4f1ea', 'solid'],
        [-0.54, -0.4, 6, 4.5, '#f4f1ea', 'solid'], [-0.5, -0.4, 8, 6, '#f4f1ea', 'solid'], [-0.46, -0.4, 6, 4.5, '#f4f1ea', 'solid']],
      hips: [[-0.9, -0.78, -0.64, -0.42, 14, '#d9b98a', '#aa7a56', 6], [-0.76, -0.7, -0.56, -0.44, 13, '#e3c79c', '#aa7a56', 4], [0.84, 0.95, -0.82, -0.38, 15, '#7a1f1c', '#e2c98a', 6], [0.68, 0.8, -0.82, -0.66, 14, '#7a1f1c', '#e2c98a', 5]],
      blocks: [[-0.2, -0.1, -0.56, -0.24, 16, '#cba46b', '#d9cdb0']],
      lights: [[-0.62, 0.3, -0.36, 0.3, 24, 6], [-0.62, 0.08, -0.36, 0.08, 24, 6], [0.52, 0.16, 0.82, 0.16, 24, 6], [-0.3, -0.25, -0.05, -0.25, 22, 5], [0.15, -0.6, 0.6, -0.6, 22, 5]],
      doors: [[-0.9, -0.3, 'tower', 10], [-0.78, -0.75, 'tower', 9], [-0.15, -0.6, 'arch', 26], [0.9, -0.95, 'canopy', 22], [0.3, -0.75, 'arch', 20], [0.25, -0.25, 'arch', 18]], plant: 60 });
    return !!kit;
  },

  // Dubai Hills Mall (2022): cream stone, a roof gridded with solar panels, an oval central skylight and four round
  // glass domes; at the south-east tip the diagrid drum that houses the indoor Storm Coaster (about 50 m; the
  // figure comes from a contractor quoted on a forum, so treat it as approximate).
  'Dubai Hills Mall': (T, B) => {
    const kit = mallKit(T, B, { h: 18, axis: [0.77, -0.64], wall: '#f1ebe2', trim: '#faf5f1', roof: '#d8d2c4', solar: true, plant: 26,
      vaults: [[-0.07, 0, 0.07, 0, 22, 9]], domes: [[-0.36, 0.3, 9, 6, '#dfe6ea', 'glass'], [0.36, 0.3, 9, 6, '#dfe6ea', 'glass'], [-0.36, -0.3, 9, 6, '#dfe6ea', 'glass'], [0.36, -0.3, 9, 6, '#dfe6ea', 'glass']],
      doors: [[-0.2, 1, 'canopy', 26], [0.3, -1, 'canopy', 26]] });
    if (!kit) return false;
    const { ring, c, o } = kit;
    let tip = ring[0]; for (const q of ring) if (q[0] - q[1] > tip[0] - tip[1]) tip = q;
    const d = norm(sub(c, tip)), q = [tip[0] + d[0] * 26, tip[1] + d[1] * 26], oo = { ...o, center: q, top: 52, fh: 6 };
    T.cone(q, 23, 23, 0, 50, oo, C('#cfd8dd'), T.L.frame != null ? T.L.frame : T.codes.GLASSY, { segs: T.lite ? 16 : 32 });
    T.dome(q, 23, 23, 50, 5, oo, C('#dfe6ea'), T.codes.SKY, { segs: T.lite ? 16 : 32, rings: 5 });
    return true;
  },

  // Nakheel Mall on Palm Jumeirah (2019; OSM: Palm Jumeirah Mall): cream curved walls; the roof is a pale plaza with
  // large slabs of bright green artificial turf, two each side of the monorail that runs through the middle, and
  // twin glass half-domes facing each other over the track.
  'Palm Jumeirah Mall': (T, B) => {
    if (B.area < 5000) return false; // (a small canopy carries the same name)
    const turf = '#6b8f2c';
    const kit = mallKit(T, B, { h: 25, wall: '#eadfd5', trim: '#f6efe6', roof: '#e2dbcf', layer: T.codes.SOLID, plant: 14,
      blocks: [[-0.82, -0.14, 0.2, 0.8, 29, '#eadfd5', turf], [0.14, 0.82, 0.2, 0.8, 29, '#eadfd5', turf], [-0.82, -0.14, -0.8, -0.2, 29, '#eadfd5', turf], [0.14, 0.82, -0.8, -0.2, 29, '#eadfd5', turf]],
      domes: [[0, 0.22, 13, 11, '#cfe0ea', 'glass'], [0, -0.22, 13, 11, '#cfe0ea', 'glass']] });
    return !!kit;
  },

  // Dubai Marina Mall (2008): a beige crescent on the yacht basin; flat roof with sand-coloured upper boxes
  'Dubai Marina Mall': (T, B) => !!mallKit(T, B, { h: 24, axis: [0.41, 0.91], wall: '#cdb086', trim: '#e6d6b8', roof: '#d9d3c6', blocks: [[-0.52, -0.06, -0.3, 0.42, 28, '#cfb68f', '#d6cfc0'], [0.08, 0.5, -0.45, 0.2, 27.5, '#d8c29c', '#d2cbbc'], [-0.3, 0.3, -0.78, -0.58, 27, '#cfb68f', '#d6cfc0']], domes: [[0.02, 0.62, 15, 5, '#dfe6ea', 'glass']], lights: [[-0.72, -0.4, -0.72, 0.3, 15, 4.5], [0.66, -0.2, 0.66, 0.3, 15, 4.5]], doors: [[0, -1, 'glass', 22], [-0.4, 1, 'canopy', 30]], plant: 16 }),
  // Mercato (2002): Italianate street fronts in ochre and salmon, one glazed barrel vault across the block, a
  // striped campanile on the Jumeirah Beach Road side, terracotta tiles
  'Mercato Shopping Mall': (T, B) => !!mallKit(T, B, { h: 13, axis: [0.58, 0.82], wall: '#dcb184', trim: '#f1e2c6', roof: '#cfc6b6', portal: '#e6c9a0', tile: '#b06a48', rim: [4.5, 3, '#b06a48'], vaults: [[0, -0.78, 0, 0.78, 12, 9]], hips: [[-0.52, -0.24, 0.6, 0.9, 16, '#e3b98c', '#b06a48', 4], [0.24, 0.52, 0.6, 0.9, 16, '#d9937a', '#b06a48', 4], [-0.5, -0.24, -0.9, -0.62, 15.5, '#e6c9a0', '#b06a48', 4], [0.24, 0.5, -0.9, -0.62, 15.5, '#cfa27c', '#b06a48', 4], [0.7, 0.93, 0.56, 0.9, 15.5, '#c9d0a8', '#b06a48', 4]], lights: [[-0.62, -0.4, -0.62, 0.4, 14, 4.5], [0.62, -0.4, 0.62, 0.4, 14, 4.5]], doors: [[0.25, 1, 'tower', 9], [-0.2, 1, 'arch', 18]], plant: 8 }),
  // Al Barsha Mall: a white box with sandstone ends, a barrel rooflight down the spine and a round lantern
  'Al Barsha Mall': (T, B) => !!mallKit(T, B, { h: 15, axis: [0.62, 0.78], wall: '#f0f0ee', trim: '#ffffff', roof: '#d6d4cd', layer: T.codes.SOLID, vaults: [[-0.7, 0, 0.7, 0, 7, 5]], domes: [[0.35, 0.45, 10, 6, '#dfe6ea', 'glass']], blocks: [[-1, -0.86, -1, 1, 17, '#d0895a'], [0.86, 1, -1, 1, 17, '#d0895a']], lights: [[-0.6, -0.5, 0.6, -0.5, 16, 4.5], [-0.6, 0.5, 0.15, 0.5, 16, 4.5]], doors: [[0, -1, 'canopy', 60]], plant: 12 }),
  // Circle Mall (2021): a long beige bar with one continuous barrel skylight down the spine and a taller anchor box
  'Circle Mall': (T, B) => !!mallKit(T, B, { h: 22, axis: [-0.42, 0.91], wall: '#edca97', trim: '#f6e6c8', roof: '#d9d3c6', layer: T.codes.SOLID, vaults: [[-0.85, 0, 0.5, 0, 7, 5]], blocks: [[0.62, 0.98, -0.92, 0.92, 26, '#e6c48f']], lights: [[-0.8, 0.5, 0.4, 0.5, 18, 4], [-0.8, -0.5, 0.4, -0.5, 18, 4]], doors: [[-0.3, 1, 'glass', 12], [0.15, -1, 'glass', 12]], plant: 8 }),
  // The Springs Souk: a low sand-coloured box with a cream cornice and pointed-arch portal towers
  'The Springs Souk': (T, B) => !!mallKit(T, B, { h: 14, axis: [0.65, -0.76], wall: '#d8c0a2', trim: '#efe6d2', roof: '#d8d0c0', portal: '#d3b99c', vaults: [[-0.4, 0, 0.4, 0, 6, 3]], doors: [[-0.5, 1, 'arch', 16], [0.4, 1, 'arch', 16], [0, -1, 'arch', 16]], plant: 10 }),
  // Times Square Center: a plain white box beside the metro with a thin canopy along the whole front
  'Times Square Center': (T, B) => !!mallKit(T, B, { h: 16, wall: '#f1f3f4', trim: '#ffffff', roof: '#d6d6d2', layer: T.codes.SOLID, lights: [[-0.6, 0, 0.6, 0, 15, 5], [-0.6, 0.5, 0.6, 0.5, 30, 4], [-0.6, -0.5, 0.6, -0.5, 30, 4]], doors: [[0, 1, 'canopy', 90], [0, -1, 'canopy', 60]], plant: 10 }),
  // Oasis Mall: beige stone, a round glass dome over the central atrium, a glazed corner rotunda
  'Oasis Mall': (T, B) => !!mallKit(T, B, { h: 25, wall: '#cdb09c', trim: '#e6d6c6', roof: '#d6cfc4', domes: [[0, 0, 18, 10, '#dfe6ea', 'glass']], lights: [[-0.7, -0.55, 0.7, -0.55, 18, 5], [-0.7, 0.4, -0.3, 0.4, 18, 5], [0.3, 0.4, 0.7, 0.4, 18, 5]], doors: [[-1, 1, 'drum', 22], [0, 1, 'glass', 26]], plant: 10 }),
  // Bay Avenue (Business Bay): the white stepped podium under the Executive Towers
  'Bay Avenue \u200bMall': (T, B) => !!mallKit(T, B, { h: 14, wall: '#ebe2da', trim: '#f7f2ec', roof: '#dcd8cf', layer: T.codes.SOLID, plant: 14 }),
  // Gate Avenue at DIFC: a long raised deck of grey paving between the towers
  'The Gate Avenue': (T, B) => !!mallKit(T, B, { h: 10, wall: '#d9dde0', trim: '#eef1f4', roof: '#7b828c', layer: T.codes.SOLID, plant: 0, blocks: [[-0.42, -0.4, -0.9, 0.9, 24, '#eef1f4'], [0, 0.02, -0.9, 0.9, 24, '#eef1f4'], [0.42, 0.44, -0.9, 0.9, 24, '#eef1f4']] }),
  // Cityland Mall (2019): the round Central Park garden open to the sky in the middle of the roof (a hole in the OSM
  // outline), ringed by a pale silver canopy that sweeps up and outward
  'Cityland Mall': (T, B) => {
    const kit = mallKit(T, B, { h: 10, wall: '#e9dfcf', trim: '#f5eee2', roof: '#d9d4c8', portal: '#8c3b43', layer: T.codes.SOLID, doors: [[0, 1, 'arch', 40]], plant: 30 });
    if (!kit) return false;
    for (const h of B.outer.slice(1)) { const hc = T.centroid(h), R = Math.max(...h.map((q) => dist(q, hc))); T.cone(hc, R + 1, R + 13, 10, 15.5, { ...kit.o, center: hc }, C('#cfd3d6'), T.codes.METAL, { segs: T.lite ? 24 : 56, cap: false }); }
    return true;
  },
  // Souk Madinat Jumeirah: a forest of wind towers on stepped sand-coloured roofs
  'Souk Madinat Jumeirah': (T, B) => { arabesque(T, B, { wall: '#e6dcc4', roof: '#d9cdb0', towers: 18 }); return true; },

  // ---------------------------------------------------------------- the lakeside Arabian quarter
  'Souk Al Bahar': (T, B) => { arabesque(T, B, { towers: 6 }); return true; },
  'The Palace - Downtown Dubai': (T, B) => { arabesque(T, B, { wall: '#d9bf98', towers: 4, pavilions: true }); return true; },
  'Al Manzil': (T, B) => { arabesque(T, B, { wall: '#ddc5a0', towers: 3 }); return true; },

  'Sky Bridge': (T, B) => {
    B.ap.layer = T.L.balconyA; B.ap.wall = C('#efebe3'); B.o.wall = B.ap.wall;
    T.defaultParts(B, { noPodium: true, wall: B.ap.wall });
    const top = B.b.parts.reduce((m, p) => (!m || p.h > m.h ? p : m), null);
    if (top) T.cap([T.insetRing(T.ccw(top.p[0]), 2.4)], top.h + 0.25, { ...B.o, top: top.h }, T.codes.POOL, C('#3fcfe0'));
    return true;
  },
};
