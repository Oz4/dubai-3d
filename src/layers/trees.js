// Trees, palms and shrubs as painted impostor cards. Every species is modelled in detail once and
// painted from three viewing elevations into a texture array (treeAtlas.js, built in a worker at
// load). Here each of the ~48k plants becomes a single card that faces the camera, picks the
// painting closest to the current view angle, is cel-shaded by the real sun through the painted normals
// (with leaf-level occlusion), writes per-pixel depth so crowns sit properly in the scene, casts a
// silhouette shadow, and sways in the breeze. Date palms beside the promenades are uplit at night.
import * as THREE from 'three';
import { RES, LAYERS, VARIANTS, ELEV, ROW_SPLIT, ATLAS_VERSION, buildTreeAtlas } from './treeAtlas.js';
import { rng } from '../core/util.js';

// The finished atlas is kept in the browser (IndexedDB) under its version, so only the first visit paints it.
const idb = (mode, fn) => new Promise((resolve) => {
  try {
    const open = indexedDB.open('dubai3d', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode), req = fn(tx.objectStore('kv'));
      req.onsuccess = () => resolve(req.result ?? null); req.onerror = () => resolve(null);
      tx.oncomplete = () => open.result.close();
    };
  } catch { resolve(null); }
});
const ATLAS_KEY = 'treeAtlas';
// Start painting the atlas off the main thread as early as possible (or take the kept one).
export function startTreeAtlas() {
  const paint = () => new Promise((resolve) => {
    let w;
    const fallback = () => { if (w) w.terminate(); resolve(buildTreeAtlas()); };
    try {
      w = new Worker(new URL('./treeAtlas.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => { resolve(e.data); w.terminate(); };
      w.onerror = fallback;
      w.postMessage(0);
    } catch { fallback(); }
  });
  return idb('readonly', (st) => st.get(ATLAS_KEY)).then((kept) => {
    if (kept && kept.version === ATLAS_VERSION && kept.res === RES && kept.layers === LAYERS && kept.albedo) { kept.ms = 0; return kept; }
    return paint().then((a) => {
      // keep a copy for the next visit (after the textures are made: the arrays are not transferred)
      setTimeout(() => idb('readwrite', (st) => st.put({ ...a, version: ATLAS_VERSION }, ATLAS_KEY)), 4000);
      return a;
    });
  });
}

const KIND = { 0: 'palms', 2: 'palms', 3: 'shrubs', 4: 'shrubs' }; // the rest are trees
const SPECIES_SWAY = { 0: 1, 2: 1 }; // palms get breathing fronds on top of the sway

// GLSL shared by the colour and shadow materials: build the card for this corner.
const CARD_V = /* glsl */ `
  uniform sampler2D uCells;
  uniform float uTime, uWind;
  uniform vec3 uKinds; // palms, trees, shrubs shown
  uniform float uGrow; // crowns drawn larger when only a share of the plants is shown (far views)
  uniform vec3 uLightDir;
  attribute vec4 iPos;   // x, ground height, z, scale
  attribute vec4 iData;  // species * variants + variant, seed, mirror (+-1), uplit
  attribute vec3 iTint;
  vec3 treeCard(out vec3 bR, out vec3 bU, out vec3 bF, out float layer, out vec4 cA, out vec4 cB, out float elev, float shiftK) {
    vec3 base = iPos.xyz; float scl = iPos.w * uGrow;
    vec3 fwd = isOrthographic ? -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
                              : normalize(base + vec3(0.0, 3.0 * scl, 0.0) - cameraPosition);
    vec3 rgt = cross(fwd, vec3(0.0, 1.0, 0.0));
    float rl = length(rgt);
    rgt = rl > 1e-3 ? rgt / rl : vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = cross(rgt, fwd);
    elev = degrees(asin(clamp(-fwd.y, -1.0, 1.0)));
    float row = elev < ${ROW_SPLIT[0]}.0 ? 0.0 : (elev < ${ROW_SPLIT[1]}.0 ? 1.0 : 2.0);
    elev = row < 0.5 ? ${ELEV[0]}.0 : (row < 1.5 ? ${ELEV[1]}.0 : ${ELEV[2]}.0);
    layer = iData.x * ${ELEV.length}.0 + row;
    int li = int(layer + 0.5);
    cA = texelFetch(uCells, ivec2(li, 0), 0); // half width, bottom, height, depth min
    cB = texelFetch(uCells, ivec2(li, 1), 0); // depth range, crown height, crown radius, sway
    vec2 c = vec2((position.x * 2.0 - 1.0) * cA.x, cA.y + position.y * cA.z) * scl;
    // the breeze bends the crown; the trunk base stays put
    float h = clamp(c.y / max(0.5, (cA.y + cA.z) * scl), 0.0, 1.0);
    float ph = uTime * (0.7 + 0.5 * iData.y) + iData.y * 37.0 + base.x * 0.013;
    // gusts roll across the city in slow waves
    float gust = 0.55 + 0.45 * sin(uTime * 0.33 - (base.x + base.z) * 0.0045);
    float sway = (sin(ph) + 0.35 * sin(ph * 2.7 + 1.3)) * uWind * cB.w * h * h * gust;
    bR = rgt * iData.z; bU = up; bF = -fwd;
    float sp = floor(iData.x / ${VARIANTS}.0 + 0.01);
    float shown = (sp < 0.5 || abs(sp - 2.0) < 0.5) ? uKinds.x : (abs(sp - 3.0) < 0.5 || abs(sp - 4.0) < 0.5) ? uKinds.z : uKinds.y;
    if (shown < 0.5) return vec3(0.0, -1.0e4, 0.0); // a hidden kind: every corner on one point, nothing drawn
    return base + rgt * (c.x + sway * scl) + up * c.y - fwd * (shiftK * cB.z * scl);
  }`;

const ALPHA_TEST = /* glsl */ `
  vec2 tsz = tuv * ${RES}.0;
  vec2 tdx = dFdx(tsz), tdy = dFdy(tsz);
  float tlod = max(0.0, 0.5 * log2(max(dot(tdx, tdx), dot(tdy, tdy))));
  vec4 talb = texture(uAlb, vec3(tuv, vTUv.z));
  // alpha-tested mips lose coverage; boost it with distance so canopies stay full
  if (talb.a * (1.0 + 0.32 * tlod) < 0.5) discard;`;

// Textures, materials and the card geometry are made once and shared by every streamed section.
const SHARED = new WeakMap(); // root context -> shared resources
function treeShared(ctx, atlas) {
  const root = ctx.root || ctx;
  let S = SHARED.get(root);
  if (S) return S;
  if (!atlas || !atlas.albedo) atlas = buildTreeAtlas();
  ctx = root;

  const arrayTex = (buf, srgb) => {
    const t = new THREE.DataArrayTexture(buf, RES, RES, LAYERS);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
    t.anisotropy = Math.min(4, ctx.renderer.capabilities.getMaxAnisotropy());
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const cells = new THREE.DataTexture(atlas.cells, LAYERS, 2, THREE.RGBAFormat, THREE.FloatType);
  cells.needsUpdate = true;
  const U = {
    uAlb: { value: arrayTex(atlas.albedo, true) }, uNrm: { value: arrayTex(atlas.normal, false) }, uCells: { value: cells },
    uTime: { value: 0 }, uWind: { value: 0.45 }, uNight: { value: 0 }, uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uKinds: { value: new THREE.Vector3(1, 1, 1) }, uGrow: { value: 1 },
    uCel: { value: new THREE.Vector4(1.0, 0.9, 1.04, 0) }, // cel shading: gain, blend over the physical light, saturation
  };
  ctx.updaters.push((dt) => { U.uTime.value += Math.min(dt, 0.1); });
  ctx.on('time', (s) => { U.uNight.value = s.night; U.uLightDir.value.copy(s.lightDir); });

  // ---- colour pass
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.35 });
  mat.shadowSide = THREE.DoubleSide;
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, U);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        ${CARD_V}
        varying vec3 vTUv; varying vec2 vTD; varying vec3 vTint, vTR, vTU, vTF; varying vec4 vTMisc; varying vec2 vTCrown;`)
      .replace('#include <beginnormal_vertex>', `vec3 tR, tU, tF; float tLayer, tElev; vec4 tA, tB;
        vec3 tWorld = treeCard(tR, tU, tF, tLayer, tA, tB, tElev, 0.0);
        vTUv = vec3(iData.z > 0.0 ? position.x : 1.0 - position.x, position.y, tLayer);
        vTD = vec2(tA.w, tB.x) * iPos.w * uGrow;
        vTint = iTint;
        vTMisc = vec4(iData.y, iData.w, floor(iData.x / ${VARIANTS}.0 + 0.01), 0.0);
        vTCrown = vec2(0.5, (tB.y * cos(radians(tElev)) - tA.y) / tA.z);
        vTR = mat3(viewMatrix) * tR; vTU = mat3(viewMatrix) * tU; vTF = mat3(viewMatrix) * tF;
        vec3 objectNormal = tF;`)
      .replace('#include <begin_vertex>', 'vec3 transformed = tWorld;')
      // one shadow lookup per plant, just outside its crown on the sun side: buildings and
      // neighbouring trees shade it, its own painted leaves never do
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        #ifdef USE_SHADOWMAP
          worldPosition = vec4(iPos.xyz + vec3(0.0, tB.y * iPos.w * uGrow, 0.0) + uLightDir * (tB.z * iPos.w * uGrow + 1.5), 1.0);
        #endif`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        precision highp sampler2DArray;
        uniform mat4 projectionMatrix;
        uniform sampler2DArray uAlb, uNrm; uniform float uTime, uNight; uniform vec3 uLightDir; uniform vec4 uCel;
        varying vec3 vTUv; varying vec2 vTD; varying vec3 vTint, vTR, vTU, vTF; varying vec4 vTMisc; varying vec2 vTCrown;`)
      .replace('#include <map_fragment>', `
        vec2 tuv = vTUv.xy;
        float tSeed = vTMisc.x, tSp = vTMisc.z;
        // leaves flutter more toward the top of the crown; palm fronds breathe around the crown
        float tfl = tuv.y * tuv.y;
        tuv.x += sin(tuv.y * 37.0 + uTime * 2.6 + tSeed * 31.0) * 0.0022 * tfl;
        tuv.y += sin(tuv.x * 41.0 + uTime * 2.1 + tSeed * 17.0) * 0.0016 * tfl;
        if (tSp < 0.5 || abs(tSp - 2.0) < 0.5) {
          vec2 tq = tuv - vTCrown; float tang = atan(tq.y, tq.x);
          tuv -= tq * sin(uTime * 1.7 + tang * 3.0 + tSeed * 20.0) * 0.03 * smoothstep(0.03, 0.3, length(tq));
        }
        ${ALPHA_TEST}
        vec4 tnrm = texture(uNrm, vec3(tuv, vTUv.z));
        diffuseColor.rgb *= talb.rgb * vTint;
        {
          // per-pixel depth: the crown's painted surface, not the flat card
          vec4 tclip = projectionMatrix * vec4(-vViewPosition + vTF * (vTD.x + tnrm.a * vTD.y), 1.0);
          gl_FragDepth = clamp(tclip.z / tclip.w * 0.5 + 0.5, 0.0, 1.0);
        }`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        vec2 tn = tnrm.xy * 2.0 - 1.0;
        normal = normalize(vTR * tn.x + vTU * tn.y + vTF * sqrt(max(0.0, 1.0 - dot(tn, tn))));`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        // how much sun reaches this plant (a building's shadow): the sun light the lighting actually applied over
        // what it would have applied unshadowed (one shadow lookup per plant, so the ratio is the same all over it;
        // where the sun grazes, the cel bands below are shade anyway)
        float tVisL = 1.0;
        #if NUM_DIR_LIGHTS > 0
        {
          float tNd = dot(normal, directionalLights[ 0 ].direction);
          float tExp = dot(max(tNd, 0.0) * directionalLights[ 0 ].color * BRDF_Lambert(diffuseColor.rgb), vec3(1.0));
          if (tExp > 1e-5) tVisL = mix(1.0, clamp(dot(reflectedLight.directDiffuse, vec3(1.0)) / tExp, 0.0, 1.0), smoothstep(0.02, 0.1, tNd));
        }
        #endif
        // leaves deep inside the crown see little sky and little sun
        reflectedLight.indirectDiffuse *= tnrm.b;
        reflectedLight.indirectSpecular *= tnrm.b;
        reflectedLight.directDiffuse *= 0.3 + 0.7 * tnrm.b;
        reflectedLight.directSpecular *= tnrm.b * 0.6;`)
      .replace('#include <opaque_fragment>', `
        {
          // stylized foliage, cel-shaded: four soft bands of light on the painted normals (cool blue-green shade,
          // mid, sunlit, a warm highlight) so every lobe of a crown reads as a round, lit cluster; inner lobes
          // deepen with occlusion, a building's shadow drops the sunlit bands, a warm rim lights the sunny
          // silhouette, sun from behind glows through the edges and the crown brightens toward its top. Blended
          // over the physical light: fully by day, faintly at night.
          vec3 tAlbC = diffuseColor.rgb;
          vec3 tLv = normalize((viewMatrix * vec4(uLightDir, 0.0)).xyz), tVv = normalize(vViewPosition);
          float tDay = 1.0 - uNight * 0.85, tSunUp = clamp(uLightDir.y * 2.5, 0.0, 1.0);
          float tVis = tVisL;
          vec3 tSunC = vec3(1.0);
          #if NUM_DIR_LIGHTS > 0
            tSunC = directionalLights[ 0 ].color; tSunC /= max(1e-3, max(tSunC.r, max(tSunC.g, tSunC.b)));
          #endif
          tSunC = mix(vec3(1.0), tSunC, 0.5);
          float tNL = dot(normal, tLv);
          tNL = mix(min(tNL, -0.25), tNL, tVis);
          float tB1 = smoothstep(-0.4, -0.1, tNL), tB2 = smoothstep(0.05, 0.35, tNL) * tSunUp, tB3 = smoothstep(0.5, 0.78, tNL) * tSunUp;
          vec3 tTone = mix(vec3(0.2, 0.3, 0.5), vec3(0.56, 0.64, 0.64), tB1);
          tTone = mix(tTone, vec3(0.98, 0.94, 0.76) * tSunC, tB2);
          tTone = mix(tTone, vec3(1.32, 1.22, 0.86) * tSunC, tB3);
          tTone *= 0.55 + 0.45 * tnrm.b;
          float tEdge = 1.0 - abs(dot(normal, tVv));
          vec3 tCel = tAlbC * tTone;
          tCel += tAlbC * vec3(1.0, 0.9, 0.62) * pow(tEdge, 3.0) * clamp(tNL, 0.0, 1.0) * 0.5 * tSunUp;
          float tBack = pow(clamp(dot(tLv, -tVv), 0.0, 1.0), 2.0);
          tCel += tAlbC * vec3(1.0, 0.86, 0.55) * tBack * (0.25 + 0.75 * tEdge) * 0.45 * tSunUp * tVis;
          outgoingLight = mix(outgoingLight, tCel * uCel.x, uCel.y * tDay);
          outgoingLight *= mix(0.86, 1.08, smoothstep(0.12, 0.95, vTUv.y));
          float tL = dot(outgoingLight, vec3(0.299, 0.587, 0.114));
          outgoingLight = max(vec3(0.0), mix(vec3(tL), outgoingLight, uCel.z));
        }
        #include <opaque_fragment>`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vTMisc.y > 0.5 && uNight > 0.01) {
          // warm uplight on the trunk and the underside of the fronds
          float tUnder = clamp(0.3 - tn.y * 0.9, 0.0, 1.0) * (1.0 - smoothstep(0.5, 0.95, tuv.y));
          totalEmissiveRadiance += vec3(1.0, 0.68, 0.38) * talb.rgb * uNight * 2.2 * tUnder;
        }`);
  };

  // ---- shadow pass: the same card turned to the sun, pushed toward it so it never sinks into the ground
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  depthMat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, U);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        ${CARD_V}
        varying vec3 vTUv;`)
      .replace('#include <begin_vertex>', `vec3 tR, tU, tF; float tLayer, tElev; vec4 tA, tB;
        vec3 transformed = treeCard(tR, tU, tF, tLayer, tA, tB, tElev, 1.0);
        vTUv = vec3(iData.z > 0.0 ? position.x : 1.0 - position.x, position.y, tLayer);`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray uAlb; varying vec3 vTUv;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        vec2 tuv = vTUv.xy;
        ${ALPHA_TEST}`);
  };

  // a card with five rows of vertices so the sway bends rather than shears
  const quad = new THREE.BufferGeometry();
  {
    const pos = [], idx = [], ROWS = 5;
    for (let j = 0; j < ROWS; j++) { const v = j / (ROWS - 1); pos.push(0, v, 0, 1, v, 0); }
    for (let j = 0; j < ROWS - 1; j++) { const a = j * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    quad.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    quad.setIndex(idx);
  }

  mat.userData.shared = true; depthMat.userData.shared = true;
  mat.userData.uniforms = U; // (handy for tuning from the console)
  S = { U, mat, depthMat, quad, atlas };
  SHARED.set(root, S);
  return S;
}

export function buildTrees(ctx, atlasIn) {
  const { U, mat, depthMat, quad, atlas } = treeShared(ctx, atlasIn);
  const { data, scene } = ctx;
  const group = new THREE.Group(); group.name = 'trees'; scene.add(group);

  // ---- instances: one mesh for every plant of this cell (palms, trees and shrubs are told apart in the shader)
  const r = rng(11);
  const lit = uplitTest(data);
  const list = data.trees.slice();
  const n = list.length;
  let uplit = 0, mesh = null;
  if (n) {
    // shuffled, so drawing only the first part (lower density) still spreads plants evenly
    const sh = rng(97 + n);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(sh() * (i + 1)); const t = list[i]; list[i] = list[j]; list[j] = t; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of list) { if (t[0] < x0) x0 = t[0]; if (t[0] > x1) x1 = t[0]; if (t[1] < y0) y0 = t[1]; if (t[1] > y1) y1 = t[1]; }
    const iPos = new Float32Array(n * 4), iData = new Float32Array(n * 4), iTint = new Float32Array(n * 3);
    list.forEach((t, i) => {
      // colour for the illustrated look: about one ordinary shade tree in six is shown in flower (flame tree or
      // yellow flame, kept to the shade tree's size), so streets and parks carry reds and golds among the greens
      let type = t[3], k = 1;
      const pick = r();
      if ((type === 1 || type === 8) && pick < 0.17) { type = pick < 0.095 ? 5 : 6; k = type === 5 ? 0.72 : 0.95; }
      const sc = (t[4] || 1) * k * (type === 0 ? 0.9 + r() * 0.2 : 0.95 + r() * 0.1);
      const variant = Math.floor(r() * VARIANTS) % VARIANTS;
      const isLit = type === 0 && lit(t[0], t[1]);
      if (isLit) uplit++;
      iPos[i * 4] = t[0]; iPos[i * 4 + 1] = t[2] || 0; iPos[i * 4 + 2] = -t[1]; iPos[i * 4 + 3] = sc;
      iData[i * 4] = type * VARIANTS + variant; iData[i * 4 + 1] = r(); iData[i * 4 + 2] = r() < 0.5 ? -1 : 1; iData[i * 4 + 3] = isLit ? 1 : 0;
      // every plant its own shade; leafy trees and shrubs also fall into families of green (lime, deep emerald,
      // golden olive) so a row of trees reads as a painted mix, not one flat green
      const b = 0.9 + r() * 0.2, h = (r() - 0.5) * 0.1, fam = r();
      let tr = b * (1 + h), tg = b, tb = b * (1 - h * 1.4);
      if (type === 1 || type === 3 || type === 7 || type === 8 || type === 9) {
        if (fam < 0.28) { tr *= 1.14; tg *= 1.04; tb *= 0.68; }
        else if (fam < 0.52) { tr *= 0.7; tg *= 0.9; tb *= 0.86; }
        else if (fam < 0.6) { tr *= 1.22; tg *= 1.0; tb *= 0.56; }
      }
      iTint[i * 3] = tr; iTint[i * 3 + 1] = tg; iTint[i * 3 + 2] = tb;
    });
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(quad.index.clone()); g.setAttribute('position', quad.attributes.position.clone()); // own copies: disposing one cell must not free another's
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 4));
    g.setAttribute('iData', new THREE.InstancedBufferAttribute(iData, 4));
    g.setAttribute('iTint', new THREE.InstancedBufferAttribute(iTint, 3));
    g.instanceCount = n;
    // cards are placed in the shader: the bounds are the plants' extent plus a crown's reach
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, 10, -(y0 + y1) / 2), Math.hypot(x1 - x0, y1 - y0) / 2 + 30);
    mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.customDepthMaterial = depthMat;
    mesh.name = 'trees';
    group.add(mesh);
  }
  void SPECIES_SWAY; void KIND;
  if (!(ctx.section && ctx.section.cell)) console.info(`[trees] ${n.toLocaleString()} plants as painted cards (${LAYERS} paintings, atlas ${atlas.ms ?? '?'} ms), ${uplit} uplit palms`);
  const KIDX = { palms: 'x', trees: 'y', shrubs: 'z' };
  return {
    group, mesh, uniforms: U,
    // draw a share of the plants (quality and zoom), with or without their shadows
    // (grow: how much larger each remaining plant is drawn, so a thinned far view keeps its canopy; shared by every cell)
    setDensity(d, grow) { if (mesh) mesh.geometry.instanceCount = Math.max(0, Math.round(n * d)); if (grow) U.uGrow.value = grow; },
    setShadows(on) { if (mesh) mesh.castShadow = on; },
    // palms, trees or shrubs on/off (one switch shared by every cell)
    setKind(k, on) { U.uKinds.value[KIDX[k]] = on ? 1 : 0; },
  };
}

// date palms within ~10 m of a lively promenade or the beach running track get uplights
function uplitTest(data) {
  const CELL = 25, grid = new Map();
  for (const p of data.paths || []) {
    if (!((p.k === 1 && (p.l || 0) >= 0.45) || p.k === 7)) continue;
    const pts = p.p;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = 0; s <= L; s += 5) {
        const x = a[0] + ((b[0] - a[0]) * s) / (L || 1), y = a[1] + ((b[1] - a[1]) * s) / (L || 1);
        const key = Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
        let arr = grid.get(key); if (!arr) grid.set(key, (arr = []));
        arr.push(x, y);
      }
    }
  }
  return (x, y) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = grid.get(cx + i + ',' + (cy + j)); if (!arr) continue;
      for (let k = 0; k < arr.length; k += 2) if ((arr[k] - x) ** 2 + (arr[k + 1] - y) ** 2 < 100) return true;
    }
    return false;
  };
}
