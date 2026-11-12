import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from '../core/util.js';
import { SEA_Y } from './ground.js';
import { Shape } from './vehicles.js';

function tint(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}

// Boats on a 12 m reference length, bow along +x, keel at y = 0 (they float about 0.45 m deep). The hull is
// skinned over sections (a flared V with a chine, the sheer rising to a pointed bow, a flat transom) with dark hull
// windows, a teak toe rail, a navy boot stripe and a stainless bow rail; white takes the instance colour.
// Kinds: 'fly' a hardtop motor yacht (wraparound dark glass under a long white roof with dark roof panels),
// 'sport' an open sport cruiser, 'sail' a sailing yacht.
const WHITE = [1, 1, 1], DECK = [0.92, 0.9, 0.84], TEAK = [0.66, 0.44, 0.26], GLASSB = [0.05, 0.08, 0.13], ANTI = [0.08, 0.17, 0.33], STEEL = [0.74, 0.76, 0.79], PAD = [0.84, 0.8, 0.7], PANEL = [0.09, 0.12, 0.2];
// [x, half beam at deck, half beam at chine, keel y, chine y, deck y]
const HULL = [[-6.0, 1.85, 1.6, 0.3, 0.6, 1.5], [-2.0, 2.0, 1.62, 0.0, 0.45, 1.5], [0.6, 1.99, 1.5, 0.0, 0.46, 1.55], [2.6, 1.95, 1.3, 0.0, 0.5, 1.62], [4.8, 1.2, 0.6, 0.15, 0.72, 1.78], [5.8, 0.5, 0.2, 0.5, 1.0, 1.88], [6.3, 0.06, 0.03, 0.95, 1.3, 1.94]];
function hull(S, beam = 1, rail = true) {
  const st = HULL.map(([x, wd, wc, yk, yc, yd]) => ({ x, pts: [[yd, -wd * beam], [yc + (yd - yc) * 0.28, -(wc + (wd - wc) * 0.28) * beam], [yc, -wc * beam], [yk, 0], [yc, wc * beam], [yc + (yd - yc) * 0.28, (wc + (wd - wc) * 0.28) * beam], [yd, wd * beam]] }));
  // strips: white topsides over a navy boot stripe, antifoul bottom; the closing strip is the deck
  S.ringLoft(st, (k) => (k === 0 || k === 5 ? WHITE : k === 1 || k === 4 ? ANTI : k === 6 ? DECK : [0.12, 0.14, 0.18]), WHITE);
  for (const sg of [-1, 1]) {
    // teak toe rail along the deck edge, dark hull windows amidships
    for (let i = 0; i < HULL.length - 1; i++) { const a = HULL[i], b = HULL[i + 1]; S.bar([a[0], a[5] + 0.04, sg * a[1] * beam], [b[0], b[5] + 0.04, sg * b[1] * beam], 0.11, TEAK); }
    S.box(-0.4, 1.08, sg * 1.87 * beam, 4.6, 0.2, 0.06, GLASSB);
    if (rail) {
      // stainless bow rail on stanchions, from amidships round to the stem
      let prev = null;
      for (const i of [2, 3, 4, 5, 6]) {
        const h = HULL[i], top = [h[0], h[5] + 0.62, sg * h[1] * beam * 0.94];
        S.bar([h[0], h[5], sg * h[1] * beam * 0.94], top, 0.05, STEEL);
        if (prev) S.bar(prev, top, 0.055, STEEL);
        prev = top;
      }
    }
  }
  S.box(-6.32, 0.78, 0, 0.66, 0.09, 3.0 * beam, TEAK);                                                               // swim platform
}
export function yachtGeometry(kind = 'fly') {
  const S = new Shape();
  if (kind === 'sail') {
    hull(S, 0.8);
    S.loft([[-2.6, 1.5, 1.95, 0.98], [1.6, 1.52, 2.0, 0.92], [2.6, 1.6, 1.66, 0.66]], () => WHITE, () => WHITE);     // coachroof
    for (const sg of [-1, 1]) S.box(-0.4, 1.8, sg * 0.97, 3.2, 0.16, 0.04, GLASSB);
    S.box(-4.2, 1.53, 0, 2.6, 0.06, 2.4, TEAK);                                                                    // cockpit
    S.bar([-4.6, 1.55, 0], [-4.6, 2.45, 0], 0.08, STEEL); S.box(-4.6, 2.45, 0, 0.1, 0.1, 0.9, STEEL);              // wheel pedestal
    S.bar([0.6, 1.9, 0], [0.6, 15.6, 0], 0.15, STEEL);                                                             // mast
    S.box(-1.7, 2.75, 0, 4.6, 0.28, 0.32, [0.9, 0.88, 0.82]);                                                      // boom with the furled sail
    S.box(0.6, 9.6, 0, 0.06, 0.06, 2.2, STEEL); S.box(0.6, 5.7, 0, 0.06, 0.06, 1.6, STEEL);                        // spreaders
    S.bar([0.6, 15.5, 0], [6.2, 2.0, 0], 0.04, STEEL); S.bar([0.6, 15.5, 0], [-6.0, 1.6, 0], 0.04, STEEL);         // stays
    return S.geometry();
  }
  hull(S);
  S.box(-4.6, 1.53, 0, 2.7, 0.06, 3.4, TEAK);                                                                       // aft cockpit
  S.box(3.5, 1.7, 0, 1.9, 0.09, 1.7, PAD);                                                                          // foredeck sun pad
  S.box(4.9, 1.82, 0, 0.5, 0.05, 0.5, GLASSB);                                                                      // hatch
  if (kind === 'sport') {
    // a low cabin under a long raked screen, an open cockpit behind a wraparound windscreen, a radar arch
    S.loft([[-1.2, 1.5, 2.2, 1.45], [1.4, 1.52, 2.15, 1.35], [3.2, 1.6, 1.68, 1.0]], (i) => (i === 1 ? GLASSB : WHITE), () => WHITE);
    for (const sg of [-1, 1]) S.box(0.3, 1.92, sg * 1.43, 2.6, 0.22, 0.05, GLASSB);
    S.loft([[-1.5, 2.18, 2.2, 1.4], [-1.2, 2.18, 2.75, 1.3], [-0.9, 2.18, 2.2, 1.4]], () => GLASSB, () => GLASSB);
    for (const sg of [-1, 1]) S.bar([-3.9, 1.55, sg * 1.6], [-3.4, 3.1, sg * 1.45], 0.16, WHITE);
    S.box(-3.4, 3.12, 0, 0.6, 0.12, 3.0, WHITE);
    S.box(-2.6, 1.85, 0, 1.4, 0.5, 2.4, PAD);                                                                       // seating
    return S.geometry();
  }
  // hardtop motor yacht: a white coaming, wraparound dark glass with white pillars and a raked screen, a long roof
  // reaching aft over the cockpit on two posts, dark panels and hatches on the roof, a radar arch and aerial
  S.loft([[-2.75, 1.5, 1.86, 1.47], [1.15, 1.52, 1.86, 1.4], [2.75, 1.6, 1.68, 1.05]], () => WHITE, () => WHITE);
  S.loft([[-2.65, 1.84, 2.56, 1.42], [1.0, 1.84, 2.56, 1.34], [2.45, 1.7, 1.78, 1.0]], (i) => (i === 1 ? GLASSB : WHITE), () => GLASSB);
  for (const x of [-2.6, -1.35, -0.1, 0.95]) for (const sg of [-1, 1]) S.box(x, 2.2, sg * 1.4, 0.1, 0.72, 0.08, WHITE);
  S.box(-1.5, 2.63, 0, 5.9, 0.13, 3.15, WHITE);                                                                     // the roof
  for (const sg of [-1, 1]) S.bar([-4.3, 1.55, sg * 1.35], [-4.2, 2.6, sg * 1.35], 0.12, WHITE);
  for (const [x, w] of [[-3.3, 1.5], [-1.6, 1.5], [0.1, 1.2]]) for (const sg of [-1, 1]) S.box(x, 2.71, sg * 0.72, w, 0.04, 1.15, PANEL);
  S.box(-4.0, 2.95, 0, 0.3, 0.5, 2.2, WHITE); S.box(-4.0, 3.3, 0, 0.5, 0.26, 0.5, WHITE);                           // radar arch and dome
  S.bar([-3.9, 3.2, 0.5], [-3.9, 4.3, 0.5], 0.05, STEEL);
  S.box(-4.1, 1.85, 0, 1.2, 0.5, 2.6, PAD);                                                                         // cockpit seating
  return S.geometry();
}

export function buildMarina(ctx) {
  const { data, scene } = ctx;
  const group = new THREE.Group(); group.name = 'marina'; scene.add(group);

  // ---- berthed yachts
  const boats = data.boats || [];
  const boatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05 });
  // three kinds share the berths: flybridge yachts on the longer ones, sport cruisers on the shorter, and a share
  // of sailing yachts
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const r = rng(3), c = new THREE.Color();
  const lists = { fly: [], sport: [], sail: [] };
  for (const b of boats) { const x = r(); lists[x < 0.16 ? 'sail' : b[3] < 11 ? (x < 0.75 ? 'sport' : 'fly') : x < 0.4 ? 'sport' : 'fly'].push(b); }
  const boatMesh = new THREE.Group(); boatMesh.name = 'berthed-boats';
  for (const [kind, list] of Object.entries(lists)) {
    if (!list.length) continue;
    const im = new THREE.InstancedMesh(yachtGeometry(kind), boatMat, list.length);
    list.forEach((b, i) => {
      const k = b[3] / 12;
      p.set(b[0], SEA_Y - 0.45 * k, -b[1]);
      q.setFromAxisAngle(up, b[2]);
      s.set(k, k * (0.92 + r() * 0.16), k);
      m.compose(p, q, s); im.setMatrixAt(i, m);
      const x = r();
      c.set(x < 0.8 ? '#ffffff' : x < 0.88 ? '#dfe6ee' : x < 0.95 ? '#2c3e57' : '#efe6d4');
      im.setColorAt(i, c);
    });
    im.castShadow = true; im.receiveShadow = true;
    boatMesh.add(im);
  }
  group.add(boatMesh);

  // ---- Ain Dubai (procedural observation wheel on Bluewaters)
  const ain = data.landmarks && data.landmarks.ainDubai;
  let wheel = null;
  if (ain) {
    wheel = buildAinDubai(ctx);
    wheel.group.position.set(ain.x, 0, -ain.y);
    wheel.group.rotation.y = ain.angle;
    group.add(wheel.group);
  }
  return { group, boatMesh, wheel };
}

function buildAinDubai(ctx) {
  const R = 120, HC = 131;
  const group = new THREE.Group(); group.name = 'ain-dubai';
  const steel = new THREE.MeshStandardMaterial({ color: '#f1f1ee', roughness: 0.35, metalness: 0.35 });
  const rimMat = new THREE.MeshStandardMaterial({ color: '#f4f4f1', roughness: 0.3, metalness: 0.3, emissive: '#ffffff', emissiveIntensity: 0 });
  const cabinMat = new THREE.MeshStandardMaterial({ color: '#a9d2e6', roughness: 0.15, metalness: 0.5, emissive: '#ffe7b8', emissiveIntensity: 0 });

  // legs: two A-frames, one each side of the wheel plane, meeting the hub ends
  const legGeo = [];
  const leg = (from, to, r0, r1) => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const L = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r1, r0, L, 10, 1).translate(0, L / 2, 0);
    const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.applyQuaternion(qq).translate(a.x, a.y, a.z);
    legGeo.push(g);
  };
  for (const side of [-1, 1]) {
    leg([-34, 0, side * 40], [0, HC, side * 15], 3.6, 2.2);
    leg([34, 0, side * 40], [0, HC, side * 15], 3.6, 2.2);
  }
  legGeo.push(new THREE.CylinderGeometry(6, 6, 34, 20).rotateX(Math.PI / 2).translate(0, HC, 0));
  const legs = new THREE.Mesh(mergeGeometries(legGeo), steel);
  legs.castShadow = legs.receiveShadow = true;
  group.add(legs);

  // rotating part
  const rotor = new THREE.Group(); rotor.position.set(0, HC, 0);
  const rim = new THREE.Mesh(mergeGeometries([
    new THREE.TorusGeometry(R, 2.4, 10, 220).translate(0, 0, 2.6),
    new THREE.TorusGeometry(R, 2.4, 10, 220).translate(0, 0, -2.6),
    new THREE.TorusGeometry(R - 7, 1.1, 6, 200),
  ]), rimMat);
  rim.castShadow = true;
  rotor.add(rim);
  const spokes = [];
  const SP = 32;
  for (let i = 0; i < SP; i++) {
    const a = (i / SP) * Math.PI * 2;
    for (const side of [-1, 1]) {
      const from = new THREE.Vector3(0, 0, side * 13), to = new THREE.Vector3(Math.cos(a) * (R - 2), Math.sin(a) * (R - 2), side * 2.6);
      const L = from.distanceTo(to);
      const g = new THREE.CylinderGeometry(0.32, 0.32, L, 4, 1).translate(0, L / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize())).translate(from.x, from.y, from.z);
      spokes.push(g);
    }
  }
  const spokeMesh = new THREE.Mesh(mergeGeometries(spokes), steel);
  rotor.add(spokeMesh);
  const cabins = [];
  const NC = 48;
  for (let i = 0; i < NC; i++) {
    const a = (i / NC) * Math.PI * 2;
    const g = new THREE.CapsuleGeometry(2.6, 6.5, 3, 8).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
    g.rotateZ(a).translate(Math.cos(a) * (R + 4.2), Math.sin(a) * (R + 4.2), 0);
    cabins.push(g);
  }
  const cabinMesh = new THREE.Mesh(mergeGeometries(cabins), cabinMat);
  cabinMesh.castShadow = true;
  rotor.add(cabinMesh);
  group.add(rotor);

  let night = 0;
  ctx.on('time', (s) => { night = s.night; cabinMat.emissiveIntensity = s.night * 0.9; });
  const hsl = new THREE.Color();
  ctx.updaters.push((dt, t) => {
    rotor.rotation.z -= dt * ((Math.PI * 2) / 900);
    if (night > 0.01) {
      hsl.setHSL((t * 0.03) % 1, 0.75, 0.6);
      rimMat.emissive.copy(hsl);
      rimMat.emissiveIntensity = night * 2.2;
    } else rimMat.emissiveIntensity = 0;
  });
  return { group, rotor };
}
