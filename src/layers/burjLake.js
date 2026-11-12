// The Burj Lake waterfront in front of The Dubai Mall, in close-up detail: the mall's lake front (bays of sand-coloured
// precast with large display screens, a one-storey podium of restaurants whose roof is a second tier of terraces, and
// the terraces at promenade level under square parasols), the Souk Al Bahar bridge (stone deck on low arches, lattice
// balustrades, four square towers and a timber pergola), the railing, lantern pylons and stone benches along the
// water, the joints of the granite paving, and the names of the outlets round the lake.
//
// Where things stand comes from OpenStreetMap vector data prepared by scripts/build-data.mjs (`burjLake` in
// world.json): the mall outline's lake-facing stretches, the bridge outline, the lake edge, and the outlets' names and
// positions as mapped. What they look like follows the reference photographs in data-raw/research/malls/dubai-mall
// (reference only; nothing is traced or measured from them). Sizes are estimates: no measured drawings are published.
// Outlet names are shown in plain lettering, not as logos; OSM may lag behind openings and closures.
import * as THREE from 'three';

const TD = (gap) => { const d = Math.min(7, (gap - 13) / 2); return d < 3.5 ? 0 : d; }; // terrace depth: the same rule as build-data
const C = (h) => new THREE.Color(h);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const inRing = (q, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

// triangle soup in plan coordinates (x east, y north, z up), written out in world axes (x, z, -y)
class Geo {
  constructor() { this.p = []; this.c = []; this.uv = []; }
  v(pt, col, u = 0, v = 0) { this.p.push(pt[0], pt[2], -pt[1]); this.c.push(col.r, col.g, col.b); this.uv.push(u, v); }
  tri(a, b, c, col) { this.v(a, col); this.v(b, col); this.v(c, col); }
  quad(a, b, c, d, col, uv) {
    if (uv) { this.v(a, col, uv[0], uv[1]); this.v(b, col, uv[2], uv[1]); this.v(c, col, uv[2], uv[3]); this.v(a, col, uv[0], uv[1]); this.v(c, col, uv[2], uv[3]); this.v(d, col, uv[0], uv[3]); } else { this.tri(a, b, c, col); this.tri(a, c, d, col); }
  }
  // a quad with a colour at each corner (soft pools of light)
  quadC(a, b, c, d, ca, cb, cc, cd) { this.v(a, ca); this.v(b, cb); this.v(c, cc); this.v(a, ca); this.v(c, cc); this.v(d, cd); }
  wall(p0, p1, z0, z1, col, uv) { this.quad([p0[0], p0[1], z0], [p1[0], p1[1], z0], [p1[0], p1[1], z1], [p0[0], p0[1], z1], col, uv); }
  box(cx, cy, z0, z1, hx, hy, ang, col, top = col) {
    const c = Math.cos(ang), s = Math.sin(ang), k = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([a, b]) => [cx + a * c - b * s, cy + a * s + b * c]);
    for (let i = 0; i < 4; i++) this.wall(k[i], k[(i + 1) % 4], z0, z1, col);
    this.quad([k[0][0], k[0][1], z1], [k[1][0], k[1][1], z1], [k[2][0], k[2][1], z1], [k[3][0], k[3][1], z1], top);
  }
  pyramid(cx, cy, z0, z1, hx, hy, ang, col) {
    const c = Math.cos(ang), s = Math.sin(ang), k = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([a, b]) => [cx + a * c - b * s, cy + a * s + b * c]);
    for (let i = 0; i < 4; i++) { const a = k[i], b = k[(i + 1) % 4]; this.tri([a[0], a[1], z0], [b[0], b[1], z0], [cx, cy, z1], col); }
  }
  // a round column, drum or cone frustum (n sides)
  cyl(cx, cy, z0, z1, r0, r1, col, n = 10, cap = true) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
      this.quad([cx + ca * r0, cy + sa * r0, z0], [cx + cb * r0, cy + sb * r0, z0], [cx + cb * r1, cy + sb * r1, z1], [cx + ca * r1, cy + sa * r1, z1], col);
      if (cap) this.tri([cx, cy, z1], [cx + ca * r1, cy + sa * r1, z1], [cx + cb * r1, cy + sb * r1, z1], col);
    }
  }
  get count() { return this.p.length / 3; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    return g;
  }
}
// a local frame on a wall: x along it, y out from it
const frame = (p0, dir, nrm) => {
  const pt = (x, y, z = 0) => [p0[0] + dir[0] * x + nrm[0] * y, p0[1] + dir[1] * x + nrm[1] * y, z], ang = Math.atan2(dir[1], dir[0]);
  return {
    pt, ang,
    box: (G, x0, x1, y0, y1, z0, z1, col, top) => { const q = pt((x0 + x1) / 2, (y0 + y1) / 2); G.box(q[0], q[1], z0, z1, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, ang, col, top); },
    // a panel standing parallel to the wall at distance y, seen from outside
    panel: (G, x0, x1, y, z0, z1, col, uv) => G.wall(pt(x0, y), pt(x1, y), z0, z1, col, uv),
    // a pointed arch drawn on a plane parallel to the wall
    arch: (G, xc, hw, y, z0, zs, zt, col) => { G.wall(pt(xc - hw, y), pt(xc + hw, y), z0, zs, col); G.tri(pt(xc - hw, y, zs), pt(xc + hw, y, zs), pt(xc, y, zt), col); },
  };
};

const STONE = C('#e3c9ab'), STONE_L = C('#ecd8bb'), STONE_D = C('#cdb38f'), FRAME = C('#2b2f36'), GLASS = C('#31474f'), DECKS = [C('#a88a6b'), C('#b9aea3'), C('#8f7458')];
const PARASOLS = ['#f4f1ea', '#f4f1ea', '#f4f1ea', '#f1ece0', '#b83a2e', '#2f6b4f', '#1f3a5f', '#e0b23a', '#c96f3b', '#7a2f3a', '#f4f1ea', '#a3c23a'];
const BRONZE = C('#2e2823'), TIMBER = C('#a57848');
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------------------------------------------------------------- the Apple store on the round drum by the bridge
// (reference: the Dezeen photographs in data-raw/research/malls/dubai-mall). A colonnade at promenade level with the
// mall's door behind it; above, a curved terrace about 56 m long behind a glass balustrade, the full-height glass
// front set back behind 18 tall lattice screens (the "solar wings", shown closed) with trees in round planters
// between them; a deep curved canopy over it all, and a band of louvres on the drum above.
function buildApple({ G, F, GL, AP }, c, R, t0, t1) {
  const n = Math.max(8, Math.ceil((t1 - t0) / 0.045)), T = (k) => t0 + ((t1 - t0) * k) / n;
  const P = (r, t) => [c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r];
  const arcWall = (g, r, z0, z1, col) => { for (let k = 0; k < n; k++) g.wall(P(r, T(k)), P(r, T(k + 1)), z0, z1, col); };
  const arcFlat = (g, r0, r1, z, col) => { for (let k = 0; k < n; k++) { const a = P(r0, T(k)), b = P(r1, T(k)), d = P(r0, T(k + 1)), e = P(r1, T(k + 1)); g.quad([a[0], a[1], z], [b[0], b[1], z], [e[0], e[1], z], [d[0], d[1], z], col); } };
  const ends = (g, r0, r1, z0, z1, col) => { for (const t of [t0, t1]) g.wall(P(r0, t), P(r1, t), z0, z1, col); };
  const champ = C('#d8ccb0'), white = C('#efebe1'), gold = C('#b7a16a'), goldD = C('#9c8752');
  const ZT = 7.05, ZC = 18.0, DT = 4.8;
  // promenade level: the glazed entrance wall behind two rows of round columns
  arcWall(GL, R + 0.25, 0.3, 5.5, GLASS); arcWall(G, R + 0.27, 5.5, 6.2, C('#cfc4ab'));
  const nc = Math.max(4, Math.round(((t1 - t0) * (R + 3.6)) / 5.4));
  for (let k = 0; k <= nc; k++) { const t = t0 + ((t1 - t0) * k) / nc, q = P(R + 3.7, t); G.cyl(q[0], q[1], 0, 6.2, 0.44, 0.44, C('#ddd6c8'), 10, false); if (k < nc) { const q2 = P(R + 1.3, t + (t1 - t0) / nc / 2); G.cyl(q2[0], q2[1], 0, 6.2, 0.36, 0.36, C('#d3ccbe'), 8, false); } }
  // the terrace: a thick curved slab, glass balustrade
  arcWall(G, R + DT, 6.2, ZT, champ); arcFlat(G, R, R + DT, ZT, white); arcFlat(G, R, R + DT, 6.2, C('#e7e1d3')); ends(G, R, R + DT, 6.2, ZT, champ);
  arcWall(G, R + DT - 0.12, ZT, ZT + 1.1, C('#cfe2e4'));
  // the glass front, two storeys high, lit from inside
  arcWall(AP, R + 0.3, ZT, ZC, C('#b4c9ce'));
  arcWall(G, R + 0.36, 12.25, 12.6, white);
  for (let k = 0; k <= n; k += 2) { const q = P(R + 0.36, T(k)); G.box(q[0], q[1], ZT, ZC, 0.06, 0.05, T(k), C('#8f8674')); }
  // eighteen lattice screens standing on the terrace
  for (let k = 0; k < 18; k++) {
    const t = t0 + ((t1 - t0) * (k + 0.5)) / 18, q = P(R + 2.5, t), d = [-Math.sin(t), Math.cos(t)], hw = Math.min(1.25, ((t1 - t0) * (R + 2.5)) / 18 / 2 - 0.25);
    const a = [q[0] - d[0] * hw, q[1] - d[1] * hw], b = [q[0] + d[0] * hw, q[1] + d[1] * hw], z0 = ZT, z1 = ZC - 0.35, ang = Math.atan2(d[1], d[0]);
    G.box(a[0], a[1], z0, z1, 0.07, 0.07, ang, gold); G.box(b[0], b[1], z0, z1, 0.07, 0.07, ang, gold); G.box(q[0], q[1], z1, z1 + 0.14, hw + 0.07, 0.07, ang, gold);
    const m = 6, dz = (z1 - z0) / m;
    for (let j = 0; j < m; j++) {
      const za = z0 + j * dz, zb = za + dz;
      F.quad([a[0], a[1], za], [a[0], a[1], za + 0.16], [b[0], b[1], zb], [b[0], b[1], zb - 0.16], goldD);
      F.quad([b[0], b[1], za], [b[0], b[1], za + 0.16], [a[0], a[1], zb], [a[0], a[1], zb - 0.16], goldD);
    }
  }
  // trees in round white planters between the pairs of screens
  for (let k = 1; k < 9; k++) {
    const t = t0 + ((t1 - t0) * k) / 9, q = P(R + 3.4, t), leaf = C('#5f8240');
    G.cyl(q[0], q[1], ZT, ZT + 0.7, 0.72, 0.92, white, 10); G.cyl(q[0], q[1], ZT + 0.7, ZT + 2.5, 0.09, 0.07, C('#6b5a48'), 6, false);
    G.cyl(q[0], q[1], ZT + 2.3, ZT + 3.0, 0.45, 1.2, leaf, 9, false); G.cyl(q[0], q[1], ZT + 3.0, ZT + 3.9, 1.2, 1.25, C('#6c9148'), 9, false); G.cyl(q[0], q[1], ZT + 3.9, ZT + 4.7, 1.25, 0.45, C('#78a052'), 9);
  }
  // the canopy: a deep curved fascia, its soffit glowing at night
  arcWall(G, R + 5.7, ZC, ZC + 1.55, champ); arcFlat(G, R, R + 5.7, ZC + 1.55, C('#cdc4ae')); arcFlat(AP, R + 0.3, R + 5.7, ZC, C('#f1ecdf')); ends(G, R, R + 5.7, ZC, ZC + 1.55, champ);
  // the louvre band on the drum above
  arcWall(G, R + 0.1, 20.7, 25.5, C('#3b4047'));
  for (const z of [20.7, 21.65, 22.6, 23.55, 24.5, 25.3]) { arcWall(G, R + 0.5, z, z + 0.32, STONE_L); arcFlat(G, R + 0.1, R + 0.5, z + 0.32, STONE_L); }
}


// ---------------------------------------------------------------- the Souk Al Bahar bridge
function buildBridge(G, F, GL, LP, GW, ringIn) {
  let ring = ringIn.slice(); if (dist(ring[0], ring[ring.length - 1]) < 0.05) ring.pop();
  let area = 0; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; area += a[0] * b[1] - b[0] * a[1]; }
  if (area < 0) ring.reverse(); // counter-clockwise: inward is to the left
  const A = [13881.5, 12810.5], Bm = [13925.4, 12862.6]; // the middles of the two landings, from the OSM outline
  const Lab = dist(A, Bm), d = [(Bm[0] - A[0]) / Lab, (Bm[1] - A[1]) / Lab], n = [-d[1], d[0]], ang = Math.atan2(d[1], d[0]);
  const S = (p) => (p[0] - A[0]) * d[0] + (p[1] - A[1]) * d[1], V = (p) => (p[0] - A[0]) * n[0] + (p[1] - A[1]) * n[1];
  const at = (s, v, z = 0) => [A[0] + d[0] * s + n[0] * v, A[1] + d[1] * s + n[1] * v, z];
  let s0 = Infinity, s1 = -Infinity; for (const p of ring) { s0 = Math.min(s0, S(p)); s1 = Math.max(s1, S(p)); }
  if (!(s1 - s0 > 30 && s1 - s0 < 120)) return; // not the outline this was written for
  // slightly humped: level with the promenade at the landings, about two metres higher over the water
  const zAt = (s) => { const t = Math.max(0, Math.min(1, (s - s0) / (s1 - s0))); return 0.14 + 2.0 * Math.pow(Math.sin(Math.PI * t), 0.75); };
  const extent = (s) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length], sa = S(a), sb = S(b); if ((sa - s) * (sb - s) > 0 || sa === sb) continue; const v = V(a) + ((V(b) - V(a)) * (s - sa)) / (sb - sa); lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo > 0.5 ? [lo, hi] : null; };
  const stone = C('#e3cdaa'), pale = C('#efe0c4'), sand = C('#dcc6a4'), terra = C('#c08f6c'), terraL = C('#e6d6ba'), blue = C('#7f9aad'), voidC = C('#23343a');
  // the deck: terracotta paving with paler cross bands, a blue border, stone margins
  let prev = null;
  for (let s = s0 + 0.05; s <= s1 - 0.04; s += 0.5) {
    const e = extent(s), cur = e ? { s, lo: e[0], hi: e[1], z: zAt(s) } : null;
    if (prev && cur) {
      const band = (a0, a1, b0, b1, col) => { if (a1 - a0 < 0.02 && b1 - b0 < 0.02) return; G.quad(at(prev.s, a0, prev.z), at(cur.s, b0, cur.z), at(cur.s, b1, cur.z), at(prev.s, a1, prev.z), col); };
      const cl = (v, o) => Math.max(o.lo, Math.min(o.hi, v));
      // sand-coloured stone with a blue border line and, down the middle, panels of terracotta tiles in paler frames
      const m = (((s - s0) % 9.5) + 9.5) % 9.5, rug = m > 1.6 && m < 7.9 ? terra : m > 1.1 && m < 8.4 ? terraL : sand;
      const cuts = [-6.3, -5.9, -4.3, 4.3, 5.9, 6.3], cols = [stone, blue, sand, rug, sand, blue, stone];
      { const w0 = C('#000000'), w1 = C('#ffcf8f'), zz = 0.06, e0 = Math.max(prev.lo, -8.5), e1 = Math.min(prev.hi, 8.5), f0 = Math.max(cur.lo, -8.5), f1 = Math.min(cur.hi, 8.5);
        GW.quadC(at(prev.s, e0, prev.z + zz), at(cur.s, f0, cur.z + zz), at(cur.s, 0, cur.z + zz), at(prev.s, 0, prev.z + zz), w0, w0, w1, w1);
        GW.quadC(at(prev.s, 0, prev.z + zz), at(cur.s, 0, cur.z + zz), at(cur.s, f1, cur.z + zz), at(prev.s, e1, prev.z + zz), w1, w1, w0, w0); }
      for (let k = 0; k <= cuts.length; k++) band(k ? cl(cuts[k - 1], prev) : prev.lo, k < cuts.length ? cl(cuts[k], prev) : prev.hi, k ? cl(cuts[k - 1], cur) : cur.lo, k < cuts.length ? cl(cuts[k], cur) : cur.hi, cols[k]);
    }
    prev = cur;
  }
  // the sides follow the outline: stone down to the water, cut by five low flat arches; a lattice balustrade on top
  const span = (s1 - s0) / 5, openAt = (s, z) => { const k = Math.floor((s - s0) / span), c = s0 + (k + 0.5) * span, x = (s - c) / (span * 0.39); return Math.abs(x) < 1 ? Math.max(0, (z - 0.6) * Math.sqrt(1 - x * x)) : 0; };
  let run = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], L = dist(a, b); if (L < 0.05) continue;
    const ed = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], along = Math.abs(ed[0] * d[0] + ed[1] * d[1]), inw = [-ed[1], ed[0]];
    const sm = S([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), landing = along < 0.5 && (sm < s0 + 1.2 || sm > s1 - 1.2);
    const nseg = Math.max(1, Math.ceil(L / 1.2));
    for (let k = 0; k < nseg; k++) {
      const p = [a[0] + ed[0] * (L * k) / nseg, a[1] + ed[1] * (L * k) / nseg], q = [a[0] + ed[0] * (L * (k + 1)) / nseg, a[1] + ed[1] * (L * (k + 1)) / nseg];
      const zp = zAt(S(p)), zq = zAt(S(q));
      if (landing) continue;
      const op = along > 0.8 ? openAt(S(p), zp) : 0, oq = along > 0.8 ? openAt(S(q), zq) : 0;
      if (op > 0 || oq > 0) G.quad([p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], oq], [p[0], p[1], op], voidC);
      G.quad([p[0], p[1], op], [q[0], q[1], oq], [q[0], q[1], zq], [p[0], p[1], zp], stone);
      // balustrade: a pierced stone panel 1.05 m high, 0.28 m thick
      const pc = Math.floor(run / 1.2) % 2 ? C('#ead9bb') : C('#d6c19e'), pi = [p[0] + inw[0] * 0.28, p[1] + inw[1] * 0.28], qi = [q[0] + inw[0] * 0.28, q[1] + inw[1] * 0.28];
      G.quad([p[0], p[1], zp], [q[0], q[1], zq], [q[0], q[1], zq + 1.05], [p[0], p[1], zp + 1.05], pc);
      G.quad([pi[0], pi[1], zp], [qi[0], qi[1], zq], [qi[0], qi[1], zq + 1.05], [pi[0], pi[1], zp + 1.05], pc);
      G.quad([p[0], p[1], zp + 1.05], [q[0], q[1], zq + 1.05], [qi[0], qi[1], zq + 1.05], [pi[0], pi[1], zp + 1.05], pale);
      // posts with ball finials
      if (Math.floor(run / 4.8) !== Math.floor((run + L / nseg) / 4.8)) { const c0 = [q[0] + inw[0] * 0.14, q[1] + inw[1] * 0.14], ea = Math.atan2(ed[1], ed[0]); G.box(c0[0], c0[1], zq, zq + 1.32, 0.27, 0.27, ea, pale); LP.box(c0[0], c0[1], zq + 1.32, zq + 1.56, 0.13, 0.13, ea, pale); }
      run += L / nseg;
    }
  }
  // four square towers at the corners of the middle section, joined by a timber pergola over the deck
  const TS = [25.2, 42.3], TV = [-9.5, 9.5], zm = zAt((TS[0] + TS[1]) / 2);
  for (const s of TS) for (const v of TV) {
    const c0 = at(s, v), z = zAt(s), top = z + 8.6, fr = [[d, n], [n, [-d[0], -d[1]]], [[-d[0], -d[1]], [-n[0], -n[1]]], [[-n[0], -n[1]], d]];
    G.box(c0[0], c0[1], 0, top, 2.3, 2.3, ang, stone);
    for (const [fx, fy] of fr) {
      // each face: a tall pointed arch under a band of lattice
      const f = frame([c0[0] - fx[0] * 2.3 - fy[0] * 2.3, c0[1] - fx[1] * 2.3 - fy[1] * 2.3], fx, [-fy[0], -fy[1]]);
      f.arch(GL, 2.3, 1.15, 0.03, z + 0.2, z + 4.0, z + 5.5, voidC);
      f.panel(G, 0.5, 4.1, 0.03, z + 6.3, z + 7.5, C('#c8b28c'));
      if (F) for (let k = 0; k < 6; k++) f.panel(F, 0.62 + k * 0.6, 0.92 + k * 0.6, 0.05, z + 6.45, z + 7.35, C('#8f7c5e'));
    }
    G.box(c0[0], c0[1], top, top + 0.45, 2.6, 2.6, ang, pale);
    G.pyramid(c0[0], c0[1], top + 0.45, top + 1.7, 2.6, 2.6, ang, C('#b9a888'));
  }
  const pa = TS[0] + 2.4, pb = TS[1] - 2.4, pz = zm + 5.1;
  for (let v = -7.2; v <= 7.21; v += 1.8) { const q = at((pa + pb) / 2, v); G.box(q[0], q[1], pz, pz + 0.24, (pb - pa) / 2, 0.09, ang, TIMBER); }
  for (let s = pa; s <= pb + 0.01; s += 0.9) { const q = at(s, 0); F.box(q[0], q[1], pz + 0.24, pz + 0.34, 0.06, 7.3, ang, C('#b88a58')); }
  for (const s of [pa, (pa + pb) / 2, pb]) for (const v of [-7.2, 7.2]) { const q = at(s, v); G.box(q[0], q[1], zAt(s), pz, 0.14, 0.14, ang, TIMBER); }
}

// ---------------------------------------------------------------- the layer
export function buildBurjLake(ctx, { labels } = {}) {
  const D = ctx.data.burjLake, lake = (ctx.data.burjWalk || [])[0];
  if (!D || !lake) return null;
  const group = new THREE.Group(); group.name = 'burj-lake'; ctx.scene.add(group);
  const G = new Geo(), F = new Geo(), GL = new Geo(), SC = new Geo(), LP = new Geo(), SG = new Geo(), ST = new Geo(), BR = new Geo(), GW = new Geo(), AP = new Geo();
  const inLake = (q) => inRing(q, lake);
  const mallB = (ctx.data.buildings || []).find((b) => b.n === 'The Dubai Mall'), mallRing = mallB ? mallB.p[0] : null;

  if (D.bridge) buildBridge(G, F, GL, LP, GW, D.bridge);

  // ---- the mall's lake front, bay by bay
  const bays = [];
  for (const line of D.front || []) {
    const cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i], line[i - 1]));
    const L = cum[cum.length - 1]; if (L < 7) continue;
    const P = (s) => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1); return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t]; };
    const n = Math.max(1, Math.round(L / 9)), bw = L / n;
    for (let k = 0; k < n; k++) {
      let p0 = P(k * bw), p1 = P((k + 1) * bw); const w = dist(p0, p1); if (w < 3) continue;
      let dir = [(p1[0] - p0[0]) / w, (p1[1] - p0[1]) / w], nrm = [dir[1], -dir[0]];
      const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      if (mallRing && inRing([mid[0] + nrm[0] * 2, mid[1] + nrm[1] * 2], mallRing)) { [p0, p1] = [p1, p0]; dir = [-dir[0], -dir[1]]; nrm = [dir[1], -dir[0]]; }
      let gap = 0; for (let e = 2; e <= 62; e += 1) if (inLake([mid[0] + nrm[0] * e, mid[1] + nrm[1] * e])) { gap = e; break; }
      bays.push({ p0, dir, nrm, w, mid, gap, td: TD(gap), lg: null, up: null, door: false });
    }
  }
  // the mapped main doors take a bay each; the mapped outlets take the bays nearest to them, one per tier
  for (const q of D.doors || []) { let best = null, bd = 16; for (const b of bays) { const e = dist(q, b.mid); if (e < bd) { bd = e; best = b; } } if (best) best.door = true; }
  // the round drum by the bridge: found as the longest evenly curving run of the mall's front, a circle fitted to it.
  // The Apple store's glass front and terrace take the part of the arc round the mall door that OSM maps there.
  let drum = null;
  for (const line of D.front || []) {
    let run = null;
    const close = () => { if (run && run.pts.length >= 9 && (!drum || run.pts.length > drum.pts.length)) drum = run; run = null; };
    for (let i = 1; i < line.length - 1; i++) {
      const a = line[i - 1], b = line[i], e = line[i + 1], turn = wrap(Math.atan2(e[1] - b[1], e[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]));
      if (dist(a, b) < 8 && dist(b, e) < 8 && Math.abs(turn) > 0.08 && Math.abs(turn) < 0.26 && (!run || Math.sign(turn) === run.sgn)) { if (!run) run = { sgn: Math.sign(turn), pts: [a] }; run.pts.push(b); run.last = e; } else if (run) { run.pts.push(run.last); close(); }
    }
    if (run) { run.pts.push(run.last); close(); }
  }
  if (drum) {
    const Pp = drum.pts, n = Pp.length, mx = Pp.reduce((s, p) => s + p[0], 0) / n, my = Pp.reduce((s, p) => s + p[1], 0) / n;
    let Suu = 0, Suv = 0, Svv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
    for (const p of Pp) { const u = p[0] - mx, v = p[1] - my; Suu += u * u; Suv += u * v; Svv += v * v; Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u; }
    const det = Suu * Svv - Suv * Suv, e1 = 0.5 * (Suuu + Suvv), e2 = 0.5 * (Svvv + Svuu), uc = (e1 * Svv - e2 * Suv) / det, vc = (e2 * Suu - e1 * Suv) / det;
    const c = [mx + uc, my + vc], R = Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / n), A = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
    const ta = A(Pp[0]), tm = ta + wrap(A(Pp[n >> 1]) - ta), tb = tm + wrap(A(Pp[n - 1]) - tm), lo = Math.min(ta, tb), hi = Math.max(ta, tb);
    const door = (D.doors || []).find((q) => Math.abs(dist(q, c) - R) < 8), td = door ? tm + wrap(A(door) - tm) : (lo + hi) / 2;
    const half = Math.min(0.66, (hi - lo) / 2 - 0.1);
    let t0 = Math.max(lo + 0.06, td - half), t1 = Math.min(hi - 0.06, td + half);
    if (R > 25 && R < 60 && t1 - t0 > 0.5) {
      const TA = (p) => tm + wrap(A(p) - tm);
      let a0 = Infinity, a1 = -Infinity;
      for (const b of bays) { const t = TA(b.mid); if (Math.abs(dist(b.mid, c) - R) < 3.5 && t > t0 && t < t1) { b.apple = true; b.door = false; b.td = 0; const p1 = [b.p0[0] + b.dir[0] * b.w, b.p0[1] + b.dir[1] * b.w]; a0 = Math.min(a0, TA(b.p0), TA(p1)); a1 = Math.max(a1, TA(b.p0), TA(p1)); } }
      if (a1 > a0) drum = { c, R, t0: a0, t1: a1 }; else drum = null;
      // the tan block of tall pointed arches stands where the straight front meets the drum
      if (drum) { let best = null, bd = 0; for (const b of bays) { if (b.apple || dist(b.mid, Pp[0]) > 13) continue; const e = dist(b.mid, c); if (e > bd) { bd = e; best = b; } } if (best) best.door = true; }
    } else drum = null;
  }
  const mine = [];
  for (const poi of D.pois || []) {
    if (poi[2] === 'Apple Store') continue; // (no plate: its glass front is the sign)
    let bi = -1, bd = 46;
    bays.forEach((b, i) => { const e = dist(poi, b.mid), out = (poi[0] - b.mid[0]) * b.nrm[0] + (poi[1] - b.mid[1]) * b.nrm[1]; if (e < bd && out < 12) { bd = e; bi = i; } });
    if (bi >= 0) mine.push({ poi, bi, bd });
  }
  mine.sort((a, b) => a.bd - b.bd);
  for (const { poi, bi } of mine) {
    const want = poi[4] > 0 ? ['up', 'lg'] : ['lg', 'up'];
    done: for (const tier of want) for (const o of [0, 1, -1, 2, -2, 3, -3]) { const b = bays[bi + o]; if (b && !b.door && !b[tier] && (tier === 'lg' || (b.td > 0 && !b.apple)) && dist(b.mid, bays[bi].mid) < 40) { b[tier] = poi; break done; } }
  }

  // ---- Souk Al Bahar's fronts on the water, in bays of about 4.4 m (one arch each)
  const soukBays = [];
  (D.souk || []).forEach((line, li) => {
    const cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i], line[i - 1]));
    const L = cum[cum.length - 1]; if (L < 6) return;
    const P = (s) => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1); return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t]; };
    const n = Math.max(1, Math.round(L / 4.4)), bw = L / n;
    for (let k = 0; k < n; k++) {
      let p0 = P(k * bw), p1 = P((k + 1) * bw); const w = dist(p0, p1); if (w < 2) continue;
      let dir = [(p1[0] - p0[0]) / w, (p1[1] - p0[1]) / w], nrm = [dir[1], -dir[0]];
      const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2], march = (sg) => { for (let e = 1; e <= 45; e += 0.5) if (inLake([mid[0] + nrm[0] * e * sg, mid[1] + nrm[1] * e * sg])) return e; return 0; };
      let gap = march(1); if (!gap && march(-1)) { [p0, p1] = [p1, p0]; dir = [-dir[0], -dir[1]]; nrm = [dir[1], -dir[0]]; gap = march(1); }
      soukBays.push({ p0, dir, nrm, w, mid, gap, li, k, n, sign: null, portal: 0 });
    }
  });
  {
    // the tall portal at the middle of the longest front, the souk's name on the bays either side
    // (the front that looks toward Burj Khalifa across the main basin: the straight face of 40 m or more whose
    // outward side points most nearly at the tower)
    const BK = [13585, 13039]; let target = null, score = -Infinity;
    (D.souk || []).forEach((line, li) => { for (let i = 1; i < line.length; i++) { const a = line[i - 1], b = line[i], L = dist(a, b); if (L < 40) continue; const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; const near = soukBays.filter((q) => q.li === li).sort((x, y) => dist(x.mid, m) - dist(y.mid, m))[0]; if (!near || !near.gap) continue; const e = dist(m, BK), sc = (near.nrm[0] * (BK[0] - m[0]) + near.nrm[1] * (BK[1] - m[1])) / e; if (sc > score) { score = sc; target = { m, li }; } } });
    if (target) {
      const list = soukBays.filter((q) => q.li === target.li); let m = 0; list.forEach((q, i) => { if (dist(q.mid, target.m) < dist(list[m].mid, target.m)) m = i; });
      if (m >= 1) { list[m - 1].portal = 1; list[m].portal = 2; for (const k of [m - 4, m + 3]) if (list[k]) list[k].sign = 'SOUK AL BAHAR'; }
    }
    const used = new Set(); for (const b of bays) for (const t of ['lg', 'up']) if (b[t]) used.add(b[t][2]);
    const cand = [];
    for (const poi of D.pois || []) {
      if (used.has(poi[2]) || poi[2] === 'Apple Store') continue;
      let bi = -1, bd = 32; soukBays.forEach((b, i) => { const e = dist(poi, b.mid), out = (poi[0] - b.mid[0]) * b.nrm[0] + (poi[1] - b.mid[1]) * b.nrm[1]; if (b.gap && e < bd && out < 14) { bd = e; bi = i; } });
      if (bi >= 0) cand.push({ poi, bi, bd });
    }
    cand.sort((a, b) => a.bd - b.bd);
    for (const { poi, bi } of cand) for (const o of [0, 1, -1, 2, -2, 3, -3, 4, -4]) { const b = soukBays[bi + o]; if (b && b.gap && !b.portal && !b.sign && b.li === soukBays[bi].li) { b.sign = poi[2]; break; } }
  }

  // sign plates: the outlets' names in plain lettering on one texture
  const names = []; for (const b of bays) for (const t of ['lg', 'up']) if (b[t] && !names.includes(b[t][2])) names.push(b[t][2]);
  for (const b of soukBays) if (b.sign && !names.includes(b.sign)) names.push(b.sign);
  const COLS = 4, ROWS = 16, CW = 512, CH = 64;
  const cv = document.createElement('canvas'); cv.width = COLS * CW; cv.height = ROWS * CH;
  const g2 = cv.getContext('2d'); g2.fillStyle = '#20242a'; g2.fillRect(0, 0, cv.width, cv.height);
  g2.textAlign = 'center'; g2.textBaseline = 'middle';
  names.slice(0, COLS * ROWS).forEach((nm, i) => {
    const x = (i % COLS) * CW, y = Math.floor(i / COLS) * CH, k = Math.floor(hash(nm) * 4);
    g2.fillStyle = ['#20242a', '#2a2420', '#1c2b33', '#f3ecdd'][k]; g2.fillRect(x, y, CW, CH);
    g2.strokeStyle = k === 3 ? '#8a7a5c' : '#c9a86a'; g2.lineWidth = 3; g2.strokeRect(x + 5, y + 5, CW - 10, CH - 10);
    let fs = 38; g2.font = `700 ${fs}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
    while (g2.measureText(nm).width > CW - 44 && fs > 16) { fs -= 2; g2.font = `700 ${fs}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`; }
    g2.fillStyle = k === 3 ? '#2a2420' : '#f7f0e2'; g2.fillText(nm, x + CW / 2, y + CH / 2 + 2);
  });
  const atlas = new THREE.CanvasTexture(cv); atlas.colorSpace = THREE.SRGBColorSpace; atlas.anisotropy = 8;
  const signUV = (nm) => { const i = names.indexOf(nm); if (i < 0 || i >= COLS * ROWS) return null; const c = i % COLS, r = Math.floor(i / COLS); return [c / COLS, 1 - (r + 1) / ROWS, (c + 1) / COLS, 1 - r / ROWS]; };
  const white = C('#ffffff');
  const sign = (f, xc, y, z0, name, maxW) => { const uv = signUV(name); if (!uv) return; const hw = Math.min(maxW, 7.6) / 2, h = (hw * 2) / 8; f.panel(SG, xc - hw, xc + hw, y, z0, z0 + h, white, uv); f.panel(G, xc - hw - 0.08, xc + hw + 0.08, y - 0.04, z0 - 0.08, z0 + h + 0.08, FRAME); };

  // furniture: a table and four chairs
  const setAt = (q, z, ang, dark) => {
    const cc = dark ? C('#4b3a2c') : C('#e9e4d8');
    F.box(q[0], q[1], z + 0.7, z + 0.76, 0.42, 0.42, ang, C('#d9d2c4')); F.box(q[0], q[1], z, z + 0.7, 0.05, 0.05, ang, C('#55565a'));
    for (let k = 0; k < 4; k++) { const a = ang + (k * Math.PI) / 2, cx = q[0] + Math.cos(a) * 0.78, cy = q[1] + Math.sin(a) * 0.78; F.box(cx, cy, z + 0.4, z + 0.47, 0.22, 0.22, a, cc); F.box(cx + Math.cos(a) * 0.2, cy + Math.sin(a) * 0.2, z + 0.47, z + 0.9, 0.03, 0.22, a, cc); }
  };
  const parasol = (q, z, ang, col, size = 1.5) => { G.pyramid(q[0], q[1], z + 2.35, z + 2.95, size, size, ang, col); G.box(q[0], q[1], z + 2.28, z + 2.35, size, size, ang, col.clone().multiplyScalar(0.9)); F.box(q[0], q[1], z, z + 2.3, 0.045, 0.045, ang, C('#6b6660')); };

  const H = 28.2, SCREENS = [['#12151b', '#5b6b8a'], ['#191216', '#a8534a'], ['#10191a', '#4f8f86'], ['#1a1711', '#c2a25e'], ['#14141c', '#8a79b8'], ['#101418', '#d9d4c8']];
  bays.forEach((b, bi) => {
    const f = frame(b.p0, b.dir, b.nrm), w = b.w, td = b.td, r = hash(`bay${bi}`);
    if (b.apple) { if (b.lg) sign(f, w / 2, 3.9, 4.95, b.lg[2], Math.min(w - 1.2, 5.6)); return; } // (the Apple front is built in one sweep below)
    // pilasters at the bay's ends, a fascia over the ground storey
    f.box(G, -0.45, 0.45, 0, 0.35, 0, H, STONE_L); if (bi === bays.length - 1 || dist(bays[bi + 1].p0, f.pt(w, 0)) > 1.5) f.box(G, w - 0.45, w + 0.45, 0, 0.35, 0, H, STONE_L);
    f.box(G, 0.45, w - 0.45, 0, 0.2, 10.5, 11.7, STONE_D);
    if (b.door) {
      // a main door: a taller block of four narrow pointed arches full of glass
      f.box(G, 0.2, w - 0.2, 0, 2.6, 0, 24, C('#d9bd96'));
      const na = 4, aw = (w - 1.6) / na;
      for (let k = 0; k < na; k++) { const xc = 0.8 + aw * (k + 0.5); f.arch(GL, xc, aw * 0.3, 2.64, 0, 15.5, 19, GLASS); f.arch(G, xc, aw * 0.3 + 0.18, 2.62, 0, 15.6, 19.5, FRAME); }
      f.box(G, 1.2, w - 1.2, 2.6, 6.2, 4.3, 4.55, C('#e9e6df'));
      return;
    }
    // the upper wall: one large display screen in a dark frame
    const s0 = w * 0.16, s1 = w * 0.84, sc = SCREENS[Math.floor(r * SCREENS.length)];
    f.box(G, s0 - 0.25, s1 + 0.25, 0, 0.22, 13.2, 25.2, FRAME);
    f.panel(SC, s0, s1, 0.26, 13.45, 24.95, C(sc[0]));
    f.panel(SC, s0 + (s1 - s0) * (0.18 + 0.3 * r), s0 + (s1 - s0) * (0.52 + 0.3 * r), 0.3, 14.6, 23.6, C(sc[1]));
    f.panel(SC, s0 + (s1 - s0) * 0.1, s0 + (s1 - s0) * 0.34, 0.31, 13.9, 14.3, C('#e8e4da'));
    // the ground-floor shopfront behind the upper terrace
    f.panel(GL, 0.9, w - 0.9, 0.22, td ? 5.3 : 0.4, 9.9, GLASS);
    for (let x = 0.9; x <= w - 0.89; x += (w - 1.8) / 3) f.box(G, x - 0.07, x + 0.07, 0.2, 0.3, td ? 5.3 : 0.4, 9.9, FRAME);
    const lgName = b.lg && b.lg[2], upName = b.up && b.up[2];
    if (upName) sign(f, w / 2, 0.26, 10.62, upName, w - 1.6);
    if (!td) { if (lgName) sign(f, w / 2, 0.3, 4.1, lgName, w - 1.6); return; }
    // the podium: one storey of restaurants, glazed to the promenade, its roof the upper terrace
    const col = C(PARASOLS[Math.floor(hash(lgName || `p${bi}`) * PARASOLS.length)]), colUp = C(PARASOLS[Math.floor(hash(upName || `u${bi}`) * 4)]);
    f.box(G, 0.15, w - 0.15, 0.2, td, 0, 5.0, STONE, C('#b9ab96'));
    f.panel(GL, 0.8, w - 0.8, td + 0.03, 0.35, 3.75, GLASS);
    for (let x = 0.8; x <= w - 0.79; x += (w - 1.6) / 4) f.box(G, x - 0.06, x + 0.06, td, td + 0.09, 0.35, 3.75, FRAME);
    f.box(G, 0.15, w - 0.15, td, td + 0.12, 3.85, 5.0, STONE_D);
    if (lgName) sign(f, w / 2, td + 0.16, 4.02, lgName, w - 1.6);
    // an awning over the shopfront in the outlet's colour
    G.quad(f.pt(0.9, td + 0.1, 3.8), f.pt(w - 0.9, td + 0.1, 3.8), f.pt(w - 0.9, td + 1.5, 3.2), f.pt(0.9, td + 1.5, 3.2), col);
    // glass balustrade round the upper terrace, parasols and tables on it
    for (const [x0, x1, y0, y1] of [[0.2, w - 0.2, td - 0.06, td], [0.2, 0.26, 0.4, td], [w - 0.26, w - 0.2, 0.4, td]]) f.box(G, x0, x1, y0, y1, 5.0, 6.05, C('#bcd3d6'));
    const nu = Math.max(1, Math.floor((w - 1.2) / 3.5));
    for (let k = 0; k < nu; k++) { const q = f.pt(0.6 + ((w - 1.2) * (k + 0.5)) / nu, td * 0.5 + 0.2); parasol(q, 5.0, f.ang, colUp, 1.45); setAt(q, 5.0, f.ang + 0.4, true); if (td > 5.5) setAt(f.pt(0.6 + ((w - 1.2) * (k + 0.5)) / nu, td * 0.5 - 2.1), 5.0, f.ang, true); }
    // the terrace at promenade level: a low deck, planter boxes with clipped hedges along its edge, parasols and tables
    const y0 = td + 0.2, y1 = 2 * td, dk = DECKS[Math.floor(hash(lgName || `d${bi}`) * DECKS.length)];
    f.box(G, 0.3, w - 0.3, y0, y1, 0, 0.2, dk);
    for (const [x0, x1] of [[0.3, w / 2 - 1.1], [w / 2 + 1.1, w - 0.3]]) { f.box(G, x0, x1, y1 - 0.55, y1, 0.2, 0.85, C('#3a3d42')); f.box(G, x0 + 0.06, x1 - 0.06, y1 - 0.49, y1 - 0.06, 0.85, 1.25, C('#4f8a3c')); }
    f.box(G, 0.3, 0.7, y0 + 0.6, y1 - 0.55, 0.2, 0.75, C('#3a3d42')); f.box(G, 0.36, 0.64, y0 + 0.66, y1 - 0.61, 0.75, 1.1, C('#5b9a45'));
    const nx = Math.max(1, Math.floor((w - 1.6) / 3.4)), ny = Math.max(1, Math.round((y1 - y0 - 1.0) / 3.3));
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const q = f.pt(1.0 + ((w - 1.6) * (i + 0.5)) / nx, y0 + 0.2 + ((y1 - y0 - 1.0) * (j + 0.5)) / ny);
      parasol(q, 0.2, f.ang, col); setAt(q, 0.2, f.ang + 0.3 + r, hash(lgName || `c${bi}`) < 0.6);
    }
  });

  if (drum) buildApple({ G, F, GL, AP }, drum.c, drum.R, drum.t0, drum.t1);

  // ---- Souk Al Bahar: a ground-floor arcade of pointed arches on slim columns, a covered restaurant terrace above
  // under a dark timber canopy, and the tall portal framed in dark tile (reference: the 2011 lake-front photograph)
  {
    const stone = C('#e4d5b8'), pale = C('#f0e7d2'), timber = C('#7a6250'), timberD = C('#5f4a3d');
    for (const b of soukBays) {
      if (!b.gap || b.portal === 2) continue;
      const f = frame(b.p0, b.dir, b.nrm), w = b.w, dp = b.gap >= 11 ? 4.2 : b.gap >= 7 ? 2.4 : 0.45;
      if (b.portal === 1) {
        const W2 = w * 2, yf = Math.min(dp, 2.4) + 0.7;
        f.box(G, 0.1, W2 - 0.1, 0, yf, 0, 17.6, C('#4b463f')); f.panel(G, 0.85, W2 - 0.85, yf + 0.04, 0, 16.7, C('#eadfc8'));
        f.arch(GL, W2 / 2, W2 * 0.29, yf + 0.08, 0, 9.4, 13.4, C('#2c3a40')); f.arch(G, W2 / 2, W2 * 0.29 + 0.25, yf + 0.06, 0, 9.5, 14.0, C('#cbbd9f'));
        for (let k = 0; k < 4; k++) f.arch(G, W2 * (0.26 + 0.16 * k), 0.36, yf + 0.08, 14.6, 15.5, 16.1, C('#4b463f'));
        continue;
      }
      // the base: one pointed arch per bay between slim columns, shops glowing behind
      f.box(G, 0, w, 0, dp, 0, 5.4, stone, C('#cdbfa6'));
      f.arch(GL, w / 2, w / 2 - 0.95, dp + 0.03, 0, 3.0, 4.6, C('#3a4850'));
      f.box(G, -0.2, 0.2, dp, dp + 0.18, 0, 3.0, pale); f.box(G, -0.3, 0.3, dp, dp + 0.24, 3.0, 3.28, pale);
      if (b.k === b.n - 1) { f.box(G, w - 0.2, w + 0.2, dp, dp + 0.18, 0, 3.0, pale); f.box(G, w - 0.3, w + 0.3, dp, dp + 0.24, 3.0, 3.28, pale); }
      if (b.sign) sign(f, w / 2, dp + 0.22, 4.8, b.sign, w - 0.3);
      if (dp > 2) {
        f.box(G, 0, w, dp - 0.09, dp, 5.4, 6.4, timber); f.box(G, -0.08, 0.08, dp - 0.16, dp, 5.4, 8.7, timberD);
        f.box(G, -0.05, w + 0.05, -0.1, dp + 0.55, 8.7, 8.92, timberD);
        f.panel(GL, 0.35, w - 0.35, 0.2, 5.8, 8.3, GLASS);
        if (dp > 3.5) setAt(f.pt(w / 2, dp / 2 + 0.2), 5.4, f.ang + 0.3, true);
      }
    }
  }

  // ---- the water's edge: railing, lantern pylons, stone benches
  for (const line of D.rail || []) {
    let run = 0;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], L = dist(a, b); if (L < 0.05) continue;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      F.box(m[0], m[1], 1.06, 1.12, L / 2, 0.035, ang, BRONZE); F.box(m[0], m[1], 0.12, 0.17, L / 2, 0.025, ang, BRONZE);
      BR.wall(a, b, 0.17, 1.06, BRONZE);
      for (let s = (2 - (run % 2)) % 2; s < L; s += 2) F.box(a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L, 0, 1.14, 0.04, 0.04, ang, BRONZE);
      run += L;
    }
  }
  {
    const w0 = C('#000000'), w1 = C('#ffc98a');
    for (const line of D.rail || []) for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], L = dist(a, b); if (L < 0.05) continue;
      let nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L; if (inLake([(a[0] + b[0]) / 2 + nx * 2.5, (a[1] + b[1]) / 2 + ny * 2.5])) { nx = -nx; ny = -ny; }
      const o = (q, e) => [q[0] + nx * e, q[1] + ny * e, 0.07];
      GW.quadC(o(a, 0.2), o(b, 0.2), o(b, 4.5), o(a, 4.5), w0, w0, w1, w1); GW.quadC(o(a, 4.5), o(b, 4.5), o(b, 12), o(a, 12), w1, w1, w0, w0);
    }
  }
  for (const [x, y, a] of D.pylons || []) {
    // a slim bronze pylon, its upper third a lantern of lattice over glass
    G.box(x, y, 0, 4.9, 0.26, 0.17, a, BRONZE); LP.box(x, y, 4.9, 7.0, 0.23, 0.14, a, C('#efe6d0')); G.box(x, y, 7.0, 7.16, 0.28, 0.19, a, BRONZE);
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const c = Math.cos(a), s = Math.sin(a), ox = dx * 0.25, oy = dy * 0.16; F.box(x + ox * c - oy * s, y + ox * s + oy * c, 4.9, 7.0, 0.025, 0.025, a, BRONZE); }
    for (const z of [5.4, 5.95, 6.5]) F.box(x, y, z, z + 0.04, 0.27, 0.18, a, BRONZE);
  }
  for (const [x, y, a] of D.benches || []) { F.box(x, y, 0, 0.42, 1.3, 0.32, a, C('#55575b'), C('#6a6c70')); F.box(x, y, 0.08, 0.3, 1.32, 0.2, a, C('#7b7d80')); }
  // ---- paving joints: thin darker lines that follow the water's edge
  for (const line of D.stripes || []) for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], L = dist(a, b); if (L < 0.05) continue;
    const nx = (-(b[1] - a[1]) / L) * 0.17, ny = ((b[0] - a[0]) / L) * 0.17, z = 0.035;
    ST.quad([a[0] - nx, a[1] - ny, z], [b[0] - nx, b[1] - ny, z], [b[0] + nx, b[1] + ny, z], [a[0] + nx, a[1] + ny, z], white);
  }

  // ---- materials and meshes
  const side = THREE.DoubleSide;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, side });
  const glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.15, side, emissive: C('#ffcf8a'), emissiveIntensity: 0 });
  const screenMat = new THREE.MeshBasicMaterial({ vertexColors: true, side });
  const lampMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, side, emissive: C('#ffe2b0'), emissiveIntensity: 0 });
  const appleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.1, side, emissive: C('#fff0d2'), emissiveIntensity: 0 });
  const signMat = new THREE.MeshStandardMaterial({ map: atlas, emissiveMap: atlas, emissive: C('#ffffff'), emissiveIntensity: 0.12, roughness: 0.7, side });
  const stripeMat = new THREE.MeshStandardMaterial({ color: C('#857a78'), roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false });
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, side, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const barsMat = new THREE.MeshStandardMaterial({ color: BRONZE, roughness: 0.7, side, transparent: true, opacity: 0.42, depthWrite: false });
  const mk = (geo, m, name, { cast = true, receive = true, order = 0 } = {}) => { if (!geo.count) return null; const mesh = new THREE.Mesh(geo.build(), m); mesh.name = name; mesh.castShadow = cast; mesh.receiveShadow = receive; mesh.renderOrder = order; group.add(mesh); return mesh; };
  mk(G, mat, 'burj-lake-main');
  const fine = mk(F, mat, 'burj-lake-furniture');
  mk(GL, glassMat, 'burj-lake-glass', { cast: false });
  mk(AP, appleMat, 'burj-lake-apple-glass', { cast: false });
  mk(SC, screenMat, 'burj-lake-screens', { cast: false, receive: false });
  mk(LP, lampMat, 'burj-lake-lanterns', { cast: false, receive: false });
  mk(SG, signMat, 'burj-lake-signs', { cast: false });
  mk(ST, stripeMat, 'burj-lake-paving', { cast: false, order: 2 });
  const bars = mk(BR, barsMat, 'burj-lake-railing', { cast: false, receive: false, order: 5 });
  const glow = mk(GW, glowMat, 'burj-lake-light', { cast: false, receive: false, order: 3 });

  // night: shopfronts, screens, lanterns and signs light up
  const setNight = (n) => { appleMat.emissiveIntensity = 1.35 * n; glassMat.emissiveIntensity = 0.85 * n; lampMat.emissiveIntensity = 2.4 * n; signMat.emissiveIntensity = 0.12 + 0.95 * n; screenMat.color.setScalar(0.5 + 0.7 * n); glowMat.opacity = 0.34 * n; if (glow) glow.visible = n > 0.02; };
  ctx.on('time', (s) => setNight(s.night || 0));
  setNight(ctx.last.time ? ctx.last.time.night || 0 : 0);
  // the small things (chairs, tables, railing posts) only from close by
  ctx.updaters.push(() => { const cam = ctx.activeCamera, near = !cam.isOrthographicCamera || cam.zoom >= 4.2; if (fine) fine.visible = near; if (bars) bars.visible = near; });

  // ---- the outlets' names as map labels, from close zoom
  if (labels && labels.add) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const put = (x, y, z, name, cls, min) => { const l = labels.add(`poi${cls}`, esc(name), new THREE.Vector3(x, z, -y), { min, prio: -5 }); const r = l.el.getBoundingClientRect(); l.w = r.width; l.h = r.height; };
    for (const [x, y, name, k] of D.pois || []) put(x, y, 7, name, k === 1 ? ' cafe' : k === 3 ? ' shop' : '', 8);
    if (D.bridge) put(13903.5, 12836.5, 13, 'Souk Al Bahar Bridge', ' shop', 6);
  }
  return { group, bays: bays.length, soukBays: soukBays.length, apple: !!drum, named: names.length };
}
