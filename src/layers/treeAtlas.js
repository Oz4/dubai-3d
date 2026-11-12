// Painted tree impostors in a stylized game-map look. Each species is modelled once: crowns as dense
// masses of round, leafy lobes (crown()), palms as broad fronds of fat leaflets, plus flowers and
// bark-textured branches. Each model is rasterised with a z-buffer (2x supersampled) from three viewing
// elevations into 256 px layers holding colour + coverage and view-space normal, occlusion and depth.
// Runs in a worker during loading; trees.js turns the result into cel-shaded, swaying, shadow-casting
// cards. Pure JS (no three.js) so it can run off the main thread.

// Bump when the paintings change: browsers keep the finished atlas (trees.js) under this name.
export const ATLAS_VERSION = 'leaves-3';
export const RES = 256;
export const ELEV = [12, 36, 62]; // elevations (degrees above the horizon) each species is painted from
export const ROW_SPLIT = [24, 49]; // camera elevations where the cards switch painting
export const VARIANTS = 3;
export const SPECIES = 11;
export const LAYERS = SPECIES * VARIANTS * ELEV.length;
const SS = 2, R2 = RES * SS;
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ small helpers
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hx = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const pick = (arr, r) => arr[Math.floor(r() * arr.length) % arr.length];
const jit = (c, r, k) => { const f = 1 + (r() - 0.5) * k, h = (r() - 0.5) * k * 0.35; return [clamp01(c[0] * f * (1 + h)), clamp01(c[1] * f), clamp01(c[2] * f * (1 - h))]; };
const sphereDir = (r) => { const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u); return [s * Math.cos(a), u, s * Math.sin(a)]; };
const pal = (...h) => h.map(hx);
// the stylized palette: canopy colours pushed more saturated and a little lighter (a painted game map, not a photo)
function vivid(c, sat = 1.3, lit = 1.12) {
  const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return [0, 1, 2].map((i) => clamp01((l + (c[i] - l) * sat) * lit));
}

class Model {
  constructor() { this.L = []; this.S = []; this.B = []; this.crownY = 4; this.crownR = 3; this.sway = 0.5; }
  // a canopy lobe (stylized foliage): centre, radius, the canopy's outward normal there, colour, occlusion, seed
  lobe(p, r, n, c, ao, seed) { this.B.push({ p, r, n, c, ao, seed }); }
  // a leaf: position, radius, normal, colour, occlusion; optionally a tangent (the way it points) and an aspect
  // (> 1: a pointed, leaf-shaped stroke rather than a disc)
  leaf(p, r, n, c, ao, t = null, asp = 1) { this.L.push({ p, r, n, c, ao, t, asp }); }
  seg(a, b, ra, rb, c, ao, o = {}) {
    this.S.push({ a, b, ra, rb, c, c2: o.c2 || c, ao, ao2: o.ao2 ?? ao, n: o.n || null, bark: o.bark || 0, s0: o.s0 || 0, L: len([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) });
  }
  // a branch drawn as a chain of segments along a curve f(t), t in [0, 1]
  limb(f, n, r0, r1, c, ao0, ao1, bark = 0) {
    let prev = f(0), s = 0;
    for (let i = 1; i <= n; i++) {
      const t = i / n, p = f(t);
      this.seg(prev, p, r0 + (r1 - r0) * (t - 1 / n), r0 + (r1 - r0) * t, c, ao0 + (ao1 - ao0) * (t - 1 / n), { ao2: ao0 + (ao1 - ao0) * t, bark, s0: s });
      s += len([p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]]); prev = p;
    }
    return prev;
  }
}

// Leaves over a lobe: leaf strokes laid over its outer side (kd: the way out of the crown), lighter and warmer where
// they face the sky, deeper and cooler underneath, some reaching past the lobe so the outline is made of leaf tips.
function leaves(M, r, q, lr, on, kd, lc, ao, leafK = 0.2, leafMax = 170) {
  const leafR = Math.max(0.13, Math.min(0.32, lr * leafK));
  const nLeaf = Math.max(30, Math.min(leafMax, Math.round(78 * lr * lr * (0.2 / leafK))));
  for (let j = 0; j < nLeaf; j++) {
    let w = sphereDir(r);
    if (dot(w, kd) < -0.15) w = mul(w, -1);
    const reach = 0.84 + 0.34 * r() * r();
    const lp = [q[0] + w[0] * lr * reach, q[1] + w[1] * lr * reach, q[2] + w[2] * lr * reach];
    const up = clamp01(w[1] * 0.5 + 0.5 + (r() - 0.5) * 0.3);          // 0 underside .. 1 top of the cluster
    const tone = up > 0.5 ? mix(lc, [lc[0] * 1.2 + 0.04, lc[1] * 1.15 + 0.04, lc[2] * 0.9], (up - 0.5) * 2) : mix([lc[0] * 0.6, lc[1] * 0.7, lc[2] * 0.86], lc, up * 2);
    const n = norm([w[0] * 0.7 + on[0] * 0.45, w[1] * 0.7 + on[1] * 0.45, w[2] * 0.7 + on[2] * 0.45]);
    const tg = norm([w[0] + (r() - 0.5) * 0.9, -0.5 + w[1] * 0.3, w[2] + (r() - 0.5) * 0.9]);
    M.leaf(lp, leafR * (0.75 + 0.5 * r()), n, jit(tone, r, 0.1).map(clamp01), clamp01(ao * (0.72 + 0.3 * up)), tg, 1.7);
  }
}

// A crown in the look of a hand-painted game map: big, round clusters of foliage (lobes) spread evenly over an
// ellipsoidal envelope (best-candidate sampling, so they neither bunch up nor leave gaps), each with a soft scalloped
// outline, over a darker core. Every lobe is shaded as a sphere tilted toward the crown's outward direction, so it
// reads as one round, lit cluster while the whole crown still lights as one volume. Flowering trees bloom by lobe
// (solid masses of blossom on the sunlit top); flowering shrubs get dots of flowers over the green. The leaf clumps
// placed first only anchor the branches.
function crown(M, r, o) {
  const C = o.c, R = o.rad, clumps = [];
  const shape = o.shape || (() => 1);
  const dirAt = () => {
    const d = sphereDir(r);
    if (o.topBias && r() < o.topBias) { d[1] = Math.abs(d[1]) * 0.75 + 0.25; const l = len(d); d[0] /= l; d[1] /= l; d[2] /= l; }
    if (o.flatBottom) d[1] = Math.max(d[1], -o.flatBottom + r() * 0.15);
    return d;
  };
  for (let i = 0; i < o.clumps; i++) {
    const d = dirAt();
    const f = (o.shell ?? 0.55) + (1 - (o.shell ?? 0.55)) * Math.sqrt(r());
    const k = shape(d[1]);
    const p = [C[0] + d[0] * R[0] * f * k, C[1] + d[1] * R[1] * f, C[2] + d[2] * R[2] * f * k];
    clumps.push({ p, cr: (o.cr[0] + (o.cr[1] - o.cr[0]) * r()) * (0.75 + 0.35 * f), col: pick(o.pal, r) });
  }
  if (o.branches !== false) {
    const top = o.from || [0, C[1] - R[1] * 0.6, 0];
    for (const k of clumps) {
      if (r() > (o.branchP ?? 0.55)) continue;
      const end = mix(top, k.p, 0.82);
      M.seg(top, end, o.branchR ?? 0.09, (o.branchR ?? 0.09) * 0.35, o.bark || hx('#5e4a39'), 0.3, { ao2: 0.45 });
    }
  }
  const topCol = o.topTint ? hx(o.topTint) : null;
  const fl = o.flowers;
  const rmin = Math.min(R[0], R[1], R[2]);
  // lobe size from the envelope's area so neighbours overlap by about a third; flat or slim crowns, whose lobes may
  // not outgrow the thin axis, get more of them
  const P16 = 1.6, area = 4 * Math.PI * Math.pow((Math.pow(R[0] * R[1], P16) + Math.pow(R[0] * R[2], P16) + Math.pow(R[1] * R[2], P16)) / 3, 1 / P16);
  const K = o.lobeK ?? 1.28;
  let nLobe = o.lobes ?? Math.max(5, Math.round(o.clumps * 0.55));
  let LR = K * Math.sqrt(area / (nLobe * Math.PI));
  if (LR > rmin * 0.72) { LR = rmin * 0.72; nLobe = Math.min(48, Math.round((K * K * area) / (Math.PI * LR * LR))); }
  const outN = (p) => norm([(p[0] - C[0]) / (R[0] * R[0]), (p[1] - C[1]) / (R[1] * R[1]) + 0.25 / R[1], (p[2] - C[2]) / (R[2] * R[2])]);
  const at = (d) => {
    const k = shape(d[1]), q = [C[0] + d[0] * R[0] * k, C[1] + d[1] * R[1], C[2] + d[2] * R[2] * k], n = outN(q);
    const sink = LR * (0.25 + 0.6 * r());
    return [q[0] - n[0] * sink, q[1] - n[1] * sink, q[2] - n[2] * sink];
  };
  const spots = [];
  for (let i = 0; i < nLobe; i++) {
    let best = null, bestD = -1;
    for (let t = 0; t < 16; t++) {
      const q = at(dirAt());
      let dm = Infinity;
      for (const u of spots) { const dd = (q[0] - u[0]) ** 2 + (q[1] - u[1]) ** 2 + (q[2] - u[2]) ** 2; if (dd < dm) dm = dd; }
      if (dm > bestD) { bestD = dm; best = q; }
    }
    spots.push(best);
  }
  // the core: a darker mass seen between the lobes (a row or a ring of them in long or flat crowns)
  const lit = o.lit ?? 1.12, coreCol = mul(vivid(pick(o.pal, r), 1.3, lit), 0.74);
  const ax = R.map((v) => Math.max(1, Math.round(v / rmin)));
  for (let a = 0; a < ax[0]; a++) for (let b = 0; b < ax[1]; b++) for (let c = 0; c < ax[2]; c++) {
    const u = ax[0] > 1 ? (a / (ax[0] - 1)) * 2 - 1 : 0, v = ax[1] > 1 ? (b / (ax[1] - 1)) * 2 - 1 : 0, w = ax[2] > 1 ? (c / (ax[2] - 1)) * 2 - 1 : 0;
    if (u * u + v * v + w * w > 1.05) continue;
    M.lobe([C[0] + u * R[0] * 0.5, C[1] - R[1] * 0.08 + v * R[1] * 0.5, C[2] + w * R[2] * 0.5], rmin * 0.85, [0, 0.4, 0], coreCol, 0.32, r() * 100);
  }
  const first = M.B.length;
  for (const q of spots) {
    const rel = [(q[0] - C[0]) / R[0], (q[1] - C[1]) / R[1], (q[2] - C[2]) / R[2]], kd = norm(rel);
    // a tree in flower blooms as one mass: every lobe above the bloom line carries blossom (one family of hues),
    // the underside stays green; fl.p sets how far down the crown the blossom reaches
    const line = fl && fl.top ? 0.55 - 1.15 * fl.p : -2;
    const bloom = !!fl && !fl.dots && (fl.top ? kd[1] > line + (r() - 0.5) * 0.2 : r() < fl.p);
    let col = bloom ? pick(fl.cols, r) : pick(o.pal, r);
    if (!bloom && topCol && kd[1] > 0.15) col = mix(col, topCol, Math.min(1, (kd[1] - 0.15) * 0.85));
    const lift = clamp01((q[1] - (C[1] - R[1])) / (2 * R[1]));
    const ao = clamp01((0.62 + 0.38 * Math.min(1, len(rel))) * (0.66 + 0.34 * lift));
    const lc = jit(bloom ? vivid(col, 1.08, 0.96) : vivid(col, 1.22, lit * 0.94), r, 0.05).map(clamp01);
    const lr = LR * (0.8 + 0.34 * r());
    // the lobe itself is the shaded depth of the cluster; its leaves are painted over it
    M.lobe(q, lr, outN(q), mul(lc, 0.8), ao, r() * 100);
    leaves(M, r, q, lr, outN(q), kd, lc, ao, o.leafK ?? 0.2, o.leafMax ?? 170);
  }
  if (fl && fl.dots) {
    // flowers dotted over the upper faces of the lobes
    for (let i = 0; i < fl.dots; i++) {
      const b = M.B[first + Math.floor(r() * (M.B.length - first))];
      const d = sphereDir(r); d[1] = Math.abs(d[1]) * 0.8 + 0.2;
      const dn = norm(d);
      M.leaf(add(b.p, mul(dn, b.r * 0.97)), fl.r * (0.8 + 0.4 * r()), dn, jit(vivid(pick(fl.cols, r), 1.15, 1.05), r, 0.08).map(clamp01), Math.min(1, b.ao * 1.12));
    }
  }
  M.crownY = C[1]; M.crownR = Math.max(R[0], R[2]);
  return clumps;
}

const trunk = (M, h, r0, r1, col, o = {}) => {
  const lx = o.lean ? o.lean[0] : 0, lz = o.lean ? o.lean[1] : 0;
  return M.limb((t) => [lx * t * t * h, t * h, lz * t * t * h], o.n || 6, r0, r1, col, o.ao0 ?? 0.55, o.ao1 ?? 0.85, o.bark || 0);
};

// ------------------------------------------------------------------ palms
// One pinnate frond: a curved rachis with stiff leaflets in a V on both sides.
function frond(M, r, o) {
  const dir = [Math.cos(o.az) * Math.cos(o.pitch), Math.sin(o.pitch), Math.sin(o.az) * Math.cos(o.pitch)];
  const P = (t) => [o.base[0] + dir[0] * o.len * t, o.base[1] + dir[1] * o.len * t - o.droop * o.len * t * t, o.base[2] + dir[2] * o.len * t];
  const N = Math.max(8, Math.ceil(o.len / o.spacing));
  let prev = P(0);
  for (let i = 1; i <= N; i++) {
    const t = i / N, p = P(t);
    M.seg(prev, p, 0.05 * (1 - 0.75 * t), 0.05 * (1 - 0.75 * t) * 0.9, o.rachis, o.ao * (0.7 + 0.3 * t));
    if (t > o.petiole) {
      const T = norm([p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]]);
      const S = norm(cross(T, [0, 1, 0])), U = cross(S, T);
      const prof = Math.min(1, (t - o.petiole) / 0.18) * (1 - 0.62 * Math.pow((t - o.petiole) / (1 - o.petiole), 2));
      for (const sg of [-1, 1]) {
        const v = o.vAngle + (r() - 0.5) * 0.25;
        const Ld = norm([S[0] * sg * Math.cos(v) + U[0] * Math.sin(v) + T[0] * o.fwd, S[1] * sg * Math.cos(v) + U[1] * Math.sin(v) + T[1] * o.fwd, S[2] * sg * Math.cos(v) + U[2] * Math.sin(v) + T[2] * o.fwd]);
        const l = o.leaflet * prof * (0.85 + 0.3 * r());
        const tip = [p[0] + Ld[0] * l, p[1] + Ld[1] * l - l * 0.22 * t, p[2] + Ld[2] * l];
        let n = norm(cross(Ld, T)); if (n[1] < 0) n = mul(n, -1);
        const c = jit(mix(o.col, o.tip, t * t), r, o.jit ?? 0.16);
        M.seg(p, tip, o.width, o.width * 0.35, c, o.ao * (0.62 + 0.38 * t), { n, c2: mix(c, o.tip, 0.35), ao2: o.ao * (0.72 + 0.28 * t) });
      }
    }
    prev = p;
  }
}

function datePalm(v) {
  const r = rng(1000 + v), M = new Model();
  const H = [7.3, 8.6, 6.3][v];
  const lean = [[0.05, 0.02], [-0.07, 0.04], [0.03, -0.06]][v];
  const top = trunk(M, H, 0.36, 0.29, hx('#8a6c4e'), { lean, n: 16, bark: 1, ao0: 0.62, ao1: 0.7 });
  // old frond bases (boots) just below the crown
  for (let i = 0; i < 16; i++) {
    const a = i * 2.39996, y = top[1] - 0.15 - (i / 16) * 0.9;
    const d = [Math.cos(a), 0.55, Math.sin(a)];
    M.seg([top[0], y, top[2]], add([top[0], y, top[2]], mul(norm(d), 0.5)), 0.09, 0.05, jit(hx('#7a5a3c'), r, 0.2), 0.45);
  }
  const nF = [21, 24, 19][v];
  // stylized fronds: fewer, broader blades of fat overlapping leaflets folded in a shallow V (two tones of green
  // either side of the midrib), vivid green yellowing toward the tips
  const green = hx('#3a7f33'), tip = hx('#86b548'), old = hx('#a4953f');
  for (let i = 0; i < nF; i++) {
    const age = i / nF; // 0 = young (upright, top) .. 1 = old (drooping, bottom)
    const pitch = (68 - age * 108 + (r() - 0.5) * 14) * DEG;
    const L = (age < 0.12 ? 2.6 : 3.4) + r() * 0.9;
    frond(M, r, {
      base: [top[0], top[1] + 0.25 - age * 0.55, top[2]], az: i * 2.39996 + r() * 0.35, pitch, len: L,
      droop: 0.1 + 0.28 * Math.max(0, Math.cos(pitch)) + (age > 0.8 ? 0.12 : 0), spacing: 0.13, petiole: 0.12,
      leaflet: 0.62, width: 0.072, vAngle: 0.34, fwd: 0.5, jit: 0.05,
      col: age > 0.84 ? mix(green, old, 0.55) : jit(green, r, 0.05), tip, rachis: hx('#c9c27f'), ao: 0.62 + 0.38 * (1 - age),
    });
  }
  if (v === 1) { // date bunches hanging under the crown
    for (let b = 0; b < 4; b++) {
      const a = b * 1.7 + 0.4;
      const c0 = [top[0] + Math.cos(a) * 0.55, top[1] - 0.55, top[2] + Math.sin(a) * 0.55];
      for (let k = 0; k < 70; k++) {
        const d = sphereDir(r);
        M.leaf([c0[0] + d[0] * 0.28, c0[1] + d[1] * 0.4 - 0.2, c0[2] + d[2] * 0.28], 0.05, norm(d), jit(hx(r() < 0.6 ? '#e09a2a' : '#c9701e'), r, 0.15), 0.6);
      }
    }
  }
  M.crownY = top[1]; M.crownR = 3.6; M.sway = 1.0;
  return M;
}

function fanPalm(v) {
  const r = rng(2000 + v), M = new Model();
  const H = [13.2, 15.4, 11.4][v];
  const top = trunk(M, H, 0.27, 0.2, hx('#8f7f6c'), { lean: [[0.02, 0.01], [-0.03, 0.02], [0.02, -0.03]][v], n: 18, bark: 2, ao0: 0.6, ao1: 0.75 });
  // trimmed 'pineapple' boot of old leaf bases near the top
  for (let i = 0; i < 26; i++) {
    const a = i * 2.39996, y = top[1] - 0.2 - (i / 26) * 1.4;
    M.seg([top[0], y, top[2]], add([top[0], y, top[2]], mul(norm([Math.cos(a), 0.9, Math.sin(a)]), 0.36)), 0.08, 0.05, jit(hx('#7d5f40'), r, 0.2), 0.5);
  }
  if (v === 2) { // a skirt of dead fronds hanging against the trunk
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2, y0 = top[1] - 0.6 - r() * 0.4;
      const p0 = [top[0] + Math.cos(a) * 0.3, y0, top[2] + Math.sin(a) * 0.3];
      M.seg(p0, [p0[0] + Math.cos(a) * 0.55, y0 - 1.7 - r() * 0.6, p0[2] + Math.sin(a) * 0.55], 0.16, 0.1, jit(hx('#9a7a52'), r, 0.25), 0.55);
    }
  }
  // stylized: a round head of broad fans, each facing outward, vivid green with lighter split tips
  const nL = 26, green = hx('#4e9a38'), tipC = hx('#8cc455');
  for (let i = 0; i < nL; i++) {
    const age = i / nL;
    const az = i * 2.39996 + r() * 0.3, pitch = (76 - age * 108 + (r() - 0.5) * 12) * DEG;
    const dir = [Math.cos(az) * Math.cos(pitch), Math.sin(pitch), Math.sin(az) * Math.cos(pitch)];
    const pl = 0.85 + r() * 0.4;
    const P = add(add(top, mul(dir, pl)), [0, -0.12 * pl * Math.cos(pitch), 0]);
    M.seg(top, P, 0.05, 0.035, hx('#9aa860'), 0.6);
    // each fan faces outward and up (a rounded head from every side); pleated rays spread over
    // ~260 degrees around the blade's upper edge and their split tips hang
    const bn = norm(add(dir, [0, 0.35, 0]));
    const fu = norm(add([0, 1, 0], mul(bn, -bn[1]))); // 'up' within the blade
    const side = norm(cross(bn, fu));
    const nr = 18, ao = 0.62 + 0.38 * (1 - age);
    for (let k = 0; k < nr; k++) {
      const th = (-130 + (260 * k) / (nr - 1)) * DEG;
      const rd = norm(add(add(mul(fu, Math.cos(th)), mul(side, Math.sin(th))), mul(bn, -0.2 * (1 - Math.cos(th)) * 0.5)));
      const L1 = 0.42 + r() * 0.06, L2 = 0.32 + r() * 0.12;
      const mid = add(P, mul(rd, L1));
      const tip = add(mid, add(mul(rd, L2 * 0.75), [0, -L2 * (0.55 + 0.35 * Math.abs(Math.sin(th))), 0]));
      const pleat = norm(add(bn, mul(rd, 0), mul(side, 0)).map((x, q) => x + (k % 2 ? 0.25 : -0.25) * side[q]));
      const c = jit(vivid(mix(green, tipC, 0.3 * r()), 1.15, 1.05), r, 0.05);
      M.seg(P, mid, 0.03, 0.078, c, ao * 0.84, { n: pleat, ao2: ao });
      M.seg(mid, tip, 0.068, 0.02, c, ao, { n: pleat, c2: mix(c, tipC, 0.55), ao2: ao * 0.96 });
    }
  }
  M.crownY = top[1]; M.crownR = 2.1; M.sway = 1.15;
  return M;
}

// ------------------------------------------------------------------ broadleaf trees
function broadleaf(v) {
  const r = rng(3000 + v), M = new Model();
  if (v === 0) { // rounded Indian laurel / ficus
    const t = trunk(M, 2.6, 0.24, 0.17, hx('#6f5a46'));
    crown(M, r, { c: [0, 4.6, 0], rad: [2.8, 2.2, 2.8], clumps: 28, cr: [0.65, 1.05], from: t, pal: pal('#2f6a2a', '#3b7a30', '#356f2c', '#44833a'), topTint: '#6f9f45', flatBottom: 0.6 });
  } else if (v === 1) { // clipped formal dome
    const t = trunk(M, 2.2, 0.22, 0.17, hx('#6f5a46'));
    crown(M, r, { c: [0, 4.0, 0], rad: [2.6, 1.85, 2.6], clumps: 34, cr: [0.5, 0.75], shell: 0.86, from: t, pal: pal('#3a7a2f', '#44863a', '#3f8034'), topTint: '#7aa84c', flatBottom: 0.45, branchP: 0.2 });
  } else { // open, spreading (albizia / lebbeck)
    const t = trunk(M, 3.0, 0.26, 0.2, hx('#75604a'), { lean: [0.04, 0.02] });
    for (let k = 0; k < 4; k++) { const a = k * 1.7 + 0.3; M.seg(t, [Math.cos(a) * 2.0, 4.4, Math.sin(a) * 2.0], 0.15, 0.08, hx('#6a5644'), 0.5, { ao2: 0.7 }); }
    crown(M, r, { topBias: 0.4, c: [0, 5.1, 0], rad: [3.5, 1.75, 3.5], clumps: 34, cr: [0.6, 0.95], from: t, pal: pal('#5a8f3c', '#6a9c45', '#4f8536'), topTint: '#8db35a', flatBottom: 0.5, branchP: 0.85, branchR: 0.1 });
  }
  M.sway = 0.55;
  return M;
}

function neem(v) {
  const r = rng(4000 + v), M = new Model();
  const rad = [[3.0, 2.7, 3.0], [2.6, 3.2, 2.6], [3.4, 2.4, 3.4]][v];
  const t = trunk(M, 3.0, 0.27, 0.2, hx('#5f4c3c'), { lean: [[0.02, 0.03], [-0.03, 0.0], [0.03, -0.02]][v] });
  crown(M, r, { c: [0, 3.0 + rad[1] * 0.95, 0], rad, clumps: 32, cr: [0.7, 1.1], from: t, pal: pal('#285c24', '#2f6a2a', '#3a7530', '#24561f'), topTint: '#5f9440', flatBottom: 0.55 });
  M.sway = 0.5;
  return M;
}

function conocarpus(v) {
  const r = rng(5000 + v), M = new Model();
  const t = trunk(M, 0.9, 0.15, 0.12, hx('#6a5644'));
  if (v === 0) crown(M, r, { c: [0, 3.5, 0], rad: [1.3, 3.0, 1.3], clumps: 24, cr: [0.45, 0.7], from: t, pal: pal('#3a7a30', '#46863a', '#2f6d2b'), topTint: '#6a9e48', branchP: 0.3 });
  else if (v === 1) crown(M, r, { c: [0, 3.3, 0], rad: [1.55, 3.0, 1.55], shape: (dy) => 1 - 0.55 * Math.max(0, dy), clumps: 26, cr: [0.4, 0.62], shell: 0.85, from: t, pal: pal('#3d7c31', '#4a8a3a'), topTint: '#74a64e', branchP: 0.2 });
  else crown(M, r, { c: [0, 2.9, 0], rad: [1.7, 2.3, 1.7], clumps: 24, cr: [0.45, 0.7], from: t, pal: pal('#356f2c', '#41803a', '#2d6728'), topTint: '#68a046', branchP: 0.3 });
  M.sway = 0.4;
  return M;
}

// Royal poinciana (flame tree): low, wide umbrella of ferny green ablaze with scarlet-orange flowers
function flameTree(v) {
  const r = rng(6000 + v), M = new Model();
  const t = trunk(M, 2.2, 0.32, 0.26, hx('#7c6a58'), { lean: [[0.05, 0.0], [-0.04, 0.04], [0.0, -0.05]][v] });
  for (let k = 0; k < 5; k++) {
    const a = k * 1.26 + r() * 0.4, d = 2.2 + r() * 0.9;
    M.limb((s) => [t[0] + Math.cos(a) * d * s, t[1] + 1.9 * Math.sin(s * 1.4), t[2] + Math.sin(a) * d * s], 5, 0.16, 0.07, hx('#776654'), 0.45, 0.62);
  }
  crown(M, r, {
    c: [0, 4.5, 0], rad: [4.5, 1.35, 4.5], clumps: 50, cr: [0.65, 1.05], from: t, flatBottom: 0.35, shell: 0.72, branchP: 0.4, topBias: 0.6,
    pal: pal('#5c9a3f', '#4f8d37', '#68a446'), topTint: '#86b85a',
    flowers: { p: [0.7, 0.52, 0.36][v], top: true, r: 0.12, cols: pal('#ec5a26', '#f26a2c', '#e44c22', '#f47c34', '#ee6228') },
  });
  M.sway = 0.45;
  return M;
}

// Yellow flame / golden shower: rounded crown with yellow blossom on top (and hanging chains)
function yellowTree(v) {
  const r = rng(7000 + v), M = new Model();
  const t = trunk(M, 2.8, 0.25, 0.18, hx('#76624e'));
  const clumps = crown(M, r, {
    c: [0, 5.0, 0], rad: [3.0, 2.3, 3.0], clumps: 30, cr: [0.65, 1.0], from: t, flatBottom: 0.55, topBias: 0.3,
    pal: pal('#4f8a38', '#5a9640', '#467f33'), topTint: '#7eae50',
    flowers: { p: [0.66, 0.48, 0.36][v], top: true, r: 0.12, cols: pal('#f2c22a', '#f6cf40', '#eeb824', '#f4c834') },
  });
  if (v === 2) { // golden shower: pendant chains of yellow flowers below the outer clumps
    for (const k of clumps) {
      if (k.p[1] > 5.6 || r() < 0.35) continue;
      for (let c = 0; c < 3; c++) {
        const x = k.p[0] + (r() - 0.5) * k.cr, z = k.p[2] + (r() - 0.5) * k.cr, y = k.p[1] - k.cr * 0.5, L = 0.4 + r() * 0.35;
        for (let s = 0; s < 9; s++) M.leaf([x + (r() - 0.5) * 0.08, y - (s / 9) * L, z + (r() - 0.5) * 0.08], 0.06, norm([r() - 0.5, 0.3, r() - 0.5]), jit(hx('#f5cf2e'), r, 0.15), 0.8);
      }
    }
  }
  M.sway = 0.55;
  return M;
}

// Ghaf (Prosopis cineraria), the national tree: twisted stems, arching branches, weeping grey-green
function ghaf(v) {
  const r = rng(8000 + v), M = new Model();
  const bark = hx('#6e5f50'), stems = v === 1 ? 3 : 2;
  const tops = [];
  for (let s = 0; s < stems; s++) {
    const a = s * 2.4 + r() * 0.6, h = 2.3 + r() * 0.6;
    tops.push(M.limb((t) => [Math.cos(a) * 0.5 * t + Math.sin(t * 5 + s) * 0.08, h * t, Math.sin(a) * 0.5 * t], 6, 0.17, 0.12, bark, 0.5, 0.6));
  }
  const greys = pal('#6f9a4c', '#7aa555', '#648f45', '#86ae5e');
  // a soft grey-green dome over the stems (what you mostly see from above)...
  crown(M, r, { c: [0, 3.45, 0], rad: [2.7, 1.3, 2.7], lit: 1.0, clumps: 24, cr: [0.5, 0.8], from: tops[0], branchP: 0.25, branchR: 0.07, bark,
    pal: greys, topTint: '#9cc06a', flatBottom: 0.3, topBias: 0.5 });
  // ...with long arching branches whose foliage weeps over the edge
  for (let k = 0; k < 13; k++) {
    const st = tops[k % stems], a = k * 2.3 + r() * 0.5, L = 2.3 + r() * 1.2, up = 1.2 + r() * 0.6;
    const f = (t) => [st[0] + Math.cos(a) * L * t, st[1] + up * t - (up + 0.9) * t * t * 1.1, st[2] + Math.sin(a) * L * t];
    M.limb(f, 6, 0.09, 0.025, bark, 0.45, 0.7);
    for (let j = 0; j < 4; j++) { // weeping tufts of foliage hanging along the branch
      const t = 0.3 + (j / 4) * 0.7, p = f(t), cr = 0.6 + r() * 0.25;
      const tc = jit(vivid(pick(greys, r), 1.3, 1.0), r, 0.05).map(clamp01), tq = [p[0], p[1] - cr * 0.45, p[2]], tn = norm([Math.cos(a), 0.25, Math.sin(a)]);
      M.lobe(tq, cr, tn, mul(tc, 0.8), clamp01(0.5 + 0.5 * t), r() * 100);
      leaves(M, r, tq, cr, tn, tn, tc, clamp01(0.5 + 0.5 * t), 0.22, 60);
    }
  }
  M.crownY = 3.2; M.crownR = 3.3; M.sway = 0.75;
  return M;
}

// Frangipani: candelabra branching, leaf rosettes at the tips and clusters of flowers
function frangipani(v) {
  const r = rng(9000 + v), M = new Model();
  const bark = hx('#9a8d7b');
  const t = trunk(M, 1.15, 0.15, 0.12, bark);
  const tips = [];
  const grow = (p, a, tilt, L, rr, depth) => {
    const d = norm([Math.sin(tilt) * Math.cos(a), Math.cos(tilt), Math.sin(tilt) * Math.sin(a)]);
    const e = add(p, mul(d, L));
    M.seg(p, e, rr, rr * 0.85, bark, 0.55, { ao2: 0.75 });
    if (depth <= 1) tips.push(e);
    if (depth <= 0) return;
    for (const s of [-1, 1]) grow(e, a + s * (0.5 + r() * 0.5), Math.min(1.2, tilt + 0.1 + r() * 0.15), L * 0.72, rr * 0.75, depth - 1);
  };
  for (let k = 0; k < 3; k++) grow(t, k * 2.1 + r() * 0.4, 0.55 + r() * 0.2, 1.0, 0.11, 3);
  const leafC = pal('#3e7a33', '#4a8a3a', '#356d2c');
  const flowerC = [pal('#fbf7ea', '#f8f1dc'), pal('#f29ab9', '#f7b8cf', '#e77ea3'), pal('#fbf3dc', '#f8e9b8')][v];
  for (const p of tips) {
    const lr = 0.42 + r() * 0.1, c = [p[0], p[1] + lr * 0.35, p[2]];
    const fc = jit(vivid(pick(leafC, r)), r, 0.05).map(clamp01), fn = norm([p[0], 1.2, p[2]]), fa = 0.85 + 0.15 * clamp01((p[1] - 1.5) / 1.5);
    M.lobe(c, lr, fn, mul(fc, 0.8), fa, r() * 100);
    leaves(M, r, c, lr, fn, [0, 1, 0], fc, fa, 0.3, 40);
    const nFl = 5 + Math.floor(r() * 5);
    for (let i = 0; i < nFl; i++) {
      const d = sphereDir(r); d[1] = Math.abs(d[1]) * 0.7 + 0.3;
      const dn = norm(d), fp = add(c, mul(dn, lr * 0.98));
      M.leaf(fp, 0.085, dn, jit(pick(flowerC, r), r, 0.05), 1);
      M.leaf(add(fp, mul(dn, 0.012)), 0.028, dn, hx('#f2c84a'), 1);
    }
  }
  M.crownY = 2.6; M.crownR = 2.0; M.sway = 0.35;
  return M;
}

// ------------------------------------------------------------------ shrubs
function bush(v) {
  const r = rng(10000 + v), M = new Model();
  crown(M, r, {
    c: [0, 0.78, 0], rad: [1.15, 0.8, 1.15], clumps: 20, cr: [0.38, 0.58], shell: 0.3, flatBottom: 0.15, branches: false,
    pal: pal('#3c7a2e', '#4a8a37', '#346d29'), topTint: '#6aa046',
    flowers: v === 1 ? { dots: 46, r: 0.1, cols: pal('#d8222a', '#e8403a', '#c81a2a') } : v === 2 ? { dots: 56, r: 0.09, cols: pal('#f3a0bc', '#fbe8ee', '#e87aa0') } : null,
  });
  M.sway = 0.15;
  return M;
}

function bougainvillea(v) {
  const r = rng(11000 + v), M = new Model();
  const cols = [pal('#c8237d', '#d6338d', '#b51a6c', '#e04a9a'), pal('#e0569e', '#ea79b4', '#cc3f8b', '#f095c4'), pal('#e8562a', '#f07a3a', '#d9442c', '#f5a04a')][v];
  crown(M, r, {
    c: [0, 0.95, 0], rad: [1.5, 0.98, 1.5], clumps: 20, cr: [0.38, 0.64], shell: 0.35, flatBottom: 0.2, branches: false,
    pal: pal('#3f7a2e', '#4b8838'), flowers: { p: 0.62, top: true, r: 0.065, cols },
  });
  // a few arching canes spraying out of the mound
  for (let k = 0; k < 4; k++) {
    const a = r() * Math.PI * 2, p = [Math.cos(a) * 1.3, 1.5 + r() * 0.4, Math.sin(a) * 1.3];
    M.lobe(p, 0.36, norm([p[0], 0.8, p[2]]), vivid(pick(cols, r)), 0.9, r() * 100);
  }
  M.sway = 0.2;
  return M;
}

// species index -> builder (matches the tree type codes in the map data)
export const BUILDERS = [datePalm, broadleaf, fanPalm, bush, bougainvillea, flameTree, yellowTree, ghaf, neem, conocarpus, frangipani];

// ------------------------------------------------------------------ rasteriser
// A lobe's outline: soft round scallops (the clusters of a stylized crown) with a fine fringe of leaf tips, tabled
// over the angle once per seed
const ET = 128, EDGE_MAX = 1.07, EDGES = new Map();
function edgeTable(seed) {
  let t = EDGES.get(seed);
  if (t) return t;
  t = new Float32Array(ET);
  const m = 6 + (Math.floor(seed * 7.3) % 4);
  for (let a = 0; a < ET; a++) {
    const th = (a / ET) * Math.PI * 2;
    const big = Math.abs(Math.sin(th * m * 0.5 + seed)), fine = 1 - Math.abs(Math.sin(th * 13 + seed * 2.1));
    t[a] = 0.93 + 0.1 * big + 0.035 * fine * fine;
  }
  EDGES.set(seed, t);
  return t;
}
// A tileable field of small domed leaf clusters (Worley F1 over a jittered 8 x 8 grid, 64 px)
// that gives every lobe a leafy surface: lighter domes, darker gaps, normals rolling over each dome
const LT = 64, LG = 8, LS = LT / LG / 0.42; // leaf-field texels per metre (clusters ~0.42 m)
const LEAF = (() => {
  const r = rng(77), P = [];
  for (let j = 0; j < LG; j++) for (let i = 0; i < LG; i++) P.push([(i + 0.15 + 0.7 * r()) / LG, (j + 0.15 + 0.7 * r()) / LG]);
  const h = new Float32Array(LT * LT), gx = new Float32Array(LT * LT), gy = new Float32Array(LT * LT);
  for (let y = 0; y < LT; y++) for (let x = 0; x < LT; x++) {
    const u = (x + 0.5) / LT, v = (y + 0.5) / LT;
    let best = 9, bx = 0, by = 0;
    for (const q of P) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const dx = u - (q[0] + ox), dy = v - (q[1] + oy), d = dx * dx + dy * dy;
      if (d < best) { best = d; bx = dx; by = dy; }
    }
    const d = Math.sqrt(best) * LG, k = y * LT + x;
    h[k] = Math.max(0, 1 - d * d * 1.7);
    gx[k] = bx * LG; gy[k] = by * LG;
  }
  return { h, gx, gy };
})();
// atan2 to about 0.005 rad, several times cheaper than Math.atan2 in the inner loop
function atan2f(y, x) {
  const ax = Math.abs(x), ay = Math.abs(y), mx = ax > ay ? ax : ay;
  if (mx === 0) return 0;
  const a = (ax < ay ? ax : ay) / mx, q = a * a;
  let rr = ((-0.0464964749 * q + 0.15931422) * q - 0.327622764) * q * a + a;
  if (ay > ax) rr = 1.5707963 - rr;
  if (x < 0) rr = 3.1415927 - rr;
  return y < 0 ? -rr : rr;
}

function rasterise(M, elevDeg, B) {
  const e = elevDeg * DEG, ce = Math.cos(e), se = Math.sin(e);
  const nL = M.L.length, nS = M.S.length;
  const LP = new Float32Array(nL * 10), SP = new Float32Array(nS * 11);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < nL; i++) {
    const l = M.L[i], p = l.p, n = l.n;
    const vx = p[0], vy = p[1] * ce - p[2] * se, vz = p[1] * se + p[2] * ce;
    let nx = n[0], ny = n[1] * ce - n[2] * se, nz = n[1] * se + n[2] * ce;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; } // leaves are two-sided
    const rr = l.r * (0.55 + 0.45 * nz);
    // the stroke's direction on screen (its tangent seen from this elevation)
    let tx = 0, ty = 1;
    if (l.t) { const ux = l.t[0], uy = l.t[1] * ce - l.t[2] * se, ul = Math.hypot(ux, uy); if (ul > 0.15) { tx = ux / ul; ty = uy / ul; } }
    const asp = l.asp || 1, ext = rr * Math.sqrt(asp);
    LP.set([vx, vy, vz, rr, nx, ny, nz, tx, ty, asp], i * 10);
    if (vx - ext < x0) x0 = vx - ext; if (vx + ext > x1) x1 = vx + ext; if (vy - ext < y0) y0 = vy - ext; if (vy + ext > y1) y1 = vy + ext;
  }
  for (let i = 0; i < nS; i++) {
    const s = M.S[i], a = s.a, b = s.b;
    const ax = a[0], ay = a[1] * ce - a[2] * se, az = a[1] * se + a[2] * ce;
    const bx = b[0], by = b[1] * ce - b[2] * se, bz = b[1] * se + b[2] * ce;
    let fx = 0, fy = 0, fz = 0;
    if (s.n) { fx = s.n[0]; fy = s.n[1] * ce - s.n[2] * se; fz = s.n[1] * se + s.n[2] * ce; if (fz < 0) { fx = -fx; fy = -fy; fz = -fz; } }
    SP.set([ax, ay, az, bx, by, bz, s.ra, s.rb, fx, fy, fz], i * 11);
    const rm = Math.max(s.ra, s.rb);
    x0 = Math.min(x0, ax - rm, bx - rm); x1 = Math.max(x1, ax + rm, bx + rm);
    y0 = Math.min(y0, ay - rm, by - rm); y1 = Math.max(y1, ay + rm, by + rm);
  }
  const nB = M.B.length, BP = new Float32Array(nB * 7);
  for (let i = 0; i < nB; i++) {
    const b = M.B[i], p = b.p, n = b.n;
    const vx = p[0], vy = p[1] * ce - p[2] * se, vz = p[1] * se + p[2] * ce;
    let nx = n[0], ny = n[1] * ce - n[2] * se, nz = n[1] * se + n[2] * ce;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    BP.set([vx, vy, vz, b.r, nx, ny, nz], i * 7);
    const e = b.r * EDGE_MAX;
    if (vx - e < x0) x0 = vx - e; if (vx + e > x1) x1 = vx + e; if (vy - e < y0) y0 = vy - e; if (vy + e > y1) y1 = vy + e;
  }
  // nearest lobes first: most hidden texels are then rejected before their outline is looked up
  const order = Array.from({ length: nB }, (_, i) => i).sort((a, b) => BP[b * 7 + 2] + BP[b * 7 + 3] - (BP[a * 7 + 2] + BP[a * 7 + 3]));
  const ext = Math.max(x1 - x0, y1 - y0);
  const hw = Math.max(-x0, x1) + ext * 0.02 + 0.04;
  const bot = y0 - ext * 0.02 - 0.04, H = y1 - y0 + ext * 0.04 + 0.08;
  const sx = R2 / (2 * hw), sy = R2 / H;
  const { Z, C, N, A } = B;
  Z.fill(-1e9);

  // canopy lobes: spheres with a scalloped, leafy outline; the normal blends the lobe's sphere with the canopy's
  // volume, so light rolls over each lobe and across the whole crown
  for (const i of order) {
    const o = i * 7, vx = BP[o], vy = BP[o + 1], vz = BP[o + 2], rr = BP[o + 3], cnx = BP[o + 4], cny = BP[o + 5], cnz = BP[o + 6];
    const b = M.B[i], cr = b.c[0], cg = b.c[1], cb = b.c[2], ao = b.ao, et = edgeTable(b.seed);
    const lox = 100 + b.seed * 0.731, loy = 100 + b.seed * 1.37; // where this lobe samples the leaf field (positive)
    const cx = (vx + hw) * sx, cy = (vy - bot) * sy, ex = rr * EDGE_MAX, ex2 = ex * ex;
    const i0 = Math.max(0, Math.floor(cx - ex * sx)), i1 = Math.min(R2 - 1, Math.ceil(cx + ex * sx));
    const j0 = Math.max(0, Math.floor(cy - ex * sy)), j1 = Math.min(R2 - 1, Math.ceil(cy + ex * sy));
    for (let j = j0; j <= j1; j++) {
      const oy = (j + 0.5 - cy) / sy, oy2 = oy * oy;
      for (let ii = i0; ii <= i1; ii++) {
        const ox = (ii + 0.5 - cx) / sx, d2 = ox * ox + oy2;
        if (d2 > ex2) continue;
        const k = j * R2 + ii;
        // the nearest this lobe can be here (its widest outline): behind what is drawn, skip
        if (vz + rr * Math.sqrt(1 - d2 / ex2) <= Z[k]) continue;
        let fa = (atan2f(oy, ox) * (0.5 / Math.PI) + 1) * ET;
        let ia = fa | 0; const fr = fa - ia; ia %= ET;
        const edge = et[ia] + (et[(ia + 1) % ET] - et[ia]) * fr;
        const dn = Math.sqrt(d2) / (rr * edge);
        if (dn >= 1) continue;
        const h = Math.sqrt(1 - dn * dn), z = vz + rr * h;
        if (z <= Z[k]) continue;
        Z[k] = z;
        // mostly the lobe's own sphere (a round cluster with its own light and shade), tilted toward the crown's
        // outward direction so the crown lights as one volume
        const sxn = ox / (rr * edge), syn = oy / (rr * edge);
        // leafy surface: small domed leaf clusters over the lobe (each lobe samples the field at its own offset)
        const lk = ((((ox + lox) * LS) | 0) & (LT - 1)) + (((((oy + loy) * LS) | 0) & (LT - 1)) * LT);
        const lh = LEAF.h[lk], lt = 0.16 * lh;
        let mx = sxn * 0.86 + cnx * 0.3 + LEAF.gx[lk] * lt, my = syn * 0.86 + cny * 0.3 + LEAF.gy[lk] * lt, mz = h * 0.86 + cnz * 0.3;
        const ml = Math.hypot(mx, my, mz) || 1; mx /= ml; my /= ml; mz /= ml;
        // painted roundness: each cluster a little lighter on top and toward its centre, a soft darker rim where
        // lobes overlap (cluster outlines), darker gaps between the leaf clusters
        const rim = ((0.9 + 0.1 * h + 0.09 * syn) - (dn > 0.86 ? (dn - 0.86) * 1.0 : 0)) * (0.9 + 0.13 * lh);
        C[k * 3] = cr * rim; C[k * 3 + 1] = cg * rim; C[k * 3 + 2] = cb * rim;
        N[k * 3] = mx; N[k * 3 + 1] = my; N[k * 3 + 2] = mz; A[k] = ao * (0.8 + 0.2 * h);
      }
    }
  }

  // leaves and flowers: domed strokes, pointed at both ends when they have an aspect, a little lighter along the
  // midrib and toward the tip (a brush mark rather than a dot)
  for (let i = 0; i < nL; i++) {
    const o = i * 10, vx = LP[o], vy = LP[o + 1], vz = LP[o + 2], rr = LP[o + 3], nx = LP[o + 4], ny = LP[o + 5], nz = LP[o + 6];
    const tx = LP[o + 7], ty = LP[o + 8], asp = LP[o + 9], maj = rr * Math.sqrt(asp), mnr = rr / Math.sqrt(asp);
    const l = M.L[i], cr = l.c[0], cg = l.c[1], cb = l.c[2], ao = l.ao;
    const cx = (vx + hw) * sx, cy = (vy - bot) * sy, rx = Math.max(0.6, maj * sx), ry = Math.max(0.6, maj * sy);
    const i0 = Math.max(0, Math.floor(cx - rx)), i1 = Math.min(R2 - 1, Math.ceil(cx + rx));
    const j0 = Math.max(0, Math.floor(cy - ry)), j1 = Math.min(R2 - 1, Math.ceil(cy + ry));
    for (let j = j0; j <= j1; j++) {
      const ey = (j + 0.5 - cy) / sy;
      for (let ii = i0; ii <= i1; ii++) {
        const ex = (ii + 0.5 - cx) / sx;
        const u = (ex * tx + ey * ty) / maj, v = (-ex * ty + ey * tx) / mnr;
        const taper = asp > 1.05 ? 1 - 0.38 * u * u : 1;
        const d2 = u * u + (v * v) / (taper * taper); if (d2 > 1) continue;
        const k = j * R2 + ii, z = vz + rr * 0.45 * Math.sqrt(1 - d2);
        if (z <= Z[k]) continue;
        Z[k] = z;
        const rim = 0.86 + 0.16 * (1 - d2) + 0.05 * u - (asp > 1.05 ? 0.05 * Math.min(1, Math.abs(v) * 1.6) : 0);
        C[k * 3] = cr * rim; C[k * 3 + 1] = cg * rim; C[k * 3 + 2] = cb * rim;
        const bx = ex / maj, by = ey / maj;
        let mx = nx + bx * 0.28, my = ny + by * 0.28, mz = nz; const ml = Math.sqrt(mx * mx + my * my + mz * mz); mx /= ml; my /= ml; mz /= ml;
        N[k * 3] = mx; N[k * 3 + 1] = my; N[k * 3 + 2] = mz; A[k] = ao;
      }
    }
  }
  // trunks, branches, rachises and leaflets: capsules (round) or flat blades (with a normal)
  for (let i = 0; i < nS; i++) {
    const o = i * 11, ax = SP[o], ay = SP[o + 1], az = SP[o + 2], bx = SP[o + 3], by = SP[o + 4], bz = SP[o + 5];
    const ra = SP[o + 6], rb = SP[o + 7], fx = SP[o + 8], fy = SP[o + 9], fz = SP[o + 10], flat = fx !== 0 || fy !== 0 || fz !== 0;
    const s = M.S[i], c0 = s.c, c1 = s.c2, bark = s.bark, sL = s.L, s0 = s.s0;
    const rm = Math.max(ra, rb);
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - rm + hw) * sx)), i1 = Math.min(R2 - 1, Math.ceil((Math.max(ax, bx) + rm + hw) * sx));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - rm - bot) * sy)), j1 = Math.min(R2 - 1, Math.ceil((Math.max(ay, by) + rm - bot) * sy));
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, Ld = Math.sqrt(L2) || 1;
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) / sy + bot;
      for (let ii = i0; ii <= i1; ii++) {
        const px = (ii + 0.5) / sx - hw;
        let t = L2 > 1e-10 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - (ax + dx * t), qy = py - (ay + dy * t), d = Math.sqrt(qx * qx + qy * qy), rr = ra + (rb - ra) * t;
        if (d >= rr) continue;
        const sr = d / rr, h = Math.sqrt(1 - sr * sr);
        const k = j * R2 + ii, z = az + (bz - az) * t + rr * (flat ? 0.15 : 1) * h;
        if (z <= Z[k]) continue;
        Z[k] = z;
        let shade = 1;
        if (bark) {
          const u = s0 + t * sL, side = (qx * -dy + qy * dx) / (Ld * rr), ang = Math.asin(side < -1 ? -1 : side > 1 ? 1 : side);
          if (bark === 1) { // date palm: criss-cross diamonds of old leaf bases
            const p1 = (u / 0.24 + ang * 0.55 + 10) % 1, p2 = (u / 0.24 - ang * 0.55 + 10) % 1;
            const ridge = Math.min(Math.abs(p1 - 0.5), Math.abs(p2 - 0.5)) * 2;
            shade = 0.68 + 0.36 * Math.min(1, ridge * 2.2);
          } else if (bark === 2) { // washingtonia: fine horizontal rings
            const ring = (u / 0.13) % 1; shade = 0.86 + 0.14 * Math.min(1, ring * 5);
          }
        } else if (!flat) shade = 0.92 + 0.08 * Math.sin(t * sL * 9 + i);
        const cr = c0[0] + (c1[0] - c0[0]) * t, cg = c0[1] + (c1[1] - c0[1]) * t, cb = c0[2] + (c1[2] - c0[2]) * t;
        C[k * 3] = cr * shade; C[k * 3 + 1] = cg * shade; C[k * 3 + 2] = cb * shade;
        let nx, ny, nz;
        if (flat) { nx = fx + qx / rr * 0.18; ny = fy + qy / rr * 0.18; nz = fz; const l = Math.sqrt(nx * nx + ny * ny + nz * nz); nx /= l; ny /= l; nz /= l; }
        else if (d > 1e-6) { nx = (qx / d) * sr; ny = (qy / d) * sr; nz = h; } else { nx = 0; ny = 0; nz = 1; }
        N[k * 3] = nx; N[k * 3 + 1] = ny; N[k * 3 + 2] = nz;
        A[k] = (s.ao + (s.ao2 - s.ao) * t) * (flat ? 1 : 0.82 + 0.18 * h);
      }
    }
  }
  return { hw, bot, H };
}

// downsample, smooth depth, bleed colours into the empty texels (clean mipmaps) and encode
function resolve(B, out, layer) {
  const { Z, C, N, A } = B;
  const n = RES * RES;
  const cov = new Float32Array(n), col = new Float32Array(n * 3), nr = new Float32Array(n * 3), ao = new Float32Array(n), dz = new Float32Array(n);
  let zmin = Infinity, zmax = -Infinity;
  for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
    let c = 0, r = 0, g = 0, b = 0, x = 0, y = 0, z = 0, a = 0, d = 0;
    for (let sj = 0; sj < SS; sj++) for (let si = 0; si < SS; si++) {
      const k = (j * SS + sj) * R2 + i * SS + si;
      if (Z[k] < -1e8) continue;
      c++; r += C[k * 3]; g += C[k * 3 + 1]; b += C[k * 3 + 2]; x += N[k * 3]; y += N[k * 3 + 1]; z += N[k * 3 + 2]; a += A[k]; d += Z[k];
    }
    const q = j * RES + i;
    if (!c) continue;
    cov[q] = c / (SS * SS);
    col[q * 3] = r / c; col[q * 3 + 1] = g / c; col[q * 3 + 2] = b / c;
    const l = Math.sqrt(x * x + y * y + z * z) || 1; nr[q * 3] = x / l; nr[q * 3 + 1] = y / l; nr[q * 3 + 2] = z / l;
    ao[q] = a / c; dz[q] = d / c;
    if (dz[q] < zmin) zmin = dz[q]; if (dz[q] > zmax) zmax = dz[q];
  }
  if (!isFinite(zmin)) { zmin = 0; zmax = 1; }
  // smooth the depth a little so the crown surface has no hard internal steps (separable, masked)
  const has = new Uint8Array(n); for (let q = 0; q < n; q++) has[q] = cov[q] > 0 ? 1 : 0;
  {
    const tmp = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
        const q = j * RES + i; if (!has[q]) continue;
        let s = 0, w = 0;
        for (let o = -2; o <= 2; o++) { const ii = i + o; if (ii < 0 || ii >= RES) continue; const k = q + o; if (has[k]) { s += dz[k]; w++; } }
        tmp[q] = s / w;
      }
      for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
        const q = j * RES + i; if (!has[q]) continue;
        let s = 0, w = 0;
        for (let o = -2; o <= 2; o++) { const jj = j + o; if (jj < 0 || jj >= RES) continue; const k = q + o * RES; if (has[k]) { s += tmp[k]; w++; } }
        dz[q] = s / w;
      }
    }
  }
  // inked outline (illustrated look): colour darkens toward the silhouette over a few texels, so every crown,
  // frond and trunk is drawn with a dark edge; a two-pass chamfer distance to the nearest empty texel
  {
    const D = new Float32Array(n), W = 5.5;
    for (let q = 0; q < n; q++) D[q] = has[q] ? 99 : 0;
    for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
      const q = j * RES + i; if (!has[q]) continue;
      let d = D[q];
      if (i > 0) d = Math.min(d, D[q - 1] + 1); else d = Math.min(d, 1);
      if (j > 0) { d = Math.min(d, D[q - RES] + 1); if (i > 0) d = Math.min(d, D[q - RES - 1] + 1.41); if (i < RES - 1) d = Math.min(d, D[q - RES + 1] + 1.41); } else d = Math.min(d, 1);
      D[q] = d;
    }
    for (let j = RES - 1; j >= 0; j--) for (let i = RES - 1; i >= 0; i--) {
      const q = j * RES + i; if (!has[q]) continue;
      let d = D[q];
      if (i < RES - 1) d = Math.min(d, D[q + 1] + 1); else d = Math.min(d, 1);
      if (j < RES - 1) { d = Math.min(d, D[q + RES] + 1); if (i < RES - 1) d = Math.min(d, D[q + RES + 1] + 1.41); if (i > 0) d = Math.min(d, D[q + RES - 1] + 1.41); } else d = Math.min(d, 1);
      D[q] = d;
      if (d < W) { const t = d / W, k = 0.42 + 0.58 * t * t * (3 - 2 * t); col[q * 3] *= k * 0.92; col[q * 3 + 1] *= k * 0.96; col[q * 3 + 2] *= k * 1.06; }
    }
  }
  // dilate: empty texels next to the canopy take the average of filled neighbours, ring by ring
  // (keeps mip levels from bleeding background colour into the leaves' edges)
  const filled = has.slice();
  {
    const idx = new Int32Array(n), val = new Float32Array(n * 8);
    for (let it = 0; it < 6; it++) {
      let m = 0;
      for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
        const q = j * RES + i; if (filled[q]) continue;
        let w = 0, r = 0, g = 0, b = 0, x = 0, y = 0, z = 0, a = 0, d = 0;
        for (let oj = -1; oj <= 1; oj++) {
          const jj = j + oj; if (jj < 0 || jj >= RES) continue;
          for (let oi = -1; oi <= 1; oi++) {
            const ii = i + oi; if (ii < 0 || ii >= RES || (oi === 0 && oj === 0)) continue;
            const k = jj * RES + ii; if (!filled[k]) continue;
            w++; r += col[k * 3]; g += col[k * 3 + 1]; b += col[k * 3 + 2]; x += nr[k * 3]; y += nr[k * 3 + 1]; z += nr[k * 3 + 2]; a += ao[k]; d += dz[k];
          }
        }
        if (!w) continue;
        idx[m] = q; const v = m * 8;
        val[v] = r / w; val[v + 1] = g / w; val[v + 2] = b / w; val[v + 3] = x / w; val[v + 4] = y / w; val[v + 5] = z / w; val[v + 6] = a / w; val[v + 7] = d / w;
        m++;
      }
      for (let f = 0; f < m; f++) {
        const q = idx[f], v = f * 8;
        col[q * 3] = val[v]; col[q * 3 + 1] = val[v + 1]; col[q * 3 + 2] = val[v + 2];
        nr[q * 3] = val[v + 3]; nr[q * 3 + 1] = val[v + 4]; nr[q * 3 + 2] = val[v + 5]; ao[q] = val[v + 6]; dz[q] = val[v + 7]; filled[q] = 1;
      }
      if (!m) break;
    }
  }
  // whatever is still empty gets the layer average
  let m = 0, ar = 0, ag = 0, ab = 0, aa = 0, ad = 0;
  for (let q = 0; q < n; q++) if (has[q]) { m++; ar += col[q * 3]; ag += col[q * 3 + 1]; ab += col[q * 3 + 2]; aa += ao[q]; ad += dz[q]; }
  m = m || 1;
  const zr = Math.max(0.05, zmax - zmin);
  const o = layer * n * 4;
  for (let q = 0; q < n; q++) {
    if (!filled[q]) { col[q * 3] = ar / m; col[q * 3 + 1] = ag / m; col[q * 3 + 2] = ab / m; nr[q * 3] = 0; nr[q * 3 + 1] = 0; nr[q * 3 + 2] = 1; ao[q] = aa / m; dz[q] = ad / m; }
    const p = o + q * 4;
    out.albedo[p] = Math.round(clamp01(col[q * 3]) * 255);
    out.albedo[p + 1] = Math.round(clamp01(col[q * 3 + 1]) * 255);
    out.albedo[p + 2] = Math.round(clamp01(col[q * 3 + 2]) * 255);
    out.albedo[p + 3] = Math.round(cov[q] * 255);
    const l = Math.sqrt(nr[q * 3] * nr[q * 3] + nr[q * 3 + 1] * nr[q * 3 + 1] + nr[q * 3 + 2] * nr[q * 3 + 2]) || 1;
    out.normal[p] = Math.round((nr[q * 3] / l * 0.5 + 0.5) * 255);
    out.normal[p + 1] = Math.round((nr[q * 3 + 1] / l * 0.5 + 0.5) * 255);
    out.normal[p + 2] = Math.round(clamp01(ao[q]) * 255);
    out.normal[p + 3] = Math.round(clamp01((dz[q] - zmin) / zr) * 255);
  }
  return { zmin, zr };
}

export function buildTreeAtlas() {
  const t0 = Date.now();
  const n = RES * RES;
  const out = { res: RES, layers: LAYERS, elev: ELEV, split: ROW_SPLIT, albedo: new Uint8Array(LAYERS * n * 4), normal: new Uint8Array(LAYERS * n * 4), cells: new Float32Array(LAYERS * 2 * 4) };
  const B = { Z: new Float32Array(R2 * R2), C: new Float32Array(R2 * R2 * 3), N: new Float32Array(R2 * R2 * 3), A: new Float32Array(R2 * R2) };
  for (let s = 0; s < SPECIES; s++) for (let v = 0; v < VARIANTS; v++) {
    const M = BUILDERS[s](v);
    for (let e = 0; e < ELEV.length; e++) {
      const layer = (s * VARIANTS + v) * ELEV.length + e;
      const box = rasterise(M, ELEV[e], B);
      const z = resolve(B, out, layer);
      out.cells.set([box.hw, box.bot, box.H, z.zmin], layer * 4);
      out.cells.set([z.zr, M.crownY, M.crownR, M.sway], (LAYERS + layer) * 4);
    }
  }
  out.ms = Date.now() - t0;
  return out;
}
