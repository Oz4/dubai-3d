import * as THREE from 'three';
import * as SunCalc from 'suncalc';

const DUBAI_UTC_OFFSET_MIN = 240; // UTC+4, no DST
const sstep = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const col = (h) => new THREE.Color(h);
function lerpStops(stops, x) {
  // stops: [[x, Color], ...] ascending by x
  if (x <= stops[0][0]) return stops[0][1].clone();
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const t = (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return stops[i - 1][1].clone().lerp(stops[i][1], t);
    }
  }
  return stops[stops.length - 1][1].clone();
}
const lerpNum = (stops, x) => {
  if (x <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (x <= stops[i][0]) {
    const t = (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
    return stops[i - 1][1] + (stops[i][1] - stops[i - 1][1]) * t;
  }
  return stops[stops.length - 1][1];
};

// Colour scripts keyed by sun altitude in degrees
// a warm, golden sun and a clear blue sky fill: light that reads as painted rather than neutral
const SUN_COLOR = [[-4, col('#ff7a3d')], [0, col('#ff8c4a')], [6, col('#ffab62')], [14, col('#ffcc92')], [30, col('#ffe0b4')], [60, col('#ffedd2')]];
const SUN_INT = [[-3, 0], [0, 0.7], [5, 2.1], [15, 3.2], [35, 3.95], [70, 4.15]];
// a soft, only slightly blue sky fill: shadows read clearly and stay neutral rather than navy
const HEMI_SKY = [[-12, col('#34457a')], [-4, col('#4f5d92')], [2, col('#b8b8cc')], [10, col('#c9d2e2')], [30, col('#c6d1e2')]];
const HEMI_GROUND = [[-12, col('#3a2c2a')], [-4, col('#43343c')], [2, col('#b8936f')], [12, col('#cdb28a')], [30, col('#d6c09b')]];
const HEMI_INT = [[-12, 0.95], [-4, 0.9], [2, 0.92], [15, 0.9], [40, 0.9]];
const SKY_TOP = [[-12, col('#040915')], [-4, col('#16244a')], [0, col('#3a5a9a')], [8, col('#4f86c9')], [25, col('#3f8ee0')]];
const SKY_HORIZON = [[-12, col('#121a33')], [-5, col('#4a3d66')], [-1, col('#f08a5d')], [4, col('#ffbe86')], [12, col('#e6eef5')], [30, col('#d9ebfb')]];
const BG_INNER = [[-12, col('#121a33')], [-3, col('#26304f')], [3, col('#2f3d5e')], [15, col('#2b4063')], [40, col('#2c4468')]];
const BG_OUTER = [[-12, col('#05080f')], [0, col('#0b1120')], [30, col('#0d1628')]];

export function createEnvironment(ctx) {
  const { scene, renderer, data } = ctx;
  const { lat0, lon0 } = data.meta;

  // ---- lights
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.9;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 9000;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0xcfe0f7, 0xd8c6a4, 1.2);
  scene.add(hemi);

  // ---- sky dome used only to build the reflection environment (PMREM)
  const skyUniforms = {
    uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() }, uSunVis: { value: 1 },
  };
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, uniforms: skyUniforms,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uTop, uHorizon, uGround, uSunDir, uSunColor; uniform float uSunVis; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 c = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h,0.0,1.0), 0.55)) : mix(uHorizon, uGround, clamp(-h*4.0,0.0,1.0));
        float s = max(dot(d, uSunDir), 0.0);
        c += uSunColor * (pow(s, 600.0) * 18.0 + pow(s, 12.0) * 0.45) * uSunVis;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const skyScene = new THREE.Scene();
  skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), skyMat));

  // ---- first-person extras: visible sky dome, horizon ground and haze (iso view keeps the dark board)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(20000, 48, 24), skyMat.clone());
  dome.material.uniforms = skyUniforms; dome.material.fog = false; dome.renderOrder = -10;
  dome.visible = false; dome.frustumCulled = false;
  scene.add(dome);
  const horizonMat = new THREE.ShaderMaterial({
    uniforms: { uSea: { value: new THREE.Color('#1d5f99') }, uSand: { value: new THREE.Color('#cdb48c') }, uHaze: { value: new THREE.Color() }, uCam: { value: new THREE.Vector3() } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform vec3 uSea, uSand, uHaze, uCam; varying vec3 vW;
      void main(){
        // coast runs NE-SW through the model; the Gulf lies to the north-west
        float side = dot(vec2(vW.x, -vW.z) - vec2(-600.0, 250.0), normalize(vec2(-0.72, 0.69)));
        vec3 c = mix(uSand, uSea, smoothstep(-150.0, 150.0, side));
        float d = length(vW.xz - uCam.xz);
        c = mix(c, uHaze, smoothstep(2500.0, 16000.0, d));
        gl_FragColor = vec4(c, 1.0);
      }`,
    depthWrite: true,
  });
  // The horizon ground surrounds the model but never lies under it: two huge planes 10 cm apart cannot be
  // depth-sorted reliably from a window view (the sea flickered into this painted ground), so the model's
  // footprint is cut out and the ring sits lower (the diorama's edge walls fill the step).
  const hb = ctx.bounds, hcx = (hb.x0 + hb.x1) / 2, hcy = (hb.y0 + hb.y1) / 2, HR = 30000;
  const hShape = new THREE.Shape([new THREE.Vector2(hcx - HR, hcy - HR), new THREE.Vector2(hcx + HR, hcy - HR), new THREE.Vector2(hcx + HR, hcy + HR), new THREE.Vector2(hcx - HR, hcy + HR)]);
  hShape.holes.push(new THREE.Path([new THREE.Vector2(hb.x0, hb.y0), new THREE.Vector2(hb.x0, hb.y1), new THREE.Vector2(hb.x1, hb.y1), new THREE.Vector2(hb.x1, hb.y0)]));
  const horizon = new THREE.Mesh(new THREE.ShapeGeometry(hShape).rotateX(-Math.PI / 2), horizonMat); // (east, north) -> (x, -z)
  horizon.position.y = -3; horizon.visible = false; horizon.renderOrder = -5;
  scene.add(horizon);
  const fog = new THREE.Fog(0xcfe0f0, 2500, 14000);
  let firstPerson = false;
  const applyMode = () => {
    dome.visible = horizon.visible = firstPerson;
    scene.background = firstPerson ? null : bgTex;
    scene.fog = firstPerson ? fog : null;
  };
  ctx.on('camera-mode', (persp) => { firstPerson = persp; applyMode(); });
  ctx.updaters.push(() => { if (firstPerson) { dome.position.copy(ctx.persp.position); horizonMat.uniforms.uCam.value.copy(ctx.persp.position); } });
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;
  // Materials that should show crisp sky reflections (glass, water). Everything else only gets a faint
  // share of the sky light so the warm sun/hemisphere palette is not washed blue.
  const reflective = new Map();
  const addReflective = (mat, intensity) => { reflective.set(mat, intensity); if (envRT) { mat.envMap = envRT.texture; mat.envMapIntensity = intensity; mat.needsUpdate = true; } };

  // ---- background (dark vignette like a presentation board)
  const bgCanvas = document.createElement('canvas'); bgCanvas.width = 512; bgCanvas.height = 512;
  const bgTex = new THREE.CanvasTexture(bgCanvas); bgTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = bgTex;
  function paintBackground(inner, outer) {
    const g = bgCanvas.getContext('2d');
    const grd = g.createRadialGradient(256, 230, 20, 256, 256, 400);
    grd.addColorStop(0, '#' + inner.getHexString()); grd.addColorStop(1, '#' + outer.getHexString());
    g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
    bgTex.needsUpdate = true;
  }

  const state = {
    date: new Date(), altitude: 0, azimuth: 0, night: 0, golden: 0,
    sunDir: new THREE.Vector3(0, 1, 0), lightDir: new THREE.Vector3(0, 1, 0), times: null,
  };
  let lastEnvKey = '';

  function setDate(date) {
    state.date = date;
    const p = SunCalc.getPosition(date, lat0, lon0);
    const alt = p.altitude, az = THREE.MathUtils.degToRad(p.azimuth), altR = THREE.MathUtils.degToRad(alt);
    state.altitude = alt; state.azimuth = p.azimuth;
    // world: x = east, y = up, z = south
    state.sunDir.set(Math.sin(az) * Math.cos(altR), Math.sin(altR), -Math.cos(az) * Math.cos(altR)).normalize();
    state.night = sstep(3, -7, alt);
    state.golden = sstep(22, 6, alt) * (1 - sstep(0, -6, alt));
    state.times = SunCalc.getTimes(date, lat0, lon0, 0, DUBAI_UTC_OFFSET_MIN);

    // light direction: sun by day, moon (fixed-ish high direction) by night
    let lightDir = state.sunDir.clone();
    let intensity = lerpNum(SUN_INT, alt);
    const sc = lerpStops(SUN_COLOR, alt);
    if (alt < 0.5) {
      const m = SunCalc.getMoonPosition(date, lat0, lon0);
      const maz = THREE.MathUtils.degToRad(m.azimuth), malt = THREE.MathUtils.degToRad(Math.max(m.altitude, 25));
      const moonDir = new THREE.Vector3(Math.sin(maz) * Math.cos(malt), Math.sin(malt), -Math.cos(maz) * Math.cos(malt)).normalize();
      const k = sstep(0.5, -6, alt);
      lightDir = alt < -2 ? moonDir : lightDir.lerp(moonDir, k).normalize();
      sc.lerp(col('#8fa6e8'), k);
      intensity = Math.max(intensity, 0.62 * k);
    }
    // keep shadows from going absurdly long at the horizon
    if (lightDir.y < 0.07) { lightDir.y = 0.07; lightDir.normalize(); }
    state.lightDir.copy(lightDir);
    sun.color.copy(sc);
    sun.intensity = intensity;

    hemi.color.copy(lerpStops(HEMI_SKY, alt));
    hemi.groundColor.copy(lerpStops(HEMI_GROUND, alt));
    hemi.intensity = lerpNum(HEMI_INT, alt);

    skyUniforms.uTop.value.copy(lerpStops(SKY_TOP, alt));
    skyUniforms.uHorizon.value.copy(lerpStops(SKY_HORIZON, alt));
    skyUniforms.uGround.value.copy(lerpStops(HEMI_GROUND, alt)).multiplyScalar(0.8);
    skyUniforms.uSunDir.value.copy(state.sunDir);
    skyUniforms.uSunColor.value.copy(sc);
    skyUniforms.uSunVis.value = sstep(-3, 2, alt);
    fog.color.copy(skyUniforms.uHorizon.value).lerp(new THREE.Color('#ffffff'), alt > 0 ? 0.15 : 0);
    horizonMat.uniforms.uHaze.value.copy(fog.color);
    if (ctx.inkPass) {
      const u = ctx.inkPass.uniforms;
      u.uHaze.value.copy(fog.color).lerp(new THREE.Color('#d9e6f2'), alt > 0 ? 0.35 : 0);
      u.uHazeAmt.value = lerpNum([[-10, 0.1], [0, 0.12], [15, 0.17]], alt);
      u.uInk.value = lerpNum([[-10, 0.3], [0, 0.42], [15, 0.55]], alt);
    }
    const shade = lerpNum([[-10, 0.12], [0, 0.55], [15, 1.0]], alt);
    horizonMat.uniforms.uSea.value.set('#1d5f99').multiplyScalar(shade);
    horizonMat.uniforms.uSand.value.set('#cdb48c').multiplyScalar(shade);

    // regenerate the reflection environment when the sky changed noticeably
    const key = Math.round(alt * 2) + ':' + Math.round(p.azimuth / 6);
    if (key !== lastEnvKey) {
      lastEnvKey = key;
      const next = pmrem.fromScene(skyScene, 0, 0.1, 100);
      scene.environment = next.texture;
      scene.environmentIntensity = lerpNum([[-10, 0.25], [0, 0.3], [20, 0.32]], alt);
      const first = !envRT;
      for (const [m, k] of reflective) { m.envMap = next.texture; m.envMapIntensity = k; if (first) m.needsUpdate = true; }
      if (envRT) envRT.dispose();
      envRT = next;
      paintBackground(lerpStops(BG_INNER, alt), lerpStops(BG_OUTER, alt));
    }
    renderer.toneMappingExposure = lerpNum([[-12, 1.06], [0, 1.02], [30, 1.06]], alt);
    if (ctx.gradePass) {
      const u = ctx.gradePass.uniforms;
      u.uSat.value = lerpNum([[-12, 1.1], [0, 1.12], [30, 1.06]], alt);
      u.uTint.value.set(...(alt < -4 ? [0.94, 0.98, 1.08] : alt < 10 ? [1.04, 1.0, 0.95] : [1.02, 1.0, 0.97]));
      if (u.uVig) u.uVig.value = 0.34 * state.night;
    }
    ctx.bloomPass.enabled = state.night > 0.05 && ctx.bloomAllowed !== false;
    // night glow: a tight halo round the brightest lights (lit windows, lamps, LED lines, crowns), small enough
    // that the lights themselves stay sharp
    ctx.bloomPass.strength = 0.08 + 0.2 * state.night;
    ctx.bloomPass.threshold = 1.08;
    ctx.bloomPass.radius = 0.3;
    ctx.emit('time', state);
  }

  // Fit the shadow frustum around what the camera is looking at. The shadow map is re-rendered when that frame
  // or the sun moves, otherwise at the quality preset's rate (swaying trees, walkers and traffic), not every frame.
  const tmp = new THREE.Vector3();
  const lastSh = { cx: NaN, cz: NaN, r: NaN, lx: NaN, ly: NaN, lz: NaN, t: 0 };
  let shadowsOn = true;
  renderer.shadowMap.autoUpdate = false;
  function updateShadow() {
    const cam = ctx.activeCamera;
    let center, radius;
    if (cam.isOrthographicCamera) {
      center = ctx.focus ? ctx.focus() : ctx.controls.target; // the ground at the centre of the view
      const vw = (cam.right - cam.left) / cam.zoom, vh = (cam.top - cam.bottom) / cam.zoom;
      radius = THREE.MathUtils.clamp(Math.hypot(vw, vh) * 0.62 + 60, 250, 4200);
    } else {
      cam.getWorldDirection(tmp);
      center = cam.position.clone().addScaledVector(tmp, 700); center.y = 0;
      radius = 1400;
    }
    const sc = sun.shadow.camera;
    // snap to texel grid to avoid shimmering while panning
    const texel = (2 * radius) / sun.shadow.mapSize.x;
    const cx = Math.round(center.x / texel) * texel, cz = Math.round(center.z / texel) * texel;
    sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
    sc.updateProjectionMatrix();
    sun.target.position.set(cx, 0, cz);
    sun.position.set(cx, 0, cz).addScaledVector(state.lightDir, 4500);
    sun.target.updateMatrixWorld();
    const L = state.lightDir, now = performance.now();
    let hz = (ctx.quality && ctx.quality.shadowHz) || 0;
    if (cam.isOrthographicCamera && cam.zoom < 0.5) hz = hz ? Math.min(hz, 4) : 4; // far out, moving shadows are too small to see
    const moved = cx !== lastSh.cx || cz !== lastSh.cz || radius !== lastSh.r || L.x !== lastSh.lx || L.y !== lastSh.ly || L.z !== lastSh.lz;
    if (shadowsOn && (moved || !hz || now - lastSh.t >= 1000 / hz)) { renderer.shadowMap.needsUpdate = true; lastSh.t = now; }
    Object.assign(lastSh, { cx, cz, r: radius, lx: L.x, ly: L.y, lz: L.z });
  }
  ctx.updaters.push(updateShadow);
  const setShadows = (on) => { shadowsOn = on; sun.shadow.intensity = on ? 1 : 0; renderer.shadowMap.needsUpdate = true; };
  const setShadowSize = (n) => {
    if (sun.shadow.mapSize.x === n) return;
    sun.shadow.mapSize.set(n, n);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    renderer.shadowMap.needsUpdate = true;
  };

  const removeReflective = (mat) => { reflective.delete(mat); };
  const env = { sun, hemi, state, setDate, addReflective, removeReflective, setShadows, setShadowSize };
  ctx.env = env;
  return env;
}

// Build a Date for a given Dubai local calendar day + minutes after midnight.
export function dubaiDate(y, m, d, minutes) {
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + (minutes - DUBAI_UTC_OFFSET_MIN) * 60000);
}
export function dubaiParts(date) {
  const t = new Date(date.getTime() + DUBAI_UTC_OFFSET_MIN * 60000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}
