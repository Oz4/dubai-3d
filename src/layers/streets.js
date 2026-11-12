// The walkable city: paved footways and promenades with kerbs, timber boardwalks, stairs, shared
// paths with a red cycle strip and bike symbols, cycle tracks, slim promenade lanterns that light
// up after dark, and bike-share docks.
import * as THREE from 'three';
import { GLSL_NOISE, newBuilder, addRibbon, builderGeometry } from '../core/util.js';
import { STREET_SURFACE } from './streetSurface.js';

export function buildStreets(ctx) {
  const { data, scene } = ctx;
  const group = new THREE.Group(); group.name = 'streets'; scene.add(group);
  const uNight = { value: 0 };
  ctx.on('time', (s) => { uNight.value = s.night; });

  // ------------------------------------------------------------ walkway surfaces
  const W = newBuilder(['aWalk']);
  // draw narrow paths first so promenades and cycle strips win where they overlap
  const walks = data.paths.filter((p) => typeof p.k === 'number' && !p.h && p.p.length >= 2).sort((a, b) => a.w - b.w);
  for (const p of walks) addRibbon(W, p.p, p.w, 0.055 + Math.min(0.02, p.w * 0.002), { aWalk: [p.k, p.w, p.l || 0, 0] });
  if (W.idx.length) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.88, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    mat.onBeforeCompile = (s) => {
      s.uniforms.uNight = uNight;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aWalk; varying vec4 vWalk; varying vec2 vWUv; varying vec3 vWWP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWalk = aWalk; vWUv = uv; vWWP = (modelMatrix * vec4(position, 1.0)).xyz;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
        uniform float uNight; varying vec4 vWalk; varying vec2 vWUv; varying vec3 vWWP;
        ${GLSL_NOISE}
        float lnW(float d, float w) { float aa = max(fwidth(d), 1e-4); float wd = max(w, aa * 0.75); return (1.0 - smoothstep(wd - aa * 0.5, wd + aa * 0.5, abs(d))) * min(1.0, w / wd); }
        // a little bicycle symbol painted every 20 m
        float bikeGlyph(vec2 q) {
          float r = 0.3;
          float g = lnW(length(q - vec2(-0.48, 0.0)) - r, 0.045) + lnW(length(q - vec2(0.48, 0.0)) - r, 0.045);
          vec2 a = q - vec2(-0.48, 0.0), b = vec2(0.96, 0.0);
          float t = clamp(dot(a, b) / dot(b, b), 0.0, 1.0); g += lnW(length(a - b * t), 0.04);
          vec2 c = q - vec2(-0.1, 0.0), e = vec2(0.25, 0.42); float t2 = clamp(dot(c, e) / dot(e, e), 0.0, 1.0); g += lnW(length(c - e * t2), 0.04);
          return clamp(g, 0.0, 1.0);
        }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float k = floor(vWalk.x + 0.5), w = vWalk.y, live = vWalk.z;
          float s = vWUv.x, v = vWUv.y, x = v * 0.5 * w; // along (m), across (-1..1), across (m)
          float fine = 1.0 - smoothstep(0.06, 0.25, fwidth(s));
          vec3 c;
          if (k < 0.5 || (k > 5.5 && k < 6.5)) {
            // stone pavers (60 cm) in two warm tones, darker kerb
            vec2 q = vec2(s, x) / 0.6; vec2 f = fract(q);
            float joint = smoothstep(0.0, 0.07, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
            c = mix(vec3(0.74, 0.69, 0.6), vec3(0.82, 0.78, 0.7), hash12(floor(q))) * mix(1.0, 0.86 + 0.14 * joint, fine);
            if (k > 5.5) {
              // shared path: red cycle strip on one side, white divider, bike symbols
              float strip = step(0.08, v);
              c = mix(c, vec3(0.5, 0.17, 0.12) * (0.92 + 0.12 * vnoise(vWWP.xz * 1.7)), strip);
              c = mix(c, vec3(0.93), lnW(v - 0.08, 0.05 / max(w, 1.0)) * fine);
              vec2 gq = vec2(mod(s, 20.0) - 10.0, x - 0.5 * (0.08 + 1.0) * 0.5 * w);
              c = mix(c, vec3(0.92), bikeGlyph(gq * 1.6) * fine * step(1.8, w));
            }
          } else if (k < 1.5) {
            // promenade: large light slabs with darker accent bands every 6 m
            vec2 q = vec2(s / 1.2, x / 0.9); vec2 f = fract(q);
            float joint = smoothstep(0.0, 0.05, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
            c = mix(vec3(0.8, 0.76, 0.68), vec3(0.86, 0.83, 0.76), hash12(floor(q))) * mix(1.0, 0.9 + 0.1 * joint, fine);
            float band = 1.0 - smoothstep(0.35, 0.45, abs(mod(s, 6.0) - 3.0) - 2.4);
            c = mix(c, vec3(0.58, 0.48, 0.38), (1.0 - band) * 0.55);
          } else if (k < 2.5) {
            // cycle track: red asphalt, white edges, dashed centre line, bike symbols
            c = vec3(0.5, 0.17, 0.12) * (0.92 + 0.12 * vnoise(vWWP.xz * 1.7));
            c = mix(c, vec3(0.93), lnW(abs(v) - 0.88, 0.05) * fine);
            c = mix(c, vec3(0.93), lnW(v, 0.04) * step(0.5, fract(s / 4.0)) * fine);
            c = mix(c, vec3(0.92), bikeGlyph(vec2(mod(s, 20.0) - 10.0, x - w * 0.25) * 1.6) * fine);
          } else if (k < 3.5) {
            // timber boardwalk: planks across the walk
            float pl = s / 0.16; float pf = fract(pl);
            c = vec3(0.5, 0.36, 0.23) * (0.82 + 0.26 * hash12(vec2(floor(pl), 3.0))) * mix(1.0, 0.75 + 0.25 * smoothstep(0.0, 0.12, min(pf, 1.0 - pf)), fine);
          } else if (k < 4.5) {
            c = vec3(0.7, 0.62, 0.46) * (0.9 + 0.15 * vnoise(vWWP.xz * 3.0));
          } else if (k > 6.5) {
            // rubber running track: terracotta with white lane lines and 100 m markers
            c = vec3(0.55, 0.2, 0.13) * (0.93 + 0.09 * vnoise(vWWP.xz * 4.0));
            c = mix(c, vec3(0.94), (lnW(abs(v) - 0.9, 0.04) + lnW(v, 0.03)) * fine);
            c = mix(c, vec3(0.94), lnW(mod(s, 100.0) - 50.0, 0.12) * fine);
          } else {
            // stairs: stone treads with dark nosings
            float tr = fract(s / 0.32);
            c = vec3(0.72, 0.68, 0.6) * mix(1.0, 0.7 + 0.3 * smoothstep(0.0, 0.15, tr), fine);
          }
          // kerb along both edges
          c = mix(c, c * 0.72, smoothstep(0.84, 0.92, abs(v)) * (step(k, 4.5) + step(5.5, k) * step(k, 6.5)));
          diffuseColor.rgb = c;
        }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += vec3(1.0, 0.8, 0.55) * uNight * (0.035 + 0.08 * vWalk.z);`);
    };
    const mesh = new THREE.Mesh(builderGeometry(W, { aWalk: 4 }), mat);
    mesh.receiveShadow = true; mesh.renderOrder = 0.5; mesh.name = 'walkways';
    group.add(mesh);
  }

  // ------------------------------------------------------------ shade sails over the busiest promenades
  {
    const pos = [], col = [], idx = [], post = []; let v = 0;
    const SAIL = [new THREE.Color('#f6f3ea'), new THREE.Color('#ece2cc'), new THREE.Color('#f6f3ea'), new THREE.Color('#d9e7e8')];
    let count = 0;
    for (const p of walks) {
      if (p.k !== 1 || (p.l || 0) < 0.8 || p.w < 4) continue;
      const pts = p.p; let acc = 6, ci = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
        const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy, ny = ux;
        for (let s = acc; s < L - 4; s += 21) {
          const cx = a[0] + ux * s, cy = a[1] + uy * s, hl = 4.6, hw = p.w / 2 + 0.6;
          const C = [[-hl, -hw, 4.3], [hl, -hw, 3.3], [hl, hw, 4.3], [-hl, hw, 3.3]].map(([lu, lv, h]) => [cx + ux * lu + nx * lv, h, -(cy + uy * lu + ny * lv)]);
          const N = 3, k = SAIL[ci++ % 4];
          const lerp = (p0, p1, t) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];
          const at = (s2, t2) => lerp(lerp(C[0], C[1], s2), lerp(C[3], C[2], s2), t2);
          for (let ia = 0; ia < N; ia++) for (let ib = 0; ib < N; ib++) {
            const q = [at(ia / N, ib / N), at((ia + 1) / N, ib / N), at((ia + 1) / N, (ib + 1) / N), at(ia / N, (ib + 1) / N)];
            for (const vv of q) { pos.push(...vv); col.push(k.r, k.g, k.b); }
            idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
          }
          for (const c of C) post.push([c[0], c[2], c[1] + 0.3]);
          count++;
        }
        acc = ((acc - L) % 21 + 21) % 21;
      }
    }
    if (idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }));
      m.castShadow = true; m.receiveShadow = true; m.name = 'promenade-sails'; group.add(m);
      const pg = new THREE.CylinderGeometry(0.06, 0.08, 1, 6).translate(0, 0.5, 0);
      const pm = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: '#c9cdd1', roughness: 0.4, metalness: 0.6 }), post.length);
      const m4 = new THREE.Matrix4();
      post.forEach(([x, z, h], i) => { m4.makeScale(1, h, 1).setPosition(x, 0, z); pm.setMatrixAt(i, m4); });
      pm.castShadow = true; pm.name = 'sail-masts'; group.add(pm);
    }
    void count;
  }

  // ------------------------------------------------------------ painted cycle lanes on roads
  if ((data.bikeLanes || []).length) {
    const Bk = newBuilder();
    for (const l of data.bikeLanes) addRibbon(Bk, l.p, l.w, 0.13, null);
    const m = new THREE.Mesh(builderGeometry(Bk), new THREE.MeshStandardMaterial({ color: '#7f2a1e', roughness: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    m.renderOrder = 1.5; m.name = 'bike-lanes'; group.add(m);
  }

  // ------------------------------------------------------------ promenade lanterns (+ light pools at night)
  const lamps = (data.amenities && data.amenities.plamps) || [];
  if (lamps.length) {
    const pole = new THREE.CylinderGeometry(0.05, 0.08, 4.2, 6).translate(0, 2.1, 0);
    const head = new THREE.CylinderGeometry(0.2, 0.14, 0.55, 6).translate(0, 4.45, 0);
    const cap = new THREE.ConeGeometry(0.26, 0.22, 6).translate(0, 4.83, 0);
    const parts = [[pole, '#3b3f44', 0], [head, '#fff1cf', 1], [cap, '#3b3f44', 0]].map(([g, colr, lit]) => {
      const gg = g.toNonIndexed(); const n = gg.attributes.position.count; const c = new THREE.Color(colr);
      gg.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n).fill(0).flatMap(() => [c.r, c.g, c.b]), 3));
      gg.setAttribute('aLit', new THREE.Float32BufferAttribute(new Array(n).fill(lit), 1));
      gg.deleteAttribute('uv'); return gg;
    });
    const merge = (list) => {
      const out = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'color', 'aLit']) {
        const size = list[0].attributes[name].itemSize; const arr = [];
        for (const g of list) arr.push(...g.attributes[name].array);
        out.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
      }
      return out;
    };
    const geo = merge(parts);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 });
    mat.onBeforeCompile = (s) => {
      s.uniforms.uNight = uNight;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aLit; varying float vLit;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLit = aLit;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying float vLit;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.8, 0.52) * vLit * uNight * 4.0;');
    };
    const im = new THREE.InstancedMesh(geo, mat, lamps.length);
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    lamps.forEach((l, i) => { p.set(l[0], 0, -l[1]); m4.compose(p, q, one); im.setMatrixAt(i, m4); });
    im.castShadow = true; im.name = 'promenade-lamps';
    group.add(im);
    const pool = new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2);
    const pmat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uNight },
      vertexShader: 'varying vec2 vU; void main(){ vU = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uNight; varying vec2 vU; void main(){ float r = length(vU); float a = pow(max(0.0, 1.0 - r), 2.0) * uNight; gl_FragColor = vec4(vec3(1.0, 0.8, 0.52) * a * 0.32, 1.0); }',
    });
    const pools = new THREE.InstancedMesh(pool, pmat, lamps.length);
    lamps.forEach((l, i) => { p.set(l[0], 0.22, -l[1]); m4.compose(p, q, one); pools.setMatrixAt(i, m4); });
    pools.renderOrder = 4; pools.frustumCulled = false; pools.name = 'promenade-light';
    ctx.on('time', (s) => { pools.visible = s.night > 0.02; });
    group.add(pools);
  }

  // ------------------------------------------------------------ kerbs, gutters, footways and driveway aprons
  // From the kerb lines the data build traces round the carriageways of a researched neighbourhood
  // (scripts/lib/street-kit.mjs). On the road side of each kerb runs a strip carrying the gutter (light concrete,
  // or a buff paver band on paver streets), the yellow or white edge line, and the asphalt or pavers that fill the
  // rounded corners of the junctions. Then come the kerb's face and top, and the footway (grey pavers between buff
  // bands) or the planted verge, all dropping where a driveway crosses. Paver aprons run from each drive to its
  // dropped kerb.
  const kerbs = data.kerbs || [], aprons = data.aprons || [];
  if (kerbs.length || aprons.length) {
    const pos = [], nor = [], uv = [], kd = [], idx = []; let v = 0;
    // kd = [kind, surface, line colour, footway width]; kind 0 road strip, 1 kerb concrete, 2 footway, 3 edging, 4 apron
    const vert = (x, y, h, n, u, w, k) => { pos.push(x, h, -y); nor.push(n[0], n[1], -n[2]); uv.push(u, w); kd.push(k[0], k[1], k[2], k[3]); return v++; };
    const UP = [0, 1, 0];
    // a strip along a polyline: per vertex a point, an offset direction, two offsets and heights; vertical when the
    // offsets are equal and the heights differ
    const strip = (P, D, o0, o1, h0, h1, S, v0, v1, k, n) => {
      let prev = -1;
      for (let i = 0; i < P.length; i++) {
        const nn = typeof n === 'function' ? n(i) : n;
        const a = vert(P[i][0] + D[i][0] * o0(i), P[i][1] + D[i][1] * o0(i), h0(i), nn, S[i], v0(i), k);
        vert(P[i][0] + D[i][0] * o1(i), P[i][1] + D[i][1] * o1(i), h1(i), nn, S[i], v1(i), k);
        if (prev >= 0) idx.push(prev, prev + 1, a + 1, prev, a + 1, a);
        prev = a;
      }
    };
    const yS = 0.1, KT = 0.18;
    for (const kb of kerbs) {
      const P = kb.p, n = P.length; if (n < 2) continue;
      const N = [], S = [0], Nh = [];
      for (let i = 0; i < n; i++) {
        const a = P[Math.max(0, i - 1)], b = P[i], c = P[Math.min(n - 1, i + 1)];
        let d0x = b[0] - a[0], d0y = b[1] - a[1], d1x = c[0] - b[0], d1y = c[1] - b[1];
        const l0 = Math.hypot(d0x, d0y) || 1, l1 = Math.hypot(d1x, d1y) || 1; d0x /= l0; d0y /= l0; d1x /= l1; d1y /= l1;
        if (i === 0) { d0x = d1x; d0y = d1y; }
        if (i === n - 1) { d1x = d0x; d1y = d0y; }
        let mx = d0y + d1y, my = -d0x - d1x; const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml; // away from the road
        const k = 1 / Math.max(0.5, mx * d1y - my * d1x);
        N.push([mx * k, my * k]); Nh.push([mx, 0, my]);
        if (i) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
      }
      const f = (i) => kb.f[i] || 0.8, d = (i) => kb.d[i] || 0;
      const yK = (i) => 0.22 - 0.105 * d(i), yF = (i) => 0.2 - 0.085 * d(i);
      const K0 = [0, kb.s, kb.c, kb.fw], K1 = [1, kb.s, 0, kb.fw], K2 = [2, kb.s, kb.fs || 0, kb.fw], K3 = [3, kb.s, kb.fs || 0, kb.fw];
      const zero = () => 0, cst = (x) => () => x;
      // road side: from the fill's inner edge up to the kerb (v = metres from the kerb)
      strip(P, N, (i) => -f(i), zero, cst(yS), cst(yS), S, f, zero, K0, UP);
      // the kerb's face (towards the road) and top
      strip(P, N, zero, zero, cst(yS), yK, S, zero, (i) => yK(i) - yS, K1, (i) => [-Nh[i][0], 0, -Nh[i][2]]);
      strip(P, N, zero, cst(KT), yK, yK, S, zero, cst(KT), K1, UP);
      if (kb.fw > 0) {
        strip(P, N, cst(KT), cst(KT + kb.fw), yF, yF, S, zero, cst(kb.fw), K2, UP);
        strip(P, N, cst(KT + kb.fw), cst(KT + kb.fw), yF, zero, S, zero, yF, K3, (i) => Nh[i]);
      } else strip(P, N, cst(KT), cst(KT), yK, zero, S, zero, yK, K1, (i) => Nh[i]);
    }
    // driveway aprons: the last metres of each drive, flaring at the dropped kerb
    for (const [ax, ay, kx, ky, w, tone] of aprons) {
      const L = Math.hypot(kx - ax, ky - ay); if (L < 0.5) continue;
      const ux = (kx - ax) / L, uy = (ky - ay) / L, nx = -uy, ny = ux, len = Math.min(L, 8.5);
      const sx = kx - ux * len, sy = ky - uy * len, fl = Math.min(1.3, len * 0.3);
      const rows = [[0, w / 2, 0.1], [len - fl, w / 2, 0.122], [len, w / 2 + 1.1, 0.125]];
      let prev = -1;
      for (const [t, hw, h] of rows) {
        const cx = sx + ux * t, cy = sy + uy * t;
        const a = vert(cx + nx * hw, cy + ny * hw, h, UP, t, 0, [4, tone || 0, 0, w]);
        vert(cx - nx * hw, cy - ny * hw, h, UP, t, 2 * hw, [4, tone || 0, 0, w]);
        if (prev >= 0) idx.push(prev, prev + 1, a, prev + 1, a + 1, a); // counter-clockwise seen from above
        prev = a;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aKd', new THREE.Float32BufferAttribute(kd, 4));
    g.setIndex(idx);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide });
    mat.onBeforeCompile = (s) => {
      s.uniforms.uNight = uNight;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aKd; varying vec4 vKd; varying vec2 vKUv; varying vec3 vKWP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvKd = aKd; vKUv = uv; vKWP = (modelMatrix * vec4(position, 1.0)).xyz;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
        uniform float uNight; varying vec4 vKd; varying vec2 vKUv; varying vec3 vKWP;
        ${GLSL_NOISE}
        ${STREET_SURFACE}
        // running-bond pavers along the strip: brightness per paver, darker joints when close enough to see
        float pav(vec2 q, vec2 size, float fine) {
          vec2 g = q / size; g.x += 0.5 * mod(floor(g.y), 2.0); vec2 f = fract(g);
          float j = smoothstep(0.0, 0.08, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
          return (0.93 + 0.12 * hash12(floor(g))) * mix(1.0, 0.82 + 0.18 * j, fine);
        }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float kind = floor(vKd.x + 0.5), surf = vKd.y, lc = vKd.z, fw = vKd.w;
          float s = vKUv.x, v = vKUv.y;
          float fine = 1.0 - smoothstep(0.03, 0.12, fwidth(s));
          vec3 c;
          if (kind < 0.5) {
            c = streetSurface(vKWP.xz, surf + 1.0, fine);
            if (surf > 0.5) {
              // buff band of two paver rows along the kerb
              c = mix(c, vec3(0.62, 0.5, 0.34) * pav(vec2(s, v), vec2(0.2, 0.2), fine), step(v, 0.4));
            } else {
              c = mix(c, vec3(0.56, 0.55, 0.52) * (0.95 + 0.06 * vnoise(vKWP.xz * 3.0)), step(v, 0.3)); // concrete gutter
            }
            float lo = surf > 0.5 ? 0.5 : 0.42, aa = max(fwidth(v), 1e-3);
            float line = smoothstep(lo - aa, lo + aa, v) * (1.0 - smoothstep(lo + 0.15 - aa, lo + 0.15 + aa, v));
            vec3 paint = lc > 1.5 ? vec3(0.86, 0.86, 0.84) : vec3(0.85, 0.55, 0.05);
            c = mix(c, paint, line * step(0.5, lc) * 0.92);
          } else if (kind < 1.5) {
            c = vec3(0.62, 0.61, 0.58) * (0.94 + 0.08 * vnoise(vKWP.xz * 2.0));
          } else if (kind < 2.5) {
            if (lc > 0.5) {
              // Emirates Hills: a strip of red clay pavers in running bond along the kerb
              c = vec3(0.42, 0.14, 0.08) * pav(vec2(s, v), vec2(0.2, 0.1), fine);
            } else {
              // footway: grey pavers between buff bands
              c = vec3(0.42, 0.45, 0.47) * pav(vec2(s, v), vec2(0.2, 0.1), fine);
              c = mix(c, vec3(0.6, 0.5, 0.36) * pav(vec2(s, v), vec2(0.2, 0.2), fine), step(v, 0.2) + step(fw - 0.2, v));
            }
          } else if (kind < 3.5) {
            c = vec3(0.55, 0.47, 0.35);
          } else {
            // driveway apron: sand (or grey-beige) pavers with a buff border
            c = mix(vec3(0.6, 0.5, 0.39), vec3(0.47, 0.44, 0.39), surf) * pav(vec2(s, v), vec2(0.2, 0.1), fine);
            c = mix(c, vec3(0.66, 0.56, 0.42) * pav(vec2(s, v), vec2(0.2, 0.2), fine), step(v, 0.25) + step(fw - 0.25, v));
          }
          diffuseColor.rgb = c;
        }`);
    };
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true; mesh.name = 'kerbs';
    group.add(mesh);
  }

  // ------------------------------------------------------------ bike-share docks (rows of bikes on a rail)
  const docks = (data.amenities && data.amenities.bikeDocks) || [];
  if (docks.length) {
    const pos = [], col = [], idx = []; let v = 0;
    const C = (h) => new THREE.Color(h);
    const frame = C('#18a87c'), tyre = C('#232629'), rail = C('#9aa1a7'), kiosk = C('#0f6e57');
    const boxAt = (cx, cy, a, L, Wd, y0, y1, k) => {
      const ca = Math.cos(a), sa = Math.sin(a);
      const P = (i, j, y) => [cx + ca * i * L / 2 - sa * j * Wd / 2, y, -(cy + sa * i * L / 2 + ca * j * Wd / 2)];
      const b = [P(-1, -1, y0), P(1, -1, y0), P(1, 1, y0), P(-1, 1, y0)], t = [P(-1, -1, y1), P(1, -1, y1), P(1, 1, y1), P(-1, 1, y1)];
      const quad = (a0, a1, a2, a3) => { pos.push(...a0, ...a1, ...a2, ...a3); for (let i = 0; i < 4; i++) col.push(k.r, k.g, k.b); idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4; };
      quad(t[0], t[1], t[2], t[3]);
      for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(b[i], b[j], t[j], t[i]); }
    };
    for (const [x, y, a, n] of docks) {
      const ca = Math.cos(a), sa = Math.sin(a);
      boxAt(x, y, a, n * 0.75 + 0.6, 0.12, 0, 0.75, rail);
      boxAt(x - ca * (n * 0.375 + 0.9), y - sa * (n * 0.375 + 0.9), a, 0.6, 0.5, 0, 2.1, kiosk);
      for (let i = 0; i < n; i++) {
        const o = (i - (n - 1) / 2) * 0.75, bx = x + ca * o - sa * 0.9, by = y + sa * o + ca * 0.9, ba = a + Math.PI / 2;
        boxAt(bx, by, ba, 1.7, 0.06, 0.08, 0.7, tyre);      // wheels seen edge-on
        boxAt(bx, by, ba, 1.1, 0.08, 0.7, 0.95, frame);     // frame and basket
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }));
    m.castShadow = true; m.name = 'bike-docks'; group.add(m);
  }
  return { group };
}
