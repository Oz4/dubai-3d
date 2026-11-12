// Low cloud drifting over the city at 200-800 m, the height of its tallest towers. Three kinds: heaped cumulus
// (flat-based piles of puffs), small fair-weather puffs, and thin translucent veils of mist. A few stay close to
// Burj Khalifa and to the Marina's supertalls, so there is usually cloud passing through their upper floors. Each
// puff is a billboard shaded as a soft ball lit from the sun's side (white crowns, a soft body, lavender-grey
// bellies), tested against the scene's depth so a tower in front of a cloud hides it; the heaps and puffs cast real,
// slowly moving shadows across buildings, streets and sea. Clouds turn translucent and then fade out as you zoom in,
// so they never block exploring.
import * as THREE from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { rng } from '../core/util.js';

const NOISE = `
  float ch(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float cn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(ch(i), ch(i + vec2(1, 0)), f.x), mix(ch(i + vec2(0, 1)), ch(i + vec2(1, 1)), f.x), f.y); }
  float cfbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * cn(p); p *= 2.03; a *= 0.5; } return s; }
  // soft, lumpy puff mask in the unit quad; the lumps churn slowly
  float puff(vec2 uv, float seed, float t) {
    vec2 q = uv * 2.0 - 1.0; float r = length(q);
    float n = cfbm(q * 1.7 + seed * 13.1 + vec2(t * 0.02, -t * 0.013));
    return smoothstep(0.98, 0.6, r + (n - 0.5) * 0.55);
  }`;
// billboard: the quad always faces whichever camera renders it (view camera, or the sun for shadows)
const BILLBOARD = `
  vec4 mvC = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float sz = length(instanceMatrix[0].xyz);
  mvC.xy += position.xy * sz;
  vec4 mvPosition = mvC;
  gl_Position = projectionMatrix * mvPosition;`;

export function buildClouds(ctx) {
  const { scene, bounds: B } = ctx;
  // visible clouds live in their own scene, drawn after the ink/haze pass so outlines of what lies
  // beneath never speckle them; a colourless twin in the main scene casts the drifting shadows
  const cloudScene = new THREE.Scene();
  const group = new THREE.Group(); group.name = 'clouds'; cloudScene.add(group);
  const r = rng(4711);
  const clusters = [];
  const pad = 1200, world = [B.x0 - pad, B.y0 - pad, B.x1 + pad, B.y1 + pad];
  // kind 0 heaped cumulus, 1 small puff, 2 veil of mist; box: where it drifts (it re-enters on the far side)
  const make = (kind, x, y, z, box, scale = 1) => {
    const c = { x, y, z, box, puffs: [] };
    if (kind === 2) {
      // a veil: a few broad, flat, see-through sheets
      const n = 6 + Math.floor(r() * 5), rx = (220 + r() * 180) * scale, ry = (110 + r() * 90) * scale, op = 0.26 + r() * 0.22;
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r());
        c.puffs.push({ dx: Math.cos(a) * d * rx, dy: Math.sin(a) * d * ry, dz: r() * 22, s: (120 + r() * 80) * scale, seed: r() * 10, lift: 0.35 + r() * 0.2, op });
      }
    } else {
      // a flat base of broad puffs with smaller ones heaped toward the middle
      const big = kind === 0, n = big ? 13 + Math.floor(r() * 10) : 5 + Math.floor(r() * 4);
      const rx = (big ? 150 + r() * 170 : 60 + r() * 55) * scale, ry = (big ? 90 + r() * 90 : 45 + r() * 35) * scale, s0 = (big ? 95 : 58) * scale, op = 0.9 + r() * 0.08;
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()), top = i / n; // later puffs sit higher and nearer the middle
        const s = s0 * (1 - 0.44 * top) * (0.8 + 0.4 * r()), reach = 1 - 0.6 * top;
        c.puffs.push({ dx: Math.cos(a) * d * rx * reach, dy: Math.sin(a) * d * ry * reach, dz: top * (big ? 130 : 60) * scale * (1 - 0.5 * d), s, seed: r() * 10, lift: top, op });
      }
    }
    clusters.push(c);
  };
  // across the whole map: about one heap per 3.3 km2, with small puffs and veils between them
  const heaps = Math.max(8, Math.min(140, Math.round((B.w * B.h) / 3.3e6)));
  const anywhere = () => [world[0] + r() * (world[2] - world[0]), world[1] + r() * (world[3] - world[1])];
  for (let k = 0; k < heaps; k++) make(0, ...anywhere(), 300 + r() * 460, world);
  for (let k = 0; k < Math.round(heaps * 0.8); k++) make(1, ...anywhere(), 240 + r() * 480, world);
  for (let k = 0; k < Math.round(heaps * 0.45); k++) make(2, ...anywhere(), 170 + r() * 380, world);
  // cloud that stays round the tallest towers (in a small box about each, at the height of their upper floors)
  const tall = (name, top, half, kinds) => {
    const b = (ctx.data.buildings || []).find((q) => q.n === name);
    const at = b ? b.p[0].reduce((a, p) => [a[0] + p[0] / b.p[0].length, a[1] + p[1] / b.p[0].length], [0, 0]) : null;
    if (!at) return;
    const box = [at[0] - half, at[1] - half * 0.7, at[0] + half, at[1] + half * 0.7];
    kinds.forEach(([kind, f0, f1, scale], i) => make(kind, box[0] + ((i + 0.3 + r() * 0.4) / kinds.length) * 2 * half, at[1] + (r() - 0.5) * half * 0.5, top * (f0 + r() * (f1 - f0)), box, scale));
  };
  tall('Burj Khalifa', 828, 850, [[0, 0.52, 0.66, 0.75], [2, 0.6, 0.8, 0.8], [1, 0.7, 0.86, 0.9], [2, 0.42, 0.55, 0.7]]);
  tall('Marina 101', 432, 620, [[1, 0.6, 0.8, 0.9], [2, 0.55, 0.85, 0.7], [0, 0.62, 0.8, 0.55]]);

  const total = clusters.reduce((a, c) => a + c.puffs.length, 0);
  const geo = new THREE.PlaneGeometry(1, 1);
  const seeds = new Float32Array(total), lifts = new Float32Array(total), ops = new Float32Array(total); let k = 0;
  for (const c of clusters) for (const p of c.puffs) { lifts[k] = p.lift; ops[k] = p.op; seeds[k++] = p.seed; }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geo.setAttribute('aLift', new THREE.InstancedBufferAttribute(lifts, 1));
  geo.setAttribute('aOp', new THREE.InstancedBufferAttribute(ops, 1));

  const uSunDir = { value: new THREE.Vector3(0, 1, 0) }, uSunCol = { value: new THREE.Color(1, 1, 1) }, uNight = { value: 0 }, uFade = { value: 1 }, uTime = { value: 0 };
  // the scene's depth (from the pass that draws the city) and the canvas size: puffs behind a tower are hidden
  const uDepth = { value: null }, uRes = { value: new THREE.Vector2(1, 1) }, uHasDepth = { value: 0 };
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    uniforms: { uSunDir, uSunCol, uNight, uFade, uTime, uDepth, uRes, uHasDepth },
    vertexShader: `attribute float aSeed, aLift, aOp; uniform vec3 uSunDir; varying vec2 vUv; varying float vSeed, vH, vOp; varying vec3 vSunV;
      void main() { vUv = uv; vSeed = aSeed; vH = aLift; vOp = aOp; vSunV = (viewMatrix * vec4(uSunDir, 0.0)).xyz; ${BILLBOARD} }`,
    fragmentShader: `uniform vec3 uSunCol; uniform float uNight, uFade, uHasDepth, uTime; uniform sampler2D uDepth; uniform vec2 uRes;
      varying vec2 vUv; varying float vSeed, vH, vOp; varying vec3 vSunV;
      ${NOISE}
      void main() {
        if (uFade < 0.01) discard;
        float a = puff(vUv, vSeed, uTime);
        if (a < 0.01) discard;
        if (uHasDepth > 0.5) {
          // soft where a puff meets a building, gone behind it
          float sd = texture2D(uDepth, gl_FragCoord.xy / uRes).x;
          a *= 1.0 - smoothstep(0.0, 0.0012, gl_FragCoord.z - sd);
          if (a < 0.01) discard;
        }
        vec2 q = vUv * 2.0 - 1.0;
        // each puff is shaded as a soft ball lit from the sun's side, the upper puffs of a heap brightest; painted in
        // three tones (lavender-grey bellies, a soft body, sunlit crowns), warm at golden hour, grey-blue at night
        vec3 n = normalize(vec3(q, sqrt(max(0.05, 1.0 - dot(q, q)))));
        float ball = dot(n, normalize(vSunV + vec3(0.0, 0.35, 0.25)));
        float veil = 1.0 - smoothstep(0.55, 0.8, vOp);
        float lit = clamp(0.3 + 0.3 * ball + 0.46 * vH + 0.2 * (cfbm(q * 2.2 + vSeed) - 0.5), 0.0, 1.0);
        lit = mix(lit, 0.5 + 0.2 * ball, veil);
        vec3 shadeC = mix(vec3(0.64, 0.68, 0.82), vec3(0.14, 0.17, 0.26), uNight);
        vec3 bodyC = mix(vec3(0.9, 0.92, 0.97), vec3(0.22, 0.25, 0.34), uNight);
        vec3 litC = mix(mix(vec3(1.0), uSunCol, 0.14), vec3(0.3, 0.32, 0.4), uNight);
        vec3 col = mix(shadeC, bodyC, smoothstep(0.24, 0.46, lit));
        col = mix(col, litC, smoothstep(0.54, 0.76, lit));
        col += vec3(0.5, 0.3, 0.15) * uNight * (1.0 - lit) * 0.34; // city glow on the underside
        // after dark cloud is thinner to the eye: the lit city shows through it
        gl_FragColor = vec4(col * (1.0 - 0.3 * uNight), a * vOp * uFade * (1.0 - 0.55 * uNight));
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, total);
  mesh.frustumCulled = false; mesh.renderOrder = 20; mesh.name = 'clouds';
  const shadowMesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), total);
  shadowMesh.instanceMatrix = mesh.instanceMatrix; shadowMesh.frustumCulled = false; shadowMesh.castShadow = true; shadowMesh.name = 'cloud-shadows';
  scene.add(shadowMesh);
  // shadow pass: same billboard (now facing the sun), solid where a heap or puff is dense; veils cast none
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (s) => {
    s.uniforms.uTime = uTime;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSeed, aOp; varying vec2 vPUv; varying float vPSeed, vPOp;')
      .replace('#include <project_vertex>', `vPUv = uv; vPSeed = aSeed; vPOp = aOp; ${BILLBOARD}`);
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>\nuniform float uTime; varying vec2 vPUv; varying float vPSeed, vPOp;\n${NOISE}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vPOp < 0.6 || puff(vPUv, vPSeed, uTime) < 0.55) discard;');
  };
  shadowMesh.customDepthMaterial = depth;
  group.add(mesh);
  const pass = new RenderPass(cloudScene, ctx.activeCamera);
  pass.clear = false; pass.clearDepth = true;
  const at = ctx.composer.passes.indexOf(ctx.bloomPass);
  ctx.composer.insertPass(pass, at >= 0 ? at : ctx.composer.passes.length - 3);

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), sc = new THREE.Vector3();
  const wind = [5.5, 2.2]; // m/s toward the east-north-east
  const place = () => {
    let i = 0;
    for (const c of clusters) for (const p of c.puffs) {
      pv.set(c.x + p.dx, c.z + p.dz, -(c.y + p.dy)); sc.setScalar(p.s * 2);
      m4.compose(pv, q, sc); mesh.setMatrixAt(i++, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  place();
  ctx.on('time', (s) => {
    uSunDir.value.copy(s.sunDir); uNight.value = s.night;
    if (ctx.env) uSunCol.value.copy(ctx.env.sun.color);
  });
  ctx.updaters.push((dt, t) => {
    dt = Math.min(dt, 0.1); uTime.value = t;
    for (const c of clusters) {
      // the clouds kept near a tower drift at a third of the wind, so they linger about it
      const sp = c.box === world ? 1 : 0.35;
      c.x += wind[0] * dt * sp; c.y += wind[1] * dt * sp;
      if (c.x > c.box[2]) c.x = c.box[0]; if (c.y > c.box[3]) c.y = c.box[1];
    }
    place();
    // see-through from mid zoom, gone up close on the iso view; first-person keeps its sky
    const cam = ctx.activeCamera;
    uFade.value = cam && cam.isOrthographicCamera ? 1 - 0.55 * THREE.MathUtils.smoothstep(cam.zoom, 2.0, 4.2) - 0.45 * THREE.MathUtils.smoothstep(cam.zoom, 4.2, 7.5) : 1;
    pass.camera = cam;
    pass.enabled = enabled && uFade.value > 0.01;
    const dt2 = ctx.aoPass && ctx.aoPass.enabled && ctx.aoPass.beautyRenderTarget ? ctx.aoPass.beautyRenderTarget.depthTexture : null;
    uDepth.value = dt2; uHasDepth.value = dt2 && cam.isOrthographicCamera ? 1 : 0;
    if (dt2 && dt2.image) uRes.value.set(dt2.image.width, dt2.image.height);
    shadowMesh.visible = enabled; // keeps casting its drifting shadow even when faded out up close
  });
  let enabled = true;
  return { group, mesh, setEnabled: (v) => { enabled = v; } };
}
