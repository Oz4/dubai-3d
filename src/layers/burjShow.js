// Burj Khalifa's evening light show, simulated: the tower's LED facade (patterns in the building shader,
// layers/buildings.js), lasers and searchlights, and the Dubai Fountain's jets on the Burj Lake, all driven by one
// timeline. Between shows the tower keeps a soft evening glow on its fins and a flashing beacon on the spire.
// The fountain's nozzle lines follow OSM's outline of it (relation 15670582): five circles and two arcs, the longer
// about 300 m. Its jet types and heights follow the published description (shooters to about 150 m, swaying
// "oarsmen"); the choreography itself is invented for the demo, and so are the short interludes of low jets that
// play between shows (the real fountain rests between its scheduled shows) and the abras' loop on the lake.
import * as THREE from 'three';
import { GLSL_NOISE } from '../core/util.js';

const FOUNTAIN = {
  circles: [[13613.4, 12783.7, 19], [13686.4, 12809.2, 24], [13761.2, 12879.1, 13.6], [13817.9, 12889.4, 21], [13872.8, 12868, 13.5]],
  arcs: [
    [[13873.4, 12853.4], [13865, 12853.4], [13855.5, 12856.2], [13846, 12858.5], [13836.3, 12860.6], [13826.6, 12862.2], [13816.8, 12863.6], [13807, 12864.4], [13797.2, 12864.9], [13787.3, 12864.8], [13777.4, 12864.4], [13767.6, 12863.7], [13757.8, 12862.6], [13748.1, 12861], [13738.4, 12859.3], [13728.7, 12857.2], [13719.2, 12854.6], [13709.8, 12851.8], [13700.5, 12848.5], [13691.4, 12844.7], [13682.8, 12839.8], [13674.8, 12834], [13667.1, 12827.9], [13659.9, 12821.1], [13653.6, 12813.6], [13647.9, 12805.5], [13642.8, 12797.1], [13638.3, 12788.4], [13634.9, 12779.1], [13632.4, 12769.6], [13631.3, 12759.8], [13631.4, 12749.9], [13632.6, 12740.2], [13632.3, 12731.6]],
    [[13768.9, 12924.7], [13768.1, 12914.6], [13767.9, 12903.3], [13772, 12892.8], [13779, 12884.1], [13788, 12877.1], [13797.9, 12871.7], [13808.8, 12868.6], [13820, 12867.5], [13831.3, 12867.4], [13842.4, 12869.9], [13852.8, 12874.3], [13862.5, 12877.3]],
  ],
};
const WATER_Y = 0.06;
const BPM = 118, BEAT = 60 / BPM;

// the show: LED pattern (see LED_GLSL), its palette, laser mode, fountain mode and the fountain's light colour
const SEGMENTS = [
  { d: 6, led: 1, pal: ['#ffffff', '#fff1c9', '#ffffff'], laser: 0, fountain: 1, light: '#fff3dc' },
  { d: 10, led: 2, pal: ['#5b2bff', '#00c2ff', '#ff3db0'], laser: 1, fountain: 2, light: '#d6e8ff' },
  { d: 10, led: 3, pal: ['#ffcf73', '#ffffff', '#ff9f3d'], laser: 2, fountain: 3, light: '#ffe2b0' },
  { d: 8, led: 9, pal: ['#ff2d6f', '#ffffff', '#ff2d6f'], laser: 4, fountain: 4, light: '#ffffff' },
  { d: 10, led: 4, pal: ['#ffffff', '#ffffff', '#ffffff'], laser: 3, fountain: 6, light: '#ffffff' },
  { d: 10, led: 5, pal: ['#ff2a00', '#ff8a12', '#ffe07a'], laser: 5, fountain: 5, light: '#ffd29a' },
  { d: 8, led: 6, pal: ['#1f6bff', '#d9f1ff', '#1f6bff'], laser: 0, fountain: 2, light: '#bfe0ff' },
  { d: 11, led: 7, pal: ['#ffffff', '#ffffff', '#ffffff'], laser: 6, fountain: 7, light: '#fff6e6' },
  { d: 7, led: 8, pal: ['#ffc75a', '#fff4d6', '#ffb347'], laser: 0, fountain: 0, light: '#ffe2b0' },
];
const XFADE = 1.0;
const TOTAL = SEGMENTS.reduce((s, g) => s + g.d, 0);
SEGMENTS.forEach((g) => { g.palC = g.pal.map((h) => new THREE.Color(h)); g.lightC = new THREE.Color(g.light); });

// ---------------------------------------------------------------- fountain jets
const JET_VERT = /* glsl */ `
  attribute vec2 corner; attribute vec3 iPos; attribute vec4 iData; attribute vec2 iDir;
  uniform vec4 uMode, uMix; uniform float uPx;
  varying vec2 vUv; varying float vH, vSeed;
  float shot(float x) { return smoothstep(0.0, 0.12, x) * (1.0 - smoothstep(0.35, 0.95, x)); }
  // height (m) of a jet in a mode: s along its line 0..1, line id, type 0 ring jet, 1 oarsman, 2 shooter, 3 super shooter
  float jetH(float m, float t, float s, float line, float type, float seed, out float sway) {
    sway = 0.0;
    float beat = uMix.y;
    bool small = type < 0.5, oar = type > 0.5 && type < 1.5, shoot = type > 1.5 && type < 2.5, sup = type > 2.5;
    if (m < 0.5) return 0.0;
    if (m < 1.5) return sup ? 0.0 : (small ? 4.0 : 7.0) + 4.0 * sin(6.2831 * (s * 3.0 - t * 0.35 + line * 0.3));
    if (m < 2.5) { float w = pow(0.5 + 0.5 * sin(6.2831 * (s * 2.0 - t * 0.5)), 2.0); return sup ? 0.0 : small ? 8.0 + 10.0 * w : 16.0 + 46.0 * w; }
    if (m < 3.5) { sway = sin(t * 2.2 + line * 0.7) * 0.42; return oar ? 52.0 : shoot ? 20.0 : small ? 9.0 : 0.0; }
    if (m < 4.5) { float b = exp(-beat * 4.0); return (sup ? 70.0 : shoot ? 52.0 : oar ? 40.0 : 14.0) * (0.5 + 0.5 * b); }
    if (m < 5.5) { float ph = fract(t * 0.42 - s * 1.5 - line * 0.13); return sup ? 150.0 * shot(fract(t * 0.25 + seed)) : shoot ? 95.0 * shot(ph) : oar ? 18.0 : 6.0; }
    if (m < 6.5) { float ph = fract(s - t * 0.6 + line * 0.25); return small ? 30.0 * exp(-ph * 6.0) + 3.0 : sup ? 0.0 : 10.0 + 22.0 * pow(0.5 + 0.5 * sin(6.2831 * (s * 3.0 - t * 0.8)), 3.0); }
    if (m < 7.5) { sway = oar ? sin(t * 3.0 + s * 12.0) * 0.35 : 0.0; return sup ? 150.0 * shot(fract(t * 0.5 + seed * 0.5)) : shoot ? 120.0 * (0.6 + 0.4 * exp(-beat * 3.0)) : oar ? 70.0 : 32.0; }
    return 0.0;
  }
  void main() {
    float swA, swB;
    float hA = jetH(uMode.x, uMode.y, iData.x, iData.y, iData.z, iData.w, swA);
    float hB = jetH(uMode.z, uMode.w, iData.x, iData.y, iData.z, iData.w, swB);
    float h = max(0.0, mix(hA, hB, uMix.x)) * uMix.z * (0.92 + 0.16 * iData.w);
    float sw = mix(swA, swB, uMix.x);
    float y = corner.y;
    float typeW = iData.z < 0.5 ? 1.5 : iData.z < 1.5 ? 2.3 : iData.z < 2.5 ? 3.0 : 5.0;
    #ifdef MIST
      // spray and mist hanging round the foot of the busy jets
      float mh = min(h * 0.3, 26.0);
      vec3 axisP = iPos + vec3(0.0, mh * y, 0.0);
      float w = (6.0 + h * 0.12) * (0.8 + 0.5 * y);
      vH = mh;
    #else
      vec3 sd = vec3(iDir.x, 0.0, -iDir.y);
      vec3 axisP = iPos + vec3(0.0, h * y, 0.0) + sd * (sw * h * y * y);
      float w = typeW * (0.7 + 0.5 * y + 1.8 * smoothstep(0.72, 1.0, y));
      vH = h;
    #endif
    vec3 toCam = normalize(cameraPosition - axisP);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    vec4 mv = viewMatrix * vec4(axisP, 1.0);
    w = max(w, uPx * (projectionMatrix[3][3] > 0.5 ? 1.0 : -mv.z) * 1.6);
    vUv = vec2(corner.x, y); vSeed = iData.w;
    gl_Position = projectionMatrix * viewMatrix * vec4(axisP + right * corner.x * w * 0.5, 1.0);
  }`;
const JET_FRAG = /* glsl */ `
  uniform vec4 uMix; uniform float uT; uniform vec3 uCol;
  varying vec2 vUv; varying float vH, vSeed;
  ${GLSL_NOISE}
  void main() {
    if (vH < 0.5) discard;
    float x = vUv.x, y = vUv.y, night = uMix.w;
    #ifdef MIST
      float a = exp(-x * x * 2.6) * (1.0 - y) * smoothstep(0.0, 0.1, y) * (0.5 + 0.5 * vnoise(vec2(x * 3.0 + vSeed * 9.0, y * 4.0 - uT * 1.5))) * 0.07;
    #else
      float core = exp(-x * x * 5.0);
      float n = vnoise(vec2(x * 4.0 + vSeed * 31.0, y * vH * 0.18 - uT * 7.0));
      float n2 = vnoise(vec2(x * 9.0 - vSeed * 13.0, y * vH * 0.5 - uT * 11.0));
      float spray = smoothstep(0.62, 1.0, y);
      float a = core * (0.5 + 0.5 * n) * (1.0 - 0.55 * spray) + spray * exp(-x * x * 2.0) * (0.25 + 0.5 * n2) * 0.8;
      a *= smoothstep(0.0, 0.03, y) * (1.0 - smoothstep(0.86, 1.0, y));
      a = clamp(a, 0.0, 1.0) * 0.9;
    #endif
    vec3 col = mix(vec3(0.96, 0.98, 1.0), uCol * (0.7 + 0.9 * exp(-x * x * 5.0)), night);
    gl_FragColor = vec4(col * a, a * (1.0 - 0.45 * night));
  }`;

// ---------------------------------------------------------------- laser and searchlight beams (camera-facing strips)
const BEAM_VERT = /* glsl */ `
  attribute vec2 corner; attribute vec3 iO; attribute vec3 iD; attribute vec4 iC; attribute vec2 iLW;
  uniform float uPx;
  varying vec2 vUv; varying vec4 vC;
  void main() {
    vec4 mv = viewMatrix * vec4(iO + iD * iLW.x * corner.x, 1.0);
    vec3 dv = normalize((viewMatrix * vec4(iD, 0.0)).xyz);
    bool ortho = projectionMatrix[3][3] > 0.5;
    vec3 eye = ortho ? vec3(0.0, 0.0, 1.0) : normalize(mv.xyz);
    vec3 side = normalize(cross(dv, eye) + vec3(1e-5, 0.0, 0.0));
    float px = uPx * (ortho ? 1.0 : -mv.z);
    float w0 = iLW.y * (1.0 + corner.x * 2.5);
    float w = max(w0, px * 2.8);
    mv.xyz += side * corner.y * w * 0.5;
    gl_Position = projectionMatrix * mv;
    vUv = corner; vC = iC; vC.a *= max(0.4, sqrt(w0 / w));
  }`;
const BEAM_FRAG = /* glsl */ `
  varying vec2 vUv; varying vec4 vC;
  void main() {
    float x = vUv.y;
    float core = exp(-x * x * 9.0) * 1.2 + 0.35 * exp(-x * x * 1.6);
    float fade = pow(1.0 - vUv.x, 1.3) * smoothstep(0.0, 0.004, vUv.x);
    gl_FragColor = vec4(vC.rgb * vC.a * core * fade, 1.0);
  }`;

function stripGeometry(rows, xs = [-1, 1]) {
  const g = new THREE.InstancedBufferGeometry();
  const c = [], idx = [];
  rows.forEach((y) => xs.forEach((x) => c.push(x, y)));
  for (let r = 0; r < rows.length - 1; r++) { const a = r * 2, b = a + 1, d = a + 2, e = a + 3; idx.push(a, b, e, a, e, d); }
  g.setAttribute('corner', new THREE.Float32BufferAttribute(c, 2));
  g.setIndex(idx);
  return g;
}

export function createBurjShow(ctx, { buildings }) {
  const group = new THREE.Group(); group.name = 'burj-show';
  ctx.scene.add(group);
  const led = buildings.led;
  const bid = buildings.info.findIndex((b) => b && b.name === 'Burj Khalifa');
  const bInfo = bid >= 0 ? buildings.info[bid] : null;
  const axis = bInfo ? new THREE.Vector3(bInfo.center[0], 0, -bInfo.center[1]) : new THREE.Vector3(13585, 0, -13039);
  led.uLedB.value.w = bid;
  led.uLedC.value.set(axis.x, axis.z, 828);
  let night = 0;
  ctx.on('time', (s) => { night = s.night; });
  if (ctx.last.time) night = ctx.last.time.night;

  // ---- the fountain: nozzle rails on the water (the rings seen from above by day) and the jets
  const jets = [];
  const addLine = (pts, line, every, typeAt) => {
    const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = L[L.length - 1], n = Math.max(2, Math.round(total / every));
    for (let k = 0; k <= n; k++) {
      const t = (total * k) / n; let i = 1; while (i < L.length - 1 && L[i] < t) i++;
      const u = (t - L[i - 1]) / (L[i] - L[i - 1] || 1), a = pts[i - 1], b = pts[i];
      const tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
      jets.push({ p: [a[0] + tx * u, a[1] + ty * u], s: k / n, line, type: typeAt(k, n), dir: [-ty / tl, tx / tl] });
    }
  };
  FOUNTAIN.arcs.forEach((pts, i) => addLine(pts, i, 3.2, (k) => (k % 8 === 4 ? 3 : k % 2 ? 2 : 1)));
  FOUNTAIN.circles.forEach(([cx, cy, r], i) => {
    const n = 48, ring = Array.from({ length: n + 1 }, (_, k) => [cx + Math.cos((k / n) * Math.PI * 2) * r, cy + Math.sin((k / n) * Math.PI * 2) * r]);
    addLine(ring, 2 + i, 3.0, () => 0);
    jets.push({ p: [cx, cy], s: 0.5, line: 2 + i, type: 3, dir: [1, 0] });
  });
  const J = jets.length;
  const iPos = new Float32Array(J * 3), iData = new Float32Array(J * 4), iDir = new Float32Array(J * 2);
  jets.forEach((j, k) => {
    iPos.set([j.p[0], WATER_Y, -j.p[1]], k * 3);
    iData.set([j.s, j.line, j.type, ((k * 0.618034) % 1)], k * 4);
    iDir.set(j.dir, k * 2);
  });
  const fU = {
    uMode: { value: new THREE.Vector4() }, uMix: { value: new THREE.Vector4(0, 0, 0, 0) }, uPx: { value: 1 }, uT: { value: 0 },
    uCol: { value: new THREE.Color('#fff3dc') },
  };
  const mkJets = (mist) => {
    const g = stripGeometry(mist ? [0, 0.5, 1] : [0, 0.12, 0.3, 0.5, 0.7, 0.85, 1]);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
    g.setAttribute('iData', new THREE.InstancedBufferAttribute(iData, 4));
    g.setAttribute('iDir', new THREE.InstancedBufferAttribute(iDir, 2));
    g.instanceCount = J;
    const m = new THREE.ShaderMaterial({
      uniforms: fU, vertexShader: JET_VERT, fragmentShader: JET_FRAG, defines: mist ? { MIST: '' } : {},
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false; mesh.renderOrder = mist ? 3 : 4; mesh.visible = false;
    mesh.name = mist ? 'fountain-mist' : 'fountain-jets';
    group.add(mesh);
    return mesh;
  };
  const jetMesh = mkJets(false), mistMesh = mkJets(true);
  {
    // nozzle rails: pale pipes just under the surface of the lake
    const pos = [], idx = [];
    const ribbon = (pts, w) => {
      const b = pos.length / 3;
      pts.forEach((p, i) => {
        const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)];
        let tx = c[0] - a[0], ty = c[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
        pos.push(p[0] - ty * w, WATER_Y - 0.02, -(p[1] + tx * w), p[0] + ty * w, WATER_Y - 0.02, -(p[1] - tx * w));
      });
      for (let i = 0; i < pts.length - 1; i++) { const q = b + i * 2; idx.push(q, q + 1, q + 3, q, q + 3, q + 2); }
    };
    FOUNTAIN.arcs.forEach((pts) => ribbon(pts, 0.5));
    FOUNTAIN.circles.forEach(([cx, cy, r]) => ribbon(Array.from({ length: 49 }, (_, k) => [cx + Math.cos((k / 48) * Math.PI * 2) * r, cy + Math.sin((k / 48) * Math.PI * 2) * r]), 0.42));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ color: '#b9e4de', roughness: 0.6, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false });
    const rails = new THREE.Mesh(g, m); rails.name = 'fountain-rails'; rails.receiveShadow = true;
    group.add(rails);
  }

  // ---- abras: the small wooden boats that carry visitors round the lake, circling the fountain's long arc
  {
    const lake = (ctx.data.burjWalk || [])[0];
    const pin = (q, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
    const edge = (q, r) => { let best = Infinity; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length], dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); best = Math.min(best, Math.hypot(a[0] + dx * t - q[0], a[1] + dy * t - q[1])); } return best; };
    const arc = FOUNTAIN.arcs[0];
    const offset = (d) => arc.map((p, i) => { const a = arc[Math.max(0, i - 1)], c = arc[Math.min(arc.length - 1, i + 1)]; let tx = c[0] - a[0], ty = c[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l; return [p[0] - ty * d, p[1] + tx * d]; });
    let loop = null;
    if (lake) for (const [d0, d1] of [[22, -22], [16, -16], [11, -11]]) {
      const pts = offset(d0).concat(offset(d1).reverse());
      if (pts.every((q) => pin(q, lake) && edge(q, lake) > 6)) { loop = pts; break; }
    }
    if (loop) {
      const curve = new THREE.CatmullRomCurve3(loop.filter((_, i) => i % 2 === 0).map((q) => new THREE.Vector3(q[0], 0, -q[1])), true, 'centripetal');
      const len = curve.getLength();
      const hullG = new THREE.SphereGeometry(1, 12, 8); hullG.scale(3.3, 0.6, 1.05);
      const deckG = new THREE.BoxGeometry(4.4, 0.12, 1.5), roofG = new THREE.BoxGeometry(3.4, 0.12, 1.9), sideG = new THREE.BoxGeometry(3.0, 1.35, 0.08);
      const wood = new THREE.MeshStandardMaterial({ color: '#8a5a34', roughness: 0.8 }), pale = new THREE.MeshStandardMaterial({ color: '#c99a62', roughness: 0.8 });
      const cloth = new THREE.MeshStandardMaterial({ color: '#f3ecdb', roughness: 0.9 }), rail = new THREE.MeshStandardMaterial({ color: '#6d4526', roughness: 0.8, transparent: true, opacity: 0.55 });
      const abras = [];
      for (let k = 0; k < 4; k++) {
        const g = new THREE.Group(); g.name = 'abra';
        const add = (geo, mat, y, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(0, y, z); m.castShadow = true; g.add(m); };
        add(hullG, wood, 0.18); add(deckG, pale, 0.62); add(roofG, cloth, 2.05); add(sideG, rail, 1.35, 0.9); add(sideG, rail, 1.35, -0.9);
        group.add(g); abras.push({ g, t: k / 4 + (k % 2) * 0.06 });
      }
      const pt = new THREE.Vector3(), tan = new THREE.Vector3();
      let tt = 0;
      ctx.updaters.push((dt) => {
        tt += dt;
        for (const a of abras) {
          a.t = (a.t + (dt * 2.1) / len) % 1;
          curve.getPointAt(a.t, pt); curve.getTangentAt(a.t, tan);
          a.g.position.set(pt.x, WATER_Y + 0.04 * Math.sin(tt * 1.7 + a.t * 40), pt.z);
          a.g.rotation.y = Math.atan2(-tan.z, tan.x);
        }
      });
    }
  }

  // ---- lasers and searchlights
  const MAXB = 120;
  const bO = new Float32Array(MAXB * 3), bD = new Float32Array(MAXB * 3), bC = new Float32Array(MAXB * 4), bLW = new Float32Array(MAXB * 2);
  const bg = stripGeometry([0, 1]);
  // the strip runs along its length: swap so corner.x = along (0..1), corner.y = across (-1..1)
  {
    const c = bg.attributes.corner.array; for (let i = 0; i < c.length; i += 2) { const x = c[i], y = c[i + 1]; c[i] = y; c[i + 1] = x; }
  }
  const attrs = { iO: [bO, 3], iD: [bD, 3], iC: [bC, 4], iLW: [bLW, 2] };
  for (const [k, [arr, n]] of Object.entries(attrs)) { const a = new THREE.InstancedBufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); bg.setAttribute(k, a); }
  bg.instanceCount = 0;
  const bU = { uPx: fU.uPx };
  const beamMesh = new THREE.Mesh(bg, new THREE.ShaderMaterial({
    uniforms: bU, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  beamMesh.frustumCulled = false; beamMesh.renderOrder = 5; beamMesh.name = 'lasers';
  group.add(beamMesh);
  const COL = { green: new THREE.Color('#29ff5e'), cyan: new THREE.Color('#14e3ff'), magenta: new THREE.Color('#ff2bd9'), red: new THREE.Color('#ff2222'), blue: new THREE.Color('#3b5bff'), violet: new THREE.Color('#9a3bff'), white: new THREE.Color('#f4f7ff') };
  const GROUND_LIGHTS = [[13480, 12640], [13990, 12690], [13410, 12900], [13900, 12980], [13660, 12500], [13770, 13000]];
  let nb = 0;
  const _c = new THREE.Color();
  const beam = (ox, oy, oz, az, el, col, inten, len = 3600, w = 0.9) => {
    if (nb >= MAXB || inten < 0.01) return;
    const ce = Math.cos(el);
    bO.set([ox, oy, oz], nb * 3); bD.set([ce * Math.cos(az), Math.sin(el), -ce * Math.sin(az)], nb * 3);
    bC.set([col.r, col.g, col.b, inten], nb * 4); bLW.set([len, w], nb * 2);
    nb++;
  };
  const fromTop = (h, az, el, col, inten, len, w) => beam(axis.x, h, axis.z, az, el, col, inten, len, w);
  function lasers(mode, t, beat, k0) {
    if (mode === 1) for (let k = 0; k < 4; k++) fromTop(760, t * 0.35 + (k * Math.PI) / 2, 0.12 + 0.08 * Math.sin(t * 0.7 + k), COL.green, 2.4 * k0);
    else if (mode === 2) for (let k = 0; k < 16; k++) fromTop(600, -0.8 + (k / 15 - 0.5) * 2.4 + 0.6 * Math.sin(t * 0.8), 0.03 + 0.06 * Math.sin(t * 1.3 + k * 0.4), k % 2 ? COL.cyan : COL.magenta, 2.0 * k0);
    else if (mode === 3) for (let k = 0; k < 10; k++) fromTop(k % 2 ? 520 : 640, (k * Math.PI) / 5 + t * 0.5, 0.22 * Math.sin(t * 0.9 + k), k % 2 ? COL.red : COL.green, 2.2 * k0);
    else if (mode === 4) {
      for (let k = 0; k < 6; k++) fromTop(800, (k * Math.PI) / 3 + t * 0.4, 1.05 + 0.25 * Math.sin(t * 0.6 + k), COL.white, 0.9 * k0, 5200, 7);
      GROUND_LIGHTS.forEach(([x, y], k) => beam(x, 2, -y, t * 0.5 + k * 1.1, 1.2 + 0.2 * Math.sin(t * 0.8 + k * 2.0), COL.white, 0.8 * k0, 5200, 6));
    } else if (mode === 5) for (let k = 0; k < 18; k++) fromTop(720, (k * Math.PI * 2) / 18 + t * 0.6, -0.42 + 0.1 * Math.sin(t * 1.4 + k), k % 2 ? COL.blue : COL.violet, 2.2 * k0, 2200);
    else if (mode === 6) for (let k = 0; k < 28; k++) {
      _c.setHSL((k / 28 + t * 0.1) % 1, 1, 0.55);
      fromTop(k % 3 === 0 ? 780 : 560, (k * Math.PI * 2) / 28 + t * 1.1, 0.04 + 0.22 * Math.sin(t * 2 + k), _c.clone(), (beat < 0.45 ? 3.2 : 0.7) * k0, 3600, 1.3);
    }
  }

  // ---- the beacon on the spire
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 6, 6), toneMapped: false }));
  beacon.position.set(axis.x, 828.5, axis.z); beacon.name = 'spire-beacon';
  group.add(beacon);

  // ---- the timeline
  const S = { running: false, t: 0, paused: false };
  const bar = document.getElementById('show-bar'), barFill = document.getElementById('show-progress'), btn = document.getElementById('show-btn');
  const segAt = (t) => { let a = 0; for (let i = 0; i < SEGMENTS.length; i++) { if (t < a + SEGMENTS[i].d) return { i, t0: a }; a += SEGMENTS[i].d; } return { i: SEGMENTS.length - 1, t0: TOTAL - SEGMENTS[SEGMENTS.length - 1].d }; };
  let orbit = 0;
  function start() {
    if (!bInfo) return;
    S.running = true; S.t = 0; orbit = 0;
    if (ctx.ui && ctx.ui.current && night < 0.9) ctx.ui.setMinutes(20 * 60 + 15);
    ctx.flyTo({ target: new THREE.Vector3(13680, 320, -12960), zoom: 1.75, azimuth: THREE.MathUtils.degToRad(38), polar: THREE.MathUtils.degToRad(62), duration: 1.8 });
    if (bar) bar.hidden = false;
    if (btn) btn.classList.add('on');
    ctx.emit('burj-show', true);
  }
  function stop() {
    S.running = false;
    if (bar) bar.hidden = true;
    if (btn) btn.classList.remove('on');
    ctx.emit('burj-show', false);
  }
  if (btn) btn.addEventListener('click', () => (S.running ? stop() : start()));
  const stopBtn = document.getElementById('show-stop');
  if (stopBtn) stopBtn.addEventListener('click', stop);

  const pal = led.uLedPal.value;
  let idleT = 0;
  ctx.updaters.push((dt) => {
    // metres per pixel, so beams and jets never thin out below a pixel or two
    const cam = ctx.activeCamera, hPx = ctx.renderer.domElement.height || 1;
    fU.uPx.value = cam.isOrthographicCamera ? (cam.top - cam.bottom) / cam.zoom / hPx : (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / hPx;
    idleT += dt;
    // spire beacon: a white flash every 1.5 s after dark
    const ph = (idleT % 1.5) / 1.5;
    beacon.visible = night > 0.3 && ph < 0.08;
    nb = 0;
    const uA = led.uLedA.value, uB = led.uLedB.value;
    if (!S.running) {
      // between shows: the evening glow
      uA.set(10, idleT, 0, 0); uB.x = 0; uB.z = night > 0.05 ? night : 0;
      // the fountain plays a short interlude of low jets every minute and a half (invented, like the show itself)
      const cyc = idleT % 92, seq = [1, 2, 6, 1], dseg = 8, si = Math.min(3, Math.floor(cyc / dseg)), loc = cyc - si * dseg;
      const want = cyc < dseg * 4 - 2.5 ? 0.62 : 0, z0 = fU.uMix.value.z, mz = z0 + Math.sign(want - z0) * Math.min(Math.abs(want - z0), dt * (want ? 0.3 : 0.6));
      const xk = si < 3 ? Math.max(0, Math.min(1, (loc - (dseg - 2)) / 2)) : 0;
      if (cyc < dseg * 4) fU.uMode.value.set(seq[si], cyc, seq[si + 1] || seq[si], cyc);
      fU.uMix.value.set(xk * xk * (3 - 2 * xk), (idleT / BEAT) % 1, mz, night);
      fU.uCol.value.set('#fff3dc'); fU.uT.value = idleT;
      jetMesh.visible = mistMesh.visible = mz > 0.001;
      bg.instanceCount = 0;
      return;
    }
    if (!S.paused) S.t += dt;
    if (S.t >= TOTAL) { stop(); return; }
    const { i, t0 } = segAt(S.t);
    const seg = SEGMENTS[i], next = SEGMENTS[i + 1];
    const local = S.t - t0, toEnd = seg.d - local;
    // crossfade into the next segment over the last XFADE seconds of this one
    const x = next && toEnd < XFADE ? 1 - toEnd / XFADE : 0;
    const k = x > 0 ? x * x * (3 - 2 * x) : 0;
    const beat = (S.t / BEAT) % 1;
    uA.set(seg.led, local, next ? next.led : 0, next ? Math.max(0, -toEnd) : 0);
    uB.x = k; uB.y = beat;
    // fade in at the start and out over the last 3 s
    const master = Math.min(1, S.t / 1.5) * Math.min(1, (TOTAL - S.t) / 3);
    uB.z = 1.2 * master * Math.max(0.35, night);
    for (let c = 0; c < 3; c++) { pal[c].copy(seg.palC[c]); pal[c + 3].copy((next || seg).palC[c]); }
    // fountain
    const fm = fU.uMode.value; fm.set(seg.fountain, local, next ? next.fountain : 0, Math.max(0, local - seg.d));
    fU.uMix.value.set(k, beat, Math.min(1, fU.uMix.value.z + dt * 0.8), night);
    fU.uCol.value.copy(seg.lightC).lerp(next ? next.lightC : seg.lightC, k);
    fU.uT.value = S.t;
    jetMesh.visible = mistMesh.visible = true;
    // lasers
    lasers(seg.laser, S.t, beat, (1 - k) * master);
    if (next) lasers(next.laser, S.t, beat, k * master);
    bg.instanceCount = nb;
    for (const a of Object.keys(attrs)) bg.attributes[a].needsUpdate = true;
    // the glow of the show
    if (ctx.bloomAllowed !== false) { ctx.bloomPass.enabled = true; ctx.bloomPass.strength = 0.36 + 0.06 * night; }
    // a slow orbit round the tower while nobody touches the map
    if (S.t > 2 && !(ctx.isInteracting && ctx.isInteracting()) && ctx.activeCamera === ctx.camera) {
      orbit += dt;
      const c = ctx.camera, tg = ctx.controls.target;
      const off = c.position.clone().sub(tg), sph = new THREE.Spherical().setFromVector3(off);
      sph.theta += dt * 0.035;
      c.position.copy(tg).add(new THREE.Vector3().setFromSpherical(sph));
      c.lookAt(tg);
    }
    if (barFill) barFill.style.width = `${(S.t / TOTAL) * 100}%`;
  });
  ctx.on('burj-show', (on) => {
    if (!on && ctx.bloomPass) ctx.bloomPass.strength = 0.1 + 0.24 * night;
    // map labels step aside during the show (and come back if they were on)
    const lab = ctx.labels, st = ctx.layers && ctx.layers.state;
    if (lab) lab.setVisible(on ? false : !st || st.labels !== false);
  });

  // seek(t) jumps within a running show (handy for previewing a segment)
  return { start, stop, seek(t) { if (S.running) S.t = Math.max(0, Math.min(TOTAL - 0.1, t)); }, pause(p = true) { S.paused = p; }, get running() { return S.running; }, duration: TOTAL, group, jets: J };
}
