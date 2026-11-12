// Small 2D geometry toolkit used by the data build (coordinates are [east, north] metres).

export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function bboxOf(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

export function pointInRing(pt, ring) {
  const x = pt[0], y = pt[1]; let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(pt, poly) {
  if (!pointInRing(pt, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(pt, poly[i])) return false;
  return true;
}

// Removes the duplicated closing vertex and consecutive duplicates.
export function openRing(ring) {
  const out = [];
  for (const p of ring) {
    const l = out[out.length - 1];
    if (!l || Math.abs(l[0] - p[0]) > 1e-3 || Math.abs(l[1] - p[1]) > 1e-3) out.push(p);
  }
  if (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-3 && Math.abs(f[1] - l[1]) < 1e-3) out.pop();
  }
  return out;
}

// Ensure outer ring is CCW and holes are CW.
export function orientPoly(poly) {
  return poly.map((r, i) => {
    const a = signedArea(r);
    return (i === 0 ? a < 0 : a > 0) ? r.slice().reverse() : r;
  });
}

// Douglas-Peucker on an open polyline.
export function simplifyLine(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0], py = pts[i][1];
      let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function simplifyRing(ring, tol) {
  if (ring.length < 5) return ring;
  // split at the farthest point from vertex 0 so both halves are open polylines
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tol);
  const b = simplifyLine(ring.slice(far).concat([ring[0]]), tol);
  const out = a.concat(b.slice(1, -1));
  return out.length >= 3 ? out : ring;
}

// Sutherland-Hodgman clip of a ring against an axis-aligned rectangle.
export function clipRingToRect(ring, R) {
  let out = ring;
  const inside = [
    (p) => p[0] >= R.x0, (p) => p[0] <= R.x1, (p) => p[1] >= R.y0, (p) => p[1] <= R.y1,
  ];
  const inter = [
    (a, b) => { const t = (R.x0 - a[0]) / (b[0] - a[0]); return [R.x0, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (R.x1 - a[0]) / (b[0] - a[0]); return [R.x1, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (R.y0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), R.y0]; },
    (a, b) => { const t = (R.y1 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), R.y1]; },
  ];
  for (let e = 0; e < 4; e++) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const ci = inside[e](cur), pi = inside[e](prev);
      if (ci) { if (!pi) out.push(inter[e](prev, cur)); out.push(cur); }
      else if (pi) out.push(inter[e](prev, cur));
    }
  }
  return out;
}

// Liang-Barsky segment clip. Returns [t0, t1] or null.
export function clipSegment(a, b, R) {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy], q = [a[0] - R.x0, R.x1 - a[0], a[1] - R.y0, R.y1 - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; }
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return [t0, t1];
}

export const lerpPt = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Clip a polyline to a rect -> list of pieces. Each piece: {pts, startIn, endIn}
// startIn/endIn tell whether the piece starts/ends strictly inside (no boundary crossing).
export function clipPolyline(pts, R) {
  const pieces = []; let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const s = clipSegment(a, b, R);
    if (!s) { if (cur) { cur.endIn = false; pieces.push(cur); cur = null; } continue; }
    const [t0, t1] = s;
    if (!cur) cur = { pts: [t0 > 0 ? lerpPt(a, b, t0) : a.slice()], startIn: t0 === 0 };
    else if (t0 > 0) {
      cur.endIn = false; pieces.push(cur);
      cur = { pts: [lerpPt(a, b, t0)], startIn: false };
    }
    cur.pts.push(t1 < 1 ? lerpPt(a, b, t1) : b.slice());
    if (t1 < 1) { cur.endIn = false; pieces.push(cur); cur = null; }
  }
  if (cur) { cur.endIn = true; pieces.push(cur); }
  return pieces.filter((p) => p.pts.length >= 2);
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// Seeded PRNG (mulberry32)
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform grid spatial index over bounding boxes.
export class Grid {
  constructor(cell = 50) { this.cell = cell; this.map = new Map(); }
  key(i, j) { return i * 100003 + j; }
  insert(bb, item) {
    const c = this.cell;
    for (let i = Math.floor(bb[0] / c); i <= Math.floor(bb[2] / c); i++)
      for (let j = Math.floor(bb[1] / c); j <= Math.floor(bb[3] / c); j++) {
        const k = this.key(i, j); let a = this.map.get(k); if (!a) this.map.set(k, (a = [])); a.push(item);
      }
  }
  query(x, y) { return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(y / this.cell))) || []; }
}

// Keep the part of a ring where dot(p - o, n) >= 0 (convex clip by a half-plane).
export function clipHalf(poly, o, n) {
  const out = [];
  const f = (p) => (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}

// Minimum-area oriented bounding box: {center, u (long axis), v, len, wid, fill}
export function obb(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.3) continue;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], v = [-u[1], u[0]];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) { const pu = p[0] * u[0] + p[1] * u[1], pv = p[0] * v[0] + p[1] * v[1]; if (pu < u0) u0 = pu; if (pu > u1) u1 = pu; if (pv < v0) v0 = pv; if (pv > v1) v1 = pv; }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, u, v, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { u, v, u0, u1, v0, v1 } = best;
  if (v1 - v0 > u1 - u0) { const nu = v, nv = [-u[0], -u[1]]; const t0 = v0, t1 = v1; v0 = -u1; v1 = -u0; u0 = t0; u1 = t1; u = nu; v = nv; }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { center: [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv], u, v, len: u1 - u0, wid: v1 - v0, fill: Math.abs(signedArea(ring)) / Math.max(1e-6, (u1 - u0) * (v1 - v0)) };
}

export function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

// Douglas-Peucker for [x, y, z] polylines: keeps a point when it deviates more than tolXY in plan or
// tolZ in height from the chord (z is interpolated along the chord parameter).
export function simplify3(pts, tolXY, tolZ) {
  if (pts.length <= 2) return pts.map((p) => p.slice());
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const a = pts[i0], b = pts[i1];
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    let worst = 1, wi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const p = pts[i];
      let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const exy = Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) / tolXY;
      const ez = Math.abs((a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t - (p[2] || 0)) / tolZ;
      const e = Math.max(exy, ez);
      if (e > worst) { worst = e; wi = i; }
    }
    if (wi >= 0) { keep[wi] = 1; stack.push([i0, wi], [wi, i1]); }
  }
  return pts.filter((_, i) => keep[i]).map((p) => p.slice());
}
