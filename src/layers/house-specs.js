// Plan data for the researched house types, shared by the data build (plots, driveways, cars in carports, pools)
// and the renderer (layers/houses.js), so both place everything from the same drawings.
// Plan coordinates follow the developer's floor plans: x across the plot from the side-garden edge to the carport
// side, y from the street boundary into the plot, in metres. Sources: data-raw/research/dubai-hills/<community>/.

// Sidra 1-3 (Emaar, 2019-2020): plot, the two-storey block (which is what OSM traces), the open 2-car carport at the
// street corner and the optional pool along the rear boundary, as drawn on the Sidra 3 brochure plans.
export const SIDRA = {
  E1: { beds: 3, bua: 3102, plot: [15.0, 27.0], block: [3.0, 11.8, 3.0, 20.0], carport: [8.0, 14.9, 0, 6.8], pool: [3.0, 11.5, 23.5, 26.0] },
  E3: { beds: 4, bua: 3523, plot: [15.8, 26.4], block: [3.0, 12.5, 3.0, 20.0], carport: [9.2, 15.7, 0, 7.0], pool: [2.3, 10.2, 22.5, 25.3] },
  E5: { beds: 5, bua: 4283, plot: [21.0, 28.8], block: [3.0, 18.0, 3.0, 21.5], carport: [14.4, 21.0, 0, 7.3], pool: [3.0, 12.6, 24.5, 27.5] },
};
// pick the type from the footprint's street frontage (E1 block 8.8 m, E3 9.5 m, E5 14.5 m wide). E2 and E4 (Sidra 1
// only, rare) are drawn as their nearest neighbour, E3 and E5.
export const sidraType = (W) => (W < 9.75 ? 'E1' : W < 12.2 ? 'E3' : 'E5');

// minimum-area oriented box of a ring (u = the longer side)
export function obb(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.3) continue;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], v = [-u[1], u[0]];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) { const pu = p[0] * u[0] + p[1] * u[1], pv = p[0] * v[0] + p[1] * v[1]; u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv); }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, u, v, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { u, v, u0, u1, v0, v1 } = best;
  if (v1 - v0 > u1 - u0) { const nu = v, nv = [-u[0], -u[1]], a0 = v0, a1 = v1; v0 = -u1; v1 = -u0; u0 = a0; u1 = a1; u = nu; v = nv; }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { c: [u[0] * cu + v[0] * cv, u[1] * cu + v[1] * cv], u, v, len: u1 - u0, wid: v1 - v0 };
}

// the street-facing frame of a footprint: front = the box side closest to the direction of the street (angle hf);
// x runs to the right seen from the street, y from the front face to the back, origin at the middle of the front face.
// short: the house always fronts its street with a short side (Sidra), even on a corner plot; long: with a long side
// (townhouse rows such as Maple)
export function frame2D(ring, hf, { short = false, long = false } = {}) {
  const ob = obb(ring); if (!ob) return null;
  const f = hf != null ? [Math.cos(hf), Math.sin(hf)] : [-ob.v[0], -ob.v[1]];
  const axes = short ? [ob.u, [-ob.u[0], -ob.u[1]]] : long ? [ob.v, [-ob.v[0], -ob.v[1]]] : [ob.u, [-ob.u[0], -ob.u[1]], ob.v, [-ob.v[0], -ob.v[1]]];
  const front = axes.reduce((m, a) => (a[0] * f[0] + a[1] * f[1] > m[0] * f[0] + m[1] * f[1] ? a : m), axes[0]);
  const yv = [-front[0], -front[1]], xv = [yv[1], -yv[0]];
  const deep = Math.abs(front[0] * ob.u[0] + front[1] * ob.u[1]) > 0.5;
  const W = deep ? ob.wid : ob.len, D = deep ? ob.len : ob.wid;
  const o0 = [ob.c[0] - (yv[0] * D) / 2, ob.c[1] - (yv[1] * D) / 2];
  return { ob, xv, yv, W, D, o0, front, P: (x, y) => [o0[0] + xv[0] * x + yv[0] * y, o0[1] + xv[1] * x + yv[1] * y] };
}

// plan -> local frame for one house: the plan's two-storey block is centred on the footprint; m = 1 keeps the carport
// on the right seen from the street, -1 mirrors it
export function planMap(spec, m, D) {
  const [bx0, bx1, by0, by1] = spec.block;
  const bcx = (bx0 + bx1) / 2, bcy = (by0 + by1) / 2;
  return { X: (x) => m * (x - bcx), Y: (y) => y - bcy + D / 2 };
}

// Maple 1-3 (Emaar townhouses, 2018-2020): OSM traces each cluster body, either a row of four (end, middle, middle,
// end) or a pair of end units. Unit plans (Maple 1/2 brochure, Type 2 and Type 3): x across the unit's plot from its
// outer edge (end units: the side-garden edge; middle units: the party wall with the end unit) towards the cluster
// centre; y from the rear garden boundary towards the street. Carports are 6 m wide and stand in front of the body.
export const MAPLE = {
  '2E': { w: 11.0, body: [3.0, 11.0], carport: [5.0, 11.0], beds: 4, area: 2462 },
  '2M': { w: 7.95, body: [0, 7.95], carport: [0, 6.0], beds: 3, area: 2228 },
  '3E': { w: 11.3, body: [3.0, 11.3], carport: [5.0, 11.2], beds: 5, area: 2700 },
  '3M': { w: 8.3, body: [0, 8.3], carport: [0, 6.0], beds: 4, area: 2387 },
  carportY: [17.2, 23.1], bodyMidY: 11.25,
};
// the cluster a footprint holds: four units on a row body longer than 24 m, else a pair; Type 3 rows are longer
export function mapleCluster(L) {
  const four = L > 24, type = four ? (L > 32.6 ? 3 : 2) : (L > 16.4 ? 3 : 2);
  const E = MAPLE[type + 'E'], M = MAPLE[type + 'M'];
  const units = four
    ? [{ t: type + 'E', X0: 0, mirror: false }, { t: type + 'M', X0: E.w, mirror: false }, { t: type + 'M', X0: E.w + M.w, mirror: true }, { t: type + 'E', X0: E.w + 2 * M.w, mirror: true }]
    : [{ t: type + 'E', X0: 0, mirror: false }, { t: type + 'E', X0: E.w, mirror: true }];
  const total = four ? 2 * (E.w + M.w) : 2 * E.w;
  const sx = Math.max(0.93, Math.min(1.07, L / (total - 2 * E.body[0])));
  return { type, units, total, Xc: total / 2, sx };
}
// unit plan coordinates -> the cluster footprint's local frame
export const mapleX = (cl, u, x) => cl.sx * ((u.mirror ? u.X0 + MAPLE[u.t].w - x : u.X0 + x) - cl.Xc);
export const mapleY = (D, y) => D / 2 + MAPLE.bodyMidY - y;

// Club Villas and Golf Grove (Emaar, 2020-2022): semi-detached pairs on the TH01/TH02 plans (mirror units sharing a
// party wall), 3 or 4 bedrooms. Pair plan: x across both plots (22.6 m) from the left plot edge, the party wall at
// 11.3; y from the street boundary into the plot. Each unit's body is 8.3 m wide beside a 3 m side yard; the two open
// carports sit side by side at the party wall under one canopy; the first floor overhangs the back of the carports.
export const PAIRS = {
  3: { carports: [[5.3, 11.3], [11.3, 17.3]], carY: [0, 6.4], gf: [6.4, 18.3], ff: [3.8, 19.2], terrace: [12.8, 19.2], stair: 'outer' },
  4: { carports: [[5.3, 11.3], [11.3, 17.3]], carY: [0, 6.0], gf: [6.0, 21.5], ff: [3.8, 20.4], terrace: [11.7, 20.4], stair: 'party' },
};
// a pair (or one of the few standalone villas), 3 or 4 bedrooms from the depth of the first floor OSM traces
export function pairLayout(W, D) {
  const single = W < 12.5, beds = D > 16.0 ? 4 : 3, S = PAIRS[beds];
  const xc = single ? 7.15 : 11.3, yc = (S.ff[0] + S.ff[1]) / 2;
  return { single, beds, S, X: (x) => x - xc, Y: (y) => y - yc + D / 2 };
}

// Golf Place (Emaar, architect Dewan, 2021-2024): large detached villas built as two wings joined by a double-height
// glazed entrance link, the 2-car garage at the front of one wing. Local frame of the footprint (x across, y from the
// front): wing and link widths as fractions of the frontage (D1: 5.9 + 2.8 + 6.4 m), the garage side mirrored per
// plot (m = -1: garage on the left).
export function golfPlaceLayout(W, D, m) {
  const wl = W * 0.4, wk = W * 0.17, wr = W - wl - wk;
  const xL0 = -W / 2, xL1 = xL0 + wl, xR0 = xL1 + wk, xR1 = W / 2;
  const S = (x) => m * x;
  const gw = Math.min(6.4, wr - 0.6), g0 = xR0 + (wr - gw) / 2, g1 = g0 + gw;
  return { wl, wk, wr, xL0, xL1, xR0, xR1, S, garage: [S(g0), S(g1)], garageY: [0, 6.0], beds: W > 20.5 ? 6 : W > 17.5 ? 5 : 4 };
}

// Fairway Vistas and Parkway Vistas (Emaar, 2019-2021): the brochure plans, measured on the floor-plan images (scale
// from the 6.0 m garage, so about +/-0.5 m). Plan x runs across the house from its left side seen from the street,
// y from the front-most element (the garage or carport) to the back of the first-floor terraces. Boxes are
// [x0, x1, y0, y1]. gf: ground-floor rooms (4 m); ff: first-floor rooms (to the roof); slab: first-floor plates
// including their terraces; hall: the entrance hall where no other room covers it; tall: the entrance glazing rises
// through both floors; court: the entrance court in front of the door (planted, open to the sky unless a first-floor
// wing overhangs it); park: the garage, carport or open parking; pool: as drawn on the garden plan.
export const LUX = {
  // 7 bed: rear living band, front garage (left), entrance court and hall (centre), office and guest room (right);
  // a near-square first floor with a notch over the court
  B1: {
    W: 21.2, D: 23.5, ffY0: 2.4, park: [0, 6.2, 0, 6.2], parkKind: 'carport', door: [8.3, 9.5],
    gf: [[0.4, 6.2, 6.2, 15.7], [0.4, 19.2, 15.7, 22.3], [11.6, 20.6, 6.3, 15.7]],
    hall: [6.2, 11.6, 10.0, 15.7], tall: true, court: [6.2, 11.6, 2.4, 10.0],
    ff: [[0.2, 6.2, 2.4, 22.0], [6.2, 11.6, 10.0, 20.1], [11.6, 21.0, 4.5, 22.0]],
    slab: [[0, 6.2, 2.4, 23.5], [6.2, 11.6, 10.0, 23.5], [11.6, 21.2, 2.4, 23.5]],
    oneRoof: true, pool: [5.6, 20.0, 28.2, 31.8],
  },
  // 6 bed: L ground floor with the family wing out at the rear right and the garage at the front right; two
  // staggered first-floor wings (the right one longer at both ends) joined by a central family room
  B2: {
    W: 19.9, D: 27.6, ffY0: 3.2, park: [13.9, 19.9, 0, 6.4], parkKind: 'carport', door: [10.6, 11.8],
    gf: [[0.9, 6.7, 6.0, 21.1], [6.7, 13.9, 9.1, 21.1], [0, 0.9, 15.5, 21.1], [13.9, 19.2, 6.4, 14.5], [13.6, 19.2, 14.5, 25.7]],
    tall: true, court: [6.7, 13.9, 5.4, 9.1],
    ff: [[0.5, 9.7, 5.2, 21.6], [9.7, 13.9, 9.1, 19.8], [13.9, 19.6, 5.4, 25.7]],
    slab: [[0.5, 9.7, 4.2, 23.3], [9.7, 13.9, 9.1, 21.0], [13.9, 19.6, 3.2, 27.6]],
    pool: [0.4, 13.6, 29.4, 33.0],
  },
  // Parkway only, 7 bed: U ground floor round a covered rear terrace, H first floor, open parking at the front left,
  // the long pool running out from the middle of the rear facade
  B3: {
    W: 21.3, D: 29.7, ffY0: 5.3, park: [0, 5.5, 0, 6.4], parkKind: 'open', door: [8.9, 10.1],
    gf: [[0, 7.3, 6.5, 15.1], [0, 5.5, 15.1, 26.8], [7.3, 11.8, 8.9, 13.2], [5.5, 11.8, 13.2, 20.8], [11.8, 21.3, 7.2, 23.0]],
    court: [5.5, 11.8, 5.5, 8.9],
    ff: [[0, 5.5, 6.7, 28.2], [5.5, 11.8, 13.2, 22.5], [11.8, 21.3, 7.9, 26.3]],
    slab: [[0, 5.5, 5.3, 29.7], [5.5, 11.8, 13.2, 25.8], [11.8, 21.3, 6.7, 26.3]],
    pool: [8.1, 11.9, 24.4, 38.8],
  },
  // Parkway only, 7 bed, the largest: U ground floor with two long wings and a central bar, H first floor, a
  // single-storey covered carpark out in front at the right, the long pool in the court between the wings
  B4: {
    W: 22.5, D: 32.5, ffY0: 5.75, park: [15.0, 21.0, 0, 7.5], parkKind: 'carport', door: [8.4, 9.6],
    gf: [[0, 6.75, 8.25, 29.75], [15.0, 22.5, 7.75, 30.75], [6.75, 15.0, 13.0, 21.5]],
    court: [6.75, 15.0, 7.5, 13.0],
    ff: [[0, 6.75, 6.75, 27.5], [6.75, 15.0, 11.5, 19.5], [15.0, 22.5, 5.75, 30.75]],
    slab: [[0, 6.75, 6.75, 29.0], [6.75, 15.0, 11.5, 25.25], [15.0, 22.5, 5.75, 32.5]],
    pool: [7.25, 10.75, 26.0, 40.5],
  },
};
// which plan a footprint holds. No plot-by-plot type schedule was published, so the type comes from the footprint:
// B4 is the widest, B2 the deepest; Parkway's square footprints are B1 or B3 (assigned by hash)
export function luxuryType(W, D, parkway, h = 0) {
  if (parkway && (W > 22.6 || D > 30.5)) return 'B4';
  if (D / W > 1.2 && D > 24) return 'B2';
  return parkway && h % 2 ? 'B3' : 'B1';
}
// plan -> the footprint's local frame. OSM traces some villas with the garage and some only by their first-floor
// roof, so the plan's depth is fitted to whichever is nearer and the backs are aligned (the garage may stand forward
// of the footprint). m = -1 mirrors the plan (the garage on the other side).
export function luxuryLayout(W, D, t, m = 1) {
  const S = LUX[t] || LUX.B1, cl = (v) => Math.max(0.9, Math.min(1.1, v));
  const ffD = S.D - S.ffY0, full = Math.abs(D - S.D) < Math.abs(D - ffD);
  const sx = cl(W / S.W), sy = cl(D / (full ? S.D : ffD));
  return { S, sx, sy, X: (x) => m * (x - S.W / 2) * sx, Y: (y) => D - (S.D - y) * sy };
}

// The wings of an irregular outline (Emirates Hills mansions): the largest rectangles that fit inside it, aligned
// with its oriented box, taken greedily until they cover most of it. Each wing can then carry its own hipped roof,
// floor or cantilever, so compound roofs and stepped massing follow the house's true shape. Returns
// [{ c: [x, y], u: [ux, uy], v: [vx, vy], len, wid }] (u along the longer side), largest first.
export function rectCover(ring, { res = 0.75, maxRects = 5, minArea = 30, stopFrac = 0.12 } = {}) {
  const ob = obb(ring); if (!ob) return [];
  const { u, v, c } = ob;
  const loc = ring.map((p) => [(p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1], (p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1]]);
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const p of loc) { s0 = Math.min(s0, p[0]); s1 = Math.max(s1, p[0]); t0 = Math.min(t0, p[1]); t1 = Math.max(t1, p[1]); }
  const NX = Math.max(1, Math.round((s1 - s0) / res)), NY = Math.max(1, Math.round((t1 - t0) / res));
  const rx = (s1 - s0) / NX, ry = (t1 - t0) / NY;
  const inside = (x, y) => { let k = false; for (let i = 0, j = loc.length - 1; i < loc.length; j = i++) { const a = loc[i], b = loc[j]; if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) k = !k; } return k; };
  const F = new Uint8Array(NX * NY); let total = 0;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) if (inside(s0 + (i + 0.5) * rx, t0 + (j + 0.5) * ry)) { F[j * NX + i] = 1; total++; }
  const out = [];
  let left = total;
  const hgt = new Int32Array(NX);
  while (out.length < maxRects && left > total * stopFrac) {
    // largest all-filled rectangle (histogram method)
    let best = null; hgt.fill(0);
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) hgt[i] = F[j * NX + i] ? hgt[i] + 1 : 0;
      const st = [];
      for (let i = 0; i <= NX; i++) {
        const h = i < NX ? hgt[i] : 0;
        let start = i;
        while (st.length && st[st.length - 1][1] >= h) {
          const [si, sh] = st.pop(); const a = sh * (i - si);
          if (!best || a > best.a) best = { a, i0: si, i1: i - 1, j1: j, j0: j - sh + 1 };
          start = si;
        }
        st.push([start, h]);
      }
    }
    if (!best || best.a * rx * ry < minArea) break;
    for (let j = best.j0; j <= best.j1; j++) for (let i = best.i0; i <= best.i1; i++) { F[j * NX + i] = 0; left--; }
    // grow back half a cell so neighbouring wings meet without a gap
    const a0 = s0 + best.i0 * rx - rx * 0.5, a1 = s0 + (best.i1 + 1) * rx + rx * 0.5, b0 = t0 + best.j0 * ry - ry * 0.5, b1 = t0 + (best.j1 + 1) * ry + ry * 0.5;
    const cs = Math.max(s0, a0), ce = Math.min(s1, a1), ts = Math.max(t0, b0), te = Math.min(t1, b1);
    const ms = (cs + ce) / 2, mt = (ts + te) / 2, L = ce - cs, Wd = te - ts;
    const cx = c[0] + u[0] * ms + v[0] * mt, cy = c[1] + u[1] * ms + v[1] * mt;
    out.push(L >= Wd ? { c: [cx, cy], u, v, len: L, wid: Wd } : { c: [cx, cy], u: v, v: [-u[0], -u[1]], len: Wd, wid: L });
  }
  return out;
}
