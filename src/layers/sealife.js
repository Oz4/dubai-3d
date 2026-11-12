// Life on the water off JBR, Bluewaters and Dubai Harbour: jet skis carving loops, kitesurfers tacking
// along the beach under arc kites, surfers and paddleboarders in the shallows, motor yachts,
// speedboats and sailboats cruising offshore, all leaving foam wakes. Placement uses the shore field
// from the ground layer (open water only: no lakes, no marina basin).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, pointInPoly } from '../core/util.js';
import { SEA_Y } from './ground.js';
import { yachtGeometry } from './marina.js';

function tint(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}
const rider = (vest, x = 0, lean = 0) => [
  tint(new THREE.CylinderGeometry(0.17, 0.2, 0.75, 6).rotateZ(lean).translate(x, 1.05, 0), vest),
  tint(new THREE.SphereGeometry(0.13, 6, 4).translate(x + Math.sin(-lean) * 0.45, 1.55, 0), '#8a5a3c'),
  tint(new THREE.CylinderGeometry(0.08, 0.08, 0.7, 4).translate(x, 0.45, 0.12), '#1f2a36'),
  tint(new THREE.CylinderGeometry(0.08, 0.08, 0.7, 4).translate(x, 0.45, -0.12), '#1f2a36'),
];
// all craft point their bow along +x
function jetSkiGeo() {
  const s = new THREE.Shape(); s.moveTo(-1.5, -0.55); s.lineTo(0.9, -0.6); s.quadraticCurveTo(1.7, -0.2, 1.75, 0); s.quadraticCurveTo(1.7, 0.2, 0.9, 0.6); s.lineTo(-1.5, 0.55); s.closePath();
  const hull = new THREE.ExtrudeGeometry(s, { depth: 0.55, bevelEnabled: false, curveSegments: 3 }).rotateX(-Math.PI / 2);
  return mergeGeometries([tint(hull, '#ffffff'), tint(new THREE.BoxGeometry(1.1, 0.18, 0.45).translate(-0.4, 0.64, 0), '#22272d'), ...rider('#f08a24', -0.35, 0.25)], false);
}
function kiteBoardGeo() {
  return mergeGeometries([tint(new THREE.BoxGeometry(1.45, 0.06, 0.45), '#ffffff'), ...rider('#2a2f38', 0, -0.35)], false);
}
function surferGeo(standing) {
  const board = tint(new THREE.BoxGeometry(2.8, 0.08, 0.62), standing ? '#f4f1e6' : '#f1c94a');
  if (standing) return mergeGeometries([board, ...rider('#e2453a', 0, 0), tint(new THREE.CylinderGeometry(0.025, 0.025, 2.0, 4).rotateZ(0.35).translate(0.35, 1.0, 0.35), '#3a3a3a')], false);
  return mergeGeometries([board, tint(new THREE.CylinderGeometry(0.17, 0.17, 0.9, 6).rotateZ(Math.PI / 2).translate(-0.2, 0.22, 0), '#1e2833'), tint(new THREE.SphereGeometry(0.13, 6, 4).translate(0.35, 0.3, 0), '#8a5a3c')], false);
}
function speedboatGeo() {
  const s = new THREE.Shape(); s.moveTo(-3.4, -1.15); s.lineTo(1.2, -1.25); s.quadraticCurveTo(3.2, -0.9, 3.7, 0); s.quadraticCurveTo(3.2, 0.9, 1.2, 1.25); s.lineTo(-3.4, 1.15); s.closePath();
  const hull = new THREE.ExtrudeGeometry(s, { depth: 1.0, bevelEnabled: false, curveSegments: 4 }).rotateX(-Math.PI / 2);
  return mergeGeometries([
    tint(hull, '#fbfbfa'),
    tint(new THREE.BoxGeometry(6.9, 0.18, 2.42).translate(0.1, 0.55, 0), '#1d3557'),
    tint(new THREE.BoxGeometry(1.0, 0.55, 2.0).rotateZ(0.5).translate(0.4, 1.25, 0), '#22313f'),
    tint(new THREE.BoxGeometry(2.6, 0.12, 2.0).translate(-1.8, 1.02, 0), '#c49a6c'),
  ], false);
}
function sailboatGeo() {
  const s = new THREE.Shape(); s.moveTo(-4.2, -1.3); s.lineTo(1.5, -1.45); s.quadraticCurveTo(4.0, -1.0, 4.6, 0); s.quadraticCurveTo(4.0, 1.0, 1.5, 1.45); s.lineTo(-4.2, 1.3); s.closePath();
  const hull = new THREE.ExtrudeGeometry(s, { depth: 1.1, bevelEnabled: false, curveSegments: 4 }).rotateX(-Math.PI / 2);
  const main = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0.4, 1.6, 0), new THREE.Vector3(0.4, 13.5, 0), new THREE.Vector3(-3.6, 1.8, 0)]);
  const jib = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0.6, 1.5, 0), new THREE.Vector3(0.6, 11.5, 0), new THREE.Vector3(4.2, 1.3, 0)]);
  main.computeVertexNormals(); jib.computeVertexNormals();
  return mergeGeometries([
    tint(hull, '#ffffff'), tint(new THREE.BoxGeometry(3.0, 0.6, 1.8).translate(-0.8, 1.4, 0), '#e9e6de'),
    tint(new THREE.CylinderGeometry(0.06, 0.08, 13, 5).translate(0.5, 7.6, 0), '#c9ccce'),
    tint(main, '#fbfaf6'), tint(jib, '#f3f1ea'),
  ], false);
}
function kiteGeo() {
  // arc (leading-edge inflatable) kite: curved strip, 9 m span, 2.4 m chord, canopy along +z when flying
  const pos = [], col = [], idx = []; const N = 12;
  for (let i = 0; i <= N; i++) {
    const t = -1 + (2 * i) / N, ang = t * 1.15;
    const x = Math.sin(ang) * 4.6, y = Math.cos(ang) * 4.6 - 4.6;
    for (const [c, k] of [[-1.25, 0.65], [1.25, 1.0]]) { pos.push(x, y, c * (1 - 0.35 * t * t)); col.push(k, k, k); }
    if (i) { const b = (i - 1) * 2; idx.push(b, b + 1, b + 3, b, b + 3, b + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export function buildSeaLife(ctx, ground) {
  const { data, scene, bounds: B } = ctx;
  const info = ground && ground.shoreTex && ground.shoreTex.userData.info; if (!info) return { group: null };
  const group = new THREE.Group(); group.name = 'sealife'; scene.add(group);
  const r = rng(9911);
  const at = (x, y) => {
    const c = Math.max(0, Math.min(info.w - 1, Math.floor(((x - B.x0) / B.w) * info.w)));
    const rr = Math.max(0, Math.min(info.h - 1, Math.floor(((B.y1 - y) / B.h) * info.h)));
    const i = rr * info.w + c; return { m: info.mask[i], n: info.near[i], w: info.wide[i] };
  };
  const lakes = data.areas.water || [], marina = data.areas.marina || [];
  const inner = (x, y) => lakes.some((p) => pointInPoly([x, y], p)) || marina.some((p) => pointInPoly([x, y], p));
  const zone = (test) => (x, y) => {
    if (x < B.x0 + 30 || x > B.x1 - 30 || y < B.y0 + 30 || y > B.y1 - 30) return false;
    const s = at(x, y); if (s.m > 0.3) return false;
    return test(s) && !inner(x, y);
  };
  const ZONES = {
    surf: zone((s) => s.n > 0.28 && s.n < 0.72),
    kite: zone((s) => s.n < 0.3 && s.w > 0.35 && s.w < 0.97),
    jet: zone((s) => s.n < 0.05 && s.w > 0.18 && s.w < 0.62),
    boat: zone((s) => s.n < 0.02 && s.w < 0.38),
  };
  // shore tangent at a point (perpendicular to the gradient of the shore field)
  const tangent = (x, y) => {
    const e = 12, gx = at(x + e, y).w - at(x - e, y).w, gy = at(x, y + e).w - at(x, y - e).w;
    const l = Math.hypot(gx, gy) || 1; return [-gy / l, gx / l];
  };
  const spawn = (test, n, tries = 4000) => {
    const out = [];
    for (let k = 0; k < tries && out.length < n; k++) {
      const x = B.x0 + r() * B.w, y = B.y0 + r() * B.h;
      if (!test(x, y)) continue;
      if (out.some((q) => Math.hypot(q[0] - x, q[1] - y) < 70)) continue;
      out.push([x, y]);
    }
    return out;
  };
  // elongated loop that must stay inside its zone; shrunk until it does
  const loop = (c, test, A, Bm, rot) => {
    for (let s = 1; s > 0.15; s *= 0.8) {
      const ok = Array.from({ length: 16 }, (_, k) => k / 16 * Math.PI * 2).every((t) => {
        const lu = Math.cos(t) * A * s, lv = Math.sin(t) * Bm * s;
        return test(c[0] + rot[0] * lu - rot[1] * lv, c[1] + rot[1] * lu + rot[0] * lv);
      });
      if (ok) return { c, A: A * s, B: Bm * s, rot };
    }
    return null;
  };

  const craft = [];
  const add = (kind, path, speed, extra = {}) => craft.push({ kind, path, speed, phase: r() * Math.PI * 2, ...extra });
  for (const c of spawn(ZONES.jet, 11)) { const a = r() * Math.PI; const L = loop(c, ZONES.jet, 70 + r() * 40, 35 + r() * 20, [Math.cos(a), Math.sin(a)]); if (L) add('jet', L, 13 + r() * 5, { fig8: r() < 0.5 }); }
  for (const c of spawn(ZONES.kite, 11)) { const t = tangent(c[0], c[1]); const L = loop(c, ZONES.kite, 150 + r() * 60, 26, t); if (L) add('kite', L, 8 + r() * 3, { kite: Math.floor(r() * 5) }); }
  for (const c of spawn(ZONES.surf, 16)) { const t = tangent(c[0], c[1]); const L = loop(c, ZONES.surf, 14 + r() * 10, 3, t); if (L) add(r() < 0.55 ? 'sup' : 'surf', L, 0.7 + r() * 0.5); }
  for (const c of spawn(ZONES.boat, 18)) {
    const t = tangent(c[0], c[1]); const kind = r() < 0.4 ? 'yacht' : r() < 0.5 ? 'speed' : 'sail';
    const L = loop(c, ZONES.boat, 380 + r() * 300, 70 + r() * 40, t);
    if (L) add(kind, L, kind === 'speed' ? 11 + r() * 4 : kind === 'yacht' ? 6 + r() * 2 : 3 + r() * 1.2, { scale: kind === 'yacht' ? 1.5 + r() * 1.2 : 1 });
  }

  // ---- instanced meshes per kind
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide });
  const GEO = { jet: jetSkiGeo(), kite: kiteBoardGeo(), sup: surferGeo(true), surf: surferGeo(false), yacht: yachtGeometry(), speed: speedboatGeo(), sail: sailboatGeo() };
  const inst = {};
  for (const [k, g] of Object.entries(GEO)) {
    const n = craft.filter((c) => c.kind === k).length; if (!n) continue;
    const m = new THREE.InstancedMesh(g, mat, n); m.castShadow = true; m.frustumCulled = false; m.name = 'sea-' + k;
    inst[k] = m; group.add(m);
  }
  const kites = craft.filter((c) => c.kind === 'kite');
  const KCOL = ['#e8402e', '#1f8fd6', '#f4c430', '#db2f8a', '#27b36b'];
  const kiteMesh = kites.length ? new THREE.InstancedMesh(kiteGeo(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), kites.length) : null;
  if (kiteMesh) { kiteMesh.frustumCulled = false; kites.forEach((k, i) => kiteMesh.setColorAt(i, new THREE.Color(KCOL[k.kite]))); kiteMesh.castShadow = true; group.add(kiteMesh); }
  const lineMesh = kites.length ? new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 3).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: '#3a3a3a' }), kites.length * 2) : null;
  if (lineMesh) { lineMesh.frustumCulled = false; group.add(lineMesh); }

  // ---- foam wakes: per craft a short history, drawn as widening, fading strips
  const NW = 26;
  const movers = craft.filter((c) => c.kind !== 'surf');
  const wpos = new Float32Array(movers.length * NW * 2 * 3), walpha = new Float32Array(movers.length * NW * 2), wside = new Float32Array(movers.length * NW * 2);
  const widx = [];
  movers.forEach((c, k) => {
    c.trail = []; c.tAcc = 0;
    for (let i = 0; i < NW - 1; i++) { const b = (k * NW + i) * 2; widx.push(b, b + 1, b + 3, b, b + 3, b + 2); }
    for (let i = 0; i < NW; i++) { wside[(k * NW + i) * 2] = -1; wside[(k * NW + i) * 2 + 1] = 1; }
  });
  const wgeo = new THREE.BufferGeometry();
  wgeo.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
  wgeo.setAttribute('aAlpha', new THREE.BufferAttribute(walpha, 1));
  wgeo.setAttribute('aSide', new THREE.BufferAttribute(wside, 1));
  wgeo.setIndex(widx);
  const uTime = { value: 0 };
  const wmat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { uTime },
    vertexShader: `attribute float aAlpha; attribute float aSide; varying float vA; varying float vS; varying vec2 vW;
      void main() { vA = aAlpha; vS = aSide; vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: `uniform float uTime; varying float vA; varying float vS; varying vec2 vW;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        float edge = 1.0 - abs(vS);
        float lace = n(vW * 1.3 + uTime * 0.4) * 0.6 + n(vW * 3.1) * 0.4;
        float a = vA * smoothstep(0.0, 0.5, edge) * (0.45 + 0.75 * lace) + vA * 0.5 * smoothstep(0.75, 1.0, abs(vS)) * lace;
        gl_FragColor = vec4(vec3(0.96, 0.99, 1.0), clamp(a, 0.0, 0.9));
      }`,
  });
  const wakes = new THREE.Mesh(wgeo, wmat); wakes.frustumCulled = false; wakes.renderOrder = 3; wakes.name = 'wakes';
  group.add(wakes);

  // ---- animation
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), sc = new THREE.Vector3(), pv = new THREE.Vector3();
  const counters = {};
  let night = 0; ctx.on('time', (s) => { night = s.night; });
  const posAt = (c, t) => {
    const P = c.path; let lu = Math.cos(t) * P.A, lv = Math.sin(t) * P.B;
    if (c.fig8) lv = Math.sin(2 * t) * P.B * 0.6;
    return [P.c[0] + P.rot[0] * lu - P.rot[1] * lv, P.c[1] + P.rot[1] * lu + P.rot[0] * lv];
  };
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
  let enabled = true;
  ctx.updaters.push((dt, tt) => {
    if (!enabled) return;
    dt = Math.min(dt, 0.1); uTime.value = tt;
    for (const k in counters) counters[k] = 0;
    const playful = night < 0.55; // kites, jet skis and surfers head in after dark
    let ki = 0, wi = 0;
    for (const c of craft) {
      const P = c.path; const per = (Math.PI * 2 * Math.sqrt((P.A * P.A + P.B * P.B) / 2)) || 1;
      c.phase += (c.speed / per) * Math.PI * 2 * dt;
      const p0 = posAt(c, c.phase), p1 = posAt(c, c.phase + 0.01);
      const head = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      const p2 = posAt(c, c.phase + 0.03); const turn = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) - head;
      const lean = Math.max(-0.5, Math.min(0.5, Math.atan2(Math.sin(turn), Math.cos(turn)) * 6));
      const bob = Math.sin(tt * 1.7 + c.phase * 3) * 0.12;
      const visible = playful || c.kind === 'yacht' || c.kind === 'speed' || c.kind === 'sail';
      const s = c.scale || 1;
      pv.set(p0[0], SEA_Y + (c.kind === 'yacht' ? -0.45 * s : c.kind === 'jet' || c.kind === 'kite' ? 0.05 : -0.1) + bob, -p0[1]);
      e.set(c.kind === 'sail' ? -0.18 : (c.kind === 'jet' ? -lean : c.kind === 'kite' ? -lean * 0.5 : 0) * 0.8, head, 0.04 * Math.sin(tt * 2.1 + c.phase));
      q.setFromEuler(e); sc.set(s, s, s);
      m4.compose(pv, q, sc);
      const im = inst[c.kind]; counters[c.kind] = counters[c.kind] || 0;
      im.setMatrixAt(counters[c.kind]++, visible ? m4 : HIDE);
      if (c.kind === 'kite' && kiteMesh) {
        // kite flies downwind (wind off the sea, from the north-west) about 22 m up
        const wind = [0.62, -0.78];
        const kx = p0[0] + wind[0] * 20 + Math.sin(tt * 0.5 + c.phase) * 4, ky = p0[1] + wind[1] * 20, kz = SEA_Y + 17 + Math.sin(tt * 0.7 + c.phase) * 1.5;
        // basis: +y along the lines, +x along the span (across the wind), +z the canopy chord
        const ly = new THREE.Vector3(kx - p0[0], kz - SEA_Y - 1.2, -(ky - p0[1])).normalize();
        const lx = new THREE.Vector3(-wind[1], 0, -wind[0]); lx.sub(ly.clone().multiplyScalar(lx.dot(ly))).normalize();
        const lz = new THREE.Vector3().crossVectors(lx, ly);
        m4.makeBasis(lx, ly, lz).setPosition(kx, kz, -ky);
        kiteMesh.setMatrixAt(ki, visible ? m4 : HIDE);
        for (const side of [-1, 1]) {
          const ax = p0[0], ay = p0[1], az = SEA_Y + 1.2;
          const tip = new THREE.Vector3(kx - 4.2 * side * wind[1], kz - 1.2, -(ky + 4.2 * side * wind[0]));
          const from = new THREE.Vector3(ax, az, -ay), d = tip.clone().sub(from);
          const lq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
          m4.compose(from, lq, new THREE.Vector3(1, d.length(), 1));
          lineMesh.setMatrixAt(ki * 2 + (side > 0 ? 1 : 0), visible ? m4 : HIDE);
        }
        ki++;
      }
      if (c.trail) {
        c.tAcc += dt;
        if (c.tAcc > (c.kind === 'sup' ? 1.2 : 0.22) || !c.trail.length) { c.tAcc = 0; c.trail.unshift([p0[0], p0[1], head]); if (c.trail.length > NW) c.trail.pop(); }
        else c.trail[0] = [p0[0], p0[1], head];
        const base = wi * NW;
        const w0 = c.kind === 'yacht' ? 2.2 * s : c.kind === 'speed' ? 1.6 : c.kind === 'sail' ? 1.2 : c.kind === 'sup' ? 0.35 : 0.8;
        const fade = visible ? (c.kind === 'sail' || c.kind === 'sup' ? 0.35 : 0.85) : 0;
        for (let i = 0; i < NW; i++) {
          const tp = c.trail[Math.min(i, c.trail.length - 1)];
          const age = i / (NW - 1), w = w0 + age * w0 * 3.5;
          const nx = -Math.sin(tp[2]), ny = Math.cos(tp[2]);
          const v = (base + i) * 2;
          wpos.set([tp[0] + nx * w, SEA_Y + 0.08, -(tp[1] + ny * w)], v * 3);
          wpos.set([tp[0] - nx * w, SEA_Y + 0.08, -(tp[1] - ny * w)], (v + 1) * 3);
          const a = i < c.trail.length ? (1 - age) * fade : 0;
          walpha[v] = walpha[v + 1] = a;
        }
        wi++;
      }
    }
    for (const k in inst) inst[k].instanceMatrix.needsUpdate = true;
    if (kiteMesh) kiteMesh.instanceMatrix.needsUpdate = true;
    if (lineMesh) lineMesh.instanceMatrix.needsUpdate = true;
    wgeo.attributes.position.needsUpdate = true; wgeo.attributes.aAlpha.needsUpdate = true;
  });
  console.info(`[sealife] ${craft.length} craft: ` + Object.entries(craft.reduce((a, c) => ((a[c.kind] = (a[c.kind] || 0) + 1), a), {})).map(([k, v]) => `${v} ${k}`).join(', '));
  return { group, craft, setEnabled(on) { enabled = on; group.visible = on; } };
}
