import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { freeAfterUpload, GLSL_NOISE, triangulate, signedArea, centroid, rng, hashStr, pointInRing } from '../core/util.js';
import { createFacadeTextures, LAYERS, L } from './facades.js';
import { LANDMARKS } from './landmarks.js';
import { HOUSE_KITS } from './houses.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const MODE = { NORMAL: 0, HIGHLIGHT: 1, DIM: 2, FLAT: 3, SELECTED: 4, HIDDEN: 5, CUT: 6 };
// the streaming grid (metres): light chunks and detailed cells share it, so a cell's detail replaces exactly
// one light chunk
export const CELL = 1000;
export const cellKey = (c) => Math.floor(c[0] / CELL) + ',' + Math.floor(c[1] / CELL);
// surface codes stored in aWall.w
const SOLID = 100, ROOF = 200, SLOPE = 300, HELI = 500, METAL = 600, GLOW = 610, GLASSY = 620, POOL = 630, LEDGE = 640, FABRIC = 650, ALU = 660, SKY = 670, CALLIG = 680, SLATV = 690, SLATH = 700, STONE = 710, SCREEN = 720;

const pal = (...c) => c;
// an illustrated palette: vivid glass, warm stone and render with a few stronger accents, varied roof decks
const GLASS = { blue: '#3f86c9', teal: '#2f9fa8', green: '#49a890', silver: '#9cc0d6', navy: '#2f68a6', bronze: '#b98f5a', sky: '#68b4e0', ice: '#a8d2e6' };
const WALLS = pal('#f6f1e6', '#f0dcb8', '#e8c898', '#dfe3e2', '#f5e6cf', '#edd3aa', '#e6b890', '#d99a72', '#cfdde6');
const JBR = pal('#e6c08a', '#dcab70', '#efd09c', '#d49a62');
const ROOFS = pal('#cbc4b6', '#bfb9ad', '#d2c8b4', '#b6b3ae', '#c9b49a', '#a9b3b8', '#d8cfc0');
const VILLA_F = pal('#eedfc4', '#e8d5b5', '#f1e7d6', '#e2cba6', '#efe4cf');
const VILLA_H = pal('#ecdcc0', '#e6d1ae', '#f0e3cb');
const TERRACOTTA = pal('#c4683f', '#b75d3c', '#cf7a4e', '#a9553a', '#c97047');
const HOUSE = new Set(['house', 'detached', 'villa', 'semidetached_house', 'terrace', 'bungalow']);

const OVERRIDES = {
  'Cayan Tower': { twist: Math.PI / 2, layer: L.curtainB, wall: GLASS.ice },
  'Infinity Tower': { twist: Math.PI / 2, layer: L.curtainB, wall: GLASS.ice },
  'Ocean Heights': { layer: L.curtainA, wall: GLASS.blue },
  'Elite Residences': { layer: L.curtainB, wall: GLASS.navy },
  'The Torch': { layer: L.curtainC, wall: '#7f97a5' },
  'DAMAC Heights': { layer: L.curtainB, wall: GLASS.sky },
  'Almas Tower': { layer: L.curtainB, wall: GLASS.teal },
  'Uptown Dubai Tower 1': { layer: L.curtainA, wall: GLASS.silver },
  'Ciel Tower': { layer: L.curtainC, wall: GLASS.ice },
  'Address Jumeirah Resort': { layer: L.curtainB, wall: GLASS.ice },
  'Marina Gate 1': { layer: L.curtainA, wall: GLASS.blue }, 'Marina Gate 2': { layer: L.curtainA, wall: GLASS.blue }, 'Marina Gate 3': { layer: L.curtainA, wall: GLASS.blue },
  'Five JBR': { layer: L.curtainA, wall: GLASS.sky },
  'Emirates Crown': { layer: L.curtainC, wall: GLASS.sky },
  'Marina 101': { layer: L.curtainB, wall: '#8ea6b6' },
  '23 Marina': { layer: L.curtainA, wall: '#9fb2c6' },
  'Princess Tower': { layer: L.punched, wall: '#d9c9b4' },
  // from data-raw/tower-appearance.json (sourced descriptions; unknowns left to the district palette)
  'Marina Pinnacle': { layer: L.curtainC, wall: '#8aa6bd' },          // blue-tinted glass, silver frames
  'Armada Tower 1': { layer: L.curtainA, wall: '#5c88b4' },           // Pilkington Arctic Blue glazing
  'Armada Tower 2': { layer: L.curtainA, wall: '#5c88b4' },
  'Armada Tower 3': { layer: L.curtainA, wall: '#5c88b4' },
  'MAG 214': { layer: L.curtainB, wall: '#9aa8b2' },                  // grey glass
  'Indigo Tower': { layer: L.curtainC, wall: '#4f6495' },             // indigo glass on an A-frame
  'Lake Terrace': { layer: L.balconyA, wall: '#eef0ee' },             // white with turquoise accents
  'LIWA Heights': { layer: L.balconyB, wall: '#6f95bf' },             // blue glass, recessed balconies
  'Concorde Tower': { layer: L.balconyA, wall: '#a9bccb' },           // glass with balconies
  'Gold Crest Views 2': { layer: L.balconyB, wall: '#efe9dd' },       // horizontal balcony bands
  'Swiss Tower': { layer: L.curtainA, wall: '#8fa7b8' },
  'Al Fattan Marine Towers': { layer: L.curtainB, wall: '#a7bcc6' },  // silver and turquoise glass
  'Silverene Tower A': { layer: L.curtainB, wall: '#b4c4cf' }, 'Silverene Tower B': { layer: L.curtainB, wall: '#b4c4cf' },
  'Cavalli Tower': { layer: L.balconyB, wall: '#7f97a8' },            // glass with deep balconies
  'Five JBR': { layer: L.stoneGlass, wall: '#e4dccd' },               // curtain wall + stone cladding
  'La Vie Residences': { layer: L.balconyA, wall: '#f3f1ec' },        // tapered balcony bands
  // Downtown, Business Bay & DIFC (styling from photographs: facade type and glass tone only)
  'The Address - Sky View Tower 1': { layer: L.frame, wall: '#f1f0eb' }, 'The Address - Sky View Tower 2': { layer: L.frame, wall: '#f1f0eb' },
  'Address Residences': { layer: L.finGlass, wall: '#8aa6ba' },
  'Address Residences Dubai Opera Tower 1': { layer: L.finGlass, wall: '#9ab4c6' }, 'Address Residences Dubai Opera Tower 2': { layer: L.finGlass, wall: '#9ab4c6' },
  'Burj Vista Tower 1': { layer: L.finGlass, wall: '#7f9fb7' }, 'Burj Vista Tower 2': { layer: L.finGlass, wall: '#7f9fb7' },
  'Opera Grand': { layer: L.balconyA, wall: '#eef0ee' }, 'Grande Signature Residences': { layer: L.balconyB, wall: '#eef0ee' },
  'Forte': { layer: L.curtainA, wall: '#8fb0c6' }, 'Boulevard Point': { layer: L.curtainB, wall: '#7fa0b8' },
  'Burj Royale': { layer: L.balconyA, wall: '#f1f0ec' }, 'Vida Residence': { layer: L.curtainC, wall: '#9fb5c4' }, 'Vida Dubai Mall': { layer: L.curtainC, wall: '#9fb5c4' },
  'St. Regis Residences Downtown': { layer: L.curtainB, wall: '#a9b9c4' }, 'The Dubai EDITION': { layer: L.stoneGlass, wall: '#e2d6c2' },
  'Boulevard Plaza Tower 1': { layer: L.curtainA, wall: '#6f93ad' }, 'Boulevard Plaza Tower 2': { layer: L.curtainA, wall: '#6f93ad' },
  'Burj Residences 1': { layer: L.stoneGlass, wall: '#e6d9c2' }, 'Burj Residences 3': { layer: L.stoneGlass, wall: '#e6d9c2' }, 'Burj Residences 4': { layer: L.stoneGlass, wall: '#e6d9c2' },
  'Burj Residences 5': { layer: L.stoneGlass, wall: '#e6d9c2' }, 'Burj Residences 6': { layer: L.stoneGlass, wall: '#e6d9c2' }, 'Burj Residences 7': { layer: L.stoneGlass, wall: '#e6d9c2' },
  'Burj Residences 8': { layer: L.stoneGlass, wall: '#e6d9c2' }, 'Burj Residences 9': { layer: L.stoneGlass, wall: '#e6d9c2' },
  '29 Boulevard Tower 1': { layer: L.balconyA, wall: '#f0ede6' }, '29 Boulevard Tower 2': { layer: L.balconyA, wall: '#f0ede6' },
  'Millenium Tower': { layer: L.curtainB, wall: '#7d9bb0' }, 'Al Wasl Tower': { layer: L.finGlass, wall: '#9db3c2' },
  'ICD Brookfield Place': { layer: L.curtainA, wall: '#a7bccb' }, 'Burj Daman': { layer: L.curtainB, wall: '#8aa7bb' },
  'Central Park Office Tower': { layer: L.curtainC, wall: '#6e98b5' }, 'Central Park Residential Tower': { layer: L.curtainC, wall: '#6e98b5' },
  'Emirates Financial Towers': { layer: L.curtainB, wall: '#88a9c0' }, 'Liberty House': { layer: L.curtainA, wall: '#7e9cb2' },
  'Chelsea Tower': { layer: L.curtainA, wall: '#5d86a8' }, 'The Tower Plaza Hotel': { layer: L.curtainA, wall: '#86a6bd' },
  '21st Century Tower': { layer: L.curtainB, wall: '#aebfcc' }, 'Rolex Tower': { layer: L.curtainA, wall: '#4f6f8c' },
  'The A-Tower': { layer: L.curtainB, wall: '#8ea8bb' }, 'Blue Tower (HHHR Tower)': { layer: L.curtainA, wall: '#5e8cb4' },
  'Conrad Dubai': { layer: L.curtainB, wall: '#a6b8c4' }, 'Park Place': { layer: L.curtainA, wall: '#7f9db4' },
  'Latifa Tower': { layer: L.curtainB, wall: '#9fb0bf' }, 'City Tower 1': { layer: L.curtainA, wall: '#86a3b8' },
  "One Za'abeel Tower 1": { layer: L.ribbon, wall: '#9db6c8' }, "One Za'abeel Tower 2": { layer: L.ribbon, wall: '#9db6c8' },
  'The Tower': { layer: L.curtainA, wall: '#8aa4b8' }, 'Capricorn Tower': { layer: L.curtainB, wall: '#6f8fa6' },
  'Sheraton Grand Hotel': { layer: L.curtainC, wall: '#93abbd' }, 'Fairmont Dubai': { layer: L.stoneGlass, wall: '#e8dcc5' },
  'Voco Hotel and Nassima Towers': { layer: L.curtainB, wall: '#8fa9bc' }, 'Mashreqbank HQ': { layer: L.curtainA, wall: '#7fa0b6' },
};

// districts with a shared architectural style that the per-building data doesn't capture
const STYLE_ZONES = [
  // Downtown's Old Town: low-rise Arabian revival (sand-coloured walls, arched windows, brown roof decks)
  { box: [13500, 12000, 14250, 12620], maxH: 50, layer: L.villa, walls: ['#dcc29c', '#d6b98f', '#e2cba8', '#d9bd94'], roofs: ['#a07f60', '#9a785a', '#a8876a'], roofLayer: L.roofDeck },
];
function styleZone(b, c, ap) {
  if (OVERRIDES[b.n] || b.v) return;
  for (const z of STYLE_ZONES) {
    if (b.h > z.maxH || c[0] < z.box[0] || c[0] > z.box[2] || c[1] < z.box[1] || c[1] > z.box[3]) continue;
    ap.layer = z.layer; ap.roofLayer = z.roofLayer;
    ap.wall = new THREE.Color(z.walls[Math.floor(ap.seed * z.walls.length)]);
    ap.roof = new THREE.Color(z.roofs[Math.floor(((ap.seed * 7.31) % 1) * z.roofs.length)]);
    return;
  }
}

// OSM colour tags are often plain CSS names or very saturated values; map to believable facade tones.
const NAMED = {
  blue: '#5b8fb9', lightblue: '#8db6cf', darkblue: '#3d6488', navy: '#3d5a7a', white: '#efede7', grey: '#aaaaa6', gray: '#aaaaa6',
  silver: '#c3c8cc', black: '#44474c', brown: '#9b7653', beige: '#e3d3b0', cream: '#efe4cc', yellow: '#e2cf86', gold: '#c9a24b',
  red: '#b5523b', maroon: '#8a4a3c', orange: '#d38a52', green: '#6c9a74', darkgreen: '#4f7558', teal: '#4f9a9c', turquoise: '#5fb3b3',
  pink: '#d9a5a0', purple: '#8a7396', sand: '#dcc59c', tan: '#cdb08a',
};
const _hsl = {};
function safeColor(c, fallback) {
  let out = new THREE.Color(fallback);
  try {
    if (c) {
      const key = String(c).trim().toLowerCase().replace(/[\s_-]/g, '');
      if (NAMED[key]) out = new THREE.Color(NAMED[key]);
      else if (/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.test(key)) out = new THREE.Color(key.startsWith('#') ? key : '#' + key);
      else return out;
      out.getHSL(_hsl, THREE.SRGBColorSpace);
      out.setHSL(_hsl.h, Math.min(_hsl.s, 0.42), THREE.MathUtils.clamp(_hsl.l, 0.4, 0.9), THREE.SRGBColorSpace);
    }
  } catch { /* ignore */ }
  return out;
}

function appearance(b, area) {
  const r = rng(hashStr(String(b.i) + (b.n || '')));
  const pick = (a) => a[Math.floor(r() * a.length)];
  const ty = b.t || '';
  const h = b.h, d = b.d || 'other';
  let layer, wall, roof, roofLayer = L.roofConcrete;
  if (ty === 'podium') { layer = L.podium; wall = pick(['#e6dfd2', '#dcd7cd', '#e9e3d6', '#d3d7d9', '#ded4c2']); roof = '#d6cdbb'; roofLayer = L.roofPodium; }
  else if (ty === 'construction') { layer = L.construction; wall = '#c9c3b8'; roof = '#b4ada2'; }
  else if (['industrial', 'warehouse', 'service', 'garage', 'garages'].includes(ty) || (d === 'industrial' && h < 25)) {
    layer = L.industrial; wall = pick(['#d4d9dd', '#c6d0d8', '#ddd6ca', '#b9c6cf']); roof = pick(['#dfe3e6', '#cfd6dc', '#e6e2da']); roofLayer = L.roofMetal;
  } else if (d === 'jbr') {
    layer = h < 40 && area > 2000 ? L.podium : L.jbr; wall = pick(JBR); roof = '#d8cbb6';
    if (layer === L.podium) roofLayer = L.roofPodium;
  } else if (h > 60) {
    const x = r();
    if (d === 'jlt') {
      // JLT reads as a forest of cool-tinted glass: blue, grey, green, teal, indigo and silver,
      // with a few balcony and office towers (no documented gold/bronze glass there)
      if (x < 0.78) { layer = pick([L.curtainA, L.curtainB, L.curtainC]); wall = pick([GLASS.blue, GLASS.green, GLASS.teal, GLASS.silver, GLASS.navy, '#8d9aa4', '#5d6f9a', GLASS.sky]); }
      else if (x < 0.92) { layer = pick([L.balconyA, L.balconyB]); wall = pick([...WALLS, '#a9bccb']); } else { layer = L.office; wall = pick(WALLS); }
    } else if (d === 'beachfront') {
      if (x < 0.6) { layer = L.balconyA; wall = '#f6f5f1'; } else { layer = L.curtainB; wall = pick([GLASS.ice, GLASS.sky, GLASS.silver]); }
    } else {
      if (x < 0.45) { layer = pick([L.curtainA, L.curtainB, L.curtainC]); wall = pick([GLASS.blue, GLASS.teal, GLASS.silver, GLASS.navy, GLASS.sky]); }
      else if (x < 0.8) { layer = pick([L.balconyA, L.balconyB]); wall = pick(WALLS); }
      else if (x < 0.9) { layer = L.stoneGlass; wall = pick(['#eadcc1', '#e6d4b4', '#efe6d4']); }
      else { layer = L.punched; wall = pick(WALLS); }
    }
    roof = pick(ROOFS);
  } else if (h > 16) {
    const x = r();
    if (h < 36 && area > 2500 && ['marina', 'jbr', 'jlt', 'beachfront'].includes(d)) { layer = L.podium; wall = pick(WALLS); roofLayer = L.roofPodium; }
    else if (d === 'bluewaters') { layer = x < 0.5 ? L.balconyA : L.punched; wall = pick(['#efe6d6', '#f3efe7', '#e8dac3']); }
    else if (x < 0.4) { layer = L.punched; wall = pick(WALLS); }
    else if (x < 0.65) { layer = L.balconyB; wall = pick(WALLS); }
    else if (x < 0.85) { layer = L.office; wall = pick(WALLS); }
    else { layer = L.stoneGlass; wall = pick(['#eadcc1', '#efe6d4']); }
    roof = pick(ROOFS);
  } else {
    const x = r();
    layer = x < 0.5 ? L.punched : x < 0.8 ? L.office : L.podium; wall = pick(WALLS); roof = pick(ROOFS);
  }
  let wallC = new THREE.Color(wall), roofC = new THREE.Color(roof);
  if (b.c) wallC = safeColor(b.c, wall);
  if (b.rc) roofC = safeColor(b.rc, roof);
  const o = OVERRIDES[b.n];
  let twist = 0;
  if (o) { if (o.layer != null) layer = o.layer; if (o.wall) wallC = new THREE.Color(o.wall); if (o.twist) twist = o.twist; }
  return { layer, wall: wallC, roof: roofC, roofLayer, twist, seed: r(), r };
}

// ---------------------------------------------------------------- polygon helpers
function insetRing(ring, d) {
  const n = ring.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = ring[(i + n - 1) % n], p1 = ring[i], p2 = ring[(i + 1) % n];
    let ax = p1[0] - p0[0], ay = p1[1] - p0[1], bx = p2[0] - p1[0], by = p2[1] - p1[1];
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1; ax /= la; ay /= la; bx /= lb; by /= lb;
    const n0 = [-ay, ax], n1 = [-by, bx]; // inward (left) normals of a CCW ring
    const dot = n0[0] * n1[0] + n0[1] * n1[1];
    let k = d / Math.max(0.35, 1 + dot);
    const mx = (n0[0] + n1[0]) * k, my = (n0[1] + n1[1]) * k;
    const ml = Math.hypot(mx, my), lim = d * 3;
    out.push(ml > lim ? [p1[0] + (mx / ml) * lim, p1[1] + (my / ml) * lim] : [p1[0] + mx, p1[1] + my]);
  }
  return out;
}
function orientedBox(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]; const Ln = Math.hypot(b[0] - a[0], b[1] - a[1]); if (Ln < 0.3) continue;
    const u = [(b[0] - a[0]) / Ln, (b[1] - a[1]) / Ln], v = [-u[1], u[0]];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) { const pu = p[0] * u[0] + p[1] * u[1], pv = p[0] * v[0] + p[1] * v[1]; u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv); }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, u, v, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { u, v, u0, u1, v0, v1 } = best;
  if (v1 - v0 > u1 - u0) { const nu = v, nv = [-u[0], -u[1]]; const a0 = v0, a1 = v1; v0 = -u1; v1 = -u0; u0 = a0; u1 = a1; u = nu; v = nv; }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { c: [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv], u, v, len: u1 - u0, wid: v1 - v0, fill: Math.abs(signedArea(ring)) / Math.max(1e-6, (u1 - u0) * (v1 - v0)) };
}
const boxRing = (ob, hl, hw, du = 0, dv = 0) => [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([a, b]) => [ob.c[0] + ob.u[0] * (a + du) + ob.v[0] * (b + dv), ob.c[1] + ob.u[1] * (a + du) + ob.v[1] * (b + dv)]);
const ccw = (r) => (signedArea(r) < 0 ? r.slice().reverse() : r);

// Growable typed buffers: the city's geometry is built straight into Float32/Uint32 storage (plain JS
// arrays would cost 8+ bytes per number and gigabytes of garbage while a large map loads).
class Grow {
  constructor(T, n = 1 << 18) { this.T = T; this.a = new T(n); this.length = 0; }
  room(k) { if (this.length + k > this.a.length) { const b = new this.T(Math.max(this.length + k, this.a.length * 2)); b.set(this.a); this.a = b; } }
  p1(a) { this.room(1); this.a[this.length++] = a; }
  p2(a, b) { this.room(2); const o = this.length; this.a[o] = a; this.a[o + 1] = b; this.length += 2; }
  p3(a, b, c) { this.room(3); const o = this.length; this.a[o] = a; this.a[o + 1] = b; this.a[o + 2] = c; this.length += 3; }
  p4(a, b, c, d) { this.room(4); const o = this.length; this.a[o] = a; this.a[o + 1] = b; this.a[o + 2] = c; this.a[o + 3] = d; this.length += 4; }
  p6(a, b, c, d, e, f) { this.room(6); const o = this.length; const x = this.a; x[o] = a; x[o + 1] = b; x[o + 2] = c; x[o + 3] = d; x[o + 4] = e; x[o + 5] = f; this.length += 6; }
  take(T = this.T) { const out = new T(this.length); out.set(this.a.subarray(0, this.length)); this.a = new this.T(0); this.length = 0; return out; }
}

// ---------------------------------------------------------------- geometry builder
// One builder fills one mesh. lite = the whole-city view: the same massing, facades, roofs and landmarks,
// without balconies, parapets, rooftop plant or villa detail (a fraction of the triangles).
function createGeoBuilder(lite) {
  const F = Float32Array;
  const P = new Grow(F, 1 << 18), NOR = new Grow(F, 1 << 18), COL = new Grow(F, 1 << 18), BID = new Grow(F, 1 << 16), WALL = new Grow(F, 1 << 18), META = new Grow(F, 1 << 17), IDX = new Grow(Uint32Array, 1 << 18);
  let vc = 0;
  const push = (x, y, z, nx, ny, nz, c, bid, u, base, top, code, fh, seed) => {
    P.p3(x, y, z); NOR.p3(nx, ny, nz); COL.p3(c.r, c.g, c.b); BID.p1(bid); WALL.p4(u, base, top, code); META.p2(fh, seed);
    return vc++;
  };
  const quad = (a, b, c, d) => IDX.p6(a, b, c, a, c, d);
  const equipment = []; // [x, y, z, rotY, kind, bid]

  // vertical walls of a ring from y0 to y1; facade pattern anchored at `base`
  function walls(ring, y0, y1, o, code, opt = {}) {
    const lay = LAYERS[code] || LAYERS[0];
    const tileW = code < SOLID ? lay.tileW : 4;
    const slices = o.twist ? 28 : 1;
    const rot = (p, a) => { if (!a) return p; const c = Math.cos(a), s = Math.sin(a), dx = p[0] - o.center[0], dy = p[1] - o.center[1]; return [o.center[0] + dx * c - dy * s, o.center[1] + dx * s + dy * c]; };
    let u = 0;
    for (let i = 0; i < ring.length; i++) {
      const a0 = ring[i], b0 = ring[(i + 1) % ring.length];
      const Ln = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]); if (Ln < 0.05) continue;
      if (Ln > 4.5) u = -(Ln % tileW) / 2 + (opt.phase || 0); // centre the pattern on long walls
      for (let k = 0; k < slices; k++) {
        const ya = y0 + ((y1 - y0) * k) / slices, yb = y0 + ((y1 - y0) * (k + 1)) / slices;
        const g0 = o.twist ? (o.twist * (ya - o.base)) / (o.top - o.base) : 0, g1 = o.twist ? (o.twist * (yb - o.base)) / (o.top - o.base) : 0;
        const a = rot(a0, g0), b = rot(b0, g0), c = rot(b0, g1), d = rot(a0, g1);
        const am = rot(a0, (g0 + g1) / 2), bm = rot(b0, (g0 + g1) / 2);
        let dx = bm[0] - am[0], dn = bm[1] - am[1]; const l = Math.hypot(dx, dn) || 1; dx /= l; dn /= l;
        const sgn = opt.inward ? -1 : 1;
        const nx = dn * sgn, nz = dx * sgn;
        const col = opt.color || o.wall;
        const iA = push(a[0], ya, -a[1], nx, 0, nz, col, o.bid, u, o.base, o.top, code, o.fh, o.seed);
        const iB = push(b[0], ya, -b[1], nx, 0, nz, col, o.bid, u + Ln, o.base, o.top, code, o.fh, o.seed);
        const iC = push(c[0], yb, -c[1], nx, 0, nz, col, o.bid, u + Ln, o.base, o.top, code, o.fh, o.seed);
        const iD = push(d[0], yb, -d[1], nx, 0, nz, col, o.bid, u, o.base, o.top, code, o.fh, o.seed);
        if (opt.inward) quad(iB, iA, iD, iC); else quad(iA, iB, iC, iD);
      }
      u += Ln;
    }
  }
  function cap(rings, y, o, code, color, down = false, twist = 0) {
    const t = triangulate(rings); if (!t) return;
    const s0 = vc;
    const rot = (p) => { if (!twist) return p; const c = Math.cos(twist), s = Math.sin(twist), dx = p[0] - o.center[0], dy = p[1] - o.center[1]; return [o.center[0] + dx * c - dy * s, o.center[1] + dx * s + dy * c]; };
    for (const v of t.verts) { const q = rot(v); push(q[0], y, -q[1], 0, down ? -1 : 1, 0, color, o.bid, q[0] - o.center[0], q[1] - o.center[1], o.top, code, o.fh, o.seed); }
    for (let i = 0; i < t.tris.length; i += 3) {
      if (down) IDX.p3(s0 + t.tris[i], s0 + t.tris[i + 2], s0 + t.tris[i + 1]);
      else IDX.p3(s0 + t.tris[i], s0 + t.tris[i + 1], s0 + t.tris[i + 2]);
    }
  }
  // flat roof with a parapet: outer walls continue above the roof, inner face + coping, roof inside
  function parapetRoof(ring, top, parH, o, roofCode, roofColor, parColor) {
    if (lite) { cap([ring], top, o, roofCode, roofColor); return ring; }
    const inner = insetRing(ring, 0.38);
    walls(ring, top, top + parH, o, SOLID, { color: parColor });
    walls(inner, top, top + parH, o, SOLID, { color: parColor.clone().multiplyScalar(0.9), inward: true });
    // coping between outer and inner rings
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const a = ring[i], b = ring[j], c = inner[j], d = inner[i];
      const ia = push(a[0], top + parH, -a[1], 0, 1, 0, parColor, o.bid, 0, o.base, o.top, SOLID, o.fh, o.seed);
      const ib = push(b[0], top + parH, -b[1], 0, 1, 0, parColor, o.bid, 0, o.base, o.top, SOLID, o.fh, o.seed);
      const ic = push(c[0], top + parH, -c[1], 0, 1, 0, parColor, o.bid, 0, o.base, o.top, SOLID, o.fh, o.seed);
      const id = push(d[0], top + parH, -d[1], 0, 1, 0, parColor, o.bid, 0, o.base, o.top, SOLID, o.fh, o.seed);
      quad(ia, ib, ic, id);
    }
    cap([inner], top + 0.02, o, roofCode, roofColor);
    return inner;
  }
  // hip roof over an oriented box (terracotta tiles) with eaves, soffit and fascia
  function hipRoof(ob, top, o, color, overhang = 0.6, pitch = 0.47) {
    const Ln = ob.len + 2 * overhang, W = ob.wid + 2 * overhang;
    const hr = (W / 2) * Math.tan(pitch), rh = Math.max(0, (Ln - W) / 2);
    const P3 = (a, b, y) => [ob.c[0] + ob.u[0] * a + ob.v[0] * b, y, ob.c[1] + ob.u[1] * a + ob.v[1] * b];
    const e = [P3(-Ln / 2, -W / 2, top), P3(Ln / 2, -W / 2, top), P3(Ln / 2, W / 2, top), P3(-Ln / 2, W / 2, top)];
    const r0 = P3(-rh, 0, top + hr), r1 = P3(rh, 0, top + hr);
    const faces = [[e[0], e[1], r1, r0], [e[2], e[3], r0, r1], [e[1], e[2], r1], [e[3], e[0], r0]];
    for (const f of faces) {
      // face normal (world: x, y, z = -north)
      const w = f.map((p) => new THREE.Vector3(p[0], p[1], -p[2]));
      const n = new THREE.Vector3().subVectors(w[1], w[0]).cross(new THREE.Vector3().subVectors(w[2], w[0])).normalize();
      let order = w; if (n.y < 0) { order = w.slice().reverse(); n.negate(); }
      // slope UVs: along the eave and up the slope
      const ea = order.filter((p) => Math.abs(p.y - top) < 1e-3);
      const ax = ea.length >= 2 ? new THREE.Vector3().subVectors(ea[1], ea[0]).setY(0).normalize() : new THREE.Vector3(1, 0, 0);
      const ids = order.map((p) => {
        const su = p.x * ax.x + p.z * ax.z;
        const sv = (p.y - top) / Math.sin(pitch);
        return push(p.x, p.y, p.z, n.x, n.y, n.z, color, o.bid, su, sv, o.top, SLOPE + o.roofLayer, o.fh, o.seed);
      });
      if (ids.length === 4) quad(ids[0], ids[1], ids[2], ids[3]); else IDX.p3(ids[0], ids[1], ids[2]);
    }
    if (lite) return;
    // soffit + fascia
    const ring = [e[0], e[1], e[2], e[3]].map((p) => [p[0], p[2]]);
    cap([ring], top - 0.02, o, SOLID, o.wall.clone().multiplyScalar(0.8), true);
    walls(ring, top - 0.28, top + 0.02, o, SOLID, { color: o.wall.clone().multiplyScalar(0.95) });
  }
  function scatterEquipment(ring, y, bid, n, r, avoid) {
    if (lite) return;
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const placed = [];
    for (let k = 0; k < n * 8 && placed.length < n; k++) {
      const p = [x0 + r() * (x1 - x0), y0 + r() * (y1 - y0)];
      if (!pointInRing(p, ring)) continue;
      if (avoid && Math.hypot(p[0] - avoid[0], p[1] - avoid[1]) < avoid[2]) continue;
      if (placed.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 2.8)) continue;
      // keep 1.5 m away from the parapet
      let ok = true; for (let i = 0; i < ring.length && ok; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t)); if (Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) < 1.4) ok = false; }
      if (!ok) continue;
      placed.push(p);
      equipment.push([p[0], y, -p[1], r() * Math.PI, r() < 0.78 ? 0 : 1, bid]);
    }
  }

  // ---------------------------------------------------------------- landmark modelling toolkit
  const V3 = THREE.Vector3;
  const parapetColor = (ap) => (ap.layer <= L.curtainC || ap.layer === L.frame ? new THREE.Color('#dfe4e8') : ap.wall.clone().lerp(new THREE.Color('#ffffff'), 0.25));
  // Lofted shaft: base ring transformed per section {y, s (scale), r (rotation), dx, dy}
  function loft(base, sections, o, code, opt = {}) {
    const c = opt.center || o.center;
    const tf = (p, sec) => {
      const s = sec.s ?? 1, rr = sec.r ?? 0, cr = Math.cos(rr), sr = Math.sin(rr);
      const x = (p[0] - c[0]) * (sec.sx ?? s), y = (p[1] - c[1]) * (sec.sy ?? s);
      return [c[0] + x * cr - y * sr + (sec.dx || 0), c[1] + x * sr + y * cr + (sec.dy || 0)];
    };
    const rings = sections.map((sec) => base.map((p) => tf(p, sec)));
    const col = opt.color || o.wall;
    for (let k = 0; k < sections.length - 1; k++) {
      const y0 = sections[k].y, y1 = sections[k + 1].y, R0 = rings[k], R1 = rings[k + 1];
      let u = 0;
      for (let i = 0; i < base.length; i++) {
        const j = (i + 1) % base.length;
        const Lb = Math.hypot(base[j][0] - base[i][0], base[j][1] - base[i][1]); if (Lb < 0.05) continue;
        const A = new V3(R0[i][0], y0, -R0[i][1]), B = new V3(R0[j][0], y0, -R0[j][1]), C = new V3(R1[j][0], y1, -R1[j][1]), D = new V3(R1[i][0], y1, -R1[i][1]);
        const n = new V3().subVectors(B, A).cross(new V3().subVectors(D, A)).normalize();
        if (!Number.isFinite(n.x)) { u += Lb; continue; }
        // (opt.edge(i): a face of its own for the wall over base edge i, { code, color })
        const ef = opt.edge ? opt.edge(i) : null, ec = ef ? ef.code : code, ek = ef ? ef.color : col;
        const ia = push(A.x, A.y, A.z, n.x, n.y, n.z, ek, o.bid, u, o.base, o.top, ec, o.fh, o.seed);
        const ib = push(B.x, B.y, B.z, n.x, n.y, n.z, ek, o.bid, u + Lb, o.base, o.top, ec, o.fh, o.seed);
        const ic = push(C.x, C.y, C.z, n.x, n.y, n.z, ek, o.bid, u + Lb, o.base, o.top, ec, o.fh, o.seed);
        const id = push(D.x, D.y, D.z, n.x, n.y, n.z, ek, o.bid, u, o.base, o.top, ec, o.fh, o.seed);
        quad(ia, ib, ic, id);
        u += Lb;
      }
    }
    const topRing = rings[rings.length - 1];
    if (opt.cap !== false) cap([topRing], sections[sections.length - 1].y, o, opt.capCode ?? (ROOF + (o.roofLayer ?? L.roofConcrete)), opt.capColor || o.roof || col);
    return topRing;
  }
  // Ellipsoidal dome (or partial dome from latitude phi0)
  function dome(c, rx, rz, y0, h, o, color, code, opt = {}) {
    const segs = opt.segs || 32, rings = opt.rings || 10, phi0 = opt.phi0 || 0, base = vc;
    for (let k = 0; k <= rings; k++) {
      const phi = phi0 + (k / rings) * (Math.PI / 2 - phi0);
      for (let s = 0; s <= segs; s++) {
        const th = (s / segs) * Math.PI * 2;
        const ex = Math.cos(phi) * Math.cos(th), ez = Math.cos(phi) * Math.sin(th), ey = Math.sin(phi);
        const n = new V3(ex / rx, ey / Math.max(h, 0.01), -ez / rz).normalize();
        push(c[0] + ex * rx, y0 + ey * h, -(c[1] + ez * rz), n.x, n.y, n.z, color, o.bid, th * Math.max(rx, rz), opt.rib || 0, o.top, code, o.fh, o.seed);
      }
    }
    for (let k = 0; k < rings; k++) for (let s = 0; s < segs; s++) {
      const a = base + k * (segs + 1) + s, b = a + 1, c2 = a + segs + 1, d = c2 + 1;
      IDX.p6(a, b, c2, b, d, c2);
    }
  }
  // Frustum / spire (r1 = 0) along y
  function cone(c, r0, r1, y0, y1, o, color, code, opt = {}) {
    const segs = opt.segs || 16, base = vc;
    const slope = (r0 - r1) / Math.max(0.01, y1 - y0);
    for (const [y, r] of [[y0, r0], [y1, r1]]) for (let s = 0; s <= segs; s++) {
      const th = (s / segs) * Math.PI * 2, ex = Math.cos(th), ez = Math.sin(th);
      const n = new V3(ex, slope, -ez).normalize();
      push(c[0] + ex * r, y, -(c[1] + ez * r), n.x, n.y, n.z, color, o.bid, th * r0, opt.rib || 0, o.top, code, o.fh, o.seed);
    }
    for (let s = 0; s < segs; s++) { const a = base + s, b = a + 1, c2 = a + segs + 1, d = c2 + 1; IDX.p6(a, b, c2, b, d, c2); }
    if (r1 > 0.01 && opt.cap !== false) {
      const ring = Array.from({ length: segs }, (_, s) => [c[0] + Math.cos((s / segs) * Math.PI * 2) * r1, c[1] + Math.sin((s / segs) * Math.PI * 2) * r1]);
      cap([ring], y1, o, code, color);
    }
  }
  function prism(ring, y0, y1, o, code, color, capCode, capColor) {
    const r2 = ccw(ring);
    walls(r2, y0, y1, { ...o, base: y0, top: y1 }, code, { color });
    cap([r2], y1, o, capCode ?? code, capColor || color);
    if (y0 > 0.5) cap([r2], y0, o, SOLID, color, true);
  }
  // Square-section beam between two points given as [east, north, up]
  function beam(a, b, w, o, color, code) {
    const A = new V3(a[0], a[2], -a[1]), Bv = new V3(b[0], b[2], -b[1]);
    const d = new V3().subVectors(Bv, A).normalize();
    const ref = Math.abs(d.y) > 0.9 ? new V3(1, 0, 0) : new V3(0, 1, 0);
    const u = new V3().crossVectors(d, ref).normalize().multiplyScalar(w / 2), v = new V3().crossVectors(d, u).normalize().multiplyScalar(w / 2);
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    for (let k = 0; k < 4; k++) {
      const [s0, t0] = corners[k], [s1, t1] = corners[(k + 1) % 4];
      const p0 = A.clone().addScaledVector(u, s0).addScaledVector(v, t0), p1 = A.clone().addScaledVector(u, s1).addScaledVector(v, t1);
      const p2 = Bv.clone().addScaledVector(u, s1).addScaledVector(v, t1), p3 = Bv.clone().addScaledVector(u, s0).addScaledVector(v, t0);
      const n = new V3().addScaledVector(u, s0 + s1).addScaledVector(v, t0 + t1).normalize();
      const ids = [p0, p1, p2, p3].map((p) => push(p.x, p.y, p.z, n.x, n.y, n.z, color, o.bid, 0, 0, o.top, code, o.fh, o.seed));
      const fn = new V3().subVectors(p1, p0).cross(new V3().subVectors(p3, p0));
      if (fn.dot(n) >= 0) quad(ids[0], ids[1], ids[2], ids[3]); else quad(ids[0], ids[3], ids[2], ids[1]);
    }
  }
  // Walls rising to a sloped roof plane: y = y0 + slope * dot(p - c, dir). opt.codeFor(a, b) / opt.colorFor(a, b)
  // choose each wall's facade; roofCode null leaves the top open (for a crown drawn separately)
  function slantTop(ring, yBase, plane, o, code, roofCode, roofColor, opt = {}) {
    const r2 = ccw(ring);
    const yAt = (p) => plane.y0 + plane.slope * ((p[0] - plane.c[0]) * plane.dir[0] + (p[1] - plane.c[1]) * plane.dir[1]);
    let u = 0;
    for (let i = 0; i < r2.length; i++) {
      const a = r2[i], b = r2[(i + 1) % r2.length]; const Ln = Math.hypot(b[0] - a[0], b[1] - a[1]); if (Ln < 0.05) continue;
      const dx = (b[0] - a[0]) / Ln, dn = (b[1] - a[1]) / Ln;
      const ya = yAt(a), yb = yAt(b);
      const cd = opt.codeFor ? opt.codeFor(a, b) : code, col = (opt.colorFor && opt.colorFor(a, b)) || o.wall;
      if (Ln > 4.5 && cd < SOLID) u = -(Ln % (LAYERS[cd] || LAYERS[0]).tileW) / 2;
      const ia = push(a[0], yBase, -a[1], dn, 0, dx, col, o.bid, u, o.base, o.top, cd, o.fh, o.seed);
      const ib = push(b[0], yBase, -b[1], dn, 0, dx, col, o.bid, u + Ln, o.base, o.top, cd, o.fh, o.seed);
      const ic = push(b[0], yb, -b[1], dn, 0, dx, col, o.bid, u + Ln, o.base, o.top, cd, o.fh, o.seed);
      const id = push(a[0], ya, -a[1], dn, 0, dx, col, o.bid, u, o.base, o.top, cd, o.fh, o.seed);
      quad(ia, ib, ic, id); u += Ln;
    }
    if (roofCode == null) return;
    const t = triangulate([r2]); if (!t) return;
    const n = new V3(-plane.slope * plane.dir[0], 1, plane.slope * plane.dir[1]).normalize();
    const s0 = vc;
    for (const p of t.verts) push(p[0], yAt(p), -p[1], n.x, n.y, n.z, roofColor, o.bid, p[0] - o.center[0], p[1] - o.center[1], o.top, roofCode, o.fh, o.seed);
    for (let k = 0; k < t.tris.length; k += 3) IDX.p3(s0 + t.tris[k], s0 + t.tris[k + 1], s0 + t.tris[k + 2]);
  }
  // Parametric surface: f(u, v) -> [east, north, up] for u, v in [0, 1] (f must accept values slightly outside,
  // for the finite-difference normals); nu x nv quads, wound to face along the computed normals
  function surface(f, nu, nv, o, color, code, opt = {}) {
    const base = vc, e = 1e-4;
    const P = (u, v) => { const p = f(u, v); return new V3(p[0], p[2], -p[1]); };
    const nrm = (u, v) => new V3().crossVectors(P(u + e, v).sub(P(u - e, v)), P(u, v + e).sub(P(u, v - e))).normalize();
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv, p = P(u, v), n = nrm(u, v);
      if (opt.flip) n.negate();
      push(p.x, p.y, p.z, n.x, n.y, n.z, color, o.bid, u * (opt.uLen || 1), v * (opt.vLen || 1), o.top, code, o.fh, o.seed);
    }
    // winding from the first quad's geometry against its normal
    const p0 = P(0.5 / nu, 0.5 / nv), pa = P(1.5 / nu, 0.5 / nv), pb = P(0.5 / nu, 1.5 / nv);
    const flipW = new V3().crossVectors(pa.sub(p0), pb.sub(p0)).dot(nrm(0.5 / nu, 0.5 / nv).multiplyScalar(opt.flip ? -1 : 1)) < 0;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      if (flipW) IDX.p6(a, c, b, b, c, d); else IDX.p6(a, b, c, b, d, c);
    }
  }
  // a single quad from four corners given as [east, north, up], wound counter-clockwise as seen from its front
  function facet(a, b, c, d, o, color, code, uv = null) {
    const A = new V3(a[0], a[2], -a[1]), Bq = new V3(b[0], b[2], -b[1]), Cq = new V3(c[0], c[2], -c[1]), D = new V3(d[0], d[2], -d[1]);
    const n = new V3().subVectors(Bq, A).cross(new V3().subVectors(D, A)).normalize();
    const u = uv || [[0, 0], [1, 0], [1, 1], [0, 1]];
    const ids = [A, Bq, Cq, D].map((p, k) => push(p.x, p.y, p.z, n.x, n.y, n.z, color, o.bid, u[k][0], u[k][1], o.top, code, o.fh, o.seed));
    quad(ids[0], ids[1], ids[2], ids[3]);
  }
  const rectRing = (cx, cy, w, d, ang) => { const c = Math.cos(ang), s = Math.sin(ang); return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([a, b]) => [cx + a * c - b * s, cy + a * s + b * c]); };
  const circleRing = (cx, cy, r, n = 24) => Array.from({ length: n }, (_, k) => [cx + Math.cos((k / n) * Math.PI * 2) * r, cy + Math.sin((k / n) * Math.PI * 2) * r]);
  const scaleRing = (ring, c, s) => ring.map((p) => [c[0] + (p[0] - c[0]) * s, c[1] + (p[1] - c[1]) * s]);

  // ---------------------------------------------------------------- balconies
  // Real projecting slabs with a reflective glass balustrade on every floor of balcony-type towers.
  // Each face gets one or two runs with open corners (as built), so the facade gains genuine depth,
  // contact shadow (AO) and the stacked horizontal bands these towers show from a distance.
  const BALC = new Set([L.balconyA, L.balconyB, L.jbr]);
  const SLAB_C = new THREE.Color('#f2f0ea');
  let balcTris = 0;
  function balconies(ring, y0, y1, o, layer) {
    if (lite || !BALC.has(layer) || y1 - y0 < 14 || o.twist) return;
    const fh = o.fh || 3.2;
    const depth = layer === L.balconyB ? 1.7 : layer === L.jbr ? 1.5 : 1.35;
    const glassC = new THREE.Color(layer === L.jbr ? '#b7c6c4' : '#a7c0cb');
    const t = 0.24, gh = 1.05;
    const segs = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 4) continue;
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, nx = uy, ny = -ux; // outward of a CCW ring
      const spans = len < 22 ? [[0.12, 0.88]] : [[0.06, 0.47], [0.53, 0.94]];
      for (const [s0, s1] of spans) {
        const P = [a[0] + ux * len * s0, a[1] + uy * len * s0], Q = [a[0] + ux * len * s1, a[1] + uy * len * s1];
        segs.push({ P, Q, P1: [P[0] + nx * depth, P[1] + ny * depth], Q1: [Q[0] + nx * depth, Q[1] + ny * depth], n: [nx, 0, -ny] });
      }
    }
    if (!segs.length) return;
    const V = (p, y, n, c, code) => push(p[0], y, -p[1], n[0], n[1], n[2], c, o.bid, 0, o.base, o.top, code, o.fh, o.seed);
    const UP = [0, 1, 0];
    for (let y = Math.max(o.base, y0) + 2 * fh; y <= y1 - fh * 0.6; y += fh) {
      for (const s of segs) {
        quad(V(s.P, y, UP, SLAB_C, SOLID), V(s.P1, y, UP, SLAB_C, SOLID), V(s.Q1, y, UP, SLAB_C, SOLID), V(s.Q, y, UP, SLAB_C, SOLID));
        quad(V(s.P1, y - t, s.n, SLAB_C, LEDGE), V(s.Q1, y - t, s.n, SLAB_C, LEDGE), V(s.Q1, y, s.n, SLAB_C, LEDGE), V(s.P1, y, s.n, SLAB_C, LEDGE));
        quad(V(s.P1, y, s.n, glassC, GLASSY), V(s.Q1, y, s.n, glassC, GLASSY), V(s.Q1, y + gh, s.n, glassC, GLASSY), V(s.P1, y + gh, s.n, glassC, GLASSY));
        balcTris += 6;
      }
    }
  }

  // ---------------------------------------------------------------- default massing (shared with landmark builders)
  function defaultParts(B, opts = {}) {
    const { b, i, outer, area, ap, o, cen } = B;
    let best = null;
    const maxH = Math.max(...b.parts.map((p) => p.h));
    const parts = b.parts.map((part) => {
      const pp = part.p.map((rr, k) => ((k === 0) === (signedArea(rr) > 0) ? rr : rr.slice().reverse()));
      return { part, pp, a: Math.abs(signedArea(pp[0])) };
    });
    const large = parts.filter((x) => x.a >= area * 0.25);
    const coverage = parts.reduce((s, x) => s + x.a, 0) / Math.max(1, area);
    if (!large.length && !opts.noBody) {
      // parts only describe a crown or spire: the outline is the tower itself (e.g. Elite Residence)
      const oh = b.oh || b.h;
      const smallTop = Math.max(...parts.map((x) => x.part.h));
      const top = opts.bodyTop || (smallTop >= oh - 1 ? oh * 0.92 : oh);
      const ob = { ...o, base: 0, top };
      walls(outer[0], 0, top, ob, ap.layer);
      parapetRoof(ccw(outer[0]), top, 1.2, ob, ROOF + ap.roofLayer, ap.roof, parapetColor(ap));
      B.plate = outer; B.plateTop = top; B.bodyTop = top;
    } else if (!opts.noBody && Math.min(...parts.map((x) => x.part.mh || 0)) > 1.5) {
      // every part starts above the ground (a crown on its tower, towers on their podium: Chelsea Tower, Damac
      // Maison, Sunrise Bay): the outline itself stands from the ground up to where the parts begin, so nothing floats
      const lowest = Math.min(...parts.map((x) => x.part.mh || 0));
      const top = lowest;
      const ob = { ...o, base: 0, top };
      const podium = top < maxH * 0.35;
      walls(outer[0], 0, top, ob, podium ? L.podium : ap.layer, podium ? { color: new THREE.Color('#e6dfd2') } : {});
      parapetRoof(ccw(outer[0]), top, 1.0, ob, ROOF + (podium ? L.roofPodium : ap.roofLayer), podium ? new THREE.Color('#d9d0bf') : ap.roof, podium ? new THREE.Color('#ece6da') : parapetColor(ap));
      if (podium) B.podiumTop = top; else { B.plate = outer; B.plateTop = top; B.bodyTop = top; }
    } else if (coverage < 0.7 && !opts.noPodium) {
      // podium around the tower parts (The Torch, Marina 101, 23 Marina, Almas...)
      const ph = THREE.MathUtils.clamp(maxH * 0.08, 12, 32);
      const po = { ...o, base: 0, top: ph, fh: ph / Math.max(1, Math.round(ph / 4.2)) };
      walls(outer[0], 0, ph, po, L.podium, { color: new THREE.Color('#e6dfd2') });
      parapetRoof(ccw(outer[0]), ph, 1.0, po, ROOF + L.roofPodium, new THREE.Color('#d9d0bf'), new THREE.Color('#ece6da'));
      B.podiumTop = ph;
    }
    for (const { part, pp, a: pa } of parts) {
      if (opts.skip && opts.skip(part, pa)) continue;
      const pc = centroid(pp[0]);
      const pcol = opts.wall || (part.c ? safeColor(part.c, '#' + ap.wall.getHexString()) : ap.wall);
      const po = { ...o, wall: pcol, center: ap.twist ? cen : pc, base: part.mh || 0, top: part.h };
      walls(pp[0], part.mh || 0, part.h, po, opts.layer ?? ap.layer);
      if (!ap.twist) balconies(pp[0], part.mh || 0, part.h, po, opts.layer ?? ap.layer);
      for (const hole of pp.slice(1)) walls(hole, part.mh || 0, part.h, po, opts.layer ?? ap.layer);
      if (pp.length === 1 && pa > 150 && !ap.twist) parapetRoof(ccw(pp[0]), part.h, part.h > 40 ? 1.2 : 0.9, po, ROOF + ap.roofLayer, ap.roof, pcol.clone().lerp(new THREE.Color('#f2f0ea'), 0.4));
      else cap(pp, part.h, po, ROOF + ap.roofLayer, ap.roof, false, ap.twist);
      if ((part.mh || 0) > 0.5) cap(pp, part.mh, po, SOLID, ap.roof, true);
      if (part.h >= maxH * 0.6 && (part.mh || 0) < maxH * 0.3 && (!best || pa > best.a)) best = { h: part.h, pp, mh: part.mh || 0, a: pa };
    }
    if (best && best.a > 80) { B.plate = best.pp; B.plateBase = best.mh; B.plateTop = best.h; }
  }

  function defaultSimple(B) {
    const { b, i, outer, area, ap, o, cen, r } = B;
    const polys = [outer, ...(b.x || []).map((x) => x.map((rr, k) => ((k === 0) === (signedArea(rr) > 0) ? rr : rr.slice().reverse())))];
    for (const poly of polys) {
      walls(poly[0], o.base, b.h, o, ap.layer);
      balconies(poly[0], o.base, b.h, o, ap.layer);
      for (const hole of poly.slice(1)) walls(hole, o.base, b.h, o, ap.layer);
      if (o.base > 0.5) cap(poly, o.base, o, SOLID, ap.roof, true);
      const simple = poly.length === 1 && !ap.twist && b.h >= 6 && b.t !== 'roof';
      if (!simple) { cap(poly, b.h, o, ROOF + ap.roofLayer, ap.roof, false, ap.twist); continue; }
      const parCol = parapetColor(ap);
      const inner = parapetRoof(ccw(poly[0]), b.h, b.h > 40 ? 1.2 : 0.9, o, ROOF + ap.roofLayer, ap.roof, parCol);
      if (lite) continue;
      // roof features: plant room or helipad on towers, AC units & tanks everywhere
      let avoid = null;
      if (b.h > 30 && area > 250) {
        const heli = b.h > 170 && area > 650 && ap.seed < 0.38;
        if (heli) {
          const R = Math.min(11, Math.sqrt(area) * 0.27);
          const ok = Array.from({ length: 12 }, (_, k) => [cen[0] + Math.cos((k / 12) * 6.283) * (R + 1), cen[1] + Math.sin((k / 12) * 6.283) * (R + 1)]).every((p) => pointInRing(p, inner));
          if (ok) {
            cap([circleRing(cen[0], cen[1], R)], b.h + 0.06, { ...o, center: cen, top: R }, HELI, new THREE.Color('#9ea3a6'));
            avoid = [cen[0], cen[1], R + 2.5];
          }
        }
        if (!avoid) {
          const plant = scaleRing(outer[0], cen, 0.42);
          if (plant.every((p) => pointInRing(p, inner))) {
            const ph = 3.5 + ap.seed * 4 + (b.h > 120 ? 3 : 0);
            const po = { ...o, base: b.h, top: b.h + ph, fh: ph };
            walls(ccw(plant), b.h, b.h + ph, po, L.podium);
            parapetRoof(ccw(plant), b.h + ph, 0.6, po, ROOF + L.roofConcrete, ap.roof, parCol);
            let rad = 0; for (const p of plant) rad = Math.max(rad, Math.hypot(p[0] - cen[0], p[1] - cen[1]));
            avoid = [cen[0], cen[1], rad + 1.5];
            scatterEquipment(ccw(insetRing(ccw(plant), 0.6)), b.h + ph, i, Math.min(6, Math.round((area * 0.18) / 90)), r);
          }
        }
      }
      if (ap.roofLayer !== L.roofPodium) scatterEquipment(inner, b.h, i, Math.max(1, Math.min(26, Math.round(area / 110))), r, avoid);
      else scatterEquipment(inner, b.h, i, Math.min(6, Math.round(area / 900)), r, avoid);
    }
  }

  const T = {
    THREE, L, LAYERS, lite, quad: facet, codes: { SOLID, ROOF, SLOPE, HELI, METAL, GLOW, GLASSY, POOL, FABRIC, ALU, SKY, CALLIG, SLATV, SLATH, STONE, SCREEN }, walls, cap, parapetRoof, hipRoof, loft, dome, cone, prism, beam, slantTop, surface,
    scatterEquipment, defaultParts, defaultSimple, orientedBox, insetRing, ccw, centroid, signedArea, pointInRing, rectRing, circleRing, scaleRing, safeColor, parapetColor,
  };

  // adds building record b under global id gid; returns its info (shared by every panel)
  function add(b, gid) {
    const i = gid;
    const outer = b.p.map((r, k) => ((k === 0) === (signedArea(r) > 0) ? r : r.slice().reverse()));
    const area = Math.abs(signedArea(outer[0]));
    const ap = appearance(b, area);
    const cen = centroid(outer[0]);
    styleZone(b, cen, ap);
    const levels = b.v ? 2 : (b.lv || Math.max(1, Math.round((b.h - (b.mh || 0)) / 3.4)));
    const fh = b.v ? 3.6 : THREE.MathUtils.clamp((b.h - (b.mh || 0)) / levels, 2.8, 6);
    const o = { bid: i, wall: ap.wall, roof: ap.roof, roofLayer: ap.roofLayer, fh, seed: ap.seed, center: cen, twist: ap.twist, base: b.mh || 0, top: b.h };
    const r = ap.r;
    const B = { b, i, outer, area, ap, o, cen, r, levels, fh, plate: outer, plateBase: b.mh || 0, plateTop: b.h };
    const lm = LANDMARKS[b.n];

    const kit = (b.hk && HOUSE_KITS[b.hk]) || (b.t === 'mosque' && !b.v ? HOUSE_KITS.mosque : null);
    if (lm && lm(T, B) !== false) {
      // hand-modelled landmark
    } else if (kit && kit(T, B) !== false) {
      // researched house model (floor plans and photographs)
    } else if (b.v) {
      // ---------------------------------------------------------- villas & townhouses
      const ob = orientedBox(outer[0]);
      const style = b.v;
      const wallH = b.h;
      const wl = style === 't' ? L.townhouse : style === 'm' ? L.townhouse : L.villa;
      o.wall = new THREE.Color(style === 't' ? (r() < 0.5 ? '#f5f2eb' : '#efe9de') : style === 'm' ? (r() < 0.6 ? '#f6f6f3' : '#e9e8e3') : style === 'h' ? VILLA_H[Math.floor(r() * VILLA_H.length)] : VILLA_F[Math.floor(r() * VILLA_F.length)]);
      const roofCol = new THREE.Color(style === 't' ? '#7a6352' : style === 'm' ? '#62666b' : style === 'h' ? TERRACOTTA[Math.floor(r() * TERRACOTTA.length)] : '#ddd3c2');
      o.roofLayer = style === 'h' ? L.roofTiles : style === 't' || style === 'm' ? L.roofDeck : L.roofConcrete;
      const parCol = style === 't' || style === 'm' ? new THREE.Color('#f7f6f2') : o.wall.clone().multiplyScalar(1.03);
      const ring = ccw(outer[0]);
      if (lite) {
        // whole-city view: the house's walls under its roof
        o.top = wallH; walls(ring, 0, wallH, o, wl);
        if (style === 'h' && ob && ob.fill > 0.72) hipRoof(ob, wallH, o, roofCol);
        else parapetRoof(ring, wallH, 0.75, o, ROOF + o.roofLayer, roofCol, parCol);
      } else if (style === 'h' && ob && ob.fill > 0.72) {
        o.top = wallH;
        walls(ring, 0, wallH, o, wl);
        cap([ring], wallH - 0.05, o, SOLID, o.wall);
        hipRoof(ob, wallH, o, roofCol);
      } else {
        // stepped massing: full ground floor + smaller upper floor (Meadows / contemporary) or full height
        const twoTier = (style === 'f' || style === 'm') && ob && r() < 0.6;
        let upper = null;
        if (twoTier) {
          const du = (r() - 0.5) * ob.len * 0.2, dv = (r() - 0.5) * ob.wid * 0.2;
          const cand = boxRing(ob, ob.len * 0.36, ob.wid * 0.38, du, dv);
          if (cand.every((p) => pointInRing(p, ring))) upper = ccw(cand);
        }
        if (upper) {
          const g1 = 3.9;
          o.top = g1; walls(ring, 0, g1, o, wl);
          const inner = parapetRoof(ring, g1, 0.7, o, ROOF + o.roofLayer, roofCol, parCol);
          o.top = wallH; o.base = g1; walls(upper, g1, wallH, o, wl, { phase: 1.3 }); o.base = 0;
          const inner2 = parapetRoof(upper, wallH, 0.7, o, ROOF + o.roofLayer, roofCol, parCol);
          scatterEquipment(inner2, wallH, i, 2 + Math.floor(r() * 2), r);
          scatterEquipment(inner, g1, i, 1 + Math.floor(r() * 2), r, [ob.c[0], ob.c[1], Math.max(ob.len, ob.wid) * 0.45]);
        } else {
          o.top = wallH; walls(ring, 0, wallH, o, wl);
          const inner = parapetRoof(ring, wallH, style === 't' ? 0.85 : 0.75, o, ROOF + o.roofLayer, roofCol, parCol);
          // roof-top room / stair head
          if (ob && r() < (style === 't' ? 0.45 : 0.7)) {
            const du = (r() < 0.5 ? -1 : 1) * ob.len * 0.22;
            const room = ccw(boxRing(ob, Math.min(3.2, ob.len * 0.18), Math.min(2.8, ob.wid * 0.22), du, 0));
            if (room.every((p) => pointInRing(p, inner))) {
              o.base = wallH; o.top = wallH + 2.9; walls(room, wallH, wallH + 2.9, o, wl, { phase: 0.7 });
              parapetRoof(room, wallH + 2.9, 0.4, o, ROOF + o.roofLayer, roofCol, parCol); o.base = 0;
              scatterEquipment(inner, wallH, i, 2 + Math.floor(r() * 2), r, [ob.c[0] + ob.u[0] * du, ob.c[1] + ob.u[1] * du, 4.5]);
            } else scatterEquipment(inner, wallH, i, 2 + Math.floor(r() * 3), r);
          } else scatterEquipment(inner, wallH, i, 2 + Math.floor(r() * 3), r);
          if (style === 'h' && ob) { // compound footprint: tiled roof over the main block
            const core = boxRing(ob, ob.len * 0.3, ob.wid * 0.32);
            if (core.every((p) => pointInRing(p, ring))) hipRoof({ ...ob, len: ob.len * 0.6, wid: ob.wid * 0.64 }, wallH + 0.75, o, roofCol, 0.3);
          }
        }
      }
      o.base = 0; o.top = b.h;
    } else if (b.parts && b.parts.length) defaultParts(B);
    else defaultSimple(B);
    const { plate, plateBase, plateTop } = B;
    return {
      index: i, name: b.n || '', altName: b.na || '', height: b.h, minHeight: b.mh || 0, levels, floorHeight: fh,
      type: b.t || (b.v ? 'villa' : 'building'), year: b.y || null, estimated: !!b.e, ml: !!b.ml, wikidata: b.wd || null,
      center: cen, area, plate, plateBase, plateTop, style: ap.layer, wall: o.wall, twist: ap.twist, villa: b.v || null, district: b.d || null,
      developer: null, community: null,
    };
  }

  // the filled buffers as one geometry (null when nothing was drawn); the picking BVH can be left for later
  function finish(bvh = true) {
    if (!vc) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P.take(), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(NOR.take(), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(COL.take(), 3));
    geo.setAttribute('aBid', new THREE.BufferAttribute(BID.take(), 1));
    geo.setAttribute('aWall', new THREE.BufferAttribute(WALL.take(), 4));
    geo.setAttribute('aMeta', new THREE.BufferAttribute(META.take(), 2));
    geo.setIndex(new THREE.BufferAttribute(IDX.take(vc > 65535 ? Uint32Array : Uint16Array), 1));
    geo.computeBoundingSphere();
    if (bvh) geo.computeBoundsTree();
    freeAfterUpload(geo, ['position', 'aBid', 'index']); // picking reads these; the rest lives on the GPU only
    return { geo, equipment, balcTris, verts: vc };
  }
  return { add, finish };
}

// ---------------------------------------------------------------- LED facade patterns (Burj Khalifa's light shows)
// a: 0..1 round the tower, h: 0..1 up it, t: seconds since the pattern began; pb picks palette A (0) or B (3)
const LED_GLSL = /* glsl */ `
  uniform vec4 uLedA, uLedB; uniform vec3 uLedC; uniform vec3 uLedPal[6];
  vec3 ledHue(float h) { return clamp(abs(fract(h + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
  vec3 ledPattern(float id, float t, float a, float h, int pb) {
    vec3 p0 = uLedPal[pb], p1 = uLedPal[pb + 1], p2 = uLedPal[pb + 2];
    vec3 c = vec3(0.0);
    if (id < 0.5) return c;
    if (id < 1.5) {          // 1: a curtain of light rising up the tower and leaving it lit
      float f = t * 0.24 - 0.05;
      c = p0 * (1.0 - smoothstep(f - 0.05, f, h)) * 0.5 + p1 * exp(-abs(h - f) * 60.0) * 2.2;
    } else if (id < 2.5) {   // 2: bands of colour rolling upward
      float k = h * 3.0 - t * 0.45;
      c = mix(mix(p0, p1, smoothstep(0.2, 0.8, fract(k))), p2, smoothstep(0.5, 1.0, sin(6.2831 * (k * 0.5 + a))) * 0.6);
      c *= 0.7 + 0.3 * sin(6.2831 * (h * 14.0 - t * 1.6));
    } else if (id < 3.5) {   // 3: helical stripes winding round and up
      float s = fract(a * 3.0 + h * 6.0 - t * 0.35);
      c = mix(p1 * 0.1, p0, smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.3, 0.38, s)));
      c += p2 * exp(-abs(fract(h * 2.0 - t * 0.5) - 0.5) * 30.0) * 0.7;
    } else if (id < 4.5) {   // 4: the UAE flag, rippling: red at the hoist; green, white and black stripes
      float w = sin(6.2831 * (a * 2.0 + t * 0.6) + h * 9.0);
      float hh = h + 0.025 * w;
      vec3 st = hh > 0.667 ? vec3(0.0, 0.62, 0.2) : hh > 0.333 ? vec3(0.8) : vec3(0.015);
      c = (fract(a + 0.06) < 0.26 ? vec3(1.0, 0.04, 0.04) : st) * (0.85 + 0.15 * w);
    } else if (id < 5.5) {   // 5: flames licking up the tower
      float n = fbm(vec2(a * 14.0, h * 9.0 - t * 1.4)) + 0.3 * vnoise(vec2(a * 40.0, h * 30.0 - t * 3.0));
      float fl = smoothstep(0.25, 0.85, n + (0.7 - h) * 0.9);
      c = mix(p0, mix(p1, p2, smoothstep(0.6, 1.0, fl)), smoothstep(0.2, 0.7, fl)) * fl * 1.4;
    } else if (id < 6.5) {   // 6: rain streaming down the fins
      float col = floor(a * 140.0);
      float ph = fract(h * 2.5 + t * (0.35 + hash12(vec2(col, 1.0)) * 0.5) + hash12(vec2(col, 7.0)));
      c = p0 * 0.07 + mix(p0, p1, exp(-ph * 60.0)) * smoothstep(0.0, 0.015, ph) * exp(-ph * 9.0) * 1.7;
    } else if (id < 7.5) {   // 7: fireworks bursting up and down the tower
      for (int k = 0; k < 9; k++) {
        float fk = float(k), cyc = t * 0.8 + fk * 0.37, n = floor(cyc), f = fract(cyc);
        vec2 ctr = vec2(hash12(vec2(n, fk)), 0.12 + 0.82 * hash12(vec2(fk, n + 3.0)));
        vec2 d = vec2((fract(a - ctr.x + 0.5) - 0.5) * 0.25, h - ctr.y);
        float r = length(d), R = sqrt(f) * 0.11;
        vec3 hc = ledHue(hash12(vec2(n, fk + 9.0)));
        c += hc * (exp(-abs(r - R) * 200.0) * 2.4 + step(r, R) * 0.25) * (1.0 - f);
      }
      c += ledHue(a + h * 0.5 + t * 0.1) * 0.1;
      c += vec3(1.0) * step(0.982, hash12(floor(vec2(a * 160.0, h * 300.0)) + floor(t * 12.0))) * 0.9;
    } else if (id < 8.5) {   // 8: gold glitter
      float g = vnoise(vec2(a * 240.0, h * 420.0 + t * 3.0));
      c = mix(p0, p1, smoothstep(0.6, 1.0, g)) * (0.45 + 0.8 * g);
    } else if (id < 9.5) {   // 9: heartbeat rings racing up on the beat
      c = p0 * exp(-fract(h * 1.6 - t * 0.9) * 10.0) * 1.5 + p1 * exp(-uLedB.y * 6.0) * 0.4;
    } else {                 // 10: the evening look between shows: soft light on the fins, a slow shimmer
      c = vec3(0.82, 0.88, 1.0) * (0.22 + 0.07 * sin(t * 0.6 + h * 18.0 + a * 6.2831));
    }
    return c;
  }
`;

// time slicing: long builds hand the main thread back between slices so the scene keeps rendering (and wait
// while the user is moving the map)
function slicer(ms, gate) {
  let t0 = performance.now();
  return {
    due: () => performance.now() - t0 > ms,
    async yield() { await (gate ? gate() : new Promise((r) => setTimeout(r, 0))); t0 = performance.now(); },
  };
}

// ---------------------------------------------------------------- the city's buildings
// One shared per-building state (filter mode, highlight colour, the sink/rise animation), indexed by global
// building id, drives two kinds of mesh, both chunked on the 1 km streaming grid: light chunks of the whole city,
// built at start from world.json, and detailed cells streamed in near the camera (core/sections.js decides which).
// A light chunk hides while its cell's detail is shown, and off-screen chunks are culled.
export async function createBuildings(ctx, { progress } = {}) {
  const world = ctx.data.buildings;
  const N = world.length;
  const secs = ctx.data.meta.sections;
  const tex = createFacadeTextures(ctx.renderer);

  // ---- per-building state texture: R = mode, GBA = highlight colour
  const TW = 1024, TH = Math.max(1, Math.ceil(N / TW));
  const stateData = new Uint8Array(TW * TH * 4);
  const stateTex = new THREE.DataTexture(stateData, TW, TH, THREE.RGBAFormat);
  stateTex.magFilter = stateTex.minFilter = THREE.NearestFilter; stateTex.needsUpdate = true;
  // ---- per-building animation texture: R = height factor (1 full height .. 0 footprint), G = ghost amount
  const animData = new Uint8Array(TW * TH * 4);
  for (let i = 0; i < N; i++) animData[i * 4] = 255;
  const animTex = new THREE.DataTexture(animData, TW, TH, THREE.RGBAFormat);
  animTex.magFilter = animTex.minFilter = THREE.NearestFilter; animTex.needsUpdate = true;
  const uAnim = { value: animTex };
  const uState = { value: stateTex }, uNight = { value: 0 }, uTime = { value: 0 }, uHover = { value: -1 }, uCut = { value: 1e5 }, uPop = { value: 1 }; // uPop: strength of the illustrated colour and shading
  const uFacade = { value: tex.color }, uFacadeMask = { value: tex.mask }, uLayer = { value: tex.info };
  // Burj Khalifa's LED facade, driven by layers/burjShow.js: A/B patterns crossfade (ids, seconds since each began),
  // then mix, beat phase, intensity and the tower's building id; the axis (x, z) and height; two 3-colour palettes
  const uLedA = { value: new THREE.Vector4(0, 0, 0, 0) }, uLedB = { value: new THREE.Vector4(0, 0, 0, -1) };
  const uLedC = { value: new THREE.Vector3(0, 0, 828) }, uLedPal = { value: Array.from({ length: 6 }, () => new THREE.Color(1, 1, 1)) };
  ctx.updaters.push((dt, t) => { uTime.value = t; });
  ctx.on('time', (s) => { uNight.value = s.night; });

  const STATE_FETCH = `
    vec4 bState(float bid) { return texelFetch(uState, ivec2(int(mod(bid, 1024.0)), int(floor(bid / 1024.0))), 0); }
    vec4 bAnim(float bid) { return texelFetch(uAnim, ivec2(int(mod(bid, 1024.0)), int(floor(bid / 1024.0))), 0); }`;
  const VERT_DECL = `
    attribute float aBid; attribute vec4 aWall; attribute vec2 aMeta;
    uniform sampler2D uState, uAnim; uniform float uCut;
    varying vec4 vWall; varying vec2 vMeta; varying float vBid; varying vec4 vState; varying vec3 vWP; varying float vGhost;
    ${STATE_FETCH}`;
  const VERT_BODY = `
    vWall = aWall; vMeta = aMeta; vBid = aBid;
    vState = bState(aBid);
    float bMode = floor(vState.r * 255.0 + 0.5);
    // filter animation: towers sink to their footprint and rise back (k = 1 full height)
    vec4 an = bAnim(aBid); vGhost = an.g;
    transformed.y = max(transformed.y * an.r, min(transformed.y, 0.7));
    if (bMode == 5.0) transformed.y = -400.0;
    if (bMode == 6.0) transformed.y = min(transformed.y, max(uCut, 0.7));
    vWP = transformed;`;

  const compile = (s) => {
    Object.assign(s.uniforms, { uState, uAnim, uNight, uTime, uHover, uPop, uCut, uFacade, uFacadeMask, uLayer, uLedA, uLedB, uLedC, uLedPal });
    const GT = ctx.groundTex;
    s.uniforms.uGndL = { value: GT ? GT.baseTex : null }; s.uniforms.uGndB = GT ? GT.uBaseB : { value: new THREE.Vector4(0, 0, 1, 1) }; s.uniforms.uGndOn = { value: GT ? 1 : 0 };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BODY);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        precision highp sampler2DArray;
        uniform float uNight, uTime, uHover, uPop, uGndOn;
        uniform sampler2D uGndL; uniform vec4 uGndB;
        uniform sampler2DArray uFacade, uFacadeMask;
        uniform vec4 uLayer[${tex.count}];
        varying vec4 vWall; varying vec2 vMeta; varying float vBid; varying vec4 vState; varying vec3 vWP; varying float vGhost;
        ${GLSL_NOISE}
        ${LED_GLSL}
        // How brightly the window holding cell c is lit, and the tone of its light (x: 0..1.4, y: 0..1). At level
        // of detail 0 a cell is one window; each level up merges 2x2 cells into a block that is lit or dark as one.
        // Homes: scattered rooms. Offices: few single rooms, but about a third of the floors lit from end to end.
        vec2 winLit(vec2 c, float lod, float seed, float office) {
          float s = exp2(lod);
          vec2 id = floor(c / s);
          float h = hash12(id + seed * 113.0 + lod * 31.7), h2 = hash12(id * 1.7 + 3.1 + lod * 7.3);
          float on = step(h, mix(0.3 + 0.16 * seed, 0.1, office));
          float fl = office * step(hash12(vec2(id.y, seed * 57.0 + lod * 3.3)), 0.17) * step(h2, 0.86);
          return vec2(max(on * (0.42 + 0.78 * h2), fl * 0.6), fract(h2 * 17.0 + h));
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float code = vWall.w;
        float winTone = 0.3, winOffice = 0.0;
        float bMode = floor(vState.r * 255.0 + 0.5);
        vec3 hl = vState.gba;
        vec3 tint = diffuseColor.rgb;
        float fh = max(vMeta.x, 2.5);
        float seed = vMeta.y;
        float glassAmt = 0.0, litAmt = 0.0, refl = 0.0;
        float mOv = -1.0, rOv = -1.0, glowAmt = 0.0, ledAmt = 0.0, vled = 0.0, ledFar = 0.0;
        // LED lines are thinner than a pixel when zoomed out: show them as lines up close and as a soft
        // tint of the whole tower from afar, instead of letting sub-pixel lines bloom into solid columns
        float ledNear = 1.0 - smoothstep(0.35, 1.3, fwidth(vWP.y));
        float relH = vWP.y - vWall.y;
        if (code < 99.5) {
          // ---- facade from the texture array
          int li = int(code + 0.5);
          vec4 Ly = uLayer[li];
          vec2 tuv = vec2(vWall.x / Ly.x, relH / (fh * Ly.z));
          vec4 tc = texture(uFacade, vec3(tuv, float(li)));
          vec4 tm = texture(uFacadeMask, vec3(tuv, float(li)));
          vec3 alb = mix(tc.rgb, tc.rgb * tint * 1.08, tm.g);
          // parapet band above the roof line: plain wall
          float par = step(vWall.z + 0.02, vWP.y);
          alb = mix(alb, tint * 1.02, par);
          glassAmt = tc.a * (1.0 - par);
          refl = Ly.w;
          vec2 cellF = vec2(tuv.x * Ly.y, tuv.y * Ly.z);
          vec2 cell = floor(cellF);
          float detail = 1.0 - smoothstep(0.45, 1.1, max(fwidth(cellF.x), fwidth(cellF.y)));
          // Window lights that stay crisp at every zoom: single windows up close; as windows shrink below a pixel
          // they merge into blocks of 2x2, 4x4... that are lit or dark together, so a tower is always a sharp
          // mosaic of lights instead of dissolving into grey speckle or a dull average
          winOffice = step(0.85, Ly.w) * step(0.55, hash12(vec2(seed * 71.0, 9.1)));
          float lodF = max(0.0, log2(max(max(fwidth(cellF.x), fwidth(cellF.y)), 1e-4) / 0.4));
          float lod0 = floor(lodF), lodT = smoothstep(0.5, 1.0, fract(lodF));
          vec2 wl0 = winLit(cellF, lod0, seed, winOffice), wl1 = winLit(cellF, lod0 + 1.0, seed, winOffice);
          vec2 wl = mix(wl0, wl1, lodT);
          winTone = lodT < 0.5 ? wl0.y : wl1.y;
          // inside one window, up close: brighter toward the ceiling lamp, a curtain drawn part-way across some
          vec2 cf = fract(cellF); float curH = hash12(cell + 41.3);
          float curtain = curH < 0.4 ? mix(0.42, 1.0, step(0.25 + 0.5 * fract(curH * 9.0), curH < 0.2 ? cf.x : 1.0 - cf.x)) : 1.0;
          float inner = mix(0.78, 1.16, cf.y) * curtain;
          // (from afar the window mask blurs to the facade's share of glass: keep the blocks bright)
          float wmask = mix(tm.r, 0.6 * step(0.04, tm.r) + 0.4 * tm.r, clamp(lodF * 0.6, 0.0, 1.0));
          litAmt = wmask * wl.x * mix(1.0, inner, detail) * (1.0 - par);
          // shopfronts at street level stay lit
          litAmt = max(litAmt, tm.r * 0.55 * (1.0 - smoothstep(3.5, 6.0, vWP.y)) * step(vWall.y, 1.0));
          // vertical LED strips on some glass towers (Dubai Marina style)
          float hasV = step(seed, 0.16) * step(80.0, vWall.z) * step(0.85, Ly.w);
          vled = hasV * smoothstep(6.18, 6.36, abs(mod(vWall.x + 1.0, 13.0) - 6.5)) * (1.0 - par) * ledNear;
          float isBalc = (li == ${L.balconyA} || li == ${L.balconyB} || li == ${L.jbr}) ? 1.0 : 0.0;
          ledFar = max(hasV, isBalc * step(seed, 0.18)) * (1.0 - ledNear) * (1.0 - par);
          // glass reflects the ground low down and the sky higher up
          float hgt = clamp((vWP.y - vWall.y) / max(vWall.z - vWall.y, 1.0), 0.0, 1.0);
          alb *= mix(1.0, mix(0.82, 1.14, hgt), tc.a * step(0.85, Ly.w));
          // illustrated colour: windows and curtain walls read as vivid teal-to-blue glass (a hue per tower), paler
          // and more cyan up the tower where they mirror the sky; render and stone are pushed a little richer
          {
            float gHue = hash12(vec2(seed * 91.0, 3.7)), gL = dot(alb, vec3(0.299, 0.587, 0.114));
            vec3 gCol = gHue < 0.35 ? vec3(0.04, 0.4, 0.5) : gHue < 0.65 ? vec3(0.05, 0.28, 0.6) : gHue < 0.85 ? vec3(0.07, 0.46, 0.42) : vec3(0.09, 0.2, 0.5);
            vec3 gAlb = gCol * (0.55 + 1.7 * gL) * mix(0.8, 1.35, hgt) + vec3(0.06, 0.13, 0.15) * hgt * hgt;
            float gAmt = tc.a * (1.0 - par) * uPop;
            alb = mix(mix(vec3(gL), alb, 1.0 + 0.3 * uPop), gAlb, gAmt * 0.72);
          }
          // ground-floor shade & grime near the street
          alb *= mix(0.72, 1.0, smoothstep(0.0, 6.0, vWP.y));
          diffuseColor.rgb = alb;
        } else if (code < 199.5) {
          diffuseColor.rgb = tint * (0.95 + 0.08 * vnoise(vWP.xz * 0.9 + vWP.y));
        } else if (code < 399.5) {
          // ---- roofs (flat: world-space tiles, slopes: along-eave/up-slope)
          int li = int(mod(code, 100.0) + 0.5);
          vec4 Ly = uLayer[li];
          vec2 ruv = code < 299.5 ? vWP.xz / Ly.x : vec2(vWall.x, vWall.y) / Ly.x;
          vec4 tc = texture(uFacade, vec3(ruv, float(li)));
          vec4 tm = texture(uFacadeMask, vec3(ruv, float(li)));
          vec3 alb = mix(tc.rgb, tc.rgb * tint * 1.12, tm.g);
          alb *= 0.94 + 0.1 * vnoise(vWP.xz * 0.12);
          if (li == ${L.roofPodium}) { // podium decks: a grid of planted beds and lawns between paved walks
            vec2 g = vWP.xz / 7.5 + seed * 3.7; vec2 cid = floor(g), cf = fract(g);
            float bed = step(0.42, hash12(cid + seed * 17.0));
            float inset = min(min(cf.x, 1.0 - cf.x), min(cf.y, 1.0 - cf.y));
            float planted = bed * smoothstep(0.1, 0.14, inset);
            vec3 grass = vec3(0.22, 0.45, 0.15) * (0.82 + 0.3 * vnoise(vWP.xz * 2.5));
            alb = mix(alb, grass, planted);
            alb = mix(alb, alb * 0.86, bed * (1.0 - smoothstep(0.08, 0.1, inset)) * smoothstep(0.06, 0.08, inset)); // kerb
          }
          diffuseColor.rgb = alb;
          glassAmt = tc.a; refl = Ly.w;
        } else if (code < 599.5) {
          // ---- helipad marking (aWall.xy = metres from the pad centre)
          vec2 q = vWall.xy; float r = length(q);
          float R = max(vWall.z, 4.0);
          vec3 c = vec3(0.42, 0.45, 0.47);
          float ringM = smoothstep(0.35, 0.0, abs(r - R * 0.8) - R * 0.035);
          float hBar = step(abs(q.x), R * 0.32) * step(abs(q.y), R * 0.055);
          float hLegs = step(abs(abs(q.x) - R * 0.27), R * 0.05) * step(abs(q.y), R * 0.4);
          c = mix(c, vec3(0.96, 0.8, 0.2), ringM);
          c = mix(c, vec3(0.97), max(hBar, hLegs));
          diffuseColor.rgb = c;
        } else {
          // ---- landmark materials: 600 metal, 610 crown metal that glows at night, 620 tinted glass, 630 pool water
          float sc = floor(code / 10.0 + 0.5) * 10.0;
          diffuseColor.rgb = tint;
          if (sc < 615.0) {
            mOv = 0.85; rOv = 0.3;
            if (vWall.y > 0.5 && vWall.y < 20.0) diffuseColor.rgb *= 0.86 + 0.14 * step(0.5, fract(vWall.x / vWall.y)); // ribs / panel joints
            if (sc > 605.0) glowAmt = 1.0;
          } else if (sc < 625.0) {
            // (glass panels on houses and landmarks: about half the rooms are lit, each its own brightness)
            float gh = hash12(floor(vWP.xz * 0.33) + floor(vWP.y / 3.2) * 7.0 + vBid);
            diffuseColor.rgb = tint * 0.6; mOv = 0.6; rOv = 0.06; litAmt = step(gh, 0.62) * (0.75 + 0.75 * fract(gh * 7.0)); winTone = fract(gh * 13.0) * 0.8;
          } else if (sc < 635.0) {
            diffuseColor.rgb = tint * (0.9 + 0.15 * vnoise(vWP.xz * 0.8 + uTime * 0.3)); mOv = 0.0; rOv = 0.04; glowAmt = 0.5;
          } else if (sc > 655.0 && sc < 665.0) {
            // aluminium cladding: satin silver panels with fine joints (Emirates Towers)
            vec2 pj = vec2(vWall.x / 1.6, relH / (fh * 0.5));
            float aa = 1.0 - smoothstep(0.3, 1.0, max(fwidth(pj.x), fwidth(pj.y)));
            float joint = max(smoothstep(0.93, 0.98, fract(pj.x)), smoothstep(0.9, 0.97, fract(pj.y))) * aa;
            diffuseColor.rgb = tint * (0.97 + 0.05 * hash12(floor(pj))) * (1.0 - 0.2 * joint);
            mOv = 0.42; rOv = 0.34;
          } else if (sc > 665.0 && sc < 675.0) {
            // skylight glazing (the mall's vaults and domes): white steel ribs over pale glass, lit from inside after
            // dark; aWall.xy run along and across the surface in metres
            vec2 q = vec2(vWall.x / 2.6, vWall.y / 3.4);
            float aa = 1.0 - smoothstep(0.25, 0.9, max(fwidth(q.x), fwidth(q.y)));
            float rib = max(smoothstep(0.8, 0.92, abs(fract(q.x) - 0.5) * 2.0), smoothstep(0.84, 0.95, abs(fract(q.y) - 0.5) * 2.0));
            float frame = mix(0.62, rib, aa);
            diffuseColor.rgb = mix(vec3(0.58, 0.68, 0.74), tint, frame);
            mOv = 0.1 + 0.45 * (1.0 - frame); rOv = mix(0.1, 0.5, frame);
            litAmt = (1.0 - frame) * 0.75;
          } else if (sc > 675.0 && sc < 685.0) {
            // the Museum of the Future's skin: brushed steel cut by flowing calligraphy, which is the glazing; dark by
            // day, it glows from inside after dark (aWall.xy = position round and across the torus, 0..1)
            vec2 q = vec2(vWall.x * 120.0, vWall.y * 30.0);
            float n = vnoise(q * vec2(1.0, 1.7)) + 0.5 * vnoise(q * vec2(2.4, 3.3) + 7.0);
            float aa = clamp(fwidth(n) * 2.2, 0.0, 1.0);
            float st = (1.0 - smoothstep(0.03, 0.09 + aa, abs(fract(n * 2.3) - 0.5))) * (1.0 - aa * 0.6);
            diffuseColor.rgb = mix(tint * (0.97 + 0.05 * vnoise(q * 0.3)), vec3(0.2, 0.24, 0.28), st);
            mOv = mix(0.85, 0.55, st); rOv = mix(0.28, 0.08, st);
            litAmt = st * 1.1;
          } else if (sc > 685.0 && sc < 705.0) {
            // timber or aluminium slats: 690 vertical, 700 horizontal (aWall.x = metres along the face)
            float sl = sc < 695.0 ? vWall.x / 0.16 : vWP.y / 0.14;
            float aa = 1.0 - smoothstep(0.3, 1.0, fwidth(sl));
            float gap = smoothstep(0.62, 0.72, fract(sl)) * aa;
            diffuseColor.rgb = tint * (0.9 + 0.14 * hash12(vec2(floor(sl), seed * 31.0))) * (1.0 - 0.55 * gap) * mix(0.9, 1.0, aa);
            mOv = 0.0; rOv = 0.7;
          } else if (sc > 705.0 && sc < 715.0) {
            // stone cladding: staggered ashlar panels with fine joints
            vec2 q = vec2(vWall.x / 1.2, vWP.y / 0.6);
            q.x += 0.5 * step(0.5, fract(q.y * 0.5));
            float aa = 1.0 - smoothstep(0.3, 1.0, max(fwidth(q.x), fwidth(q.y)));
            vec2 f = fract(q);
            float joint = max(1.0 - smoothstep(0.0, 0.04, min(f.x, 1.0 - f.x)), 1.0 - smoothstep(0.0, 0.06, min(f.y, 1.0 - f.y))) * aa;
            diffuseColor.rgb = tint * (0.9 + 0.14 * hash12(floor(q) + seed * 7.0)) * (1.0 - 0.3 * joint) * (0.97 + 0.06 * vnoise(vWP.xz * 3.0 + vWP.y));
            mOv = 0.0; rOv = 0.8;
          } else if (sc > 715.0 && sc < 725.0) {
            // a geometric metal screen (mashrabiya): a lattice of squares turned through 45 degrees and axis bars, with
            // the dark glazing showing through, lit from inside after dark
            vec2 q = vec2(vWall.x, vWP.y) / 0.55;
            float aa = 1.0 - smoothstep(0.25, 0.9, max(fwidth(q.x), fwidth(q.y)));
            float l1 = abs(fract(q.x + q.y) - 0.5), l2 = abs(fract(q.x - q.y) - 0.5), l3 = min(abs(fract(q.x) - 0.5), abs(fract(q.y) - 0.5));
            float bar = max(max(1.0 - smoothstep(0.06, 0.11, l1), 1.0 - smoothstep(0.06, 0.11, l2)), 1.0 - smoothstep(0.035, 0.07, l3 - 0.43));
            bar = mix(0.55, bar, aa);
            diffuseColor.rgb = mix(vec3(0.12, 0.13, 0.14), tint, bar);
            mOv = mix(0.0, 0.55, bar); rOv = mix(0.4, 0.35, bar);
            litAmt = (1.0 - bar) * 0.8;
          } else if (sc > 645.0) {
            // tensioned fabric (Burj Al Arab's sail): matte white by day, washed with colour at night
            diffuseColor.rgb = tint * (0.97 + 0.04 * vnoise(vWP.xz * 0.05 + vWP.y * 0.02)); mOv = 0.0; rOv = 0.6; glowAmt = 1.0;
          } else {
            // balcony slab edge: plain concrete by day, an LED line at night on about a third of the towers
            diffuseColor.rgb = tint * (0.95 + 0.06 * vnoise(vWP.xz * 0.9 + vWP.y));
            ledAmt = step(seed, 0.18) * ledNear;
          }
        }
        bool isRoofS = code >= 199.5 && code < 399.5;
        if (bMode == 1.0) {
          // developer highlight keeps the real facade: a gentle hue shift on walls, the brand colour on roofs
          diffuseColor.rgb = isRoofS ? mix(diffuseColor.rgb, hl, 0.55) : mix(diffuseColor.rgb, diffuseColor.rgb * (0.6 + 0.75 * hl), 0.3);
        } else if (bMode == 4.0) { diffuseColor.rgb = mix(diffuseColor.rgb, hl, 0.3); }
        if (vGhost > 0.002) {
          // the rest of the city fades back but stays recognisable: facade pattern kept, colour washed out
          float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          vec3 g = mix(diffuseColor.rgb, vec3(l), 0.5);
          g = mix(g, vec3(0.9, 0.9, 0.92), 0.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, g, vGhost);
          glassAmt *= 1.0 - 0.3 * vGhost; litAmt *= 1.0 - 0.6 * vGhost; glowAmt *= 1.0 - vGhost; ledAmt *= 1.0 - vGhost; vled *= 1.0 - vGhost; ledFar *= 1.0 - vGhost;
          if (mOv >= 0.0) { mOv = mix(mOv, 0.05, vGhost); rOv = mix(rOv, 0.85, vGhost); }
        }
        `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.9, 0.08, glassAmt * refl);
        if (rOv >= 0.0) roughnessFactor = rOv;`)
      .replace('#include <opaque_fragment>', `
        #if NUM_DIR_LIGHTS > 0
        {
          // illustrated volume: walls turned from the sun fall into a deeper, cool shade and sunlit walls warm up,
          // so every block reads as a light side and a dark side (by day; roofs keep their light)
          float sNL = dot(normal, directionalLights[ 0 ].direction);
          vec3 sUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float sWall = 1.0 - smoothstep(0.5, 0.9, abs(dot(normal, sUp)));
          float sDay = (1.0 - uNight) * uPop;
          outgoingLight *= mix(vec3(1.0), vec3(0.62, 0.74, 1.0), smoothstep(0.3, -0.05, sNL) * sWall * sDay);
          outgoingLight *= mix(vec3(1.0), vec3(1.12, 1.06, 0.95), smoothstep(0.25, 0.75, sNL) * sWall * sDay);
          // Light bounced off the ground: the foot of every wall picks up the colour of the lawn, sand or paving a
          // few metres in front of it (read from the ground painting), fading with height; undersides take the most.
          if (uGndOn > 0.5) {
            vec3 gN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
            vec2 gp = vWP.xz + gN.xz * 7.0;
            vec3 gcol = texture2D(uGndL, vec2((gp.x - uGndB.x) / uGndB.z, (uGndB.y + gp.y) / uGndB.w)).rgb;
            float gFace = clamp(0.6 - 0.65 * gN.y, 0.0, 1.25);
            outgoingLight += diffuseColor.rgb * gcol * gFace * exp(-max(vWP.y, 0.0) / 10.0) * 0.34 * sDay;
          }
        }
        #endif
        #include <opaque_fragment>`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = glassAmt * refl * 0.75;
        if (mOv >= 0.0) metalnessFactor = mOv;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // the colour of the light in each window: mostly warm lamps, some amber, some neutral white, a few cool
          // (screens, daylight tubes); office floors run cool white. Bright enough for the night glow to catch.
          vec3 warm = winTone < 0.5 ? vec3(1.0, 0.7, 0.4) : winTone < 0.74 ? vec3(1.0, 0.56, 0.24) : winTone < 0.92 ? vec3(1.0, 0.9, 0.76) : vec3(0.7, 0.82, 1.0);
          warm = mix(warm, vec3(0.84, 0.92, 1.0), winOffice * 0.85);
          totalEmissiveRadiance += warm * litAmt * uNight * 1.12;
          // keep the massing legible after dark: a faint lift of the facade colour, a cool sheen of night sky on
          // the glass, and the warm glow of the street on the lower floors
          totalEmissiveRadiance += diffuseColor.rgb * uNight * 0.055;
          totalEmissiveRadiance += vec3(0.014, 0.028, 0.06) * glassAmt * uNight;
          float stGlow = 1.0 - smoothstep(0.0, 26.0, vWP.y);
          totalEmissiveRadiance += vec3(1.0, 0.64, 0.34) * uNight * 0.17 * stGlow * stGlow * step(code, 199.5);
          // accent lighting: a thin LED line under the parapet of many towers, LED balcony edges, LED strips
          vec3 led = seed < 0.12 ? vec3(0.2, 0.7, 1.0) : seed < 0.22 ? vec3(0.3, 0.45, 1.0) : seed < 0.3 ? vec3(0.62, 0.38, 1.0) : vec3(0.9, 0.94, 1.0);
          float crown = step(90.0, vWall.z) * step(code, 99.5) * step(seed, 0.6) * (1.0 - smoothstep(0.25, 0.55, abs(vWP.y - (vWall.z - 0.9))));
          totalEmissiveRadiance += led * crown * uNight * mix(0.9, 1.6, ledNear);
          totalEmissiveRadiance += led * ledAmt * uNight * 1.1;
          totalEmissiveRadiance += led * vled * uNight * 1.1;
          totalEmissiveRadiance += led * ledFar * uNight * 0.07;
          if (bMode == 1.0) {
            // soft pulse plus a lit band along the top edge marks the developer's towers
            float topBand = smoothstep(vWall.z - 2.5, vWall.z - 0.2, vWP.y) * (1.0 - step(vWall.z + 0.02, vWP.y)) * step(code, 199.5);
            totalEmissiveRadiance += hl * (0.05 + 0.04 * sin(uTime * 2.2) + 0.3 * uNight + 0.55 * topBand);
          }
          if (bMode == 4.0) totalEmissiveRadiance += hl * (0.32 + 0.22 * sin(uTime * 3.2));
          if (abs(vBid - uHover) < 0.5) totalEmissiveRadiance += vec3(0.16, 0.13, 0.07);
          // Burj Khalifa's LED facade: the pixels sit on the fins (thin vertical lines up close, an even wash from afar)
          if (abs(vBid - uLedB.w) < 0.5 && uLedB.z > 0.001 && vWP.y > 26.0 && (code < 99.5 || (code > 599.5 && code < 605.0))) {
            vec2 rel = vWP.xz - uLedC.xy;
            float la = atan(rel.y, rel.x) / 6.2831853 + 0.5, lh = clamp(vWP.y / uLedC.z, 0.0, 1.0);
            vec3 lc = mix(ledPattern(uLedA.x, uLedA.y, la, lh, 0), ledPattern(uLedA.z, uLedA.w, la, lh, 3), uLedB.x);
            float fin = 1.0 - smoothstep(0.1, 0.24, abs(fract(vWall.x / 1.7 + 0.5) - 0.5));
            float pix = mix(0.6, max(fin, 0.1), ledNear) * (code > 599.5 ? 0.7 : 1.0);
            totalEmissiveRadiance += lc * pix * uLedB.z;
            diffuseColor.rgb *= 1.0 - min(uLedB.z, 1.0) * (0.35 + 0.25 * uNight);
          }
          if (glowAmt > 0.0) {
            // crowns and domes light up after dark, slowly cycling colour
            float ph = uTime * 0.12 + seed * 6.0;
            vec3 cyc = 0.6 + 0.4 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + ph));
            bool fabric = code > 645.0, pool = code > 625.0 && !fabric;
            // the sail is washed in slowly changing colour, brightest toward the top
            vec3 lightC = pool ? vec3(0.1, 0.75, 0.95) : fabric ? cyc * (0.55 + 0.45 * clamp(vWP.y / max(vWall.z, 1.0), 0.0, 1.0)) : mix(vec3(1.0, 0.9, 0.7), cyc, 0.7);
            totalEmissiveRadiance += lightC * glowAmt * uNight * (pool ? 0.8 : fabric ? 0.55 : 0.75);
          }
        }`);
  };

  const mkMat = (lod) => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
    if (lod) m.defines = { BLD_LOD: '' };
    m.onBeforeCompile = compile;
    m.userData.shared = true;
    if (ctx.env) ctx.env.addReflective(m, 1.15);
    return m;
  };
  const mkDepth = (lod) => {
    const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    if (lod) m.defines = { BLD_LOD: '' };
    m.onBeforeCompile = (s) => {
      s.uniforms.uState = uState; s.uniforms.uCut = uCut; s.uniforms.uAnim = uAnim;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_DECL)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BODY);
    };
    m.userData.shared = true;
    return m;
  };
  const mat = mkMat(false), matLod = mkMat(true), depthMat = mkDepth(false), depthLod = mkDepth(true);

  // ---- rooftop equipment (AC units + water tanks), hidden with their building's state
  const EQ_DECL = `attribute float aEqBid; uniform sampler2D uState, uAnim; uniform float uCut; varying float vEqDim; ${STATE_FETCH}`;
  const EQ_BODY = `{ vec4 st = bState(aEqBid); vec4 an = bAnim(aEqBid); float m = floor(st.r * 255.0 + 0.5); vEqDim = an.g; if (an.r < 0.98 || m == 5.0 || m == 6.0) transformed *= 0.0; }`;
  const eqBase = [
    new THREE.BoxGeometry(2.1, 1.25, 1.5).translate(0, 0.62, 0),
    new THREE.CylinderGeometry(0.75, 0.75, 1.7, 10).translate(0, 0.85, 0),
  ];
  const eqColors = ['#d6d8d8', '#f1efe8'];
  const eqMat = eqColors.map((c, kind) => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: kind === 0 ? 0.25 : 0 });
    m.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, { uState, uCut, uAnim });
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\n' + EQ_DECL).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + EQ_BODY);
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vEqDim;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.87, 0.9), vEqDim);');
    };
    m.userData.shared = true;
    return m;
  });
  const eqDepth = eqColors.map(() => {
    const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    dm.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, { uState, uCut, uAnim });
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\n' + EQ_DECL.replace('varying float vEqDim;', 'float vEqDim;')).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + EQ_BODY);
    };
    dm.userData.shared = true;
    return dm;
  });
  function equipmentMeshes(equipment) {
    const out = [];
    const mt = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), pv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    eqBase.forEach((base, kind) => {
      const items = equipment.filter((e) => e[4] === kind);
      if (!items.length) return;
      const g = base.clone();
      const im = new THREE.InstancedMesh(g, eqMat[kind], items.length);
      const bids = new Float32Array(items.length);
      items.forEach((e, k) => { pv.set(e[0], e[1], e[2]); q.setFromAxisAngle(up, e[3]); const s2 = 0.85 + ((k * 0.618) % 1) * 0.35; sc.set(s2, s2, s2); mt.compose(pv, q, sc); im.setMatrixAt(k, mt); bids[k] = e[5]; });
      g.setAttribute('aEqBid', new THREE.InstancedBufferAttribute(bids, 1));
      im.castShadow = true; im.receiveShadow = true; im.customDepthMaterial = eqDepth[kind];
      im.name = 'rooftop-equipment';
      im.computeBoundingSphere();
      out.push(im);
    });
    return out;
  }

  // ---- filter animation: per building height factor k and ghost g eased toward their targets,
  // staggered outward from a focus point so the change ripples across the city
  const A = { kFrom: new Float32Array(N).fill(1), kTo: new Float32Array(N).fill(1), kT0: new Float32Array(N), kDur: new Float32Array(N).fill(1), kEase: new Uint8Array(N),
    gFrom: new Float32Array(N), gTo: new Float32Array(N), gT0: new Float32Array(N), gDur: new Float32Array(N).fill(1) };
  const curK = new Float32Array(N).fill(1), curG = new Float32Array(N);
  const live = new Set(); let clock = 0; const focus = [0, 0];
  const info = new Array(N);
  const easeOutBack = (x) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const stagger = (i) => { const c = info[i] ? info[i].center : null; const d = c ? Math.hypot(c[0] - focus[0], c[1] - focus[1]) : 0; return Math.min(1.1, d * 0.00045) + ((i * 0.618) % 1) * 0.12; };
  function animate(i, kTo, gTo, pop) {
    if (pop) { curK[i] = 0; A.kFrom[i] = 0; A.kTo[i] = 1; A.kT0[i] = clock + 0.15 + stagger(i) * 0.6; A.kDur[i] = 0.95; A.kEase[i] = 1; live.add(i); }
    else if (Math.abs(A.kTo[i] - kTo) > 1e-3) { A.kFrom[i] = curK[i]; A.kTo[i] = kTo; A.kT0[i] = clock + stagger(i); A.kDur[i] = kTo < curK[i] ? 0.7 : 0.9; A.kEase[i] = kTo > curK[i] ? 1 : 0; live.add(i); }
    if (Math.abs(A.gTo[i] - gTo) > 1e-3) { A.gFrom[i] = curG[i]; A.gTo[i] = gTo; A.gT0[i] = clock + stagger(i) * 0.7; A.gDur[i] = 0.5; live.add(i); }
  }
  ctx.updaters.push((dt) => {
    clock += Math.min(dt, 0.1);
    if (!live.size) return;
    for (const i of live) {
      let done = true;
      const tk = (clock - A.kT0[i]) / A.kDur[i];
      if (tk < 1) done = false;
      const xk = Math.max(0, Math.min(1, tk));
      curK[i] = A.kFrom[i] + (A.kTo[i] - A.kFrom[i]) * (A.kEase[i] ? easeOutBack(xk) : easeInOut(xk));
      const tg = (clock - A.gT0[i]) / A.gDur[i];
      if (tg < 1) done = false;
      const xg = Math.max(0, Math.min(1, tg));
      curG[i] = A.gFrom[i] + (A.gTo[i] - A.gFrom[i]) * easeInOut(xg);
      animData[i * 4] = Math.max(0, Math.min(255, Math.round(curK[i] * 255)));
      animData[i * 4 + 1] = Math.round(curG[i] * 255);
      if (done) live.delete(i);
    }
    animTex.needsUpdate = true;
  });

  // ---- the light whole-city meshes, chunked on the streaming grid (off-screen chunks are culled, and a chunk
  // hides while its cell's detail is shown); this pass also fills the info every panel reads
  const S = new Map(); // section id -> { sec, lods: Map(cell -> mesh), cells: Map(cell -> detail) }
  const stats = { liteVerts: 0, detailVerts: 0, balconyTris: 0 };
  ctx.stats = Object.assign(ctx.stats || {}, { buildings: stats });
  const bvhQueue = []; // meshes waiting for their picking BVH (built in idle moments, or when a ray needs it)
  {
    const sl = slicer(60);
    let done = 0;
    for (const sec of secs) {
      const st = { sec, lods: new Map(), cells: new Map() };
      S.set(sec.id, st);
      const buckets = new Map();
      for (let k = 0; k < sec.bn; k++) {
        const key = cellKey(centroid(world[sec.b0 + k].p[0]));
        let b = buckets.get(key); if (!b) buckets.set(key, (b = [])); b.push(k);
      }
      for (const [key, ks] of buckets) {
        const bl = createGeoBuilder(true);
        for (const k of ks) {
          const gid = sec.b0 + k;
          info[gid] = bl.add(world[gid], gid);
          done++;
          if (sl.due()) { if (progress) progress(done / N); await sl.yield(); }
        }
        const out = bl.finish(false);
        if (!out) continue;
        const lod = new THREE.Mesh(out.geo, matLod);
        lod.castShadow = true; lod.receiveShadow = true; lod.customDepthMaterial = depthLod;
        lod.name = 'buildings-lite'; lod.userData.lod = true;
        ctx.scene.add(lod);
        st.lods.set(key, lod); bvhQueue.push(lod);
        stats.liteVerts += out.verts;
      }
    }
  }

  // ---- detail, streamed cell by cell (the section streamer decides which cells are near the view)
  const gate = () => (ctx.workGate ? ctx.workGate() : new Promise((r) => setTimeout(r, 0)));
  // rooftop plant is only drawn close in
  let eqShown = true;
  const eqWanted = () => !ctx.activeCamera.isOrthographicCamera || ctx.activeCamera.zoom > 1.3;
  ctx.updaters.push(() => {
    const v = eqWanted(); if (v === eqShown) return;
    eqShown = v;
    for (const st of S.values()) for (const C of st.cells.values()) for (const m of C.eq) m.visible = v;
  });
  async function buildCell(id, key, list, idxs, parent) {
    const st = S.get(id); if (!st || st.cells.has(key)) return false;
    const sec = st.sec;
    const C = { group: new THREE.Group(), mesh: null, eq: [], idxs, cancelled: false };
    C.group.name = 'buildings-' + key; parent.add(C.group);
    st.cells.set(key, C);
    const bl = createGeoBuilder(false);
    const sl = slicer(8, gate);
    for (const k of idxs) {
      bl.add(list[k], sec.b0 + k);
      if (sl.due()) { await sl.yield(); if (C.cancelled) return false; }
    }
    const out = bl.finish(false);
    if (C.cancelled) { if (out) out.geo.dispose(); return false; }
    if (out) {
      const mesh = new THREE.Mesh(out.geo, mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.customDepthMaterial = depthMat;
      mesh.name = 'buildings';
      C.mesh = mesh; C.eq = equipmentMeshes(out.equipment);
      for (const m of C.eq) m.visible = eqShown;
      C.group.add(mesh, ...C.eq);
      stats.detailVerts += out.verts; stats.balconyTris += out.balcTris;
      bvhQueue.push(mesh);
    }
    const lod = st.lods.get(key); if (lod) lod.visible = false; // the light chunk steps aside
    return true;
  }
  function disposeCell(id, key) {
    const st = S.get(id); const C = st && st.cells.get(key); if (!C) return;
    C.cancelled = true; st.cells.delete(key);
    if (C.mesh) {
      const g = C.mesh.geometry;
      stats.detailVerts -= g.attributes.aBid ? g.attributes.aBid.count : 0;
      if (g.boundsTree) g.disposeBoundsTree();
      g.dispose();
    }
    for (const m of C.eq) { m.geometry.dispose(); m.dispose(); }
    C.group.removeFromParent();
    const lod = st.lods.get(key); if (lod) lod.visible = true;
  }
  // one picking BVH per frame while the map is still
  ctx.updaters.push(() => {
    if (!bvhQueue.length || (ctx.isInteracting && ctx.isInteracting())) return;
    const m = bvhQueue.shift();
    if (m.parent && !m.geometry.boundsTree && m.geometry.attributes.position.count) m.geometry.computeBoundsTree();
  });

  // ---- API
  const modes = new Uint8Array(N);
  const _sph = new THREE.Sphere();
  const pickables = (ray) => {
    const out = [];
    // a mesh the ray reaches gets its BVH now rather than waiting for an idle moment
    const take = (m) => {
      if (!m.geometry.boundsTree && ray && ray.intersectsSphere(_sph.copy(m.geometry.boundingSphere))) m.geometry.computeBoundsTree();
      out.push(m);
    };
    for (const st of S.values()) {
      for (const lod of st.lods.values()) if (lod.visible) take(lod);
      for (const C of st.cells.values()) if (C.mesh) take(C.mesh);
    }
    return out;
  };
  const bidOf = (h) => { const g = h.object.geometry; return g.attributes.aBid.getX(g.index.getX(h.faceIndex * 3)); };
  const api = {
    info, count: N, modes, uHover, uPop, uCut, sections: S, stats,
    led: { uLedA, uLedB, uLedC, uLedPal },
    buildCell, disposeCell,
    setFocus(x, y) { focus[0] = x; focus[1] = y; },
    setState(i, mode, color, opts = {}) {
      const prev = modes[i];
      modes[i] = mode;
      stateData[i * 4] = mode;
      // FLAT sinks to the footprint, DIM/FLAT ghost; a newly highlighted tower pops up from the ground
      const kTo = mode === MODE.FLAT ? 0 : 1, gTo = mode === MODE.DIM || mode === MODE.FLAT ? 1 : 0;
      if (opts.instant) { curK[i] = A.kFrom[i] = A.kTo[i] = kTo; curG[i] = A.gFrom[i] = A.gTo[i] = gTo; animData[i * 4] = kTo * 255; animData[i * 4 + 1] = gTo * 255; animTex.needsUpdate = true; }
      else animate(i, kTo, gTo, mode === MODE.HIGHLIGHT && prev !== MODE.HIGHLIGHT && opts.pop !== false);
      if (color) { const c = color.isColor ? color : new THREE.Color(color); stateData[i * 4 + 1] = c.r * 255; stateData[i * 4 + 2] = c.g * 255; stateData[i * 4 + 3] = c.b * 255; }
    },
    resetStates() { stateData.fill(0); modes.fill(0); },
    commit() { stateTex.needsUpdate = true; },
    pick(raycaster) {
      const hits = raycaster.intersectObjects(pickables(raycaster.ray), false);
      for (const h of hits) {
        const bid = bidOf(h);
        if (modes[bid] === MODE.FLAT || modes[bid] === MODE.HIDDEN) continue;
        return { index: bid, point: h.point, distance: h.distance };
      }
      return null;
    },
    raycastFirst(origin, dir, far, ignore = -1) {
      const rc = api._rc || (api._rc = new THREE.Raycaster());
      rc.set(origin, dir); rc.far = far; rc.firstHitOnly = ignore < 0;
      const hits = rc.intersectObjects(pickables(rc.ray), false);
      for (const h of hits) {
        const bid = bidOf(h);
        if (bid === ignore) continue;
        return { index: bid, distance: h.distance };
      }
      return null;
    },
  };
  return api;
}
