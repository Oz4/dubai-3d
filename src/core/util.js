import * as THREE from 'three';

export const GLSL_NOISE = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for(int i=0;i<4;i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; } return s; }
float band(float x, float a, float b, float aa){ return smoothstep(a-aa, a+aa, x) * (1.0 - smoothstep(b-aa, b+aa, x)); }
`;

export const srgb = (hex) => new THREE.Color(hex); // THREE.Color parses hex as sRGB and stores linear

// Deterministic PRNG
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) { const p = ring[i], q = ring[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
export function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n], f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [ring[0][0], ring[0][1]];
  return [cx / (3 * a), cy / (3 * a)];
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

// Triangulate a polygon ([outer, ...holes] in [east, north]) -> {verts: [[e,n]...], tris: [i,j,k...]}, CCW from above.
export function triangulate(poly) {
  const contour = poly[0].map((p) => new THREE.Vector2(p[0], p[1]));
  const holes = poly.slice(1).map((r) => r.map((p) => new THREE.Vector2(p[0], p[1])));
  let tris;
  try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { return null; }
  const verts = poly[0].concat(...poly.slice(1));
  const out = [];
  for (const t of tris) {
    const a = verts[t[0]], b = verts[t[1]], c = verts[t[2]];
    const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cr >= 0) out.push(t[0], t[1], t[2]); else out.push(t[0], t[2], t[1]);
  }
  return { verts, tris: out };
}

// Flat polygons -> BufferGeometry in world space (x = east, z = -north) at height y
export function polygonsGeometry(polys, y, opts = {}) {
  const pos = [], idx = [], uv = [];
  let base = 0;
  for (const poly of polys) {
    const t = triangulate(poly); if (!t) continue;
    const yy = typeof y === 'function' ? y(poly) : y;
    for (const v of t.verts) {
      pos.push(v[0], yy, -v[1]);
      if (opts.uvBounds) { const b = opts.uvBounds; uv.push((v[0] - b.x0) / b.w, (v[1] - b.y0) / b.h); }
    }
    // CCW in (east, north) maps to an upward-facing triangle in world space (x = east, z = -north).
    for (let i = 0; i < t.tris.length; i += 3) idx.push(base + t.tris[i], base + t.tris[i + 1], base + t.tris[i + 2]);
    base += t.verts.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (opts.uvBounds) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Ribbon along a polyline of [east, north, elev] points. Pushes into the supplied builder.
// builder: {pos:[], nor:[], uv:[], idx:[], extra?:{name:[...]} }
export function addRibbon(B, pts, width, yOffset, extraPerVertex) {
  const n = pts.length; if (n < 2) return;
  const hw = width / 2;
  let s = 0; const base = B.pos.length / 3;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
    let d0x = p[0] - prev[0], d0y = p[1] - prev[1], d1x = next[0] - p[0], d1y = next[1] - p[1];
    const l0 = Math.hypot(d0x, d0y) || 1, l1 = Math.hypot(d1x, d1y) || 1;
    d0x /= l0; d0y /= l0; d1x /= l1; d1y /= l1;
    if (i === 0) { d0x = d1x; d0y = d1y; }
    if (i === n - 1) { d1x = d0x; d1y = d0y; }
    // left normals
    const n0x = -d0y, n0y = d0x, n1x = -d1y, n1y = d1x;
    let mx = n0x + n1x, my = n0y + n1y; const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
    const cos = mx * n1x + my * n1y; const k = 1 / Math.max(0.35, cos);
    if (i > 0) s += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    const y = (p[2] || 0) + yOffset;
    // left (t=+1) then right (t=-1)
    B.pos.push(p[0] + mx * hw * k, y, -(p[1] + my * hw * k));
    B.pos.push(p[0] - mx * hw * k, y, -(p[1] - my * hw * k));
    B.nor.push(0, 1, 0, 0, 1, 0);
    B.uv.push(s, 1, s, -1);
    if (extraPerVertex) for (const [name, vals] of Object.entries(extraPerVertex)) { B.extra[name].push(...vals, ...vals); }
    if (i > 0) {
      const a = base + (i - 1) * 2, b = a + 1, c = a + 2, d = a + 3;
      // (a,b,c) is CCW in (east, north) -> faces up in world space
      B.idx.push(a, b, c, b, d, c);
    }
  }
}

export function newBuilder(extraNames = []) {
  const B = { pos: [], nor: [], uv: [], idx: [], extra: {} };
  for (const e of extraNames) B.extra[e] = [];
  return B;
}
export function builderGeometry(B, extraSizes = {}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nor, 3));
  if (B.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
  for (const [name, arr] of Object.entries(B.extra)) g.setAttribute(name, new THREE.Float32BufferAttribute(arr, extraSizes[name] || 1));
  g.setIndex(B.idx);
  // builders often live on in closures (updaters); their plain arrays are dead weight once copied
  B.pos.length = B.nor.length = B.uv.length = B.idx.length = 0;
  for (const arr of Object.values(B.extra)) arr.length = 0;
  return g;
}

export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Drop the CPU copies of a static geometry's arrays right after they reach the GPU (big maps would
// otherwise keep every vertex twice). `keep` lists attributes still read on the CPU ('index' included).
export function freeAfterUpload(geo, keep = []) {
  // an empty array, not null: raycasts still read normals/uvs of the hit triangle (they come back undefined)
  const drop = function () { this.array = new this.array.constructor(0); };
  for (const [k, a] of Object.entries(geo.attributes)) if (!keep.includes(k)) a.onUploadCallback = drop;
  if (geo.index && !keep.includes('index')) geo.index.onUploadCallback = drop;
  return geo;
}
