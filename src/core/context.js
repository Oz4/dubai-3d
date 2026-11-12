import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { N8AOPass } from 'n8ao';

// Default framing: camera sits south-east of the target looking north-west,
// so the Arabian Gulf is at the top of the screen like classic aerial shots of the Marina.
export const ISO_POLAR = THREE.MathUtils.degToRad(54);
export const ISO_AZIMUTH = THREE.MathUtils.degToRad(45);
const FRUSTUM_H = 2400; // world metres visible vertically at zoom = 1
const CAM_DIST = 9000;

export function createContext(canvas, data) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // (a page opened in a background tab or a hidden frame can start at 0 x 0: fall back to a typical screen so the
  // camera's zoom never comes out as NaN; the resize handler sets the real size once the page is shown)
  const aspect = () => (window.innerWidth > 0 && window.innerHeight > 0 ? window.innerWidth / window.innerHeight : 1.6);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const [x0, y0, x1, y1] = data.meta.bounds;
  const bounds = { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };

  // ---- cameras
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 50, 30000);
  const persp = new THREE.PerspectiveCamera(62, 1, 0.5, 30000);
  const fitCamera = () => {
    const a = aspect();
    camera.left = (-FRUSTUM_H * a) / 2; camera.right = (FRUSTUM_H * a) / 2;
    camera.top = FRUSTUM_H / 2; camera.bottom = -FRUSTUM_H / 2;
    camera.updateProjectionMatrix();
    persp.aspect = a; persp.updateProjectionMatrix();
  };
  fitCamera();

  const controls = new MapControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.minZoom = 0.42;
  controls.maxZoom = 60;
  controls.minPolarAngle = THREE.MathUtils.degToRad(18);
  // (below 70 degrees: at 70 three's zoom-to-cursor turns the camera back toward its old target on every wheel step)
  controls.maxPolarAngle = THREE.MathUtils.degToRad(68);
  controls.zoomSpeed = 1.4;
  controls.rotateSpeed = 0.6;

  // home: the Marina close-up for a single section; the whole diorama once several sections are built
  const sectionsN = (data.meta.sections || []).length;
  const fitZoom = () => {
    const a = aspect(), diag = (bounds.w + bounds.h) * Math.SQRT1_2;
    return Math.min((FRUSTUM_H * a) / diag, FRUSTUM_H / (diag * Math.cos(ISO_POLAR) + 400)) * 1.04;
  };
  const home = sectionsN > 1
    ? { target: new THREE.Vector3((x0 + x1) / 2, 0, -(y0 + y1) / 2), zoom: fitZoom(), polar: ISO_POLAR, azimuth: ISO_AZIMUTH }
    : { target: new THREE.Vector3(60, 0, -170), zoom: 1.05, polar: ISO_POLAR, azimuth: ISO_AZIMUTH };
  controls.minZoom = Math.min(0.42, home.zoom * 0.8);
  function placeCamera(target, polar, azimuth, zoom) {
    controls.target.copy(target);
    const off = new THREE.Vector3().setFromSphericalCoords(CAM_DIST, polar, azimuth);
    camera.position.copy(target).add(off);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    controls.update();
  }
  placeCamera(home.target, home.polar, home.azimuth, home.zoom);

  // keep the target on the diorama
  controls.addEventListener('change', () => {
    const t = controls.target;
    const cx = THREE.MathUtils.clamp(t.x, x0 + 100, x1 - 100), cz = THREE.MathUtils.clamp(t.z, -y1 + 100, -y0 - 100);
    if (cx !== t.x || cz !== t.z) {
      const dx = cx - t.x, dz = cz - t.z;
      t.x = cx; t.z = cz; camera.position.x += dx; camera.position.z += dz;
    }
  });

  // ---- post-processing: N8AO (ambient occlusion) -> bloom (night) -> tone map -> SMAA
  const size = new THREE.Vector2(window.innerWidth * dpr, window.innerHeight * dpr);
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, rt);
  const aoPass = new N8AOPass(scene, camera, size.x, size.y);
  aoPass.configuration.aoRadius = 16;
  aoPass.configuration.distanceFalloff = 1.0;
  aoPass.configuration.intensity = 4.2;
  aoPass.configuration.halfRes = false; // half-res path is incompatible with three r18x render targets
  aoPass.configuration.gammaCorrection = false;
  aoPass.configuration.color = new THREE.Color(0x15110e);
  const renderPass = new RenderPass(scene, camera);
  renderPass.enabled = false;
  composer.addPass(renderPass);
  composer.addPass(aoPass);
  // illustrated finish: soft ink outlines on silhouettes and roof edges (from the depth N8AO renders)
  // plus atmospheric perspective toward the far side of the view, like an aerial painting
  const inkPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2(1 / size.x, 1 / size.y) },
      uNear: { value: 1 }, uFar: { value: 20000 }, uOrtho: { value: 1 }, uRef: { value: CAM_DIST },
      uInk: { value: 0.34 }, uHaze: { value: new THREE.Color('#b9cde0') }, uHazeAmt: { value: 0.16 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse, tDepth; uniform vec2 uTexel; uniform float uNear, uFar, uOrtho, uRef, uInk, uHazeAmt; uniform vec3 uHaze; varying vec2 vUv;
      float lin(vec2 uv) {
        float d = texture2D(tDepth, uv).x;
        return uOrtho > 0.5 ? uNear + d * (uFar - uNear) : (uNear * uFar) / (uFar - d * (uFar - uNear));
      }
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        float d0 = lin(vUv);
        float dl = lin(vUv - vec2(uTexel.x, 0.0)), dr = lin(vUv + vec2(uTexel.x, 0.0));
        float du = lin(vUv + vec2(0.0, uTexel.y)), dd = lin(vUv - vec2(0.0, uTexel.y));
        // relative depth discontinuity: an edge where the neighbours jump away (silhouettes, roof lips)
        float jump = max(max(dl, dr), max(du, dd)) - d0;
        float lap = abs(dl + dr + du + dd - 4.0 * d0);
        float scale = uOrtho > 0.5 ? 1.0 : d0 * 0.02;
        float edge = smoothstep(2.2 * scale, 7.0 * scale, jump) * 0.85 + smoothstep(6.0 * scale, 20.0 * scale, lap) * 0.35;
        edge *= step(d0, uFar * 0.98);
        c.rgb = mix(c.rgb, c.rgb * vec3(0.2, 0.2, 0.26), clamp(edge, 0.0, 1.0) * uInk);
        // haze grows with distance beyond the focus (the far side of an iso view, the horizon in first person)
        float far = uOrtho > 0.5 ? smoothstep(uRef - 600.0, uRef + 2600.0, d0) : smoothstep(400.0, 4000.0, d0);
        c.rgb = mix(c.rgb, uHaze * (0.85 + 0.15 * dot(c.rgb, vec3(0.33))), far * uHazeAmt * step(d0, uFar * 0.98));
        gl_FragColor = c;
      }`,
  });
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.7, 0.55, 0.9);
  bloomPass.enabled = false;
  composer.addPass(inkPass);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  // gentle grade for the "illustrated map" look: saturation, slight contrast, warm tint
  const gradePass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uSat: { value: 1.26 }, uContrast: { value: 1.08 }, uTint: { value: new THREE.Vector3(1.02, 1.0, 0.97) }, uTexel: { value: new THREE.Vector2(1 / size.x, 1 / size.y) }, uSharp: { value: 0.35 }, uVig: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uSat, uContrast, uSharp, uVig; uniform vec3 uTint; uniform vec2 uTexel; varying vec2 vUv;
      void main(){
        vec4 c = texture2D(tDiffuse, vUv);
        // unsharp mask for crisp, illustrated edges
        vec3 blur = (texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb
                   + texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb) * 0.25;
        c.rgb += (c.rgb - blur) * uSharp;
        float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        // deep shade keeps less colour, so shaded asphalt and paving read grey rather than navy
        c.rgb = mix(vec3(l), c.rgb, uSat * mix(0.72, 1.0, smoothstep(0.08, 0.4, l)));
        // vibrance: lift muted colours more than already-vivid ones (foliage, water, glass)
        float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), satv = (mx - mn) / max(mx, 1e-3);
        c.rgb = mix(vec3(l), c.rgb, 1.0 + 0.2 * (1.0 - satv));
        // split toning: slightly cool shadows, golden highlights, like a painted aerial view in late sun
        float lt = clamp(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
        c.rgb *= mix(vec3(0.97, 0.99, 1.035), vec3(1.05, 1.0, 0.93), smoothstep(0.12, 0.8, lt));
        // S-curve: rich, clear contrast
        c.rgb = (c.rgb - 0.5) * uContrast + 0.5;
        c.rgb = mix(c.rgb, c.rgb * c.rgb * (3.0 - 2.0 * c.rgb), 0.42);
        c.rgb *= uTint;
        // after dark the corners fall away a little, so the lit city holds the eye
        c.rgb *= 1.0 - uVig * smoothstep(0.5, 1.15, length((vUv - 0.5) * vec2(1.25, 1.4)));
        gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a); }`,
  });
  composer.addPass(gradePass);
  const smaaPass = new SMAAPass(size.x, size.y);
  composer.addPass(smaaPass);

  const ctx = {
    THREE, renderer, scene, camera, persp, activeCamera: camera, controls, composer, aoPass, renderPass, bloomPass, smaaPass, gradePass,
    bounds, data, home, placeCamera, dpr,
    clock: new THREE.Clock(), time: 0,
    updaters: [], // fn(dt, t)
    events: new EventTarget(),
    last: {}, // the latest payload of every event, so parts built later (streamed sections) can catch up
    emit(name, detail) { this.last[name] = detail; this.events.dispatchEvent(new CustomEvent(name, { detail })); },
    // subscribe; returns the unsubscribe function
    on(name, fn) { const h = (e) => fn(e.detail); this.events.addEventListener(name, h); return () => this.events.removeEventListener(name, h); },
  };

  ctx.setAO = (on) => { aoPass.enabled = on; renderPass.enabled = !on; inkPass.enabled = on; };

  // ---- interaction: background work (streaming, ground painting) backs off while the user moves the map
  let dragging = false, lastMove = 0;
  const poke = () => { lastMove = performance.now(); };
  controls.addEventListener('start', () => { dragging = true; poke(); });
  controls.addEventListener('end', () => { dragging = false; poke(); });
  controls.addEventListener('change', poke); // also fires while the view glides to a stop
  canvas.addEventListener('wheel', poke, { passive: true });
  ctx.isInteracting = () => dragging || performance.now() - lastMove < 250;

  // ---- turning the view pivots on what is at the centre of the screen
  // The controls turn the camera about their target, which sits on the ground on the view axis. Zoomed in on a
  // tower, that ground point lies far behind it (about 140 m behind a 100 m tower), so a turn swung the tower
  // across the screen. When a turn starts, the target slides along the view axis to the surface at the centre of
  // the screen (a facade or a roof, else the ground). The camera is orthographic, so the picture does not change,
  // and that point stays put while the view turns. ctx.focus() is the ground point at the centre of the view, for
  // whatever needs the view's position on the map (streaming, shadows, ground tiles, crowds).
  const _rc = new THREE.Raycaster(), _mid = new THREE.Vector2(0, 0), _ax = new THREE.Vector3(), _fo = new THREE.Vector3(), _pv = new THREE.Vector3(), _d = new THREE.Vector3();
  const axisAtY = (y, out) => {
    _ax.copy(controls.target).sub(camera.position).normalize();
    if (Math.abs(_ax.y) < 1e-4) return out.copy(controls.target);
    return out.copy(controls.target).addScaledVector(_ax, (y - controls.target.y) / _ax.y);
  };
  ctx.focus = () => axisAtY(0, _fo);
  ctx.pivotOnCentre = () => {
    if (ctx.activeCamera !== camera || !ctx.buildings || !ctx.buildings.pick) return;
    camera.updateMatrixWorld();
    _rc.setFromCamera(_mid, camera);
    const hit = ctx.buildings.pick(_rc);
    if (hit) {
      // the hit lies on the centre ray; keep the target exactly on the view axis at that depth
      _ax.copy(controls.target).sub(camera.position).normalize();
      const depth = _ax.dot(_d.copy(hit.point).sub(camera.position));
      _pv.copy(camera.position).addScaledVector(_ax, depth);
    } else axisAtY(0, _pv);
    _pv.sub(controls.target);
    controls.target.add(_pv); camera.position.add(_pv);
  };
  // drag turns (right mouse, ctrl/shift + left, two-finger twist); the toolbar turns go through flyTo (ui.js)
  controls.addEventListener('start', () => { const s = controls.state; if (s === 0 || s === 3 || s === 6) ctx.pivotOnCentre(); });
  // resolves on a later task once the map is still: long jobs await this between slices
  ctx.workGate = () => new Promise((resolve) => {
    const check = () => (ctx.isInteracting() ? setTimeout(check, 50) : resolve());
    setTimeout(check, 0);
  });

  // ---- render resolution (quality presets)
  let pixelRatio = dpr;
  const applySize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    const w = Math.round(window.innerWidth * pixelRatio), h = Math.round(window.innerHeight * pixelRatio);
    composer.setSize(window.innerWidth, window.innerHeight);
    aoPass.setSize(w, h);
    gradePass.uniforms.uTexel.value.set(1 / w, 1 / h);
    inkPass.uniforms.uTexel.value.set(1 / w, 1 / h);
  };
  ctx.setPixelRatio = (pr) => {
    pixelRatio = pr; ctx.dpr = pr;
    renderer.setPixelRatio(pr); composer.setPixelRatio(pr);
    applySize();
  };
  ctx.inkPass = inkPass;
  ctx.updaters.push(() => {
    const u = inkPass.uniforms, cam = ctx.activeCamera;
    u.tDepth.value = aoPass.beautyRenderTarget ? aoPass.beautyRenderTarget.depthTexture : null;
    u.uNear.value = cam.near; u.uFar.value = cam.far; u.uOrtho.value = cam.isOrthographicCamera ? 1 : 0;
    inkPass.enabled = aoPass.enabled && !!u.tDepth.value;
  });
  ctx.useCamera = (cam) => {
    ctx.activeCamera = cam;
    renderPass.camera = cam;
    aoPass.camera = cam;
    if (aoPass.configuration) aoPass.configuration.screenSpaceRadius = !!cam.isPerspectiveCamera;
    if (cam.isPerspectiveCamera) { aoPass.configuration.aoRadius = 32; aoPass.configuration.distanceFalloff = 0.25; }
    else { aoPass.configuration.aoRadius = 14; aoPass.configuration.distanceFalloff = 1.0; }
    ctx.emit('camera-mode', !!cam.isPerspectiveCamera);
  };

  window.addEventListener('resize', () => {
    fitCamera();
    applySize();
    ctx.emit('resize');
  });

  return ctx;
}
