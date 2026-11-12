import * as THREE from 'three';
import { GLSL_NOISE, polygonsGeometry, signedArea, pointInPoly, newBuilder, addRibbon, builderGeometry } from '../core/util.js';
import { obb } from './house-specs.js';

export const SEA_Y = -0.8;
// linear colour of the bright beach sand as seen under very shallow water (matches the beach paint)
const CAUSTICS = `
  const vec3 SAND_BOTTOM = vec3(0.84, 0.76, 0.56);
  vec2 cH22(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
  float causticWeb(vec2 p, float t) {
    vec2 i = floor(p), f = fract(p); float F1 = 8.0, F2 = 8.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y)); vec2 o = cH22(i + g);
      o = 0.5 + 0.42 * sin(t * 0.7 + 6.2831 * o);
      float dd = length(g + o - f);
      if (dd < F1) { F2 = F1; F1 = dd; } else if (dd < F2) { F2 = dd; }
    }
    return 1.0 - smoothstep(0.0, 0.11, F2 - F1);
  }
  // wavy, knotted caustics: two warped webs whose crossings glow brightest, brightness varying in patches
  float causticNet(vec2 p, float t) {
    vec2 w = vec2(sin(p.y * 1.7 + t * 0.6) + sin(p.y * 0.7 - t * 0.3), sin(p.x * 1.5 - t * 0.5) + sin(p.x * 0.6 + t * 0.4)) * 0.16;
    float a = causticWeb(p + w, t);
    float b = causticWeb(mat2(0.8, -0.6, 0.6, 0.8) * (p * 1.37 + 3.1) - w * 1.3, t * 1.21);
    float patchy = 0.55 + 0.45 * sin(p.x * 0.31 + t * 0.2) * sin(p.y * 0.27 - t * 0.17);
    return clamp((a * 0.62 + b * 0.38 + a * b * 0.9) * patchy, 0.0, 1.2);
  }`;

// Swimming pool water, shared by the public pools here and the villa pools (layers/details.js). Seen from above a
// pool is its floor through moving water: a pale shallow end with steps sloping to a deeper blue end, mosaic joints,
// a band of darker waterline tiles round the edge, lane lines on the long pools, and a bright web of caustics
// sliding over everything; it glows by day so it stays turquoise in shadow, and is lit from below at night.
// Geometry carries aPool = (metres along the pool, metres across, length, width); a negative width marks a pool that
// is not a plain rectangle (no edge band, steps or lanes: its edges are not known from those two numbers).
export function makePoolMaterial(ctx) {
  const uTime = { value: 0 }, uNight = { value: 0 };
  ctx.updaters.push((dt, t) => { uTime.value = t; });
  ctx.on('time', (s) => { uNight.value = s.night; });
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.07, metalness: 0 });
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, { uTime, uNight });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aPool; varying vec4 vPool; varying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPool = aPool; vWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime, uNight; varying vec4 vPool; varying vec3 vWPos;\n${GLSL_NOISE}\n${CAUSTICS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 p = vWPos.xz; float t = uTime;
          float L = max(vPool.z, 1.0), W = abs(vPool.w), u = vPool.x, v = vPool.y, rect = step(0.0, vPool.w);
          float px = length(fwidth(p)), fine = 1.0 - smoothstep(0.05, 0.22, px), mid = 1.0 - smoothstep(0.25, 1.1, px);
          // the surface's wobble bends everything seen through it
          vec2 wob = vec2(vnoise(p * 0.9 + t * 0.35), vnoise(p * 0.9 - t * 0.3 + 7.0)) - 0.5;
          vec2 fp = p + wob * 0.24;
          float uw = u + wob.x * 0.24, vw = v + wob.y * 0.24;
          // shallow end to deep end
          vec3 wc = mix(vec3(0.42, 0.9, 0.9), vec3(0.03, 0.47, 0.76), smoothstep(0.1, 0.85, uw / L));
          // steps down from the shallow end
          float stepsOn = rect * step(7.0, L);
          float sk = clamp(floor((1.8 - uw) / 0.6) + 1.0, 0.0, 3.0) * stepsOn;
          wc = mix(wc, vec3(0.8, 0.98, 0.96), 0.2 * sk);
          wc *= 1.0 - 0.1 * stepsOn * mid * (1.0 - smoothstep(0.0, 0.07, abs(fract(uw / 0.6) - 0.5) - 0.44)) * step(uw, 1.8);
          // mosaic joints
          vec2 tq = fract(fp / 0.5);
          wc *= mix(1.0, 0.89 + 0.11 * smoothstep(0.0, 0.1, min(min(tq.x, 1.0 - tq.x), min(tq.y, 1.0 - tq.y))), fine);
          // lane lines along the long pools
          float lanes = rect * step(22.0, L) * step(7.0, W) * step(2.5, uw) * step(uw, L - 2.5);
          float ld = abs(fract(vw / 2.5 + 0.5) - 0.5) * 2.5;
          wc = mix(wc, vec3(0.02, 0.2, 0.55), lanes * (1.0 - smoothstep(0.1, 0.17, ld)) * mid);
          // the band of darker waterline tiles
          float e = min(min(u, L - u), min(v, W - v));
          float rim = rect * (1.0 - smoothstep(0.24, 0.32, e)) * mid;
          wc = mix(wc, vec3(0.04, 0.34, 0.66) * (0.8 + 0.4 * step(0.5, fract((u + v) / 0.7))), rim);
          // caustics
          float cs = causticNet(fp * 0.85, t * 1.4);
          wc += vec3(0.78, 1.0, 0.96) * cs * 0.5 * mid;
          diffuseColor.rgb = wc;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz, wv = uTime * vec2(0.5, 0.3);
          float r0 = vnoise(p * 2.3 + wv), rx = vnoise((p + vec2(0.2, 0.0)) * 2.3 + wv), rz = vnoise((p + vec2(0.0, 0.2)) * 2.3 + wv);
          normal = normalize((viewMatrix * vec4(normalize(vec3(-(rx - r0) * 0.5, 1.0, -(rz - r0) * 0.5)), 0.0)).xyz);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * mix(0.3, 0.6, uNight);`);
  };
  if (ctx.env) ctx.env.addReflective(mat, 0.5);
  return mat;
}

const AREA_COLORS = {
  residential: '#d8d0c2', commercial: '#d4cdc1', industrial: '#cdc6ba', construction: '#d8c296',
  parking: '#8e8f90', plaza: '#e3d9c6', island: '#e0cca5',
  golf: '#56963b', rough: '#528d38', park: '#5c9c3c', grass: '#64a341', wood: '#44843a',
  fairway: '#66a945', golfgreen: '#7fc057', bunker: '#f0e0b0', pitch: '#4a9a43',
  beach: '#efe3c6', sand: '#e8d4a6',
};
const LAND = '#e2cfa6';
function mulberry(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function buildGround(ctx, env) {
  const { data, bounds: B, scene } = ctx;
  const group = new THREE.Group(); group.name = 'ground';
  scene.add(group);

  const landPolys = data.land.map((p) => p.map((r, i) => ((i === 0) === (signedArea(r) > 0) ? r : r.slice().reverse())));

  // ------------------------------------------------------------------ land colour texture + surface class map
  // A low-res base painting of the whole map (always resident) plus sharp detail tiles painted on demand
  // around the camera into a fixed pool (texture array + an indirection grid). Ground memory therefore
  // stays flat however much of Dubai the map covers; zooming in sharpens the tiles in view.
  const maxTex = Math.min(ctx.renderer.capabilities.maxTextureSize, 4096);
  const TM = 16;                                   // metres of overlap painted around every tile
  const DT = 1024, DD = 0.82;                      // detail tile size (px) and density (texels per metre)
  const DS = DT / DD - 2 * TM;                     // detail tile core (m)
  const gnx = Math.max(1, Math.ceil(B.w / DS)), gny = Math.max(1, Math.ceil(B.h / DS));
  const SLOTS = Math.min(gnx * gny, 22);
  const KS = 0.5;                                  // class map at half resolution
  // current paint target: canvas contexts, sizes, texels per metre, west/north edge, culling window
  let g = null, k = null, cw = 0, ch = 0, kw = 0, kh = 0, sx = 1, sy = 1, ox = 0, oy = 0;
  const win = [0, 0, 0, 0];
  const tx = (x) => (x - ox) * sx, ty = (y) => (oy - y) * sy;
  const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const both = (fn) => { fn(g, 1); k.save(); k.scale(KS, KS); fn(k, KS); k.restore(); };
  // bounding boxes (cached) so each tile only draws what overlaps it
  const bbCache = new WeakMap();
  const bbPts = (key, pts) => {
    let bb = bbCache.get(key);
    if (!bb) { bb = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of pts) { if (p[0] < bb[0]) bb[0] = p[0]; if (p[1] < bb[1]) bb[1] = p[1]; if (p[0] > bb[2]) bb[2] = p[0]; if (p[1] > bb[3]) bb[3] = p[1]; } bbCache.set(key, bb); }
    return bb;
  };
  const inWin = (bb, pad = 0) => bb[2] + pad >= win[0] && bb[0] - pad <= win[2] && bb[3] + pad >= win[1] && bb[1] - pad <= win[3];
  const tracePoly = (c, poly) => {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) { const p = ring[i]; if (i) c.lineTo(tx(p[0]), ty(p[1])); else c.moveTo(tx(p[0]), ty(p[1])); }
      c.closePath();
    }
  };
  const clsCol = (cls) => `rgb(${cls * 16},0,0)`;
  const fill = (list, color, cls) => {
    if (!list || !list.length) return;
    const vis = list.filter((p) => inWin(bbPts(p, p[0])));
    if (!vis.length) return;
    both((c, sc) => { c.fillStyle = sc === 1 ? color : clsCol(cls); c.beginPath(); for (const p of vis) tracePoly(c, p); c.fill('nonzero'); });
  };
  const strokeLines = (lines, color, widthFn, cls, colourOnly = false) => {
    const vis = lines.filter((l) => inWin(bbPts(l, l.p), widthFn(l)));
    if (!vis.length) return;
    (colourOnly ? (fn) => fn(g, 1) : both)((c, sc) => {
      c.strokeStyle = sc === 1 ? color : clsCol(cls); c.lineCap = 'round'; c.lineJoin = 'round';
      for (const l of vis) {
        c.lineWidth = Math.max(1, widthFn(l) * sx);
        c.beginPath(); l.p.forEach((p, i) => (i ? c.lineTo(tx(p[0]), ty(p[1])) : c.moveTo(tx(p[0]), ty(p[1])))); c.stroke();
      }
    });
  };
  // Flower beds and clipped hedges along lawn edges: the colour painting's alpha is lowered in a band inside the
  // edge and the land shader plants the band procedurally (sharp at any zoom); anything painted later covers it.
  // bedPolys: a band of the given width inside polygons; bedLines: a stroke of that width (the caller repaints its
  // middle, leaving bands at its edges).
  const bedPolys = (list, band) => {
    const vis = (list || []).filter((p) => inWin(bbPts(p, p[0]), band));
    if (!vis.length) return;
    g.save();
    g.beginPath(); for (const p of vis) tracePoly(g, p); g.clip();
    g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 0.6; g.lineJoin = 'round';
    g.lineWidth = Math.max(1, 2 * band * sx);
    g.beginPath(); for (const p of vis) tracePoly(g, p); g.stroke();
    g.restore();
  };
  const bedLines = (lines, width) => {
    const vis = lines.filter((l) => inWin(bbPts(l, l.p), width));
    if (!vis.length) return;
    g.save();
    g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 0.6; g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = Math.max(1, width * sx);
    for (const l of vis) { g.beginPath(); l.p.forEach((p, i) => (i ? g.lineTo(tx(p[0]), ty(p[1])) : g.moveTo(tx(p[0]), ty(p[1])))); g.stroke(); }
    g.restore();
  };
  // 2026 vegetation (Sentinel-2 NDVI, 19 Oct 2026), prepared once and drawn into every painting
  let ndviCol = null, ndviMsk = null, ns = 1;
  if (ctx.ndvi && data.meta.ndvi) {
    const N = data.meta.ndvi;
    // a big map keeps the canvases at Sentinel-2's native 10 m (the 5 m grid is an upsampling anyway)
    ns = N.w * N.h > 8e6 ? 0.5 : 1;
    const W2 = Math.round(N.w * ns), H2 = Math.round(N.h * ns);
    ndviCol = mkCanvas(W2, H2); ndviMsk = mkCanvas(W2, H2);
    const scratch = mkCanvas(W2, H2), o = scratch.getContext('2d', { willReadFrequently: true });
    o.imageSmoothingQuality = 'high';
    o.drawImage(ctx.ndvi, 0, 0, W2, H2);
    const src = o.getImageData(0, 0, W2, H2), col = o.createImageData(W2, H2), msk = o.createImageData(W2, H2);
    const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const DRY = [160, 170, 100], LAWN = [96, 158, 62], DENSE = [76, 138, 50];
    for (let i = 0; i < W2 * H2; i++) {
      const nd = (src.data[i * 4] / 255) * 0.9 - 0.1;
      const t1 = ss(0.2, 0.42, nd), t2 = ss(0.46, 0.7, nd);
      for (let c = 0; c < 3; c++) {
        const v = DRY[c] + (LAWN[c] - DRY[c]) * t1;
        col.data[i * 4 + c] = v + (DENSE[c] - v) * t2;
      }
      col.data[i * 4 + 3] = 238 * ss(0.16, 0.38, nd);
      msk.data[i * 4] = 96; msk.data[i * 4 + 3] = nd > 0.3 ? 255 : 0; // class 6 (grass) where clearly planted
    }
    ndviCol.getContext('2d').putImageData(col, 0, 0);
    ndviMsk.getContext('2d').putImageData(msk, 0, 0);
    scratch.width = scratch.height = 1;
    ctx.ndvi = null; // the decoded image is no longer needed
  }
  // ---- everything the painter draws, prepared once
  const A = data.areas;
  // ---- rock shores (breakwater areas). The shoreline's segments by 60 m row give a quick land-or-water test; each
  // rock area's edges are sorted into those backed by land (the walk side: a kerb) and those facing the water, and
  // the stretch of shoreline beside it is kept for cutting the land away under the rock.
  const RCELL = 60, landRows = new Map();
  for (const poly of landPolys) for (const ring of poly) for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length];
    for (let j = Math.floor(Math.min(a[1], b[1]) / RCELL); j <= Math.floor(Math.max(a[1], b[1]) / RCELL); j++) { let r = landRows.get(j); if (!r) landRows.set(j, (r = [])); r.push(a, b); }
  }
  const onLand = (x, y) => {
    const row = landRows.get(Math.floor(y / RCELL)); if (!row) return false;
    let inside = false;
    for (let k = 0; k < row.length; k += 2) { const a = row[k], b = row[k + 1]; if ((a[1] > y) !== (b[1] > y) && x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside; }
    return inside;
  };
  const rockInfo = new Map(); // rock area -> { edges: [{ a, b, nx, ny, land }] per ring, coast: [a, b, ...] }
  for (const poly of A.breakwater || []) {
    const rings = poly.map((ring) => {
      const out = signedArea(ring) > 0 ? 1 : -1; // outward is to the right of a counter-clockwise ring
      return ring.map((a, k) => {
        const b = ring[(k + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
        const nx = (dy / L) * out, ny = (-dx / L) * out, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        return { a, b, nx, ny, land: L > 0.05 && onLand(mx + nx * 2.5, my + ny * 2.5) && onLand(mx + nx * 6.5, my + ny * 6.5) };
      });
    });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of poly[0]) { if (v[0] < x0) x0 = v[0]; if (v[0] > x1) x1 = v[0]; if (v[1] < y0) y0 = v[1]; if (v[1] > y1) y1 = v[1]; }
    const coast = [];
    for (let j = Math.floor((y0 - 10) / RCELL); j <= Math.floor((y1 + 10) / RCELL); j++) {
      const row = landRows.get(j); if (!row) continue;
      for (let k = 0; k < row.length; k += 2) { const a = row[k], b = row[k + 1]; if (Math.max(a[0], b[0]) > x0 - 10 && Math.min(a[0], b[0]) < x1 + 10 && Math.max(a[1], b[1]) > y0 - 10 && Math.min(a[1], b[1]) < y1 + 10) coast.push(a, b); }
    }
    rockInfo.set(poly, { rings, coast });
  }
  const towerRings = data.buildings.filter((b) => b.h > 28 && !b.v && b.d !== 'industrial').map((b) => ({ p: b.p[0].concat([b.p[0][0]]) }));
  const lakeRings = (data.lakeWalks || []).flatMap((poly) => poly.map((r) => ({ p: r.concat([r[0]]) })));
  const burjRings = (data.burjWalk || []).map((r) => ({ p: r.concat([r[0]]) }));
  const groundRoads = data.roads.filter((r) => !r.b);
  const VERGE = new Set(['primary', 'secondary', 'trunk', 'tertiary', 'primary_link', 'secondary_link']);
  const vergeRoads = groundRoads.filter((r) => VERGE.has(r.k));
  const sideRoads = groundRoads.filter((r) => r.k !== 'motorway' && r.k !== 'motorway_link' && !r.s);
  const kitRoads = groundRoads.filter((r) => r.s); // kerbed streets: footways are geometry, verges are planted
  const motorRoads = groundRoads.filter((r) => r.k === 'motorway' || r.k === 'motorway_link');
  const LAWNS = ['#5f9e3e', '#66a542', '#5a993b', '#6caa47', '#62a140'];
  const LOT_BASE = ['#7d7e80', '#cfc8bb', '#d4cec3', '#7a7b7d'], LOT_CLS = [4, 5, 5, 4];
  const PAD = ['#76777a', '#9b5e47', '#c4bdb1', '#717274'], PAD_CLS = [4, 13, 5, 4];
  const lotsByStyle = [[], [], [], []]; for (const lot of data.lots || []) lotsByStyle[lot.s].push(lot.p);
  // the streamed sections' own ground: villa lawns, driveways and pool decks, walkways, parking bays
  const SECS = new Map(); // section id -> paint lists (+ bbox)
  function sectionLists(sd, rects) {
    const walkPaths = (sd.paths || []).filter((p) => p.k !== 'breakwater' && !p.h);
    const lawnGroups = LAWNS.map(() => []);
    { const rr = mulberry(5); for (const pl of sd.plots || []) lawnGroups[Math.floor(rr() * LAWNS.length)].push([pl.p]); }
    const red = (pl) => (sd.buildings[pl.b] || {}).d === 'springs';
    const drive = (pl) => ({ p: [[pl.dr[0], pl.dr[1]], [pl.dr[2], pl.dr[3]]], w: pl.dr[4] });
    const plots = sd.plots || [];
    const drives = plots.filter((pl) => pl.dr && !red(pl)).map(drive), drivesRed = plots.filter((pl) => pl.dr && red(pl)).map(drive);
    // Emirates Hills forecourts before the porte-cocheres
    const courts = plots.filter((pl) => pl.fc).map((pl) => {
      const [x, y, a, Lf, Wf] = pl.fc, c = Math.cos(a), s = Math.sin(a);
      return [[[-Lf / 2, -Wf / 2], [Lf / 2, -Wf / 2], [Lf / 2, Wf / 2], [-Lf / 2, Wf / 2]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c])];
    });
    const decks = plots.filter((pl) => pl.pool).map((pl) => {
      const [x, y, a, Lp, Wp] = pl.pool, c = Math.cos(a), s = Math.sin(a), L2 = Lp / 2 + 2.4, W2 = Wp / 2 + 2.2;
      return [[[-L2, -W2], [L2, -W2], [L2, W2], [-L2, W2]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c])];
    });
    const baysByStyle = [[], [], [], []];
    for (const [x, y, a, st] of sd.bays || []) {
      const c = Math.cos(a), sn = Math.sin(a), hd = 2.65, hw = 1.25;
      baysByStyle[st].push([[[-hd, -hw], [hd, -hw], [hd, hw], [-hd, hw]].map(([u, v]) => [x + u * c - v * sn, y + u * sn + v * c])]);
    }
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of rects) { bb[0] = Math.min(bb[0], q[0]); bb[1] = Math.min(bb[1], q[1]); bb[2] = Math.max(bb[2], q[2]); bb[3] = Math.max(bb[3], q[3]); }
    const roofs = (sd.buildings || []).map((b) => [b.p[0]]);
    return { walkPaths, lawnGroups, drives, drivesRed, decks, courts, baysByStyle, roofs, bb };
  }

  // classes: 0 sand, 1 urban, 2 industrial, 3 dirt, 4 asphalt, 5 paving, 6 grass, 7 fairway, 8 rough, 9 green, 10 beach, 11 wood, 12 pitch, 13 pavers, 14 deck
  const paint = () => {
    // features are clipped to their section (plus a margin for what pokes over the edge)
    const secs = [...SECS.values()].filter((L) => inWin(L.bb, 80));
    g.fillStyle = LAND; g.fillRect(0, 0, cw, ch);
    k.fillStyle = clsCol(0); k.fillRect(0, 0, kw, kh);
    // JLT: plazas and forecourts are paved between the cluster podiums (Esri imagery, Oct 2026)
    if (data.zones && data.zones.jlt) fill(data.zones.jlt, '#d8d0c1', 5);
    fill(A.residential, AREA_COLORS.residential, 1); fill(A.commercial, AREA_COLORS.commercial, 1); fill(A.island, AREA_COLORS.island, 0);
    fill(A.industrial, AREA_COLORS.industrial, 2); fill(A.construction, AREA_COLORS.construction, 3);
    // tyre tracks on construction sites
    const sites = (A.construction || []).filter((p) => inWin(bbPts(p, p[0]), 260));
    if (sites.length) {
      g.save(); g.beginPath(); for (const p of sites) tracePoly(g, p); g.clip();
      g.strokeStyle = 'rgba(120,96,66,0.28)'; g.lineWidth = Math.max(1, 1.6 * sx);
      for (const p of sites) {
        const rr = mulberry(Math.round(Math.abs(p[0][0][0] * 7 + p[0][0][1] * 13)) + 9);
        const r0 = p[0]; const c0 = r0[Math.floor(rr() * r0.length)];
        for (let t = 0; t < 4; t++) {
          g.beginPath(); g.moveTo(tx(c0[0]), ty(c0[1]));
          g.bezierCurveTo(tx(c0[0] + (rr() - 0.5) * 160), ty(c0[1] + (rr() - 0.5) * 160), tx(c0[0] + (rr() - 0.5) * 220), ty(c0[1] + (rr() - 0.5) * 220), tx(c0[0] + (rr() - 0.5) * 260), ty(c0[1] + (rr() - 0.5) * 260));
          g.stroke();
        }
      }
      g.restore();
    }
    // 2026 vegetation (Sentinel-2 NDVI): green wherever the imagery shows irrigated planting, so lawns,
    // verges, roundabouts and the landscaping OSM never mapped all appear. Painted under the crisp OSM
    // parks, golf, plots and paving that follow. Only the part of the grid inside this painting is drawn.
    if (ndviCol) {
      const N = data.meta.ndvi;
      const c0 = Math.max(0, Math.floor((win[0] - N.x0) / N.res) - 1), c1 = Math.min(N.w, Math.ceil((win[2] - N.x0) / N.res) + 1);
      const r0 = Math.max(0, Math.floor((N.y1 - win[3]) / N.res) - 1), r1 = Math.min(N.h, Math.ceil((N.y1 - win[1]) / N.res) + 1);
      if (c1 > c0 && r1 > r0) {
        const dx = tx(N.x0 + c0 * N.res), dy = ty(N.y1 - r0 * N.res), dw = (c1 - c0) * N.res * sx, dh = (r1 - r0) * N.res * sy;
        g.save(); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(ndviCol, c0 * ns, r0 * ns, (c1 - c0) * ns, (r1 - r0) * ns, dx, dy, dw, dh); g.restore();
        k.save(); k.imageSmoothingEnabled = false; k.drawImage(ndviMsk, c0 * ns, r0 * ns, (c1 - c0) * ns, (r1 - r0) * ns, dx * KS, dy * KS, dw * KS, dh * KS); k.restore();
      }
    }
    // the Burj Lake promenade: grey-pink granite in bands that follow the water's edge, a pale kerb at the water
    // (painted before the parks, so Burj Park and the gardens keep their lawns)
    const BURJ_BANDS = [[100, '#a59c98'], [84, '#9c9390'], [68, '#a59c98'], [52, '#9c9390'], [36, '#a59c98'], [20, '#9c9390'], [3.0, '#d2cabb']];
    if (burjRings.length) for (const [bw, bc] of BURJ_BANDS) strokeLines(burjRings, bc, () => bw, 5);
    fill(A.parking, AREA_COLORS.parking, 4);
    fill(A.golf, AREA_COLORS.golf, 8); fill(A.rough, AREA_COLORS.rough, 8);
    fill(A.park, AREA_COLORS.park, 6); fill(A.grass, AREA_COLORS.grass, 6); fill(A.wood, AREA_COLORS.wood, 11);
    bedPolys(A.park, 2.0); bedPolys(A.grass, 2.0);
    fill(A.fairway, AREA_COLORS.fairway, 7);
    fill(A.golfgreen, AREA_COLORS.golfgreen, 9); fill(A.bunker, AREA_COLORS.bunker, 10);
    fill(A.pitch, AREA_COLORS.pitch, 12);
    if (A.pitch) {
      const vis = A.pitch.filter((p) => inWin(bbPts(p, p[0])));
      if (vis.length) { g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = Math.max(1, 0.5 * sx); g.beginPath(); for (const p of vis) tracePoly(g, p); g.stroke(); }
    }
    fill(A.beach, AREA_COLORS.beach, 10); fill(A.sand, AREA_COLORS.sand, 10);
    fill(A.plaza, AREA_COLORS.plaza, 5);
    // ...and once more over the mapped plazas round the lake, which the plaza fill has just covered in its own colour
    if (burjRings.length && A.plaza) {
      const lb = bbPts(burjRings[0], burjRings[0].p);
      const near = A.plaza.filter((p) => { const b = bbPts(p, p[0]); return inWin(b) && b[2] > lb[0] - 60 && b[0] < lb[2] + 60 && b[3] > lb[1] - 60 && b[1] < lb[3] + 60; });
      if (near.length) { g.save(); g.beginPath(); for (const p of near) tracePoly(g, p); g.clip('evenodd'); for (const [bw, bc] of BURJ_BANDS) strokeLines(burjRings, bc, () => bw, 5, true); g.restore(); }
    }
    // towers stand in landscaped grounds with a paved forecourt (Marina, JBR, JLT, Harbour, Bluewaters)
    // ...with flower beds along both edges of the lawn (alpha bands: the land shader plants them)
    strokeLines(towerRings, '#62a040', () => 46, 6);
    bedLines(towerRings, 46);
    strokeLines(towerRings, '#62a040', () => 42, 6, true);
    bedLines(towerRings, 20);
    strokeLines(towerRings, '#dcd4c6', () => 16, 5);
    // JLT lake promenades: a broad paved walk with a stone kerb at the water (the lake surface covers
    // the inner half of the stroke)
    if (lakeRings.length) {
      strokeLines(lakeRings, '#e3dccd', () => 22, 5);
      strokeLines(lakeRings, '#cfc6b5', () => 3.2, 5);
      strokeLines(lakeRings, '#f1ece2', () => 1.4, 5);
    }
    // landscaped verges and medians along the boulevards
    strokeLines(vergeRoads, '#64a242', (r) => r.w + (r.k === 'tertiary' ? 9 : 15), 6);
    // the estate's planted verges (groundcover, grasses, young trees) between the kerbs or footways and the walls
    strokeLines(kitRoads, '#5f9a40', (r) => r.w + 11, 6);
    // villa plots: lawns, driveways, pool decks
    for (const L of secs) L.lawnGroups.forEach((list, i) => fill(list, LAWNS[i], 6));
    for (const L of secs) {
      strokeLines(L.drives, '#d3c4a8', (l) => l.w, 13);
      strokeLines(L.drivesRed, '#a8644c', (l) => l.w, 13);
      fill(L.decks, '#e6dccb', 14);
      fill(L.courts, '#d9ccb5', 13);
    }
    // sidewalks: ground-level roads drawn wider in paving colour (the asphalt ribbon covers the middle)
    strokeLines(sideRoads, '#d8d0c1', (r) => r.w + (r.k === 'service' ? 1.4 : 4.4), 5);
    for (const L of secs) strokeLines(L.walkPaths, '#eae2d3', (p) => p.w, 5);
    // surface car parks (painted last so gardens/verges never cover them):
    // 0 asphalt, 1 red interlocking pavers with light kerbs, 2 light paving, 3 street-side bays
    lotsByStyle.forEach((list, st) => fill(list, LOT_BASE[st], LOT_CLS[st]));
    for (const L of secs) L.baysByStyle.forEach((list, st) => fill(list, PAD[st], PAD_CLS[st]));
    // Where grass blades must not grow although the ground is painted as lawn: under buildings, under the kerbed
    // streets and their footways, under the motorways, under the lakes. A flag in the low bits of the class value (the class itself
    // is unchanged, so the lawn keeps its look); layers/grass.js reads it. Only in the sharp tiles.
    if (sx > 0.5) {
      const roofs = secs.flatMap((L) => L.roofs.filter((p) => inWin(bbPts(p, p[0]), 3)));
      const kr = kitRoads.filter((l) => inWin(bbPts(l, l.p), l.w + 4)), mw = motorRoads.filter((l) => inWin(bbPts(l, l.p), l.w + 2));
      const lakes = (A.water || []).filter((p) => inWin(bbPts(p, p[0]), 3));
      if (roofs.length || kr.length || mw.length || lakes.length) {
        const t = mkCanvas(kw, kh), tc = t.getContext('2d');
        tc.scale(KS, KS); tc.fillStyle = tc.strokeStyle = 'rgb(7,0,0)'; tc.lineCap = tc.lineJoin = 'round';
        if (roofs.length) { tc.lineWidth = Math.max(1, 1.6 * sx); tc.beginPath(); for (const p of roofs) tracePoly(tc, p); tc.fill('nonzero'); tc.stroke(); }
        if (lakes.length) { tc.lineWidth = Math.max(1, 2.4 * sx); tc.beginPath(); for (const p of lakes) tracePoly(tc, p); tc.fill('evenodd'); tc.stroke(); }
        for (const [list, extra] of [[kr, 3.4], [mw, 1]]) for (const l of list) {
          tc.lineWidth = Math.max(1, (l.w + extra) * sx);
          tc.beginPath(); l.p.forEach((p, i) => (i ? tc.lineTo(tx(p[0]), ty(p[1])) : tc.moveTo(tx(p[0]), ty(p[1])))); tc.stroke();
        }
        k.save(); k.globalCompositeOperation = 'lighter'; k.drawImage(t, 0, 0); k.restore();
        t.width = t.height = 1;
      }
    }
    // Rock revetments and breakwaters: the land is cut away under them, and in the strip between the mapped rock
    // and the waterline (never on the walk's side), so the armour stones lie below the walk and run into the sea
    {
      const vis = (A.breakwater || []).filter((q) => inWin(bbPts(q, q[0]), 8));
      if (vis.length) {
        const t = mkCanvas(cw, ch), tc = t.getContext('2d');
        tc.strokeStyle = tc.fillStyle = '#fff'; tc.lineJoin = tc.lineCap = 'round';
        tc.lineWidth = Math.max(1, 7 * sx); tc.beginPath(); for (const q of vis) tracePoly(tc, q); tc.stroke();
        tc.globalCompositeOperation = 'destination-in'; tc.lineWidth = Math.max(1, 8 * sx); tc.beginPath();
        for (const q of vis) { const cs = rockInfo.get(q).coast; for (let k = 0; k < cs.length; k += 2) { tc.moveTo(tx(cs[k][0]), ty(cs[k][1])); tc.lineTo(tx(cs[k + 1][0]), ty(cs[k + 1][1])); } }
        tc.stroke();
        tc.globalCompositeOperation = 'source-over'; tc.beginPath(); for (const q of vis) tracePoly(tc, q); tc.fill('nonzero');
        g.save(); g.globalCompositeOperation = 'destination-out'; g.drawImage(t, 0, 0); g.restore();
        t.width = t.height = 1;
      }
    }
  };
  const target = (gc, kc, x0, yTop, spanW, spanH) => {
    g = gc.getContext('2d'); k = kc.getContext('2d');
    cw = gc.width; ch = gc.height; kw = kc.width; kh = kc.height;
    ox = x0; oy = yTop; sx = cw / spanW; sy = ch / spanH;
    win[0] = x0; win[1] = yTop - spanH; win[2] = x0 + spanW; win[3] = yTop;
  };
  // paintings go straight from the canvas to the GPU texture (no pixel readback through the CPU)
  const upload = (canvas, dst, x, y, layer) => ctx.renderer.copyTextureToTexture(new THREE.Texture(canvas), dst, null, layer == null ? new THREE.Vector2(x, y) : new THREE.Vector3(x, y, layer));
  const gpuTex = (T, w, h, d) => { const t = d ? new T(null, w, h, d) : new T(null, w, h); t.source.dataReady = false; return t; };
  const workGate = () => (ctx.workGate ? ctx.workGate() : new Promise((r) => setTimeout(r, 0)));

  // ---- base painting: the whole map, low resolution
  const bSpanW = B.w + 2 * TM, bSpanH = B.h + 2 * TM, bScale = maxTex / Math.max(bSpanW, bSpanH);
  const bw = Math.round(bSpanW * bScale), bh = Math.round(bSpanH * bScale);
  const baseC = mkCanvas(bw, bh), baseK = mkCanvas(Math.round(bw * KS), Math.round(bh * KS));
  target(baseC, baseK, B.x0 - TM, B.y1 + TM, bSpanW, bSpanH);
  paint();
  const baseTex = gpuTex(THREE.DataTexture, bw, bh);
  baseTex.format = THREE.RGBAFormat; baseTex.colorSpace = THREE.SRGBColorSpace; baseTex.generateMipmaps = true; baseTex.minFilter = THREE.LinearMipmapLinearFilter; baseTex.magFilter = THREE.LinearFilter;
  baseTex.anisotropy = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy()); baseTex.needsUpdate = true;
  const baseCls = gpuTex(THREE.DataTexture, Math.round(bw * KS), Math.round(bh * KS));
  baseCls.format = THREE.RedFormat; baseCls.unpackAlignment = 1; baseCls.magFilter = baseCls.minFilter = THREE.NearestFilter; baseCls.generateMipmaps = false; baseCls.needsUpdate = true;
  upload(baseC, baseTex, 0, 0); upload(baseK, baseCls, 0, 0);
  baseC.width = baseC.height = baseK.width = baseK.height = 1; // release
  // repaint part of the base painting (a section has arrived), in strips so frames keep flowing
  async function repaintBase(bb) {
    const PADM = 60;
    let px0 = Math.max(0, Math.floor((bb[0] - PADM - (B.x0 - TM)) * bScale)), px1 = Math.min(bw, Math.ceil((bb[2] + PADM - (B.x0 - TM)) * bScale));
    let py0 = Math.max(0, Math.floor((B.y1 + TM - (bb[3] + PADM)) * bScale)), py1 = Math.min(bh, Math.ceil((B.y1 + TM - (bb[1] - PADM)) * bScale));
    px0 -= px0 % 2; py0 -= py0 % 2; px1 = Math.min(bw - (bw % 2), px1 + (px1 % 2)); py1 = Math.min(bh - (bh % 2), py1 + (py1 % 2));
    const w = px1 - px0; if (w <= 0 || py1 <= py0) return;
    const STRIP = 256;
    for (let y = py0; y < py1; y += STRIP) {
      await workGate();
      const h = Math.min(STRIP, py1 - y);
      const c = mkCanvas(w, h), kc = mkCanvas(w * KS, h * KS);
      target(c, kc, B.x0 - TM + px0 / bScale, B.y1 + TM - y / bScale, w / bScale, h / bScale);
      paint();
      upload(c, baseTex, px0, y); upload(kc, baseCls, px0 * KS, y * KS);
      c.width = c.height = kc.width = kc.height = 1;
    }
  }

  // ---- detail tiles, painted on demand into a pool of slots
  const detC = mkCanvas(DT, DT), detK = mkCanvas(DT * KS, DT * KS);
  const KD = DT * KS;
  const detTex = gpuTex(THREE.DataArrayTexture, DT, DT, SLOTS); // storage lives on the GPU only
  detTex.format = THREE.RGBAFormat; detTex.type = THREE.UnsignedByteType; detTex.colorSpace = THREE.SRGBColorSpace;
  detTex.generateMipmaps = true; detTex.minFilter = THREE.LinearMipmapLinearFilter; detTex.magFilter = THREE.LinearFilter;
  detTex.anisotropy = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy()); detTex.needsUpdate = true;
  const detCls = gpuTex(THREE.DataArrayTexture, KD, KD, SLOTS);
  detCls.format = THREE.RedFormat; detCls.type = THREE.UnsignedByteType; detCls.unpackAlignment = 1;
  detCls.magFilter = detCls.minFilter = THREE.NearestFilter; detCls.generateMipmaps = false; detCls.needsUpdate = true;
  const indir = new THREE.DataTexture(new Uint8Array(gnx * gny), gnx, gny, THREE.RedFormat);
  indir.unpackAlignment = 1; indir.magFilter = indir.minFilter = THREE.NearestFilter; indir.generateMipmaps = false; indir.needsUpdate = true;
  const slotCell = new Int32Array(SLOTS).fill(-1), slotUsed = new Float64Array(SLOTS), cellSlot = new Int16Array(gnx * gny).fill(-1);
  const stale = new Uint8Array(gnx * gny); // resident tiles painted before a section arrived
  function paintCell(ci, cj, slot) {
    target(detC, detK, B.x0 + ci * DS - TM, B.y1 - cj * DS + TM, DS + 2 * TM, DS + 2 * TM);
    paint();
    upload(detC, detTex, 0, 0, slot); upload(detK, detCls, 0, 0, slot);
    const old = slotCell[slot];
    if (old >= 0) { cellSlot[old] = -1; indir.image.data[old] = 0; }
    const cell = cj * gnx + ci;
    slotCell[slot] = cell; cellSlot[cell] = slot; indir.image.data[cell] = slot + 1; indir.needsUpdate = true;
    stale[cell] = 0;
  }
  // mark resident tiles overlapping bb (metres) for repainting
  function invalidateTiles(bb) {
    for (let sl = 0; sl < SLOTS; sl++) {
      const cell = slotCell[sl]; if (cell < 0) continue;
      const ci = cell % gnx, cj = Math.floor(cell / gnx);
      const x0 = B.x0 + ci * DS - TM, x1 = x0 + DS + 2 * TM, y1 = B.y1 - cj * DS + TM, y0 = y1 - DS - 2 * TM;
      if (x1 >= bb[0] - 80 && x0 <= bb[2] + 80 && y1 >= bb[1] - 80 && y0 <= bb[3] + 80) stale[cell] = 1;
    }
  }
  let gFrame = 0;
  ctx.updaters.push(() => {
    gFrame++;
    if (gFrame % (ctx.isInteracting && ctx.isInteracting() ? 6 : 2)) return;
    const cam = ctx.activeCamera;
    let cx, cy, R;
    if (cam.isOrthographicCamera) {
      const mpp = (cam.top - cam.bottom) / cam.zoom / Math.max(1, window.innerHeight);
      if (mpp > 1.7) return; // far out: the base painting is sharp enough
      const f = ctx.focus ? ctx.focus() : ctx.controls.target; cx = f.x; cy = -f.z;
      R = (Math.hypot(cam.right - cam.left, cam.top - cam.bottom) / cam.zoom) * 0.6 + 200;
    } else { cx = cam.position.x; cy = -cam.position.z; R = 1400; }
    const i0 = Math.max(0, Math.floor((cx - R - B.x0) / DS)), i1 = Math.min(gnx - 1, Math.floor((cx + R - B.x0) / DS));
    const j0 = Math.max(0, Math.floor((B.y1 - (cy + R)) / DS)), j1 = Math.min(gny - 1, Math.floor((B.y1 - (cy - R)) / DS));
    let best = -1, bestD = Infinity, redo = -1, redoD = Infinity;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const mx = B.x0 + (i + 0.5) * DS, my = B.y1 - (j + 0.5) * DS, d = Math.hypot(mx - cx, my - cy);
      if (d > R + DS * 0.71) continue;
      const cell = j * gnx + i, sl = cellSlot[cell];
      if (sl >= 0) { slotUsed[sl] = gFrame; if (stale[cell] && d < redoD) { redoD = d; redo = cell; } } else if (d < bestD) { bestD = d; best = cell; }
    }
    // missing tiles first; then tiles a newly arrived section has made stale, repainted in place
    if (best < 0 && redo >= 0) { paintCell(redo % gnx, Math.floor(redo / gnx), cellSlot[redo]); return; }
    if (best < 0) return;
    // a free slot, else the least recently used one not needed this frame
    let slot = -1, oldest = Infinity;
    for (let sIdx = 0; sIdx < SLOTS; sIdx++) {
      if (slotCell[sIdx] < 0) { slot = sIdx; break; }
      if (slotUsed[sIdx] < gFrame && slotUsed[sIdx] < oldest) { oldest = slotUsed[sIdx]; slot = sIdx; }
    }
    if (slot < 0) return; // every slot is in view
    paintCell(best % gnx, Math.floor(best / gnx), slot);
    slotUsed[slot] = gFrame;
  });
  // ground grid: west, north, detail core, overlap; base: west, north, span w, span h (all metres)
  const uGrid = { value: new THREE.Vector4(B.x0, B.y1, DS, TM) }, uGridN = { value: new THREE.Vector2(gnx, gny) };
  const uBaseB = { value: new THREE.Vector4(B.x0 - TM, B.y1 + TM, bSpanW, bSpanH) };
  console.info(`[ground] base ${bw}x${bh} px (${(1 / bScale).toFixed(1)} m/px), detail ${gnx}x${gny} tiles of ${Math.round(DS)} m in ${SLOTS} slots (${(1 / DD).toFixed(2)} m/px)`);

  // ------------------------------------------------------------------ shore distance texture (low-res blurred land mask)
  const shoreTex = makeShoreTexture(data, landPolys, B);

  ctx.groundTex = { uBaseB, baseTex }; // the base painting, for light bounced onto walls (layers/buildings.js)
  // ------------------------------------------------------------------ shared uniforms
  const uTime = { value: 0 }, uNight = { value: 0 };
  const uBounds = { value: new THREE.Vector4(B.x0, B.y0, B.w, B.h) };
  ctx.updaters.push((dt, t) => { uTime.value = t; });
  ctx.on('time', (s) => { uNight.value = s.night; });

  // ------------------------------------------------------------------ land
  const landMat = new THREE.MeshStandardMaterial({ roughness: 0.97, metalness: 0 });
  landMat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, {
      uNight, uTime, uBounds, uGrid, uGridN, uBaseB, uShore: { value: shoreTex },
      uBaseL: { value: baseTex }, uBaseK: { value: baseCls }, uDetL: { value: detTex }, uDetK: { value: detCls }, uIndir: { value: indir },
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nprecision highp sampler2DArray;\nvarying vec3 vWPos;\nuniform float uNight, uTime;\nuniform sampler2D uShore, uBaseL, uBaseK, uIndir;\nuniform sampler2DArray uDetL, uDetK;\nuniform vec4 uBounds, uGrid, uBaseB;\nuniform vec2 uGridN;\nfloat gPaved = 0.0;\n${GLSL_NOISE}`)
      .replace('#include <map_fragment>', `
        {
          vec2 p = vWPos.xz;
          // sharp detail tile where one is resident, else the whole-map base painting (gradients come from
          // the continuous world position, so neither tile borders nor the switch show a mip seam)
          vec2 gq = vec2(p.x - uGrid.x, uGrid.y + p.y);             // metres east of the west edge, south of the north edge
          vec2 buv = vec2((p.x - uBaseB.x) / uBaseB.z, (uBaseB.y + p.y) / uBaseB.w);
          vec2 bgx = dFdx(buv), bgy = dFdy(buv);
          float dspan = uGrid.z + 2.0 * uGrid.w;
          vec2 dgx = dFdx(gq) / dspan, dgy = dFdy(gq) / dspan;
          ivec2 tcell = ivec2(clamp(floor(gq / uGrid.z), vec2(0.0), uGridN - 1.0));
          float tslot = floor(texelFetch(uIndir, tcell, 0).r * 255.0 + 0.5) - 1.0;
          vec4 landC; float clsRaw;
          if (tslot >= 0.0) {
            vec2 duv = (gq - vec2(tcell) * uGrid.z + uGrid.w) / dspan;
            landC = textureGrad(uDetL, vec3(duv, tslot), dgx, dgy);
            clsRaw = textureLod(uDetK, vec3(duv, tslot), 0.0).r;
          } else {
            landC = textureGrad(uBaseL, buv, bgx, bgy);
            clsRaw = textureLod(uBaseK, buv, 0.0).r;
          }
          if (landC.a < 0.5) discard; // cut away under the rock revetments
          diffuseColor *= landC;
          float cls = floor(clsRaw * 255.0 / 16.0 + 0.5);
          float px = length(fwidth(p));
          float fine = 1.0 - smoothstep(0.07, 0.3, px);
          float mid = 1.0 - smoothstep(0.25, 1.4, px);
          vec3 col = diffuseColor.rgb;
          col *= 0.94 + 0.1 * fbm(p * 0.045);
          bool grassy = cls == 6.0 || cls == 7.0 || cls == 8.0 || cls == 9.0 || cls == 11.0 || cls == 12.0;
          if (grassy) {
            float blades = vnoise(p * 3.1) * 0.5 + vnoise(p * 9.0) * 0.5;
            col *= mix(1.0, 0.82 + 0.3 * blades, mid);
            float dry = smoothstep(0.58, 0.86, fbm(p * 0.07 + 7.0));
            if (cls != 9.0 && cls != 12.0) col = mix(col, col * vec3(1.08, 1.02, 0.74), dry * 0.35);
            // painted lawn: broad soft patches drifting between warm yellow-green and cool emerald, and brush-like
            // streaks running one way across the grass
            float hue = smoothstep(0.25, 0.75, fbm(p * 0.016 + 3.0));
            col *= mix(vec3(0.9, 1.02, 1.04), vec3(1.08, 1.05, 0.8), hue);
            float strokeN = vnoise(vec2(dot(p, vec2(0.8, 0.6)) * 0.55, dot(p, vec2(-0.6, 0.8)) * 2.6));
            col *= mix(1.0, 0.92 + 0.16 * strokeN, mid);
            float gl = dot(col, vec3(0.299, 0.587, 0.114));
            col = mix(vec3(gl), col, 1.02);
            // wind over the grass: bands of bent, lighter blades roll across the lawns in gusts, with a fine
            // shimmer of blades inside each band
            {
              float gust = vnoise(p * 0.03 + vec2(uTime * 0.2, uTime * 0.08));
              float wave = sin(dot(p, vec2(0.62, 0.78)) * 0.5 - uTime * 1.7 + gust * 9.0);
              float bend = smoothstep(0.3, 1.0, wave) * smoothstep(0.3, 0.72, gust);
              float bl = vnoise(vec2(dot(p, vec2(0.78, -0.62)) * 7.0, dot(p, vec2(0.62, 0.78)) * 1.5 - uTime * 0.7));
              col *= 1.0 + mid * bend * (0.14 + 0.16 * (bl - 0.5));
              col = mix(col, col * vec3(1.1, 1.08, 0.84), bend * 0.3 * mid);
            }
            // flower beds along lawn edges (alpha bands in the painting): clipped hedge greens with clusters of
            // pink, magenta, white and red flowers; far out, a blended tint
            float bedA = smoothstep(0.92, 0.6, landC.a);
            if (bedA > 0.01) {
              float lf = vnoise(p * 2.4) * 0.55 + vnoise(p * 7.0) * 0.45;
              vec3 hedge = vec3(0.05, 0.17, 0.045) * (0.7 + 0.6 * lf);
              // flowers in clusters: two jittered grids of blooms, the colour shared by neighbouring blooms
              vec2 fc = p / 0.55, fi = floor(fc), ff = fract(fc);
              float fd = length(ff - (0.22 + 0.56 * vec2(hash12(fi), hash12(fi + 17.0))));
              float fl = (1.0 - smoothstep(0.2, 0.32, fd)) * step(0.18, hash12(fi + 5.0));
              vec2 fc2 = p / 0.55 + 0.5, fi2 = floor(fc2), ff2 = fract(fc2);
              float fd2 = length(ff2 - (0.22 + 0.56 * vec2(hash12(fi2 + 3.0), hash12(fi2 + 41.0))));
              fl = max(fl, (1.0 - smoothstep(0.18, 0.3, fd2)) * step(0.35, hash12(fi2 + 9.0)));
              float fh = hash12(floor(p / 2.4) + 29.0);
              vec3 fcol = fh < 0.4 ? vec3(0.86, 0.12, 0.36) : fh < 0.66 ? vec3(0.95, 0.4, 0.6) : fh < 0.84 ? vec3(0.92, 0.88, 0.82) : vec3(0.84, 0.12, 0.08);
              vec3 bedC = mix(mix(hedge, fcol * 0.7, 0.42), mix(hedge, fcol * (0.85 + 0.3 * lf), fl), mid);
              col = mix(col, bedC, bedA);
            }
          }
          if (cls == 7.0) col *= 0.93 + 0.11 * step(0.5, fract(dot(p, vec2(0.6, 0.8)) / 14.0));
          if (cls == 9.0) col *= 0.96 + 0.06 * step(0.5, fract(dot(p, vec2(0.8, -0.6)) / 3.0));
          if (cls == 6.0) col *= mix(1.0, 0.955 + 0.07 * step(0.5, fract(dot(p, vec2(0.8, -0.6)) / 2.6)), fine);
          if (cls == 5.0 || cls == 13.0 || cls == 14.0) {
            float tile = cls == 13.0 ? 0.42 : 0.7;
            vec2 t = fract(p / tile);
            float joint = smoothstep(0.0, 0.07, min(min(t.x, 1.0 - t.x), min(t.y, 1.0 - t.y)));
            float tv = hash12(floor(p / tile));
            col *= mix(1.0, (0.86 + 0.14 * joint) * (0.94 + 0.1 * tv), fine);
          }
          // Wind-shaped sand. The ground lies in low dunes: a long windward slope brightening up to a sharp crest,
          // then a short slip face in shade; the wind combs fine ripples square to itself that creep downwind, and
          // in gusts streamers of loose sand snake over the surface (the same wind that bends the grass).
          vec2 wd = vec2(0.62, 0.78);
          float along = dot(p, wd), across = dot(p, vec2(-wd.y, wd.x));
          float duneN = (vnoise(vec2(along * 0.014, across * 0.006) + 4.0) * 0.7 + vnoise(vec2(along * 0.035, across * 0.016) + 9.0) * 0.3) * 3.4;
          float duneW = clamp(fwidth(duneN) * 1.5, 0.004, 0.5); // (derivative taken outside the branch)
          if (cls == 0.0 || cls == 10.0 || cls == 3.0) {
            float open = cls == 0.0 ? 1.0 : cls == 10.0 ? 0.7 : 0.5;
            float duneFade = 1.0 - smoothstep(4.0, 14.0, px);
            float dq = fract(duneN);
            float lee = (1.0 - smoothstep(0.0, 0.17, dq)) * smoothstep(0.0, duneW, dq);
            float rise = smoothstep(0.25, 1.0, dq) * (1.0 - smoothstep(1.0 - duneW, 1.0, dq));
            col *= 1.0 + open * duneFade * (0.1 * rise - 0.25 * lee);
            col = mix(col, col * vec3(1.07, 1.0, 0.86), open * duneFade * lee * 0.45);
            float rip = sin(along * 2.4 + vnoise(p * 0.22) * 7.0 - uTime * 0.3);
            col *= mix(1.0, 0.965 + 0.05 * rip, mid);
            col *= mix(1.0, 0.93 + 0.13 * vnoise(p * 7.0), fine);
            float gustS = smoothstep(0.4, 0.72, vnoise(p * 0.012 + vec2(uTime * 0.06, uTime * 0.03)));
            float thr = vnoise(vec2(along * 0.07 - uTime * 0.85, across * 0.85 + 2.5 * vnoise(vec2(along * 0.03 - uTime * 0.3, across * 0.12))));
            float thr2 = vnoise(vec2(along * 0.12 - uTime * 1.3, across * 1.6 + 9.0));
            float stream = smoothstep(0.64, 0.86, thr) * (0.45 + 0.55 * thr2) * gustS * open * (1.0 - smoothstep(0.5, 2.4, px));
            col = mix(col, col * 1.12 + vec3(0.1, 0.09, 0.06), stream);
          }
          if (cls == 10.0) {
            // beach: soft dunes up top, darker damp sand and a glossy swash line at the waterline
            col *= 0.97 + 0.06 * fbm(p * 0.02 + 3.0);
            vec2 suv = vec2((p.x - uBounds.x) / uBounds.z, (-p.y - uBounds.y) / uBounds.w);
            float wet = texture2D(uShore, suv).a;
            float damp = smoothstep(0.38, 0.8, wet + 0.08 * (vnoise(p * 0.3) - 0.5));
            col = mix(col, col * vec3(0.88, 0.85, 0.8), damp * 0.8);
          }
          if (cls == 4.0) col *= mix(1.0, 0.88 + 0.16 * vnoise(p * 4.0) * vnoise(p * 0.7), mid);
          if (cls == 1.0 || cls == 2.0) col *= mix(1.0, 0.95 + 0.08 * vnoise(p * 1.3), mid);
          diffuseColor.rgb = col; diffuseColor.a = 1.0;
          gPaved = (cls == 4.0 || cls == 5.0 || cls == 13.0 || cls == 14.0) ? 1.0 : 0.0;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * uNight * mix(0.05, 0.13, gPaved) + vec3(1.0, 0.66, 0.36) * uNight * 0.03 * gPaved;`);
  };
  const landGeo = polygonsGeometry(landPolys, 0);
  const land = new THREE.Mesh(landGeo, landMat);
  land.receiveShadow = true; land.name = 'land';
  group.add(land);

  // ------------------------------------------------------------------ water
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x1b6fb0, roughness: 0.08, metalness: 0.0 });
  const deep = new THREE.Color('#073a74'), mid = new THREE.Color('#1262a6'), shallow = new THREE.Color('#2f93b4'), foam = new THREE.Color('#e9f7f6');
  waterMat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, {
      uTime, uNight, uBounds, uShore: { value: shoreTex },
      uDeep: { value: deep }, uMid: { value: mid }, uShallow: { value: shallow }, uFoam: { value: foam },
      // the Burj Lake (Downtown) is shallow over a pale lined floor: bright turquoise, not the teal of other lakes
      uPoolBox: { value: new THREE.Vector4(13380, 12390, 14020, 13010) },
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        uniform float uTime, uNight; uniform vec4 uBounds; uniform sampler2D uShore;
        uniform vec3 uDeep, uMid, uShallow, uFoam; uniform vec4 uPoolBox;
        ${GLSL_NOISE}
        ${CAUSTICS}
        float waveH(vec2 p){
          float t = uTime;
          float h = 0.45 * sin(dot(p, vec2(0.11, 0.045)) + t * 1.05) + 0.3 * sin(dot(p, vec2(-0.06, 0.13)) + t * 1.37);
          h += 0.9 * (vnoise(p * 0.16 + vec2(t * 0.22, t * 0.09)) - 0.5);
          h += 0.4 * (vnoise(p * 0.55 - vec2(t * 0.35, -t * 0.18)) - 0.5);
          h += 1.3 * sin(dot(p, vec2(0.5, 0.866)) * 0.13 - t * 0.9); // the swell
          return h;
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 suv = vec2((vWPos.x - uBounds.x) / uBounds.z, (-vWPos.z - uBounds.y) / uBounds.w);
        vec4 sh = texture2D(uShore, suv);
        float nearS = sh.r, wideS = sh.g;
        // inland lakes sit above sea level: calm, darker green-blue water with no surf
        float lake = step(-0.4, vWPos.y);
        {
        vec2 p = vWPos.xz; float t = uTime;
        float dn = 1.0 - nearS, dw = 1.0 - wideS;
        float beachN = smoothstep(0.02, 0.35, sh.b);
        float open = 1.0 - lake;
        // palette of clear Gulf shallows: bright sand seen through a film of water, aqua, turquoise, teal-blue
        vec3 clearW = mix(SAND_BOTTOM, vec3(0.36, 0.78, 0.74), 0.5);
        vec3 aqua = vec3(0.2, 0.68, 0.64), turq = vec3(0.035, 0.4, 0.46), teal = vec3(0.02, 0.3, 0.42), deepC = vec3(0.02, 0.24, 0.38);
        vec3 wc = mix(turq, teal, smoothstep(0.2, 0.9, dw));
        wc = mix(wc, deepC, smoothstep(0.35, 1.0, 1.0 - sh.a) * open);
        float ramp = beachN * open;
        wc = mix(wc, turq, (1.0 - smoothstep(0.35, 1.0, dn)) * ramp);
        wc = mix(wc, aqua, (1.0 - smoothstep(0.15, 0.7, dn)) * ramp);
        wc = mix(wc, clearW, (1.0 - smoothstep(0.0, 0.32, dn)) * ramp);
        wc = mix(wc, aqua * 0.9, (1.0 - smoothstep(0.0, 0.45, dn)) * (1.0 - beachN) * open * 0.35); // harbour walls
        // broad colour patches and swell offshore
        wc *= 0.93 + 0.14 * fbm(p * 0.0045 + 2.0);
        float swell = sin(dot(p, vec2(-0.55, 0.84)) * 0.085 + t * 0.55 + fbm(p * 0.008) * 5.0);
        wc *= 1.0 + 0.03 * swell * smoothstep(0.2, 0.7, dw) * open;
        // rolling swell: long crests marching toward the coast in sets, sunlit along the crest and shaded in the
        // trough ahead of it, breaking into whitecaps; out at sea only (harbours, lagoons and lakes stay calm)
        {
          float seaK = open * smoothstep(0.22, 0.75, dw);
          float sfade = 1.0 - smoothstep(3.0, 9.0, length(fwidth(p)));
          float ph = dot(p, vec2(0.5, 0.866)) * 0.13 - t * 0.9 + fbm(p * 0.006 + 1.7) * 7.0 + vnoise(p * 0.02) * 1.5;
          float crestS = pow(0.5 + 0.5 * sin(ph), 5.0);
          float sets = smoothstep(0.3, 0.7, vnoise(p * 0.004 + vec2(t * 0.02, 0.0)));
          wc *= 1.0 + seaK * sfade * (0.5 + 0.5 * sets) * (0.2 * crestS - 0.13 * smoothstep(0.0, 1.0, -cos(ph)) * (1.0 - crestS));
          float cap = smoothstep(0.86, 0.99, crestS) * smoothstep(0.62, 0.84, vnoise(p * vec2(0.03, 0.05) + vec2(t * 0.1, -t * 0.07))) * sets;
          cap *= 0.55 + 0.45 * vnoise(p * 0.9 + vec2(t * 0.4, 0.0)); // lacy foam, not a solid stroke
          wc = mix(wc, uFoam, cap * seaK * sfade * 0.7 * (1.0 - 0.9 * uNight));
        }
        // sand ripples and seagrass patches on the bottom where it is shallow
        float shl = (1.0 - smoothstep(0.05, 0.8, dn)) * ramp;
        float sandR = vnoise(p * vec2(0.22, 0.6)) * 0.55 + vnoise(p * 0.05) * 0.45;
        wc = mix(wc, wc * (0.93 + 0.12 * sandR), shl * 0.7);
        float grassP = smoothstep(0.64, 0.75, fbm(p * 0.016 + 11.0)) * smoothstep(0.25, 0.5, dn);
        wc = mix(wc, wc * vec3(0.62, 0.72, 0.58), grassP * shl * 0.65);
        // caustics: a web of focused sunlight, strongest in the shallows, faded out when it would alias
        float cAmt = shl * 0.85 + (1.0 - smoothstep(0.0, 0.5, dw)) * open * 0.06;
        float cfade = 1.0 - smoothstep(0.08, 0.3, length(fwidth(p * 0.24))); // derivatives outside the branch
        float wfade = 1.0 - smoothstep(0.35, 1.3, length(fwidth(p)));
        if (cAmt * cfade > 0.005) {
          vec2 cp = p * 0.24 + vec2(vnoise(p * 0.07 + t * 0.05), vnoise(p * 0.06 - t * 0.04)) * 1.6;
          float cs = causticNet(cp, t);
          wc += vec3(0.75, 0.9, 0.85) * cs * cfade * cAmt;
        }
        // calm inland lakes: teal-green
        wc = mix(wc, vec3(0.06, 0.29, 0.34) * (0.9 + 0.2 * fbm(p * 0.03)), lake);
        float poolLake = lake * step(uPoolBox.x, p.x) * step(p.x, uPoolBox.z) * step(uPoolBox.y, -p.y) * step(-p.y, uPoolBox.w);
        wc = mix(wc, vec3(0.1, 0.5, 0.5) * (0.93 + 0.12 * fbm(p * 0.02 + 5.0)), poolLake);
        // painted wavelets (stylized water): short bright crests and soft troughs drifting with the breeze,
        // faded out where they would alias
        {
          vec2 wq = p * 0.42;
          float ph = dot(wq, vec2(0.7, 0.71)) * 2.0 + vnoise(wq * 0.55 + t * 0.05) * 6.5 - t * 0.85;
          float sp = sin(ph), brk = vnoise(wq * vec2(1.4, 0.9) + vec2(t * 0.06, -t * 0.04));
          // (the breeze ruffles the water in patches: slicks of calm between them)
          float ruffle = mix(0.2, 1.0, smoothstep(0.3, 0.62, fbm(p * 0.011 + vec2(t * 0.012, 0.0))));
          float crest = smoothstep(0.8, 0.97, sp) * smoothstep(0.42, 0.66, brk) * ruffle;
          float trough = smoothstep(0.72, 0.98, -sp) * smoothstep(0.3, 0.6, brk);
          wc *= 1.0 - 0.12 * trough * wfade;
          wc = mix(wc, wc * 0.5 + vec3(0.46, 0.74, 0.7), crest * wfade * 0.42 * (1.0 - lake * 0.6) * (1.0 - 0.85 * uNight));
        }
        // surf: soft crest lines rolling in, a gentle lacy swash at the waterline
        float lace = vnoise(p * 0.8 + vec2(t * 0.35, 0.0)) * 0.6 + vnoise(p * 2.6 - vec2(0.0, t * 0.5)) * 0.4;
        float surfZone = smoothstep(0.3, 0.75, nearS) * open * beachN;
        float crest = smoothstep(0.88, 0.97, fract(nearS * 2.4 - t * 0.1 + 0.08 * vnoise(p * 0.05))) * surfZone;
        float swashF = smoothstep(0.86, 0.97, nearS) * (0.55 + 0.45 * sin(t * 0.8 + p.x * 0.03 + p.y * 0.02 + lace * 2.0)) * open * mix(0.15, 1.0, beachN);
        float foamAmt = clamp(crest * smoothstep(0.35, 0.75, lace) * 1.1 + swashF * smoothstep(0.38, 0.75, lace) * 0.8, 0.0, 1.0);
        wc = mix(wc, uFoam, foamAmt * 0.75 * (1.0 - 0.75 * uNight));
        diffuseColor.rgb = wc;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz; float e = 0.7;
          float h0 = waveH(p), hx = waveH(p + vec2(e, 0.0)), hz = waveH(p + vec2(0.0, e));
          // fine wind ripples for sun glitter
          vec2 wv = uTime * vec2(0.9, 0.4);
          float r0 = vnoise(p * 1.9 + wv), rx = vnoise((p + vec2(0.25, 0.0)) * 1.9 + wv), rz = vnoise((p + vec2(0.0, 0.25)) * 1.9 + wv);
          float calm = 0.4 + 0.6 * smoothstep(0.0, 0.6, 1.0 - sh.r);
          vec3 nW = normalize(vec3((-(hx - h0) / e * 0.16 - (rx - r0) * 0.26) * calm, 1.0, (-(hz - h0) / e * 0.16 - (rz - r0) * 0.26) * calm));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // water glows with its own colour by day (light scattered inside it), so it stays turquoise in the
        // towers' shadows instead of turning navy
        totalEmissiveRadiance += diffuseColor.rgb * 0.24 * (1.0 - uNight);
        {
          // after dark the lights of the shore lie on the water as a soft warm glow that thins out seaward, gently
          // broken by the ripples (no sparks or streaks)
          float nearL = smoothstep(0.35, 1.0, sh.r) * 0.75 + smoothstep(0.3, 1.0, sh.g) * 0.25;
          float rp = 0.75 + 0.5 * vnoise(vWPos.xz * 0.11 + vec2(uTime * 0.12, -uTime * 0.07));
          totalEmissiveRadiance += vec3(1.0, 0.62, 0.3) * uNight * 0.055 * nearL * rp;
          totalEmissiveRadiance += vec3(0.02, 0.05, 0.11) * uNight;
        }`);
  };
  if (ctx.env) ctx.env.addReflective(waterMat, 0.3);
  // a grid rather than two giant triangles: big triangles lose depth precision in first-person views
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(B.w, B.h, Math.ceil(B.w / 250), Math.ceil(B.h / 250)).rotateX(-Math.PI / 2), waterMat);
  sea.position.set(B.x0 + B.w / 2, SEA_Y, -(B.y0 + B.h / 2));
  sea.receiveShadow = true; sea.name = 'sea';
  group.add(sea);
  const inland = new THREE.Mesh(polygonsGeometry(A.water || [], 0.03), waterMat);
  inland.receiveShadow = true; inland.name = 'lakes';
  group.add(inland);

  // ------------------------------------------------------------------ beaches meet the sea softly
  // Coastline edges next to a sandy beach get no sea wall; instead a strip of clear water washes up
  // and back over the sand, foam at its front and damp sand behind, matching the sea's edge colour.
  const sInfo = shoreTex.userData.info;
  const beachAt = (x, y) => {
    const c = Math.max(0, Math.min(sInfo.w - 1, Math.floor(((x - B.x0) / B.w) * sInfo.w)));
    const r = Math.max(0, Math.min(sInfo.h - 1, Math.floor(((B.y1 - y) / B.h) * sInfo.h)));
    return sInfo.beach[r * sInfo.w + c];
  };
  function isBeachEdge(a, b) {
    const dx = b[0] - a[0], dn = b[1] - a[1], L = Math.hypot(dx, dn); if (L < 0.01) return false;
    return beachAt((a[0] + b[0]) / 2 + (dn / L) * 2, (a[1] + b[1]) / 2 - (dx / L) * 2) > 0.08;
  }
  {
    const pos = [], dd = [], nor = [], idx = []; let v = 0; const W = 11;
    for (const poly of landPolys) for (const ring of poly) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (!isBeachEdge(a, b)) continue;
      const dx = b[0] - a[0], dn = b[1] - a[1], L = Math.hypot(dx, dn);
      const lx = (-dn / L) * W, ly = (dx / L) * W; // inland (left of a CCW land ring)
      // tiny overlap past the coastline hides the seam with the sea plane below
      const ox = (dn / L) * 0.6, oy = (-dx / L) * 0.6;
      pos.push(a[0] + ox, 0.03, -(a[1] + oy), b[0] + ox, 0.03, -(b[1] + oy), b[0] + lx, 0.03, -(b[1] + ly), a[0] + lx, 0.03, -(a[1] + ly));
      dd.push(0, 0, 1, 1); for (let k = 0; k < 4; k++) nor.push(0, 1, 0);
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
    }
    if (idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('aD', new THREE.Float32BufferAttribute(dd, 1));
      g.setIndex(idx);
      const swashMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      swashMat.onBeforeCompile = (sh2) => {
        sh2.uniforms.uTime = uTime;
        sh2.vertexShader = sh2.vertexShader.replace('#include <common>', '#include <common>\nattribute float aD; varying float vD; varying vec3 vWP2;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvD = aD; vWP2 = (modelMatrix * vec4(position, 1.0)).xyz;');
        sh2.fragmentShader = sh2.fragmentShader.replace('#include <common>', `#include <common>\nuniform float uTime; varying float vD; varying vec3 vWP2;\n${GLSL_NOISE}\n${CAUSTICS}\nfloat swCover;`)
          .replace('#include <color_fragment>', `#include <color_fragment>
            {
              float t = uTime; vec2 p = vWP2.xz;
              float n = vnoise(p * 0.08 + t * 0.03);
              // each wave runs up the sand and slides back; reach varies along the beach
              float reach = 0.28 + 0.18 * sin(t * 0.42 + p.x * 0.021 - p.y * 0.017) + 0.14 * (n - 0.5);
              float cover = 1.0 - smoothstep(reach - 0.12, reach + 0.01, vD);
              float lace = vnoise(p * 0.9 + vec2(t * 0.3, 0.0)) * 0.6 + vnoise(p * 2.8) * 0.4;
              float front = smoothstep(reach - 0.07, reach, vD) * (1.0 - smoothstep(reach, reach + 0.035, vD)) * smoothstep(0.28, 0.68, lace);
              float wetBack = 1.0 - smoothstep(reach, reach + 0.32, vD);
              vec3 clearW = mix(SAND_BOTTOM, vec3(0.36, 0.78, 0.74), 0.5 * (1.0 - 0.65 * smoothstep(0.0, max(reach, 0.05), vD)));
              float cs = causticNet(p * 0.3 + 7.3, t * 1.2);
              float cfade = 1.0 - smoothstep(0.08, 0.3, length(fwidth(p * 0.3)));
              vec3 col = clearW + vec3(0.75, 0.9, 0.85) * cs * cfade * 0.3;
              col = mix(SAND_BOTTOM * 0.84, col, cover);
              col = mix(col, vec3(0.95, 0.97, 0.96), front * 0.9);
              diffuseColor.rgb = col;
              diffuseColor.a = clamp(max(cover * (0.94 - vD * 0.35), front) + wetBack * 0.3 * (1.0 - cover), 0.0, 1.0) * (1.0 - smoothstep(0.7, 1.0, vD));
              swCover = cover;
            }`)
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.85, 0.12, swCover);');
      };
      if (ctx.env) ctx.env.addReflective(swashMat, 0.4);
      const swash = new THREE.Mesh(g, swashMat);
      swash.receiveShadow = true; swash.renderOrder = 2; swash.name = 'swash';
      group.add(swash);
    }
  }

  // ------------------------------------------------------------------ coast walls (land edge drops to sea level)
  // a shoreline point backed by a rock revetment (a breakwater area just inland of it; lx, ly point inland)
  const bwBoxes = (A.breakwater || []).map((q) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const v of q[0]) { if (v[0] < x0) x0 = v[0]; if (v[0] > x1) x1 = v[0]; if (v[1] < y0) y0 = v[1]; if (v[1] > y1) y1 = v[1]; } return [x0 - 8, y0 - 8, x1 + 8, y1 + 8]; });
  const inRock = (x, y) => { for (let k = 0; k < bwBoxes.length; k++) { const bb = bwBoxes[k]; if (x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3] && pointInPoly([x, y], A.breakwater[k])) return true; } return false; };
  const rockShore = (x, y, lx, ly) => inRock(x + lx * 1.5, y + ly * 1.5) || inRock(x + lx * 4, y + ly * 4) || inRock(x - lx * 1.5, y - ly * 1.5);
  {
    const pos = [], nor = [], idx = [], led = []; let v = 0;
    const onEdge = (p) => Math.abs(p[0] - B.x0) < 0.6 || Math.abs(p[0] - B.x1) < 0.6 || Math.abs(p[1] - B.y0) < 0.6 || Math.abs(p[1] - B.y1) < 0.6;
    const marinaPolys = A.marina || [];
    for (const poly of landPolys) for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (onEdge(a) && onEdge(b)) continue;
        if (isBeachEdge(a, b)) continue;
        const dx = b[0] - a[0], dn = b[1] - a[1], L = Math.hypot(dx, dn); if (L < 0.01) continue;
        if (rockShore((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, -dn / L, dx / L)) continue; // the stones run into the water there
        const nx = dn / L, nz = dx / L;
        pos.push(a[0], SEA_Y - 0.2, -a[1], b[0], SEA_Y - 0.2, -b[1], b[0], 0.0, -b[1], a[0], 0.0, -a[1]);
        for (let k = 0; k < 4; k++) nor.push(nx, 0, nz);
        const mid = [(a[0] + b[0]) / 2 + (dn / L) * 3, (a[1] + b[1]) / 2 - (dx / L) * 3];
        const isMarina = marinaPolys.some((poly) => pointInPoly(mid, poly)) ? 1 : 0;
        led.push(isMarina, isMarina, isMarina, isMarina);
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('aLed', new THREE.Float32BufferAttribute(led, 1));
    geo.setIndex(idx);
    const wallMat = new THREE.MeshStandardMaterial({ color: '#c9b893', roughness: 0.9 });
    wallMat.onBeforeCompile = (s) => {
      s.uniforms.uNight = uNight;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aLed; varying float vLed; varying float vY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLed = aLed; vY = position.y;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying float vLed; varying float vY;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.12, 0.38, 1.0) * vLed * uNight * 3.0 * smoothstep(-0.42, -0.12, vY);');
    };
    const walls = new THREE.Mesh(geo, wallMat);
    walls.receiveShadow = true; group.add(walls);
  }

  // ------------------------------------------------------------------ breakwaters (rock), piers (deck), pools
  {
    const rockMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 });
    rockMat.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\n${GLSL_NOISE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            // the bed under the armour stones: dark between them up close, the stones' own mottled grey from afar
            vec2 rp = vWPos.xz;
            float rfar = smoothstep(0.12, 0.5, length(fwidth(rp)));
            vec3 far = vec3(0.47, 0.455, 0.42) * (0.82 + 0.36 * vnoise(rp * 0.9) * (0.6 + 0.4 * vnoise(rp * 3.1)));
            diffuseColor.rgb = mix(vec3(0.27, 0.26, 0.24), far, rfar);
          }`);
    };
    const rb = newBuilder();
    for (const l of data.paths.filter((p) => p.k === 'breakwater')) addRibbon(rb, l.p, l.w, SEA_Y + 0.06);
    const rockLines = new THREE.Mesh(builderGeometry(rb), rockMat);
    const rockAreas = new THREE.Mesh(polygonsGeometry(A.breakwater || [], SEA_Y + 0.06), rockMat);
    rockLines.receiveShadow = rockAreas.receiveShadow = true;
    group.add(rockLines, rockAreas);

    // The walk's side of a rock shore is a hard edge: a concrete kerb along every edge of the rock that is backed by
    // land, its face dropping to the stones, which lie lower than the walk.
    {
      const pos = [], nor = [], idx = []; let v = 0;
      const quad = (p0, p1, p2, p3, n) => { pos.push(...p0, ...p1, ...p2, ...p3); for (let k = 0; k < 4; k++) nor.push(...n); idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4; };
      const TOPY = 0.16, HALF = 0.55;
      for (const info of rockInfo.values()) for (const ring of info.rings) for (const e of ring) {
        if (!e.land) continue;
        const { a, b, nx, ny } = e;
        const P = (q, o, y) => [q[0] + nx * o, y, -(q[1] + ny * o)];
        quad(P(a, -HALF, TOPY), P(b, -HALF, TOPY), P(b, HALF, TOPY), P(a, HALF, TOPY), [0, 1, 0]);          // the kerb's top
        quad(P(a, -HALF, SEA_Y - 0.3), P(b, -HALF, SEA_Y - 0.3), P(b, -HALF, TOPY), P(a, -HALF, TOPY), [-nx, 0, ny]); // its face to the rock
      }
      if (idx.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setIndex(idx);
        const kerb = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#d9d3c6', roughness: 0.9, side: THREE.DoubleSide }));
        kerb.receiveShadow = true; kerb.name = 'rock-kerb'; group.add(kerb);
      }
    }
    // The water's side has no edge at all: a veil of the sea's own water lies over the foot of the rock, clear at
    // the rock and deepening to the open sea a few metres out, the way the sea meets the sand on the beaches.
    {
      const pos = [], nor = [], av = [], idx = []; let v = 0; const VY = SEA_Y + 0.38, IN = 2.2, OUTW = 7.0;
      for (const info of rockInfo.values()) for (const ring of info.rings) {
        const n = ring.length;
        // a shared direction at each corner (the mean of the two water-facing edges meeting there), so the veil is one strip
        const dir = ring.map((e, k) => {
          const pv = ring[(k + n - 1) % n];
          let x = (e.land ? 0 : e.nx) + (pv.land ? 0 : pv.nx), y = (e.land ? 0 : e.ny) + (pv.land ? 0 : pv.ny); const l = Math.hypot(x, y);
          if (l < 0.2) { x = e.land ? pv.nx : e.nx; y = e.land ? pv.ny : e.ny; } else { x /= l; y /= l; }
          return [x, y];
        });
        for (let k = 0; k < n; k++) {
          const e = ring[k]; if (e.land) continue;
          const d0 = dir[k], d1 = dir[(k + 1) % n];
          pos.push(e.a[0] - d0[0] * IN, VY, -(e.a[1] - d0[1] * IN), e.b[0] - d1[0] * IN, VY, -(e.b[1] - d1[1] * IN), e.b[0] + d1[0] * OUTW, VY, -(e.b[1] + d1[1] * OUTW), e.a[0] + d0[0] * OUTW, VY, -(e.a[1] + d0[1] * OUTW));
          av.push(0, 0, 1, 1); for (let q = 0; q < 4; q++) nor.push(0, 1, 0);
          idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
        }
      }
      if (idx.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
        g.setAttribute('aV', new THREE.Float32BufferAttribute(av, 1)); g.setIndex(idx);
        const veilMat = new THREE.MeshStandardMaterial({ color: 0x1b6fb0, roughness: 0.08, metalness: 0.0, transparent: true, depthWrite: false, side: THREE.DoubleSide });
        veilMat.onBeforeCompile = (sh) => {
          waterMat.onBeforeCompile(sh); // the sea's own colours, ripples and glitter
          sh.vertexShader = sh.vertexShader.replace('varying vec3 vWPos;', 'varying vec3 vWPos; attribute float aV; varying float vV;').replace('vWPos = (modelMatrix', 'vV = aV; vWPos = (modelMatrix');
          sh.fragmentShader = sh.fragmentShader.replace('varying vec3 vWPos;', 'varying vec3 vWPos; varying float vV;')
            .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
              {
                // clear over the stones, a lighter band of shallows, then the sea
                float vn = vnoise(vWPos.xz * 0.5) - 0.5;
                float vt = clamp(vV + vn * 0.14, 0.0, 1.0);
                diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.82, 0.78), (1.0 - smoothstep(0.3, 0.95, vt)) * 0.35);
                diffuseColor.a = smoothstep(0.24, 1.0, vt) * 0.97;
              }`);
        };
        veilMat.customProgramCacheKey = () => 'rock-veil';
        if (ctx.env) ctx.env.addReflective(veilMat, 0.3);
        const veil = new THREE.Mesh(g, veilMat);
        veil.receiveShadow = true; veil.renderOrder = 3; veil.name = 'rock-veil'; group.add(veil);
      }
    }

    // Armour stones: the breakwaters and revetments are built of small low-poly rocks (0.5-0.9 m), stacked. On a
    // shore they lie below the walk, highest against the kerb and sloping to the waterline, with a thinning scatter
    // under the shallows beyond it; a mole out in the water is a low mound. There are millions of stones over the
    // whole map, so they are made on demand in 60 m cells around the view once it is zoomed in enough to tell one
    // stone from the next, and let go behind it.
    {
      const CELL = RCELL, STEP = 0.8, MINZOOM = 5.0, MAXCELLS = 70, OUT = 5.5;
      const polys = A.breakwater || [];
      const lines = data.paths.filter((q) => q.k === 'breakwater');
      const key = (i, j) => i * 100003 + j;
      const index = new Map(); // cell -> { polys: Set, lines: Set }
      const touch = (x, y, kind, id) => {
        const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const k = key(ci + di, cj + dj); let e = index.get(k);
          if (!e) index.set(k, (e = { i: ci + di, j: cj + dj, polys: new Set(), lines: new Set() }));
          e[kind].add(id);
        }
      };
      const walk = (pts, closed, kind, id) => {
        for (let k = 0; k < pts.length - (closed ? 0 : 1); k++) {
          const a = pts[k], b = pts[(k + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / (CELL * 0.5)));
          for (let t = 0; t <= n; t++) touch(a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n, kind, id);
        }
      };
      polys.forEach((rings, id) => rings.forEach((r) => walk(r, true, 'polys', id)));
      lines.forEach((l, id) => walk(l.p, false, 'lines', id));
      // edges (pairs in a flat list) a ray along +x from the cell can cross, and the ones close enough to measure to
      const pickEdges = (rings, x0, y0, x1, y1, cross, near) => {
        for (const ring of rings) for (let k = 0; k < ring.length; k++) {
          const a = ring[k], b = ring[(k + 1) % ring.length], lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
          if (hi < y0 - 9 || lo > y1 + 9 || Math.max(a[0], b[0]) < x0 - 9) continue;
          if (hi >= y0 - OUT && lo <= y1 + OUT) cross.push(a, b);
          if (Math.min(a[0], b[0]) < x1 + 9) near.push(a, b);
        }
      };
      const isIn = (cross, px, py) => {
        let inside = false;
        for (let k = 0; k < cross.length; k += 2) {
          const a = cross[k], b = cross[k + 1];
          if ((a[1] > py) !== (b[1] > py) && px < a[0] + ((py - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
        }
        return inside;
      };
      const distTo = (near, px, py, cap) => {
        let d = cap;
        for (let k = 0; k < near.length; k += 2) {
          const a = near[k], b = near[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2)), dd = Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t);
          if (dd < d) d = dd;
        }
        return d;
      };

      // one stone: an icosahedron knocked out of round, flat-shaded; every instance turned, stretched and tinted
      const stone = new THREE.IcosahedronGeometry(1, 0);
      {
        const pa = stone.attributes.position, jr = mulberry(77), seen = new Map();
        for (let i = 0; i < pa.count; i++) {
          const kk = pa.getX(i).toFixed(3) + pa.getY(i).toFixed(3) + pa.getZ(i).toFixed(3);
          let f = seen.get(kk); if (!f) seen.set(kk, (f = 0.72 + jr() * 0.42));
          pa.setXYZ(i, pa.getX(i) * f, pa.getY(i) * f, pa.getZ(i) * f);
        }
        stone.computeVertexNormals(); stone.userData.shared = true;
      }
      const stoneMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.96, flatShading: true });
      const TONES = ['#b9b4aa', '#a5a096', '#cbc6ba', '#8f8b83', '#d8d3c8', '#aaa397', '#bdb6a6'].map((h) => new THREE.Color(h));
      const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e4 = new THREE.Euler(), p4 = new THREE.Vector3(), s4 = new THREE.Vector3(), c4 = new THREE.Color();
      const rocks = new THREE.Group(); rocks.name = 'armour-stones'; group.add(rocks);
      const built = new Map(); // cell key -> mesh (or null where nothing fell inside)
      // heights of a stone's centre: at the waterline, and at the crest against the kerb (with the layer resting on
      // it, still under the level of the walk)
      const LOW = SEA_Y + 0.03, TOP = -0.6, LIFT = 0.24, FOOT = SEA_Y + 0.02; // (the foot lies just over the sea bed, under the veil of clear water)

      function buildCell(e) {
        const x0 = e.i * CELL, y0 = e.j * CELL, x1 = x0 + CELL, y1 = y0 + CELL, rr = mulberry((e.i * 73856093) ^ (e.j * 19349663));
        // the shoreline near this cell, for the way to the water
        const lNear = [];
        for (let j = e.j - 1; j <= e.j + 1; j++) {
          const row = landRows.get(j); if (!row) continue;
          for (let k = 0; k < row.length; k += 2) {
            const a = row[k], b = row[k + 1];
            if (Math.max(a[0], b[0]) > x0 - 9 && Math.min(a[0], b[0]) < x1 + 9 && Math.max(a[1], b[1]) > y0 - 9 && Math.min(a[1], b[1]) < y1 + 9) lNear.push(a, b);
          }
        }
        const inst = []; // x, height of the stone's centre, y, layer
        const place = (px, py, h, sparse) => {
          // h: 0 at the waterline .. 1 at the crest (below 0: under the shallows)
          const yc = h >= 0 ? LOW + (TOP - LOW) * h : FOOT;
          inst.push(px, yc, py, 0);
          if (!sparse && h > 0.45 && rr() < 0.5) inst.push(px + (rr() - 0.5) * STEP, yc + LIFT, py + (rr() - 0.5) * STEP, 1);
        };
        for (const id of e.polys) {
          const cross = [], near = [];
          pickEdges(polys[id], x0, y0, x1, y1, cross, near);
          if (!cross.length && !near.length) continue;
          for (let y = y0; y < y1; y += STEP) for (let x = x0; x < x1; x += STEP) {
            const px = x + rr() * STEP, py = y + rr() * STEP;
            const inside = isIn(cross, px, py), dEdge = distTo(near, px, py, 7);
            if (!inside && dEdge > OUT) continue;
            const land = onLand(px, py), dSea = distTo(lNear, px, py, 8);
            if (inside) {
              if (land) place(px, py, Math.min(1, 0.08 + dSea / 5), false);                 // on the shore: rising from the water to the kerb
              else if (dSea >= 8) place(px, py, Math.min(0.7, dEdge / 4), false);            // a mole out in the water: a low mound
              else place(px, py, Math.max(-0.4, 0.06 - dSea / 6), true);                     // the rock's foot, past the waterline
            } else if (!land) {
              if (rr() < 1 - 0.75 * (dEdge / OUT)) place(px, py, -1, true);  // a thinning scatter under the shallows
            } else if (dSea < 3.2 && dEdge < 3.6) {
              place(px, py, Math.min(1, 0.08 + dSea / 5), false);                            // the strip between the mapped rock and the waterline
            }
          }
        }
        for (const id of e.lines) {
          const l = lines[id], hw = l.w / 2;
          for (let k = 1; k < l.p.length; k++) {
            const a = l.p[k - 1], b = l.p[k], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.3) continue;
            const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
            for (let t = 0; t < L; t += STEP) for (let o = -hw - 2; o < hw + 2; o += STEP) {
              const tt = t + rr() * STEP, oo = o + rr() * STEP, px = a[0] + ux * tt - uy * oo, py = a[1] + uy * tt + ux * oo;
              if (px < x0 || px >= x1 || py < y0 || py >= y1) continue;
              const d = hw - Math.abs(oo);
              if (d < 0) { if (rr() < 0.5) place(px, py, -0.3, true); } else place(px, py, Math.min(0.7, d / 4), false);
            }
          }
        }
        const n = inst.length / 4; if (!n) return null;
        const im = new THREE.InstancedMesh(stone, stoneMat, n);
        for (let i = 0; i < n; i++) {
          const top = inst[i * 4 + 3], sz = (top ? 0.27 : 0.33) + rr() * 0.15;
          e4.set(rr() * 6.28, rr() * 6.28, rr() * 6.28); q4.setFromEuler(e4);
          p4.set(inst[i * 4], inst[i * 4 + 1] + (rr() - 0.5) * 0.08, -inst[i * 4 + 2]);
          s4.set(sz * (0.9 + rr() * 0.5), sz * (0.62 + rr() * 0.3), sz * (0.9 + rr() * 0.5));
          m4.compose(p4, q4, s4); im.setMatrixAt(i, m4);
          // wet and darker at the waterline, dry and pale up the slope
          const wet = Math.min(1, Math.max(0, (inst[i * 4 + 1] - LOW) / 0.22));
          im.setColorAt(i, c4.copy(TONES[Math.floor(rr() * TONES.length)]).multiplyScalar((0.6 + 0.38 * wet) * (0.92 + rr() * 0.16)));
        }
        im.boundingSphere = new THREE.Sphere(new THREE.Vector3(x0 + CELL / 2, 0, -(y0 + CELL / 2)), CELL);
        im.receiveShadow = true; im.castShadow = false;
        return im;
      }
      let tickN = 0;
      ctx.updaters.push(() => {
        const cam = ctx.activeCamera, ortho = cam.isOrthographicCamera;
        const on = !ortho || cam.zoom >= MINZOOM;
        rocks.visible = on;
        if (++tickN % 2 || (ctx.isInteracting && ctx.isInteracting() && built.size > 4 && tickN % 8)) return;
        const f = ortho ? (ctx.focus ? ctx.focus() : ctx.controls.target) : cam.position;
        const fx = f.x, fy = -f.z;
        const R = !on ? -1 : ortho ? Math.min(420, (Math.hypot(cam.right - cam.left, cam.top - cam.bottom) / cam.zoom) * 0.6 + 40) : 260;
        // let go of cells behind the view
        for (const [k, im] of built) {
          const e = index.get(k), d = Math.hypot((e.i + 0.5) * CELL - fx, (e.j + 0.5) * CELL - fy);
          if (d > R + 160 || (built.size > MAXCELLS && d > R + 40)) { if (im) { rocks.remove(im); im.dispose(); } built.delete(k); }
        }
        if (R < 0) return;
        // make the nearest missing cell
        let best = null, bd = Infinity;
        const i0 = Math.floor((fx - R) / CELL), i1 = Math.floor((fx + R) / CELL), j0 = Math.floor((fy - R) / CELL), j1 = Math.floor((fy + R) / CELL);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const k = key(i, j); if (built.has(k)) continue;
          const e = index.get(k); if (!e) continue;
          const d = Math.hypot((i + 0.5) * CELL - fx, (j + 0.5) * CELL - fy);
          if (d < R && d < bd) { bd = d; best = e; }
        }
        if (best && built.size < MAXCELLS) { const im = buildCell(best); built.set(key(best.i, best.j), im); if (im) rocks.add(im); }
      });
    }

    const deckMat = new THREE.MeshStandardMaterial({ color: '#d8d1c4', roughness: 0.85 });
    const pb = newBuilder();
    for (const l of data.piers.lines) addRibbon(pb, l.p, l.w, 0.08);
    const pierLines = new THREE.Mesh(builderGeometry(pb), deckMat);
    const pierAreas = new THREE.Mesh(polygonsGeometry(data.piers.areas, 0.08), deckMat);
    pierLines.receiveShadow = pierAreas.receiveShadow = true;
    group.add(pierLines, pierAreas);

    // pools carry their own elevation (many sit on podium roofs); a band of pale stone coping runs round each
    const pools = new THREE.Mesh(polygonsGeometryWithZ(data.pools), makePoolMaterial(ctx));
    pools.receiveShadow = true; pools.name = 'pools';
    const cb = newBuilder();
    for (const it of data.pools) { const r = it.p[0]; if (r.length > 2) addRibbon(cb, r.concat([r[0], r[1]]).map((q) => [q[0], q[1], it.z]), 0.9, 0.13); }
    const coping = new THREE.Mesh(builderGeometry(cb), new THREE.MeshStandardMaterial({ color: '#efe8da', roughness: 0.8 }));
    coping.receiveShadow = true; coping.name = 'pool-coping';
    group.add(pools, coping);
  }

  // ------------------------------------------------------------------ diorama base with cross-section sides
  group.add(buildBase(B, landPolys));

  // a streamed section's ground (lawns, drives, walkways, bays): painted into the base and the tiles; the
  // base keeps it after the section leaves (it is cheap there and keeps the far view rich)
  async function addSection(id, sd, rects) {
    const L = sectionLists(sd, rects);
    SECS.set(id, L);
    invalidateTiles(L.bb);
    await repaintBase(L.bb);
  }
  function removeSection(id) { SECS.delete(id); }

  return { group, land, sea, waterMat, landPolys, shoreTex, uNight, uTime, addSection, removeSection, tex: { uGrid, uGridN, uBaseB, baseTex, detTex, detCls, indir } };
}

function polygonsGeometryWithZ(items) {
  const geos = items.map((it) => polygonsGeometry([it.p], it.z + 0.09));
  const pos = [], idx = [], pool = []; let base = 0;
  geos.forEach((g, gi) => {
    // pool coordinates from the outline's oriented box (see makePoolMaterial)
    const ring = items[gi].p[0], ob = obb(ring), q = g.attributes.position.array;
    const plain = ob && ring.length <= 5 && items[gi].p.length === 1 && Math.abs(signedArea(ring)) > ob.len * ob.wid * 0.9;
    for (let i = 0; i < q.length; i += 3) {
      if (!ob) { pool.push(0, 0, 1, -1); continue; }
      const dx = q[i] - ob.c[0], dy = -q[i + 2] - ob.c[1];
      pool.push(dx * ob.u[0] + dy * ob.u[1] + ob.len / 2, dx * ob.v[0] + dy * ob.v[1] + ob.wid / 2, ob.len, plain ? ob.wid : -ob.wid);
    }
  });
  for (const g of geos) {
    const p = g.attributes.position.array; for (let i = 0; i < p.length; i++) pos.push(p[i]);
    const ix = g.index.array; for (let i = 0; i < ix.length; i++) idx.push(ix[i] + base);
    base += p.length / 3; g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aPool', new THREE.Float32BufferAttribute(pool, 4));
  geo.setIndex(idx); geo.computeVertexNormals();
  return geo;
}

function makeShoreTexture(data, landPolys, B) {
  const w = Math.min(2048, Math.max(1024, Math.round(B.w / 4.2))), h = Math.round((w * B.h) / B.w);
  const K = 4.83 / (B.w / w); // blur radii below were tuned at 4.83 m per pixel
  const rr = (r) => Math.max(1, Math.round(r * K));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const sx = w / B.w, sy = h / B.h;
  const trace = (poly) => { for (const ring of poly) { ring.forEach((p, i) => (i ? g.lineTo((p[0] - B.x0) * sx, (B.y1 - p[1]) * sy) : g.moveTo((p[0] - B.x0) * sx, (B.y1 - p[1]) * sy))); g.closePath(); } };
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.beginPath(); for (const p of landPolys) trace(p); for (const p of data.areas.breakwater || []) trace(p); for (const p of data.piers.areas) trace(p); g.fill();
  g.strokeStyle = '#fff'; g.lineCap = 'round';
  for (const l of data.paths.filter((p) => p.k === 'breakwater')) { g.lineWidth = l.w * sx; g.beginPath(); l.p.forEach((p, i) => (i ? g.lineTo((p[0] - B.x0) * sx, (B.y1 - p[1]) * sy) : g.moveTo((p[0] - B.x0) * sx, (B.y1 - p[1]) * sy))); g.stroke(); }
  g.fillStyle = '#000'; g.beginPath(); for (const p of data.areas.water || []) trace(p); g.fill();
  const img = g.getImageData(0, 0, w, h).data;
  const mask = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = img[i * 4] / 255;
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.beginPath(); for (const p of data.areas.beach || []) trace(p); g.fill();
  const bimg = g.getImageData(0, 0, w, h).data;
  const beachRaw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) beachRaw[i] = bimg[i * 4] / 255;
  const beach = boxBlur(beachRaw, w, h, rr(7), 3);
  const near = boxBlur(mask, w, h, rr(4), 3);
  const wide = boxBlur(mask, w, h, rr(22), 3);
  const wetBlur = boxBlur(mask.map((m) => 1 - m), w, h, rr(2), 2); // land side: how close the water is
  const far = boxBlur(mask, w, h, rr(70), 2); // water side, ~1 km scale: open sea deepens away from the coast
  const out = new Uint8Array(w * h * 4);
  const info = { w, h, mask, near: new Float32Array(w * h), wide: new Float32Array(w * h) };
  for (let i = 0; i < w * h; i++) {
    // flip vertically so that v = 0 is south (DataTexture has no flipY)
    const x = i % w, y = (i / w) | 0, j = (h - 1 - y) * w + x;
    const m = mask[i];
    const nr = m > 0.5 ? 1 : Math.min(1, near[i] * 1.8), wd = m > 0.5 ? 1 : Math.min(1, wide[i] * 2.2);
    out[j * 4] = nr * 255; out[j * 4 + 1] = wd * 255;
    out[j * 4 + 2] = Math.min(255, beach[i] * 3 * 255); out[j * 4 + 3] = m > 0.5 ? Math.min(255, wetBlur[i] * 2.4 * 255) : Math.min(255, far[i] * 2.0 * 255);
    info.near[i] = nr; info.wide[i] = wd;
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  info.beach = beach;
  tex.userData.info = info; // CPU copy (row 0 = north) for placing things on the water
  return tex;
}

// Separable box blur (sliding sums). Both passes walk memory row by row: the vertical pass keeps one running sum
// per column instead of striding down columns, which is several times faster on wide maps.
function boxBlur(src, w, h, r, passes) {
  const a = Float32Array.from(src), b = new Float32Array(w * h), col = new Float64Array(w);
  const inv = 1 / (2 * r + 1), last = w - 1, lastRow = h - 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) { // horizontal: a -> b
      const row = y * w;
      let s = 0;
      for (let x = -r; x <= r; x++) s += a[row + (x < 0 ? 0 : x > last ? last : x)];
      for (let x = 0; x < w; x++) {
        b[row + x] = s * inv;
        const xa = x + r + 1, xs = x - r;
        s += a[row + (xa > last ? last : xa)] - a[row + (xs < 0 ? 0 : xs)];
      }
    }
    col.fill(0); // vertical: b -> a
    for (let y = -r; y <= r; y++) { const row = (y < 0 ? 0 : y > lastRow ? lastRow : y) * w; for (let x = 0; x < w; x++) col[x] += b[row + x]; }
    for (let y = 0; y < h; y++) {
      const row = y * w, ya = y + r + 1, ys = y - r;
      const add = (ya > lastRow ? lastRow : ya) * w, sub = (ys < 0 ? 0 : ys) * w;
      for (let x = 0; x < w; x++) { a[row + x] = col[x] * inv; col[x] += b[add + x] - b[sub + x]; }
    }
  }
  return a;
}

function buildBase(B, landPolys) {
  const DEPTH = 70, SPLIT = 9;
  const pos = [], colr = [], nor = [], idx = []; let v = 0;
  const cLandTop = new THREE.Color('#d6bd92'), cLandMid = new THREE.Color('#8c6d48'), cLandBot = new THREE.Color('#2a221b');
  const cSeaTop = new THREE.Color('#2f7fc0'), cSeaMid = new THREE.Color('#0f3f74'), cSeaBot = new THREE.Color('#0a1a30');
  const isLand = (x, y) => landPolys.some((p) => pointInPoly([x, y], p));
  const edges = [
    { a: [B.x0, B.y0], b: [B.x1, B.y0], n: [0, 0, 1], inset: [0, 1] },   // south side faces +z
    { a: [B.x1, B.y0], b: [B.x1, B.y1], n: [1, 0, 0], inset: [-1, 0] },  // east
    { a: [B.x1, B.y1], b: [B.x0, B.y1], n: [0, 0, -1], inset: [0, -1] }, // north
    { a: [B.x0, B.y1], b: [B.x0, B.y0], n: [-1, 0, 0], inset: [1, 0] },  // west
  ];
  for (const e of edges) {
    const L = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]); const N = Math.ceil(L / 12);
    for (let i = 0; i < N; i++) {
      const t0 = i / N, t1 = (i + 1) / N;
      const p0 = [e.a[0] + (e.b[0] - e.a[0]) * t0, e.a[1] + (e.b[1] - e.a[1]) * t0];
      const p1 = [e.a[0] + (e.b[0] - e.a[0]) * t1, e.a[1] + (e.b[1] - e.a[1]) * t1];
      const mid = [(p0[0] + p1[0]) / 2 + e.inset[0] * 1.5, (p0[1] + p1[1]) / 2 + e.inset[1] * 1.5];
      const land = isLand(mid[0], mid[1]);
      const top = land ? 0 : SEA_Y;
      const [ct, cm, cb] = land ? [cLandTop, cLandMid, cLandBot] : [cSeaTop, cSeaMid, cSeaBot];
      for (const [y0, y1, c0, c1] of [[top, -SPLIT, ct, cm], [-SPLIT, -DEPTH, cm, cb]]) {
        // quad facing outward: (p0,y0) (p1,y0) (p1,y1) (p0,y1) with CCW seen from outside
        pos.push(p0[0], y0, -p0[1], p0[0], y1, -p0[1], p1[0], y1, -p1[1], p1[0], y0, -p1[1]);
        for (const c of [c0, c1, c1, c0]) colr.push(c.r, c.g, c.b);
        for (let k = 0; k < 4; k++) nor.push(...e.n);
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
  mesh.name = 'base';
  return mesh;
}
