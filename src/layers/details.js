// Neighbourhood "life": plot walls & hedges, private pools, parked cars, zebra crossings, street lamps, beach umbrellas.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { freeAfterUpload, rng, signedArea } from '../core/util.js';
import { CAR_KINDS, CAR_COLORS } from './vehicles.js';
const CAR_GEO = new Map(); // one geometry per kind, shared by every cell's parked cars
const getCarGeo = (k, K) => { let g = CAR_GEO.get(k); if (!g) { g = K.make(); g.userData.shared = true; CAR_GEO.set(k, g); } return g; };
import { SEA_Y, makePoolMaterial } from './ground.js';

function colorGeo(geo, color, extra) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  if (extra) for (const [k, v] of Object.entries(extra)) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n).fill(v), 1));
  return g;
}

export function buildDetails(ctx) {
  const { data, scene } = ctx;
  const group = new THREE.Group(); group.name = 'details'; scene.add(group);
  const uNight = { value: 0 };
  ctx.on('time', (s) => { uNight.value = s.night; });
  const r = rng(8080);
  const bInfo = data.buildings;

  // ------------------------------------------------------------ plot boundary walls / hedges
  {
    const pos = [], nor = [], col = [], idx = []; let v = 0;
    const box = (a, b, h, t, c, z0 = 0) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); if (L < 0.6) return;
      const ux = dx / L, uy = dy / L, nx = -uy * t / 2, ny = ux * t / 2;
      const P = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
      const faces = [[0, 1], [2, 3]]; // the 0.3 m end caps are never seen
      for (const [i0, i1] of faces) {
        const p0 = P[i0], p1 = P[i1]; const ex = p1[0] - p0[0], ey = p1[1] - p0[1], el = Math.hypot(ex, ey) || 1;
        const n = [ey / el, 0, ex / el];
        pos.push(p0[0], z0, -p0[1], p1[0], z0, -p1[1], p1[0], h, -p1[1], p0[0], h, -p0[1]);
        for (let k = 0; k < 4; k++) { nor.push(...n); col.push(c.r * (k > 1 ? 1 : 0.82), c.g * (k > 1 ? 1 : 0.82), c.b * (k > 1 ? 1 : 0.82)); }
        idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
      }
      for (const p of P) { pos.push(p[0], h, -p[1]); nor.push(0, 1, 0); col.push(c.r * 1.05, c.g * 1.05, c.b * 1.05); }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
    };
    // researched communities: Sidra has a low white wall with a grey bar railing along the street (the carport stays
    // open to it) and solid white walls about 2 m high along the sides and the back
    const SIDRA_WALL = new THREE.Color('#e9e8e2'), SIDRA_RAIL = new THREE.Color('#4e5154');
    const GP_WALL = new THREE.Color('#ece4cf'), GP_STONE = new THREE.Color('#d8cdba'), PAIR_WALL = new THREE.Color('#e4dccf');
    // mansions (Hills Grove / Hills View): a white front wall with a dark slatted infill between a low base and a top
    // beam, tall rendered walls round the rest; custom villas: solid rendered walls; the Vistas: open lawns at the
    // front, low white party walls, a low wall with a slatted metal fence along the golf side
    const MAN_WALL = new THREE.Color('#efeee9'), MAN_SLAT = new THREE.Color('#3a3936'), LUX_WALL = new THREE.Color('#ecebe6'), LUX_FENCE = new THREE.Color('#3f4245');
    // Emirates Hills: a rendered base wall with piers' worth of height, black metal railings over it and a clipped
    // hedge behind along the street; tall rendered walls screened by hedges round the rest of the plot
    const EH_PLINTH = new THREE.Color('#cdbfa6'), EH_WALL = new THREE.Color('#ece3d3'), EH_CAP = new THREE.Color('#f5efe3'), EH_RAIL = new THREE.Color('#232220'), EH_GOLD = new THREE.Color('#b8923e'), EH_HEDGE = new THREE.Color('#3f6d2e');
    const kitWalls = (pl, b, style = 'sidra') => {
      const gp = style === 'golfplace';
      const ring = signedArea(pl.p) < 0 ? pl.p.slice().reverse() : pl.p;
      const f = b.hf != null ? [Math.cos(b.hf), Math.sin(b.hf)] : null;
      const drv = pl.dr ? [pl.dr[2], pl.dr[3]] : null, gateHalf = pl.dr ? pl.dr[4] / 2 + 0.2 : 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b2 = ring[(i + 1) % ring.length];
        const dx = b2[0] - a[0], dy = b2[1] - a[1], L = Math.hypot(dx, dy); if (L < 0.6) continue;
        const front = f && (dy / L) * f[0] - (dx / L) * f[1] > 0.6; // outward normal of a CCW ring faces the street
        const open = pl.ov && pl.ov.includes(i); // an edge onto the golf course or a lake
        const onMain = pl.mr && pl.mr.includes(i); // an edge onto a main road
        const run = (p, q) => {
          if (!front && style === 'eh' && onMain) {
            // along the main roads: a clipped hedge 4-5 m tall on a stone-clad plinth
            box(p, q, 1.0, 1.3, EH_PLINTH); box(p, q, 4.6, 1.2, EH_HEDGE, 1.0);
            return;
          }
          if (!front && style === 'eh' && open) {
            // onto the course or a lake: a low rendered wall with black railings, the view kept open
            box(p, q, 0.9, 0.36, EH_WALL); box(p, q, 1.85, 0.05, EH_RAIL, 0.9); box(p, q, 1.92, 0.08, EH_WALL, 1.85);
            return;
          }
          if (!front && style === 'eh') {
            box(p, q, 2.6, 0.26, EH_WALL);
            const L2 = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, ix = -(q[1] - p[1]) / L2 * 0.8, iy = (q[0] - p[0]) / L2 * 0.8;
            box([p[0] + ix, p[1] + iy], [q[0] + ix, q[1] + iy], 3.2, 1.0, EH_HEDGE);
            return;
          }
          if (!front) { box(p, q, style === 'mansion' ? 2.2 : 2.0, 0.22, gp ? GP_WALL : style === 'sidra' ? SIDRA_WALL : MAN_WALL); return; }
          if (gp) { box(p, q, 1.15, 0.3, GP_STONE); return; } // Golf Place: a low travertine-clad wall
          if (style === 'mansion') { box(p, q, 0.75, 0.34, MAN_WALL); box(p, q, 1.7, 0.06, MAN_SLAT, 0.75); box(p, q, 1.84, 0.34, MAN_WALL, 1.7); return; }
          if (style === 'custom') { box(p, q, 1.5, 0.25, MAN_WALL); return; }
          if (style === 'eh') {
            // a low cream base wall, black railings with gilded spear tips, cream piers with caps every 3.6 m
            box(p, q, 0.75, 0.42, EH_WALL); box(p, q, 2.05, 0.05, EH_RAIL, 0.75); box(p, q, 2.12, 0.07, EH_GOLD, 2.05);
            const L2 = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, ux = (q[0] - p[0]) / L2, uy = (q[1] - p[1]) / L2;
            for (let s2 = 0; s2 <= L2 + 0.01; s2 += Math.max(2.4, L2 / Math.max(1, Math.round(L2 / 3.6)))) {
              const c0 = [p[0] + ux * (s2 - 0.3), p[1] + uy * (s2 - 0.3)], c1 = [p[0] + ux * (s2 + 0.3), p[1] + uy * (s2 + 0.3)];
              box(c0, c1, 2.45, 0.6, EH_WALL); box([c0[0] - ux * 0.06, c0[1] - uy * 0.06], [c1[0] + ux * 0.06, c1[1] + uy * 0.06], 2.62, 0.72, EH_CAP, 2.45);
            }
            // the clipped hedge on the street side
            const ox = (q[1] - p[1]) / L2 * 0.85, oy = -(q[0] - p[0]) / L2 * 0.85;
            box([p[0] + ox, p[1] + oy], [q[0] + ox, q[1] + oy], 1.25, 0.95, EH_HEDGE);
            return;
          }
          box(p, q, 0.95, 0.24, SIDRA_WALL);
          box(p, q, 1.45, 0.05, SIDRA_RAIL, 0.95);
        };
        if (front && drv) {
          let t = ((drv[0] - a[0]) * dx + (drv[1] - a[1]) * dy) / (L * L); t = Math.max(0, Math.min(1, t));
          const q = [a[0] + dx * t, a[1] + dy * t];
          if (Math.hypot(q[0] - drv[0], q[1] - drv[1]) < 4) {
            const g = gateHalf / L;
            if (t - g > 0.02) run(a, [a[0] + dx * (t - g), a[1] + dy * (t - g)]);
            if (t + g < 0.98) run([a[0] + dx * (t + g), a[1] + dy * (t + g)], b2);
            continue;
          }
        }
        run(a, b2);
      }
    };
    // Maple: open frontages (no front walls), ~2 m rendered walls along the sides and the back of the gardens
    const MAPLE_WALL = new THREE.Color('#d9ccb0'), MAPLE3_WALL = new THREE.Color('#ecebe6');
    const openFrontWalls = (pl, b, col, fenceBack = false) => {
      const ring = signedArea(pl.p) < 0 ? pl.p.slice().reverse() : pl.p;
      const f = b.hf != null ? [Math.cos(b.hf), Math.sin(b.hf)] : null;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b2 = ring[(i + 1) % ring.length];
        const dx = b2[0] - a[0], dy = b2[1] - a[1], L = Math.hypot(dx, dy); if (L < 0.6) continue;
        const dot = f ? (dy / L) * f[0] - (dx / L) * f[1] : 0;
        if (dot > 0.5) continue;
        if (fenceBack && dot < -0.6) { box(a, b2, 0.6, 0.26, col); box(a, b2, 1.5, 0.05, LUX_FENCE, 0.6); continue; }
        box(a, b2, fenceBack ? 1.8 : 2.0, 0.22, col);
      }
    };
    const JI_WALL = new THREE.Color('#e9dfc8'), JI_HEDGE = new THREE.Color('#4f7a34');
    for (const pl of data.plots) {
      const b = bInfo[pl.b] || {};
      if (pl.k === 'sidra') { kitWalls(pl, b); continue; }
      if (pl.k === 'maple') { openFrontWalls(pl, b, /Maple 3/i.test(b.hs || '') ? MAPLE3_WALL : MAPLE_WALL); continue; }
      if (pl.k === 'pair') { openFrontWalls(pl, b, PAIR_WALL); continue; }
      if (pl.k === 'golfplace') { kitWalls(pl, b, 'golfplace'); continue; }
      if (pl.k === 'luxury') { openFrontWalls(pl, b, LUX_WALL, true); continue; }
      if (pl.k === 'mansion' || pl.k === 'custom' || pl.k === 'eh') { kitWalls(pl, b, pl.k); continue; }
      if (pl.k === 'ji') {
        // Jumeirah Islands (street and garden photographs): open front lawns with no gates, clipped hedges between
        // the plots, a low rendered wall with a black rail fence along the back of the garden
        const ring = signedArea(pl.p) < 0 ? pl.p.slice().reverse() : pl.p;
        const f = b.hf != null ? [Math.cos(b.hf), Math.sin(b.hf)] : null;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b2 = ring[(i + 1) % ring.length];
          const dx = b2[0] - a[0], dy = b2[1] - a[1], L = Math.hypot(dx, dy); if (L < 0.6) continue;
          const dot = f ? (dy / L) * f[0] - (dx / L) * f[1] : 0;
          if (dot > 0.5) continue;
          if (dot < -0.6) { box(a, b2, 0.45, 0.26, JI_WALL); box(a, b2, 1.3, 0.05, LUX_FENCE, 0.45); continue; }
          box(a, b2, 1.5, 0.9, JI_HEDGE);
        }
        continue;
      }
      const hedge = r() < (b.d === 'springs' ? 0.1 : 0.22);
      const c = new THREE.Color(hedge ? (r() < 0.5 ? '#4e7d36' : '#5b8a3c') : b.d === 'springs' ? '#f0ece3' : b.v === 'm' ? '#e9e8e4' : (r() < 0.5 ? '#e4d3b2' : '#dccaa5'));
      const ring = signedArea(pl.p) < 0 ? pl.p.slice().reverse() : pl.p;
      const drv = pl.dr ? [pl.dr[2], pl.dr[3]] : null;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b2 = ring[(i + 1) % ring.length];
        // leave a gate where the driveway meets the street
        if (drv) {
          const dx = b2[0] - a[0], dy = b2[1] - a[1], L2 = dx * dx + dy * dy || 1;
          let t = ((drv[0] - a[0]) * dx + (drv[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t));
          const q = [a[0] + dx * t, a[1] + dy * t];
          if (Math.hypot(q[0] - drv[0], q[1] - drv[1]) < 3) {
            const L = Math.sqrt(L2), gate = 3.2 / L;
            if (t - gate > 0.02) box(a, [a[0] + dx * (t - gate), a[1] + dy * (t - gate)], hedge ? 1.5 : 1.9, hedge ? 0.9 : 0.28, c);
            if (t + gate < 0.98) box([a[0] + dx * (t + gate), a[1] + dy * (t + gate)], b2, hedge ? 1.5 : 1.9, hedge ? 0.9 : 0.28, c);
            continue;
          }
        }
        box(a, b2, hedge ? 1.5 : 1.9, hedge ? 0.9 : 0.28, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(Int8Array.from(nor, (x) => Math.round(x * 127)), 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(Uint8Array.from(col, (x) => Math.round(Math.min(1, x) * 255)), 3, true));
    g.setIndex(idx);
    freeAfterUpload(g);
    const walls = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    walls.castShadow = true; walls.receiveShadow = true; walls.name = 'plot-walls';
    group.add(walls);
  }

  // ------------------------------------------------------------ private pools with stone coping
  {
    const water = [], coping = [], poolUV = [];
    const rect = (cx, cy, ang, L, W, y, arr) => {
      const c = Math.cos(ang), s = Math.sin(ang);
      const P = [[-L / 2, -W / 2], [L / 2, -W / 2], [L / 2, W / 2], [-L / 2, W / 2]].map(([a, b]) => [cx + a * c - b * s, cy + a * s + b * c]);
      arr.push(...P.flatMap((p) => [p[0], y, -p[1]]));
    };
    for (const pl of data.plots) if (pl.pool) {
      const [x, y, a, L, W] = pl.pool;
      rect(x, y, a, L + 1.4, W + 1.4, 0.14, coping);
      rect(x, y, a, L, W, 0.17, water);
      poolUV.push(0, 0, L, W, L, 0, L, W, L, W, L, W, 0, W, L, W); // metres along and across, length, width
    }
    const quadsGeo = (arr) => {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const n = arr.length / 12, idx = []; for (let i = 0; i < n; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
      g.setIndex(idx); g.computeVertexNormals(); return g;
    };
    const copeMesh = new THREE.Mesh(quadsGeo(coping), new THREE.MeshStandardMaterial({ color: '#e9e1d2', roughness: 0.8 }));
    const poolGeo = quadsGeo(water);
    poolGeo.setAttribute('aPool', new THREE.Float32BufferAttribute(poolUV, 4));
    const poolMesh = new THREE.Mesh(poolGeo, makePoolMaterial(ctx));
    copeMesh.receiveShadow = poolMesh.receiveShadow = true;
    group.add(copeMesh, poolMesh);
  }

  // ------------------------------------------------------------ parked cars (parking lots + driveways)
  {
    // the same models as the traffic (vehicles.js), one instanced mesh per kind: saloons, SUVs, hatchbacks, pickups
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.3 });
    const cars = data.parked;
    const KINDS = CAR_KINDS.filter((K) => !K.fixed), cut = [0.35, 0.74, 0.87, 0.94, 1.01];
    const byKind = KINDS.map(() => []);
    cars.forEach((car) => { const h = ((car[3] * 2654435761) >>> 0) / 4294967296; byKind[Math.min(KINDS.length - 1, cut.findIndex((v) => h < v))].push(car); });
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    const total = CAR_COLORS.reduce((s, x) => s + x[1], 0);
    byKind.forEach((list, k) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(getCarGeo(k, KINDS[k]), mat, list.length);
      list.forEach((car, i) => {
        p.set(car[0], 0.1, -car[1]); q.setFromAxisAngle(up, car[2]); m.compose(p, q, one); im.setMatrixAt(i, m);
        let x = ((car[3] * 7919) % 1000) / 1000 * total, pick = '#ffffff';
        for (const [cc, w] of CAR_COLORS) { x -= w; if (x <= 0) { pick = cc; break; } }
        if (KINDS[k].colors) pick = KINDS[k].colors[(car[3] * 31) % KINDS[k].colors.length | 0];
        im.setColorAt(i, c.set(pick));
      });
      im.receiveShadow = true; im.castShadow = false; im.name = 'parked-cars';
      group.add(im);
    });
  }

  // ------------------------------------------------------------ parking bay markings (painted side lines)
  {
    const pos = [], col = [];
    const white = new THREE.Color('#f3f1ea'), soft = new THREE.Color('#dcd2c3');
    for (const [x, y, a, s] of data.bays || []) {
      const c = Math.cos(a), sn = Math.sin(a), hd = 2.5, hw = 1.2, t = 0.055;
      const k = s === 1 ? soft : white;
      const lines = s === 3 ? [[-1, 'end'], [1, 'end']] : [[-1, 'side'], [1, 'side']];
      for (const [side, kind] of lines) {
        const P = kind === 'side'
          ? [[-hd, side * hw - t], [hd, side * hw - t], [hd, side * hw + t], [-hd, side * hw + t]]
          : [[side * hd - t, -hw], [side * hd + t, -hw], [side * hd + t, hw], [side * hd - t, hw]];
        const W = P.map(([u, v]) => [x + u * c - v * sn, y + u * sn + v * c]);
        pos.push(...[W[0], W[1], W[2], W[0], W[2], W[3]].flatMap((p) => [p[0], 0.045, -p[1]]));
        for (let i = 0; i < 6; i++) col.push(k.r, k.g, k.b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide, depthWrite: false }));
    m.receiveShadow = true; m.renderOrder = 2; m.name = 'parking-bays';
    group.add(m);
  }

  // ------------------------------------------------------------ shade canopies over some parking rows
  if ((data.canopies || []).length) {
    const COLS = ['#f2f0ea', '#d9c7a3', '#4a7257', '#3a5781'];
    const panelGeo = new THREE.BoxGeometry(5.6, 0.1, 2.52).translate(-0.2, 2.75, 0);
    const postGeo = new THREE.BoxGeometry(0.16, 2.75, 0.16).translate(2.35, 1.375, 1.15);
    const panels = new THREE.InstancedMesh(panelGeo, new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide }), data.canopies.length);
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: '#9aa0a5', roughness: 0.5, metalness: 0.5 }), data.canopies.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    data.canopies.forEach(([x, y, a, k], i) => {
      p.set(x, 0, -y); q.setFromAxisAngle(up, a); m4.compose(p, q, one);
      panels.setMatrixAt(i, m4); posts.setMatrixAt(i, m4);
      panels.setColorAt(i, c.set(COLS[k % COLS.length]));
    });
    panels.castShadow = posts.castShadow = true; panels.receiveShadow = true;
    panels.name = 'parking-canopies'; posts.name = 'canopy-posts';
    group.add(panels, posts);
  }

  // ------------------------------------------------------------ zebra crossings
  {
    const pos = [];
    for (const [x, y, ang, w] of data.xwalks) {
      const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
      const n = Math.max(2, Math.floor((w - 1) / 1.1));
      for (let k = 0; k < n; k++) {
        const o = -((n - 1) * 1.1) / 2 + k * 1.1;
        const cx = x + nx * o, cy = y + ny * o;
        const hw = 0.28, hd = 1.6;
        const P = [[-hd, -hw], [hd, -hw], [hd, hw], [-hd, hw]].map(([a, b]) => [cx + ux * a + nx * b, cy + uy * a + ny * b]);
        pos.push(...[P[0], P[1], P[2], P[0], P[2], P[3]].flatMap((pp) => [pp[0], 0.17, -pp[1]]));
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
    // make sure faces point up
    const nrm = g.attributes.normal; for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#f1f1ec', roughness: 0.7, side: THREE.DoubleSide, depthWrite: false }));
    mesh.receiveShadow = true; mesh.renderOrder = 2; mesh.name = 'crosswalks';
    group.add(mesh);
  }

  // ------------------------------------------------------------ street lamps (glow at night)
  {
    const pole = colorGeo(new THREE.CylinderGeometry(0.09, 0.14, 9, 6).translate(0, 4.5, 0), '#8d9296');
    const arm = colorGeo(new THREE.BoxGeometry(2.2, 0.1, 0.1).translate(1.1, 8.85, 0), '#8d9296');
    const head = colorGeo(new THREE.BoxGeometry(0.75, 0.16, 0.34).translate(2.1, 8.75, 0), '#fff4d6', { aLight: 1 });
    pole.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(pole.attributes.position.count), 1));
    arm.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(arm.attributes.position.count), 1));
    // style 1, the Dubai Hills columns (street photographs): a slim square bronze post with an L arm and a flat LED head
    const pole1 = colorGeo(new THREE.BoxGeometry(0.16, 7, 0.16).translate(0, 3.5, 0), '#5a4535');
    const arm1 = colorGeo(new THREE.BoxGeometry(1.5, 0.12, 0.12).translate(0.75, 6.94, 0), '#5a4535');
    const head1 = colorGeo(new THREE.BoxGeometry(0.55, 0.08, 0.2).translate(1.25, 6.85, 0), '#fff4d6', { aLight: 1 });
    for (const g of [pole1, arm1]) g.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
    // style 2, Emirates Hills avenues: a grey octagonal column about 10.5 m with an LED head; style 3, its residential
    // streets and lake walks: a black post-top lamp about 4.5 m with a disc head (landscape research)
    const pole2 = colorGeo(new THREE.CylinderGeometry(0.1, 0.17, 10.5, 8).translate(0, 5.25, 0), '#8f959a');
    const arm2 = colorGeo(new THREE.BoxGeometry(1.7, 0.1, 0.1).translate(0.85, 10.35, 0), '#8f959a');
    const head2 = colorGeo(new THREE.BoxGeometry(0.7, 0.12, 0.3).translate(1.6, 10.25, 0), '#fff4d6', { aLight: 1 });
    const pole3 = colorGeo(new THREE.CylinderGeometry(0.06, 0.09, 4.4, 8).translate(0, 2.2, 0), '#1e1e1f');
    const cap3 = colorGeo(new THREE.CylinderGeometry(0.36, 0.3, 0.1, 16).translate(0, 4.5, 0), '#1e1e1f');
    const head3 = colorGeo(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 16).translate(0, 4.42, 0), '#fff4d6', { aLight: 1 });
    for (const g of [pole2, arm2, pole3, cap3]) g.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
    // style 4, Jumeirah Islands clusters (street photographs): a dark post about 6.5 m with a swan neck and a bell shade
    const pole4 = colorGeo(new THREE.CylinderGeometry(0.06, 0.1, 6.0, 8).translate(0, 3.0, 0), '#2a2c2e');
    const neck4 = colorGeo(new THREE.TorusGeometry(0.45, 0.04, 6, 10, Math.PI).translate(0.45, 6.0, 0), '#2a2c2e');
    const bell4 = colorGeo(new THREE.CylinderGeometry(0.1, 0.36, 0.34, 12).translate(0.9, 5.85, 0), '#2a2c2e');
    const head4 = colorGeo(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12).translate(0.9, 5.66, 0), '#fff4d6', { aLight: 1 });
    for (const g of [pole4, neck4, bell4]) g.setAttribute('aLight', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
    const geos = [mergeGeometries([pole, arm, head]), mergeGeometries([pole1, arm1, head1]), mergeGeometries([pole2, arm2, head2]), mergeGeometries([pole3, cap3, head3]), mergeGeometries([pole4, neck4, bell4, head4])], reach = [2.1, 1.25, 1.6, 0, 0.9];
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 });
    mat.onBeforeCompile = (s) => {
      s.uniforms.uNight = uNight;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aLight; varying float vLight;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = aLight;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying float vLight;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vec3(1.0, 0.78, 0.45) * vLight * uNight * 6.0;');
    };
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    for (const st of [0, 1, 2, 3, 4]) {
      const list = data.lamps.filter((l) => (l[3] || 0) === st); if (!list.length) continue;
      const im = new THREE.InstancedMesh(geos[st], mat, list.length);
      list.forEach((l, i) => { p.set(l[0], 0, -l[1]); q.setFromAxisAngle(up, l[2]); m.compose(p, q, one); im.setMatrixAt(i, m); });
      im.castShadow = true; im.name = st ? 'street-lamps-estate-' + st : 'street-lamps';
      group.add(im);
    }
    // light pools under each lamp head (additive, only after dark)
    const pool = new THREE.PlaneGeometry(22, 22).rotateX(-Math.PI / 2);
    const pmat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uNight },
      vertexShader: 'varying vec2 vU; void main(){ vU = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uNight; varying vec2 vU; void main(){ float r = length(vU); float a = pow(max(0.0, 1.0 - r), 2.2) * uNight; gl_FragColor = vec4(vec3(1.0, 0.78, 0.5) * a * 0.42, 1.0); }',
    });
    const pools = new THREE.InstancedMesh(pool, pmat, Math.max(1, data.lamps.length));
    data.lamps.forEach((l, i) => { const r = reach[l[3] || 0]; p.set(l[0] + Math.cos(l[2]) * r, 0.24, -(l[1] + Math.sin(l[2]) * r)); m.compose(p, q.identity(), one); pools.setMatrixAt(i, m); });
    pools.count = data.lamps.length; pools.renderOrder = 4; pools.name = 'lamp-pools'; pools.frustumCulled = false;
    ctx.on('time', (s) => { pools.visible = s.night > 0.02; });
    group.add(pools);
  }

  // ------------------------------------------------------------ beach umbrellas + sun loungers
  {
    const canopy = new THREE.ConeGeometry(1.35, 0.55, 10, 1, true).translate(0, 2.35, 0);
    const poleG = new THREE.CylinderGeometry(0.035, 0.035, 2.4, 4).translate(0, 1.2, 0);
    const umbrellaGeo = mergeGeometries([colorGeo(canopy, '#ffffff'), colorGeo(poleG, '#c9c2b4')]);
    const loungerGeo = mergeGeometries([
      colorGeo(new THREE.BoxGeometry(1.9, 0.12, 0.66).translate(0.2, 0.32, -1.25), '#f6f4ee'),
      colorGeo(new THREE.BoxGeometry(0.6, 0.12, 0.66).rotateZ(0.55).translate(-0.85, 0.5, -1.25), '#f6f4ee'),
      colorGeo(new THREE.BoxGeometry(1.9, 0.12, 0.66).translate(0.2, 0.32, 1.25), '#f6f4ee'),
      colorGeo(new THREE.BoxGeometry(0.6, 0.12, 0.66).rotateZ(0.55).translate(-0.85, 0.5, 1.25), '#f6f4ee'),
    ]);
    const COLS = [['#fbfaf6', 35], ['#efe3c8', 20], ['#24427a', 15], ['#e07a2f', 10], ['#2bb3b8', 10], ['#c8343a', 10]];
    const um = new THREE.InstancedMesh(umbrellaGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }), Math.max(1, data.umbrellas.length));
    const lm = new THREE.InstancedMesh(loungerGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), Math.max(1, data.umbrellas.length));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    data.umbrellas.forEach((u, i) => {
      p.set(u[0], 0, -u[1]); q.setFromAxisAngle(up, 0.7 + (u[2] % 7) * 0.03); m.compose(p, q, one);
      um.setMatrixAt(i, m); lm.setMatrixAt(i, m);
      let x = (u[2] % 100) / 100 * 100, pick = COLS[0][0]; for (const [cc, w] of COLS) { x -= w; if (x <= 0) { pick = cc; break; } }
      um.setColorAt(i, c.set(pick));
    });
    um.count = lm.count = data.umbrellas.length;
    um.castShadow = lm.castShadow = true; um.receiveShadow = lm.receiveShadow = true;
    um.name = 'umbrellas'; lm.name = 'loungers';
    group.add(um, lm);
  }
  void SEA_Y;
  return { group };
}
