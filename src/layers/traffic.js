import * as THREE from 'three';
import { rng } from '../core/util.js';
import { CAR_KINDS, CAR_COLORS, carKind, busGeometry } from './vehicles.js';

const SPEED = { 10: 24, 9: 20, 8: 16, 7: 14, 6: 12, 5: 11, 4: 8, 3: 6 };

export function createTraffic(ctx) {
  const { data, scene } = ctx;
  const G = data.graph;
  const r = rng(42);
  // directed edge geometry
  const edges = G.edges.map((e, i) => {
    const pts = e.p; const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    return { i, a: e.a, b: e.b, pts, cum, len: cum[cum.length - 1], rank: e.k, lanes: Math.max(1, Math.round(e.l)), oneway: e.o, width: e.w };
  }).filter((e) => e.len > 0.5);
  const out = G.nodes.map(() => []);
  for (const e of edges) {
    if (e.oneway !== -1) out[e.a].push({ e, dir: 1 });
    if (e.oneway !== 1) out[e.b].push({ e, dir: -1 });
  }
  // spawn weights
  // (the motorways and main roads carry most of the traffic, so they look busy; back streets see a car now and then)
  const weights = edges.map((e) => e.len * e.lanes * (e.rank >= 9 ? 4.5 : e.rank >= 7 ? 2.2 : e.rank >= 5 ? 0.9 : 0.3));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const pickEdge = () => { let x = r() * totalW; for (let i = 0; i < edges.length; i++) { x -= weights[i]; if (x <= 0) return edges[i]; } return edges[edges.length - 1]; };
  const colW = CAR_COLORS.reduce((a, c) => a + c[1], 0);
  const pickColor = () => { let x = r() * colW; for (const [c, w] of CAR_COLORS) { x -= w; if (x <= 0) return c; } return '#ffffff'; };

  const NCARS = 6000, NBUS = 160; // sized for the whole built map (five sections)
  const mkMesh = (geo, n) => {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.25 });
    mat.onBeforeCompile = (s) => {
      s.uniforms.uNight = uNight;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aLight; varying float vLight;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = aLight;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying float vLight;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          if (vLight > 0.5) totalEmissiveRadiance += (vLight < 1.5 ? vec3(1.0, 0.92, 0.75) * 6.0 : vec3(1.0, 0.08, 0.05) * 4.0) * (0.15 + uNight);`);
    };
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.castShadow = false; m.receiveShadow = true;
    m.frustumCulled = false;
    return m;
  };
  const uNight = { value: 0 };
  ctx.on('time', (s) => { uNight.value = s.night; });
  // one instanced mesh per kind of car (sedan, SUV, hatchback, pickup, taxi), sized to its share of the traffic
  const kindOf = [], kindN = CAR_KINDS.map(() => 0), kindIdx = [];
  for (let i = 0; i < NCARS; i++) { const k = carKind(r()); kindOf.push(k); kindIdx.push(kindN[k]++); }
  const carMeshes = CAR_KINDS.map((K, k) => mkMesh(K.make(), Math.max(1, kindN[k])));
  const busMesh = mkMesh(busGeometry(), NBUS);
  const group = new THREE.Group(); group.name = 'traffic'; group.add(...carMeshes, busMesh); scene.add(group);

  // Trails: a short streak behind every vehicle that follows the road's curve and fades out, pale by day (speed
  // lines) and a red tail-light smear after dark.
  const TR = 5, NV = NCARS + NBUS;
  const tPos = new Float32Array(NV * TR * 6), tTU = new Float32Array(NV * TR * 4), tIdx = [];
  for (let i = 0; i < NV; i++) for (let j = 0; j < TR; j++) {
    const o = (i * TR + j) * 4; tTU[o] = tTU[o + 2] = j / (TR - 1); tTU[o + 1] = 0; tTU[o + 3] = 1;
    if (j < TR - 1) { const b = (i * TR + j) * 2; tIdx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  const tGeo = new THREE.BufferGeometry(), tPosAttr = new THREE.BufferAttribute(tPos, 3);
  tPosAttr.setUsage(THREE.DynamicDrawUsage);
  tGeo.setAttribute('position', tPosAttr); tGeo.setAttribute('aTU', new THREE.BufferAttribute(tTU, 2)); tGeo.setIndex(tIdx);
  tGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const trails = new THREE.Mesh(tGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: { uNight },
    vertexShader: 'attribute vec2 aTU; varying vec2 vTU; void main() { vTU = aTU; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uNight; varying vec2 vTU;
      void main() {
        float a = 1.0 - vTU.x; a *= a;
        float e = smoothstep(0.0, 0.75, 1.0 - abs(vTU.y * 2.0 - 1.0));
        // by day two pale speed lines off the car's flanks over a faint haze; by night one soft red smear
        float lines = max(1.0 - smoothstep(0.03, 0.1, abs(vTU.y - 0.2)), 1.0 - smoothstep(0.03, 0.1, abs(vTU.y - 0.8)));
        float day = a * (0.14 * e + 0.62 * lines), night = a * e * 0.62;
        gl_FragColor = vec4(mix(vec3(1.0), vec3(1.0, 0.14, 0.07) * 2.6, uNight), mix(day, night, uNight));
      }`,
  }));
  trails.frustumCulled = false; trails.renderOrder = 2; trails.name = 'car-trails';
  group.add(trails);

  const vehicles = [];
  const spawn = (v) => {
    const e = pickEdge();
    const dirs = [];
    if (e.oneway !== -1) dirs.push(1); if (e.oneway !== 1) dirs.push(-1);
    v.e = e; v.dir = dirs[(r() * dirs.length) | 0];
    v.s = r() * e.len;
    v.lane = (r() * (e.oneway ? e.lanes : Math.max(1, Math.floor(e.lanes / 2)))) | 0;
    v.speed = (SPEED[e.rank] || 8) * (0.8 + r() * 0.4) * (v.bus ? 0.8 : 1);
    v.seg = 0;
  };
  const col = new THREE.Color();
  for (let i = 0; i < NCARS + NBUS; i++) {
    const bus = i >= NCARS, k = bus ? -1 : kindOf[i];
    const v = { bus, idx: bus ? i - NCARS : kindIdx[i], mesh: bus ? busMesh : carMeshes[k] };
    spawn(v);
    col.set(bus ? (r() < 0.6 ? '#e8e9ea' : '#d7383b') : CAR_KINDS[k].fixed ? '#ffffff' : CAR_KINDS[k].colors ? CAR_KINDS[k].colors[Math.floor(r() * CAR_KINDS[k].colors.length)] : pickColor());
    v.mesh.setColorAt(v.idx, col);
    vehicles.push(v);
  }

  function next(v) {
    const node = v.dir === 1 ? v.e.b : v.e.a;
    let opts = out[node].filter((o) => o.e !== v.e);
    if (!opts.length) { spawn(v); return; }
    // prefer going straight
    const pts = v.e.pts, n = pts.length;
    const a = v.dir === 1 ? pts[n - 2] : pts[1], b = v.dir === 1 ? pts[n - 1] : pts[0];
    const h0 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const scored = opts.map((o) => {
      const p = o.e.pts, m2 = p.length;
      const c = o.dir === 1 ? p[0] : p[m2 - 1], d = o.dir === 1 ? p[1] : p[m2 - 2];
      let dh = Math.abs(Math.atan2(d[1] - c[1], d[0] - c[0]) - h0); if (dh > Math.PI) dh = 2 * Math.PI - dh;
      return { o, dh, w: (o.e.rank >= v.e.rank - 1 ? 1.5 : 0.6) / (0.3 + dh) };
    });
    let tw = scored.reduce((s, x) => s + x.w, 0), x = r() * tw, pick = scored[0].o;
    for (const s of scored) { x -= s.w; if (x <= 0) { pick = s.o; break; } }
    v.e = pick.e; v.dir = pick.dir; v.s = 0; v.seg = 0;
    const lanes = v.e.oneway ? v.e.lanes : Math.max(1, Math.floor(v.e.lanes / 2));
    v.lane = Math.min(v.lane, lanes - 1);
    v.speed = (SPEED[v.e.rank] || 8) * (0.8 + r() * 0.4) * (v.bus ? 0.8 : 1);
  }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  let enabled = true;
  ctx.updaters.push((dt) => {
    if (!enabled) return;
    dt = Math.min(dt, 0.1);
    for (let vi = 0; vi < vehicles.length; vi++) {
      const v = vehicles[vi];
      if (v.idx >= v.mesh.count) { if (!v.hid) { tPos.fill(0, vi * TR * 6, (vi + 1) * TR * 6); v.hid = true; } continue; } // beyond the current density
      v.hid = false;
      v.s += v.speed * dt;
      let guard = 0;
      while (v.s > v.e.len && guard++ < 4) { const over = v.s - v.e.len; next(v); v.s = over; }
      const e = v.e, cum = e.cum, pts = e.pts;
      const sAbs = v.dir === 1 ? v.s : e.len - v.s;
      let k = Math.min(v.seg, cum.length - 2);
      // locate segment (search from cached index)
      if (v.dir === 1) { while (k < cum.length - 2 && cum[k + 1] < sAbs) k++; while (k > 0 && cum[k] > sAbs) k--; }
      else { while (k > 0 && cum[k] > sAbs) k--; while (k < cum.length - 2 && cum[k + 1] < sAbs) k++; }
      v.seg = k;
      const a = pts[k], b = pts[k + 1], L = cum[k + 1] - cum[k] || 1, t = (sAbs - cum[k]) / L;
      let dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
      if (v.dir === -1) { dx = -dx; dy = -dy; }
      const lanes = e.oneway ? e.lanes : Math.max(1, Math.floor(e.lanes / 2));
      const lw = e.width / (e.oneway ? e.lanes : Math.max(2, e.lanes));
      const off = e.oneway ? (v.lane - (lanes - 1) / 2) * lw : (v.lane + 0.5) * lw;
      const x = a[0] + (b[0] - a[0]) * t + dy * off, n = a[1] + (b[1] - a[1]) * t - dx * off;
      const y = (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t;
      pos.set(x, y + 0.12 + (e.rank * 0.006), -n);
      q.setFromAxisAngle(up, Math.atan2(dy, dx));
      m4.compose(pos, q, one);
      v.mesh.setMatrixAt(v.idx, m4);
      // the trail: cross-sections back along the lane the vehicle has just driven
      const Ltr = Math.min(20, Math.max(6, v.speed * 0.9)), lift = 0.1 + e.rank * 0.006;
      let kk = k;
      for (let j = 0; j < TR; j++) {
        const d = 1.8 + (j / (TR - 1)) * Ltr;
        const s2 = Math.max(0, Math.min(e.len, v.dir === 1 ? sAbs - d : sAbs + d));
        if (v.dir === 1) { while (kk > 0 && cum[kk] > s2) kk--; } else { while (kk < cum.length - 2 && cum[kk + 1] < s2) kk++; }
        const a2 = pts[kk], b2 = pts[kk + 1], L2 = cum[kk + 1] - cum[kk] || 1, t2 = (s2 - cum[kk]) / L2;
        let ux = (b2[0] - a2[0]) / L2, uy = (b2[1] - a2[1]) / L2;
        if (v.dir === -1) { ux = -ux; uy = -uy; }
        const cx = a2[0] + (b2[0] - a2[0]) * t2 + uy * off, cy = a2[1] + (b2[1] - a2[1]) * t2 - ux * off;
        const cz = (a2[2] || 0) + ((b2[2] || 0) - (a2[2] || 0)) * t2 + lift;
        const hw = (v.bus ? 1.1 : 0.85) * (1 - 0.5 * (j / (TR - 1))), o = (vi * TR + j) * 6;
        tPos[o] = cx + uy * hw; tPos[o + 1] = cz; tPos[o + 2] = -(cy - ux * hw);
        tPos[o + 3] = cx - uy * hw; tPos[o + 4] = cz; tPos[o + 5] = -(cy + ux * hw);
      }
    }
    tPosAttr.needsUpdate = true;
    for (const m of carMeshes) m.instanceMatrix.needsUpdate = true;
    busMesh.instanceMatrix.needsUpdate = true;
  });

  return {
    group,
    setEnabled(on) { enabled = on; group.visible = on; },
    // share of the fleet on the roads (quality presets)
    setDensity(f) { carMeshes.forEach((m, k) => { m.count = Math.round(kindN[k] * f); }); busMesh.count = Math.round(NBUS * f); },
  };
}
