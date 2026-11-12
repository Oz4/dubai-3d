// Dubai Metro Red Line elevated stations, modelled on the Aedas design seen in photos:
// a long, low, lens-shaped champagne-aluminium shell dotted with small dark vents, its eave
// overhanging a band of dark glazing around the platforms; under the platforms a glazed concourse
// box on columns; enclosed skybridges at concourse level that reach entrance pods wearing a
// smaller version of the shell.
import * as THREE from 'three';

function nearestOnSpines(spines, p) {
  let best = null;
  for (const sp of spines) for (let i = 1; i < sp.length; i++) {
    const a = sp[i - 1], b = sp[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t));
    const q = [a[0] + dx * t, a[1] + dy * t], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!best || d < best.d) {
      const l = Math.sqrt(L2);
      best = { d, q, dir: [dx / l, dy / l], z: a[2] + (b[2] - a[2]) * t, w: a[3] + (b[3] - a[3]) * t };
    }
  }
  return best;
}

// geometry sink: positions, normals, uvs (metres) + index
const sink = () => ({ pos: [], nor: [], uv: [], idx: [] });
function quad(B, a, b, c, d, uvs) {
  const base = B.pos.length / 3;
  const n = new THREE.Vector3().subVectors(new THREE.Vector3(...b), new THREE.Vector3(...a))
    .cross(new THREE.Vector3().subVectors(new THREE.Vector3(...d), new THREE.Vector3(...a))).normalize();
  for (const p of [a, b, c, d]) { B.pos.push(...p); B.nor.push(n.x, n.y, n.z); }
  B.uv.push(...(uvs || [0, 0, 1, 0, 1, 1, 0, 1]));
  B.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function toGeo(B) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
  g.setIndex(B.idx);
  B.pos.length = B.nor.length = B.uv.length = B.idx.length = 0;
  return g;
}
// local station frame: a = along the line, s = across (left), y = up
const frameOf = (c, dir) => (a, s, y) => [c[0] + dir[0] * a - dir[1] * s, y, -(c[1] + dir[1] * a + dir[0] * s)];

// vertical walls along a closed plan outline [(a, s)...], uv = (perimeter metres, height metres)
function walls(B, F, plan, y0, y1, closed = true) {
  let per = 0;
  const n = plan.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p = plan[i], q = plan[(i + 1) % n];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    quad(B, F(p[0], p[1], y0), F(q[0], q[1], y0), F(q[0], q[1], y1), F(p[0], p[1], y1), [per, y0, per + L, y0, per + L, y1, per, y1]);
    per += L;
  }
}
// flat cap over a convex plan
function cap(B, F, plan, y, down = false) {
  const base = B.pos.length / 3;
  for (const [a, s] of plan) { B.pos.push(...F(a, s, y)); B.nor.push(0, down ? -1 : 1, 0); B.uv.push(a, s); }
  for (let i = 1; i < plan.length - 1; i++) down ? B.idx.push(base, base + i + 1, base + i) : B.idx.push(base, base + i, base + i + 1);
}
const octo = (L, W, ch) => [[-L / 2 + ch, -W / 2], [L / 2 - ch, -W / 2], [L / 2, -W / 2 + ch], [L / 2, W / 2 - ch], [L / 2 - ch, W / 2], [-L / 2 + ch, W / 2], [-L / 2, W / 2 - ch], [-L / 2, -W / 2 + ch]];

// lens-shaped shell: rim at y0, crown y0 + H; uv in metres for the vent pattern
function shell(B, F, L, HW, H, y0, { ends = 2.2, nl = 64, nt = 24 } = {}) {
  const base = B.pos.length / 3;
  // plan: a lens with softly pointed ends; section: a low flattened arch, fuller toward the eave
  const W = (s) => HW * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), ends)), 0.6);
  for (let i = 0; i <= nl; i++) {
    const s = -1 + (2 * i) / nl;
    const hw = W(s), hs = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), 3.0)), 0.5);
    for (let j = 0; j <= nt; j++) {
      const t = -1 + (2 * j) / nt;
      const h = H * hs * Math.pow(Math.max(0, 1 - t * t), 0.62);
      B.pos.push(...F(s * L / 2, t * hw, y0 + h));
      B.nor.push(0, 1, 0);
      B.uv.push(s * L / 2, t * hw);
    }
  }
  for (let i = 0; i < nl; i++) for (let j = 0; j < nt; j++) {
    const a = base + i * (nt + 1) + j, b = a + 1, c = a + nt + 1, d = c + 1;
    B.idx.push(a, c, b, b, c, d);
  }
  return W;
}
// thin eave band following the shell rim
function eave(B, F, L, W, y0, depth, nl = 64) {
  for (const side of [-1, 1]) {
    let per = 0;
    for (let i = 0; i < nl; i++) {
      const s0 = -1 + (2 * i) / nl, s1 = -1 + (2 * (i + 1)) / nl;
      const p = [s0 * L / 2, side * W(s0)], q = [s1 * L / 2, side * W(s1)];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      quad(B, F(p[0], p[1], y0 - depth), F(q[0], q[1], y0 - depth), F(q[0], q[1], y0 + 0.05), F(p[0], p[1], y0 + 0.05), [per, 0, per + len, 0, per + len, 1, per, 1]);
      per += len;
    }
  }
}
// round column
function column(B, F, a, s, y0, y1, r, n = 14) {
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * Math.PI * 2, t1 = ((i + 1) / n) * Math.PI * 2;
    quad(B, F(a + Math.cos(t0) * r, s + Math.sin(t0) * r, y0), F(a + Math.cos(t1) * r, s + Math.sin(t1) * r, y0),
      F(a + Math.cos(t1) * r, s + Math.sin(t1) * r, y1), F(a + Math.cos(t0) * r, s + Math.sin(t0) * r, y1));
  }
}

export function buildStations(ctx) {
  const { data, scene } = ctx;
  const group = new THREE.Group(); group.name = 'metro-stations'; scene.add(group);
  const spines = (data.viaducts || []).filter((v) => v.k === 'metro').map((v) => v.p);
  const uNight = { value: 0 };
  ctx.on('time', (s) => { uNight.value = s.night; });

  // ---- materials
  const shellMat = new THREE.MeshStandardMaterial({ color: '#d9c79f', metalness: 0.62, roughness: 0.36, side: THREE.DoubleSide });
  shellMat.onBeforeCompile = (s) => {
    s.uniforms.uNight = uNight;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vSUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvSUv = uv;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec2 vSUv; uniform float uNight;
      float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // staggered rows of small dark vents, as seen from above in photos of the shells
        vec2 cell = vec2(3.4, 1.7);
        vec2 g = vSUv / cell; float row = floor(g.y);
        g.x += mod(row, 2.0) * 0.5;
        vec2 id = floor(g), f = fract(g) - 0.5;
        float on = step(0.42, h21(id + row * 7.0));
        float vent = (1.0 - smoothstep(0.26, 0.3, abs(f.x))) * (1.0 - smoothstep(0.1, 0.14, abs(f.y))) * on;
        float seam = smoothstep(0.46, 0.5, abs(fract(vSUv.x / 4.0) - 0.5));
        diffuseColor.rgb *= 1.0 - 0.08 * seam;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.15, 0.14), vent * 0.85);`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.8, 0.52) * uNight * 0.2 * (1.0 - vent * 0.85);'); // floodlit at night, vents stay dark
  };
  const glassMat = new THREE.MeshStandardMaterial({ color: '#1e2c35', metalness: 0.3, roughness: 0.16, side: THREE.DoubleSide });
  glassMat.onBeforeCompile = (s) => {
    s.uniforms.uNight = uNight;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vGUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGUv = uv;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vGUv; uniform float uNight;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        // distance (m) to the nearest mullion / transom
        float du = (0.5 - abs(fract(vGUv.x / 1.6) - 0.5)) * 1.6;
        float dv = (0.5 - abs(fract(vGUv.y / 2.2) - 0.5)) * 2.2;
        float mu = 1.0 - smoothstep(0.05, 0.09, du), tr = 1.0 - smoothstep(0.04, 0.08, dv);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.7, 0.71, 0.72), max(mu, tr) * 0.85);`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.82, 0.55) * uNight * 0.34 * (1.0 - max(mu, tr) * 0.7);');
  };
  const whiteMat = new THREE.MeshStandardMaterial({ color: '#ece9e3', roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide });
  const concMat = new THREE.MeshStandardMaterial({ color: '#d6d0c5', roughness: 0.85, side: THREE.DoubleSide });
  if (ctx.env) { ctx.env.addReflective(shellMat, 1.0); ctx.env.addReflective(glassMat, 0.55); }

  const SH = sink(), GL = sink(), WH = sink(), CO = sink();
  const stationPts = [];
  for (const st of data.stations || []) {
    const near = nearestOnSpines(spines, [st.x, st.y]); if (!near || near.d > 90) continue;
    const c = near.q, dir = near.dir, z = near.z, w = near.w;
    const F = frameOf(c, dir);
    const edge = w / 2 - 1.3, PW = 5.6, out = edge + PW; // platform edge / outer face from the line centre
    const LP = 118, platTop = z + 1.0, eaveY = z + 5.2, concTop = z - 1.2, concFloor = z - 7.6;
    stationPts.push({ c, z, concFloor, name: st.n });
    // platforms (both sides) on the deck
    for (const sd of [-1, 1]) {
      const p0 = sd > 0 ? [edge, out] : [-out, -edge];
      const plan = [[-LP / 2, p0[0]], [LP / 2, p0[0]], [LP / 2, p0[1]], [-LP / 2, p0[1]]];
      walls(WH, F, plan, concTop, platTop); cap(WH, F, plan, platTop);
      // glazing between platform and eave on the outer face
      const gp = sd > 0 ? [[-LP / 2 + 6, out - 0.2], [LP / 2 - 6, out - 0.2]] : [[LP / 2 - 6, -out + 0.2], [-LP / 2 + 6, -out + 0.2]];
      walls(GL, F, gp, platTop, eaveY, false);
      // mullion posts carrying the shell
      for (let a = -LP / 2 + 6; a <= LP / 2 - 6; a += 9.5) column(WH, F, a, sd * (out - 0.2), platTop, eaveY, 0.22, 8);
    }
    // shell over everything
    const HW = out + 6.5, LS = 140, HS = 6.2;
    const W = shell(SH, F, LS, HW, HS, eaveY);
    eave(WH, F, LS, W, eaveY, 0.75);
    // concourse box under the platforms, glazed, white bands top and bottom
    const LC = 86, WC = 2 * out + 1.2;
    const plan = octo(LC, WC, 7);
    walls(GL, F, plan, concFloor, concTop - 0.9);
    walls(WH, F, plan, concTop - 0.9, concTop);
    walls(WH, F, plan, concFloor - 0.9, concFloor);
    cap(WH, F, plan, concFloor - 0.9, true); cap(WH, F, plan, concTop);
    // columns under the concourse
    for (let a = -LC / 2 + 8; a <= LC / 2 - 8; a += 14) for (const sd of [-1, 1]) column(CO, F, a, sd * (out - 2.4), -0.3, concFloor - 0.9, 0.85);
  }

  // ---- footbridges: enclosed skybridges at concourse level near stations, open bridges elsewhere
  const fbs = data.footbridges || [];
  // an end is free when no other bridge passes within a few metres (joins and T-junctions are not)
  const segD = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]); };
  const joined = (p, self) => fbs.some((o) => o !== self && o.p.some((q, i) => i > 0 && segD(p, o.p[i - 1], q) < 4.5));
  const pods = [];
  for (const fb of fbs) {
    const pts = fb.p; if (pts.length < 2) continue;
    const mid = pts[Math.floor(pts.length / 2)];
    const st = stationPts.find((s) => Math.hypot(s.c[0] - mid[0], s.c[1] - mid[1]) < 260);
    const enclosed = !!st || fb.c;
    const y = st ? st.concFloor : fb.l >= 2 ? 11 : 6.2;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
      const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      const F = frameOf(a, d);
      const hw = enclosed ? 2.8 : 1.8;
      const slab = [[-0.2, -hw], [L + 0.2, -hw], [L + 0.2, hw], [-0.2, hw]];
      walls(WH, F, slab, y - 0.8, y); cap(WH, F, slab, y - 0.8, true);
      if (enclosed) {
        walls(GL, F, [[-0.2, hw - 0.15], [L + 0.2, hw - 0.15]], y, y + 3.1, false);
        walls(GL, F, [[L + 0.2, -hw + 0.15], [-0.2, -hw + 0.15]], y, y + 3.1, false);
        // barrel roof in champagne metal (three facets)
        const r = [[-hw, y + 3.1], [-hw * 0.55, y + 3.85], [hw * 0.55, y + 3.85], [hw, y + 3.1]];
        for (let k = 0; k < 3; k++) quad(SH, F(-0.3, r[k][0], r[k][1]), F(L + 0.3, r[k][0], r[k][1]), F(L + 0.3, r[k + 1][0], r[k + 1][1]), F(-0.3, r[k + 1][0], r[k + 1][1]), [0, r[k][0], L, r[k][0], L, r[k + 1][0], 0, r[k + 1][0]]);
      } else {
        cap(CO, F, slab, y);
        walls(CO, F, [[-0.2, hw], [L + 0.2, hw]], y, y + 1.1, false);
        walls(CO, F, [[L + 0.2, -hw], [-0.2, -hw]], y, y + 1.1, false);
      }
      // piers for long spans
      if (L > 30) for (let s = 15; s < L - 8; s += 26) column(CO, F, s, 0, -0.3, y - 0.8, 0.55, 10);
    }
    // entrance pods at free ends (not continuing into another bridge), away from the station box
    if (enclosed) for (const [p, q] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]]) {
      if (joined(p, fb)) continue;
      if (st && Math.hypot(st.c[0] - p[0], st.c[1] - p[1]) < 45) continue;
      const L = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
      pods.push({ p, d: [(p[0] - q[0]) / L, (p[1] - q[1]) / L], y });
    }
  }
  for (const pod of pods) {
    // pod centred just beyond the bridge end, its long axis continuing the bridge
    const c = [pod.p[0] + pod.d[0] * 9, pod.p[1] + pod.d[1] * 9];
    const F = frameOf(c, pod.d);
    const plan = octo(24, 13, 3.5);
    walls(GL, F, plan, 0, pod.y + 3.2);
    walls(WH, F, plan, pod.y + 3.2, pod.y + 3.9);
    const W = shell(SH, F, 30, 9.5, 4.2, pod.y + 3.9, { ends: 2.2, nl: 24, nt: 12 });
    eave(WH, F, 30, W, pod.y + 3.9, 0.5, 24);
  }

  const add = (B, mat, name) => {
    if (!B.idx.length) return;
    const g = toGeo(B);
    if (mat === shellMat) g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; m.name = name; group.add(m);
  };
  add(SH, shellMat, 'station-shells');
  add(GL, glassMat, 'station-glass');
  add(WH, whiteMat, 'station-cladding');
  add(CO, concMat, 'station-concrete');
  return { group };
}
