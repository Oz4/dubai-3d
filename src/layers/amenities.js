// Park & neighbourhood amenities: sports courts drawn with real markings (tennis, padel, basketball,
// football, beach volleyball, multi-use), the running track, rubber-floored playgrounds under shade
// sails with play towers, slides, swings and riders, fountains with animated jets, cafe terraces on
// the waterfront, benches, sculptures, outdoor gym frames, shade shelters and waving UAE flags.
import * as THREE from 'three';
import { triangulate } from '../core/util.js';

const SPORT_ID = { tennis: 0, basketball: 1, soccer: 2, padel: 3, volley: 4, multi: 5, track: 6 };

// ---------------------------------------------------------------- tiny geometry kit
function sink() { return { pos: [], nor: [], col: [], idx: [] }; }
function geoOf(S) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(S.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(S.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(S.col, 3));
  g.setIndex(S.idx);
  S.pos.length = S.nor.length = S.col.length = S.idx.length = 0; // the sinks outlive the build in closures
  return g;
}
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();
// world helpers: local (east, north, up) -> three (x, y, z)
const W3 = (e, n, u) => [e, u, -n];
function face(S, pts, color) {
  // planar polygon (3 or 4 points, three coords), flat normal
  _a.set(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]);
  _b.set(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]);
  _n.crossVectors(_a, _b).normalize();
  const base = S.pos.length / 3; const c = color;
  for (const p of pts) { S.pos.push(p[0], p[1], p[2]); S.nor.push(_n.x, _n.y, _n.z); S.col.push(c.r, c.g, c.b); }
  if (pts.length === 4) S.idx.push(base, base + 1, base + 2, base, base + 2, base + 3); else S.idx.push(base, base + 1, base + 2);
}
// oriented box: centre (e, n), along-angle a, length L (along), width W, from u0 to u1
function box(S, e, n, a, L, W, u0, u1, color) {
  const c = Math.cos(a), s = Math.sin(a);
  const P = (i, j, u) => W3(e + c * i * L / 2 - s * j * W / 2, n + s * i * L / 2 + c * j * W / 2, u);
  const b = [P(-1, -1, u0), P(1, -1, u0), P(1, 1, u0), P(-1, 1, u0)], t = [P(-1, -1, u1), P(1, -1, u1), P(1, 1, u1), P(-1, 1, u1)];
  face(S, [t[0], t[1], t[2], t[3]], color); // top: CCW in (east, north) faces up
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; face(S, [b[i], b[j], t[j], t[i]], color); }
}
// cylinder between two local points (e, n, u)
function rod(S, p0, p1, r, color, seg = 6) {
  const A = new THREE.Vector3(...W3(...p0)), B = new THREE.Vector3(...W3(...p1));
  const d = B.clone().sub(A); const L = d.length(); if (L < 1e-4) return;
  d.normalize();
  const t = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(d, t).normalize(), v = new THREE.Vector3().crossVectors(d, u);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const o0 = u.clone().multiplyScalar(Math.cos(a0) * r).add(v.clone().multiplyScalar(Math.sin(a0) * r));
    const o1 = u.clone().multiplyScalar(Math.cos(a1) * r).add(v.clone().multiplyScalar(Math.sin(a1) * r));
    face(S, [A.clone().add(o0).toArray(), A.clone().add(o1).toArray(), B.clone().add(o1).toArray(), B.clone().add(o0).toArray()], color);
  }
}
const col = (h) => new THREE.Color(h);

export function buildAmenities(ctx) {
  const { data, scene } = ctx;
  const A = data.amenities; if (!A) return { group: null };
  const group = new THREE.Group(); group.name = 'amenities'; scene.add(group);
  const uNight = { value: 0 }, uTime = { value: 0 };
  ctx.on('time', (s) => { uNight.value = s.night; });
  ctx.updaters.push((dt) => { uTime.value += dt; });

  // ================================================================ court & track surfaces
  {
    const pos = [], uv = [], info = [], idx = [];
    const quad = (c, a, L, W, z, sport, n) => {
      const ca = Math.cos(a), sa = Math.sin(a), base = pos.length / 3;
      for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lu = (i * L) / 2, lv = (j * W) / 2;
        pos.push(...W3(c[0] + ca * lu - sa * lv, c[1] + sa * lu + ca * lv, z + 0.07));
        uv.push(lu, lv); info.push(sport, n, L, W);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (const ct of A.courts) quad(ct.c, ct.a, ct.L, ct.W, ct.z, SPORT_ID[ct.s] ?? 5, ct.n || 1);
    for (const tr of A.tracks) quad(tr.c, tr.a, tr.L, tr.W, 0, 6, 1);
    if (idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('aCourt', new THREE.Float32BufferAttribute(info, 4));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
      g.setIndex(idx);
      const m = new THREE.MeshStandardMaterial({ roughness: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
      m.onBeforeCompile = (s) => {
        s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aCourt; varying vec4 vCourt; varying vec2 vCUv;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCourt = aCourt; vCUv = uv;');
        s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
          varying vec4 vCourt; varying vec2 vCUv;
          // anti-aliased line that keeps its average brightness when thinner than a pixel
          float ln(float d, float w) { float aa = max(fwidth(d), 1e-4); float wd = max(w, aa * 0.75); return (1.0 - smoothstep(wd - aa * 0.5, wd + aa * 0.5, abs(d))) * min(1.0, w / wd); }
          float rectLine(vec2 p, vec2 h, float w) {
            float x = ln(abs(p.x) - h.x, w) * step(abs(p.y), h.y + w);
            float y = ln(abs(p.y) - h.y, w) * step(abs(p.x), h.x + w);
            return max(x, y);
          }`)
          .replace('#include <color_fragment>', `#include <color_fragment>
          {
            float sport = floor(vCourt.x + 0.5), n = max(1.0, vCourt.y); vec2 dim = vCourt.zw; vec2 p = vCUv;
            vec3 c = vec3(0.3, 0.55, 0.32); float L = 0.0; float wl = 0.05;
            if (sport < 0.5) {            // tennis: blue court, green surround, n courts side by side
              float cw = dim.y / n; float k = clamp(floor((p.y + dim.y * 0.5) / cw), 0.0, n - 1.0);
              vec2 q = vec2(p.x, p.y + dim.y * 0.5 - (k + 0.5) * cw);
              float sc = min(1.0, min(cw / 16.5, dim.x / 33.0));
              vec2 dbl = vec2(11.885, 5.485) * sc; float sgl = 4.115 * sc, svc = 6.4 * sc;
              c = vec3(0.30, 0.54, 0.36);
              if (abs(q.x) < dbl.x && abs(q.y) < dbl.y) c = vec3(0.23, 0.42, 0.64);
              L = rectLine(q, dbl, wl);
              L = max(L, ln(abs(q.y) - sgl, wl) * step(abs(q.x), dbl.x));
              L = max(L, ln(abs(q.x) - svc, wl) * step(abs(q.y), sgl));
              L = max(L, ln(q.y, wl) * step(abs(q.x), svc));
              L = max(L, ln(q.y, wl) * step(dbl.x - 0.15, abs(q.x)) * step(abs(q.x), dbl.x));
            } else if (sport < 1.5) {     // basketball
              float sc = min(1.0, min(dim.x / 31.0, dim.y / 17.5));
              vec2 h = vec2(14.0, 7.5) * sc; float ax = abs(p.x);
              c = vec3(0.31, 0.47, 0.33);
              if (ax < h.x && abs(p.y) < h.y) c = vec3(0.66, 0.31, 0.22);
              if (ax > h.x - 5.8 * sc && ax < h.x && abs(p.y) < 2.45 * sc) c = vec3(0.24, 0.42, 0.62);
              L = rectLine(p, h, wl);
              L = max(L, ln(p.x, wl) * step(abs(p.y), h.y));
              L = max(L, ln(length(p) - 1.8 * sc, wl));
              vec2 kp = vec2(ax - (h.x - 5.8 * sc), p.y);
              L = max(L, rectLine(vec2(ax - (h.x - 2.9 * sc), p.y), vec2(2.9 * sc, 2.45 * sc), wl));
              L = max(L, ln(length(kp) - 1.8 * sc, wl) * step(ax, h.x - 5.8 * sc + 1.81 * sc));
              vec2 hp = vec2(ax - (h.x - 1.575 * sc), p.y);
              L = max(L, ln(length(hp) - 6.75 * sc, wl) * step(ax, h.x - 1.575 * sc) * step(abs(p.y), 6.6 * sc));
              L = max(L, ln(abs(p.y) - 6.6 * sc, wl) * step(h.x - 1.575 * sc, ax) * step(ax, h.x));
            } else if (sport < 2.5) {     // football (artificial turf): mown stripes and markings
              vec2 h = dim * 0.5 - 1.0;
              float stripe = step(0.5, fract((p.x + h.x) / max(4.0, dim.x / 12.0)));
              c = mix(vec3(0.27, 0.55, 0.25), vec3(0.32, 0.62, 0.29), stripe);
              L = rectLine(p, h, 0.06);
              L = max(L, ln(p.x, 0.06) * step(abs(p.y), h.y));
              L = max(L, ln(length(p) - min(9.15, dim.y * 0.13), 0.06));
              float bd = min(16.5, dim.x * 0.16), bw = min(20.15, dim.y * 0.3), gd = min(5.5, dim.x * 0.055), gw = min(9.16, dim.y * 0.14);
              L = max(L, rectLine(vec2(abs(p.x) - (h.x - bd * 0.5), p.y), vec2(bd * 0.5, bw), 0.06));
              L = max(L, rectLine(vec2(abs(p.x) - (h.x - gd * 0.5), p.y), vec2(gd * 0.5, gw), 0.06));
            } else if (sport < 3.5) {     // padel: blue courts side by side
              float cw = dim.y / n; float k = clamp(floor((p.y + dim.y * 0.5) / cw), 0.0, n - 1.0);
              vec2 q = vec2(p.x, p.y + dim.y * 0.5 - (k + 0.5) * cw);
              float sc = min(1.0, min(cw / 10.5, dim.x / 20.5));
              vec2 h = vec2(10.0, 5.0) * sc;
              c = vec3(0.17, 0.39, 0.66);
              L = rectLine(q, h, wl);
              L = max(L, ln(abs(q.x) - 6.95 * sc, wl) * step(abs(q.y), h.y));
              L = max(L, ln(q.y, wl) * step(abs(q.x), 6.95 * sc));
            } else if (sport < 4.5) {     // beach volleyball on sand with blue boundary tape
              c = vec3(0.89, 0.81, 0.62) * (0.94 + 0.06 * fract(sin(dot(floor(p * 4.0), vec2(12.9, 78.2))) * 43758.5));
              vec2 h = min(vec2(8.0, 4.0), dim * 0.5 - 1.5);
              float tape = rectLine(p, h, 0.05);
              c = mix(c, vec3(0.16, 0.36, 0.7), tape);
            } else if (sport < 5.5) {     // multi-use court
              vec2 h = dim * 0.5 - 1.2;
              c = vec3(0.29, 0.53, 0.33);
              if (abs(p.x) < h.x && abs(p.y) < h.y) c = vec3(0.27, 0.49, 0.58);
              L = rectLine(p, h, wl); L = max(L, ln(p.x, wl) * step(abs(p.y), h.y)); L = max(L, ln(length(p) - min(3.0, h.y * 0.4), wl));
            } else {                      // running track: stadium oval, 8 lanes of red tartan, grass infield
              float R = dim.y * 0.5, sl = max(0.0, (dim.x - dim.y) * 0.5);
              float d = length(vec2(max(abs(p.x) - sl, 0.0), p.y));
              float edge = R - d;
              if (edge < 0.0) discard;
              float band = dim.y < 70.0 ? 4.9 : 9.8; // 4 lanes on small jogging ovals, 8 on full tracks
              if (edge < band) {
                c = vec3(0.69, 0.29, 0.21) * (0.93 + 0.07 * fract(sin(dot(floor(p * 3.0), vec2(12.9, 78.2))) * 43758.5));
                float lane = mod(edge - 0.05, 1.22);
                L = ln(min(lane, 1.22 - lane), 0.025);
              } else {
                c = vec3(0.33, 0.59, 0.27);
                L = ln(edge - band - 0.05, 0.06);
              }
            }
            diffuseColor.rgb = mix(c, vec3(0.95), clamp(L, 0.0, 1.0));
          }`);
      };
      const mesh = new THREE.Mesh(g, m); mesh.renderOrder = 2; mesh.receiveShadow = true; mesh.name = 'courts';
      group.add(mesh);
    }
  }

  // ================================================================ playground rubber floors
  {
    const pos = [], aid = [], idx = [];
    A.playgrounds.forEach((pg, k) => {
      const t = triangulate([pg.p]); if (!t) return;
      const base = pos.length / 3;
      for (const v of t.verts) { pos.push(...W3(v[0], v[1], pg.z + 0.08)); aid.push(k); }
      for (const i of t.tris) idx.push(base + i);
    });
    if (idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aPg', new THREE.Float32BufferAttribute(aid, 1));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
      g.setIndex(idx);
      const m = new THREE.MeshStandardMaterial({ roughness: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide });
      m.onBeforeCompile = (s) => {
        s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aPg; varying float vPg; varying vec3 vPW;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPg = aPg; vPW = (modelMatrix * vec4(position, 1.0)).xyz;');
        s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
          varying float vPg; varying vec3 vPW;
          float h1(float n) { return fract(sin(n * 91.7) * 43758.5); }
          float h2(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
          float vn2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }`)
          .replace('#include <color_fragment>', `#include <color_fragment>
          {
            // poured rubber safety floor: a base colour with soft-edged islands of two accent colours
            vec3 P[5]; P[0] = vec3(0.20, 0.47, 0.70); P[1] = vec3(0.33, 0.62, 0.33); P[2] = vec3(0.78, 0.40, 0.23); P[3] = vec3(0.86, 0.68, 0.25); P[4] = vec3(0.45, 0.33, 0.62);
            int b = int(mod(vPg * 3.0, 5.0)), a1 = int(mod(vPg * 3.0 + 2.0, 5.0)), a2 = int(mod(vPg * 3.0 + 4.0, 5.0));
            // designed, curvy islands of colour (thresholded smooth noise), like poured play floors
            vec2 q = vPW.xz / 6.0 + vPg * 7.3;
            float n1 = vn2(q) * 0.65 + vn2(q * 2.1) * 0.35, n2 = vn2(q * 0.8 + 19.0) * 0.6 + vn2(q * 1.9 + 7.0) * 0.4;
            vec3 c = P[b];
            c = mix(c, P[a1], smoothstep(0.6, 0.63, n1));
            c = mix(c, P[a2], smoothstep(0.66, 0.69, n2) * (1.0 - smoothstep(0.6, 0.63, n1)));
            c *= 0.95 + 0.07 * h2(floor(vPW.xz * 8.0));
            diffuseColor.rgb = c;
          }`);
      };
      const mesh = new THREE.Mesh(g, m); mesh.renderOrder = 2; mesh.receiveShadow = true; mesh.name = 'playground-floors';
      group.add(mesh);
    }
  }

  // ================================================================ 3D props
  const S = sink(), F = sink(), MET = sink(), NET = sink(), GLASS = sink();
  const C = {
    red: col('#d24a33'), blue: col('#2f73c2'), yellow: col('#f0c23a'), green: col('#3f9a4c'), orange: col('#ec7d2e'), purple: col('#7b5aa8'),
    steel: col('#9aa1a7'), dark: col('#3a3e43'), white: col('#f3f2ee'), wood: col('#a3734b'), stone: col('#e4dbc8'), black: col('#26292c'),
    fence: col('#2f5a3c'), glass: col('#bfe1ea'), net: col('#2a2d30'), canvas: col('#efe6d2'),
  };
  const SAIL = [col('#f4f1e8'), col('#ea8a3d'), col('#2fa3a9'), col('#ecc743')];
  const BRIGHT = [C.red, C.blue, C.yellow, C.green, C.orange, C.purple];
  const R2 = (e, n, a, lu, lv) => [e + Math.cos(a) * lu - Math.sin(a) * lv, n + Math.sin(a) * lu + Math.cos(a) * lv];

  // ---- playground equipment & shade sails
  A.playgrounds.forEach((pg, k) => {
    const z = pg.z || 0;
    pg.eq.forEach(([x, y, a, kind], j) => {
      const c1 = BRIGHT[(k + j) % 6], c2 = BRIGHT[(k + j + 2) % 6], c3 = BRIGHT[(k + j + 4) % 6];
      if (kind === 0) {
        // play tower: deck on four posts, pyramid roof, slide and ladder
        const P = (lu, lv) => R2(x, y, a, lu, lv);
        for (const [i, jj] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const q = P(i * 0.9, jj * 0.9); rod(S, [q[0], q[1], z], [q[0], q[1], z + 2.7], 0.07, c2); }
        box(S, x, y, a, 1.9, 1.9, z + 1.15, z + 1.3, c1);
        box(S, ...P(0, 0.93), a, 1.9, 0.08, z + 1.3, z + 2.0, c3);
        box(S, ...P(0, -0.93), a, 1.9, 0.08, z + 1.3, z + 2.0, c3);
        const top = [x, y, z + 3.6], cr = [[-1.1, -1.1], [1.1, -1.1], [1.1, 1.1], [-1.1, 1.1]].map(([i, jj]) => { const q = P(i, jj); return [q[0], q[1], z + 2.7]; });
        for (let i = 0; i < 4; i++) { const p0 = cr[i], p1 = cr[(i + 1) % 4]; face(S, [W3(...p0), W3(...p1), W3(...top)], i % 2 ? c1 : C.yellow); }
        // slide off the +u side
        const s0 = P(0.95, 0), s1 = P(4.1, 0), sw = 0.62, ca = Math.cos(a), sa = Math.sin(a);
        const L0 = [s0[0] - sa * sw / 2, s0[1] + ca * sw / 2], R0 = [s0[0] + sa * sw / 2, s0[1] - ca * sw / 2], L1 = [s1[0] - sa * sw / 2, s1[1] + ca * sw / 2], R1 = [s1[0] + sa * sw / 2, s1[1] - ca * sw / 2];
        face(S, [W3(L0[0], L0[1], z + 1.3), W3(R0[0], R0[1], z + 1.3), W3(R1[0], R1[1], z + 0.25), W3(L1[0], L1[1], z + 0.25)], C.yellow);
        face(S, [W3(L1[0], L1[1], z + 0.25), W3(R1[0], R1[1], z + 0.25), W3(R0[0], R0[1], z + 1.3), W3(L0[0], L0[1], z + 1.3)], C.yellow);
        rod(S, [L0[0], L0[1], z + 1.55], [L1[0], L1[1], z + 0.5], 0.05, C.yellow); rod(S, [R0[0], R0[1], z + 1.55], [R1[0], R1[1], z + 0.5], 0.05, C.yellow);
        // ladder off the -u side
        const l0 = P(-0.95, -0.35), l1 = P(-1.9, -0.35), m0 = P(-0.95, 0.35), m1 = P(-1.9, 0.35);
        rod(S, [l1[0], l1[1], z], [l0[0], l0[1], z + 1.3], 0.04, C.steel); rod(S, [m1[0], m1[1], z], [m0[0], m0[1], z + 1.3], 0.04, C.steel);
        for (let r = 1; r <= 3; r++) { const t = r / 4; rod(S, [l1[0] + (l0[0] - l1[0]) * t, l1[1] + (l0[1] - l1[1]) * t, z + 1.3 * t], [m1[0] + (m0[0] - m1[0]) * t, m1[1] + (m0[1] - m1[1]) * t, z + 1.3 * t], 0.03, C.steel); }
      } else if (kind === 1) {
        // swing set: A-frames at both ends, top beam, two seats on chains
        const P = (lu, lv) => R2(x, y, a, lu, lv);
        for (const sd of [-1.7, 1.7]) { const tp = P(sd, 0); for (const lg of [-0.75, 0.75]) { const ft = P(sd, lg); rod(S, [ft[0], ft[1], z], [tp[0], tp[1], z + 2.35], 0.06, c1); } }
        const b0 = P(-1.7, 0), b1 = P(1.7, 0); rod(S, [b0[0], b0[1], z + 2.35], [b1[0], b1[1], z + 2.35], 0.07, c1);
        for (const sd of [-0.7, 0.7]) {
          const q = P(sd, 0);
          for (const ch of [-0.22, 0.22]) { const r = P(sd + ch, 0); rod(S, [r[0], r[1], z + 2.33], [r[0], r[1], z + 0.48], 0.012, C.steel, 4); }
          box(S, q[0], q[1], a, 0.55, 0.22, z + 0.44, z + 0.5, C.black);
        }
      } else if (kind === 2) {
        // spring rider
        rod(S, [x, y, z], [x, y, z + 0.38], 0.1, C.dark, 6);
        box(S, x, y, a, 0.85, 0.32, z + 0.38, z + 0.78, c2);
        box(S, ...R2(x, y, a, 0.32, 0), a, 0.22, 0.26, z + 0.78, z + 1.0, c2);
      } else {
        // climbing dome: meridian arcs and two rings of steel bars
        const rr = 1.6;
        for (let m = 0; m < 6; m++) {
          const th = (m / 6) * Math.PI;
          for (let i = 0; i < 6; i++) {
            const p0 = (i / 6) * Math.PI, p1 = ((i + 1) / 6) * Math.PI;
            const q0 = [x + Math.cos(th) * Math.cos(p0) * rr, y + Math.sin(th) * Math.cos(p0) * rr, z + Math.sin(p0) * rr];
            const q1 = [x + Math.cos(th) * Math.cos(p1) * rr, y + Math.sin(th) * Math.cos(p1) * rr, z + Math.sin(p1) * rr];
            rod(S, q0, q1, 0.035, m % 2 ? c3 : C.steel, 4);
          }
        }
        for (const hh of [0.55, 1.15]) {
          const rad = Math.sqrt(rr * rr - hh * hh);
          for (let i = 0; i < 12; i++) { const t0 = (i / 12) * Math.PI * 2, t1 = ((i + 1) / 12) * Math.PI * 2; rod(S, [x + Math.cos(t0) * rad, y + Math.sin(t0) * rad, z + hh], [x + Math.cos(t1) * rad, y + Math.sin(t1) * rad, z + hh], 0.035, C.steel, 4); }
        }
      }
    });
    // shade sails: tensioned hypar quads on four masts
    for (const [x, y, a, L, Wd, ci] of pg.sails) {
      const hc = [4.7, 2.8, 4.7, 2.8];
      const cr = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j], m) => { const q = R2(x, y, a, (i * L) / 2, (j * Wd) / 2); return [q[0], q[1], z + hc[m]]; });
      const N = 4;
      const lerp3 = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      const at = (s, t) => lerp3(lerp3(cr[0], cr[1], s), lerp3(cr[3], cr[2], s), t);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        // corners pulled in a little so the edges read as a catenary
        const pinch = (s, t) => { const p = at(s, t); const e = Math.min(s, 1 - s, t, 1 - t); const sag = 0.18 * Math.sin(Math.PI * (e < Math.min(s, 1 - s) ? s : t)); return [p[0], p[1], p[2] - sag * (1 - 2 * e)]; };
        face(F, [W3(...pinch(i / N, j / N)), W3(...pinch((i + 1) / N, j / N)), W3(...pinch((i + 1) / N, (j + 1) / N)), W3(...pinch(i / N, (j + 1) / N))], SAIL[ci % 4]);
      }
      for (const p of cr) { const ext = R2(p[0], p[1], Math.atan2(p[1] - y, p[0] - x), 0.7, 0); rod(MET, [ext[0], ext[1], z], [ext[0], ext[1], p[2] + 0.4], 0.09, C.steel); rod(MET, [ext[0], ext[1], p[2] + 0.2], p, 0.015, C.steel, 4); }
    }
  });

  // ---- court furniture: nets, posts, hoops, goals, fences, padel glass
  for (const ct of A.courts) {
    const z = ct.z || 0, a = ct.a, [cx, cy] = ct.c, L = ct.L, Wd = ct.W, n = ct.n || 1;
    const P = (lu, lv) => R2(cx, cy, a, lu, lv);
    const fence = (hgt) => {
      const cr = [P(-L / 2, -Wd / 2), P(L / 2, -Wd / 2), P(L / 2, Wd / 2), P(-L / 2, Wd / 2)];
      for (let i = 0; i < 4; i++) {
        const p0 = cr[i], p1 = cr[(i + 1) % 4];
        face(NET, [W3(p0[0], p0[1], z), W3(p1[0], p1[1], z), W3(p1[0], p1[1], z + hgt), W3(p0[0], p0[1], z + hgt)], C.fence);
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), np = Math.max(1, Math.round(len / 3));
        for (let k = 0; k < np; k++) { const t = k / np; rod(MET, [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, z], [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, z + hgt], 0.04, C.dark, 4); }
      }
    };
    if (ct.s === 'tennis') {
      const cw = Wd / n;
      for (let k = 0; k < n; k++) {
        const off = -Wd / 2 + (k + 0.5) * cw, sc = Math.min(1, cw / 16.5, L / 33), half = (5.485 + 0.914) * sc;
        const p0 = P(0, off - half), p1 = P(0, off + half);
        face(NET, [W3(p0[0], p0[1], z + 0.05), W3(p1[0], p1[1], z + 0.05), W3(p1[0], p1[1], z + 1.07), W3(p0[0], p0[1], z + 1.07)], C.net);
        rod(S, [p0[0], p0[1], z + 1.07], [p1[0], p1[1], z + 1.07], 0.03, C.white, 4);
        rod(MET, [p0[0], p0[1], z], [p0[0], p0[1], z + 1.07], 0.04, C.dark, 4); rod(MET, [p1[0], p1[1], z], [p1[0], p1[1], z + 1.07], 0.04, C.dark, 4);
      }
      fence(3.2);
    } else if (ct.s === 'padel') {
      const cw = Wd / n;
      for (let k = 0; k < n; k++) {
        const off = -Wd / 2 + (k + 0.5) * cw, sc = Math.min(1, cw / 10.5, L / 20.5), hl = 10 * sc, hw = 5 * sc;
        const cr = [P(-hl, off - hw), P(hl, off - hw), P(hl, off + hw), P(-hl, off + hw)];
        for (let i = 0; i < 4; i++) {
          const q0 = cr[i], q1 = cr[(i + 1) % 4];
          face(GLASS, [W3(q0[0], q0[1], z), W3(q1[0], q1[1], z), W3(q1[0], q1[1], z + 3), W3(q0[0], q0[1], z + 3)], C.glass);
          face(NET, [W3(q0[0], q0[1], z + 3), W3(q1[0], q1[1], z + 3), W3(q1[0], q1[1], z + 4), W3(q0[0], q0[1], z + 4)], C.fence);
          rod(MET, [q0[0], q0[1], z], [q0[0], q0[1], z + 4], 0.05, C.black, 4);
        }
        const n0 = P(0, off - hw), n1 = P(0, off + hw);
        face(NET, [W3(n0[0], n0[1], z + 0.05), W3(n1[0], n1[1], z + 0.05), W3(n1[0], n1[1], z + 0.92), W3(n0[0], n0[1], z + 0.92)], C.net);
      }
    } else if (ct.s === 'basketball' || ct.s === 'multi') {
      const sc = Math.min(1, L / 31, Wd / 17.5), hx = (ct.s === 'multi' ? L / 2 - 1.2 : 14 * sc);
      for (const sd of [-1, 1]) {
        const pole = P(sd * (hx + 0.9), 0), board = P(sd * (hx - 1.2 * sc), 0), rim = P(sd * (hx - 1.575 * sc), 0);
        rod(MET, [pole[0], pole[1], z], [pole[0], pole[1], z + 3.4], 0.08, C.dark);
        rod(MET, [pole[0], pole[1], z + 3.25], [board[0], board[1], z + 3.25], 0.05, C.dark, 4);
        box(S, board[0], board[1], a + Math.PI / 2, 1.8, 0.06, z + 2.9, z + 3.95, C.white);
        for (let i = 0; i < 8; i++) { const t0 = (i / 8) * Math.PI * 2, t1 = ((i + 1) / 8) * Math.PI * 2; rod(MET, [rim[0] + Math.cos(t0) * 0.23, rim[1] + Math.sin(t0) * 0.23, z + 3.05], [rim[0] + Math.cos(t1) * 0.23, rim[1] + Math.sin(t1) * 0.23, z + 3.05], 0.02, C.orange, 4); }
      }
      if (ct.s === 'multi') fence(3.5);
    } else if (ct.s === 'soccer') {
      const small = L < 50, gw = small ? 3 : Math.min(7.32, Wd * 0.12), gh = small ? 2 : 2.44, gx = L / 2 - 1.0;
      for (const sd of [-1, 1]) {
        const g0 = P(sd * gx, -gw / 2), g1 = P(sd * gx, gw / 2), b0 = P(sd * (gx + 1.2), -gw / 2), b1 = P(sd * (gx + 1.2), gw / 2);
        rod(S, [g0[0], g0[1], z], [g0[0], g0[1], z + gh], 0.06, C.white, 6); rod(S, [g1[0], g1[1], z], [g1[0], g1[1], z + gh], 0.06, C.white, 6);
        rod(S, [g0[0], g0[1], z + gh], [g1[0], g1[1], z + gh], 0.06, C.white, 6);
        face(NET, [W3(b0[0], b0[1], z), W3(b1[0], b1[1], z), W3(g1[0], g1[1], z + gh), W3(g0[0], g0[1], z + gh)], C.white);
      }
      if (small) fence(4);
    } else if (ct.s === 'volley') {
      const n0 = P(0, -5), n1 = P(0, 5);
      rod(MET, [n0[0], n0[1], z], [n0[0], n0[1], z + 2.6], 0.05, C.steel); rod(MET, [n1[0], n1[1], z], [n1[0], n1[1], z + 2.6], 0.05, C.steel);
      face(NET, [W3(n0[0], n0[1], z + 1.43), W3(n1[0], n1[1], z + 1.43), W3(n1[0], n1[1], z + 2.43), W3(n0[0], n0[1], z + 2.43)], C.net);
    }
  }
  // dog parks: low mesh fence
  for (const ring of A.dogParks || []) for (let i = 0; i < ring.length; i++) {
    const p0 = ring[i], p1 = ring[(i + 1) % ring.length];
    face(NET, [W3(p0[0], p0[1], 0), W3(p1[0], p1[1], 0), W3(p1[0], p1[1], 1.3), W3(p0[0], p0[1], 1.3)], C.fence);
    rod(MET, [p0[0], p0[1], 0], [p0[0], p0[1], 1.3], 0.035, C.dark, 4);
  }

  // ---- benches (the sitter looks along `face`)
  for (const [x, y, fa] of A.benches) {
    const a = fa + Math.PI / 2; // bench length runs across the view direction
    const back = R2(x, y, fa, -0.24, 0);
    box(S, x, y, a, 1.8, 0.45, 0.42, 0.48, C.wood);
    box(S, back[0], back[1], a, 1.8, 0.06, 0.5, 0.88, C.wood);
    for (const sd of [-0.75, 0.75]) { const q = R2(x, y, a, sd, 0); box(S, q[0], q[1], a, 0.07, 0.45, 0, 0.42, C.dark); }
  }
  // ---- cafe terraces: square parasols over tables and chairs, in rows facing the water
  const CANVAS = [col('#f1e8d4'), col('#f7f6f2'), col('#c8714a'), col('#2f5b45')];
  for (const [x, y, a, n, rows, ci, zz] of A.cafes) {
    const z = zz || 0;
    for (let r = 0; r < rows; r++) for (let k = 0; k < n; k++) {
      const lu = rows === 2 ? (r ? 1.6 : -1.6) : 0, lv = (k - (n - 1) / 2) * 3.3;
      const [px, py] = R2(x, y, a, lu, lv);
      rod(MET, [px, py, z], [px, py, z + 2.55], 0.035, C.dark, 4);
      const cr = [[-1.3, -1.3], [1.3, -1.3], [1.3, 1.3], [-1.3, 1.3]].map(([i, j]) => { const q = R2(px, py, a, i, j); return [q[0], q[1], z + 2.25]; });
      for (let i = 0; i < 4; i++) face(F, [W3(...cr[i]), W3(...cr[(i + 1) % 4]), W3(px, py, z + 2.75)], CANVAS[ci % 4]);
      rod(S, [px, py, z], [px, py, z + 0.72], 0.03, C.dark, 4);
      box(S, px, py, a, 0.8, 0.8, z + 0.72, z + 0.76, C.white);
      for (const [cu, cv] of [[0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75]]) { const q = R2(px, py, a, cu, cv); box(S, q[0], q[1], a, 0.42, 0.42, z + 0.42, z + 0.47, C.dark); box(S, ...R2(q[0], q[1], Math.atan2(cv, cu) + a, 0.19, 0), Math.atan2(cv, cu) + a + Math.PI / 2, 0.42, 0.04, z + 0.47, z + 0.85, C.dark); }
    }
  }
  // ---- outdoor gym frames
  for (const [x, y, z, a, kind] of A.fitness) {
    const P = (lu, lv) => R2(x, y, a, lu, lv);
    if (kind === 0) { // horizontal ladder
      for (const sd of [-1.5, 1.5]) for (const w of [-0.4, 0.4]) { const q = P(sd, w); rod(MET, [q[0], q[1], z], [q[0], q[1], z + 2.3], 0.05, C.green, 6); }
      for (const w of [-0.4, 0.4]) { const q0 = P(-1.5, w), q1 = P(1.5, w); rod(MET, [q0[0], q0[1], z + 2.3], [q1[0], q1[1], z + 2.3], 0.04, C.yellow, 6); }
      for (let i = 0; i < 8; i++) { const u = -1.3 + (i * 2.6) / 7; const q0 = P(u, -0.4), q1 = P(u, 0.4); rod(MET, [q0[0], q0[1], z + 2.3], [q1[0], q1[1], z + 2.3], 0.025, C.yellow, 4); }
    } else if (kind === 1) { // parallel bars
      for (const w of [-0.3, 0.3]) { for (const sd of [-1, 1]) { const q = P(sd, w); rod(MET, [q[0], q[1], z], [q[0], q[1], z + 1.2], 0.04, C.green, 6); } const q0 = P(-1.1, w), q1 = P(1.1, w); rod(MET, [q0[0], q0[1], z + 1.2], [q1[0], q1[1], z + 1.2], 0.035, C.yellow, 6); }
    } else { // pull-up bars at three heights
      [[-1, 1.9], [0, 2.2], [1, 2.5]].forEach(([u, h]) => { const q0 = P(u - 0.45, 0), q1 = P(u + 0.45, 0); rod(MET, [q0[0], q0[1], z], [q0[0], q0[1], z + h], 0.05, C.green, 6); rod(MET, [q1[0], q1[1], z], [q1[0], q1[1], z + h], 0.05, C.green, 6); rod(MET, [q0[0], q0[1], z + h], [q1[0], q1[1], z + h], 0.035, C.yellow, 6); });
    }
  }
  // ---- shade shelters with a bench
  for (const [x, y, z, a] of A.shelters) {
    for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const q = R2(x, y, a, i * 2.6, j * 1.7); rod(MET, [q[0], q[1], z], [q[0], q[1], z + 2.8], 0.07, C.white); }
    box(S, x, y, a, 6.2, 4.2, z + 2.8, z + 3.05, C.canvas);
    box(S, x, y, a, 3.5, 0.45, z + 0.42, z + 0.48, C.wood);
  }
  // ---- sculptures (polished steel / bronze)
  const ART = sink();
  const artCols = [col('#d9dde0'), col('#c9a560'), col('#e8e4dc'), col('#b8c4cc')];
  for (const [x, y, z, kind, s] of A.art) {
    const c = artCols[kind % 4];
    box(ART, x, y, 0, 1.6, 1.6, z, z + 0.6, C.stone);
    if (kind === 0) { for (let i = 0; i < 10; i++) box(ART, x, y, i * 0.16, 0.9 * s, 0.25 * s, z + 0.6 + i * 0.42 * s, z + 0.6 + (i + 1) * 0.42 * s, c); } // twisting ribbon
    else if (kind === 1) { const geo = new THREE.IcosahedronGeometry(1.1 * s, 1); const p = geo.attributes.position; for (let i = 0; i < p.count; i += 3) face(ART, [0, 1, 2].map((k) => [x + p.getX(i + k), z + 0.6 + 1.1 * s + p.getY(i + k), -y + p.getZ(i + k)]), c); }
    else if (kind === 2) { box(ART, x, y, 0.3, 1.3 * s, 1.3 * s, z + 0.6, z + 0.6 + 1.3 * s, c); box(ART, x, y, 0.9, 1.0 * s, 1.0 * s, z + 0.6 + 1.3 * s, z + 0.6 + 2.3 * s, c); box(ART, x, y, 1.5, 0.7 * s, 0.7 * s, z + 0.6 + 2.3 * s, z + 0.6 + 3.0 * s, c); }
    else { for (let i = 0; i < 16; i++) { const t0 = (i / 16) * Math.PI * 2, t1 = ((i + 1) / 16) * Math.PI * 2, R = 1.4 * s; rod(ART, [x + Math.cos(t0) * R, y, z + 0.6 + R + Math.sin(t0) * R], [x + Math.cos(t1) * R, y, z + 0.6 + R + Math.sin(t1) * R], 0.22 * s, c, 6); } }
  }
  // ---- lifeguard towers: white timber stilts, a hut with a red roof, flag
  for (const [x, y, a] of A.lifeguards || []) {
    for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const q = R2(x, y, a, i * 0.9, j * 0.9); rod(S, [q[0], q[1], 0], [q[0], q[1], 2.4], 0.07, C.white, 5); }
    const st = R2(x, y, a, -1.4, 0), st2 = R2(x, y, a, -0.9, 0); rod(S, [st[0], st[1], 0], [st2[0], st2[1], 2.3], 0.05, C.wood, 4);
    box(S, x, y, a, 2.3, 2.3, 2.3, 2.45, C.wood);
    box(S, x, y, a, 1.7, 1.7, 2.45, 3.7, C.white);
    box(S, x, y, a, 2.2, 2.2, 3.7, 3.85, C.red);
    const fp = R2(x, y, a, 0.9, 0.9); rod(MET, [fp[0], fp[1], 3.85], [fp[0], fp[1], 5.4], 0.03, C.steel, 4);
    box(S, ...R2(fp[0], fp[1], a, 0.35, 0), a, 0.7, 0.03, 4.9, 5.35, C.red);
  }
  // ---- flagpoles
  for (const [x, y, z, h] of A.flags) rod(MET, [x, y, z], [x, y, z + h], 0.12, C.white, 8);

  // ---- fountain basins (land): stone rim, water surface
  const WATER = sink();
  const jets = [];
  for (const f of A.fountains) {
    const z = f.z || 0;
    if (f.w) { // jets standing in the marina or a lake
      const nj = f.r > 3 ? 5 : 3;
      for (let k = 0; k < nj; k++) jets.push({ x: f.c[0] + (k - (nj - 1) / 2) * 3.2, y: f.c[1], z: -0.6, h: 7 + ((k * 37) % 5) * 1.6, r: 0.5 });
      continue;
    }
    let ring = f.p || Array.from({ length: 20 }, (_, k) => [f.c[0] + Math.cos((k / 20) * Math.PI * 2) * f.r, f.c[1] + Math.sin((k / 20) * Math.PI * 2) * f.r]);
    for (let i = 0; i < ring.length; i++) {
      const p0 = ring[i], p1 = ring[(i + 1) % ring.length];
      face(S, [W3(p0[0], p0[1], z), W3(p1[0], p1[1], z), W3(p1[0], p1[1], z + 0.5), W3(p0[0], p0[1], z + 0.5)], C.stone);
      const cx = f.c[0], cy = f.c[1], k = 0.3 / Math.max(0.5, f.r);
      const q0 = [p0[0] + (cx - p0[0]) * k, p0[1] + (cy - p0[1]) * k], q1 = [p1[0] + (cx - p1[0]) * k, p1[1] + (cy - p1[1]) * k];
      face(S, [W3(p0[0], p0[1], z + 0.5), W3(p1[0], p1[1], z + 0.5), W3(q1[0], q1[1], z + 0.5), W3(q0[0], q0[1], z + 0.5)], C.stone);
    }
    const t = triangulate([ring]);
    if (t) { const base = WATER.pos.length / 3; for (const v of t.verts) { WATER.pos.push(...W3(v[0], v[1], z + 0.36)); WATER.nor.push(0, 1, 0); WATER.col.push(1, 1, 1); } for (const i of t.tris) WATER.idx.push(base + i); }
    jets.push({ x: f.c[0], y: f.c[1], z: z + 0.36, h: Math.min(5, 1.8 + f.r * 0.45), r: Math.min(0.9, 0.25 + f.r * 0.08) });
    if (f.r > 4) for (let k = 0; k < 6; k++) { const t2 = (k / 6) * Math.PI * 2, rr = f.r * 0.55; jets.push({ x: f.c[0] + Math.cos(t2) * rr, y: f.c[1] + Math.sin(t2) * rr, z: z + 0.36, h: 1.4, r: 0.18 }); }
  }

  // ---- meshes
  const add = (Sk, mat, name, opts = {}) => {
    if (!Sk.idx.length) return null;
    const m = new THREE.Mesh(geoOf(Sk), mat); m.name = name; m.castShadow = opts.cast !== false; m.receiveShadow = true;
    if (opts.order != null) m.renderOrder = opts.order;
    group.add(m); return m;
  };
  add(S, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05 }), 'amenity-props');
  add(MET, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.6 }), 'amenity-metal');
  add(F, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }), 'shade-sails');
  add(NET, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide }), 'court-nets', { cast: false, order: 5 });
  add(GLASS, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }), 'padel-glass', { cast: false, order: 6 });
  const artMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.85 });
  if (ctx.env) ctx.env.addReflective(artMat, 1.0);
  add(ART, artMat, 'sculptures');
  const waterMat = new THREE.MeshStandardMaterial({ color: '#56b3c6', roughness: 0.06, metalness: 0.1, emissive: '#2c8fa6', emissiveIntensity: 0, side: THREE.DoubleSide });
  ctx.on('time', (s) => { waterMat.emissiveIntensity = s.night * 0.6; });
  if (ctx.env) ctx.env.addReflective(waterMat, 0.8);
  add(WATER, waterMat, 'fountain-water', { cast: false });

  // ---- fountain jets: additive spray columns, flickering
  if (jets.length) {
    const geos = [];
    const base = new THREE.CylinderGeometry(1, 0.35, 1, 10, 6, true).translate(0, 0.5, 0);
    jets.forEach((j, k) => {
      const g = base.clone().scale(j.r * 1.6, j.h, j.r * 1.6).translate(j.x, j.z, -j.y);
      g.setAttribute('aSeed', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(k * 1.37), 1));
      geos.push(g);
    });
    const merged = mergeList(geos);
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    mat.onBeforeCompile = (s) => {
      s.uniforms.uTime = uTime; s.uniforms.uNight = uNight;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSeed; varying float vSeed; varying vec2 vJUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeed = aSeed; vJUv = uv;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
        uniform float uTime, uNight; varying float vSeed; varying vec2 vJUv;
        float hh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hh(i), hh(i + vec2(1, 0)), f.x), mix(hh(i + vec2(0, 1)), hh(i + vec2(1, 1)), f.x), f.y); }`)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
          float v = vJUv.y; // 0 at the nozzle, 1 at the crown
          float streaks = vn(vec2(vJUv.x * 22.0 + vSeed, v * 6.0 - uTime * 4.5 - vSeed)) * 0.7 + vn(vec2(vJUv.x * 50.0, v * 14.0 - uTime * 7.0)) * 0.45;
          float a = smoothstep(0.0, 0.08, v) * (1.0 - smoothstep(0.55, 1.0, v)) * (0.25 + 0.75 * streaks);
          a *= 0.55 + 0.1 * sin(uTime * 2.0 + vSeed);
          vec3 tint = mix(vec3(0.9, 0.96, 1.0), vec3(0.75, 0.9, 1.0), uNight);
          vec4 diffuseColor = vec4(tint * (0.75 + 0.9 * uNight), a);`);
    };
    const jm = new THREE.Mesh(merged, mat); jm.renderOrder = 7; jm.name = 'fountain-jets';
    group.add(jm);
  }

  // ---- UAE flags waving
  if (A.flags.length) {
    const pos = [], colr = [], dist = [], idx = [];
    const RED = col('#c8262c'), GRN = col('#00843d'), WHT = col('#ffffff'), BLK = col('#1b1b1b');
    for (const [x, y, z, h] of A.flags) {
      const fw = h * 0.16, fh = fw * 0.5, top = z + h - 0.2;
      const strip = (d0, d1, h0, h1, c) => {
        const segs = 4, base = pos.length / 3;
        for (let i = 0; i <= segs; i++) {
          const d = d0 + ((d1 - d0) * i) / segs;
          pos.push(x + d, top - fh + h1 * fh, -y, x + d, top - fh + h0 * fh, -y);
          colr.push(c.r, c.g, c.b, c.r, c.g, c.b); dist.push(d, d);
          if (i) { const b = base + (i - 1) * 2; idx.push(b, b + 1, b + 3, b, b + 3, b + 2); }
        }
      };
      strip(0.12, 0.12 + fw * 0.25, 0, 1, RED);
      strip(0.12 + fw * 0.25, 0.12 + fw, 2 / 3, 1, GRN);
      strip(0.12 + fw * 0.25, 0.12 + fw, 1 / 3, 2 / 3, WHT);
      strip(0.12 + fw * 0.25, 0.12 + fw, 0, 1 / 3, BLK);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
    g.setIndex(idx); g.computeVertexNormals();
    const fm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
    fm.onBeforeCompile = (s) => {
      s.uniforms.uTime = uTime;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aDist; uniform float uTime;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z += sin(uTime * 3.2 + aDist * 1.6) * 0.09 * aDist;');
    };
    const flags = new THREE.Mesh(g, fm); flags.name = 'flags'; flags.castShadow = true;
    group.add(flags);
  }
  return { group };
}

function mergeList(geos) {
  const pos = [], uv = [], seed = [], idx = []; let v = 0;
  for (const g of geos) {
    const p = g.attributes.position, u = g.attributes.uv, s = g.attributes.aSeed;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); uv.push(u.getX(i), u.getY(i)); seed.push(s.getX(i)); }
    const ix = g.index.array; for (let i = 0; i < ix.length; i++) idx.push(ix[i] + v);
    v += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  out.setIndex(idx);
  return out;
}
