// People make the neighbourhoods walkable: pedestrians strolling the promenades (busiest where the
// cafes, shops, beach and marina are), joggers, cyclists on the shared paths and cycle tracks,
// sunbathers on the loungers and swimmers in the shallows. Legs and arms swing as they walk.
import * as THREE from 'three';
import { rng } from '../core/util.js';
import { SEA_Y } from './ground.js';

// geometry with per-vertex roles, packed to stay inside the 16 vertex attributes a draw may use: aSkin (1: keep
// the skin tone or the painted colour) plus twice the colour slot; aLimb (-1 / +1 a leg, -2 / +2 an arm, for swinging)
function part(geo, color, role = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count, c = new THREE.Color(color);
  const set = (name, v) => g.setAttribute(name, new THREE.Float32BufferAttribute(new Array(n).fill(v), 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [c.r, c.g, c.b]), 3));
  set('aSkin', (role.skin ? 1 : 0) + 2 * (role.slot || 0)); set('aLimb', role.leg ? role.leg : role.arm ? 2 * role.arm : 0); set('aVar', role.v || 0);
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}
function mergeParts(list) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color', 'aSkin', 'aLimb', 'aVar']) {
    const size = list[0].attributes[name].itemSize, arr = [];
    for (const g of list) arr.push(...g.attributes[name].array);
    out.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
  }
  return out;
}
// A person, facing +x, about 1.72 m tall, in the manner of low-poly city figures: blocks of clothing colour, hair,
// shoes. One mesh carries five figures; each instance shows the parts of its own (aVar is a bit mask of the kinds a
// part belongs to, 0 = everyone): 1 a man in shirt and trousers, 2 a man in T-shirt and shorts with a backpack,
// 3 a woman in a top and trousers with long hair and a handbag, 4 a woman in a dress, 5 a man in an open jacket.
// Colour slots: 0 the top (instance colour), 1 trousers, shorts or skirt (aCol2), 2 hair (aHair); skin parts take
// the person's skin tone; other fixed colours stay as painted.
function walkerGeo() {
  const SKIN = '#ffffff', SHOE = '#26262a';
  const cyl = (rt, rb, h, seg = 7) => new THREE.CylinderGeometry(rt, rb, h, seg);
  const K = (...kinds) => kinds.reduce((m, k) => m + (1 << (k - 1)), 0);
  const MEN = K(1, 2, 5), WOMEN = K(3, 4);
  const parts = [];
  for (const sd of [1, -1]) {
    const z = 0.086 * sd, leg = { leg: sd };
    parts.push(part(new THREE.BoxGeometry(0.25, 0.075, 0.1).translate(0.035, 0.04, z), SHOE, { ...leg, skin: true }));
    parts.push(part(cyl(0.08, 0.054, 0.8).translate(0, 0.47, z), '#ffffff', { ...leg, slot: 1, v: K(1, 3, 5) }));          // trousers
    parts.push(part(cyl(0.062, 0.046, 0.6).translate(0, 0.37, z), SKIN, { ...leg, skin: true, v: K(2, 4) }));              // bare legs
    parts.push(part(cyl(0.09, 0.084, 0.34).translate(0, 0.71, z), '#ffffff', { ...leg, slot: 1, v: K(2) }));               // shorts
    // arms: sleeved, or bare below a short sleeve; hands
    for (const [mask, za, rt, rb] of [[MEN, 0.25, 0.054, 0.042], [WOMEN, 0.212, 0.045, 0.035]]) {
      const zz = za * sd, arm = { arm: sd }, long = mask === MEN ? K(1, 5) : K(3), bare = mask === MEN ? K(2) : K(4);
      parts.push(part(cyl(rt, rb, 0.56).translate(0, 1.15, zz), '#ffffff', { ...arm, v: long }));
      parts.push(part(cyl(rt * 0.9, rb, 0.56).translate(0, 1.15, zz), SKIN, { ...arm, skin: true, v: bare }));
      parts.push(part(cyl(rt * 1.12, rt * 1.08, 0.2).translate(0, 1.34, zz), '#ffffff', { ...arm, v: bare }));
      parts.push(part(new THREE.SphereGeometry(rb * 1.15, 6, 5).translate(0, 0.84, zz), SKIN, { ...arm, skin: true, v: mask }));
    }
  }
  // hips; a man's chest is broad across the shoulders, a woman's narrower with a waist
  parts.push(part(cyl(0.165, 0.16, 0.16, 8).scale(0.72, 1, 1).translate(0, 0.9, 0), '#ffffff', { slot: 1, v: K(1, 2, 3, 5) }));
  parts.push(part(cyl(0.21, 0.165, 0.5, 8).scale(0.64, 1, 1).translate(0, 1.21, 0), '#ffffff', { v: MEN }));
  parts.push(part(new THREE.SphereGeometry(0.21, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.64, 0.3, 1).translate(0, 1.455, 0), '#ffffff', { v: MEN }));
  parts.push(part(cyl(0.175, 0.128, 0.5, 8).scale(0.7, 1, 1).translate(0, 1.21, 0), '#ffffff', { v: WOMEN }));
  parts.push(part(new THREE.SphereGeometry(0.175, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.7, 0.3, 1).translate(0, 1.455, 0), '#ffffff', { v: WOMEN }));
  // the dress: a skirt flaring from the waist to the knee, in the colour of the top
  parts.push(part(cyl(0.135, 0.25, 0.46, 9).scale(0.8, 1, 1).translate(0, 0.76, 0), '#ffffff', { v: K(4) }));
  // open jacket over a light shirt
  parts.push(part(new THREE.BoxGeometry(0.04, 0.46, 0.12).translate(0.125, 1.21, 0), '#ece8df', { skin: true, v: K(5) }));
  parts.push(part(cyl(0.052, 0.058, 0.09, 6).translate(0, 1.5, 0), SKIN, { skin: true }));
  parts.push(part(new THREE.SphereGeometry(0.115, 9, 7).scale(1, 1.12, 0.95).translate(0.005, 1.635, 0), SKIN, { skin: true }));
  // hair: cropped for the men; long for the women, falling to the shoulders
  parts.push(part(new THREE.SphereGeometry(0.125, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.54).scale(1, 1.1, 0.98).translate(-0.016, 1.648, 0), '#ffffff', { slot: 2, v: MEN }));
  parts.push(part(new THREE.SphereGeometry(0.132, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.6).scale(1.02, 1.1, 1.02).translate(-0.016, 1.648, 0), '#ffffff', { slot: 2, v: WOMEN }));
  parts.push(part(new THREE.BoxGeometry(0.1, 0.34, 0.24).translate(-0.095, 1.5, 0), '#ffffff', { slot: 2, v: WOMEN }));
  // a backpack, a handbag swinging on the arm
  parts.push(part(new THREE.BoxGeometry(0.13, 0.36, 0.27).translate(-0.19, 1.22, 0), '#3d5a80', { skin: true, v: K(2) }));
  parts.push(part(new THREE.BoxGeometry(0.2, 0.15, 0.07).translate(0, 0.86, -0.27), '#8a4b2a', { skin: true, arm: -1, v: K(3) }));
  return mergeParts(parts);
}
function cyclistGeo() {
  const wheel = (x) => part(new THREE.TorusGeometry(0.33, 0.035, 4, 14).translate(x, 0.34, 0), '#25282c', { skin: true });
  return mergeParts([
    wheel(0.52), wheel(-0.52),
    part(new THREE.BoxGeometry(0.95, 0.05, 0.05).rotateZ(0.12).translate(0.02, 0.62, 0), '#d0d4d8', { skin: true }),
    part(new THREE.BoxGeometry(0.05, 0.45, 0.05).rotateZ(-0.3).translate(-0.2, 0.6, 0), '#d0d4d8', { skin: true }),
    part(new THREE.CylinderGeometry(0.17, 0.15, 0.58, 6).rotateZ(-0.55).translate(0.05, 1.2, 0), '#ffffff'),
    part(new THREE.SphereGeometry(0.12, 8, 6).translate(0.26, 1.52, 0), '#ffffff', { skin: true }),
    part(new THREE.BoxGeometry(0.11, 0.6, 0.12).translate(-0.12, 0.72, 0.1), '#555555', { leg: 1 }),
    part(new THREE.BoxGeometry(0.11, 0.6, 0.12).translate(-0.12, 0.72, -0.1), '#555555', { leg: -1 }),
    part(new THREE.BoxGeometry(0.42, 0.07, 0.07).rotateZ(-0.5).translate(0.32, 1.12, 0.17), '#ffffff'),
    part(new THREE.BoxGeometry(0.42, 0.07, 0.07).rotateZ(-0.5).translate(0.32, 1.12, -0.17), '#ffffff'),
  ]);
}
function loungerPersonGeo() {
  return mergeParts([
    part(new THREE.CylinderGeometry(0.17, 0.15, 1.15, 6).rotateZ(Math.PI / 2).translate(0.25, 0.5, 0), '#ffffff'),
    part(new THREE.SphereGeometry(0.115, 8, 6).translate(-0.48, 0.68, 0), '#ffffff', { skin: true }),
    part(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 6).rotateZ(Math.PI / 2).translate(-0.25, 0.6, 0), '#ffffff', { skin: true }),
  ]);
}
function swimmerGeo() {
  return mergeParts([
    part(new THREE.SphereGeometry(0.13, 8, 6).translate(0, 0.16, 0), '#ffffff', { skin: true }),
    part(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 8).translate(0, -0.02, 0), '#ffffff', { skin: true }),
  ]);
}

// a golf buggy (faces +x): painted parts keep their colours (they ride the skin channel, below pure white)
function buggyGeo() {
  const body = '#f2f2ee';
  return mergeParts([
    part(new THREE.BoxGeometry(2.3, 0.55, 1.15).translate(0, 0.55, 0), body, { skin: true }),
    part(new THREE.BoxGeometry(0.16, 0.55, 1.0).translate(-0.15, 1.08, 0), '#34363a', { skin: true }),
    part(new THREE.BoxGeometry(0.7, 0.12, 1.0).translate(0.15, 0.88, 0), '#34363a', { skin: true }),
    part(new THREE.BoxGeometry(2.05, 0.08, 1.25).translate(0.05, 1.98, 0), body, { skin: true }),
    ...[[0.88, 0.56], [0.88, -0.56], [-0.82, 0.56], [-0.82, -0.56]].map(([x, z]) => part(new THREE.BoxGeometry(0.06, 1.15, 0.06).translate(x, 1.4, z), '#c8c9cb', { skin: true })),
    part(new THREE.BoxGeometry(0.32, 0.85, 0.85).translate(-1.0, 1.05, 0), '#2b4a7a', { skin: true }),
    ...[[0.75, 0.55], [0.75, -0.55], [-0.75, 0.55], [-0.75, -0.55]].map(([x, z]) => part(new THREE.BoxGeometry(0.42, 0.42, 0.18).translate(x, 0.21, z), '#1d1e20', { skin: true })),
  ]);
}

const CLOTHES = [['#f3f3f0', 18], ['#1b1b1e', 13], ['#3e6ea8', 9], ['#c8463e', 6], ['#e8c24a', 5], ['#4a9a5a', 5], ['#d8c7a5', 9], ['#8a8f96', 8], ['#e59ab0', 5], ['#24324a', 8], ['#f08a3c', 4], ['#7b5aa8', 3], ['#2bb3b8', 4]];
const SPORT = [['#e8463c', 3], ['#2b86d6', 3], ['#1b1b1e', 3], ['#f2c230', 2], ['#38b26a', 2], ['#f3f3f0', 2], ['#ef5aa0', 2]];
const SWIM = [['#e8463c', 3], ['#2b86d6', 3], ['#1b1b1e', 3], ['#f2c230', 2], ['#38b26a', 2], ['#f08a3c', 2], ['#ef5aa0', 2]];
const pickW = (list, r) => { let x = r() * list.reduce((a, [, w]) => a + w, 0); for (const [c, w] of list) { x -= w; if (x <= 0) return c; } return list[0][0]; };

function makeMaterial(uTime) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  mat.onBeforeCompile = (s) => {
    s.uniforms.uTime = uTime;
    s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>
        attribute float aSkin; attribute float aLimb; attribute float aPhase; attribute float aTone; attribute float aVar; attribute float aKind;
        // aKind packs the figure (1-5), its trouser colour (x8) and its hair colour (x64), both from these palettes
        const vec3 P_BOT[8] = vec3[8](vec3(0.0252, 0.0482, 0.1070), vec3(0.0123, 0.0137, 0.0176), vec3(0.1441, 0.1529, 0.1683), vec3(0.4851, 0.3968, 0.2542), vec3(0.0423, 0.0685, 0.1559), vec3(0.8388, 0.8308, 0.7835), vec3(0.0685, 0.0423, 0.0252), vec3(0.0185, 0.0296, 0.0685));
        const vec3 P_HAIR[8] = vec3[8](vec3(0.0123, 0.0086, 0.0065), vec3(0.0123, 0.0086, 0.0065), vec3(0.0423, 0.0232, 0.0116), vec3(0.0423, 0.0232, 0.0116), vec3(0.1470, 0.0685, 0.0232), vec3(0.4342, 0.2542, 0.0685), vec3(0.2542, 0.0423, 0.0130), vec3(0.1022, 0.1022, 0.1119));`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float sw = sin(aPhase);
          float aLeg = abs(aLimb) < 1.5 ? aLimb : 0.0, aArm = abs(aLimb) > 1.5 ? sign(aLimb) : 0.0;
          if (aLeg != 0.0) { float a = sw * 0.5 * aLeg; vec3 q = transformed - vec3(0.0, 0.86, 0.0); transformed = vec3(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a), q.z) + vec3(0.0, 0.86, 0.0); }
          if (aArm != 0.0) { float a = -sw * 0.4 * aArm; vec3 q = transformed - vec3(0.0, 1.42, 0.0); transformed = vec3(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a), q.z) + vec3(0.0, 1.42, 0.0); }
          // only this person's outfit is drawn: parts of the others collapse to a point
          bool shown = aVar < 0.5 || mod(floor(aVar / exp2(pKind - 1.0) + 0.001), 2.0) > 0.5;
          if (!shown) transformed = vec3(0.0);
        }`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        // clothing takes the instance colour; skin keeps a per-person tone; bikes keep their paint
        vec3 skinC = mix(vec3(0.82, 0.52, 0.38), vec3(0.22, 0.11, 0.07), aTone);
        float pSkin = mod(aSkin, 2.0), pSlot = floor(aSkin * 0.5 + 0.01);
        float pCode = floor(aKind + 0.5), pKind = mod(pCode, 8.0);
        vec3 aCol2 = P_BOT[int(mod(floor(pCode / 8.0), 8.0))], aHair = P_HAIR[int(floor(pCode / 64.0))];
        vColor.rgb = mix(vColor.rgb, pSkin > 0.5 && color.r > 0.99 ? skinC : color.rgb, pSkin);
        if (pSlot > 1.5) vColor.rgb = aHair; else if (pSlot > 0.5) vColor.rgb = aCol2;`);
  };
  return mat;
}

export function buildPeople(ctx, ground) {
  const { data, scene } = ctx;
  const group = new THREE.Group(); group.name = 'people'; scene.add(group);
  const r = rng(5555);
  const uTime = { value: 0 };
  const mat = makeMaterial(uTime);

  // ---- routes: walkways with cumulative lengths
  const routes = [];
  for (const p of data.paths) {
    if (typeof p.k !== 'number' || p.p.length < 2) continue;
    const cum = [0];
    for (let i = 1; i < p.p.length; i++) cum.push(cum[i - 1] + Math.hypot(p.p[i][0] - p.p[i - 1][0], p.p[i][1] - p.p[i - 1][1]));
    const L = cum[cum.length - 1]; if (L < 8) continue;
    routes.push({ pts: p.p, cum, L, k: p.k, w: p.w, l: p.l || 0 });
  }
  const at = (rt, s, out) => {
    s = Math.max(0, Math.min(rt.L, s));
    let lo = 0, hi = rt.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rt.cum[m] <= s) lo = m; else hi = m; }
    const a = rt.pts[lo], b = rt.pts[hi], seg = rt.cum[hi] - rt.cum[lo] || 1, t = (s - rt.cum[lo]) / seg;
    out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = Math.atan2(b[1] - a[1], b[0] - a[0]);
    return out;
  };

  // ---- agents on the walkways
  const walkers = [], cyclists = [];
  for (const rt of routes) {
    const walkable = rt.k !== 2 && rt.k !== 7;
    if (rt.k === 7) { // running track: joggers, a few walkers
      const nj = Math.round((rt.L / 100) * 2.2);
      for (let i = 0; i < nj; i++) walkers.push({ rt, s: r() * rt.L, dir: r() < 0.5 ? 1 : -1, v: 2.5 + r() * 1.1, off: (r() - 0.5) * 1.4, stride: 2.2, col: pickW(SPORT, r), tone: r(), jog: true });
      const nw = Math.round((rt.L / 100) * 0.6);
      for (let i = 0; i < nw; i++) walkers.push({ rt, s: r() * rt.L, dir: r() < 0.5 ? 1 : -1, v: 1.2 + r() * 0.3, off: (r() - 0.5) * 1.4, stride: 1.45, col: pickW(CLOTHES, r), tone: r() });
    }
    if (walkable) {
      const n = Math.round((rt.L / 100) * (0.12 + 9.5 * rt.l * rt.l * rt.l + 2.0 * rt.l * rt.l) + (r() < 0.3 ? 1 : 0) * (rt.l > 0.2 ? 1 : 0));
      for (let i = 0; i < n; i++) walkers.push({ rt, s: r() * rt.L, dir: r() < 0.5 ? 1 : -1, v: 1.05 + r() * 0.5, off: (r() - 0.5) * Math.max(0.2, rt.w - 0.9), stride: 1.45, col: pickW(CLOTHES, r), tone: r() });
      if (rt.l >= 0.3 && rt.k !== 5) { const nj = Math.round((rt.L / 100) * 0.3 + (r() < 0.2 ? 1 : 0)); for (let i = 0; i < nj; i++) walkers.push({ rt, s: r() * rt.L, dir: r() < 0.5 ? 1 : -1, v: 2.6 + r() * 0.8, off: (r() - 0.5) * Math.max(0.2, rt.w - 0.9), stride: 2.2, col: pickW(SPORT, r), tone: r(), jog: true }); }
    }
    if (rt.k === 2 || rt.k === 6) {
      const nc = Math.round((rt.L / 100) * (0.5 + 1.2 * rt.l) + (r() < 0.25 ? 1 : 0));
      for (let i = 0; i < nc; i++) cyclists.push({ rt, s: r() * rt.L, dir: r() < 0.5 ? 1 : -1, v: 4 + r() * 2.5, off: rt.k === 6 ? (0.25 + r() * 0.4) * rt.w * 0.5 * (r() < 0.5 ? 1 : 0.6) : (r() - 0.5) * rt.w * 0.5, col: pickW(SPORT, r), tone: r() });
    }
  }
  const MAXW = 7000; if (walkers.length > MAXW) walkers.splice(MAXW);

  const mkInst = (geo, n, name) => {
    const g = geo.clone();
    g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n)), 1));
    g.setAttribute('aTone', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n)), 1));
    g.setAttribute('aKind', new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n)).fill(1 + 8), 1));
    const m = new THREE.InstancedMesh(g, mat, Math.max(1, n)); m.count = n; m.frustumCulled = false; m.name = name;
    m.castShadow = true; group.add(m); return m;
  };
  const wMesh = mkInst(walkerGeo(), walkers.length, 'pedestrians');
  const cMesh = mkInst(cyclistGeo(), cyclists.length, 'cyclists');
  const col = new THREE.Color();
  // who is who: joggers in shorts; of the rest, men in shirts, jackets or shorts and women in trousers or dresses,
  // each with their own trousers and hair colour
  const dress = (mesh, i, a) => {
    const k = r(), kind = a.jog ? (k < 0.6 ? 2 : 3) : k < 0.28 ? 1 : k < 0.42 ? 5 : k < 0.58 ? 2 : k < 0.82 ? 3 : 4;
    const g = mesh.geometry.attributes;
    g.aKind.array[i] = kind + 8 * Math.floor(r() * 8) + 64 * Math.floor(r() * 8); g.aTone.array[i] = a.tone;
    mesh.setColorAt(i, col.set(a.col));
  };
  walkers.forEach((a, i) => dress(wMesh, i, a));
  wMesh.geometry.attributes.aKind.needsUpdate = true;
  cyclists.forEach((a, i) => { cMesh.setColorAt(i, col.set(a.col)); cMesh.geometry.attributes.aTone.array[i] = a.tone; });

  // ---- beach: sunbathers on about a third of the loungers, swimmers in the shallows
  // figures are drawn ~35% larger than life so they read at map zoom (as illustrated maps do)
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), one = new THREE.Vector3(1.35, 1.35, 1.35), up = new THREE.Vector3(0, 1, 0);
  // sunbathers on about a third of the loungers (umbrella frame x lounger offset)
  const sun = [];
  {
    const um = new THREE.Matrix4(), lm = new THREE.Matrix4();
    for (const u of data.umbrellas || []) {
      if (r() > 0.38) continue;
      q.setFromAxisAngle(up, 0.7 + (u[2] % 7) * 0.03); um.compose(pv.set(u[0], 0, -u[1]), q, new THREE.Vector3(1, 1, 1));
      for (const side of [-1.25, 1.25]) {
        if (r() < 0.45) continue;
        lm.makeTranslation(0.2, 0, side).multiply(new THREE.Matrix4().makeScale(1.15, 1.15, 1.15)); // on the lounger, slightly enlarged
        sun.push({ m: um.clone().multiply(lm), col: pickW(SWIM, r), tone: r() });
      }
    }
  }
  const sMesh = mkInst(loungerPersonGeo(), sun.length, 'sunbathers');
  sun.forEach((p, i) => { sMesh.setMatrixAt(i, p.m); sMesh.setColorAt(i, col.set(p.col)); sMesh.geometry.attributes.aTone.array[i] = p.tone; });
  sMesh.instanceMatrix.needsUpdate = true;
  const swimmers = [];
  const info = ground && ground.shoreTex && ground.shoreTex.userData.info;
  if (info) {
    // swimmers in this section's own waters (a share of ~220 across the map by area)
    const B = ctx.bounds;
    const rects = (ctx.section && ctx.section.rects) || [[B.x0, B.y0, B.x1, B.y1]];
    let qx0 = Infinity, qy0 = Infinity, qx1 = -Infinity, qy1 = -Infinity, qa = 0;
    for (const q of rects) { qx0 = Math.min(qx0, q[0]); qy0 = Math.min(qy0, q[1]); qx1 = Math.max(qx1, q[2]); qy1 = Math.max(qy1, q[3]); qa += (q[2] - q[0]) * (q[3] - q[1]); }
    const cell = ctx.section && ctx.section.cell;
    const quota = cell ? 6 : Math.max(20, Math.round((220 * qa) / (B.w * B.h)));
    for (let k = 0; k < (cell ? 1500 : 9000) && swimmers.length < quota; k++) {
      const x = qx0 + r() * (qx1 - qx0), y = qy0 + r() * (qy1 - qy0);
      if (!rects.some((q) => x >= q[0] && x < q[2] && y >= q[1] && y < q[3])) continue;
      const c = Math.floor(((x - B.x0) / B.w) * info.w), rr = Math.floor(((B.y1 - y) / B.h) * info.h);
      const idx = rr * info.w + c; if (idx < 0 || idx >= info.mask.length) continue;
      if (info.mask[idx] > 0.3 || info.near[idx] < 0.45 || info.near[idx] > 0.88 || info.beach[idx] < 0.12) continue;
      swimmers.push({ x, y, ph: r() * 6.28, col: pickW(SWIM, r), tone: r() });
    }
  }
  const swMesh = mkInst(swimmerGeo(), swimmers.length, 'swimmers');
  swimmers.forEach((a, i) => { swMesh.setColorAt(i, col.set(a.col)); swMesh.geometry.attributes.aTone.array[i] = a.tone; });
  for (const m of [wMesh, cMesh, sMesh, swMesh]) { if (m.instanceColor) m.instanceColor.needsUpdate = true; m.geometry.attributes.aTone.needsUpdate = true; }
  // ---- golfers on the greens, tees and fairways, gardeners at work in the estates, guards at the gates; buggies
  const figs = data.figures || [], bugs = data.buggies || [];
  const GOLF = [['#f3f3f0', 6], ['#24324a', 4], ['#9fc4e8', 3], ['#e8b4c0', 2], ['#3a6b4a', 2], ['#1b1b1e', 2], ['#d64545', 1], ['#f2d36b', 1]];
  const fMesh = mkInst(walkerGeo(), figs.length, 'golfers-staff');
  figs.forEach((f, i) => {
    q.setFromAxisAngle(up, f[2]); m4.compose(pv.set(f[0], 0, -f[1]), q, one); fMesh.setMatrixAt(i, m4);
    fMesh.setColorAt(i, col.set(f[3] === 1 ? '#5c7a38' : f[3] === 2 ? '#1f2a3c' : pickW(GOLF, r)));
    fMesh.geometry.attributes.aTone.array[i] = r();
    fMesh.geometry.attributes.aKind.array[i] = (f[3] === 0 ? (r() < 0.35 ? 2 : r() < 0.3 ? 3 : 1) : 1) + 8 * (f[3] === 0 ? [5, 3, 7][Math.floor(r() * 3)] : 1) + 64 * Math.floor(r() * 8);
    fMesh.geometry.attributes.aPhase.array[i] = f[3] === 1 ? 1.2 : (r() - 0.5) * 0.4; // gardeners mid-stride, golfers standing
  });
  fMesh.instanceMatrix.needsUpdate = true; if (fMesh.instanceColor) fMesh.instanceColor.needsUpdate = true;
  fMesh.geometry.attributes.aTone.needsUpdate = true; fMesh.geometry.attributes.aPhase.needsUpdate = true;
  const bMesh = mkInst(buggyGeo(), bugs.length, 'golf-buggies');
  const bs = new THREE.Vector3(1.15, 1.15, 1.15);
  bugs.forEach((b, i) => { q.setFromAxisAngle(up, b[2]); m4.compose(pv.set(b[0], 0, -b[1]), q, bs); bMesh.setMatrixAt(i, m4); bMesh.setColorAt(i, col.set('#ffffff')); });
  bMesh.instanceMatrix.needsUpdate = true; if (bMesh.instanceColor) bMesh.instanceColor.needsUpdate = true;
  // everyone stays on their routes, loungers and swimming spots: those bounds let off-screen crowds be skipped
  {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (const rt of routes) for (const p of rt.pts) grow(p[0], p[1]);
    for (const u of data.umbrellas || []) grow(u[0], u[1]);
    for (const a of swimmers) grow(a.x, a.y);
    for (const f of figs) grow(f[0], f[1]);
    for (const b of bugs) grow(b[0], b[1]);
    if (x1 >= x0) {
      const sphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, 1, -(y0 + y1) / 2), Math.hypot(x1 - x0, y1 - y0) / 2 + 12);
      for (const m of [wMesh, cMesh, sMesh, swMesh]) { m.boundingSphere = sphere; m.frustumCulled = true; }
    }
  }

  // ---- animation
  const tmp = [0, 0, 0];
  const place = (mesh, list, i, a, dt, cyc) => {
    a.s += a.dir * a.v * dt;
    if (a.s > a.rt.L) { a.s = a.rt.L; a.dir = -1; } else if (a.s < 0) { a.s = 0; a.dir = 1; }
    at(a.rt, a.s, tmp);
    const head = tmp[2] + (a.dir < 0 ? Math.PI : 0);
    const nx = -Math.sin(tmp[2]), ny = Math.cos(tmp[2]);
    const off = cyc ? a.off * a.dir : a.off;
    pv.set(tmp[0] + nx * off, 0.08 + (cyc ? 0 : Math.abs(Math.sin(a.ph || 0)) * 0.04), -(tmp[1] + ny * off));
    q.setFromAxisAngle(up, head);
    m4.compose(pv, q, one); mesh.setMatrixAt(i, m4);
    a.ph = (a.ph || 0) + (a.v / a.stride) * Math.PI * dt * (cyc ? 0.6 : 1);
    mesh.geometry.attributes.aPhase.array[i] = a.ph;
  };
  let visible = true, acc = 0, enabled = true;
  // only people near the view are animated (at ~30 Hz); the rest pause until the camera comes back
  const near = (a, cx, cy, R2) => a.lx === undefined || (a.lx - cx) * (a.lx - cx) + (a.ly - cy) * (a.ly - cy) < R2;
  ctx.updaters.push((dt) => {
    const cam = ctx.activeCamera;
    visible = enabled && (!cam.isOrthographicCamera || cam.zoom > 1.35);
    group.visible = visible;
    if (!visible) return;
    acc += Math.min(dt, 0.1); if (acc < 1 / 30) return;
    dt = acc; acc = 0; uTime.value += dt;
    const tgt = ctx.focus ? ctx.focus() : ctx.controls.target, cx = tgt.x, cy = -tgt.z;
    const R = cam.isOrthographicCamera ? Math.hypot(cam.right - cam.left, cam.top - cam.bottom) / cam.zoom * 0.75 + 60 : 900;
    const R2 = R * R;
    walkers.forEach((a, i) => { if (near(a, cx, cy, R2)) { place(wMesh, walkers, i, a, dt, false); a.lx = tmp[0]; a.ly = tmp[1]; } });
    cyclists.forEach((a, i) => { if (near(a, cx, cy, R2)) { a.stride = 1.6; place(cMesh, cyclists, i, a, dt, true); a.lx = tmp[0]; a.ly = tmp[1]; } });
    swimmers.forEach((a, i) => {
      a.ph += dt * 1.3;
      pv.set(a.x + Math.sin(a.ph * 0.2) * 1.5, SEA_Y + Math.sin(a.ph) * 0.08, -(a.y + Math.cos(a.ph * 0.17) * 1.5));
      q.setFromAxisAngle(up, a.ph * 0.1); m4.compose(pv, q, one); swMesh.setMatrixAt(i, m4);
    });
    for (const m of [wMesh, cMesh, swMesh]) { m.instanceMatrix.needsUpdate = true; m.geometry.attributes.aPhase.needsUpdate = true; }
  });
  if (!(ctx.section && ctx.section.cell)) console.info(`[people] ${walkers.length} on foot, ${cyclists.length} cycling, ${sMesh.count} sunbathing, ${swimmers.length} swimming`);
  return {
    group, walkers, cyclists,
    setEnabled(on) { enabled = on; group.visible = on && group.visible; },
    setShadows(on) { for (const m of [wMesh, cMesh, sMesh, swMesh]) m.castShadow = on; },
  };
}
