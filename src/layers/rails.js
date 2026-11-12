// Dubai Metro Red Line + Dubai Tram + Palm Monorail.
//  - viaduct: one twin-track box girder per corridor (precast segmental look: cantilevered deck,
//    sloped webs, parapets) on single round columns with tapered hammerhead caps, every ~30 m
//  - ballastless track beds with steel rails, plinths and the third rail
//  - 5-car Red Line trains (white body, navy window band, blue stripe, wrap-around cab windscreen)
//    and Citadis-style trams; trains brake into stations, dwell, and pull away
//  - Palm Monorail: straddle-type concrete guideway beams on slim columns, 3-car trains (livery is
//    illustrative)
import * as THREE from 'three';
import { newBuilder, addRibbon, builderGeometry } from '../core/util.js';

// ---------------------------------------------------------------- paths
function chain(lines, tol = 2) {
  const pool = lines.map((l) => l.p.map((p) => p.slice()));
  const out = [];
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
  while (pool.length) {
    let cur = pool.shift(); let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i];
        if (near(cur[cur.length - 1], l[0])) cur = cur.concat(l.slice(1));
        else if (near(cur[cur.length - 1], l[l.length - 1])) cur = cur.concat(l.slice(0, -1).reverse());
        else if (near(cur[0], l[l.length - 1])) cur = l.slice(0, -1).concat(cur);
        else if (near(cur[0], l[0])) cur = l.slice(1).reverse().concat(cur);
        else continue;
        pool.splice(i, 1); grew = true; break;
      }
    }
    out.push(cur);
  }
  return out;
}

class Path {
  constructor(pts) {
    this.pts = pts; this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.length = this.cum[this.cum.length - 1];
  }
  at(s, out) {
    s = Math.max(0, Math.min(this.length, s));
    let lo = 0, hi = this.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
    const a = this.pts[lo], b = this.pts[hi], seg = this.cum[hi] - this.cum[lo] || 1, t = (s - this.cum[lo]) / seg;
    out.x = a[0] + (b[0] - a[0]) * t; out.n = a[1] + (b[1] - a[1]) * t; out.z = (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t;
    out.heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
    out.pitch = Math.atan2((b[2] || 0) - (a[2] || 0), seg);
    return out;
  }
  project(p) {
    let best = { d: Infinity, s: 0 };
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1], b = this.pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
      if (d < best.d) best = { d, s: this.cum[i - 1] + t * Math.sqrt(L2) };
    }
    return best;
  }
}

// ---------------------------------------------------------------- girder loft
// profile(hw) -> [[u, v, colour], ...] closed loop (u: left of travel, v: up from rail level);
// the colour belongs to the edge that starts at that point. Every edge gets its own vertices so
// the cross-section reads crisp while staying smooth along the length.
function loft(spines, profile, out) {
  const { pos, nor, col, idx } = out;
  for (const sp of spines) {
    if (sp.length < 2) continue;
    const frames = sp.map((p, i) => {
      const a = sp[Math.max(0, i - 1)], b = sp[Math.min(sp.length - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      return { x: p[0], y: p[1], z: p[2], hw: p[3] / 2, nx: -ty, ny: tx };
    });
    const prof0 = profile(frames[0].hw);
    const E = prof0.length;
    for (let e = 0; e < E; e++) {
      const base = pos.length / 3;
      for (const f of frames) {
        const pr = profile(f.hw);
        const A = pr[e], B = pr[(e + 1) % E];
        // outward normal of this edge in the cross-section (profile is listed clockwise seen from behind)
        let du = B[0] - A[0], dv = B[1] - A[1]; const dl = Math.hypot(du, dv) || 1; du /= dl; dv /= dl;
        const nu = -dv, nv = du;
        for (const P of [A, B]) {
          pos.push(f.x + f.nx * P[0], f.z + P[1], -(f.y + f.ny * P[0]));
          nor.push(f.nx * nu, nv, -f.ny * nu);
          col.push(...A[2]);
        }
      }
      for (let i = 0; i < frames.length - 1; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
}

const C = (hex) => new THREE.Color(hex).toArray();
const PAR = C('#e4dfd5'), FASCIA = C('#d9d3c8'), SOFFIT = C('#b9b3a7'), WEB = C('#cdc7bb'), DECK = C('#aaa59b');
// Metro: cantilevered deck slab over a trapezoid box, ~2.4 m deep, 1.1 m parapets with a cable walkway
const metroProfile = (hw) => [
  [-hw + 0.32, -0.3, DECK], [hw - 0.32, -0.3, PAR], [hw - 0.32, 0.8, PAR], [hw, 0.8, FASCIA], [hw, -0.62, SOFFIT],
  [hw * 0.64, -1.0, WEB], [hw * 0.38, -2.4, SOFFIT], [-hw * 0.38, -2.4, WEB], [-hw * 0.64, -1.0, SOFFIT],
  [-hw, -0.62, FASCIA], [-hw, 0.8, PAR], [-hw + 0.32, 0.8, PAR],
];
const tramProfile = (hw) => [
  [-hw + 0.25, -0.25, DECK], [hw - 0.25, -0.25, PAR], [hw - 0.25, 0.95, PAR], [hw, 0.95, FASCIA], [hw, -0.55, SOFFIT],
  [hw * 0.55, -1.25, WEB], [-hw * 0.55, -1.25, SOFFIT], [-hw, -0.55, FASCIA], [-hw, 0.95, PAR], [-hw + 0.25, 0.95, PAR],
];

// Monorail guideway: a 0.85 m wide, 1.6 m deep concrete beam; the train straddles its top
const BEAM = C('#dcd6cb'), BEAMS = C('#cfc9bd'), BEAMSOF = C('#b2aca0');
const monoProfile = () => [
  [-0.43, 0, BEAM], [0.43, 0, BEAMS], [0.43, -1.6, BEAMSOF], [-0.43, -1.6, BEAMS],
];

// round column + tapered hammerhead cap under the girder soffit
function piers(list, out) {
  const { pos, nor, col, idx } = out;
  const quad = (a, b, c, d, n, k) => {
    const base = pos.length / 3;
    for (const p of [a, b, c, d]) { pos.push(...p); nor.push(...n); col.push(...k); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const colC = C('#d4cec3'), capC = C('#cfc9bd');
  for (const [x, y, z, ang, w, kind] of list) {
    const metro = kind === 0, mono = kind === 2;
    const soffit = z + (metro ? -2.4 : mono ? -1.6 : -1.25), capD = metro ? 1.9 : mono ? 0.55 : 1.1;
    const capTop = metro ? Math.min(w * 0.38 + 0.6, 6.2) : mono ? 0.6 : w * 0.3, capBot = metro ? 1.7 : mono ? 0.5 : 0.9, capL = metro ? 1.4 : mono ? 0.75 : 0.9;
    const r = metro ? 1.25 : mono ? 0.62 : 0.8, yTop = soffit - capD;
    if (yTop < 0.8) continue;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    // local: a = along track, s = across
    const P = (a, s, h) => [x + ca * a - sa * s, h, -(y + sa * a + ca * s)];
    // column (16-gon)
    const N = 16;
    for (let i = 0; i < N; i++) {
      const t0 = (i / N) * Math.PI * 2, t1 = ((i + 1) / N) * Math.PI * 2;
      const p0 = P(Math.cos(t0) * r * 0.82, Math.sin(t0) * r, 0), p1 = P(Math.cos(t1) * r * 0.82, Math.sin(t1) * r, 0);
      const tm = (t0 + t1) / 2, nl = [Math.cos(tm) * 0.82, Math.sin(tm)];
      const n = [ca * nl[0] - sa * nl[1], 0, -(sa * nl[0] + ca * nl[1])];
      quad([p0[0], -0.4, p0[2]], [p1[0], -0.4, p1[2]], [p1[0], yTop + 0.05, p1[2]], [p0[0], yTop + 0.05, p0[2]], n, colC);
    }
    // hammerhead: wide at the top, narrowing toward the column
    const T = [[-capL, -capTop], [capL, -capTop], [capL, capTop], [-capL, capTop]].map(([a, s]) => P(a, s, soffit));
    const B = [[-capL, -capBot], [capL, -capBot], [capL, capBot], [-capL, capBot]].map(([a, s]) => P(a, s, yTop));
    const up = [0, 1, 0], dn = [0, -1, 0];
    quad(T[0], T[1], T[2], T[3], up, capC);
    quad(B[3], B[2], B[1], B[0], dn, capC);
    const ctr = new THREE.Vector3(x, (soffit + yTop) / 2, -y);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const b0 = new THREE.Vector3(...B[i]), b1 = new THREE.Vector3(...B[j]), t0 = new THREE.Vector3(...T[i]);
      const n = b1.clone().sub(b0).cross(t0.clone().sub(b0)).normalize();
      const mid = b0.clone().add(b1).add(t0).add(new THREE.Vector3(...T[j])).multiplyScalar(0.25);
      if (n.dot(mid.sub(ctr)) < 0) n.negate();
      quad(B[i], B[j], T[j], T[i], n.toArray(), capC);
    }
  }
}

// ---------------------------------------------------------------- rolling stock
// cross-section of the car body (left half, bottom centre -> roof centre); colour per edge end
const COL = { under: '#3a3e43', body: '#eef1f3', stripe: '#2b86d6', window: '#17243a', roof: '#c9ced3', gang: '#2a2d31', tramBody: '#f1f2f0', tramStripe: '#c9a14a', monoBody: '#f4f5f4', monoSkirt: '#d5dadd', monoStripe: '#1f9bb4' };
function carGeometry({ L, profile, nose = 0, glassFrom = 1.4, glassTo = 3.2, metroFace = true }) {
  const half = profile;
  const full = [...half, ...half.slice(0, -1).reverse().map(([u, v, c, g]) => [-u, v, c, g])];
  const rings = [];
  const xs = nose ? [-L / 2, L / 2 - nose, L / 2 - nose * 0.62, L / 2 - nose * 0.3, L / 2 - nose * 0.08, L / 2] : [-L / 2, L / 2];
  for (const x of xs) {
    const f = nose ? Math.max(0, (x - (L / 2 - nose)) / nose) : 0;
    rings.push({ x, f, pts: full.map(([u, v, c, g]) => {
      const vt = v > 1.25 ? 1.25 + (v - 1.25) * (1 - 0.2 * f * f) : v;
      let col = c, glow = g;
      if (f > 0.45 && v > glassFrom && v < glassTo) { col = COL.window; glow = 1; }
      return [u * (1 - 0.2 * f * f * f), vt, col, glow];
    }) });
  }
  const pos = [], nor = [], colr = [], glw = [];
  const tri = (a, b, c, k, g) => {
    pos.push(...a, ...b, ...c);
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = new THREE.Vector3(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]).normalize();
    for (let i = 0; i < 3; i++) { nor.push(n.x, n.y, n.z); colr.push(...k); glw.push(g); }
  };
  const P = (r, i) => [r.x, r.pts[i][1], r.pts[i][0]];
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k], B = rings[k + 1];
    for (let i = 0; i < full.length - 1; i++) {
      const c = new THREE.Color(B.pts[i + 1][2]).toArray(), g = B.pts[i + 1][3];
      tri(P(A, i), P(B, i), P(B, i + 1), c, g); tri(P(A, i), P(B, i + 1), P(A, i + 1), c, g);
    }
  }
  // end caps: fan from the section centre
  const cap = (r, front) => {
    const cx = r.x, cv = 1.9;
    for (let i = 0; i < full.length - 1; i++) {
      const a = P(r, i), b = P(r, i + 1);
      const v = (r.pts[i][1] + r.pts[i + 1][1]) / 2;
      let k = COL.gang, g = 0;
      if (front) {
        if (v > glassFrom + 0.05 && v < glassTo) { k = COL.window; g = 1; }
        else if (metroFace && v > 1.0 && v <= glassFrom + 0.05) k = COL.stripe;
        else k = r.pts[i + 1][2] === COL.under ? COL.under : COL.body;
      }
      const c = new THREE.Color(k).toArray();
      if (front) tri([cx, cv, 0], b, a, c, g); else tri([cx, cv, 0], a, b, c, g);
    }
  };
  cap(rings[0], false); cap(rings[rings.length - 1], !!nose);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  geo.setAttribute('aGlow', new THREE.Float32BufferAttribute(glw, 1));
  return geo;
}
// [u, v, colour, glows-at-night]
const metroSection = [
  [0, 0.3, COL.under, 0], [1.2, 0.3, COL.under, 0], [1.42, 0.62, COL.under, 0], [1.45, 1.0, COL.body, 0], [1.45, 1.22, COL.stripe, 0],
  [1.45, 1.92, COL.body, 0], [1.43, 2.88, COL.window, 1], [1.34, 3.22, COL.body, 0], [0.98, 3.52, COL.roof, 0], [0, 3.62, COL.roof, 0],
];
// straddle monorail car: skirt hugging the guideway beam below the floor (v = 0 is the beam top)
const monoSection = [
  [0, -0.95, COL.under, 0], [0.55, -0.95, COL.under, 0], [0.62, -0.2, COL.monoSkirt, 0], [1.3, 0.05, COL.monoBody, 0], [1.42, 0.5, COL.monoBody, 0],
  [1.45, 0.95, COL.monoStripe, 0], [1.45, 1.12, COL.monoBody, 0], [1.42, 2.55, COL.window, 1], [1.3, 2.95, COL.monoBody, 0], [0.92, 3.22, COL.roof, 0], [0, 3.3, COL.roof, 0],
];
const tramSection = [
  [0, 0.25, COL.under, 0], [1.15, 0.25, COL.under, 0], [1.3, 0.5, COL.under, 0], [1.32, 0.95, COL.body, 0], [1.32, 1.1, COL.tramStripe, 0],
  [1.32, 1.2, COL.body, 0], [1.3, 2.85, COL.window, 1], [1.2, 3.1, COL.body, 0], [0.9, 3.32, COL.roof, 0], [0, 3.4, COL.roof, 0],
];

export function buildRails(ctx) {
  const { data, scene } = ctx;
  const group = new THREE.Group(); group.name = 'rails'; scene.add(group);
  const metro = data.rails.filter((r) => r.k === 'metro');
  const tram = data.rails.filter((r) => r.k === 'tram');
  const mono = data.rails.filter((r) => r.k === 'mono');
  const uNight = { value: 0 };
  ctx.on('time', (s) => { uNight.value = s.night; });

  // ---- viaduct girders + piers
  const G = { pos: [], nor: [], col: [], idx: [] };
  const vi = data.viaducts || [];
  loft(vi.filter((v) => v.k === 'metro').map((v) => v.p), metroProfile, G);
  loft(vi.filter((v) => v.k === 'tram').map((v) => v.p), tramProfile, G);
  loft(vi.filter((v) => v.k === 'mono').map((v) => v.p), monoProfile, G);
  piers(data.viaPiers || [], G);
  const gGeo = new THREE.BufferGeometry();
  gGeo.setAttribute('position', new THREE.Float32BufferAttribute(G.pos, 3));
  gGeo.setAttribute('normal', new THREE.Float32BufferAttribute(G.nor, 3));
  gGeo.setAttribute('color', new THREE.Float32BufferAttribute(G.col, 3));
  gGeo.setIndex(G.idx);
  G.pos.length = G.nor.length = G.col.length = G.idx.length = 0;
  const girder = new THREE.Mesh(gGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, side: THREE.DoubleSide }));
  girder.castShadow = girder.receiveShadow = true; girder.name = 'viaduct';
  group.add(girder);

  // ---- track beds: concrete plinths, steel rails, third rail (metro); embedded track (tram at grade)
  const trackMat = (base, kind) => {
    const m = new THREE.MeshStandardMaterial({ color: base, roughness: 0.9 });
    m.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vTUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvTUv = uv;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vTUv;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float hwid = ${kind === 'metro' ? '1.35' : '1.6'};
          float u = vTUv.y * hwid;            // metres across, 0 = track centre
          float aa = max(fwidth(u), 0.02);
          ${kind === 'metro'
            ? `float plinth = step(abs(u), 1.05) * step(0.18, fract(vTUv.x / 0.62));
               diffuseColor.rgb *= mix(0.86, 0.68, plinth);
               float third = 1.0 - smoothstep(0.05, 0.05 + aa, abs(u - 1.22));
               diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.40, 0.37), third * 0.9);`
            : `diffuseColor.rgb *= 0.93 + 0.07 * step(0.5, fract(vTUv.x / 1.6));`}
          float rail = 1.0 - smoothstep(0.04, 0.04 + aa, abs(abs(u) - 0.72));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.29, 0.28), rail * 0.95);
          float shine = 1.0 - smoothstep(0.012, 0.012 + aa, abs(abs(u) - 0.72));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.77, 0.74), shine * 0.6);`);
    };
    return m;
  };
  const mb = newBuilder();
  for (const r of metro) addRibbon(mb, r.p, 2.7, -0.24, null);
  const metroBeds = new THREE.Mesh(builderGeometry(mb), trackMat('#a39e94', 'metro'));
  metroBeds.receiveShadow = true;
  const tb = newBuilder(), tbe = newBuilder();
  for (const r of tram) {
    const up = r.p.some((p) => p[2] > 1.0);
    if (up) addRibbon(tbe, r.p, 3.2, -0.2, null); else addRibbon(tb, r.p, 3.4, 0.07, null);
  }
  const tramBed = new THREE.Mesh(builderGeometry(tb), trackMat('#c4bdb0', 'tram'));
  tramBed.receiveShadow = true; tramBed.renderOrder = 1; tramBed.material.depthWrite = false;
  const tramBedUp = new THREE.Mesh(builderGeometry(tbe), trackMat('#b3ada2', 'tram'));
  tramBedUp.receiveShadow = true;
  group.add(metroBeds, tramBed, tramBedUp);

  // ---- trains
  const trainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.22 });
  trainMat.onBeforeCompile = (s) => {
    s.uniforms.uNight = uNight;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aGlow; varying float vGlow;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.88, 0.66) * uNight * vGlow * 0.85;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.08, vGlow);');
  };
  if (ctx.env) ctx.env.addReflective(trainMat, 0.6);

  const metroCab = carGeometry({ L: 17.4, profile: metroSection, nose: 3.4, glassFrom: 1.25, glassTo: 3.25 });
  const metroMid = carGeometry({ L: 16.6, profile: metroSection });
  const tramCab = carGeometry({ L: 9.2, profile: tramSection, nose: 1.8, glassFrom: 1.15, glassTo: 3.0, metroFace: false });
  const tramMid = carGeometry({ L: 8.6, profile: tramSection });
  const monoCab = carGeometry({ L: 11.2, profile: monoSection, nose: 2.4, glassFrom: 1.2, glassTo: 2.9, metroFace: false });
  const monoMid = carGeometry({ L: 10.2, profile: monoSection });

  const trains = [];
  // stop positions along a track; the paired platform nodes of one stop collapse into one
  const stopsOn = (path, pts, maxD) => {
    const ss = pts.map((p) => path.project(p)).filter((r) => r.d < maxD).map((r) => r.s).sort((a, b) => a - b);
    const out = [];
    for (const v of ss) { const last = out[out.length - 1]; if (last && v - last.s < 45) { last.s = (last.s * last.n + v) / (last.n + 1); last.n++; } else out.push({ s: v, n: 1 }); }
    return out.map((o) => o.s);
  };
  const setupLine = (lines, minLen, opts, stopPts) => {
    const paths = chain(lines).map((p) => new Path(p)).filter((p) => p.length > minLen).sort((a, b) => b.length - a.length).slice(0, 2);
    if (!paths.length) return;
    // right-hand running: travel each track so the other track is on the left
    let dirs = [1, -1];
    if (paths.length === 2) {
      const tmp = {}; paths[0].at(paths[0].length / 2, tmp);
      const o = paths[1].project([tmp.x, tmp.n]); const q = {}; paths[1].at(o.s, q);
      const cross = Math.cos(tmp.heading) * (q.n - tmp.n) - Math.sin(tmp.heading) * (q.x - tmp.x);
      dirs = cross > 0 ? [1, -1] : [-1, 1];
    }
    paths.forEach((path, i) => {
      const stops = stopsOn(path, stopPts, opts.stopD);
      for (let k = 0; k < opts.perTrack; k++) {
        trains.push({ ...opts, path, dir: dirs[i], stops, s: path.length * ((k + 0.25 + i * 0.4) / opts.perTrack) % path.length, v: opts.vmax * 0.8, dwell: 0, served: -1 });
      }
    });
  };
  setupLine(metro, 600, { kind: 'metro', perTrack: 2, cars: 5, cabL: 17.4, midL: 16.6, gap: 0.9, vmax: 22, acc: 1.0, dec: 1.1, dwellT: 22, stopD: 70, y: -0.24 },
    (data.stations || []).map((s) => [s.x, s.y]));
  setupLine(tram, 400, { kind: 'tram', perTrack: 2, cars: 5, cabL: 9.2, midL: 8.6, gap: 0.35, vmax: 11, acc: 0.9, dec: 1.0, dwellT: 18, stopD: 22, y: 0.07 },
    (data.tramStops || []).map((s) => [s.x, s.y]));
  setupLine(mono, 300, { kind: 'mono', perTrack: 2, cars: 3, cabL: 11.2, midL: 10.2, gap: 0.4, vmax: 15, acc: 0.8, dec: 0.9, dwellT: 25, stopD: 60, y: 0 },
    (data.monoStops || []).map((s) => [s.x, s.y]));

  const nCab = trains.length * 2, nMid = trains.reduce((a, t) => a + t.cars - 2, 0);
  const cabs = (k) => Math.max(1, trains.filter((t) => t.kind === k).length * 2), mids = (k) => Math.max(1, trains.filter((t) => t.kind === k).reduce((a, t) => a + t.cars - 2, 0));
  const instCab = { metro: new THREE.InstancedMesh(metroCab, trainMat, cabs('metro')), tram: new THREE.InstancedMesh(tramCab, trainMat, cabs('tram')), mono: new THREE.InstancedMesh(monoCab, trainMat, cabs('mono')) };
  const instMid = { metro: new THREE.InstancedMesh(metroMid, trainMat, mids('metro')), tram: new THREE.InstancedMesh(tramMid, trainMat, mids('tram')), mono: new THREE.InstancedMesh(monoMid, trainMat, mids('mono')) };
  const allInst = [...Object.values(instCab), ...Object.values(instMid)];
  for (const m of allInst) { m.castShadow = true; m.frustumCulled = false; m.count = 0; group.add(m); }
  for (const k of ['metro', 'tram', 'mono']) { instCab[k].count = trains.filter((t) => t.kind === k).length * 2; instMid[k].count = trains.filter((t) => t.kind === k).reduce((a, t) => a + t.cars - 2, 0); }
  void nCab; void nMid;

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YZX'), sc = new THREE.Vector3(1, 1, 1), pv = new THREE.Vector3();
  const tmp = {};
  const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
  const step = (t, dt) => {
    const L = t.path.length;
    if (t.dwell > 0) { t.dwell -= dt; if (t.dwell <= 0) t.v = 0.5; return; }
    // next stop ahead in the travel direction
    let next = null;
    for (const s of t.dir > 0 ? t.stops : [...t.stops].reverse()) {
      const d = (s - t.s) * t.dir;
      if (d > 0.3 && s !== t.served) { next = d; break; }
    }
    const brake = next == null ? Infinity : Math.sqrt(2 * t.dec * Math.max(0, next - 0.25));
    t.v = Math.min(t.vmax, t.v + t.acc * dt, brake);
    if (next != null && next < 0.8 && t.v < 0.6) {
      t.s += next * t.dir; t.v = 0; t.dwell = t.dwellT;
      t.served = t.stops.find((s) => Math.abs(s - t.s) < 1) ?? -1;
      return;
    }
    t.s += t.v * t.dir * dt;
    if (t.s > L) { t.s -= L; t.served = -1; } else if (t.s < 0) { t.s += L; t.served = -1; }
  };
  const counters = { metro: [0, 0], tram: [0, 0], mono: [0, 0] };
  let trainsOn = true;
  ctx.updaters.push((dt) => {
    if (!trainsOn) return;
    dt = Math.min(dt, 0.1);
    for (const k in counters) counters[k][0] = counters[k][1] = 0;
    for (const t of trains) {
      step(t, dt);
      const len = t.cabL * 2 + t.midL * (t.cars - 2) + t.gap * (t.cars - 1);
      let off = len / 2; // car centres from the head backwards
      for (let c = 0; c < t.cars; c++) {
        const cab = c === 0 || c === t.cars - 1, cl = cab ? t.cabL : t.midL;
        const sw = t.s + (off - cl / 2) * t.dir;
        off -= cl + t.gap;
        const inst = cab ? instCab[t.kind] : instMid[t.kind];
        const ci = counters[t.kind];
        if (sw < 0 || sw > t.path.length) { inst.setMatrixAt(cab ? ci[0]++ : ci[1]++, HIDDEN); continue; } // beyond the map edge
        t.path.at(sw, tmp);
        const head = tmp.heading + (t.dir < 0 ? Math.PI : 0) + (c === t.cars - 1 ? Math.PI : 0);
        pv.set(tmp.x, tmp.z + t.y, -tmp.n);
        e.set(0, head, (c === t.cars - 1 ? -1 : 1) * (t.dir < 0 ? -1 : 1) * tmp.pitch);
        q.setFromEuler(e);
        m4.compose(pv, q, sc);
        inst.setMatrixAt(cab ? ci[0]++ : ci[1]++, m4);
      }
    }
    for (const m of allInst) m.instanceMatrix.needsUpdate = true;
  });
  const trainMeshes = allInst;
  return { group, trains, setTrainsVisible(on) { trainsOn = on; for (const m of trainMeshes) m.visible = on; } };
}
