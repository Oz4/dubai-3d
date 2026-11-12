// Grass that moves: real blades on every lawn round the view, bending in the same gusts that roll over the painted
// ground. A fixed pool of tufts is wrapped round the centre of the view (each tuft keeps its place in the world, so
// nothing swims as the camera moves); a tuft only grows where the ground painting says lawn (parks, verges, gardens,
// golf rough and fairways), away from paving, roads and buildings, and takes the colour painted under it. Blades are
// drawn larger at mid zoom, so they read as tufts from further out and as single blades up close.
import * as THREE from 'three';
import { GLSL_NOISE, rng } from '../core/util.js';

export function buildGrass(ctx, ground) {
  const T = ground.tex; if (!T) return null;
  const S = 260, N = 300000, BLADES = 2;
  // one tuft: blades of two segments (base, middle, tip); z carries the blade's index
  const pos = [], idx = [];
  for (let b = 0; b < BLADES; b++) {
    const o = b * 5;
    pos.push(-0.5, 0, b, 0.5, 0, b, -0.36, 0.5, b, 0.36, 0.5, b, 0, 1, b);
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const off = new Float32Array(N * 4), r = rng(90210);
  for (let i = 0; i < N; i++) { off[i * 4] = r() * S; off[i * 4 + 1] = r() * S; off[i * 4 + 2] = r(); off[i * 4 + 3] = r(); }
  geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
  geo.instanceCount = N;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const U = {
    uTime: ground.uTime, uFocus: { value: new THREE.Vector2() }, uS: { value: S }, uShow: { value: 0 }, uTall: { value: 1 }, uViewR: { value: S / 2 },
    uGrid: T.uGrid, uGridN: T.uGridN, uDetL: { value: T.detTex }, uDetK: { value: T.detCls }, uIndir: { value: T.indir },
  };
  // (no depth written, and drawn after everything solid: the depth-based shading and outline passes then leave the
  // blades alone instead of inking every one black)
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.97, metalness: 0, side: THREE.DoubleSide, depthWrite: false });
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, U);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        precision highp sampler2DArray;
        attribute vec4 aOff;
        uniform float uTime, uS, uShow, uTall, uViewR; uniform vec2 uFocus, uGridN; uniform vec4 uGrid;
        uniform sampler2D uIndir; uniform sampler2DArray uDetL, uDetK;
        varying vec3 vGCol; varying float vGT;
        ${GLSL_NOISE}
        // the ground painting's class value under a point (class * 16 + a no-grass flag), -1 where no sharp tile is loaded
        float classAt(vec2 p, out vec3 uvw) {
          vec2 gq = vec2(p.x - uGrid.x, uGrid.y + p.y);
          vec2 tc = clamp(floor(gq / uGrid.z), vec2(0.0), uGridN - 1.0);
          float slot = floor(texelFetch(uIndir, ivec2(tc), 0).r * 255.0 + 0.5) - 1.0;
          uvw = vec3(0.0);
          if (slot < 0.0) return -1.0;
          uvw = vec3((gq - tc * uGrid.z + uGrid.w) / (uGrid.z + 2.0 * uGrid.w), slot);
          return floor(textureLod(uDetK, uvw, 0.0).r * 255.0 + 0.5);
        }
        // how tall grass grows on that class: lawns, rough and woodland floor full height, fairways mown short
        float growOn(float raw) {
          if (raw < 0.0) return 0.0;
          float cls = floor(raw / 16.0 + 0.5);
          if (raw - cls * 16.0 > 3.0) return 0.0; // under a building, a kerbed street or a motorway
          return (cls == 6.0 || cls == 8.0 || cls == 11.0) ? 1.0 : cls == 7.0 ? 0.45 : 0.0;
        }`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `
        vec2 root = aOff.xy + floor((uFocus - aOff.xy) / uS + 0.5) * uS;
        vec2 dq = abs(root - uFocus);
        float far = max(dq.x, dq.y);
        vec3 transformed = vec3(root.x, -4.0, root.y);
        vGCol = vec3(0.0); vGT = 0.0;
        if (far < uViewR && uShow > 0.01) {
          vec3 uvw, u2;
          float grow = growOn(classAt(root, uvw));
          float ang = aOff.w * 6.2832;
          if (grow > 0.0) {
            // only well inside the lawn: the class map is coarse, and kerbs, walls and paths stand at its edges
            vec2 d1 = vec2(cos(ang), sin(ang)) * 1.1, d2 = vec2(-d1.y, d1.x);
            grow = min(grow, min(growOn(classAt(root + d1, u2)), growOn(classAt(root - d1, u2))));
            if (grow > 0.0) grow = min(grow, min(growOn(classAt(root + d2, u2)), growOn(classAt(root - d2, u2))));
          }
          if (grow > 0.0) {
            vec4 lc = textureLod(uDetL, uvw, 0.0);
            grow *= step(0.9, lc.a); // not in the flower beds
            float edge = 1.0 - smoothstep(0.82, 1.0, far / uViewR);
            float h = grow * edge * uShow;
            if (h > 0.03) {
              float bid = position.z, t = position.y;
              float yaw = ang + bid * 2.4 + 1.0;
              vec2 dir = vec2(cos(yaw), sin(yaw)), side = vec2(-dir.y, dir.x);
              float bh = (0.34 + 0.42 * aOff.z) * (0.8 + 0.4 * fract(aOff.w * 7.3 + bid * 0.37)) * uTall * h;
              // the same gusts the land shader paints: bands of bent, lighter blades rolling downwind
              float gust = vnoise(root * 0.03 + vec2(uTime * 0.2, uTime * 0.08));
              float wave = sin(dot(root, vec2(0.62, 0.78)) * 0.5 - uTime * 1.7 + gust * 9.0);
              float bend = smoothstep(0.3, 1.0, wave) * smoothstep(0.3, 0.72, gust);
              float flutter = sin(uTime * (2.6 + 2.0 * aOff.z) + aOff.w * 40.0 + bid * 1.7);
              vec2 push = vec2(0.62, 0.78) * (0.12 + 0.8 * bend + 0.1 * flutter) + dir * 0.3;
              transformed = vec3(root.x, 0.02, root.y);
              transformed.xz += side * position.x * 0.3 * uTall * (0.7 + 0.5 * aOff.z) + push * (t * t) * bh;
              transformed.y += bh * t * (1.0 - 0.3 * t * bend);
              float hue = smoothstep(0.25, 0.75, fbm(root * 0.016 + 3.0));
              vGCol = lc.rgb * mix(vec3(0.9, 1.02, 1.04), vec3(1.08, 1.05, 0.8), hue) * (1.0 + 0.24 * bend);
              vGT = t;
            }
          }
        }`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGCol; varying float vGT;')
      // a little darker at the root, lighter and yellower at the tip
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vGCol * mix(vec3(0.52, 0.6, 0.56), vec3(1.7, 1.78, 0.95), vGT * vGT);')
      // lit like the lawn under it whichever way a blade faces
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);');
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 6; mesh.receiveShadow = true; mesh.castShadow = false; mesh.name = 'grass';
  ground.group.add(mesh);

  let enabled = true;
  const ss = (x, a, b) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  ctx.updaters.push(() => {
    const cam = ctx.activeCamera, ortho = cam.isOrthographicCamera;
    const q = ctx.quality && ctx.quality.grass != null ? ctx.quality.grass : 1;
    let show = 0, tall = 1, viewR = S / 2, fx, fz;
    if (ortho) {
      // blades appear once the tuft pool covers the whole view, and are drawn larger the further out the view is
      show = ss(cam.zoom, 11, 14.5); tall = Math.max(1, Math.min(2.4, 40 / cam.zoom));
      const f = ctx.focus ? ctx.focus() : ctx.controls.target; fx = f.x; fz = f.z;
      const span = Math.hypot(cam.right - cam.left, cam.top - cam.bottom) / cam.zoom;
      const tilt = Math.max(0.36, Math.cos(ctx.controls.getPolarAngle ? ctx.controls.getPolarAngle() : 0.95));
      viewR = Math.min(S / 2, (span * 0.5) / tilt + 12);
    } else { show = 1; fx = cam.position.x; fz = cam.position.z; }
    mesh.visible = enabled && q > 0 && show > 0.01;
    if (!mesh.visible) return;
    geo.instanceCount = Math.max(1000, Math.round(N * Math.min(1, q)));
    U.uShow.value = show; U.uTall.value = tall; U.uViewR.value = viewR; U.uFocus.value.set(fx, fz);
  });
  return { mesh, U, setEnabled: (v) => { enabled = v; } };
}
