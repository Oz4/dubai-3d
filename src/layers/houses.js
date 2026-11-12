// Researched house models. Each kit rebuilds one community's houses from the developer's floor plans, brochures and
// photographs (data-raw/research/<area>/<community>/research.json lists every source). A kit works in a local frame
// fixed to the footprint: x runs along the street frontage (to the right, seen from the street), y from the street
// to the back garden, z up, all in metres. OSM supplies where each house stands, how it is turned and which side
// faces its street; the kit supplies what it looks like.
import * as THREE from 'three';
import { SIDRA, frame2D, planMap, MAPLE, mapleCluster, mapleX, mapleY, pairLayout, golfPlaceLayout, luxuryLayout, rectCover } from './house-specs.js';

const C = (h) => new THREE.Color(h);
export const colour = C;

// the local frame of a footprint (shared with the data build, so plots, driveways and cars line up)
export function houseFrame(T, B) {
  return frame2D(T.ccw(B.outer[0]), B.b.hf, { short: B.b.hk === 'sidra' });
}

// drawing helpers bound to one house: every coordinate is local (x, y, z)
export function houseKit(T, B, F, base = {}) {
  const o = { ...B.o, base: 0, top: B.b.h, fh: 3.4, center: F.P(0, F.D / 2), ...base };
  const lite = T.lite;
  const ring2 = (pts) => T.ccw(pts.map(([x, y]) => F.P(x, y)));
  const n2 = { front: [-F.yv[0], -F.yv[1]], back: F.yv, left: [-F.xv[0], -F.xv[1]], right: F.xv };
  const H = {
    T, B, F, o, lite, P: F.P,
    ring: ring2,
    // a solid volume over a local rectangle (or polygon); top: 'flat' cap, 'parapet' wall + coping, or 'none'
    box(x0, y0, x1, y1, z0, z1, { code = T.codes.SOLID, color, top = 'flat', roof, par = 0.6, parColor, poly } = {}) {
      const r = ring2(poly || [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
      const oo = { ...o, base: z0, top: z1 };
      const col = color || o.wall;
      T.walls(r, z0, z1, oo, code, { color: col });
      if (z0 > 0.3) T.cap([r], z0, oo, T.codes.SOLID, col.clone().multiplyScalar(0.85), true);
      if (top === 'parapet' && !lite) return T.parapetRoof(r, z1, par, oo, T.codes.ROOF + T.L.roofConcrete, roof || C('#d9d6cf'), parColor || col);
      if (top !== 'none') T.cap([r], z1, oo, roof ? T.codes.ROOF + T.L.roofConcrete : T.codes.SOLID, roof || col);
      return r;
    },
    // a flat panel on a face: face 'front' | 'back' | 'left' | 'right', `at` = the wall's local y (front/back) or x
    // (left/right), a..b along the face, z0..z1, standing `off` metres proud of the wall
    panel(face, at, a, b, z0, z1, color, code, off = 0.05) {
      if (lite) return;
      const n = n2[face];
      const p0 = face === 'front' || face === 'back' ? F.P(a, at) : F.P(at, a);
      const p1 = face === 'front' || face === 'back' ? F.P(b, at) : F.P(at, b);
      // run the ends left to right for someone facing the wall from outside
      const right = [-n[1], n[0]];
      let [q0, q1] = (p1[0] - p0[0]) * right[0] + (p1[1] - p0[1]) * right[1] >= 0 ? [p0, p1] : [p1, p0];
      q0 = [q0[0] + n[0] * off, q0[1] + n[1] * off]; q1 = [q1[0] + n[0] * off, q1[1] + n[1] * off];
      const L = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
      T.quad([q0[0], q0[1], z0], [q1[0], q1[1], z0], [q1[0], q1[1], z1], [q0[0], q0[1], z1], o, color, code, [[0, z0], [L, z0], [L, z1], [0, z1]]);
    },
    // a window: frame, glass (lit after dark through the glass code) and optional mullions
    window(face, at, a, b, z0, z1, { frame = C('#3b3f44'), glass = C('#4b5a66'), mullions = 0, fw = 0.08 } = {}) {
      if (lite) return;
      H.panel(face, at, a, b, z0, z1, frame, T.codes.SOLID, 0.03);
      H.panel(face, at, a + fw, b - fw, z0 + fw, z1 - fw, glass, T.codes.GLASSY, 0.05);
      for (let k = 1; k <= mullions; k++) { const m = a + ((b - a) * k) / (mullions + 1); H.panel(face, at, m - 0.035, m + 0.035, z0, z1, frame, T.codes.SOLID, 0.06); }
    },
    // a pergola: posts and slats
    pergola(x0, y0, x1, y1, z, color, slats = 9) {
      if (lite) return;
      const post = 0.15;
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) H.box(x - post, y - post, x + post, y + post, z - 3.0, z, { color });
      for (let k = 0; k <= slats; k++) { const x = x0 + ((x1 - x0) * k) / slats; H.box(x - 0.05, y0, x + 0.05, y1, z - 0.2, z, { color }); }
    },
  };
  return H;
}

// drawing in a developer plan's coordinates (x across the plot towards the carport side, y into the plot), mirrored
// when the house is (m = -1)
function planKit(T, B, spec) {
  const F = houseFrame(T, B); if (!F) return null;
  const H = houseKit(T, B, F);
  const m = B.b.hm || 1;
  const M = planMap(spec, m, F.D);
  const xr = (a, b) => { const p = M.X(a), q = M.X(b); return p < q ? [p, q] : [q, p]; };
  const side = (f) => (m < 0 && (f === 'left' || f === 'right') ? (f === 'left' ? 'right' : 'left') : f);
  const K = {
    T, B, F, H, M, m, lite: T.lite,
    box(x0, x1, y0, y1, z0, z1, opt) { const [a, b] = xr(x0, x1); return H.box(a, M.Y(y0), b, M.Y(y1), z0, z1, opt); },
    prism(pts, z0, z1, opt) { return H.box(0, 0, 0, 0, z0, z1, { ...opt, poly: pts.map(([x, y]) => [M.X(x), M.Y(y)]) }); },
    panel(face, at, a, b, z0, z1, color, code, off) {
      if (face === 'front' || face === 'back') { const [p, q] = xr(a, b); H.panel(face, M.Y(at), p, q, z0, z1, color, code, off); }
      else H.panel(side(face), M.X(at), M.Y(a), M.Y(b), z0, z1, color, code, off);
    },
    window(face, at, a, b, z0, z1, opt) {
      if (face === 'front' || face === 'back') { const [p, q] = xr(a, b); H.window(face, M.Y(at), p, q, z0, z1, opt); }
      else H.window(side(face), M.X(at), M.Y(a), M.Y(b), z0, z1, opt);
    },
    // a 'picture frame': a deep rectangular tube round an opening (no bottom when it stands on a roof)
    frame(x0, x1, y0, y1, z0, z1, t, color, bottom = true) {
      K.box(x0, x1, y0, y1, z1 - t, z1, { color });
      if (bottom) K.box(x0, x1, y0, y1, z0, z0 + t, { color });
      K.box(x0, x0 + t, y0, y1, z0, z1 - t, { color });
      K.box(x1 - t, x1, y0, y1, z0, z1 - t, { color });
    },
    pergola(x0, x1, y0, y1, z, color) { const [a, b] = xr(x0, x1); H.pergola(a, M.Y(y0), b, M.Y(y1), z, color); },
  };
  return K;
}

// ---------------------------------------------------------------- Sidra 1-3 (Emaar, 2019-2020)
// Contemporary cubic villas: white render (#ECEBE5) with mid-grey 'picture frames' and portal frames (#9C9F9E),
// anthracite windows and louvres, a teak pivot door, an open 2-car carport at the street corner and a low white wall
// with grey bar railings (plot walls: layers/details.js). Geometry from the Sidra 3 brochure plans (E1, E3, E5); heights
// are estimated from photographs (no elevations were published). Plan coordinates as in house-specs.js.
const SW = {
  white: C('#ecebe5'), grey: C('#9c9f9e'), frame: C('#45484b'), glass: C('#2a3a48'), louvre: C('#3c414b'), rail: C('#4e5154'),
  door: C('#a97a45'), gdoor: C('#c8cac5'), roof: C('#d8d8d3'), terrace: C('#e2d6c0'), ac: C('#8e9190'),
};
const Z1 = 3.95, Z2 = 7.25, PAR = 0.55, TOWER = 8.45, CP0 = 2.75, CP1 = 3.25;
const WIN = { frame: SW.frame, glass: SW.glass };
function rail(K, face, at, a, b) {
  K.panel(face, at, a, b, Z1, Z1 + 1.1, SW.rail, K.T.codes.SLATV, 0.02);
  K.panel(face, at, a, b, Z1 + 1.04, Z1 + 1.12, SW.rail, K.T.codes.SOLID, 0.04);
}
function door(K, face, at, a, b, side) {
  K.panel(face, at, a, b, 0.45, 3.0, SW.door, K.T.codes.SLATV, 0.05);
  K.window(face, at, b + 0.04, side, 0.45, 3.0);
}
const SIDRA_GEOM = {
  E1: {
    gf: [[3, 5], [8, 5], [8, 6.8], [11.8, 6.8], [11.8, 19.8], [6.5, 19.8], [6.5, 15.6], [3, 15.6]],
    ff: [[3, 5], [5.5, 5], [5.5, 4.0], [11.6, 4.0], [11.6, 17.8], [3, 17.8]],
    tower: [3.0, 5.5, 5.0, 9.0], ac: [6.2, 9.8, 9.5, 12.5],
    carRoof: [[8, 0], [14.9, 0], [14.9, 6.8], [11.6, 6.8], [11.6, 4.0], [8, 4.0]], passage: [11.8, 14.6, 6.8],
    terrace: [[3.0, 11.8, 19.8, 22.4], [3.0, 6.5, 15.6, 19.8]],
    details(K) {
      // street front: the grey frame round bedroom 2 and the study, cantilevered over the entrance
      K.frame(5.5, 11.9, 3.0, 4.0, 3.55, 7.7, 0.45, SW.grey);
      K.window('front', 4.0, 5.9, 7.3, 4.4, 6.9, { mullions: 1 });
      K.window('front', 4.0, 8.0, 11.1, 4.05, 6.9, { mullions: 2 });
      rail(K, 'front', 3.07, 7.7, 11.45);
      door(K, 'front', 5.0, 6.05, 7.05, 7.45);
      K.window('front', 5.0, 3.7, 4.5, 1.4, 2.4);
      K.panel('front', 5.0, 3.45, 5.15, 4.3, 7.3, SW.louvre, K.T.codes.SLATH, 0.06);
      // garden side: glazed living bay, the master balcony in its grey box, covered terrace beside
      K.window('back', 19.8, 7.0, 11.3, 0.5, 3.4, { mullions: 3 });
      K.frame(6.2, 11.9, 17.8, 20.0, Z1, 7.5, 0.35, SW.grey, false);
      K.window('back', 17.8, 7.0, 11.0, 4.05, 6.9, { mullions: 2 });
      rail(K, 'back', 19.93, 6.6, 11.5);
      K.window('back', 15.6, 3.4, 6.1, 0.5, 3.4, { mullions: 1 });
      K.window('back', 17.8, 4.0, 5.4, 5.0, 6.4);
      K.window('left', 3.0, 6.0, 6.6, 1.2, 7.2);
      K.window('left', 3.0, 12.5, 13.1, 5.0, 6.8);
      K.window('left', 3.0, 13.0, 14.5, 1.0, 2.4);
      K.window('right', 11.8, 8.5, 9.5, 1.4, 2.4);
      K.window('right', 11.6, 11.0, 12.6, 4.5, 6.9);
    },
  },
  E3: {
    gf: [[3, 3], [6.8, 3], [6.8, 6.5], [9.2, 6.5], [9.2, 7.0], [12.5, 7.0], [12.5, 20], [3.5, 20], [3.5, 15], [6.5, 15], [6.5, 12], [3, 12]],
    ff: [[3, 5], [12.5, 5], [12.5, 19.5], [7.3, 19.5], [7.3, 15], [3, 15]],
    ac: [8.2, 11.6, 9.4, 12.4],
    carRoof: [[9.2, 0], [15.7, 0], [15.7, 7.0], [12.5, 7.0], [12.5, 5.0], [9.2, 5.0]], passage: [12.5, 15.4, 7.0],
    terrace: [[3.5, 12.5, 20, 22.5], [3.0, 6.5, 12, 15]],
    details(K) {
      // the wing projecting to the street: the study's big window, bedroom 2's balcony above under a deep canopy
      K.window('front', 3.0, 3.5, 6.3, 0.6, 3.3, { mullions: 2 });
      K.box(2.75, 7.25, 2.7, 5.0, 7.05, 7.5, { color: SW.white });
      K.box(3.0, 3.3, 3.0, 5.0, Z1, 7.05, { color: SW.white });
      K.window('front', 5.0, 3.7, 6.5, 4.05, 6.9, { mullions: 1 });
      rail(K, 'front', 3.07, 3.35, 6.9);
      // the entrance, recessed between the wing and the carport
      door(K, 'front', 6.5, 7.3, 8.35, 8.75);
      // bedroom 3 over the back of the carport: its window in a grey surround
      K.panel('front', 5.0, 9.0, 9.55, Z1, Z2, SW.grey, K.T.codes.SOLID, 0.14);
      K.panel('front', 5.0, 9.0, 12.5, 6.95, Z2, SW.grey, K.T.codes.SOLID, 0.14);
      K.window('front', 5.0, 9.8, 11.9, 4.3, 6.7, { mullions: 1 });
      // garden side: full-width living/dining glazing, the master suite, the rear balcony under a slatted pergola
      K.window('back', 20.0, 4.0, 12.0, 0.5, 3.4, { mullions: 4 });
      K.window('back', 19.5, 7.8, 12.0, 4.05, 6.9, { mullions: 2 });
      K.window('back', 15.0, 3.8, 6.9, 4.05, 6.9, { mullions: 1 });
      K.pergola(3.5, 7.3, 15.0, 19.5, Z2 - 0.05, SW.grey);
      rail(K, 'back', 19.45, 3.6, 7.2);
      // the stair window behind vertical louvres on the side
      K.panel('left', 3.0, 9.8, 10.7, 1.0, 7.0, SW.louvre, K.T.codes.SLATV, 0.06);
      K.window('left', 3.0, 7.6, 8.3, 1.5, 2.4);
      K.window('right', 12.5, 8.5, 9.5, 1.4, 2.4);
      K.window('right', 12.5, 9.6, 11.2, 4.5, 6.9);
      K.window('right', 12.5, 13.0, 14.0, 5.2, 6.6);
    },
  },
  E5: {
    gf: [[3, 10], [9.0, 10], [9.0, 3.0], [13.6, 3.0], [13.6, 7.3], [18, 7.3], [18, 15.8], [17.3, 15.8], [17.3, 21.5], [12.4, 21.5], [12.4, 17.8], [3, 17.8]],
    ff: [[3, 9.5], [9.5, 9.5], [9.5, 3.0], [15.7, 3.0], [15.7, 7.5], [18, 7.5], [18, 13], [17.3, 13], [17.3, 19], [12.5, 19], [12.5, 16.5], [3, 16.5]],
    tower: [3.0, 7.0, 9.5, 13.0], ac: [8.6, 12.4, 10.4, 13.2],
    carRoof: [[14.4, 0], [21, 0], [21, 7.3], [15.7, 7.3], [15.7, 3.0], [14.4, 3.0]], passage: [18.0, 20.7, 7.3],
    terrace: [[3.0, 12.4, 17.8, 22.2]],
    details(K) {
      // street front: the projecting cube (guest room below, bedroom 2 above) between the entrance and the carport
      K.window('front', 3.0, 9.6, 12.6, 0.8, 3.2, { mullions: 1 });
      K.window('front', 3.0, 10.2, 14.6, 4.3, 6.9, { mullions: 2 });
      K.box(7.0, 9.0, 7.5, 9.5, 3.6, 3.95, { color: SW.white });
      door(K, 'front', 10.0, 7.4, 8.45, 8.85);
      K.panel('front', 9.5, 3.5, 6.5, 4.3, 7.4, SW.louvre, K.T.codes.SLATH, 0.06);
      // garden side: the two-storey grey portal frame over the first-floor balconies and the covered terrace
      K.box(2.6, 3.4, 16.5, 21.5, 0, 7.95, { color: SW.grey });
      K.box(16.9, 17.7, 16.5, 21.5, 0, 7.95, { color: SW.grey });
      K.box(2.6, 17.7, 16.5, 21.5, 7.1, 7.95, { color: SW.grey });
      K.box(3.4, 12.4, 16.5, 19.0, 3.6, Z1, { color: SW.white });
      rail(K, 'back', 18.93, 3.5, 12.35);
      rail(K, 'back', 21.13, 12.6, 16.8);
      K.window('back', 17.8, 3.6, 12.0, 0.5, 3.4, { mullions: 5 });
      K.window('back', 21.5, 13.0, 16.6, 0.5, 3.4, { mullions: 2 });
      K.window('back', 16.5, 3.6, 6.6, 4.05, 6.9, { mullions: 1 });
      K.window('back', 16.5, 8.4, 11.8, 4.05, 6.9, { mullions: 1 });
      K.window('back', 19.0, 13.0, 16.6, 4.05, 6.9, { mullions: 2 });
      K.window('left', 3.0, 13.5, 14.5, 1.0, 2.6);
      K.window('right', 18.0, 9.0, 10.0, 1.4, 2.4);
      K.window('right', 18.0, 9.0, 10.5, 5.0, 6.6);
    },
  },
};
function sidra(T, B) {
  const type = B.b.ht && SIDRA_GEOM[B.b.ht] ? B.b.ht : 'E3';
  const g = SIDRA_GEOM[type], K = planKit(T, B, SIDRA[type]); if (!K) return false;
  const win = K.window; K.window = (f, at, a, b, z0, z1, opt = {}) => win(f, at, a, b, z0, z1, { ...WIN, ...opt });
  const roof = { color: SW.white, top: 'parapet', par: PAR, roof: SW.roof, parColor: SW.white };
  K.prism(g.gf, 0, Z1, { color: SW.white, top: 'flat', roof: SW.roof });
  K.prism(g.ff, Z1, Z2, roof);
  if (g.tower) { const [x0, x1, y0, y1] = g.tower; K.box(x0, x1, y0, y1, 0, TOWER - PAR, roof); }
  // the open carport: roof slab, the wall on the plot boundary and a pier at the house side; about a third of the
  // owners have closed theirs with a sectional garage door
  const [cx0, cx1, , cy1] = SIDRA[type].carport;
  K.prism(g.carRoof, CP0, CP1, { color: SW.white, top: 'flat', roof: SW.roof });
  K.box(cx1 - 0.3, cx1, 0, cy1, 0, CP0, { color: SW.white });
  K.box(cx0, cx0 + 0.35, 0, 0.4, 0, CP0, { color: SW.white });
  const shut = ((B.i * 2654435761) >>> 0) % 100 < 34;
  if (shut) K.panel('front', 0, cx0 + 0.35, cx1 - 0.3, 0.02, CP0, SW.gdoor, T.codes.SLATH, 0.12);
  else { const [px0, px1, py] = g.passage; K.panel('front', py, px0, px1, 0, 2.2, SW.grey, T.codes.SLATV, 0.04); }
  // rooftop AC condensers behind a grey slatted screen; the raised garden terrace; then the type's own details
  if (!K.lite) {
    const [ax0, ax1, ay0, ay1] = g.ac;
    K.box(ax0, ax1, ay0, ay1, Z2, Z2 + 1.25, { color: SW.ac, code: T.codes.SLATH, top: 'none' });
    for (const [x0, x1, y0, y1] of g.terrace) K.box(x0, x1, y0, y1, 0, 0.42, { color: SW.terrace });
    g.details(K);
  }
  B.plate = [K.H.ring(g.ff.map(([x, y]) => [K.M.X(x), K.M.Y(y)]))]; B.plateBase = Z1; B.plateTop = Z2;
  return true;
}

// ---------------------------------------------------------------- Maple 1-3 (Emaar townhouses, 2018-2020)
// Rows of four (end, middle, middle, end) and pairs of end units, each unit from the Maple 1/2 brochure plans: a
// two-storey body, an upper bedroom box cantilevered over the back of its open 6 m carport, flat roofs with staggered
// parapets. Maple 1/2: sand render (#DDD0B4) with charcoal window surrounds and panels (#55575A); Maple III: white
// render (#F2F0EB) with grey volumes (#9FA09B). Open frontages; ~2 m walls between and behind the gardens.
// Unit plan coordinates as in house-specs.js (x from the unit's outer edge, y from the rear garden boundary).
const MP = {
  m12: { wall: C('#ddd0b4'), alt: C('#cbbb9c'), accent: C('#55575a'), roof: C('#d3cdbf') },
  m3: { wall: C('#f2f0eb'), alt: C('#e4e2dd'), accent: C('#8f908b'), roof: C('#d9d8d3') },
};
const MW = { frame: C('#3c3f43'), glass: C('#3e4c57'), rail: C('#4a4d51'), door: C('#7a5235') };
const MZ1 = 3.6, MZ2 = 6.95, MPAR = 0.6, MCP0 = 2.95, MCP1 = 3.5;
const MAPLE_GEOM = {
  '2M': {
    gf: [[0, 10.2], [3.0, 10.2], [3.0, 7.0], [7.95, 7.0], [7.95, 17.1], [0, 17.1]],
    uf: [[2.0, 7.0], [7.95, 7.0], [7.95, 17.3], [0, 17.3], [0, 12.4], [2.0, 12.4]],
    box: [1.6, 5.1, 17.3, 21.6], boxWin: [2.5, 4.2], rear: 7.0,
    balcony: { frame: [4.0, 7.95, 5.6, 7.0], rail: [4.1, 7.85, 5.65] },
    door: ['front', 17.1, 6.3, 7.25, 7.65],
    wins: [['front', 17.3, 5.5, 7.6, 4.2, 6.6, 1], ['front', 17.1, 0.9, 1.8, 1.5, 2.4, 0], ['back', 7.0, 3.3, 7.7, 0.15, 2.9, 3], ['back', 10.2, 0.4, 2.6, 1.0, 2.6, 1], ['back', 7.0, 4.4, 7.5, 3.75, 6.4, 2], ['back', 7.0, 2.3, 3.5, 4.6, 5.8, 0]],
  },
  '2E': {
    gf: [[3.0, 5.3], [9.2, 5.3], [9.2, 9.0], [11.0, 9.0], [11.0, 17.1], [3.0, 17.1]],
    uf: [[5.1, 5.05], [9.35, 5.05], [9.35, 8.4], [11.0, 8.4], [11.0, 17.1], [3.1, 17.1], [3.1, 8.4], [5.1, 8.4]],
    box: [7.9, 11.0, 15.1, 18.3], boxWin: [8.6, 10.4], rear: 5.3, end: true,
    balcony: { rail: [3.2, 5.05, 5.45] },
    door: ['left', 3.0, 12.6, 13.6, 0],
    wins: [['front', 17.1, 5.3, 7.4, 4.2, 6.6, 1], ['back', 5.3, 3.5, 8.8, 0.15, 2.9, 3], ['back', 9.0, 9.5, 10.7, 1.0, 2.6, 1], ['back', 5.05, 5.6, 8.9, 3.75, 6.4, 2], ['left', 3.1, 9.5, 11.0, 4.2, 6.4, 1], ['left', 3.0, 10.0, 12.0, 0.6, 2.8, 1]],
  },
  '3M': {
    gf: [[0, 5.3], [4.7, 5.3], [4.7, 7.0], [8.3, 7.0], [8.3, 17.2], [0, 17.2]],
    uf: [[0, 5.1], [4.7, 5.1], [4.7, 8.2], [8.3, 8.2], [8.3, 14.5], [6.9, 14.5], [6.9, 17.2], [2.1, 17.2], [2.1, 14.5], [0, 14.5]],
    box: [2.1, 6.9, 17.2, 18.3], boxWin: [3.3, 5.7], rear: 5.3,
    balcony: { rail: [4.8, 8.2, 6.95] },
    door: ['front', 17.2, 6.6, 7.55, 7.95],
    wins: [['back', 5.3, 0.4, 4.4, 0.15, 2.9, 2], ['back', 7.0, 5.0, 8.0, 0.15, 2.9, 2], ['back', 5.1, 0.5, 4.3, 3.75, 6.4, 2], ['back', 8.2, 5.2, 7.8, 4.1, 6.4, 1]],
  },
  '3E': {
    gf: [[3.0, 5.3], [6.7, 5.3], [6.7, 7.1], [11.3, 7.1], [11.3, 17.4], [3.0, 17.4]],
    uf: [[6.6, 5.1], [11.3, 5.1], [11.3, 18.1], [3.0, 18.1], [3.0, 8.0], [6.6, 8.0]],
    box: [6.8, 10.1, 14.7, 18.1], boxWin: [7.4, 9.5], rear: 5.3, end: true,
    balcony: { rail: [3.2, 6.55, 5.55], front: [4.7, 9.1, 18.1, 20.0] },
    door: ['left', 3.0, 12.3, 13.3, 0],
    wins: [['front', 18.1, 3.6, 6.4, 3.75, 6.4, 1], ['back', 5.3, 3.4, 6.4, 0.15, 2.9, 1], ['back', 7.1, 7.0, 11.0, 0.15, 2.9, 3], ['back', 5.1, 7.0, 11.0, 3.75, 6.4, 2], ['left', 3.0, 9.4, 11.4, 4.2, 6.4, 1]],
  },
};
function maple(T, B) {
  const F = frame2D(T.ccw(B.outer[0]), B.b.hf, { long: true }); if (!F) return false;
  const H = houseKit(T, B, F);
  const cl = mapleCluster(F.W);
  const pal = /Maple 3/i.test(B.b.hs || '') ? MP.m3 : MP.m12;
  const Y = (y) => mapleY(F.D, y);
  const win = { frame: MW.frame, glass: MW.glass };
  const plate = [];
  for (const u of cl.units) {
    const g = MAPLE_GEOM[u.t], spec = MAPLE[u.t];
    const X = (x) => mapleX(cl, u, x);
    const xr = (a, b) => { const p = X(a), q = X(b); return p < q ? [p, q] : [q, p]; };
    const face = (f) => (u.mirror && (f === 'left' || f === 'right') ? (f === 'left' ? 'right' : 'left') : f);
    const poly = (pts) => pts.map(([x, y]) => [X(x), Y(y)]);
    const pw = (f, at, a, b, z0, z1, opt) => {
      if (f === 'front' || f === 'back') { const [p, q] = xr(a, b); H.window(f, Y(at), p, q, z0, z1, { ...win, ...opt }); }
      else H.window(face(f), X(at), Y(a), Y(b), z0, z1, { ...win, ...opt });
    };
    const pp = (f, at, a, b, z0, z1, color, code, off) => {
      if (f === 'front' || f === 'back') { const [p, q] = xr(a, b); H.panel(f, Y(at), p, q, z0, z1, color, code, off); }
      else H.panel(face(f), X(at), Y(a), Y(b), z0, z1, color, code, off);
    };
    H.box(0, 0, 0, 0, 0, MZ1, { poly: poly(g.gf), color: pal.wall, top: 'flat', roof: pal.roof });
    const roofIn = H.box(0, 0, 0, 0, MZ1, MZ2, { poly: poly(g.uf), color: pal.wall, top: 'parapet', par: MPAR, roof: pal.roof, parColor: pal.wall });
    plate.push(H.ring(poly(g.uf)));
    // the bedroom box over the back of the carport stands taller than the rest of the roof
    const [bx0, bx1, by0, by1] = g.box, [b0, b1] = xr(bx0, bx1);
    H.box(b0, Y(by1), b1, Y(by0), MZ1, MZ2 + 0.45, { color: pal.wall, top: 'parapet', par: MPAR, roof: pal.roof, parColor: pal.wall });
    // the open carport: slab with a charcoal fascia, square piers at the front corners
    const [cx0, cx1] = spec.carport, [c0, c1] = xr(cx0, cx1), [cy0, cy1] = MAPLE.carportY;
    H.box(c0, Y(cy1), c1, Y(cy0), MCP0, MCP1, { color: pal.alt });
    H.box(c0, Y(cy1), c0 + 0.35, Y(cy1) + 0.35, 0, MCP0, { color: pal.alt });
    H.box(c1 - 0.35, Y(cy1), c1, Y(cy1) + 0.35, 0, MCP0, { color: pal.alt });
    if (!T.lite) {
      H.panel('front', Y(cy1), c0, c1, MCP1 - 0.22, MCP1, pal.accent, T.codes.SOLID, 0.03);
      // street side: the box's tall window in a projecting charcoal surround; other windows, the front door
      const [w0, w1] = g.boxWin;
      pp('front', by1, w0 - 0.3, w1 + 0.3, MZ1 + 0.15, MZ2 + 0.25, pal.accent, T.codes.SOLID, 0.12);
      pw('front', by1, w0, w1, MZ1 + 0.4, MZ2, { mullions: 1 });
      if (g.end) pp('front', 17.1, 3.1, 4.0, MZ1, MZ2 + MPAR, pal.accent, T.codes.SLATH, 0.05); // the stacked panels at the cluster end
      for (const [f, at, a, b, z0, z1, m] of g.wins) pw(f, at, a, b, z0, z1, { mullions: m });
      const [df, dat, da, db, ds] = g.door;
      if (df === 'front') { pp(df, dat, da, db, 0.1, 2.6, MW.door, T.codes.SLATV, 0.04); pw(df, dat, db + 0.04, ds, 0.1, 2.6, {}); }
      else pp(df, dat, da, db, 0.1, 2.6, MW.door, T.codes.SLATV, 0.04);
      // balconies: the framed rear balcony of the middle units, railings, the front balcony of the 3E end unit
      if (g.balcony.frame) {
        const [fx0, fx1, fy0, fy1] = g.balcony.frame, [f0, f1] = xr(fx0, fx1), yA = Y(fy1), yB = Y(fy0);
        H.box(f0, yA, f1, yB, MZ1 - 0.35, MZ1, { color: pal.wall });
        H.box(f0, yA, f1, yB, MZ2 - 0.3, MZ2 + 0.15, { color: pal.alt });
        H.box(f0, yA, f0 + 0.3, yB, MZ1, MZ2 - 0.3, { color: pal.alt });
        H.box(f1 - 0.3, yA, f1, yB, MZ1, MZ2 - 0.3, { color: pal.alt });
      }
      const [ra, rb, ry] = g.balcony.rail;
      pp('back', ry, ra, rb, MZ1, MZ1 + 1.1, MW.rail, T.codes.SLATV, 0.02);
      if (g.balcony.front) {
        const [fx0, fx1, fy0, fy1] = g.balcony.front, [f0, f1] = xr(fx0, fx1);
        H.box(f0, Y(fy1), f1, Y(fy0), MCP1, MZ1, { color: pal.wall });
        H.panel('front', Y(fy1), f0, f1, MZ1, MZ1 + 1.1, MW.rail, T.codes.SLATV, 0.02);
      }
      // end units: the wall and gate closing the side garden at the front
      if (g.end) {
        const [s0, s1] = xr(0, 3.0), yw = Y(17.1);
        H.box(s0, yw - 0.12, s1, yw + 0.12, 0, 2.0, { color: pal.wall });
        H.panel('front', yw - 0.12, (s0 + s1) / 2 - 0.6, (s0 + s1) / 2 + 0.6, 0.05, 1.9, MW.rail, T.codes.SLATH, 0.03);
      }
      if (roofIn) T.scatterEquipment(roofIn, MZ2, B.i, 2, B.r);
    }
    // the garden wall along the shared boundary with the next unit, from the house to the back of the plot
    const next = u.X0 + spec.w;
    if (next < cl.total - 0.5) {
      const xw = cl.sx * (next - cl.Xc), rearY = Y(Math.min(g.rear, MAPLE_GEOM[cl.units[cl.units.indexOf(u) + 1].t].rear));
      H.box(xw - 0.1, rearY, xw + 0.1, Y(0), 0, 2.0, { color: pal.wall });
    }
  }
  B.plate = plate.slice(0, 1); B.plateBase = MZ1; B.plateTop = MZ2;
  return true;
}

// ---------------------------------------------------------------- Club Villas and Golf Grove: semi-detached pairs
// Emaar's TH01/TH02 plans (3 and 4 bedrooms), mirror units sharing a party wall. Ground floor 8.3 m wide beside a 3 m
// side yard; a deeper first floor overhangs the two open carports, which stand side by side under one white canopy;
// a glass-railed roof terrace over the back half with a stair box. Styles (from the developer CGIs): Club Villas in
// greige render with off-white window frames, teak panels and a louvred recess between the units; Golf Grove Eames
// (beige with grey end volumes, timber and louvre screens), Savoye (a thick white frame round the first floor, a dark
// brown clad box at one end of the pair, dark slats) and Aalto, the 4-bed (alternating windows and timber panels
// between grey slab bands). Pair plan coordinates as in house-specs.js.
const PAIR_STYLE = {
  club3: { wall: C('#e6ded3'), frame: C('#f3eee6'), timber: C('#a86a40'), louvre: C('#b49c84') },
  club4: { wall: C('#e6ded3'), frame: C('#f3eee6'), timber: C('#a86a40'), louvre: C('#b49c84') },
  eames: { wall: C('#e6d6bf'), grey: C('#9c948c'), timber: C('#b5845b'), louvre: C('#a8937a') },
  savoye: { wall: C('#eedbb8'), frame: C('#f4f2ee'), box: C('#82594a'), slat: C('#6b4630') },
  aalto: { wall: C('#e6d6bf'), band: C('#aea198'), timber: C('#b5845b') },
};
const PW_ = { frame: C('#2f3033'), glass: C('#3b4954'), canopy: C('#ebe7e0'), deck: C('#cdbfae'), rail: C('#4a4a48'), door: C('#7a5235') };
const PZ1 = 3.6, PZ2 = 7.0, PPAR = 0.5;
function pairs(T, B) {
  const F = houseFrame(T, B); if (!F) return false;
  const H = houseKit(T, B, F);
  const L = pairLayout(F.W, F.D), S = L.S;
  const st = PAIR_STYLE[B.b.ht] || (B.b.hk === 'golf-grove' ? PAIR_STYLE.eames : PAIR_STYLE.club3);
  const four = L.beds === 4;
  const win = { frame: PW_.frame, glass: PW_.glass };
  const [g0, g1] = S.gf, [f0, f1] = S.ff;
  const bal = four ? 16.7 : 15.5; // the recessed master balcony at the rear party-wall corner
  const plate = [];
  for (const mirror of L.single ? [false] : [false, true]) {
    const X = (x) => L.X(mirror ? 22.6 - x : x);
    const xr = (a, b) => { const p = X(a), q = X(b); return p < q ? [p, q] : [q, p]; };
    const side = (f) => (mirror && (f === 'left' || f === 'right') ? (f === 'left' ? 'right' : 'left') : f);
    const poly = (pts) => pts.map(([x, y]) => [X(x), L.Y(y)]);
    const pw = (f, at, a, b, z0, z1, opt) => {
      if (f === 'front' || f === 'back') { const [p, q] = xr(a, b); H.window(f, L.Y(at), p, q, z0, z1, { ...win, ...opt }); }
      else H.window(side(f), X(at), L.Y(a), L.Y(b), z0, z1, { ...win, ...opt });
    };
    const pp = (f, at, a, b, z0, z1, color, code, off) => {
      if (f === 'front' || f === 'back') { const [p, q] = xr(a, b); H.panel(f, L.Y(at), p, q, z0, z1, color, code, off); }
      else H.panel(side(f), X(at), L.Y(a), L.Y(b), z0, z1, color, code, off);
    };
    const bx = (x0, x1, y0, y1, z0, z1, opt) => { const [p, q] = xr(x0, x1); return H.box(p, L.Y(y0), q, L.Y(y1), z0, z1, opt); };
    // volumes: ground floor, the deeper first floor with the recessed balcony cut out, the roof stair box
    bx(3.0, 11.3, g0, g1, 0, PZ1, { color: st.wall, top: 'flat', roof: PW_.deck });
    const ff = poly([[3.0, f0], [11.3, f0], [11.3, bal], [8.8, bal], [8.8, f1], [3.0, f1]]);
    H.box(0, 0, 0, 0, PZ1, PZ2, { poly: ff, color: st.wall, top: 'parapet', par: PPAR, roof: PW_.deck, parColor: st.wall });
    plate.push(H.ring(ff));
    const [sx0, sx1, sy0, sy1] = S.stair === 'outer' ? [3.0, 6.4, S.terrace[0] - 3.4, S.terrace[0]] : [8.0, 11.3, S.terrace[0] - 3.7, S.terrace[0]];
    bx(sx0, sx1, sy0, sy1, PZ2, PZ2 + 2.8, { color: st.wall, top: 'parapet', par: 0.3, roof: PW_.deck, parColor: st.wall });
    if (!T.lite) {
      // the roof terrace's frameless glass balustrade on the parapet, garden side and outer side
      pp('back', f1, 3.05, 8.75, PZ2 + PPAR, PZ2 + 1.15, PW_.glass, T.codes.GLASSY, 0.02);
      pp('left', 3.0, S.terrace[0], f1, PZ2 + PPAR, PZ2 + 1.15, PW_.glass, T.codes.GLASSY, 0.02);
      // street side, by style
      const zA = PZ1 + 0.25, zB = PZ2 - 0.25;
      if (st.frame && st.louvre) { // Club Villas: framed bay, half glass and half teak; louvred recess at the party wall
        pp('front', f0, 3.3, 10.4, PZ1 + 0.1, PZ2 - 0.1, st.frame, T.codes.SOLID, 0.25);
        pw('front', f0, 3.6, 7.0, zA, zB, { mullions: 2 });
        pp('front', f0, 7.1, 10.1, zA, zB, st.timber, T.codes.SLATV, 0.27);
        pp('front', f0, 10.45, 11.3, PZ1, PZ2, st.louvre, T.codes.SLATH, 0.08);
      } else if (st.grey) { // Eames: grey end volume, inset glazing, timber panel and louvre screen
        pp('front', f0, 3.0, 4.6, PZ1, PZ2 + PPAR, st.grey, T.codes.SOLID, 0.15);
        pw('front', f0, 4.9, 7.8, zA, zB, { mullions: 1 });
        pp('front', f0, 7.9, 9.4, zA, zB, st.timber, T.codes.SLATV, 0.06);
        pp('front', f0, 9.5, 11.1, zA, zB, st.louvre, T.codes.SLATV, 0.2);
      } else if (st.box) { // Savoye: thick white frame, tall windows with dark slats between; brown box at the pair's end
        pp('front', f0, 3.0, 11.3, PZ2 - 0.45, PZ2 + 0.3, st.frame, T.codes.SOLID, 0.3);
        pp('front', f0, 3.0, 3.5, PZ1, PZ2 + 0.3, st.frame, T.codes.SOLID, 0.3);
        pw('front', f0, 3.8, 6.2, zA, zB, { mullions: 1 });
        pp('front', f0, 6.3, 7.3, zA, zB, st.slat, T.codes.SLATV, 0.06);
        pw('front', f0, 7.4, 10.6, zA, zB, { mullions: 1 });
        if (mirror) { bx(3.0, 7.1, f0 - 0.5, f0 + 4.5, PZ1 - 0.2, PZ2 + 0.3, { color: st.box, code: T.codes.SLATV }); pw('front', f0 - 0.5, 3.9, 6.3, zA, zB, {}); }
      } else if (st.band) { // Aalto: grey slab bands, alternating full-height windows and timber panels
        pp('front', f0, 3.0, 11.3, PZ1, PZ1 + 0.35, st.band, T.codes.SOLID, 0.12);
        pp('front', f0, 3.0, 11.3, PZ2 - 0.35, PZ2, st.band, T.codes.SOLID, 0.12);
        [[3.3, 5.3], [7.2, 9.1]].forEach(([a, b]) => pw('front', f0, a, b, PZ1 + 0.35, PZ2 - 0.35, {}));
        [[5.3, 7.2], [9.1, 11.0]].forEach(([a, b]) => pp('front', f0, a, b, PZ1 + 0.35, PZ2 - 0.35, st.timber, T.codes.SLATV, 0.05));
      }
      // ground floor: tall glazing at the outer front corner, side entry from the side path, glazed garden front
      pw('front', g0, 3.4, 5.1, 0.3, 3.2, { mullions: 1 });
      pp('left', 3.0, g0 + 2.6, g0 + 3.6, 0.1, 2.5, PW_.door, T.codes.SLATV, 0.04);
      pw('back', g1, 3.4, 10.9, 0.1, 3.0, { mullions: 3 });
      pw('back', f1, 3.5, 8.3, PZ1 + 0.2, PZ2 - 0.4, { mullions: 2 });
      pp('back', f1 - 0.05, 8.85, 11.25, PZ1, PZ1 + 1.05, PW_.rail, T.codes.SLATH, 0.02);
      pw('left', 3.0, g0 + 5.0, g0 + 7.5, 0.6, 2.8, { mullions: 1 });
      // raised rear terrace and the side terrace in the side yard
      bx(3.0, 11.3, g1, g1 + (four ? 2.3 : 2.7), 0, 0.4, { color: PW_.deck });
      bx(0.2, 3.0, g0 + 4.6, g0 + 10.4, 0, 0.3, { color: PW_.deck });
    }
    // the wall along the party line, from the house to the back of the garden
    if (!mirror && !L.single) H.box(L.X(11.2), L.Y(g1), L.X(11.4), L.Y(g1 + 7.5), 0, 2.0, { color: st.wall });
  }
  // the shared carport canopy on three columns
  const [c0, c1] = L.single ? [L.X(S.carports[0][0]), L.X(S.carports[0][1])] : [L.X(5.3), L.X(17.3)];
  const cy0 = L.Y(S.carY[0]), cy1 = L.Y(f0);
  H.box(c0, cy0, c1, cy1, 2.85, 3.2, { color: PW_.canopy });
  for (const x of L.single ? [c0 + 0.2, c1 - 0.2] : [c0 + 0.2, (c0 + c1) / 2, c1 - 0.2]) H.box(x - 0.15, cy0 + 0.15, x + 0.15, cy0 + 0.45, 0, 2.85, { color: PW_.canopy });
  B.plate = plate.slice(0, 1); B.plateBase = PZ1; B.plateTop = PZ2;
  return true;
}

// ---------------------------------------------------------------- Golf Place I-II (Emaar, architect Dewan)
// Two wings joined by a double-height glazed entrance link under a pergola, the 2-car garage open at the front of one
// wing with a glass-railed terrace on top. Each plot is one of three styles: Contemporary (as built: dark bronze
// framed first-floor glass boxes with a white mullion grid, travertine-clad side walls, a dark soffit over the
// ground-floor glazing), Modern (white render cubes, big windows in grey-beige surrounds) or Elegant (thin floating
// roof slabs with deep eaves, white louvre screens, grey stone walls). Ivory render (#EFE7D0) throughout.
const GP = {
  ivory: C('#efe7d0'), white: C('#f3f1ec'), stone: C('#d8cdba'), grey: C('#9a9893'), bronze: C('#2e2925'), mull: C('#eeeeea'),
  surround: C('#cfc6b8'), louvre: C('#f0f0ee'), glass: C('#34424d'), frame: C('#2a2a2c'), deck: C('#cfc6b7'), door: C('#8b5a35'),
};
const GZ1 = 4.0, GZ2 = 7.6, GPAR = 0.5;
function golfPlace(T, B) {
  const F = houseFrame(T, B); if (!F) return false;
  const H = houseKit(T, B, F);
  const m = B.b.hm || 1, style = B.b.ht || 'contemporary';
  const G = golfPlaceLayout(F.W, F.D, m);
  const D = F.D, wall = style === 'modern' ? GP.white : GP.ivory;
  const xr = (a, b) => { const p = G.S(a), q = G.S(b); return p < q ? [p, q] : [q, p]; };
  const bx = (x0, x1, y0, y1, z0, z1, opt) => { const [p, q] = xr(x0, x1); return H.box(p, y0, q, y1, z0, z1, opt); };
  const side = (f) => (m < 0 && (f === 'left' || f === 'right') ? (f === 'left' ? 'right' : 'left') : f);
  const pw = (f, at, a, b, z0, z1, opt = {}) => {
    if (f === 'front' || f === 'back') { const [p, q] = xr(a, b); H.window(f, at, p, q, z0, z1, { frame: GP.frame, glass: GP.glass, ...opt }); }
    else H.window(side(f), G.S(at), a, b, z0, z1, { frame: GP.frame, glass: GP.glass, ...opt });
  };
  const pp = (f, at, a, b, z0, z1, color, code, off) => {
    if (f === 'front' || f === 'back') { const [p, q] = xr(a, b); H.panel(f, at, p, q, z0, z1, color, code, off); }
    else H.panel(side(f), G.S(at), a, b, z0, z1, color, code, off);
  };
  const { xL0, xL1, xR0, xR1 } = G;
  const roof = (c) => ({ color: c, top: style === 'elegant' ? 'flat' : 'parapet', par: GPAR, roof: GP.deck, parColor: c });
  const sideCode = style === 'contemporary' ? T.codes.STONE : T.codes.SOLID, sideCol = style === 'contemporary' ? GP.stone : wall;
  // ground floor: the left wing set back behind a front garden, the right wing behind its open garage, the link
  bx(xL0, xL1, 2.5, D, 0, GZ1, { color: wall, top: 'flat', roof: GP.deck });
  bx(xR0, xR1, 6.0, D, 0, GZ1, { color: wall, top: 'flat', roof: GP.deck });
  bx(xL1, xR0, 4.0, D - 6.0, 0, GZ2 + 0.3, { color: wall, top: 'flat', roof: GP.deck });
  // first floor: a box over each wing (the left one projecting over the front garden), terrace over the garage
  const lBox = bx(xL0, xL1, 1.2, D - 0.6, GZ1, GZ2, roof(wall));
  bx(xR0, xR1, 6.0, D - 0.6, GZ1, GZ2, roof(wall));
  bx(xR0, xR1, 0, 6.0, GZ1 - 0.45, GZ1, { color: wall });
  bx(xR1 - 0.3, xR1, 0, 6.0, 0, GZ1 - 0.45, { color: sideCol, code: sideCode });
  bx(xR0, xR0 + 0.35, 0, 0.4, 0, GZ1 - 0.45, { color: wall });
  if (style === 'elegant') {
    // thin floating roof slabs with deep eaves over each wing
    bx(xL0 - 1.2, xL1 + 0.3, 0.0, D + 0.6, GZ2, GZ2 + 0.35, { color: GP.louvre });
    bx(xR0 - 0.3, xR1 + 1.2, 4.8, D + 0.6, GZ2, GZ2 + 0.35, { color: GP.louvre });
  }
  if (!T.lite) {
    const zA = GZ1 + 0.3, zB = GZ2 - 0.3;
    // the outer side walls: travertine (Contemporary), grey stone (Elegant) or render
    const outerCol = style === 'elegant' ? GP.grey : sideCol, outerCode = style === 'modern' ? T.codes.SOLID : T.codes.STONE;
    pp('left', xL0, 1.2, D - 0.6, GZ1, GZ2, outerCol, outerCode, 0.04);
    pp('right', xR1, 6.0, D - 0.6, GZ1, GZ2, outerCol, outerCode, 0.04);
    for (const [a, b, y] of [[xL0, xL1, 1.2], [xR0, xR1, 6.0]]) {
      if (style === 'contemporary') {
        // the dark bronze frame round a glass box with a white mullion grid and a glass balustrade
        pp('front', y, a + 0.1, b - 0.1, GZ1, GZ2, GP.bronze, T.codes.SOLID, 0.4);
        pp('front', y, a + 0.45, b - 0.45, GZ1 + 0.1, GZ2 - 0.35, GP.glass, T.codes.GLASSY, 0.42);
        const n = Math.max(3, Math.round((b - a) / 1.3));
        for (let k = 1; k < n; k++) { const xm = a + 0.45 + ((b - a - 0.9) * k) / n; pp('front', y, xm - 0.04, xm + 0.04, GZ1 + 0.1, GZ2 - 0.35, GP.mull, T.codes.SOLID, 0.45); }
        for (const z of [GZ1 + 1.15, GZ2 - 1.25]) pp('front', y, a + 0.45, b - 0.45, z - 0.04, z + 0.04, GP.mull, T.codes.SOLID, 0.45);
      } else if (style === 'modern') {
        pp('front', y, a + 0.5, b - 0.5, zA - 0.2, zB + 0.2, GP.surround, T.codes.SOLID, 0.2);
        pw('front', y, a + 0.8, b - 0.8, zA, zB, { mullions: 2 });
      } else {
        pw('front', y, a + 0.5, b - 0.5, zA, zB, { mullions: 3 });
        pp('front', y, a + 0.3, b - 0.3, zA, zB, GP.louvre, T.codes.SLATH, 0.35);
      }
    }
    // the glazed double-height link with its pergola, the front door
    pw('front', 4.0, xL1 + 0.2, xR0 - 0.2, 0.1, GZ2, { mullions: 2 });
    const [k0, k1] = xr(xL1, xR0);
    for (let k = 0; k <= 6; k++) { const yy = 4.0 + ((D - 10.0) * k) / 6; H.box(k0, yy - 0.06, k1, yy + 0.06, GZ2 + 0.3, GZ2 + 0.55, { color: GP.bronze }); }
    pp('front', 4.0, xL1 + 0.5, xL1 + 1.6, 0.1, 3.0, GP.door, T.codes.SLATV, 0.08);
    // ground floor: the left wing's big window under a dark soffit, glazed garden fronts, rear windows upstairs
    pw('front', 2.5, xL0 + 0.6, xL1 - 0.4, 0.2, GZ1 - 0.4, { mullions: 3 });
    if (style === 'contemporary') bx(xL0, xL1, 1.0, 2.5, GZ1 - 0.35, GZ1, { color: GP.bronze });
    for (const [a, b] of [[xL0, xL1], [xR0, xR1]]) {
      pw('back', D, a + 0.5, b - 0.5, 0.1, GZ1 - 0.3, { mullions: 3 });
      pw('back', D - 0.6, a + 0.7, b - 0.7, zA, zB, { mullions: 2 });
    }
    // the terrace over the garage: glass balustrade
    pp('front', 0, xR0 + 0.1, xR1 - 0.1, GZ1, GZ1 + 1.1, GP.glass, T.codes.GLASSY, 0.02);
    // covered rear terrace slab and side windows
    bx(xL0, xR1, D, D + 3.2, 0, 0.35, { color: GP.deck });
    pw('left', xL0, 6.0, 9.0, 0.6, 3.2, { mullions: 1 });
    pw('right', xR1, 10.0, 12.5, zA, zB, { mullions: 1 });
    if (lBox) T.scatterEquipment(lBox, GZ2, B.i, 2, B.r);
  }
  B.plate = [H.ring([[G.xL0, 1.2], [G.xR1, 1.2], [G.xR1, D - 0.6], [G.xL0, D - 0.6]])]; B.plateBase = GZ1; B.plateTop = GZ2;
  return true;
}

// windows evenly along every wall of a CCW ring (for houses built on their own OSM outline): frame and glass quads
function ringWindows(T, o, ring, z0, z1, spacing, width, frame, glass, trim = null) {
  if (T.lite) return;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < width + 1.4) continue;
    const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [d[1], -d[0]];
    const k = Math.max(1, Math.floor(L / spacing));
    for (let j = 0; j < k; j++) {
      const mid = (L * (j + 0.5)) / k;
      const parts = [[mid - width / 2, mid + width / 2, z0, z1, 0.045, frame, T.codes.SOLID], [mid - width / 2 + 0.09, mid + width / 2 - 0.09, z0 + 0.09, z1 - 0.09, 0.06, glass, T.codes.GLASSY]];
      // a moulded surround (classic and Arabian revival houses)
      if (trim) parts.unshift([mid - width / 2 - 0.24, mid + width / 2 + 0.24, z0 - 0.3, z1 + 0.22, 0.025, trim, T.codes.SOLID]);
      for (const [s0, s1, za, zb, off, col, code] of parts) {
        const q0 = [a[0] + d[0] * s0 + n[0] * off, a[1] + d[1] * s0 + n[1] * off], q1 = [a[0] + d[0] * s1 + n[0] * off, a[1] + d[1] * s1 + n[1] * off];
        T.quad([q0[0], q0[1], za], [q1[0], q1[1], za], [q1[0], q1[1], zb], [q0[0], q0[1], zb], o, col, code);
      }
    }
  }
}
// does a ring cross itself (an inset of an intricate outline can fold over)?
function selfCrossing(r) {
  const n = r.length, X = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const a = r[i], b = r[(i + 1) % n], c = r[j], d = r[(j + 1) % n];
    if (X(a, b, c) * X(a, b, d) < 0 && X(c, d, a) * X(c, d, b) < 0) return true;
  }
  return false;
}
// the edge of a CCW ring that faces a direction most squarely (the street front of an irregular mansion)
function facingEdge(ring, f) {
  let best = 0, bd = -2;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 4) continue;
    const dt = ((b[1] - a[1]) / L) * f[0] - ((b[0] - a[0]) / L) * f[1];
    if (dt * Math.min(1, L / 10) > bd) { bd = dt * Math.min(1, L / 10); best = i; }
  }
  return best;
}

// ---------------------------------------------------------------- Fairway Vistas and Parkway Vistas (Emaar, 2019-2021)
// Golf-front villas built on the brochure plans (house-specs.js LUX: B1 7 bed and B2 6 bed in both communities, B3
// and B4 7 bed at Parkway only), each in its façade options:
// Modern: white render, thin slabs with deep overhangs, travertine panels (the built Fairway villas used a darker
//   banded stone than the renders), dark bronze vertical fins over the glass, a slatted carport screen;
// Arabesque ('Modern Arabesque' at Fairway, 'Contemporary Arabesque' at Parkway; B1/B2): beige boxes in deep picture
//   frames, bronze geometric screens over the glass and the double-height entrance, walnut panels;
// Classic (Parkway B3/B4): beige render, stepped cornices, framed vertical windows and a tall entrance portal.
const LXS = {
  modern: { wall: C('#f2f1ec'), slab: C('#f7f7f4'), stone: C('#bcad95'), built: C('#9d8b75'), fin: C('#3d3329'), canopy: C('#3b3a38') },
  arabesque: { wall: C('#d6c0a2'), frame: C('#ddc9ac'), screen: C('#8a6248'), timber: C('#5f4535'), trav: C('#cfc7b8') },
  classic: { wall: C('#e3d3b6'), trim: C('#f0e7d6'), screen: C('#8a6248'), trav: C('#cfc7b8') },
};
const LXW = { frame: C('#2e2d2b'), glass: C('#34424d'), rail: C('#5f7988'), door: C('#5f4535'), deck: C('#d4c9b8'), roof: C('#e3dfd7'), leaf: C('#4f7a3a'), bark: C('#6b5444') };
const LG = 4.0, LF = 7.4; // first-floor level, roof level
function luxury(T, B) {
  const F = houseFrame(T, B); if (!F) return false;
  const H = houseKit(T, B, F);
  const [t, st0] = String(B.b.ht || 'B1-modern').split('-');
  const st = LXS[st0] ? st0 : 'modern', S = LXS[st];
  const m = B.b.hm || 1, lite = T.lite;
  const Lay = luxuryLayout(F.W, F.D, t, m), P = Lay.S, X = Lay.X, Y = Lay.Y;
  const stone = st === 'modern' ? (/Fairway/.test(B.b.hs || '') ? S.built : S.stone) : S.trav;
  const wall = S.wall;
  // a plan box [x0, x1, y0, y1] in local coordinates, and drawing on its faces in plan terms: 'front' | 'back' run
  // along plan x, 'pl' | 'pr' (the plan's left and right sides, swapped when the house is mirrored) along plan y
  const R = ([x0, x1, y0, y1]) => { const a = X(x0), b = X(x1); return [Math.min(a, b), Y(y0), Math.max(a, b), Y(y1)]; };
  const bx = (r, z0, z1, opt) => { const [a, y0, b, y1] = R(r); return H.box(a, y0, b, y1, z0, z1, opt); };
  const face = (f, r, u0, u1) => {
    if (f === 'front' || f === 'back') { const a = X(u0), b = X(u1); return [f, Y(f === 'front' ? r[2] : r[3]), Math.min(a, b), Math.max(a, b)]; }
    const left = (f === 'pl') === (m > 0);
    return [left ? 'left' : 'right', X(f === 'pl' ? r[0] : r[1]), Y(u0), Y(u1)];
  };
  const pp = (f, r, u0, u1, z0, z1, color, code, off) => { if (lite || u1 - u0 < 0.2) return; const [n, at, a, b] = face(f, r, u0, u1); H.panel(n, at, a, b, z0, z1, color, code, off); };
  const pw = (f, r, u0, u1, z0, z1, opt = {}) => { if (lite || u1 - u0 < 0.4) return; const [n, at, a, b] = face(f, r, u0, u1); H.window(n, at, a, b, z0, z1, { frame: LXW.frame, glass: LXW.glass, ...opt }); };
  const mull = (w) => Math.max(1, Math.round(w / 2.4) - 1);
  const slabOf = (f) => P.slab.find((s) => f[0] >= s[0] - 0.05 && f[1] <= s[1] + 0.05 && f[2] >= s[2] - 0.05 && f[3] <= s[3] + 0.05) || f;
  const gfRear = Math.max(...P.gf.map((g) => g[3]));

  // ground floor
  for (const g of P.gf) bx(g, 0, LG, { color: wall, top: 'flat', roof: LXW.deck });
  if (P.hall) bx(P.hall, 0, LG, { color: wall, top: 'flat', roof: LXW.deck }); // the first floor above holds the void
  for (const g of P.gf) {
    const w = g[1] - g[0], d = g[3] - g[2];
    if (g[3] > gfRear - 4.8 && w > 4) {
      // the garden front: sliding glass across the living rooms, solid stone-clad ends
      pw('back', g, g[0] + 1.3, g[1] - 1.3, 0.12, LG - 0.55, { mullions: mull(w - 2.6) });
      if (st === 'modern') { pp('back', g, g[0], g[0] + 1.2, 0, LG - 0.35, stone, T.codes.STONE, 0.04); pp('back', g, g[1] - 1.2, g[1], 0, LG - 0.35, stone, T.codes.STONE, 0.04); }
    } else if (w > 3.5) pw('back', g, g[0] + 1.0, g[0] + Math.min(4.2, w - 1.4), 0.9, LG - 0.8, { mullions: 1 });
    if (g[2] < P.ffY0 + 8 && w > 3.5 && Math.abs(g[2] - P.court[3]) > 0.3 && !(g[0] < P.park[1] - 0.2 && g[1] > P.park[0] + 0.2 && g[2] < P.park[3] + 1)) {
      // the street front of the rooms beside the entrance: a wide window, a stone panel (modern) or surround
      const a = g[0] + 0.7, b = g[0] + Math.min(w * 0.5, 4.6);
      if (st === 'classic') { pp('front', g, a - 0.25, b + 0.25, 0.35, LG - 0.45, S.trim, T.codes.SOLID, 0.08); pw('front', g, a, b, 0.6, LG - 0.7, { mullions: 2 }); }
      else pw('front', g, a, b, 0.25, LG - 0.6, { mullions: 2 });
      if (st === 'modern') { pp('front', g, g[1] - Math.min(2.4, w * 0.22), g[1], 0, LG - 0.35, stone, T.codes.STONE, 0.04); pp('front', g, b + 0.9, b + 2.0, 0.2, LG - 0.6, S.fin, T.codes.SLATV, 0.12); }
    }
    for (const f of ['pl', 'pr']) if (d > 6) pw(f, g, g[2] + d * 0.35, g[2] + d * 0.35 + Math.min(3.2, d * 0.3), 0.9, LG - 0.8, { mullions: 1 });
  }

  // the entrance: the pivot door at the back of the planted court, glazing beside it (double height in the hall)
  {
    const c = P.court, dw = [c[0], c[1], c[3], c[3]], hz = P.tall ? LF - 0.5 : LG - 0.55;
    pp('front', dw, P.door[0], P.door[1], 0.05, 3.5, LXW.door, T.codes.SLATV, 0.09);
    pw('front', dw, P.door[1] + 0.15, c[1] - 0.25, 0.1, hz, { mullions: P.tall ? 2 : 1 });
    if (P.door[0] - c[0] > 1.2) pw('front', dw, c[0] + 0.3, P.door[0] - 0.15, 0.1, hz, { mullions: 1 });
    if (st === 'arabesque' && P.tall) pp('front', dw, c[0] + 0.25, c[1] - 0.25, LG - 0.6, LF - 0.5, S.screen, T.codes.SCREEN, 0.3);
    if (st !== 'modern') {
      // a travertine surround round the door; Classic: a tall portal through both floors
      const z1 = st === 'classic' ? LF + 0.3 : 3.9;
      const [, at, a0, a1] = face('front', dw, P.door[0] - 0.45, P.door[1] + 0.45);
      H.box(a0, at - 0.45, a0 + 0.35, at, 0, z1, { color: st === 'classic' ? S.trim : S.trav });
      H.box(a1 - 0.35, at - 0.45, a1, at, 0, z1, { color: st === 'classic' ? S.trim : S.trav });
      H.box(a0, at - 0.45, a1, at, z1 - 0.45, z1, { color: st === 'classic' ? S.trim : S.trav });
    } else pp('front', dw, P.door[0] - 0.9, P.door[0] - 0.1, 0, 3.6, stone, T.codes.STONE, 0.05);
    const tx = c[0] + (c[1] - c[0]) * 0.3, ty = c[2] + (c[3] - c[2]) * 0.4, tr = 1.5;
    if (!lite && !P.slab.some((s) => s[0] < tx + tr && s[1] > tx - tr && s[2] < ty + tr && s[3] > ty - tr)) {
      // the court's tree, where no first-floor wing overhangs it
      const p = F.P(X(tx), Y(ty));
      T.cone(p, 0.14, 0.1, 0, 2.9, H.o, LXW.bark, T.codes.SOLID, { segs: 6, cap: false });
      T.dome(p, 1.6, 1.6, 2.5, 2.3, H.o, LXW.leaf, T.codes.SOLID, { segs: 9, rings: 3 });
    }
  }

  // parking: a carport canopy (a dark slatted screen on its open side for Modern) or open parking under a thin roof
  {
    const k = P.park, out = (k[0] + k[1]) / 2 < P.W / 2 ? 'pl' : 'pr', inX = out === 'pl' ? k[1] : k[0];
    if (P.parkKind === 'open') {
      bx(k, 2.85, 3.05, { color: st === 'modern' ? S.slab : wall });
      if (!lite) for (const [x, y] of [[k[0] + 0.3, k[2] + 0.4], [k[1] - 0.3, k[2] + 0.4]]) bx([x - 0.08, x + 0.08, y - 0.08, y + 0.08], 0, 2.85, { color: LXW.frame });
    } else {
      bx(k, LG - 0.8, LG - 0.4, { color: st === 'modern' ? S.canopy : wall });
      bx(out === 'pl' ? [inX - 0.3, inX, k[2] + 0.3, k[3]] : [inX, inX + 0.3, k[2] + 0.3, k[3]], 0, LG - 0.8, { color: st === 'modern' ? stone : wall, code: st === 'modern' ? T.codes.STONE : T.codes.SOLID });
      if (st === 'modern') pp(out, k, k[2] + 0.2, k[2] + Math.min(4.2, k[3] - k[2] - 0.5), 0.1, LG - 0.85, S.fin, T.codes.SLATV, 0.02);
      else if (st === 'arabesque') pp('front', k, k[0] + 0.1, k[1] - 0.1, LG - 0.8, LG - 0.4, S.timber, T.codes.SLATH, 0.03);
    }
  }

  // first floor: floor plates (the terraces), the rooms, the roof
  for (const s of P.slab) bx(s, LG - 0.35, LG, { color: st === 'modern' ? S.slab : wall, top: 'flat', roof: LXW.deck });
  const ffTop = st === 'modern' ? { color: wall, top: 'flat' } : { color: wall, top: 'parapet', par: 0.65, roof: LXW.roof, parColor: st === 'arabesque' ? S.frame : S.trim };
  let biggest = null, bigA = 0;
  for (const f of P.ff) {
    const ring = bx(f, LG, LF, ffTop), A = (f[1] - f[0]) * (f[3] - f[2]);
    if (A > bigA) { bigA = A; biggest = { f, ring }; }
  }
  if (st === 'modern') {
    // thin white roof slabs with deep overhangs over the rooms and terraces (one over the whole of B1), and a low
    // screen round the roof plant
    const ex = (s, e) => [s[0] - e, s[1] + e, s[2] - e - 0.2, s[3] + e];
    const roofs = P.oneRoof ? [[Math.min(...P.slab.map((s) => s[0])), Math.max(...P.slab.map((s) => s[1])), Math.min(...P.slab.map((s) => s[2])), Math.max(...P.slab.map((s) => s[3]))]] : P.slab;
    for (const s of roofs) bx(ex(s, 0.6), LF, LF + 0.38, { color: S.slab, top: 'flat' });
    if (biggest) { const f = biggest.f, e = Math.min(2.2, (f[1] - f[0]) * 0.25); bx([f[0] + e, f[1] - e, f[2] + 2.2, f[3] - 2.2], LF + 0.38, LF + 0.85, { color: S.slab }); }
    if (P.oneRoof) pp('front', [P.court[0], P.court[1], P.ffY0, P.ffY0], P.court[0] + 0.15, P.court[1] - 0.15, LG, LF, S.fin, T.codes.SLATV, -0.2);
  } else if (st === 'classic') {
    // stepped cornices under the parapet and along the first-floor line
    for (const f of P.ff) for (const [z, e] of [[LF - 0.4, 0.22], [LG - 0.3, 0.16]]) bx([f[0] - e, f[1] + e, f[2] - e, f[3] + e], z, z + 0.32, { color: S.trim });
  }
  for (const f of P.ff) {
    const s = slabOf(f), w = f[1] - f[0], d = f[3] - f[2], zA = LG + 0.3, zB = LF - 0.35;
    for (const side of ['front', 'back']) {
      const terr = side === 'front' ? f[2] - s[2] > 0.6 : s[3] - f[3] > 0.6;
      if (st === 'arabesque' && !lite) {
        // the deep picture frame round each face
        const y = side === 'front' ? f[2] : f[3], dy = side === 'front' ? -0.65 : 0.65, ya = Math.min(y, y + dy), yb = Math.max(y, y + dy);
        bx([f[0] - 0.12, f[1] + 0.12, ya, yb], LF - 0.45, LF + 0.65, { color: S.frame });
        bx([f[0] - 0.12, f[0] + 0.45, ya, yb], LG - 0.35, LF - 0.45, { color: S.frame });
        bx([f[1] - 0.45, f[1] + 0.12, ya, yb], LG - 0.35, LF - 0.45, { color: S.frame });
      }
      if (terr) {
        // terrace doors across the face, the frameless glass balustrade along the slab edge
        pw(side, f, f[0] + 0.6, f[1] - 0.6, LG + 0.08, zB, { mullions: mull(w - 1.2) });
        pp(side, s, s[0] + 0.12, s[1] - 0.12, LG, LG + 1.1, LXW.rail, T.codes.GLASSY, 0.03);
        if (st === 'modern' && w > 6) pp(side, f, f[0] + w * 0.55, f[0] + w * 0.55 + 1.9, LG + 0.05, LF, S.fin, T.codes.SLATV, side === 'front' ? (f[2] - s[2]) * 0.5 : (s[3] - f[3]) * 0.5);
        if (st === 'arabesque' && w > 6) pp(side, f, f[0] + w * 0.5, f[0] + w * 0.5 + 1.8, zA, zB, S.screen, T.codes.SCREEN, 0.35);
        continue;
      }
      if (st === 'modern') {
        const g1 = f[0] + Math.max(1.6, w * 0.58);
        pw(side, f, f[0] + 0.5, g1, zA, zB, { mullions: mull(g1 - f[0]) });
        pp(side, f, f[0] + 0.4, f[0] + Math.min(2.6, w * 0.3), LG + 0.05, LF, S.fin, T.codes.SLATV, 0.3);
        pp(side, f, g1 + 0.3, f[1] - 0.2, LG, LF, stone, T.codes.STONE, 0.04);
      } else if (st === 'arabesque') {
        const g1 = f[0] + Math.max(1.6, w * 0.5);
        pw(side, f, f[0] + 0.8, g1, zA, zB, { mullions: 1 });
        pp(side, f, g1 + 0.1, g1 + Math.min(2.2, w * 0.22), zA, zB, S.screen, T.codes.SCREEN, 0.25);
        pp(side, f, f[1] - Math.min(1.8, w * 0.16) - 0.6, f[1] - 0.6, zA, zB, S.timber, T.codes.SLATV, 0.06);
      } else {
        const n = Math.max(1, Math.floor(w / 3.2));
        for (let k = 0; k < n; k++) {
          const xm = f[0] + (w * (k + 0.5)) / n;
          pp(side, f, xm - 0.95, xm + 0.95, zA - 0.2, zB + 0.12, S.trim, T.codes.SOLID, 0.1);
          pw(side, f, xm - 0.68, xm + 0.68, zA, zB, { mullions: 1 });
          if (k % 2) pp(side, f, xm - 0.6, xm + 0.6, zA + 0.1, zB - 0.1, S.screen, T.codes.SCREEN, 0.16);
        }
      }
    }
    for (const sd of ['pl', 'pr']) if (d > 7) {
      const y0 = f[2] + d * 0.3, y1 = y0 + Math.min(st === 'modern' ? 4 : 1.6, d * 0.25);
      if (st === 'classic') pp(sd, f, y0 - 0.22, y1 + 0.22, zA - 0.2, zB + 0.12, S.trim, T.codes.SOLID, 0.1);
      pw(sd, f, y0, y1, zA, zB, { mullions: st === 'modern' ? 1 : 0 });
    }
  }
  if (biggest && biggest.ring && !lite) T.scatterEquipment(biggest.ring, st === 'modern' ? LF + 0.38 : LF, B.i, 2, B.r);

  // the paved garden terrace behind the house
  if (!lite) {
    const x0 = Math.max(0, P.pool[0] - 0.6), x1 = Math.min(P.W, P.pool[1] + 0.6);
    const gr = Math.max(...P.gf.filter((g) => g[0] < x1 && g[1] > x0).map((g) => g[3]));
    bx([x0, x1, Math.min(gr, P.pool[2] - 3.2), P.pool[2] - 0.3], 0, 0.3, { color: LXW.deck });
  }

  const all = P.slab, sx0 = Math.min(...all.map((s) => s[0])), sx1 = Math.max(...all.map((s) => s[1])), sy0 = Math.min(...all.map((s) => s[2])), sy1 = Math.max(...all.map((s) => s[3]));
  const [a, y0, b, y1] = R([sx0, sx1, sy0, sy1]);
  B.plate = [H.ring([[a, y0], [b, y0], [b, y1], [a, y1]])]; B.plateBase = LG; B.plateTop = LF;
  return true;
}

// ---------------------------------------------------------------- Hills Grove and Hills View mansions
// One-off mansions on 2,300-3,800 m2 plots, raised on their own OSM outlines: a tall ground floor on the full
// footprint and a set-back first floor, in the styles the photographs show: white Arabian revival (cornices, an arched
// entrance filled with a geometric screen), cream classic (stepped cornices, framed windows), contemporary (travertine
// ground floor, white upper floor under a thin overhanging roof, wide glazing, a roof pavilion) and, in Hills View,
// contemporary houses under low grey hipped roofs.
const MN = {
  arabesque: { wall: C('#f0efea'), trim: C('#f8f7f3'), screen: C('#a88a66') },
  classic: { wall: C('#d9cbb0'), trim: C('#ece3d1') },
  contemporary: { wall: C('#f2f1ec'), base: C('#d8cdb8'), slab: C('#f6f6f3') },
  hipped: { wall: C('#efede6'), base: C('#d4cbbb'), roof: C('#77716a'), slab: C('#f4f3ef') },
};
const MNW = { frame: C('#2f2e2c'), glass: C('#34424d'), deck: C('#e2ddd3'), door: C('#6b4a32') };
function outlineHouse(T, B, { z1, z2, inset, style, S, windows }) {
  const ring = T.ccw(B.outer[0]);
  const o = { ...B.o, base: 0, top: z2, fh: z1, center: T.centroid(ring) };
  const area = Math.abs(T.signedArea(ring));
  // the set-back upper floor: the outline inset (unless that folds over itself on an intricate outline), else the
  // outline shrunk about its centre if that stays on the ground floor, else the full outline
  let up = T.ccw(T.insetRing(ring, inset));
  if (!(Math.abs(T.signedArea(up)) > area * 0.35) || selfCrossing(up)) {
    up = T.ccw(T.scaleRing(ring, o.center, 0.82));
    if (!up.every((p) => T.pointInRing(p, ring))) up = ring;
  }
  const baseCode = S.base ? T.codes.STONE : T.codes.SOLID;
  T.walls(ring, 0, z1, o, baseCode, { color: S.base || S.wall });
  T.cap([ring], z1, o, T.codes.ROOF + T.L.roofConcrete, MNW.deck);
  T.walls(up, z1, z2, { ...o, base: z1 }, T.codes.SOLID, { color: S.wall });
  T.cap([up], z1, o, T.codes.SOLID, S.wall, true);
  let roofRing = up;
  const upBox = T.orientedBox(up);
  // a hipped roof only over a near-rectangular upper floor (a hip over an L or U would roof the courtyard too)
  if (style === 'hipped' && upBox && upBox.fill > 0.78) {
    T.cap([up], z2, o, T.codes.SOLID, S.wall);
    T.hipRoof(upBox, z2, { ...o, wall: S.wall, roofLayer: T.L.roofTiles }, S.roof, 0.7, 0.26);
  } else if (style === 'contemporary' || style === 'hipped') {
    T.cap([up], z2, o, T.codes.ROOF + T.L.roofConcrete, MNW.deck);
    const slab = T.ccw(T.insetRing(up, -0.9));
    T.walls(slab, z2, z2 + 0.35, { ...o, base: z2 }, T.codes.SOLID, { color: S.slab });
    T.cap([slab], z2 + 0.35, o, T.codes.SOLID, S.slab);
    T.cap([slab], z2, o, T.codes.SOLID, S.slab.clone().multiplyScalar(0.8), true);
  } else {
    roofRing = T.parapetRoof(up, z2, 0.8, o, T.codes.ROOF + T.L.roofConcrete, MNW.deck, S.trim || S.wall);
    // cornice bands stepping out under the parapet and over the ground floor
    for (const [r, z] of [[up, z2 - 0.45], [ring, z1 - 0.4]]) {
      const c = T.ccw(T.insetRing(r, -0.22));
      T.walls(c, z, z + 0.4, { ...o, base: z }, T.codes.SOLID, { color: S.trim || S.wall });
      if (!T.lite) T.cap([c], z + 0.4, o, T.codes.SOLID, S.trim || S.wall);
    }
  }
  if (!T.lite) {
    const [gs, gw, us, uw] = windows, trim = style === 'arabesque' || style === 'classic' ? S.trim : null;
    ringWindows(T, o, ring, 0.6, z1 - 0.8, gs, gw, MNW.frame, MNW.glass, trim);
    ringWindows(T, o, up, z1 + 0.6, z2 - 0.7, us, uw, MNW.frame, MNW.glass, trim);
  }
  return { ring, up, roofRing, o };
}
// the street front of an outline house: draw(quad, mid, L) adds panels along the wall that faces the street most
// squarely (s along the wall, z up, standing `off` metres proud)
function streetFront(T, B, r, draw) {
  if (T.lite || B.b.hf == null) return;
  const f = [Math.cos(B.b.hf), Math.sin(B.b.hf)], ring = r.ring, i = facingEdge(ring, f);
  const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [d[1], -d[0]];
  const q = (s, off) => [a[0] + d[0] * s + n[0] * off, a[1] + d[1] * s + n[1] * off];
  const quad = (s0, s1, z0, z1, off, col, code) => { const p0 = q(s0, off), p1 = q(s1, off); T.quad([p0[0], p0[1], z0], [p1[0], p1[1], z0], [p1[0], p1[1], z1], [p0[0], p0[1], z1], r.o, col, code, [[0, z0], [s1 - s0, z0], [s1 - s0, z1], [0, z1]]); };
  draw(quad, L / 2, L);
}
function mansion(T, B) {
  const style = B.b.ht || 'contemporary', S = MN[style] || MN.contemporary;
  const wide = style === 'contemporary' || style === 'hipped';
  const r = outlineHouse(T, B, { z1: 4.8, z2: 9.4, inset: 2.2, style, S, windows: wide ? [5.0, 3.4, 5.0, 3.0] : [3.6, 1.5, 3.6, 1.4] });
  // the street front: an arched entrance with a geometric screen (Arabian revival), a tall framed portal (classic) or
  // a double-height glazed entry
  streetFront(T, B, r, (quad, mid) => {
    if (style === 'arabesque') { quad(mid - 2.4, mid + 2.4, 0, 7.2, 0.3, S.trim, T.codes.SOLID); quad(mid - 1.7, mid + 1.7, 0.1, 6.2, 0.36, S.screen, T.codes.SCREEN); }
    else if (style === 'classic') { quad(mid - 2.3, mid + 2.3, 0, 8.6, 0.32, S.trim, T.codes.SOLID); quad(mid - 1.5, mid + 1.5, 0.1, 7.6, 0.38, MNW.glass, T.codes.GLASSY); quad(mid - 0.75, mid + 0.75, 0.1, 3.4, 0.42, MNW.door, T.codes.SLATV); }
    else quad(mid - 2.2, mid + 2.2, 0.1, 9.0, 0.3, MNW.glass, T.codes.GLASSY);
  });
  if (!T.lite && (style === 'contemporary' || style === 'arabesque')) {
    // a roof pavilion over the terrace
    const c = T.centroid(r.up), ob = T.orientedBox(r.up);
    if (ob) { const pv = T.ccw(T.rectRing(c[0], c[1], Math.min(7, ob.len * 0.3), Math.min(5, ob.wid * 0.35), Math.atan2(ob.u[1], ob.u[0]))); T.walls(pv, 9.4, 12.4, { ...r.o, base: 9.4 }, T.codes.SOLID, { color: S.wall }); T.cap([pv], 12.4, r.o, T.codes.SOLID, S.wall); }
  }
  B.plate = [r.up]; B.plateBase = 4.8; B.plateTop = 9.4;
  return true;
}

// ---------------------------------------------------------------- custom villas: Emerald Hills, The Fairway, The Parkway
// Owner-built contemporary villas on 660-1,900 m2 plots (design guidelines: contemporary, flat roofs), on their OSM
// outlines: a full ground floor and a set-back first floor, in the palettes the listings show: white render with a
// travertine ground floor, white with corten panels, all white, or white with charcoal.
const CV = {
  travertine: { wall: C('#f1efe9'), base: C('#d8cdb8'), slab: C('#f5f4f0') },
  corten: { wall: C('#efede7'), base: C('#6b4a3a'), slab: C('#f5f4f0') },
  white: { wall: C('#f4f3ef'), slab: C('#f7f6f2') },
  charcoal: { wall: C('#efeeea'), base: C('#3d4043'), slab: C('#f5f4f0') },
};
function custom(T, B) {
  const S = CV[B.b.ht] || CV.white;
  const r = outlineHouse(T, B, { z1: 4.0, z2: 7.6, inset: 1.4, style: 'contemporary', S, windows: [4.4, 3.2, 4.6, 2.8] });
  // the entrance: a double-height glazed slot with a timber door, beside a full-height accent panel (the palette's
  // stone, corten or charcoal; travertine on the all-white houses)
  streetFront(T, B, r, (quad, mid, L) => {
    if (L < 9) return;
    quad(mid - 1.4, mid + 1.4, 0.1, 7.2, 0.32, MNW.glass, T.codes.GLASSY);
    quad(mid - 0.6, mid + 0.6, 0.1, 3.3, 0.36, MNW.door, T.codes.SLATV);
    quad(mid + 1.6, mid + 3.6, 0, 7.6, 0.2, S.base || MN.contemporary.base, T.codes.STONE);
  });
  B.plate = [r.up]; B.plateBase = 4.0; B.plateTop = 7.6;
  return true;
}

// ---------------------------------------------------------------- Emirates Hills mansions
// Every mansion stands on its own OSM outline. The outline is split into wings (house-specs.js rectCover): the ground
// floor follows the true outline, the upper floor rises on the wings, and roofs, windows, porticos and details
// follow the style the plot carries (data-raw/research/emirates-hills/mansions/research.json). Mediterranean and
// Tuscan houses get a terracotta hipped roof over each wing, so their roofs intersect as built; the classic houses a
// balustraded flat roof and a columned portico with a pediment; the Arabian revival houses crenellated parapets, a
// dome and arched, screened openings; the contemporary houses cantilevered upper boxes under thin floating slabs,
// stone cladding and full-height glass. Outbuildings (guard and staff houses, majlis, pool houses) take their
// mansion's style.
// palettes from the listing photographs (mansions research): neoclassical houses in ivory and cream render or stone
// with white mouldings; Arabian revival in white and cream; the flat-roofed Mediterranean-Arabian houses in warm
// sand and ochre with deep verandas; modern houses in white render, travertine or cream limestone; terracotta hips
// only on the few tiled villas
// (research palette: white render #F0EFEA, ivory #F2E8D0, limestone #E4DDD2, travertine #D5C6AC, sand #D5BF93, ochre
// #CDB06A-#D7C094; frames black #2B2B2B or bronze #3B352B)
const EHS = {
  classic: { walls: ['#f2e8d0', '#f0efea', '#e4ddd2'], trim: C('#faf7f0'), frame: C('#2b2b2b'), glass: C('#3d5560'), roof: C('#dcd8cf') },
  arabesque: { walls: ['#f0efea', '#f2e8d0', '#d5c6ac'], trim: C('#faf8f3'), frame: C('#3b352b'), glass: C('#3d5560'), screen: C('#8a6248'), dome: C('#f6f2ea'), roof: C('#dcd5c8') },
  mediterranean: { walls: ['#d5bf93', '#d7c094', '#cdb06a', '#dcc8a2'], trim: C('#ecdcbd'), frame: C('#3b352b'), glass: C('#3e4b53'), screen: C('#c4a676'), roof: C('#d8cdbd') },
  tiled: { walls: ['#ecdcc2', '#e9d3b4'], trim: C('#f7f0e3'), roof: C('#b45a33'), frame: C('#3b352b'), glass: C('#3e4b53'), pitched: true },
  contemporary: { walls: ['#f0efea', '#f2f1ec'], stone: C('#d5c6ac'), lime: C('#e4ddd2'), dark: C('#3a3d40'), frame: C('#2b2b2b'), glass: C('#33414c'), slab: C('#f6f5f1'), roof: C('#e2dfd8') },
};
EHS.tuscan = EHS.tiled;
const ehPalette = (st, i) => { const S = EHS[st] || EHS.contemporary; return { ...S, wall: C(S.walls[i % S.walls.length]) }; };
const EZ1 = 5.2, EZ2 = 10.2; // parapets end at 10.7-11.2 m, roof pavilions at 13.5-14 m (research estimates 10-12 and 13-15)
const wingRing = (T, w, grow = 0) => {
  const hl = w.len / 2 + grow, hw = w.wid / 2 + grow;
  return T.ccw([[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([a, b]) => [w.c[0] + w.u[0] * a + w.v[0] * b, w.c[1] + w.u[1] * a + w.v[1] * b]));
};
// a continuous band along every wall of a ring (balustrades, cornices, stone): quads standing `off` proud
function ringBand(T, o, ring, z0, z1, color, code, off = 0.04) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.4) continue;
    const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [d[1], -d[0]];
    const p = [a[0] + n[0] * off, a[1] + n[1] * off], q = [b[0] + n[0] * off, b[1] + n[1] * off];
    T.quad([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1], o, color, code, [[0, z0], [L, z0], [L, z1], [0, z1]]);
  }
}
// merlons along a parapet (Arabian revival)
function crenels(T, o, ring, z, color) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 2) continue;
    const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [-d[1], d[0]];
    for (let s = 0.5; s < L - 0.4; s += 1.05) {
      const p0 = [a[0] + d[0] * s, a[1] + d[1] * s], p1 = [a[0] + d[0] * (s + 0.5), a[1] + d[1] * (s + 0.5)];
      T.prism([p0, p1, [p1[0] + n[0] * 0.32, p1[1] + n[1] * 0.32], [p0[0] + n[0] * 0.32, p0[1] + n[1] * 0.32]], z, z + 0.42, o, T.codes.SOLID, color);
    }
  }
}
function ehAnnex(T, B, st0) {
  const [st, pi] = st0.split(':'), S = ehPalette(st, +pi || 0), ring = T.ccw(B.outer[0]);
  const h = Math.min(4.2, 3.0 + Math.sqrt(B.area) * 0.08);
  const o = { ...B.o, base: 0, top: h, fh: h, center: T.centroid(ring), wall: S.wall };
  T.walls(ring, 0, h, o, T.codes.SOLID, { color: S.wall });
  if (S.pitched) {
    T.cap([ring], h, o, T.codes.SOLID, S.wall);
    const ob = T.orientedBox(ring); if (ob) T.hipRoof(ob, h, { ...o, wall: S.trim, roofLayer: T.L.roofTiles }, S.roof, 0.45, 0.4);
  } else if (st === 'contemporary') {
    const slab = T.ccw(T.insetRing(ring, -0.5));
    T.walls(slab, h, h + 0.3, { ...o, base: h }, T.codes.SOLID, { color: S.slab });
    T.cap([slab], h + 0.3, o, T.codes.SOLID, S.slab);
  } else {
    T.parapetRoof(ring, h, 0.5, o, T.codes.ROOF + T.L.roofConcrete, S.roof, S.trim);
    if (!T.lite && st === 'arabesque') crenels(T, o, ring, h + 0.5, S.trim);
  }
  if (!T.lite) ringWindows(T, o, ring, 0.9, h - 0.8, 3.6, 1.2, S.frame, S.glass, S.pitched || st === 'classic' ? S.trim : null);
  B.plate = [ring]; B.plateBase = 0; B.plateTop = h;
  return true;
}
function eh(T, B) {
  const st0 = B.b.ht || 'contemporary';
  if (st0.startsWith('annex-')) return ehAnnex(T, B, st0.slice(6));
  const [st, pi] = st0.split(':'), S = ehPalette(st, +pi || 0);
  const ring = T.ccw(B.outer[0]);
  const o = { ...B.o, base: 0, top: EZ2, fh: 4.6, center: T.centroid(ring), wall: S.wall };
  const lite = T.lite, R = B.r;
  const wings = rectCover(ring).filter((w) => w.len * w.wid > 28);
  if (!wings.length) return false;
  const flat = !S.pitched;
  // ground floor on the true outline (the limestone-clad modern houses are stone all over)
  const lime = st === 'contemporary' && (B.i >> 2) % 5 < 2;
  if (lime) { S.wall = S.lime; o.wall = S.lime; }
  T.walls(ring, 0, EZ1, o, lime ? T.codes.STONE : T.codes.SOLID, { color: S.wall });
  T.cap([ring], EZ1, o, T.codes.ROOF + T.L.roofConcrete, S.roof || C('#e0dbd2'));
  let upper = [];
  if (S.pitched) {
    // a storey on every wing, each under its own terracotta hipped roof; cornice under the eaves
    upper = wings.map((w) => wingRing(T, w));
    wings.forEach((w, k) => {
      const r = upper[k];
      T.walls(r, EZ1, EZ2, { ...o, base: EZ1 }, T.codes.SOLID, { color: S.wall });
      T.cap([r], EZ2, o, T.codes.SOLID, S.wall);
      T.hipRoof({ c: w.c, u: w.u, v: w.v, len: w.len, wid: w.wid }, EZ2, { ...o, wall: S.trim, roofLayer: T.L.roofTiles }, S.roof, 0.75, 0.38 + 0.04 * ((B.i + k) % 3));
      if (!lite) ringBand(T, o, r, EZ1 - 0.35, EZ1, S.trim, T.codes.SOLID, 0.12);
    });
  } else if (st === 'contemporary') {
    // upper boxes on the two largest wings, the second slid along its length into a cantilever; thin floating
    // slabs with deep overhangs; a smaller roof pavilion on the largest
    const pick = wings.slice(0, Math.min(2, wings.length));
    pick.forEach((w, k) => {
      const slide = k === 1 ? Math.min(3.5, w.len * 0.18) * ((B.i % 2) ? 1 : -1) : 0;
      const ww = { ...w, c: [w.c[0] + w.u[0] * slide, w.c[1] + w.u[1] * slide] };
      const r = wingRing(T, ww, -0.4);
      upper.push(r);
      // the upper boxes' finish varies house to house: white render, charcoal, timber slats or stone
      const fin = k === 1 ? (B.i >> 1) % 4 : 0;
      T.walls(r, EZ1, EZ2, { ...o, base: EZ1 }, fin === 3 ? T.codes.STONE : fin === 2 ? T.codes.SLATV : T.codes.SOLID, { color: fin === 1 ? S.dark : fin === 2 ? C('#8b6a4e') : fin === 3 ? S.stone : S.wall });
      T.cap([r], EZ1, o, T.codes.SOLID, S.wall, true);
      const slab = wingRing(T, ww, 0.6);
      const zt = EZ2 + 0.02 * k;
      T.walls(slab, zt, zt + 0.36, { ...o, base: zt }, T.codes.SOLID, { color: S.slab });
      T.cap([slab], zt + 0.36, o, T.codes.ROOF + T.L.roofConcrete, S.roof);
      T.cap([slab], zt, o, T.codes.SOLID, S.slab.clone().multiplyScalar(0.82), true);
    });
    const w0 = pick[0], hv = (B.i * 2654435761) >>> 0;
    if (w0.len > 14 && hv % 100 < 65) {
      // a roof pavilion (gym, lounge) off to one end, a pergola over the roof terrace beside it
      const shift = (((hv >> 8) % 3) - 1) * w0.len * 0.2, pl = w0.len * (0.28 + ((hv >> 12) % 4) * 0.05);
      const pc = [w0.c[0] + w0.u[0] * shift, w0.c[1] + w0.u[1] * shift];
      const pv = wingRing(T, { ...w0, c: pc, len: pl, wid: w0.wid * 0.5 }, 0);
      T.walls(pv, EZ2 + 0.36, EZ2 + 3.4, { ...o, base: EZ2 }, T.codes.SOLID, { color: S.wall });
      const ps = wingRing(T, { ...w0, c: pc, len: pl, wid: w0.wid * 0.5 }, 0.5);
      T.walls(ps, EZ2 + 3.4, EZ2 + 3.7, { ...o, base: EZ2 }, T.codes.SOLID, { color: S.slab });
      T.cap([ps], EZ2 + 3.7, o, T.codes.SOLID, S.slab);
      if (!lite && (hv >> 4) % 2) {
        const side = shift <= 0 ? 1 : -1, gc = [pc[0] + w0.u[0] * side * (pl / 2 + 2.6), pc[1] + w0.u[1] * side * (pl / 2 + 2.6)];
        for (let k2 = -2; k2 <= 2; k2++) {
          const bc = [gc[0] + w0.u[0] * k2 * 0.9, gc[1] + w0.u[1] * k2 * 0.9];
          T.prism(wingRing(T, { ...w0, c: bc, len: 0.12, wid: w0.wid * 0.45 }, 0), EZ2 + 3.0, EZ2 + 3.2, o, T.codes.SOLID, C('#8b6a4e'));
        }
        for (const [a2, b2] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          const pp = [gc[0] + w0.u[0] * a2 * 2.0 + w0.v[0] * b2 * w0.wid * 0.21, gc[1] + w0.u[1] * a2 * 2.0 + w0.v[1] * b2 * w0.wid * 0.21];
          T.cone(pp, 0.08, 0.08, EZ2 + 0.36, EZ2 + 3.0, o, C('#2c2c2c'), T.codes.SOLID, { segs: 6 });
        }
      }
    }
    if (!lite) T.scatterEquipment(wingRing(T, w0, -1.2), EZ2 + 0.36, B.i, 3, R);
  } else {
    // classic and Arabian revival: a full upper storey on the outline (set back a little), a flat roof behind a
    // parapet; cornices; a balustrade (classic) or merlons (Arabian revival)
    let up = T.ccw(T.insetRing(ring, 0.6));
    if (selfCrossing(up) || Math.abs(T.signedArea(up)) < Math.abs(T.signedArea(ring)) * 0.6) up = ring;
    upper = [up];
    T.walls(up, EZ1, EZ2, { ...o, base: EZ1 }, T.codes.SOLID, { color: S.wall });
    T.cap([up], EZ1, o, T.codes.SOLID, S.wall, true);
    const inner = T.parapetRoof(up, EZ2, 1.0, o, T.codes.ROOF + T.L.roofConcrete, S.roof, S.trim);
    if (!lite) {
      ringBand(T, o, up, EZ2 - 0.45, EZ2 - 0.05, S.trim, T.codes.SOLID, 0.18);
      ringBand(T, o, ring, EZ1 - 0.4, EZ1, S.trim, T.codes.SOLID, 0.16);
      if (st === 'classic') ringBand(T, o, up, EZ2 + 0.12, EZ2 + 0.82, S.trim, T.codes.SLATV, 0.05);
      else crenels(T, o, up, EZ2 + 1.0, S.trim);
      if (inner) T.scatterEquipment(inner, EZ2, B.i, Math.min(5, Math.round(Math.abs(T.signedArea(up)) / 160)), R);
    }
    if (!lite && st === 'mediterranean') {
      // a scalloped frieze under the parapet, and deep two-storey verandas on the garden side
      ringBand(T, o, up, EZ2 - 0.95, EZ2 - 0.5, S.screen, T.codes.SCREEN, 0.2);
      const f = B.b.hf != null ? [-Math.cos(B.b.hf), -Math.sin(B.b.hf)] : [0, 1], i = facingEdge(ring, f);
      const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > 10) {
        const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [d[1], -d[0]], dp = 3.0;
        const W = (s2, t2) => [a[0] + d[0] * s2 + n[0] * t2, a[1] + d[1] * s2 + n[1] * t2];
        const rect = (s0, s1, t0, t1) => [W(s0, t0), W(s1, t0), W(s1, t1), W(s0, t1)];
        T.prism(rect(1, L - 1, 0, dp), EZ1 - 0.35, EZ1, o, T.codes.SOLID, S.trim);
        T.prism(rect(1, L - 1, 0, dp), EZ2 - 0.4, EZ2, o, T.codes.SOLID, S.trim);
        const nCol = Math.max(2, Math.round((L - 2) / 3.6));
        for (let k = 0; k <= nCol; k++) { const sc = 1.2 + ((L - 2.4) * k) / nCol; T.prism(rect(sc - 0.25, sc + 0.25, dp - 0.5, dp), 0, EZ2 - 0.4, o, T.codes.SOLID, S.wall); }
        const r0 = W(1, dp + 0.02), r1 = W(L - 1, dp + 0.02);
        T.quad([r0[0], r0[1], EZ1], [r1[0], r1[1], EZ1], [r1[0], r1[1], EZ1 + 1.0], [r0[0], r0[1], EZ1 + 1.0], o, S.screen, T.codes.SCREEN, [[0, EZ1], [L - 2, EZ1], [L - 2, EZ1 + 1], [0, EZ1 + 1]]);
      }
    }
    if (!lite && st === 'classic' && (B.i >> 3) % 10 < 3 && B.b.hf != null) {
      // two small blue glass domes over the stair halls (seen on several neoclassical houses)
      const f = [Math.cos(B.b.hf), Math.sin(B.b.hf)], i = facingEdge(up, f);
      const a = up[i], b = up[(i + 1) % up.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > 12) {
        const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [d[1], -d[0]];
        for (const s2 of [L * 0.32, L * 0.68]) {
          const c = [a[0] + d[0] * s2 - n[0] * 3.2, a[1] + d[1] * s2 - n[1] * 3.2];
          T.cone(c, 1.5, 1.5, EZ2, EZ2 + 1.1, o, S.trim, T.codes.SOLID, { segs: 16 });
          T.dome(c, 1.4, 1.4, EZ2 + 1.1, 1.3, o, C('#4f86b3'), T.codes.GLASSY, { segs: 16, rings: 6 });
        }
      }
    }
    if (!lite && inner && (B.i >> 5) % 10 < 5) {
      // the 'large usable rooftop': a pergola or a domed gazebo on the roof terrace
      const w = wings[0], gz = (B.i >> 9) % 2;
      const c = [w.c[0] + w.u[0] * w.len * 0.22, w.c[1] + w.u[1] * w.len * 0.22];
      if (T.pointInRing(c, inner)) {
        const hs = 1.9;
        for (const [a2, b2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) T.cone([c[0] + w.u[0] * a2 * hs + w.v[0] * b2 * hs, c[1] + w.u[1] * a2 * hs + w.v[1] * b2 * hs], 0.13, 0.11, EZ2, EZ2 + 2.7, o, S.trim, T.codes.SOLID, { segs: 8 });
        if (gz) { T.cone(c, 2.5, 2.5, EZ2 + 2.7, EZ2 + 3.0, o, S.trim, T.codes.SOLID, { segs: 20 }); T.dome(c, 2.4, 2.4, EZ2 + 3.0, 1.5, o, S.dome || S.trim, T.codes.SOLID, { segs: 20, rings: 6 }); }
        else for (let k = -3; k <= 3; k++) { const bc = [c[0] + w.u[0] * k * 0.6, c[1] + w.u[1] * k * 0.6]; T.prism(wingRing(T, { ...w, c: bc, len: 0.1, wid: 4.4 }, 0), EZ2 + 2.6, EZ2 + 2.8, o, T.codes.SOLID, C('#8b6a4e')); }
      }
    }
    // a dome over the central wing (every Arabian revival house; a few classic palaces)
    if ((st === 'arabesque' && B.i % 5 < 2) || (st === 'classic' && B.i % 7 === 0)) {
      // a dome on a drum over the entrance hall, with a finial
      const w = wings[0], rr = Math.min(w.wid * 0.18, 3.6), dz = EZ2 + 1.0;
      T.cone(w.c, rr * 1.04, rr * 1.04, EZ2, dz + 1.4, o, S.trim, T.codes.SOLID, { segs: 24 });
      T.dome(w.c, rr, rr, dz + 1.4, rr * 0.9, o, S.dome || S.trim, T.codes.SOLID, { segs: 24, rings: 8 });
      T.cone(w.c, 0.1, 0.0, dz + 1.4 + rr * 0.9, dz + 2.4 + rr * 0.9, o, C('#c9a54a'), T.codes.SOLID, { segs: 6 });
    }
  }
  if (!lite) {
    // windows by style
    const win = st === 'contemporary' ? [5.6, 4.4, 5.6, 3.8, null] : st === 'classic' ? [3.0, 1.45, 3.0, 1.35, S.trim] : st === 'arabesque' ? [3.4, 1.5, 3.4, 1.4, S.trim] : [3.3, 1.4, 3.3, 1.3, S.trim];
    ringWindows(T, o, ring, st === 'contemporary' ? 0.25 : 0.6, EZ1 - 0.8, win[0], win[1], S.frame, S.glass, win[4]);
    for (const r of upper) ringWindows(T, o, r, EZ1 + 0.7, EZ2 - 0.7, win[2], win[3], S.frame, S.glass, win[4]);
    if (st === 'contemporary') for (const r of upper) ringBand(T, o, [r[0], r[1]], EZ1, EZ2, S.stone, T.codes.STONE, 0.06);
    // the porte-cochere at the street front
    if (B.b.hf != null) {
      const f = [Math.cos(B.b.hf), Math.sin(B.b.hf)], i = facingEdge(ring, f);
      const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > 9) {
        const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [d[1], -d[0]], mid = L / 2;
        const W = (s, t) => [a[0] + d[0] * s + n[0] * t, a[1] + d[1] * s + n[1] * t];
        const hw = Math.min(5, L * 0.25), dp = st === 'contemporary' ? 7.5 : 6.2;
        const rect = (s0, s1, t0, t1) => [W(s0, t0), W(s1, t0), W(s1, t1), W(s0, t1)];
        if (st === 'contemporary') {
          T.prism(rect(mid - hw - 1, mid + hw + 1, 0, dp), 4.4, 4.85, o, T.codes.SOLID, S.slab);
          T.prism(rect(mid + hw, mid + hw + 0.5, 0, dp - 0.6), 0, 4.4, o, T.codes.STONE, S.stone);
        } else {
          const col = st === 'classic' ? S.trim : S.wall;
          for (const s of [mid - hw, mid + hw]) for (const t of [dp - 0.6, 1.2]) T.cone(W(s, t), 0.32, 0.28, 0, 4.8, o, col, T.codes.SOLID, { segs: 12 });
          T.prism(rect(mid - hw - 0.5, mid + hw + 0.5, 0, dp), 4.8, 5.6, o, T.codes.SOLID, S.trim);
          if (S.pitched) {
            const ob = { c: W(mid, dp / 2), u: d, v: n, len: 2 * hw + 1, wid: dp };
            T.hipRoof(ob, 5.6, { ...o, wall: S.trim, roofLayer: T.L.roofTiles }, S.roof, 0.4, 0.4);
          } else if (st === 'classic') {
            // pediment over the portico
            const h0 = 5.6, h1 = 7.3, p0 = W(mid - hw - 0.5, dp), p1 = W(mid + hw + 0.5, dp), pm = W(mid, dp), q0 = W(mid - hw - 0.5, 0.2), q1 = W(mid + hw + 0.5, 0.2), qm = W(mid, 0.2);
            T.quad([p0[0], p0[1], h0], [p1[0], p1[1], h0], [pm[0], pm[1], h1], [pm[0], pm[1], h1], o, S.trim, T.codes.SOLID);
            T.quad([p1[0], p1[1], h0], [q1[0], q1[1], h0], [qm[0], qm[1], h1], [pm[0], pm[1], h1], o, S.trim, T.codes.SOLID);
            T.quad([q0[0], q0[1], h0], [p0[0], p0[1], h0], [pm[0], pm[1], h1], [qm[0], qm[1], h1], o, S.trim, T.codes.SOLID);
          } else {
            // Arabian revival: a screened arch filling the portico front
            const p0 = W(mid - hw + 0.4, dp + 0.02), p1 = W(mid + hw - 0.4, dp + 0.02);
            T.quad([p0[0], p0[1], 1.0], [p1[0], p1[1], 1.0], [p1[0], p1[1], 4.6], [p0[0], p0[1], 4.6], o, S.screen, T.codes.SCREEN, [[0, 1], [2 * hw - 0.8, 1], [2 * hw - 0.8, 4.6], [0, 4.6]]);
          }
        }
        // the entrance door, double height in the classic and Arabian revival houses
        const e0 = W(mid - 1.2, 0.05), e1 = W(mid + 1.2, 0.05), dz = st === 'classic' || st === 'arabesque' ? 6.4 : 4.0;
        T.quad([e0[0], e0[1], 0.1], [e1[0], e1[1], 0.1], [e1[0], e1[1], dz], [e0[0], e0[1], dz], o, C('#5c4330'), T.codes.SLATV, [[0, 0.1], [2.4, 0.1], [2.4, dz], [0, dz]]);
      }
    }
  }
  B.plate = [ring]; B.plateBase = EZ1; B.plateTop = EZ2;
  return true;
}

// ---------------------------------------------------------------- Jumeirah Islands (Nakheel, 2004-2006)
// 46 island clusters of 16 villas round a loop road, each cluster in one theme, plus The Mansions
// (data-raw/research/jumeirah-islands/research.json). Every villa is two storeys with a single-storey double garage
// forward at a front corner, in one of three types: Entertainment Foyer (garage, entrance bay beside it, the main
// block behind), Garden Hall (deeper, with a double-height hall to the garden) and Master View (a U round a garden
// terrace). The look follows the listing photographs of each theme:
//   Islamic: straw-cream render, flat roofs behind crenellated parapets, a square entrance tower with a tall
//     recessed pointed arch, lattice grilles;
//   Oasis: sand render, plain parapets and roof terraces, a garage block with battered sides and a curved parapet,
//     pointed arches, zigzag reliefs; one type carries a wind tower;
//   European: cream render with white trim, terracotta hips on every block, a gabled bay, a columned portico with a
//     balustraded balcony, arched windows;
//   Mediterranean: warm peach-cream render with darker trim, many small tile hips, a belvedere tower with an open
//     arch, black iron balcony rails;
//   'Contemporary' (the portals' name): the European houses in white, mustard or salmon;
//   The Mansions: beige render with taupe pilasters on a stone plinth under light terracotta hips.
// About a third of the villas have since been remodelled as white modern houses with dark frames (estimate): the
// tile-roofed ones mostly keep their roofs, the flat-roofed ones become plain white boxes under thin slabs.
// Wall and roof colours were sampled from the photographs; the footprints, the heights (eaves or parapet about
// 7.5 m, towers about 10 m) and the massing of each type are estimates: no dimensioned plan was published.
const JI = {
  islamic: { walls: ['#e4d9a7', '#e6daae', '#d9cc9f', '#e9dc9c'], trim: '#f2ebca', recess: '#cbbd8a', screen: '#a8966a', door: '#efe6cf', deck: '#d9d3c4', flat: true },
  oasis: { walls: ['#e0c592', '#d8bd8a', '#d3b784', '#ddc08a'], trim: '#e8d9b8', recess: '#b39c72', screen: '#a58c62', door: '#e3d3b0', deck: '#d6cfbf', flat: true },
  euro: { walls: ['#f0e3d2', '#eadfc8', '#e2d6bb', '#f3e9da'], trim: '#fdfbf5', recess: '#d9cbb2', screen: '#fdfbf5', door: '#efe6d6', roofs: ['#bd7754', '#b47457', '#c27d58'] },
  med: { walls: ['#f4d9b9', '#e9d5ae', '#f3d5ab', '#efcaa8'], trim: '#dcbb92', recess: '#8a7358', screen: '#2c2a28', door: '#e9d9bd', roofs: ['#c0714c', '#b66a48', '#c98058'] },
  cont: { walls: ['#ebebeb', '#d4b56e', '#e9bfa6', '#f1ede3'], trim: '#f8f6f0', recess: '#d8d2c4', screen: '#f8f6f0', door: '#ece6da', roofs: ['#bd7754', '#b06f52', '#c27d58'] },
  mansion: { walls: ['#c9b79b', '#c4b193', '#cdbca1', '#c9b79b'], trim: '#8a715d', recess: '#b29f84', screen: '#3a3330', door: '#6b4a32', roofs: ['#cd8a63', '#c98560', '#d2906a'], plinth: '#a89880' },
  modern: { walls: ['#f3f2ed', '#f0efe9', '#f5f4f0', '#eeede8'], trim: '#f8f7f3', recess: '#3d4144', screen: '#8b6a4e', door: '#4a4d50', deck: '#e2dfd8', flat: true },
};
const JW = { frame: C('#f6f4ec'), glass: C('#4d7f79'), dark: C('#2b2d2f'), mglass: C('#39505c'), rail: C('#26272a') };
const JZ1 = 3.7, JZ2 = 7.4;
function ji(T, B) {
  const F = houseFrame(T, B); if (!F) return false;
  const [th0, type, vi, rm] = String(B.b.ht || 'med:ef:0:o').split(':');
  const v = +vi || 0, base = JI[th0] || JI.med, remodel = rm === 'r', mans = th0 === 'mansion';
  const keepRoof = remodel && !base.flat && (B.i + v) % 3 !== 0;
  const P = remodel ? JI.modern : base, theme = remodel ? 'modern' : th0, tiled = remodel ? keepRoof : !base.flat;
  const S = {
    wall: C(P.walls[v % P.walls.length]), trim: C(P.trim), recess: C(P.recess), screen: C(P.screen), door: C(P.door), deck: C(P.deck || '#d9d3c4'),
    roof: C(keepRoof && (B.i >> 1) % 2 ? '#5f6164' : (base.roofs || ['#bd7754'])[(B.i + v) % 3]), frame: remodel ? JW.dark : JW.frame, glass: remodel ? JW.mglass : JW.glass,
  };
  const H = houseKit(T, B, F, { fh: JZ1, wall: S.wall });
  const o = H.o, lite = T.lite, m = B.b.hm || 1, W = F.W, D = F.D, hw = W / 2, K = T.codes;
  const aT = theme === 'euro' || theme === 'med' || theme === 'cont' || theme === 'mansion' ? 1 : theme === 'oasis' || theme === 'islamic' ? 2 : 0;
  // local coordinates: x across the front (garage side positive, mirrored by m), y from the front face into the plot
  const X = (a, b) => (m > 0 ? [a, b] : [-b, -a]);
  const Pt = (x, y) => F.P(m * x, y);
  const rect = (x0, x1, y0, y1) => T.ccw([Pt(x0, y0), Pt(x1, y0), Pt(x1, y1), Pt(x0, y1)]);
  const bx = (x0, x1, y0, y1, z0, z1, opt) => { const [a, b] = X(x0, x1); return H.box(a, y0, b, y1, z0, z1, opt); };
  const nOf = { front: [-F.yv[0], -F.yv[1]], back: F.yv, right: [F.xv[0] * m, F.xv[1] * m], left: [-F.xv[0] * m, -F.xv[1] * m] };
  const onFace = (face, at, q, off) => { const p = face === 'front' || face === 'back' ? Pt(q, at) : Pt(at, q), n = nOf[face]; return [p[0] + n[0] * off, p[1] + n[1] * off]; };
  // a shape on a wall: prof = [[s, zTop], ...] along the face (s is local x on the front and back, local y on the
  // sides), filled down to z0, standing `off` proud
  const strip = (face, at, prof, z0, color, code = K.SOLID, off = 0.06) => {
    if (lite || prof.length < 2) return;
    const n = nOf[face], a0 = onFace(face, at, prof[0][0], off), a1 = onFace(face, at, prof[prof.length - 1][0], off);
    const pr = (a1[0] - a0[0]) * -n[1] + (a1[1] - a0[1]) * n[0] >= 0 ? prof : prof.slice().reverse();
    for (let i = 0; i + 1 < pr.length; i++) {
      const p = onFace(face, at, pr[i][0], off), q = onFace(face, at, pr[i + 1][0], off), L = Math.abs(pr[i + 1][0] - pr[i][0]);
      if (L < 0.01) continue;
      T.quad([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], pr[i + 1][1]], [p[0], p[1], Math.max(z0 + 0.01, pr[i][1])], o, color, code, [[0, z0], [L, z0], [L, pr[i + 1][1]], [0, pr[i][1]]]);
    }
  };
  const panel = (face, at, a, b, z0, z1, color, code = K.SOLID, off = 0.05) => strip(face, at, [[a, z1], [b, z1]], z0, color, code, off);
  const arcProf = (a, b, zs, pointed = false, n = 8, k = 1) => {
    const r = (b - a) / 2, out = [];
    for (let i = 0; i <= n; i++) { const t = i / n, u = Math.abs(2 * t - 1); out.push([a + (b - a) * t, zs + 0.02 + r * k * (pointed ? 1.25 * (1 - Math.pow(u, 1.6)) : Math.sqrt(Math.max(0, 1 - u * u)))]); }
    return out;
  };
  const arch = (face, at, a, b, z0, zs, color, code = K.SOLID, off = 0.05, pointed = false) => strip(face, at, arcProf(a, b, zs, pointed), z0, color, code, off);
  // a window: moulded surround, frame and glass; top 0 square, 1 round arch, 2 pointed arch
  const win = (face, at, c, w, z0, z1, top = 0, mull = 0) => {
    if (lite || w < 0.5) return;
    const a = c - w / 2, b = c + w / 2;
    if (theme !== 'modern') { if (top) arch(face, at, a - 0.16, b + 0.16, z0 - 0.16, z1, S.trim, K.SOLID, 0.03, top === 2); else panel(face, at, a - 0.16, b + 0.16, z0 - 0.16, z1 + 0.16, S.trim, K.SOLID, 0.03); }
    if (top) { arch(face, at, a, b, z0, z1, S.frame, K.SOLID, 0.045, top === 2); arch(face, at, a + 0.08, b - 0.08, z0 + 0.08, z1, S.glass, K.GLASSY, 0.06, top === 2); }
    else { panel(face, at, a, b, z0, z1, S.frame, K.SOLID, 0.045); panel(face, at, a + 0.08, b - 0.08, z0 + 0.08, z1 - 0.08, S.glass, K.GLASSY, 0.06); }
    for (let k = 1; k <= mull; k++) { const x = a + (w * k) / (mull + 1); panel(face, at, x - 0.035, x + 0.035, z0, z1, S.frame, K.SOLID, 0.07); }
  };
  const row = (face, at, a, b, n, w, z0, z1, top = 0, mull = 0) => { for (let k = 0; k < n; k++) win(face, at, a + ((b - a) * (k + 0.5)) / n, Math.min(w, (b - a) / n - 0.5), z0, z1, top, mull); };
  const hip = (x0, x1, y0, y1, z, over = 0.55, pitch = 0.36) => {
    const c = Pt((x0 + x1) / 2, (y0 + y1) / 2), lx = Math.abs(x1 - x0), ly = Math.abs(y1 - y0);
    const ob = lx >= ly ? { c, u: F.xv, v: F.yv, len: lx, wid: ly } : { c, u: F.yv, v: F.xv, len: ly, wid: lx };
    T.hipRoof(ob, z, { ...o, wall: S.trim, roofLayer: T.L.roofTiles }, S.roof, over, pitch);
  };
  // one block of the house under the theme's roof: tile hips, a crenellated or plain parapet, or a thin modern slab
  const block = (x0, x1, y0, y1, z0, z1, kind = 'main') => {
    const r = rect(x0, x1, y0, y1);
    if (tiled) {
      bx(x0, x1, y0, y1, z0, z1, { color: S.wall });
      hip(x0, x1, y0, y1, z1, kind === 'main' ? 0.6 : 0.45, kind === 'main' ? 0.33 : kind === 'tower' ? 0.5 : 0.38);
      if (!lite && theme !== 'modern') ringBand(T, o, r, z1 - 0.34, z1 - 0.05, S.trim, K.SOLID, 0.09);
    } else if (theme === 'modern') {
      bx(x0, x1, y0, y1, z0, z1, { color: S.wall, roof: S.deck });
      if (kind !== 'garage') bx(x0 - 0.45, x1 + 0.45, y0 - 0.45, y1 + 0.45, z1, z1 + 0.26, { color: S.trim, roof: S.deck });
    } else {
      const par = kind === 'tower' ? 0.9 : 0.75;
      bx(x0, x1, y0, y1, z0, z1, { color: S.wall, top: 'parapet', roof: S.deck, par, parColor: S.wall });
      if (!lite) {
        ringBand(T, o, r, z1 - 0.12, z1 + 0.12, S.trim, K.SOLID, 0.07);
        if (theme === 'islamic') crenels(T, o, r, z1 + par, S.wall);
      }
    }
    return r;
  };
  const column = (x, y, z0, z1, r = 0.2, color = S.trim) => { if (!lite) T.cone(Pt(x, y), r, r * 0.9, z0, z1, o, color, K.SOLID, { segs: 8 }); };
  const railOf = () => (theme === 'modern' ? [S.glass, K.GLASSY] : theme === 'euro' || theme === 'cont' ? [S.screen, K.SLATV] : theme === 'islamic' || theme === 'oasis' ? [S.screen, K.SCREEN] : [JW.rail, K.SLATV]);
  // a balcony: slab, rail on its three open sides, posts under the outer corners
  const balcony = (face, at, a, b, dp, z = JZ1) => {
    if (lite) return;
    const s = face === 'back' ? 1 : -1, y0 = Math.min(at, at + s * dp), y1 = Math.max(at, at + s * dp), [rc, rk] = railOf();
    bx(a, b, y0, y1, z - 0.25, z, { color: S.trim });
    panel(face, at + s * dp, a, b, z, z + 0.95, rc, rk, 0);
    panel('left', a, y0, y1, z, z + 0.95, rc, rk, 0); panel('right', b, y0, y1, z, z + 0.95, rc, rk, 0);
    for (const x of [a + 0.2, b - 0.2]) column(x, at + s * (dp - 0.2), 0, z - 0.25, 0.16, theme === 'modern' ? S.frame : S.trim);
  };

  // ---- the double garage at the front corner
  const G = Math.min(6.4, W * 0.4), gd = 6.4, gx0 = hw - G, gz = 3.6;
  const zig = (a, b, z) => { const zz = []; for (let k = 0; k <= 10; k++) zz.push([a + ((b - a) * k) / 10, z + (k % 2 ? 0.4 : 0.04)]); strip('front', 0, zz, z, S.recess, K.SOLID, 0.03); };
  if (theme === 'oasis' && !lite) {
    // battered sides under a curved parapet (the street-front photographs)
    const top = rect(gx0, hw, 0, gd), bot = rect(gx0 - 0.5, hw + 0.5, 0, gd);
    for (let i = 0; i < 4; i++) { const a = bot[i], b = bot[(i + 1) % 4], c = top[(i + 1) % 4], d = top[i]; T.quad([a[0], a[1], 0], [b[0], b[1], 0], [c[0], c[1], gz], [d[0], d[1], gz], o, S.wall, K.SOLID); }
    T.parapetRoof(top, gz, 0.5, o, K.ROOF + T.L.roofConcrete, S.deck, S.wall);
    const prof = arcProf(gx0, hw, gz + 0.5, false, 10, 0.28);
    strip('front', 0, prof, gz + 0.45, S.wall, K.SOLID, 0); strip('back', 0.38, prof, gz + 0.45, S.wall.clone().multiplyScalar(0.9), K.SOLID, 0);
    zig(gx0 + 1.3, hw - 1.3, 2.95);
  } else {
    block(gx0, hw, 0, gd, 0, gz, 'garage');
    if (theme === 'islamic') zig(gx0 + 1.6, hw - 1.6, 2.95);
  }
  if (!lite) {
    const a = gx0 + 0.75, b = hw - 0.75;
    if (aT === 1) {
      // a low arched opening in a moulded surround
      strip('front', 0, arcProf(a - 0.25, b + 0.25, 2.25, false, 8, 0.16), 0, S.trim, K.SOLID, 0.03);
      strip('front', 0, arcProf(a, b, 2.2, false, 8, 0.13), 0, S.door, K.SLATH, 0.06);
    } else panel('front', 0, a, b, 0, 2.6, S.door, K.SLATH, 0.06);
  }

  // ---- the entrance, by theme
  const door = (at, c, zt = 2.5) => panel('front', at, c - 0.7, c + 0.7, 0, zt, C(theme === 'modern' ? '#3a3d40' : '#5c4330'), K.SLATV, 0.07);
  const entrance = (ex0, ex1, ey0, my) => {
    const ec = (ex0 + ex1) / 2, ew = ex1 - ex0;
    if (theme === 'islamic') {
      // the square entrance tower: a tall recessed pointed arch, a grille under the merlons
      block(ex0, ex1, ey0, my + 0.8, 0, 9.3, 'tower');
      arch('front', ey0, ec - ew * 0.34, ec + ew * 0.34, 0.1, 6.3, S.recess, K.SOLID, 0.04, true);
      win('front', ey0, ec, ew * 0.4, 4.5, 6.0, 2); door(ey0, ec);
      panel('front', ey0, ec - ew * 0.3, ec + ew * 0.3, 8.2, 8.8, S.screen, K.SCREEN, 0.05);
    } else if (theme === 'oasis') {
      const wind = v === 3; // the wind-tower type
      block(ex0, ex1, ey0, my + (wind ? 1.4 : 0.8), 0, wind ? 10.3 : JZ2 + 0.9, 'tower');
      arch('front', ey0, ec - 1.0, ec + 1.0, 0.05, 2.0, S.recess, K.SOLID, 0.04, true); door(ey0, ec, 2.1);
      strip('front', ey0, arcProf(ec - 0.75, ec + 0.75, 4.9, true), 4.3, S.screen, K.SCREEN, 0.05);
      if (wind) {
        for (const k of [-1, 0, 1]) panel('front', ey0, ec + k * ew * 0.27 - 0.28, ec + k * ew * 0.27 + 0.28, 8.1, 9.9, S.recess, K.SLATV, 0.05);
        const yd = my + 1.4 - ey0;
        for (const k of [-1, 0, 1]) { const c = ey0 + yd / 2 + k * yd * 0.27; panel('left', ex0, c - 0.26, c + 0.26, 8.1, 9.9, S.recess, K.SLATV, 0.05); panel('right', ex1, c - 0.26, c + 0.26, 8.1, 9.9, S.recess, K.SLATV, 0.05); }
      }
    } else if (theme === 'med') {
      // the belvedere tower: an open arch at the upper level behind an iron rail, under a pyramid of tiles
      block(ex0, ex1, ey0, my + 0.9, 0, 9.7, 'tower');
      arch('front', ey0, ec - ew * 0.3, ec + ew * 0.3, 4.3, 7.0, S.recess, K.SOLID, 0.04);
      panel('front', ey0, ec - ew * 0.3, ec + ew * 0.3, 4.3, 5.2, JW.rail, K.SLATV, 0.07);
      arch('front', ey0, ec - 0.95, ec + 0.95, 0, 2.3, S.trim, K.SOLID, 0.03); door(ey0, ec, 2.6);
      if (!lite) ringBand(T, o, rect(ex0, ex1, ey0, my + 0.9), 3.6, 3.85, S.trim, K.SOLID, 0.1);
    } else if (theme === 'modern') {
      // a flat canopy over a double-height glazed entrance, a timber panel beside it
      if (!lite) bx(ex0 - 0.3, ex1 + 0.3, my - 1.3, my, 2.9, 3.14, { color: S.trim });
      panel('front', my, ec - ew * 0.42, ec + ew * 0.42, 0.1, 6.7, S.frame, K.SOLID, 0.04);
      panel('front', my, ec - ew * 0.42 + 0.1, ec + ew * 0.42 - 0.1, 0.2, 6.6, S.glass, K.GLASSY, 0.055);
      door(my, ec, 2.6);
      panel('front', my, ex0 - 2.0, ex0 - 0.3, 0, JZ2, S.screen, K.SLATV, 0.05);
    } else {
      // European and 'Contemporary' villas and the Mansions: a columned portico; over it a balustraded balcony
      // (a tiled porch on the Mansions)
      const py = ey0;
      if (!lite) bx(ex0 - 0.2, ex1 + 0.2, py, my, 3.2, 3.55, { color: mans ? S.wall : S.trim });
      for (const x of mans ? [ex0 + 0.25, ec - 0.7, ec + 0.7, ex1 - 0.25] : [ex0 + 0.25, ex1 - 0.25]) column(x, py + 0.3, 0, 3.2, 0.22, mans ? S.trim : S.trim);
      if (mans) hip(ex0 - 0.2, ex1 + 0.2, py, my, 3.55, 0.35, 0.36);
      else { panel('front', py, ex0 - 0.2, ex1 + 0.2, 3.55, 4.45, S.screen, K.SLATV, 0); panel('left', ex0 - 0.2, py, my, 3.55, 4.45, S.screen, K.SLATV, 0); panel('right', ex1 + 0.2, py, my, 3.55, 4.45, S.screen, K.SLATV, 0); }
      arch('front', my, ec - 0.95, ec + 0.95, 0, 2.3, S.trim, K.SOLID, 0.03); door(my, ec, 2.6);
      win('front', my, ec, 1.5, 3.75, 5.9, 1, 1);
    }
  };
  // the street front of the main block between x0 and x1 (clear of the entrance)
  const fronts = (x0, x1, my, bay = true) => {
    let a = x0 + 0.7;
    if (bay && tiled && theme !== 'modern' && x1 - x0 > 7.5) {
      // a projecting two-storey bay under its own hip (the 'gable' of the European and Mediterranean fronts)
      const bw = Math.min(5.2, (x1 - x0) * 0.46);
      block(x0 + 0.7, x0 + 0.7 + bw, my - 1.3, my + 2.5, 0, JZ2, 'bay');
      win('front', my - 1.3, x0 + 0.7 + bw / 2, Math.min(2.2, bw - 1.6), 0.9, 2.5, aT, 1);
      win('front', my - 1.3, x0 + 0.7 + bw / 2, Math.min(1.9, bw - 1.8), 4.5, 6.2, 0, 1);
      a = x0 + 0.7 + bw + 0.3;
    }
    const n = x1 - a > 6.5 ? 2 : x1 - a > 2.4 ? 1 : 0;
    row('front', my, a, x1 - 0.5, n, theme === 'modern' ? 2.6 : 1.5, theme === 'modern' ? 0.3 : 0.9, 2.6, theme === 'modern' ? 0 : aT === 1 ? 1 : 0, 1);
    row('front', my, a, x1 - 0.5, n, theme === 'modern' ? 2.6 : 1.4, 4.5, 6.3, aT === 2 ? 2 : 0, 1);
    if (!lite && theme === 'oasis' && n) panel('front', my, a + 0.4, x1 - 0.9, JZ2 + 0.15, JZ2 + 0.7, S.screen, K.SCREEN, 0.05);
    if (!lite && theme === 'islamic' && n) for (let k = 0; k < n; k++) { const c = a + ((x1 - 0.5 - a) * (k + 0.5)) / n; panel('front', my, c - 0.7, c + 0.7, 6.65, 7.05, S.screen, K.SCREEN, 0.05); }
  };
  // the garden side between x0 and x1: glazed doors to the terrace, bedroom windows and a balcony above
  const rear = (x0, x1, yb, hall = false) => {
    const n = x1 - x0 > 11 ? 3 : x1 - x0 > 6 ? 2 : 1, mod = theme === 'modern';
    if (hall) {
      // the Garden Hall's double-height living hall
      const c = (x0 + x1) / 2;
      win('back', yb, c, Math.min(4.2, (x1 - x0) * 0.36), 0.25, mod ? 6.6 : 5.4, mod ? 0 : aT, 2);
      for (const s of [-1, 1]) { const cs = c + s * (x1 - x0) * 0.34; win('back', yb, cs, 1.8, 0.2, 2.7, 0, 1); win('back', yb, cs, 1.5, 4.5, 6.3, aT === 2 ? 2 : 0, 1); }
      balcony('back', yb, x1 - 4.4, x1 - 0.5, 1.4);
      return;
    }
    row('back', yb, x0 + 0.6, x1 - 0.6, n, mod ? 3.4 : 2.3, 0.2, 2.75, mod ? 0 : aT === 1 ? 1 : 0, mod ? 2 : 1);
    row('back', yb, x0 + 0.6, x1 - 0.6, n, mod ? 3.0 : 1.6, mod ? 4.0 : 4.4, 6.4, aT === 2 ? 2 : 0, 1);
    if (x1 - x0 > 6) balcony('back', yb, x0 + 0.7, x0 + 0.7 + Math.min(5.5, (x1 - x0) * 0.45), 1.5);
  };
  const flank = (face, at, y0, y1) => { const n = y1 - y0 > 9 ? 2 : 1; row(face, at, y0 + 0.8, y1 - 0.8, n, 1.3, 0.9, 2.6, 0, 1); row(face, at, y0 + 0.8, y1 - 0.8, n, 1.3, 4.5, 6.2, 0, 1); };
  const course = (r) => { if (!lite && theme !== 'modern') ringBand(T, o, r, JZ1 - 0.18, JZ1 + 0.08, S.trim, K.SOLID, 0.07); if (!lite && mans) ringBand(T, o, r, 0, 0.6, C(JI.mansion.plinth), K.STONE, 0.06); };

  let plate;
  if (type === 'mv' || type === 'mn') {
    // Master View and the Mansions: a U round a garden terrace, the entrance recessed in the middle of the front
    const wl = Math.min(5.8, W * 0.26), my = 3.4, yt = D - 5, cx0 = -hw + wl, ec = (cx0 + gx0) / 2;
    const left = block(-hw, cx0, 1.2, D, 0, JZ2, 'main'), mid = block(cx0, gx0, my, yt, 0, JZ2, 'main'), right = block(gx0, hw, gd, D, 0, JZ2, 'main');
    for (const r of [left, mid, right]) course(r);
    entrance(ec - 1.9, ec + 1.9, my - 1.9, my);
    // windows: the wings' street and garden ends, the middle block either side of the entrance
    for (const [z0, z1, tp] of [[0.9, 2.6, aT === 1 ? 1 : 0], [4.5, 6.3, aT === 2 ? 2 : 0]]) {
      win('front', 1.2, -hw + wl / 2, Math.min(1.8, wl - 1.6), z0, z1, tp, 1);
      win('back', D, -hw + wl / 2, Math.min(2.2, wl - 1.4), z0 === 0.9 ? 0.2 : z0, z1, tp, 1);
      win('back', D, (gx0 + hw) / 2, Math.min(2.2, G - 1.6), z0 === 0.9 ? 0.2 : z0, z1, tp, 1);
      if (ec - 1.9 - cx0 > 2.6) win('front', my, (cx0 + ec - 1.9) / 2, 1.4, z0, z1, tp, 1);
      if (gx0 - ec - 1.9 > 2.6) win('front', my, (gx0 + ec + 1.9) / 2, 1.4, z0, z1, tp, 1);
    }
    flank('left', -hw, 1.2, D); flank('right', hw, gd, D);
    // the garden terrace between the wings: a loggia on columns, glazed doors behind it, windows over its roof
    if (!lite) {
      bx(cx0, gx0, yt, D - 1.0, 3.25, 3.55, { color: S.trim, roof: S.deck });
      const nc = Math.max(2, Math.round((gx0 - cx0) / 3.2));
      for (let k = 0; k <= nc; k++) column(cx0 + 0.3 + ((gx0 - cx0 - 0.6) * k) / nc, D - 1.3, 0, 3.25, 0.2);
      row('back', yt, cx0 + 0.5, gx0 - 0.5, 2, 2.4, 0.2, 2.75, 0, 1);
      row('back', yt, cx0 + 0.5, gx0 - 0.5, 2, 1.6, 4.4, 6.3, aT === 2 ? 2 : 0, 1);
      if (mans) for (const x of [-hw + 0.1, cx0 - 0.55, gx0 + 0.1, hw - 0.55]) panel('back', D, x, x + 0.45, 0.6, JZ2 - 0.35, S.trim, K.SOLID, 0.04);
      if (mans) for (const x of [-hw + 0.1, cx0 - 0.55]) panel('front', 1.2, x, x + 0.45, 0.6, JZ2 - 0.35, S.trim, K.SOLID, 0.04);
    }
    plate = [left, mid, right];
  } else if (type === 'gh') {
    // Garden Hall: a deeper house; the double-height hall looks down the garden
    const my = 4.2, mx1 = hw - 4.4, ex1 = gx0, ex0 = gx0 - Math.min(3.4, (gx0 + hw) * 0.36);
    const main = block(-hw, mx1, my, D, 0, JZ2 + 0.4, 'main'); course(main);
    block(mx1, hw, gd, D - 5, 0, 3.5, 'wing');
    entrance(ex0, ex1, 2.4, my);
    fronts(-hw, ex0, my, false);
    rear(-hw, mx1, D, true);
    flank('left', -hw, my, D);
    if (!lite) row('right', mx1, D - 4.4, D - 0.6, 1, 1.4, 4.5, 6.3, 0, 1);
    plate = [main];
  } else {
    // Entertainment Foyer: the garage and the entrance bay side by side on the street, the main block behind
    const my = 3.2, ex1 = gx0, ex0 = gx0 - Math.min(3.8, (gx0 + hw) * 0.34);
    const main = block(-hw, gx0, my, D, 0, JZ2, 'main'); course(main);
    block(gx0, hw - 0.6, gd, D - 3.4, 0, 3.5, 'wing');
    entrance(ex0, ex1, 1.4, my);
    fronts(-hw, ex0, my);
    rear(-hw, gx0, D);
    flank('left', -hw, my, D);
    if (!lite) row('right', gx0, D - 3.0, D - 0.5, 1, 1.3, 4.5, 6.2, 0, 1);
    plate = [main];
  }
  B.plate = plate; B.plateBase = 0; B.plateTop = JZ2;
  return true;
}

// ---------------------------------------------------------------- Jumeirah Islands: townhouses, Pavilion, clubhouse
// a pergola along one wall of a CCW outline: posts, two beams and slats, optionally over a timber deck
function pergolaAlong(T, o, ring, i, depth, z, color, deck = null) {
  const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 6) return;
  const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [d[1], -d[0]];
  const W = (s, t) => [a[0] + d[0] * s + n[0] * t, a[1] + d[1] * s + n[1] * t];
  const rect = (s0, s1, t0, t1) => [W(s0, t0), W(s1, t0), W(s1, t1), W(s0, t1)];
  if (deck) T.prism(rect(0.4, L - 0.4, 0, depth + 0.7), 0, 0.16, o, T.codes.SLATH, deck);
  const np = Math.max(1, Math.round((L - 1) / 4.2));
  for (let k = 0; k <= np; k++) { const s = 0.5 + ((L - 1) * k) / np; T.prism(rect(s - 0.1, s + 0.1, depth - 0.2, depth), 0, z, o, T.codes.SOLID, color); }
  T.prism(rect(0.3, L - 0.3, depth - 0.22, depth + 0.02), z, z + 0.22, o, T.codes.SOLID, color);
  T.prism(rect(0.3, L - 0.3, 0.02, 0.2), z, z + 0.22, o, T.codes.SOLID, color);
  for (let s = 0.6; s < L - 0.5; s += 0.6) T.prism(rect(s - 0.045, s + 0.045, 0.02, depth + 0.35), z + 0.22, z + 0.34, o, T.codes.SOLID, color);
}
// The townhouses (84 four-bedroom houses in terraces, 2016-2017; OSM maps eight rows). From the listing and the
// street photographs: flat-roofed terraces in warm sand to salmon render; the first floor oversails an open double
// carport (6.2 x 5.35 m, sourced) beside a service bay; a first-floor terrace on the street side and a balcony to
// the garden, both behind glass balustrades, with dark timber pergolas over some; a roof level of stair heads with
// louvred panels, so the rows read as three storeys with a stepped skyline; small walled yards behind. A row is
// cut into houses about 8 m wide (estimate from the carport width and the 216 m2 plots); storey heights are
// estimates.
const JTH = { walls: ['#e3c497', '#dcb58c', '#d8ab86', '#e0bd92'], dark: '#3a2f28', wood: '#5a3a2a', glass: '#4a6068', deck: '#d8d2c4', door: '#6b4630', cream: '#efe2c4' };
function jiRow(T, B) {
  const ring = T.ccw(B.outer[0]);
  const F = frame2D(ring, B.b.hf, { long: true }); if (!F) return false;
  const K = T.codes, lite = T.lite, W = F.W, D = F.D, hw = W / 2;
  const wall = C(JTH.walls[B.i % 4]), wall2 = wall.clone().multiplyScalar(0.93), dark = C(JTH.dark), wood = C(JTH.wood), glass = C(JTH.glass), deck = C(JTH.deck);
  const H = houseKit(T, B, F, { fh: 3.3, wall });
  const n = Math.max(1, Math.round(W / 8)), u = W / n, Z1 = 3.3, Z2 = 6.6, Z3 = 9.3, CP = Math.min(5.4, D * 0.36), cw = Math.min(6.2, u - 1.0);
  const wo = { frame: dark, glass, mullions: 2 };
  // the row: ground floor behind the carports, the first floor oversailing them, the terrace slab over the carports
  H.box(-hw, CP, hw, D, 0, Z1, { color: wall });
  H.box(-hw, 0.2, hw, CP, Z1 - 0.3, Z1, { color: wall2 });
  H.box(-hw, 2.6, hw, D - 1.6, Z1, Z2, { color: wall, top: 'parapet', roof: deck, par: 0.9, parColor: wall });
  for (let k = 0; k < n; k++) {
    const x0 = -hw + k * u, x1 = x0 + u, bx0 = x0 + 0.3 + cw;
    // carport: a party fin, the open bays, the service bay with its cupboards
    H.box(x0, 0.2, x0 + 0.3, CP, 0, Z1 - 0.3, { color: wall });
    H.box(bx0, 0.7, x1, CP, 0, Z1 - 0.3, { color: wall });
    // the roof level: a stair head with louvred panels
    const sx0 = x0 + 0.5, sx1 = x0 + Math.max(3.2, u * 0.52), sy0 = 2.6 + (D - 4.2) * 0.22, sy1 = 2.6 + (D - 4.2) * 0.6;
    H.box(sx0, sy0, sx1, sy1, Z2, Z3 - (k % 3 === 1 ? 0.7 : 0), { color: wall });
    if (lite) continue;
    H.panel('front', 0.7, bx0 + 0.15, x1 - 0.15, 0.15, 2.3, C(JTH.cream), K.SOLID, 0.04);
    H.panel('front', CP, bx0 - 1.7, bx0 - 0.5, 0, 2.3, C(JTH.door), K.SLATV, 0.05);
    // the street terrace: a solid upstand and a glass balustrade, the neighbour's screen wall, sliding doors behind
    H.box(x0, 0.2, x0 + u * 0.42, 0.45, Z1, Z1 + 1.0, { color: wall });
    H.box(x0 + u * 0.42, 0.26, x1, 0.32, Z1, Z1 + 1.0, { color: glass, code: K.GLASSY });
    H.box(x0 - 0.12, 0.2, x0 + 0.12, 2.6, Z1, Z1 + 1.6, { color: wall });
    H.window('front', 2.6, x0 + 1.0, x1 - 1.0, Z1 + 0.15, Z1 + 2.5, wo);
    if ((k + B.i) % 2 === 0) H.pergola(x0 + 0.7, 0.55, x1 - 0.7, 2.45, Z1 + 2.85, wood, 8);
    // the garden side: glazed doors, the balcony behind glass, a walled yard
    H.window('back', D, x0 + 0.9, x1 - 0.9, 0.15, 2.6, wo);
    H.window('back', D - 1.6, x0 + 0.9, x1 - 0.9, Z1 + 0.15, Z1 + 2.5, wo);
    H.box(x0 + 0.12, D - 0.1, x1 - 0.12, D - 0.04, Z1, Z1 + 1.0, { color: glass, code: K.GLASSY });
    H.box(x0 - 0.12, D - 1.6, x0 + 0.12, D, Z1, Z1 + 1.6, { color: wall });
    H.box(x0 - 0.1, D, x0 + 0.1, D + 6.4, 0, 1.9, { color: wall2 });
    H.panel('front', sy0, sx0 + 0.35, sx1 - 0.35, Z3 - 1.5, Z3 - 0.9, wood, K.SLATH, 0.05);
    H.panel('back', sy1, sx0 + 0.35, sx1 - 0.35, Z3 - 1.5, Z3 - 0.9, wood, K.SLATH, 0.05);
  }
  H.box(hw - 0.3, 0.2, hw, CP, 0, Z1 - 0.3, { color: wall });
  if (!lite) {
    H.box(hw - 0.1, D, hw + 0.1, D + 6.4, 0, 1.9, { color: wall2 });
    H.box(-hw - 0.1, D + 6.2, hw + 0.1, D + 6.4, 0, 1.9, { color: wall2 });
    for (const [face, at] of [['left', -hw], ['right', hw]]) {
      H.window(face, at, CP + 1.2, CP + 2.6, 1.0, 2.4, { frame: dark, glass });
      H.window(face, at, 4.2, 5.8, Z1 + 1.0, Z1 + 2.4, { frame: dark, glass });
      H.window(face, at, D - 5.2, D - 3.6, Z1 + 1.0, Z1 + 2.4, { frame: dark, glass });
    }
  }
  B.plate = [T.ccw([F.P(-hw, 2.6), F.P(hw, 2.6), F.P(hw, D - 1.6), F.P(-hw, D - 1.6)])]; B.plateBase = 0; B.plateTop = Z2;
  return true;
}
// The Pavilion (opened 2017): separate flat-roofed blocks in smooth cream render round a lakeside lawn, on their OSM
// outlines; the larger blocks are two storeys with band windows upstairs and a stepped parapet on the road side, the
// others single-storey retail rows; the shopfronts toward the lawn stand under a continuous red-brown pergola
// colonnade (photographs). Which block is which is not mapped: the storeys follow the footprint (estimate).
function jiPav(T, B) {
  const ring = T.ccw(B.outer[0]), K = T.codes, lite = T.lite;
  const two = B.area > 550, H0 = two ? 8.6 : B.area > 330 ? 5.4 : 4.8;
  const S = { wall: C('#f1e9da'), trim: C('#f9f5ec'), wood: C('#8e432f'), frame: C('#f6f4ee'), glass: C('#3f5661'), deck: C('#dcd6c8') };
  const o = { ...B.o, base: 0, top: H0, fh: two ? 4.3 : H0, center: T.centroid(ring), wall: S.wall };
  T.walls(ring, 0, H0, o, K.SOLID, { color: S.wall });
  const inner = T.parapetRoof(ring, H0, 0.9, o, K.ROOF + T.L.roofConcrete, S.deck, S.wall);
  B.plate = [ring]; B.plateBase = 0; B.plateTop = H0;
  if (lite) return true;
  ringBand(T, o, ring, H0 + 0.6, H0 + 0.92, S.trim, K.SOLID, 0.05);
  ringWindows(T, o, ring, 0.25, 3.1, 6.0, 3.8, S.frame, S.glass);
  if (two) { ringBand(T, o, ring, 4.15, 4.4, S.trim, K.SOLID, 0.05); ringWindows(T, o, ring, 5.2, 7.2, 7.0, 4.4, S.frame, S.glass); }
  if (inner) T.scatterEquipment(inner, H0, B.i, two ? 4 : 2, B.r);
  const ob = T.orientedBox(ring);
  const back = B.b.hf != null ? [-Math.cos(B.b.hf), -Math.sin(B.b.hf)] : ob ? ob.v : [0, 1];
  pergolaAlong(T, o, ring, facingEdge(ring, back), 3.6, 3.35, S.wood);
  if (two) {
    // the stepped parapet over the road front
    const i = facingEdge(ring, [-back[0], -back[1]]), a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L > 10) {
      const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [d[1], -d[0]], W = (s, t) => [a[0] + d[0] * s + n[0] * t, a[1] + d[1] * s + n[1] * t];
      T.prism([W(L * 0.3, -0.38), W(L * 0.7, -0.38), W(L * 0.7, 0), W(L * 0.3, 0)], H0 + 0.9, H0 + 1.9, o, K.SOLID, S.wall);
    }
  }
  return true;
}
// The clubhouse (renovated 2021) and the two buildings beside it, on their OSM outlines: white-cream walls under
// terracotta-tiled hips (photographs), the main building two storeys (restaurant by the pool, a bar with a balcony
// above: sourced), a timber deck under a white pergola on the side away from the road. Heights are estimates.
function jiClub(T, B) {
  const ring = T.ccw(B.outer[0]), K = T.codes, lite = T.lite;
  const two = B.area > 400, z1 = two ? 4.2 : 3.9, z2 = two ? 7.8 : z1;
  const S = { wall: C('#f4eddd'), trim: C('#fbf8f0'), roof: C('#c0714c'), frame: C('#f6f4ec'), glass: C('#4d7f79'), deck: C('#9a6b47'), white: C('#f5f3ee') };
  const o = { ...B.o, base: 0, top: z2, fh: z1, center: T.centroid(ring), wall: S.wall };
  let wings = rectCover(ring).filter((w) => w.len * w.wid > 24);
  if (!wings.length) { const ob = T.orientedBox(ring); if (!ob) return false; wings = [{ c: ob.c, u: ob.u, v: ob.v, len: ob.len, wid: ob.wid }]; }
  T.walls(ring, 0, z1, o, K.SOLID, { color: S.wall });
  T.cap([ring], z1, o, K.ROOF + T.L.roofConcrete, C('#ddd6c6'));
  for (const w of wings) {
    const r = wingRing(T, w);
    if (two) { T.walls(r, z1, z2, { ...o, base: z1 }, K.SOLID, { color: S.wall }); T.cap([r], z2, o, K.SOLID, S.wall); }
    T.hipRoof({ c: w.c, u: w.u, v: w.v, len: w.len, wid: w.wid }, z2, { ...o, wall: S.trim, roofLayer: T.L.roofTiles }, S.roof, 0.7, 0.38);
  }
  B.plate = [ring]; B.plateBase = 0; B.plateTop = z1;
  if (lite) return true;
  ringBand(T, o, ring, z1 - 0.3, z1, S.trim, K.SOLID, 0.1);
  ringWindows(T, o, ring, 0.3, z1 - 1.0, 3.8, 2.2, S.frame, S.glass, S.trim);
  if (two) for (const w of wings) ringWindows(T, o, wingRing(T, w), z1 + 0.7, z2 - 0.8, 3.8, 1.6, S.frame, S.glass, S.trim);
  if (two && B.b.hf != null) pergolaAlong(T, o, ring, facingEdge(ring, [-Math.cos(B.b.hf), -Math.sin(B.b.hf)]), 4.6, 3.2, S.white, S.deck);
  return true;
}

// house kits by id
// ---------------------------------------------------------------- mosques
// Every mosque (OSM building=mosque, or a place of worship tagged muslim) is built as one, on its own outline:
// a stone prayer hall under a crenellated parapet with a band of screened windows, a main dome on a drum over the
// hall (toward the qibla wall), smaller domes beside it on the larger mosques, a tall portal on the entrance side
// and one or two tiered minarets with balconies at the entrance corners. Sizes follow the footprint; the palette
// (cream, sand or white stone; a pale, turquoise or golden dome) is picked per building. Illustrative: OSM gives
// the outline, not the design of each mosque.
const MOSQUE_PAL = [
  { wall: '#efe4cc', trim: '#f8f2e4', dome: '#f4eee0', accent: '#c9a45a' },
  { wall: '#e6d2ad', trim: '#f3e8cf', dome: '#eadfc6', accent: '#b98a4a' },
  { wall: '#f4f1ea', trim: '#ffffff', dome: '#f7f5ef', accent: '#c9a45a' },
  { wall: '#e9dcc0', trim: '#f6eedc', dome: '#3f9c98', accent: '#d9b25a' },
  { wall: '#f0e6d2', trim: '#faf5ea', dome: '#d2b060', accent: '#d2b060' },
  { wall: '#eadfc8', trim: '#f7f1e2', dome: '#f1ead9', accent: '#c9a45a' },
];
const QIBLA = [-0.98, -0.2]; // from Dubai, Mecca lies a little south of due west (x east, y north)
function minaret(T, o, c, Hm, r0, yb, S, lite) {
  const K = T.codes.STONE, segs = lite ? 6 : 8;
  T.cone(c, r0 * 1.3, r0 * 1.3, 0, yb, o, S.wall, K, { segs });                       // base, clear of the parapet
  const yA = Hm * 0.6, yB = Hm * 0.82, yC = Hm * 0.9;
  T.cone(c, r0, r0 * 0.9, yb, yA, o, S.wall, K, { segs });                             // lower shaft
  if (!lite) {
    T.cone(c, r0 * 0.92, r0 * 1.5, yA - 0.9, yA, o, S.trim, T.codes.SOLID, { segs, cap: false }); // corbel under the balcony
    T.cone(c, r0 * 1.5, r0 * 1.5, yA, yA + 0.9, o, S.trim, T.codes.SOLID, { segs });   // balcony rail
  }
  T.cone(c, r0 * 0.72, r0 * 0.66, yA, yB, o, S.wall, K, { segs });                     // upper shaft
  if (!lite) {
    T.cone(c, r0 * 0.7, r0 * 1.15, yB - 0.7, yB, o, S.trim, T.codes.SOLID, { segs, cap: false });
    T.cone(c, r0 * 1.15, r0 * 1.15, yB, yB + 0.8, o, S.trim, T.codes.SOLID, { segs });
  }
  T.cone(c, r0 * 0.5, r0 * 0.48, yB, yC, o, S.trim, K, { segs });                      // lantern
  T.cone(c, r0 * 0.66, 0.05, yC, Hm, o, S.dome, T.codes.SOLID, { segs, cap: false });  // pointed cap
  T.cone(c, 0.12, 0.03, Hm, Hm + 1.5, o, S.accent, T.codes.SOLID, { segs: 5, cap: false });
}
function mosque(T, B) {
  const ring = T.ccw(B.outer[0]), ob = T.orientedBox(ring);
  if (!ob || B.area < 45 || ob.wid < 5) return false;
  const P = MOSQUE_PAL[(B.i * 7 + Math.floor(B.area)) % MOSQUE_PAL.length];
  const S = { wall: C(P.wall), trim: C(P.trim), dome: C(P.dome), accent: C(P.accent) };
  const lite = T.lite, cen = T.centroid(ring);
  const H = Math.min(11, 6.2 + Math.sqrt(B.area) * 0.11);
  const o = { ...B.o, base: 0, top: H, fh: H, center: cen, wall: S.wall };
  T.walls(ring, 0, H, o, T.codes.STONE, { color: S.wall });
  T.parapetRoof(ring, H, 0.9, o, T.codes.ROOF + T.L.roofConcrete, C('#ddd3bf'), S.trim);
  if (!lite) {
    crenels(T, o, ring, H + 0.9, S.trim);
    ringBand(T, o, ring, H * 0.3, H * 0.74, C('#6b5840'), T.codes.SCREEN, 0.05);   // tall windows behind carved screens
    ringBand(T, o, ring, 0, 0.7, S.trim, T.codes.SOLID, 0.06);                      // base course
    ringBand(T, o, ring, H - 0.5, H - 0.15, S.trim, T.codes.SOLID, 0.07);           // string course under the parapet
  }
  // the hall's axes: q toward the qibla wall, e toward the entrance, x across
  const along = Math.abs(ob.u[0] * QIBLA[0] + ob.u[1] * QIBLA[1]) >= Math.abs(ob.v[0] * QIBLA[0] + ob.v[1] * QIBLA[1]);
  let q = along ? ob.u : ob.v, x = along ? ob.v : ob.u; const hq = (along ? ob.len : ob.wid) / 2, hx = (along ? ob.wid : ob.len) / 2;
  if (q[0] * QIBLA[0] + q[1] * QIBLA[1] < 0) q = [-q[0], -q[1]];
  const e = [-q[0], -q[1]];
  const at = (a, b) => [ob.c[0] + q[0] * a + x[0] * b, ob.c[1] + q[1] * a + x[1] * b];
  // main dome on its drum
  const R = Math.min(7.5, Math.max(2.0, Math.min(ob.len, ob.wid) * 0.3));
  let dc = at(hq * 0.18, 0); if (!T.pointInRing(dc, ring)) dc = T.pointInRing(ob.c, ring) ? ob.c : cen;
  const segs = lite ? 12 : 22, drum = R * 0.42;
  T.cone(dc, R * 1.04, R * 1.04, H, H + drum, o, S.trim, T.codes.STONE, { segs, cap: false });
  if (!lite) T.cone(dc, R * 1.1, R * 1.1, H + drum - 0.25, H + drum, o, S.trim, T.codes.SOLID, { segs });
  T.dome(dc, R, R, H + drum, R * 1.08, o, S.dome, T.codes.SOLID, { segs, rings: lite ? 4 : 8 });
  T.cone(dc, 0.2, 0.04, H + drum + R * 1.05, H + drum + R * 1.05 + 1.8, o, S.accent, T.codes.SOLID, { segs: 5, cap: false });
  // smaller domes either side on the larger halls
  if (B.area > 600) {
    const r2 = R * 0.42, offs = B.area > 1500 ? [[hq * 0.18, hx * 0.62], [hq * 0.18, -hx * 0.62], [-hq * 0.45, hx * 0.62], [-hq * 0.45, -hx * 0.62]] : [[hq * 0.18, hx * 0.62], [hq * 0.18, -hx * 0.62]];
    for (const [a, b] of offs) {
      const c2 = at(a, b); if (!T.pointInRing(c2, ring)) continue;
      T.cone(c2, r2 * 1.05, r2 * 1.05, H, H + r2 * 0.4, o, S.trim, T.codes.STONE, { segs: lite ? 8 : 14, cap: false });
      T.dome(c2, r2, r2, H + r2 * 0.4, r2 * 1.05, o, S.dome, T.codes.SOLID, { segs: lite ? 8 : 14, rings: lite ? 3 : 6 });
    }
  }
  // the entrance portal: a taller framed block in the middle of the wall facing away from the qibla
  if (!lite) {
    const i = facingEdge(ring, e), a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L > 7) {
      const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n = [d[1], -d[0]], w = Math.min(7, L * 0.34), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const W = (s, t) => [m[0] + d[0] * s + n[0] * t, m[1] + d[1] * s + n[1] * t];
      T.prism([W(-w / 2, -0.4), W(w / 2, -0.4), W(w / 2, 1.1), W(-w / 2, 1.1)], 0, H + 2.0, o, T.codes.STONE, S.trim);
      const dw = w * 0.42, dh = Math.min(H * 0.78, 6);
      T.quad([...W(-dw / 2, 1.14), 0], [...W(dw / 2, 1.14), 0], [...W(dw / 2, 1.14), dh], [...W(-dw / 2, 1.14), dh], o, C('#4a3a2a'), T.codes.SCREEN, [[0, 0], [dw, 0], [dw, dh], [0, dh]]);
    }
  }
  // minarets at the entrance corners: one on a small mosque, a pair on a larger one
  const Hm = Math.min(46, 20 + Math.sqrt(B.area) * 0.55), r0 = Math.min(1.7, 0.95 + Math.sqrt(B.area) * 0.012);
  const sides = B.area < 480 ? [(B.i % 2) * 2 - 1] : [1, -1];
  for (const sd of sides) {
    let c = at(-hq + r0 * 1.5, sd * (hx - r0 * 1.5));
    if (!T.pointInRing(c, ring)) {
      // an outline that is not a plain box: the outline's own corner nearest that way, drawn in a little
      let best = null, bd = -Infinity;
      for (const p of ring) { const s2 = (p[0] - ob.c[0]) * (e[0] + x[0] * sd * 0.8) + (p[1] - ob.c[1]) * (e[1] + x[1] * sd * 0.8); if (s2 > bd) { bd = s2; best = p; } }
      c = [best[0] + (cen[0] - best[0]) * 0.12, best[1] + (cen[1] - best[1]) * 0.12];
    }
    minaret(T, o, c, Hm, r0, H + 1.6, S, lite);
  }
  B.plate = [ring]; B.plateBase = 0; B.plateTop = H;
  return true;
}

export const HOUSE_KITS = { sidra, maple, 'club-villas': pairs, 'golf-grove': pairs, 'golf-place': golfPlace, luxury, mansion, custom, eh, mosque, ji, 'ji-th': jiRow, 'ji-pav': jiPav, 'ji-club': jiClub };
