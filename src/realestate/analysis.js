import * as THREE from 'three';
import * as SunCalc from 'suncalc';

export const SURF = { SEA: 0, LAND: 1, LAKE: 2, MARINA: 3, GOLF: 4, PARK: 5, BEACH: 6 };
const SURF_NAMES = ['sea', 'city', 'lake', 'marina', 'golf', 'park', 'beach'];

// Rasterise what lies on the ground at every 4 m cell (used by sightline tests).
export function buildSurfaceGrid(data, landPolys, B) {
  const RES = 4;
  const w = Math.ceil(B.w / RES), h = Math.ceil(B.h / RES);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const tr = (poly) => { for (const ring of poly) { ring.forEach((p, i) => (i ? g.lineTo((p[0] - B.x0) / RES, (B.y1 - p[1]) / RES) : g.moveTo((p[0] - B.x0) / RES, (B.y1 - p[1]) / RES))); g.closePath(); } };
  const fill = (list, v) => { if (!list || !list.length) return; g.fillStyle = `rgb(${v * 30},0,0)`; g.beginPath(); for (const p of list) tr(p); g.fill(); };
  g.fillStyle = 'rgb(0,0,0)'; g.fillRect(0, 0, w, h);
  fill(landPolys, SURF.LAND);
  const A = data.areas;
  fill([...(A.park || []), ...(A.grass || []), ...(A.wood || [])], SURF.PARK);
  fill([...(A.golf || []), ...(A.fairway || []), ...(A.golfgreen || []), ...(A.rough || [])], SURF.GOLF);
  fill([...(A.beach || []), ...(A.sand || [])], SURF.BEACH);
  fill(A.water, SURF.LAKE);
  fill(A.marina, SURF.MARINA);
  // the marina basin polygon also covers its quays; re-assert land there
  const img = g.getImageData(0, 0, w, h).data;
  const grid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = Math.min(6, Math.round(img[i * 4] / 30));
  return {
    w, h, RES,
    at(x, y) {
      const i = Math.floor((x - B.x0) / RES), j = Math.floor((B.y1 - y) / RES);
      if (i < 0 || j < 0 || i >= w || j >= h) return -1;
      return grid[j * w + i];
    },
  };
}

const LANDMARKS = [
  { name: 'Ain Dubai', lat: 25.0796, lon: 55.1235, h: 130, minH: 0, local: true },
  { name: 'Palm Jumeirah', lat: 25.1124, lon: 55.1390, h: 2, minH: 25 },
  { name: 'Burj Al Arab', lat: 25.1412, lon: 55.1853, h: 160, minH: 70 },
];

// Analyse what a unit's window sees: sea / marina / golf / lake fractions, close obstructions, landmarks.
export function analyseView(ctx, buildings, grid, info, unit, floorBase) {
  const fac = unit.facade;
  if (!fac) return null;
  const H = floorBase + 1.6;
  const [nx, ny] = fac.normal;
  const ox = fac.mid[0] + nx * 0.8, oy = fac.mid[1] + ny * 0.8;
  const origin = new THREE.Vector3(ox, H, -oy);
  const dir = new THREE.Vector3();
  const rays = [];
  const counts = { sea: 0, marina: 0, golf: 0, lake: 0, park: 0, beach: 0, city: 0 };
  let blocked = 0, blockers = new Map();
  const N = 13, spread = (65 * Math.PI) / 180;
  const base = Math.atan2(ny, nx);
  for (let k = 0; k < N; k++) {
    const a = base - spread + (2 * spread * k) / (N - 1);
    const dx = Math.cos(a), dy = Math.sin(a);
    // horizontal obstruction
    dir.set(dx, 0, -dy);
    const hit = buildings.raycastFirst(origin, dir, 2600, info.index);
    const near = hit && hit.distance < 110;
    if (near) { blocked++; const nm = buildings.info[hit.index].name || 'a neighbouring building'; blockers.set(nm, (blockers.get(nm) || 0) + 1); }
    // look down at ground points: first visible non-city surface wins
    let seen = 'city';
    for (const D of [70, 140, 260, 450, 750, 1200, 1900]) {
      if (hit && hit.distance < D * 0.98) break;
      const gx = ox + dx * D, gy = oy + dy * D;
      const s = grid.at(gx, gy);
      if (s < 0) { // beyond the model: assume open sea if the ray heads out over water
        break;
      }
      const tgt = new THREE.Vector3(gx, s === 0 ? -0.8 : 0.5, -gy);
      const d2 = tgt.clone().sub(origin); const dist = d2.length(); d2.normalize();
      const occ = buildings.raycastFirst(origin, d2, dist - 2, info.index);
      if (occ) continue;
      const name = SURF_NAMES[s];
      if (name !== 'city' && name !== 'park') { seen = name; break; }
      if (name === 'park' && seen === 'city') seen = 'park';
    }
    counts[seen]++;
    rays.push({ a, seen, near, dist: hit ? hit.distance : null });
  }
  // landmarks
  const { lat0, lon0, mlat, mlon } = ctx.data.meta;
  const landmarks = [];
  for (const L of LANDMARKS) {
    if (H < L.minH) continue;
    const lx = (L.lon - lon0) * mlon, ly = (L.lat - lat0) * mlat;
    const vx = lx - ox, vy = ly - oy; const dist = Math.hypot(vx, vy);
    let da = Math.atan2(vy, vx) - base; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    if (Math.abs(da) > (80 * Math.PI) / 180) continue;
    const tgt = new THREE.Vector3(lx, L.h, -ly);
    const d2 = tgt.clone().sub(origin); const far = Math.min(d2.length(), 3200); d2.normalize();
    if (!buildings.raycastFirst(origin, d2, far, info.index)) landmarks.push({ name: L.name, dist });
  }
  const f = (k) => counts[k] / N;
  let topBlocker = null; for (const [n, c] of blockers) if (!topBlocker || c > topBlocker.c) topBlocker = { n, c };
  return {
    sea: f('sea'), marina: f('marina'), golf: f('golf'), lake: f('lake'), park: f('park'), beach: f('beach'), city: f('city'),
    blocked: blocked / N, blocker: topBlocker ? topBlocker.n : null, rays, landmarks, base, height: H,
  };
}

export function viewChips(v) {
  if (!v) return [];
  const chips = [];
  if (v.sea >= 0.55) chips.push(['Full sea view', '']);
  else if (v.sea >= 0.2) chips.push(['Sea view', '']);
  else if (v.sea > 0.05) chips.push(['Partial sea view', '']);
  if (v.marina >= 0.15) chips.push(['Marina view', '']);
  if (v.golf >= 0.15) chips.push(['Golf course view', '']);
  if (v.lake >= 0.15) chips.push(['Lake view', '']);
  if (v.beach >= 0.15) chips.push(['Beach view', '']);
  for (const l of v.landmarks) chips.push([`${l.name} in sight`, '']);
  if (v.blocked >= 0.45 && v.blocker) chips.push([`Faces ${v.blocker}`, 'bad']);
  else if (v.blocked >= 0.2) chips.push(['Partly obstructed', 'warn']);
  if (!chips.length || chips.every((c) => c[1])) chips.unshift(['City view', 'warn']);
  return chips;
}

// Hours of direct sun on the unit's facade for a given day (Dubai local), sampled every 15 minutes.
export function sunHours(ctx, buildings, info, unit, floorBase, dayDate) {
  const fac = unit.facade; if (!fac) return null;
  const { lat0, lon0 } = ctx.data.meta;
  const [nx, ny] = fac.normal;
  const origin = new THREE.Vector3(fac.mid[0] + nx * 0.8, floorBase + 1.6, -(fac.mid[1] + ny * 0.8));
  const dir = new THREE.Vector3();
  let minutes = 0, first = null, last = null;
  const start = dayDate.getTime();
  for (let m = 300; m <= 1200; m += 15) {
    const d = new Date(start + m * 60000);
    const p = SunCalc.getPosition(d, lat0, lon0);
    if (p.altitude < 2) continue;
    const az = THREE.MathUtils.degToRad(p.azimuth), alt = THREE.MathUtils.degToRad(p.altitude);
    const sx = Math.sin(az) * Math.cos(alt), sn = Math.cos(az) * Math.cos(alt), sy = Math.sin(alt);
    if (sx * nx + sn * ny < 0.05) continue;
    dir.set(sx, sy, -sn).normalize();
    if (buildings.raycastFirst(origin, dir, 3000, info.index)) continue;
    minutes += 15; if (first == null) first = m; last = m;
  }
  return { hours: minutes / 60, first, last };
}
