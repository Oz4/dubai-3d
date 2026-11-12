import * as THREE from 'three';
import { GLSL_NOISE, newBuilder, addRibbon, builderGeometry } from '../core/util.js';
import { STREET_SURFACE } from './streetSurface.js';

const RANK = { motorway: 10, trunk: 9, primary: 8, secondary: 7, motorway_link: 6, trunk_link: 6, primary_link: 6, tertiary: 6, secondary_link: 5, tertiary_link: 4, residential: 4, unclassified: 4, living_street: 3, road: 3, service: 2 };

export function buildRoads(ctx) {
  const { data, scene } = ctx;
  const group = new THREE.Group(); group.name = 'roads';
  scene.add(group);
  const uNight = { value: 0 };
  ctx.on('time', (s) => { uNight.value = s.night; });

  const roads = data.roads.slice().sort((a, b) => (RANK[a.k] || 1) - (RANK[b.k] || 1));
  const ground = newBuilder(['aRoad', 'aMark']), bridge = newBuilder(['aRoad', 'aMark']);
  // Painted lines stop where a road meets others (r.j from the data build: distance along, fade radius, ...). The
  // ribbon gets extra points at each fade's edges, and every point a marking strength (0 inside a junction).
  const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const TAPER = 30;
  const withMarks = (r) => {
    const pts = r.p, j = r.j || [], tp = r.t;
    if (!r.j && !tp) return { pts, marks: null, widths: null };
    const S = [0];
    for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = S[S.length - 1];
    const stops = pts.map((q, i) => ({ s: S[i], q }));
    const at = (c) => {
      let i = 1; while (i < S.length - 1 && S[i] < c) i++;
      const a = pts[i - 1], b = pts[i], L = S[i] - S[i - 1] || 1, t = (c - S[i - 1]) / L;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t];
    };
    for (let k = 0; k < j.length; k += 2) for (const c of [j[k] - j[k + 1], j[k] - j[k + 1] * 0.5, j[k] + j[k + 1] * 0.5, j[k] + j[k + 1]]) {
      if (c > 0.4 && c < total - 0.4 && !stops.some((o) => Math.abs(o.s - c) < 0.4)) stops.push({ s: c, q: at(c) });
    }
    // width tapers (r.t: the width at the start and at the end where the road meets one of another width): extra
    // points along the taper, the width easing from the shared value to the road's own, no lane lines in between
    const tl = Math.min(TAPER, total * 0.45);
    if (tp) for (const [w, from] of [[tp[0], 0], [tp[1], total]]) if (w) for (const f of [0.25, 0.5, 0.75, 1]) {
      const c = from === 0 ? tl * f : total - tl * f;
      if (c > 0.4 && c < total - 0.4 && !stops.some((o) => Math.abs(o.s - c) < 0.4)) stops.push({ s: c, q: at(c) });
    }
    stops.sort((a, b) => a.s - b.s);
    const marks = stops.map((o) => {
      let m = 1;
      for (let k = 0; k < j.length; k += 2) m = Math.min(m, ss(j[k + 1] * 0.5, j[k + 1], Math.abs(o.s - j[k])));
      if (tp && tp[0]) m = Math.min(m, ss(tl * 0.6, tl, o.s));
      if (tp && tp[1]) m = Math.min(m, ss(tl * 0.6, tl, total - o.s));
      return m;
    });
    const widths = tp ? stops.map((o) => {
      let w = r.w;
      if (tp[0]) w = tp[0] + (w - tp[0]) * ss(0, tl, o.s);
      if (tp[1]) w = tp[1] + (w - tp[1]) * ss(0, tl, total - o.s);
      return w;
    }) : null;
    return { pts: stops.map((o) => o.q), marks, widths };
  };
  const ribbon = (B, r, y, extra) => {
    const { pts, marks, widths } = withMarks(r);
    const v0 = B.pos.length / 3;
    addRibbon(B, pts, r.w, y, extra);
    for (let i = 0; i < pts.length; i++) { const m = marks ? marks[i] : 1; B.extra.aMark.push(m, m); }
    if (widths) {
      // move each pair of edge vertices to the tapered width (and tell the lane painter)
      for (let i = 0; i < pts.length; i++) {
        const a = (v0 + i * 2) * 3, b = a + 3, k = widths[i] / r.w;
        const cx = (B.pos[a] + B.pos[b]) / 2, cz = (B.pos[a + 2] + B.pos[b + 2]) / 2;
        B.pos[a] = cx + (B.pos[a] - cx) * k; B.pos[a + 2] = cz + (B.pos[a + 2] - cz) * k;
        B.pos[b] = cx + (B.pos[b] - cx) * k; B.pos[b + 2] = cz + (B.pos[b + 2] - cz) * k;
        const e = (v0 + i * 2) * 4; B.extra.aRoad[e + 2] = widths[i]; B.extra.aRoad[e + 6] = widths[i];
      }
    }
  };
  for (const r of roads) {
    if (r.p.length < 2) continue;
    const rank = RANK[r.k] || 1;
    const marked = rank >= 4 && r.l >= 1.5 ? 1 : 0;
    // w: marked, plus twice the street-kit surface (1 asphalt, 2 pavers) where kerbs carry the edge lines
    const extra = { aRoad: [r.l, r.o ? 1 : 0, r.w, marked + 2 * (r.s || 0)] };
    // per-rank lift keeps overlapping decks at elevated junctions from z-fighting
    if (r.b) ribbon(bridge, r, 0.12 + rank * 0.004, extra);
    else ribbon(ground, r, 0.05 + rank * 0.006, extra);
  }

  const makeMat = (depthWrite) => {
    // (little of the deep-blue sky reflection: asphalt in a tower's shadow stays grey, not navy)
    const m = new THREE.MeshStandardMaterial({ color: '#77787b', roughness: 0.92, metalness: 0, depthWrite, envMapIntensity: 0.15 });
    m.onBeforeCompile = (s) => {
      s.uniforms.uNight = uNight;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aRoad; attribute float aMark; varying vec4 vRoad; varying vec2 vRUv; varying vec3 vWP; varying float vMark;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad; vMark = aMark; vRUv = uv; vWP = (modelMatrix * vec4(position, 1.0)).xyz;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uNight; varying vec4 vRoad; varying vec2 vRUv; varying vec3 vWP; varying float vMark;\n${GLSL_NOISE}\n${STREET_SURFACE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float lanes = max(vRoad.x, 1.0), oneway = vRoad.y, width = vRoad.z;
          float marked = mod(vRoad.w, 2.0), kit = floor(vRoad.w * 0.5 + 0.01), noKit = 1.0 - step(0.5, kit);
          float s = vRUv.x, d = (vRUv.y * 0.5 + 0.5) * width;
          diffuseColor.rgb *= 0.9 + 0.12 * vnoise(vWP.xz * 0.7) + 0.05 * vnoise(vWP.xz * 0.05);
          // kit 1 asphalt, 2 pavers, 3 asphalt with a dashed yellow centre line (Emirates Hills), 4 the same in white
          // (Jumeirah Islands)
          float kit3 = step(2.5, kit), kit4 = step(3.5, kit);
          if (kit > 0.5) diffuseColor.rgb = streetSurface(vWP.xz, kit3 > 0.5 ? 1.0 : kit, 1.0 - smoothstep(0.03, 0.12, fwidth(s)));
          float aa = fwidth(d);
          float vis = (1.0 - smoothstep(0.12, 0.45, aa)) * marked;
          float lineW = 0.09;
          // kerbed streets: the kerb strips paint the edge lines (they follow the kerb round every corner)
          float edge = ((1.0 - smoothstep(lineW, lineW + aa, abs(d - 0.45))) + (1.0 - smoothstep(lineW, lineW + aa, abs(d - (width - 0.45))))) * noKit;
          float lw = width / lanes;
          float lc = d / lw; float fl = fract(lc);
          float distL = min(fl, 1.0 - fl) * lw;
          float inner = step(0.6, lc) * step(lc, lanes - 0.6);
          float isCenter = (1.0 - oneway) * (1.0 - step(0.6, abs(lc - lanes * 0.5))) * min(1.0, noKit + kit3);
          float dash = mix(step(fract(s / 9.0), 0.42), 1.0, isCenter * noKit);
          // the estate's two-way streets have no centre line; its one-way carriageways keep their lane dashes
          float lane = (1.0 - smoothstep(lineW, lineW + aa, distL)) * inner * dash * (1.0 - (1.0 - noKit) * (1.0 - oneway) * (1.0 - kit3));
          vec3 paint = mix(vec3(0.93), vec3(0.95, 0.78, 0.25), isCenter * (1.0 - kit4));
          diffuseColor.rgb = mix(diffuseColor.rgb, paint, clamp(max(edge, lane), 0.0, 1.0) * vis * 0.9 * vMark);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            float lamp = pow(0.5 + 0.5 * cos(vRUv.x / 34.0 * 6.2831), 2.5);
            float sideGlow = 0.45 + 0.55 * smoothstep(0.2, 1.0, abs(vRUv.y));
            // street lighting: every road is a warm ribbon after dark, pools of light under the lamps up close
            totalEmissiveRadiance += vec3(1.0, 0.76, 0.48) * uNight * (0.17 + 0.6 * lamp * sideGlow) * (0.65 + 0.35 * marked);
          }`);
    };
    return m;
  };

  const gMesh = new THREE.Mesh(builderGeometry(ground, { aRoad: 4, aMark: 1 }), makeMat(false));
  gMesh.receiveShadow = true; gMesh.renderOrder = 1; gMesh.name = 'roads-ground';
  const bMesh = new THREE.Mesh(builderGeometry(bridge, { aRoad: 4, aMark: 1 }), makeMat(true));
  bMesh.receiveShadow = true; bMesh.castShadow = true; bMesh.name = 'roads-bridges';
  group.add(gMesh, bMesh);

  // bridge structure: deck sides + underside + piers
  // bridges stand on piers; approach ramps on ordinary ways (r.e) are earth-filled with retaining walls
  const structure = buildStructures(data.roads.filter((r) => r.b).map((r) => ({ p: r.p, w: r.w + 0.6, solid: !!r.e })), { deck: 1.4, parapet: 0.8, pierEvery: 36, pierW: 2.0, minPierH: 2.5 });
  const concrete = new THREE.MeshStandardMaterial({ color: '#d6d0c5', roughness: 0.9, side: THREE.DoubleSide });
  const sMesh = new THREE.Mesh(structure, concrete);
  sMesh.castShadow = true; sMesh.receiveShadow = true;
  group.add(sMesh);

  return { group, groundMesh: gMesh, bridgeMesh: bMesh };
}

// Deck sides, underside and piers for elevated linear structures (road bridges, metro viaduct)
const SOLID_MAX = 6.5;
export function buildStructures(items, opt) {
  const pos = [], nor = [], idx = []; let v = 0;
  const quad = (a, b, c, d, n) => { pos.push(...a, ...b, ...c, ...d); for (let k = 0; k < 4; k++) nor.push(...n); idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4; };
  const box = (cx, cz, y0, y1, hw, hd, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const corner = (dx, dz) => [cx + dx * c - dz * s, cz + dx * s + dz * c];
    const p = [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)];
    for (let i = 0; i < 4; i++) {
      const a = p[i], b = p[(i + 1) % 4];
      const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez) || 1;
      // outward normal for this (clockwise-in-xz) loop
      const n = [ez / L, 0, -ex / L];
      quad([a[0], y0, a[1]], [a[0], y1, a[1]], [b[0], y1, b[1]], [b[0], y0, b[1]], n);
    }
  };
  for (const it of items) {
    const pts = it.p; if (pts.length < 2) continue;
    const hw = it.w / 2;
    // offset polylines (left/right) in world xz
    const L = [], R = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
      let dx = next[0] - prev[0], dy = next[1] - prev[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const nx = -dy, ny = dx;
      const y = p[2] || 0;
      L.push([p[0] + nx * hw, y, -(p[1] + ny * hw)]);
      R.push([p[0] - nx * hw, y, -(p[1] - ny * hw)]);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const y0 = Math.min(L[i][1], L[i + 1][1]), y1 = Math.max(L[i][1], L[i + 1][1]);
      // earth-filled ramps keep retaining walls up to ~6.5 m; above that they continue on piers
      const solidHere = it.solid && y1 < SOLID_MAX;
      if (solidHere ? y1 < 0.12 : y0 < 0.6) continue; // at grade: no structure
      const dt = opt.deck, pp = opt.parapet;
      const l0 = L[i], l1 = L[i + 1], r0 = R[i], r1 = R[i + 1];
      const up = (p, dy) => [p[0], p[1] + dy, p[2]];
      const ex = l1[0] - l0[0], ez = l1[2] - l0[2], el = Math.hypot(ex, ez) || 1;
      const nl = [ez / el, 0, -ex / el];
      if (solidHere) {
        // retaining walls from the ground up to the parapet; the fill hides the underside
        const gnd = (p) => [p[0], -0.3, p[2]];
        quad(gnd(l0), gnd(l1), up(l1, pp), up(l0, pp), [-nl[0], 0, -nl[2]]);
        quad(gnd(r1), gnd(r0), up(r0, pp), up(r1, pp), nl);
        continue;
      }
      // deck sides (left faces left) and underside
      quad(up(l0, -dt), up(l1, -dt), up(l1, pp), up(l0, pp), [-nl[0], 0, -nl[2]]);
      quad(up(r1, -dt), up(r0, -dt), up(r0, pp), up(r1, pp), nl);
      quad(up(l0, -dt), up(r0, -dt), up(r1, -dt), up(l1, -dt), [0, -1, 0]);
    }
    // piers
    let acc = opt.pierEvery * 0.5;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i]; const seg = Math.hypot(b[0] - a[0], b[1] - a[1]); if (seg < 0.01) continue;
      const ang = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
      while (acc < seg) {
        const t = acc / seg; const y = (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t - opt.deck;
        if (y > opt.minPierH && (!it.solid || y + opt.deck > SOLID_MAX)) {
          const x = a[0] + (b[0] - a[0]) * t, z = -(a[1] + (b[1] - a[1]) * t);
          box(x, z, -0.5, y, opt.pierW * 0.5, Math.min(hw * 0.6, opt.pierW * 1.6), ang + Math.PI / 2);
        }
        acc += opt.pierEvery;
      }
      acc -= seg;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}
