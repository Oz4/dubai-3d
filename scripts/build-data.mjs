// Converts raw OSM (+ Overture ML footprints) into compact JSON scene descriptions consumed by the web
// app: public/data/world.json (global, always loaded) + public/data/sections/<id>.json (streamed)
//
// The map covers the built sections of Dubai (scripts/sections.json). Coordinates are local metres
// [east, north] from a fixed origin shared by every section.
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { BBOX, ORIGIN, BUILT } from './config.mjs';
import {
  signedArea, centroid, bboxOf, pointInRing, pointInPoly, openRing, orientPoly, simplifyRing, simplifyLine,
  clipRingToRect, clipPolyline, polylineLength, rng, Grid, distToSegment, lerpPt, clipHalf, obb, simplify3,
} from './lib/geom.mjs';
import { solveElevations } from './lib/elevation.mjs';
import { LANDMARKS } from '../src/layers/landmarks.js';
import { SIDRA, sidraType, frame2D, planMap, MAPLE, mapleCluster, mapleX, mapleY, pairLayout, golfPlaceLayout, luxuryType, luxuryLayout } from '../src/layers/house-specs.js';
const LANDMARK_NAMES = new Set(Object.keys(LANDMARKS));
import { viaductSpines, placePiers } from './lib/viaduct.mjs';
import { streetKit } from './lib/street-kit.mjs';

const t0 = Date.now();
const raw = JSON.parse(readFileSync(new URL('../data-raw/osm.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- projection
const { lat0, lon0 } = ORIGIN;
const phi = (lat0 * Math.PI) / 180;
const MLAT = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi);
const MLON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
const project = (lat, lon) => [(lon - lon0) * MLON, (lat - lat0) * MLAT];
const R = { x0: (BBOX.w - lon0) * MLON, y0: (BBOX.s - lat0) * MLAT, x1: (BBOX.e - lon0) * MLON, y1: (BBOX.n - lat0) * MLAT };
const Rpad = { x0: R.x0 - 5, y0: R.y0 - 5, x1: R.x1 + 5, y1: R.y1 + 5 };
const inBox = (p, m = 0) => p[0] >= R.x0 - m && p[0] <= R.x1 + m && p[1] >= R.y0 - m && p[1] <= R.y1 + m;

const r1 = (v) => Math.round(v * 10) / 10;
const rp = (p) => [r1(p[0]), r1(p[1])];
const rpz = (p) => [r1(p[0]), r1(p[1]), r1(p[2] || 0)];
const rRing = (ring) => ring.map(rp);

// ---------------------------------------------------------------- index OSM
const nodes = new Map(), ways = new Map(), rels = [];
// Overpass "out skel" re-emits recursed elements without tags: never let those overwrite tagged copies.
for (const e of raw.elements) {
  const m = e.type === 'node' ? nodes : e.type === 'way' ? ways : null;
  if (m) { const prev = m.get(e.id); if (!prev || (!prev.tags && e.tags)) m.set(e.id, e); }
  else if (e.type === 'relation') rels.push(e);
}
const xyCache = new Map();
const nodeXY = (id) => {
  let p = xyCache.get(id);
  if (!p) { const n = nodes.get(id); if (!n) return null; p = project(n.lat, n.lon); xyCache.set(id, p); }
  return p;
};
const wayPts = (w) => w.nodes.map(nodeXY).filter(Boolean);
const isClosed = (w) => w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1];

// Join member ways (node id lists) into closed rings.
function joinRings(lists) {
  const pool = lists.map((a) => a.slice()); const rings = [];
  while (pool.length) {
    let cur = pool.shift();
    let guard = 0;
    while (cur[0] !== cur[cur.length - 1] && guard++ < 10000) {
      const last = cur[cur.length - 1];
      const idx = pool.findIndex((w) => w[0] === last || w[w.length - 1] === last);
      if (idx < 0) break;
      let w = pool.splice(idx, 1)[0];
      if (w[0] !== last) w = w.reverse();
      cur = cur.concat(w.slice(1));
    }
    if (cur[0] === cur[cur.length - 1] && cur.length >= 4) rings.push(cur);
  }
  return rings;
}

// Multipolygon relation -> list of polygons ([outer, ...holes]) in metres
function relationPolys(rel) {
  const outerL = [], innerL = [];
  for (const m of rel.members) {
    if (m.type !== 'way') continue;
    const w = ways.get(m.ref); if (!w) continue;
    (m.role === 'inner' ? innerL : outerL).push(w.nodes);
  }
  const outers = joinRings(outerL).map((r) => openRing(r.map(nodeXY).filter(Boolean))).filter((r) => r.length >= 3);
  const inners = joinRings(innerL).map((r) => openRing(r.map(nodeXY).filter(Boolean))).filter((r) => r.length >= 3);
  const polys = outers.map((o) => [o]);
  for (const h of inners) {
    const c = h[0];
    const host = polys.find((p) => pointInRing(c, p[0]));
    if (host) host.push(h);
  }
  return polys.map(orientPoly);
}

function wayPoly(w) {
  const r = openRing(wayPts(w));
  return r.length >= 3 ? orientPoly([r]) : null;
}

// ---------------------------------------------------------------- tag helpers
function parseLen(v) {
  if (v == null) return null;
  const s = String(v).replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/ft|'/.test(s)) n *= 0.3048;
  return Number.isFinite(n) ? n : null;
}
const SPAM = /safari|buggy|tours?\b|desert|rent a|cheap|best\s|call\s|whatsapp/i;
function cleanName(t) {
  let n = t['name:en'] || t.name || t['alt_name'] || '';
  n = n.trim();
  if (!n || SPAM.test(n)) return '';
  return n;
}
// Published heights where OSM has none or a wrong one.
const HEIGHT_FIX = {
  w446646206: 828, // Burj Khalifa (OSM: 163 levels, no height)
  w393391115: 309, // Jumeirah Emirates Towers Hotel (OSM repeats the office tower's 355 m)
};
// A few buildings carry the name of a venue inside them in OSM; show the building's own name instead.
const NAME_FIX = {
  w238284905: 'JW Marriott Marquis Hotel', // name:en is the bar on levels 71-72
  w1148163194: 'Amna, Noora & Meera (Al Habtoor City)', // the residential towers' podium is tagged with a nightclub's name
  w1136937509: 'Mall of the Emirates', // the mall's building is unnamed in OSM; only its Ski Dubai part carries a name
};
const yearOf = (t) => { const m = String(t.start_date || '').match(/(19|20)\d\d/); return m ? +m[0] : undefined; };
const isArabic = (s) => /[؀-ۿ]/.test(s);

// ---------------------------------------------------------------- coastline -> land polygons
function buildLand() {
  const coast = [...ways.values()].filter((w) => w.tags && w.tags.natural === 'coastline');
  let chains = coast.map((w) => w.nodes.slice());
  // merge chains end->start (coastline direction must be preserved: land on the left)
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i++) {
      const a = chains[i];
      if (a[0] === a[a.length - 1]) continue;
      for (let j = 0; j < chains.length; j++) {
        if (i === j) continue;
        const b = chains[j];
        if (b[0] === b[b.length - 1]) continue;
        if (a[a.length - 1] === b[0]) { chains[i] = a.concat(b.slice(1)); chains.splice(j, 1); merged = true; break outer; }
      }
    }
  }
  const landRings = [], waterRings = [];
  let pieces = [];
  for (const ch of chains) {
    let pts = ch.map(nodeXY).filter(Boolean);
    const closed = ch[0] === ch[ch.length - 1];
    if (closed) {
      if (pts.every((p) => inBox(p))) {
        const r = openRing(pts);
        if (signedArea(r) > 0) landRings.push(r); else waterRings.push(r);
        continue;
      }
      // rotate so that the ring starts outside the box, then treat as open
      const k = pts.findIndex((p) => !inBox(p));
      const ring = openRing(pts);
      const kk = ring.findIndex((p) => !inBox(p));
      pts = ring.slice(kk).concat(ring.slice(0, kk + 1));
      void k;
    }
    for (const piece of clipPolyline(pts, R)) pieces.push(piece);
  }
  // Repair pieces that end inside the box (broken data) by joining nearest dangling ends.
  const dangEnd = pieces.filter((p) => p.endIn), dangStart = pieces.filter((p) => p.startIn);
  for (const a of dangEnd) {
    if (!a.endIn) continue;
    const e = a.pts[a.pts.length - 1];
    let best = null, bd = Infinity;
    for (const b of dangStart) {
      if (!b.startIn || b === a) continue;
      const d = Math.hypot(b.pts[0][0] - e[0], b.pts[0][1] - e[1]);
      if (d < bd) { bd = d; best = b; }
    }
    if (best && bd < 400) {
      a.pts = a.pts.concat(best.pts); a.endIn = best.endIn; best.startIn = false; best.dead = true;
      console.log(`  coastline gap joined (${bd.toFixed(1)} m)`);
    }
  }
  pieces = pieces.filter((p) => !p.dead);
  // Any still-dangling ends: extend straight to the nearest boundary.
  const snapToBoundary = (p) => {
    const d = [p[0] - R.x0, R.x1 - p[0], p[1] - R.y0, R.y1 - p[1]];
    const m = Math.min(...d), i = d.indexOf(m);
    return i === 0 ? [R.x0, p[1]] : i === 1 ? [R.x1, p[1]] : i === 2 ? [p[0], R.y0] : [p[0], R.y1];
  };
  for (const p of pieces) {
    if (p.startIn) { p.pts.unshift(snapToBoundary(p.pts[0])); console.log('  coastline start snapped to boundary'); }
    if (p.endIn) { p.pts.push(snapToBoundary(p.pts[p.pts.length - 1])); console.log('  coastline end snapped to boundary'); }
  }
  const W = R.x1 - R.x0, H = R.y1 - R.y0, PER = 2 * (W + H);
  const bparam = (p) => {
    const d = [Math.abs(p[1] - R.y0), Math.abs(p[0] - R.x1), Math.abs(p[1] - R.y1), Math.abs(p[0] - R.x0)];
    const i = d.indexOf(Math.min(...d));
    if (i === 0) return p[0] - R.x0;
    if (i === 1) return W + (p[1] - R.y0);
    if (i === 2) return W + H + (R.x1 - p[0]);
    return 2 * W + H + (R.y1 - p[1]);
  };
  const corners = [[W, [R.x1, R.y0]], [W + H, [R.x1, R.y1]], [2 * W + H, [R.x0, R.y1]], [PER, [R.x0, R.y0]]];
  for (const p of pieces) { p.tin = bparam(p.pts[0]); p.tout = bparam(p.pts[p.pts.length - 1]); }
  const used = new Set();
  for (const s of pieces) {
    if (used.has(s)) continue;
    const ring = []; let cur = s; let guard = 0;
    while (guard++ < 1000) {
      used.add(cur); ring.push(...cur.pts);
      let best = null, bd = Infinity;
      for (const q of pieces) {
        if (used.has(q) && q !== s) continue;
        let d = (q.tin - cur.tout + PER) % PER;
        if (d < bd) { bd = d; best = q; }
      }
      const cs = corners
        .map(([pc, xy]) => [((pc - cur.tout) % PER + PER) % PER, xy])
        .filter(([d]) => d > 1e-9 && d < bd)
        .sort((a, b) => a[0] - b[0]);
      for (const [, xy] of cs) ring.push(xy);
      if (!best || best === s) break;
      cur = best;
    }
    const r = openRing(ring);
    if (r.length >= 3 && signedArea(r) > 1) landRings.push(r);
  }
  if (!pieces.length && !landRings.length) landRings.push([[R.x0, R.y0], [R.x1, R.y0], [R.x1, R.y1], [R.x0, R.y1]]);
  console.log(`  coastline: ${chains.length} chains, ${pieces.length} boundary pieces -> ${landRings.length} land polygons, ${waterRings.length} enclosed water`);
  return { land: landRings, water: waterRings };
}

// ---------------------------------------------------------------- areas
function areaKind(t) {
  if (!t) return null;
  if (t.man_made === 'geoglyph') return null;
  if (t.leisure === 'swimming_pool' || t.water === 'pool') return 'pool';
  if (t.leisure === 'marina') return 'marina';
  if (t.natural === 'water' || t.water || t.leisure === 'marina' || t.landuse === 'basin' || t.landuse === 'reservoir' ||
      t.golf === 'water_hazard' || t.golf === 'lateral_water_hazard' || t.waterway === 'riverbank') return 'water';
  if (t.natural === 'beach') return 'beach';
  if (t.natural === 'sand' || t.natural === 'shingle') return 'sand';
  if (t.golf === 'bunker') return 'bunker';
  if (t.golf === 'green' || t.golf === 'tee') return 'golfgreen';
  if (t.golf === 'fairway') return 'fairway';
  if (t.golf === 'rough') return 'rough';
  if (t.leisure === 'golf_course') return 'golf';
  if (t.leisure === 'pitch' && t.sport === 'golf') return 'golfgreen';
  if (t.leisure === 'pitch' || t.leisure === 'track') return 'pitch';
  if (['park', 'garden', 'dog_park', 'playground', 'common', 'recreation_ground'].includes(t.leisure)) return 'park';
  if (t.landuse === 'grass' || t.natural === 'grassland' || t.landuse === 'meadow' || t.landuse === 'village_green' || t.landuse === 'flowerbed') return 'grass';
  if (t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub' || t.natural === 'heath') return 'wood';
  if (t.landuse === 'construction' || t.landuse === 'brownfield') return 'construction';
  if (t.landuse === 'industrial') return 'industrial';
  if (t.landuse === 'commercial' || t.landuse === 'retail') return 'commercial';
  if (t.landuse === 'residential') return 'residential';
  if (t.amenity === 'parking') return 'parking';
  if (t.highway === 'pedestrian' || t['area:highway'] || (t.highway && t.area === 'yes')) return 'plaza';
  if (t.man_made === 'breakwater' || t.man_made === 'groyne') return 'breakwater';
  if (t.man_made === 'pier') return 'pier';
  // the Souk Al Bahar bridge over the Burj lake is mapped as a deck outline: a low stone deck on the water, like a pier
  if (t.man_made === 'bridge' && /سوق البحار|Souk Al Bahar/i.test(`${t.name || ''} ${t['name:en'] || ''}`)) return 'pier';
  if (t.place === 'islet' || t.place === 'island') return 'island';
  return null;
}

// ---------------------------------------------------------------- run
console.log('Building land from coastline...');
const coastResult = buildLand();

const areas = {}; const pushArea = (k, poly) => { (areas[k] = areas[k] || []).push(poly); };
const parkingLots = []; // amenity=parking polygons with their tags (qualified later)
const beachTags = new WeakMap(); // beach polygon -> its OSM tags (public / private hints)
const pools = [];
const pierAreas = [];
for (const w of ways.values()) {
  if (!w.tags || !isClosed(w)) continue;
  if (w.tags.building || w.tags['building:part']) continue;
  const k = areaKind(w.tags);
  if (!k) continue;
  if (w.tags.highway && !w.tags.area && k !== 'plaza') continue;
  const poly = wayPoly(w); if (!poly) continue;
  if (k === 'pool') pools.push(poly);
  else if (k === 'pier') pierAreas.push(poly);
  else if (k === 'parking') parkingLots.push({ id: w.id, tags: w.tags, poly });
  else { pushArea(k, poly); if (k === 'beach') beachTags.set(poly, w.tags); }
}
for (const r of rels) {
  if (!r.tags || r.tags.type !== 'multipolygon') continue;
  if (r.tags.building || r.tags['building:part']) continue;
  const k = areaKind(r.tags); if (!k) continue;
  for (const poly of relationPolys(r)) {
    if (k === 'pool') pools.push(poly); else if (k === 'pier') pierAreas.push(poly); else pushArea(k, poly);
  }
}
for (const r of coastResult.water) pushArea('water', [r]);

// clip & simplify areas to the box
function clipPoly(poly, tol = 0.4) {
  const out = [];
  const outer = clipRingToRect(poly[0], Rpad);
  if (outer.length < 3 || Math.abs(signedArea(outer)) < 2) return null;
  out.push(simplifyRing(outer, tol));
  for (let i = 1; i < poly.length; i++) {
    const h = clipRingToRect(poly[i], Rpad);
    if (h.length >= 3) out.push(simplifyRing(h, tol));
  }
  return orientPoly(out);
}
// Water polygons that sit over the open sea (e.g. the Dubai Marina / Harbour basins, which the
// coastline already excludes from land) are only kept for classification ("marina"), not rendered.
{
  const landRings = coastResult.land;
  const onLand = (pt) => landRings.some((r) => pointInRing(pt, r));
  const rr = rng(7);
  const inland = [];
  for (const poly of areas.water || []) {
    const bb = bboxOf(poly[0]); let tot = 0, land = 0;
    for (let i = 0; i < 400 && tot < 24; i++) {
      const pt = [bb[0] + rr() * (bb[2] - bb[0]), bb[1] + rr() * (bb[3] - bb[1])];
      if (!pointInPoly(pt, poly)) continue;
      tot++; if (onLand(pt)) land++;
    }
    if (tot === 0 || land / tot > 0.5) inland.push(poly);
  }
  console.log(`  water polygons: ${(areas.water || []).length} -> ${inland.length} inland`);
  areas.water = inland;
}
const areasOut = {};
for (const [k, list] of Object.entries(areas)) {
  areasOut[k] = list.map((p) => clipPoly(p)).filter(Boolean).map((p) => p.map(rRing));
}
const landOut = coastResult.land.map((r) => [rRing(simplifyRing(r, 0.4))]);

// ---------------------------------------------------------------- water/land masks for placement tests
const waterPolys = (areas.water || []);
const landPolys = coastResult.land.map((r) => [r]);
const wGrid = new Grid(200); waterPolys.forEach((p) => wGrid.insert(bboxOf(p[0]), p));
const lGrid = new Grid(200); landPolys.forEach((p) => lGrid.insert(bboxOf(p[0]), p));
const isWater = (pt) => {
  let onLand = false;
  for (const p of lGrid.query(pt[0], pt[1])) if (pointInPoly(pt, p)) { onLand = true; break; }
  if (!onLand) return true;
  for (const p of wGrid.query(pt[0], pt[1])) if (pointInPoly(pt, p)) return true;
  return false;
};

// ---------------------------------------------------------------- buildings
console.log('Buildings...');
const FLOOR_H = 3.5;
const bRaw = []; // {osmId, tags, polys}
const partRaw = [];
for (const w of ways.values()) {
  if (!w.tags || !isClosed(w)) continue;
  if (w.tags['building:part'] && w.tags['building:part'] !== 'no') { const p = wayPoly(w); if (p) partRaw.push({ osm: 'w' + w.id, tags: w.tags, polys: [p] }); continue; }
  if (w.tags.building && w.tags.building !== 'no') { const p = wayPoly(w); if (p) bRaw.push({ osm: 'w' + w.id, tags: w.tags, polys: [p] }); }
}
for (const r of rels) {
  if (!r.tags) continue;
  const isPart = r.tags['building:part'] && r.tags['building:part'] !== 'no';
  if (!isPart && !(r.tags.building && r.tags.building !== 'no')) continue;
  if (r.tags.type !== 'multipolygon' && r.tags.type !== 'building') continue;
  let polys;
  if (r.tags.type === 'building') {
    // "building" relations group an outline and parts; handle the outline member only
    const outline = r.members.find((m) => m.role === 'outline' && m.type === 'way');
    const w = outline && ways.get(outline.ref);
    polys = w && isClosed(w) ? [wayPoly(w)].filter(Boolean) : [];
  } else polys = relationPolys(r);
  if (!polys.length) continue;
  (isPart ? partRaw : bRaw).push({ osm: 'r' + r.id, tags: r.tags, polys });
}

function heights(t, area) {
  let h = parseLen(t.height) ?? parseLen(t['building:height']);
  const lv = parseLen(t['building:levels']);
  let est = false;
  if (h == null && lv != null) h = lv * FLOOR_H + (lv > 10 ? 4 : 1);
  let mh = parseLen(t.min_height);
  if (mh == null && t['building:min_level'] != null) mh = parseLen(t['building:min_level']) * FLOOR_H;
  if (h == null) {
    est = true;
    const b = t.building || t['building:part'] || 'yes';
    if (['house', 'detached', 'villa', 'semidetached_house', 'terrace', 'bungalow'].includes(b)) h = 8;
    else if (['garage', 'garages', 'shed', 'kiosk', 'hut', 'carport', 'toilets', 'service', 'transformer_tower'].includes(b)) h = 4;
    else if (b === 'roof') h = 6;
    else if (['retail', 'commercial', 'supermarket'].includes(b)) h = area > 3000 ? 18 : 10;
    else if (['industrial', 'warehouse'].includes(b)) h = 10;
    else if (['apartments', 'residential', 'hotel', 'office'].includes(b)) h = area > 600 ? 26 : 16;
    else if (b === 'mosque') h = 10;
    else if (b === 'construction') h = 12;
    else h = area < 60 ? 3.5 : area < 200 ? 7 : area < 1200 ? 12 : 16;
  }
  if (t.building === 'roof' && mh == null) mh = Math.max(0, h - 0.8);
  return { h: Math.max(2.5, h), mh: Math.max(0, mh || 0), lv: lv ?? undefined, est };
}

const buildings = [];
const bGrid = new Grid(60);
let skippedOutside = 0;
for (const b of bRaw) {
  const t = b.tags;
  // (a negative layer means below ground, unless the building is tagged as standing on the surface: Nakheel Mall)
  if (t.building === 'bridge' || t.location === 'underground' || (parseLen(t.layer) < 0 && t.location !== 'surface')) continue;
  const poly = b.polys[0];
  const c = centroid(poly[0]);
  if (!inBox(c, -2)) { skippedOutside++; continue; }
  const area = Math.abs(signedArea(poly[0]));
  if (area < 4) continue;
  const hs = heights(t, area);
  if (HEIGHT_FIX[b.osm]) Object.assign(hs, { h: HEIGHT_FIX[b.osm], est: false });
  const rec = {
    osm: b.osm, tags: t, polys: b.polys.map((p) => p.map((r) => simplifyRing(r, 0.15))), c, area, ...hs, parts: [],
  };
  buildings.push(rec);
  bGrid.insert(bboxOf(poly[0]), rec);
}

// assign parts to the smallest building outline containing their centroid
let orphanParts = 0;
const orphans = [];
for (const p of partRaw) {
  const c = centroid(p.polys[0][0]);
  if (!inBox(c, -2)) continue;
  let host = null;
  for (const b of bGrid.query(c[0], c[1])) {
    if (pointInPoly(c, b.polys[0]) && (!host || b.area < host.area)) host = b;
  }
  const area = Math.abs(signedArea(p.polys[0][0]));
  const hs = heights(p.tags, area);
  const part = { tags: p.tags, polys: p.polys, c, area, ...hs };
  if (host) host.parts.push(part);
  else orphans.push(part);
}
// Parts without an outline (e.g. Princess Tower body + crown): group overlapping parts into one
// synthetic building so they are selected together and every part is rendered.
orphans.sort((a, b) => b.area - a.area);
const synth = [];
for (const part of orphans) {
  const g = synth.find((s) => s.members.some((m) => pointInPoly(part.c, m.polys[0])));
  if (g) g.members.push(part);
  else synth.push({ members: [part] });
}
for (const g of synth) {
  orphanParts += g.members.length;
  const base = g.members[0];
  const named = g.members.find((m) => m.tags.name) || g.members.reduce((a, b) => (b.h > a.h ? b : a));
  const tags = { ...named.tags, building: named.tags.building || named.tags['building:part'] || 'yes' };
  const rec = { osm: 'synth', tags, polys: base.polys, c: base.c, area: base.area, h: Math.max(...g.members.map((m) => m.h)), mh: 0, est: g.members.every((m) => m.est), lv: Math.max(0, ...g.members.map((m) => m.lv || 0)) || undefined, parts: g.members };
  buildings.push(rec); bGrid.insert(bboxOf(base.polys[0][0]), rec);
}

// Overture / Microsoft ML footprints that are not in OSM -> low-rise fill
let mlAdded = 0;
const overturePath = new URL('../data-raw/overture-buildings.geojson', import.meta.url);
if (existsSync(overturePath)) {
  const ov = JSON.parse(readFileSync(overturePath, 'utf8'));
  for (const f of ov.features) {
    const src = (f.properties.sources || []).map((s) => s.dataset);
    if (src.includes('OpenStreetMap')) continue;
    if (f.geometry.type !== 'Polygon') continue;
    const ring = openRing(f.geometry.coordinates[0].map(([lon, lat]) => project(lat, lon)));
    if (ring.length < 3) continue;
    const poly = orientPoly([ring]);
    const c = centroid(poly[0]);
    if (!inBox(c, -2)) continue;
    const area = Math.abs(signedArea(poly[0]));
    if (area < 15) continue;
    // skip if overlapping an OSM building
    let overlap = false;
    for (const b of bGrid.query(c[0], c[1])) if (pointInPoly(c, b.polys[0]) || pointInRing(b.c, poly[0])) { overlap = true; break; }
    if (overlap) continue;
    const h = parseLen(f.properties.height) ?? (area < 120 ? 4 : area < 450 ? 8 : 12);
    const rec = { osm: 'ml' + mlAdded, tags: { building: 'yes', source: 'ml' }, polys: [poly], c, area, h, mh: 0, est: true, parts: [], ml: true };
    buildings.push(rec); bGrid.insert(bboxOf(poly[0]), rec); mlAdded++;
  }
}

// Ain Dubai is rendered procedurally; record its axis.
const landmarks = {};
{
  const ain = buildings.find((b) => b.tags.attraction === 'big_wheel');
  if (ain) {
    const ring = ain.polys[0][0];
    // longest axis of the footprint
    let best = [0, 1], bd = 0;
    for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
      const d = Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
      if (d > bd) { bd = d; best = [i, j]; }
    }
    const a = ring[best[0]], b = ring[best[1]];
    landmarks.ainDubai = { x: r1((a[0] + b[0]) / 2), y: r1((a[1] + b[1]) / 2), angle: Math.atan2(b[1] - a[1], b[0] - a[0]), span: r1(bd) };
    ain.skip = true;
  }
}

// ---------------------------------------------------------------- roads
console.log('Roads...');
const ROAD = {
  motorway: { lanes: 3, rank: 10 }, motorway_link: { lanes: 1, rank: 8 },
  trunk: { lanes: 3, rank: 9 }, trunk_link: { lanes: 1, rank: 7 },
  primary: { lanes: 4, rank: 8 }, primary_link: { lanes: 1, rank: 6 },
  secondary: { lanes: 4, rank: 7 }, secondary_link: { lanes: 1, rank: 5 },
  tertiary: { lanes: 2, rank: 6 }, tertiary_link: { lanes: 1, rank: 4 },
  residential: { lanes: 2, rank: 4 }, unclassified: { lanes: 2, rank: 4 }, living_street: { lanes: 2, rank: 3 },
  service: { lanes: 1.4, rank: 2 }, road: { lanes: 2, rank: 3 },
};
const DRIVABLE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
  'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street']);
const PATHS = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'track', 'bridleway', 'corridor']);
const LANE_W = 3.4;
// walkway kinds: 0 footway (pavers), 1 pedestrian street / promenade, 2 cycle track, 3 boardwalk,
// 4 unpaved path, 5 steps, 6 shared foot + cycle path
const WALK_W = { 0: 2.6, 1: 6, 2: 2.4, 3: 3, 4: 1.8, 5: 2.4, 6: 3.2, 7: 2.4 }; // 7: rubber running track
function walkKind(t) {
  const surf = t.surface || '';
  if (t.highway === 'steps') return 5;
  if (surf === 'wood') return 3;
  if (t.highway === 'cycleway') return t.foot === 'designated' || t.foot === 'yes' ? 6 : 2;
  if (t.highway === 'pedestrian') return 1;
  if (['dirt', 'sand', 'gravel', 'ground', 'grass', 'compacted', 'fine_gravel', 'unpaved'].includes(surf)) return 4;
  if ((t.bicycle === 'designated' || t.bicycle === 'yes') && t.highway !== 'steps') return 6;
  return 0;
}
const LAYER_H = 6.5;

const roadWays = [];
const pathsOut = [];
for (const w of ways.values()) {
  const t = w.tags; if (!t || !t.highway) continue;
  if (t.area === 'yes') continue;
  if (t.tunnel && t.tunnel !== 'no') continue;
  if (t.covered === 'yes' || parseLen(t.layer) < 0 || t.location === 'underground' || t.indoor === 'yes') continue;
  if (PATHS.has(t.highway)) {
    if (isClosed(w) && (t.highway === 'pedestrian' || t.area === 'yes')) continue; // pedestrian areas are plazas
    // footbridges are modelled as skybridges; a boardwalk (bridge=boardwalk: the Palm crescent's 11 km walk on its
    // rock revetment) is a walkway at ground level and stays
    if (t.bridge && t.bridge !== 'no' && t.bridge !== 'boardwalk') continue;
    if (t.footway === 'crossing' || t.cycleway === 'crossing' || t.path === 'crossing') continue; // drawn on the road
    // the Palm Jumeirah Boardwalk is a broad red rubber-surfaced promenade along the revetment: the running-track kind
    const palmWalk = /Palm Jumeirah (Boardwalk|Broadwalk)/i.test(t.name || '');
    const k = palmWalk ? 7 : walkKind(t);
    const tw = parseLen(t.width);
    const width = tw > 0.8 && tw < 30 ? tw : palmWalk ? 9 : WALK_W[k];
    for (const piece of clipPolyline(wayPts(w), Rpad)) pathsOut.push({ k, w: r1(width), p: simplifyLine(piece.pts, 0.3).map(rp) });
    continue;
  }
  const def = ROAD[t.highway]; if (!def) continue;
  // parking aisles belong to a car park: outside a mapped one they would be stray lanes on bare ground
  if (t.highway === 'service' && t.service === 'parking_aisle') {
    const ap = wayPts(w);
    const inLot = parkingLots.some((lot) => {
      const bb = lot.bb || (lot.bb = bboxOf(lot.poly[0]));
      return ap.some((q) => q[0] >= bb[0] && q[0] <= bb[2] && q[1] >= bb[1] && q[1] <= bb[3] && pointInPoly(q, lot.poly));
    });
    if (!inLot) continue;
  }
  const lanes = Math.min(10, Math.max(1, parseLen(t.lanes) || def.lanes));
  let oneway = 0;
  if (['yes', 'true', '1'].includes(t.oneway) || t.junction === 'roundabout' || t.junction === 'circular' || t.highway === 'motorway' || t.highway === 'motorway_link') oneway = 1;
  if (t.oneway === '-1') oneway = -1;
  if (t.oneway === 'no') oneway = 0;
  const bridge = !!(t.bridge && t.bridge !== 'no');
  if (!bridge && parseLen(t.layer) >= 2) continue; // roads on parking decks / roofs
  const layer = bridge ? Math.max(1, Math.min(3, parseLen(t.layer) || 1)) : 0;
  let width = lanes * LANE_W + (t.highway === 'motorway' ? 3 : t.highway === 'service' ? 0 : 1);
  if (t.width && parseLen(t.width)) width = Math.max(3, parseLen(t.width));
  roadWays.push({ w, t, kind: t.highway, rank: def.rank, lanes, oneway, bridge, layer, width, name: cleanName(t) });
}

// Dead-end stubs: short service lanes and slip roads that end in nothing read as roads to nowhere (most are
// driveways, whose plots draw their own, or fragments left by mapping in progress).
{
  const use = new Map();
  const bump = (id, k) => use.set(id, (use.get(id) || 0) + k);
  for (const r of roadWays) { const n = r.w.nodes; bump(n[0], 1); bump(n[n.length - 1], 1); for (let i = 1; i < n.length - 1; i++) bump(n[i], 2); }
  let cut = 0;
  for (let pass = 0; pass < 2; pass++) for (let i = roadWays.length - 1; i >= 0; i--) {
    const r = roadWays[i]; if (r.bridge) continue;
    const maxL = r.kind === 'service' ? 32 : /_link$/.test(r.kind) ? 60 : 0; if (!maxL) continue;
    const n = r.w.nodes, a = n[0], b = n[n.length - 1];
    if (use.get(a) !== 1 && use.get(b) !== 1) continue;
    const pts = wayPts(r.w);
    if (pts.length < 2 || !inBox(pts[0], -5) || !inBox(pts[pts.length - 1], -5) || polylineLength(pts) > maxL) continue;
    bump(a, -1); bump(b, -1); for (let k = 1; k < n.length - 1; k++) bump(n[k], -2);
    roadWays.splice(i, 1); cut++;
  }
  console.log(`  dead-end stubs removed: ${cut}`);
}
// Where a road meets others its lane and edge lines stop, as painted lines do at a junction: a road ending at a
// junction, a slip road along its merge taper, and a through road across the box of a crossing of its own
// standing. r.jn: [x, y, radius] per such node; the renderer fades the markings inside the radius.
{
  const nodeWays = new Map();
  for (const r of roadWays) { const n = r.w.nodes; n.forEach((id, i) => { let a = nodeWays.get(id); if (!a) nodeWays.set(id, (a = [])); a.push({ r, end: i === 0 || i === n.length - 1 }); }); }
  const isLink = (r) => /_link$/.test(r.kind);
  for (const r of roadWays) {
    const n = r.w.nodes; r.jn = [];
    n.forEach((id, i) => {
      const all = nodeWays.get(id); if (all.length < 2) return;
      const others = all.filter((o) => o.r !== r); if (!others.length) return;
      const end = i === 0 || i === n.length - 1;
      const wMax = (list) => Math.min(30, Math.max(...list.map((o) => o.r.width)));
      let R = 0;
      if (end) {
        const cont = others.length === 1 && others[0].end;
        if (cont) {
          R = isLink(r) && !isLink(others[0].r) ? 22 : 0;
          // one way handing over to the next with another width (a lane gained or lost): both taper to the mean
          const ow = others[0].r.width;
          if (Math.abs(ow - r.width) > 0.4 && Math.abs(ow - r.width) < 9) { (r.tw = r.tw || {})[i === 0 ? 0 : 1] = (ow + r.width) / 2; const q = nodeXY(id); if (q) (r.twp = r.twp || {})[i === 0 ? 0 : 1] = q; }
        }
        else R = isLink(r) ? 36 : wMax(others) / 2 + (r.kind === 'service' ? 2 : 5);
      } else {
        const strong = others.filter((o) => !(isLink(o.r) && o.end && !isLink(r)) && o.r.rank >= r.rank - 2 && !(o.r.kind === 'service' && r.kind !== 'service'));
        if (strong.length) R = Math.min(24, wMax(strong) / 2 + 4);
      }
      if (R > 0) { const q = nodeXY(id); if (q) r.jn.push([q[0], q[1], R]); }
    });
  }
}

// ---------------------------------------------------------------- cycle lanes painted on roads
const bikeLanes = [];
{
  const ok = (v) => v && !['no', 'none', 'separate', 'shared_lane', 'share_busway', 'opposite'].includes(v);
  const offsetLine = (pts, off) => pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / l) * off, p[1] + (dx / l) * off];
  });
  for (const r of roadWays) {
    if (r.bridge) continue;
    const t = r.t, both = t.cycleway || t['cycleway:both'], sides = [];
    if (ok(both)) sides.push(1, -1);
    else { if (ok(t['cycleway:left'])) sides.push(1); if (ok(t['cycleway:right'])) sides.push(-1); }
    if (!sides.length) continue;
    const pts = wayPts(r.w);
    for (const sd of sides) for (const piece of clipPolyline(offsetLine(pts, sd * (r.width / 2 - 1.0)), Rpad)) bikeLanes.push({ w: 1.7, p: piece.pts.map(rp) });
  }
  console.log(`  cycle lanes on roads: ${bikeLanes.length}`);
}

// ---------------------------------------------------------------- elevations (network solver)
// Heights come from the whole road + rail network at once (scripts/lib/elevation.mjs): every shared
// node has one elevation, each crossing pins the upper way above the lower one with clearance, and
// ramps fall out of grade-limited propagation, so flyovers, ramps and the metro meet without steps.
console.log('Elevations...');
const railWays = [...ways.values()].filter((w) => w.tags && ['subway', 'tram', 'light_rail', 'monorail', 'rail'].includes(w.tags.railway) && !(w.tags.tunnel && w.tags.tunnel !== 'no'));
// envelope: what must fit under a crossing deck (vehicles + clearance); deck: the structure's own depth
const ELEV_MODES = {
  road: { grade: 0.06, cruise: 6.0, water: 5.5, envelope: 5.6, deck: 1.5 },
  tram: { grade: 0.05, cruise: 6.0, water: 5.5, envelope: 4.6, deck: 1.4 },
  metro: { grade: 0.035, cruise: 12.5, water: 12.5, envelope: 5.2, deck: 2.4, deadEndLands: false },
  // Palm Monorail: straddle beam ~9 m up along the trunk, ends inside its terminal stations
  mono: { grade: 0.06, cruise: 9.0, water: 9.0, envelope: 5.0, deck: 1.7, deadEndLands: false },
};
// Red Line stations: platforms ride ~15 m up so the concourse beneath clears the roads it spans
const stationNodes = [];
{
  const sp = new URL('../data-raw/stations.json', import.meta.url);
  if (existsSync(sp)) for (const e of JSON.parse(readFileSync(sp, 'utf8')).elements) {
    const t = e.tags; if (e.type !== 'node' || !t || t.railway !== 'station' || t.station === 'monorail') continue;
    const p = project(e.lat, e.lon); if (inBox(p, 300)) stationNodes.push(p);
  }
}
const STATION_RAIL_Z = 15.0;
const stationLB = (L, p) => (L.mode === 'metro' && stationNodes.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 95) ? STATION_RAIL_Z : 0);
for (const r of roadWays) r.el = { nodes: r.w.nodes, mode: 'road', bridge: r.bridge, order: r.bridge ? Math.max(1, parseLen(r.t.layer) || 1) : 0 };
const railLines = railWays.map((w) => {
  const bridge = !!(w.tags.bridge && w.tags.bridge !== 'no');
  const mode = w.tags.railway === 'tram' ? 'tram' : w.tags.railway === 'monorail' ? 'mono' : 'metro';
  return { w, nodes: w.nodes, mode, bridge: bridge || mode === 'mono', order: bridge || mode === 'mono' ? Math.max(1, parseLen(w.tags.layer) || 1) : 0 };
});
// Some mapped crossings cannot be built: a ramp too short to climb between the two levels it joins makes the
// upper deck chase the lower one up to the height limit, dragging the whole stack with it. Those crossings are
// found by a first solve and set aside (the two ways meet at one level there); the rest then settles.
let EL = null;
{
  const lines = [...roadWays.map((r) => r.el), ...railLines], skip = [];
  for (let pass = 0; pass < 4; pass++) {
    EL = solveElevations({ lines, pos: nodeXY, modes: ELEV_MODES, isWater, inside: (p) => inBox(p, -1), extraLB: stationLB, skip, log: pass ? () => {} : console.log });
    if (!EL.unresolved.length) break;
    for (const c of EL.unresolved) skip.push(EL.pos(c.hi).slice(0, 2));
  }
  console.log(`  elevation: ${skip.length} impossible crossings set aside, ${EL.unresolved.length} left unresolved`);
}
for (const c of EL.unresolved.slice(0, 8)) {
  const p = EL.pos(c.hi);
  console.log(`    unresolved crossing at [${p.map(Math.round)}]: ${c.hiLine.mode} over ${c.loLine.mode}, ${(EL.h.get(c.hi) || 0).toFixed(1)} vs ${(EL.h.get(c.lo) || 0).toFixed(1)} + ${c.C}`);
}
const lineXYZ = (L) => L.ids.map((id) => { const p = EL.pos(id); const z = EL.h.get(id) || 0; return [p[0], p[1], z < 0.03 ? 0 : z]; });

// Split a non-bridge way where it leaves the ground: approach ramps are drawn with solid retaining walls.
function splitByElevation(pts, thr = 0.25) {
  const out = []; let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const up = Math.max(pts[i][2], pts[i + 1][2]) > thr;
    if (!cur || cur.up !== up) { cur = { up, pts: [pts[i]] }; out.push(cur); }
    cur.pts.push(pts[i + 1]);
  }
  // short ground gaps between two elevated runs stay elevated
  for (let k = 1; k < out.length - 1; k++) {
    if (!out[k].up && out[k - 1].up && out[k + 1].up && polylineLength(out[k].pts) < 10) out[k].up = true;
  }
  const merged = [];
  for (const pc of out) {
    const last = merged[merged.length - 1];
    if (last && last.up === pc.up) last.pts.push(...pc.pts.slice(1)); else merged.push({ up: pc.up, pts: pc.pts.slice() });
  }
  return merged;
}

// Render roads: clip to box
const roadsOut = [];
let rampCount = 0;
for (const r of roadWays) {
  const pts = lineXYZ(r.el);
  const pieces = r.bridge ? [{ up: true, bridge: true, pts }] : splitByElevation(pts);
  for (const pc of pieces) {
    if (pc.up && !pc.bridge) rampCount++;
    for (const piece of clipPolyline(pc.pts, Rpad)) {
      const p3 = simplify3(piece.pts, 0.2, 0.05);
      if (polylineLength(p3) < 1) continue;
      const o = { k: r.kind, w: r1(r.width), l: r.lanes, o: r.oneway, p: p3.map(rpz) };
      if (pc.up) o.b = r.bridge ? r.layer : 1;
      if (pc.up && !pc.bridge) o.e = 1; // embankment / retaining-wall ramp
      if (r.name && r.rank >= 6 && !isArabic(r.name)) o.n = r.name;
      if (r.tw) {
        // t: [width at the piece's start, at its end] where it meets a way of another width (0: no taper)
        const near = (q, e) => q && Math.hypot(q[0] - e[0], q[1] - e[1]) < 1.5;
        const t0 = near(r.twp[0], p3[0]) ? r.tw[0] : near(r.twp[1], p3[0]) ? r.tw[1] : 0;
        const t1 = near(r.twp[1], p3[p3.length - 1]) ? r.tw[1] : near(r.twp[0], p3[p3.length - 1]) ? r.tw[0] : 0;
        if (t0 || t1) o.t = [r1(t0), r1(t1)];
      }
      if (r.jn && r.jn.length) {
        // junctions as distances along this piece: [s, radius, ...]
        const j = [];
        for (const [x, y, R] of r.jn) {
          let acc = 0, bs = -1, bd = 1.5;
          for (let i = 1; i < p3.length; i++) {
            const a = p3[i - 1], b = p3[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
            const t = L2 > 1e-9 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
            const d = Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
            if (d < bd) { bd = d; bs = acc + L * t; }
            acc += L;
          }
          if (bs >= 0) j.push(r1(bs), r1(R));
        }
        if (j.length) o.j = j;
      }
      roadsOut.push(o);
      (r.outs = r.outs || []).push(o);
    }
  }
}
console.log(`  ${rampCount} approach ramps on non-bridge ways`);

// Traffic graph (drivable roads only), split at junction nodes
console.log('Traffic graph...');
const nodeUse = new Map();
for (const r of roadWays) if (DRIVABLE.has(r.kind)) for (const n of r.w.nodes) nodeUse.set(n, (nodeUse.get(n) || 0) + 1);
const gNodeIdx = new Map(); const gNodes = [];
const gIndex = (key, p) => { let i = gNodeIdx.get(key); if (i == null) { i = gNodes.length; gNodeIdx.set(key, i); gNodes.push(rpz(p)); } return i; };
const gEdges = [];
for (const r of roadWays) {
  if (!DRIVABLE.has(r.kind)) continue;
  const ids = r.el.ids, prof = lineXYZ(r.el);
  let start = 0;
  for (let i = 1; i < ids.length; i++) {
    const junction = i === ids.length - 1 || (nodeUse.get(ids[i]) || 0) > 1;
    if (!junction) continue;
    const pts = simplify3(prof.slice(start, i + 1), 0.25, 0.08);
    const aKey = ids[start], bKey = ids[i];
    // clip to box
    const allIn = pts.every((p) => inBox(p));
    if (allIn) {
      gEdges.push({ a: gIndex(aKey, pts[0]), b: gIndex(bKey, pts[pts.length - 1]), r, pts });
    } else {
      const pieces = clipPolyline(pts, R);
      pieces.forEach((pc, k) => {
        const a = pc.startIn ? gIndex(aKey, pc.pts[0]) : gIndex(`x${r.w.id}_${start}_${k}a`, pc.pts[0]);
        const b = pc.endIn ? gIndex(bKey, pc.pts[pc.pts.length - 1]) : gIndex(`x${r.w.id}_${start}_${k}b`, pc.pts[pc.pts.length - 1]);
        if (polylineLength(pc.pts) > 0.5) gEdges.push({ a, b, r, pts: pc.pts });
      });
    }
    start = i;
  }
}
const graphOut = {
  nodes: gNodes,
  edges: gEdges.map((e) => ({ a: e.a, b: e.b, k: e.r.rank, l: e.r.lanes, o: e.r.oneway, w: r1(e.r.width), p: e.pts.map(rpz) })),
};

// ---------------------------------------------------------------- rails
const railsOut = [];
for (const L of railLines) {
  for (const piece of clipPolyline(lineXYZ(L), Rpad)) {
    const o = { k: L.mode, p: simplify3(piece.pts, 0.15, 0.04).map(rpz) };
    if (L.bridge) o.b = 1;
    railsOut.push(o);
  }
}

// ---------------------------------------------------------------- piers & breakwaters (linear)
const piersOut = { lines: [], areas: pierAreas.map((p) => clipPoly(p, 0.2)).filter(Boolean).map((p) => p.map(rRing)) };
for (const w of ways.values()) {
  const t = w.tags; if (!t) continue;
  if (t.man_made === 'pier' && !isClosed(w)) {
    for (const piece of clipPolyline(wayPts(w), Rpad)) piersOut.lines.push({ w: r1(parseLen(t.width) || 2.6), p: piece.pts.map(rp) });
  }
  if ((t.man_made === 'breakwater' || t.man_made === 'groyne') && !isClosed(w)) {
    for (const piece of clipPolyline(wayPts(w), Rpad)) pathsOut.push({ w: 7, k: 'breakwater', p: piece.pts.map(rp) });
  }
}

const buildingAt = (pt) => {
  let host = null;
  for (const b of bGrid.query(pt[0], pt[1])) if (!b.skip && pointInPoly(pt, b.polys[0]) && (!host || b.area < host.area)) host = b;
  return host;
};
// road surface test
const rGrid = new Grid(40);
for (const r of roadWays) {
  const pts = wayPts(r.w);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    rGrid.insert([Math.min(a[0], b[0]) - r.width, Math.min(a[1], b[1]) - r.width, Math.max(a[0], b[0]) + r.width, Math.max(a[1], b[1]) + r.width], { a, b, hw: r.width / 2 });
  }
}
const onRoad = (pt, margin = 0.8) => {
  for (const s of rGrid.query(pt[0], pt[1])) if (distToSegment(pt, s.a, s.b) < s.hw + margin) return true;
  return false;
};

// ---------------------------------------------------------------- viaducts (metro + elevated tram)
// One deck per twin-track corridor (not one per OSM track) on a single row of piers kept out of the
// carriageways below.
const viaductsOut = [], viaPiersOut = [];
for (const [mode, opt] of [['metro', { reach: 22, half: 2.9, span: 30 }], ['tram', { reach: 8, half: 2.3, span: 26 }], ['mono', { reach: 1.2, half: 0.45, span: 30 }]]) {
  const tracks = [];
  for (const L of railLines) {
    if (L.mode !== mode) continue;
    for (const piece of clipPolyline(lineXYZ(L), Rpad)) {
      // elevated runs only
      let run = [];
      for (const p of piece.pts) { if (p[2] > 1.0) run.push(p); else { if (run.length > 1) tracks.push(run); run = []; } }
      if (run.length > 1) tracks.push(run);
    }
  }
  for (const sp of viaductSpines(tracks, { reach: opt.reach, half: opt.half })) {
    viaductsOut.push({ k: mode, p: sp.map((q) => [r1(q[0]), r1(q[1]), r1(q[2]), r1(q[3])]) });
    for (const pr of placePiers(sp, { span: opt.span, blocked: (q) => q.z < 3 || !inBox([q.x, q.y], -2) || isWater([q.x, q.y]) || onRoad([q.x, q.y], 1.5) })) {
      viaPiersOut.push([r1(pr.x), r1(pr.y), r1(pr.z), Math.round(pr.ang * 1000) / 1000, r1(pr.w), mode === 'metro' ? 0 : mode === 'tram' ? 1 : 2]);
    }
  }
}
console.log(`  viaducts ${viaductsOut.length} (${viaductsOut.map((v) => v.k).join(',')}), piers ${viaPiersOut.length}`);

// pools: lift onto podium roofs when inside a low building
const poolsOut = [];
for (const p of pools) {
  const c = centroid(p[0]);
  if (!inBox(c, -2)) continue;
  const host = buildingAt(c);
  let z = 0;
  if (host) { if (host.h > 60) continue; z = host.h; }
  poolsOut.push({ z: r1(z), p: p.map((r) => rRing(simplifyRing(r, 0.15))) });
}

// ---------------------------------------------------------------- park & neighbourhood amenities
// Mapped amenities from OSM (courts by sport, playgrounds and their equipment, fountains, the running
// track, benches, artworks, fitness gear, shelters, flagpoles) plus cafe terraces facing the water.
// Large parks with no mapped playground get an illustrative one (flagged `ill`).
const amen = { courts: [], playgrounds: [], fountains: [], tracks: [], benches: [], cafes: [], art: [], fitness: [], shelters: [], flags: [], dogParks: [], plamps: [], bikeDocks: [], lifeguards: [] };
// beach ownership (set with the promenades, read again for umbrellas)
const beachClass = new Map();
const villaLikeGrid = new Grid(80), hotelGrid = new Grid(200), tallGrid = new Grid(200);
{
  // houses inside residential land (the Palm fronds), not kiosks, beach clubs or shops
  const resG = new Grid(200); (areas.residential || []).forEach((p) => resG.insert(bboxOf(p[0]), p));
  const inRes = (c) => resG.query(c[0], c[1]).some((p) => pointInPoly(c, p));
  const CIVIC = /^(commercial|retail|school|hospital|mosque|hotel|office|kindergarten|public|civic|church|clinic|kiosk)$/;
  for (const b of buildings) {
    const t = b.tags;
    const civic = !!(t.amenity || t.shop || t.office || t.leisure || t.tourism || t.name) || CIVIC.test(t.building || '');
    // registered in every cell within the search radius, so one cell lookup finds all neighbours
    if (b.h <= 13 && b.area >= 60 && b.area <= 1500 && !b.parts.length && !civic && inRes(b.c)) villaLikeGrid.insert([b.c[0] - 50, b.c[1] - 50, b.c[0] + 50, b.c[1] + 50], b.c);
    if (b.h > 30) tallGrid.insert([b.c[0] - 160, b.c[1] - 160, b.c[0] + 160, b.c[1] + 160], b.c);
  }
}
// hotel and resort footprints / grounds (distance to the outline, not the centre: resorts are huge)
for (const b of buildings) {
  if (/^(hotel|resort)$/.test(b.tags.tourism || '') || b.tags.building === 'hotel') { const bb = bboxOf(b.polys[0][0]); hotelGrid.insert([bb[0] - 130, bb[1] - 130, bb[2] + 130, bb[3] + 130], b.polys[0][0]); }
}
for (const w of ways.values()) {
  if (!w.tags || !/^(hotel|resort)$/.test(w.tags.tourism || '') || !isClosed(w)) continue;
  const p = wayPoly(w); if (!p) continue;
  const bb = bboxOf(p[0]); hotelGrid.insert([bb[0] - 130, bb[1] - 130, bb[2] + 130, bb[3] + 130], p[0]);
}
const nearIn = (g, p, d) => g.query(p[0], p[1]).some((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) < d);
const villaNear = (p, d) => nearIn(villaLikeGrid, p, d);
const hotelNear = (p, d) => hotelGrid.query(p[0], p[1]).some((ring) => pointInRing(p, ring) || ring.some((a, i) => distToSegment(p, a, ring[(i + 1) % ring.length]) < d));
// the mainland is the largest land polygon; islands (the Palm, Bluewaters) have no public running track
const mainland = coastResult.land.reduce((m, r) => (Math.abs(signedArea(r)) > Math.abs(signedArea(m)) ? r : m), coastResult.land[0]);
const amenGrid = new Grid(40); // footprints that trees and street furniture keep off
const amenAt = (p) => amenGrid.query(p[0], p[1]).some((r) => pointInRing(p, r));
function growRing(ring, d) {
  const c = centroid(ring);
  return ring.map((p) => { const dx = p[0] - c[0], dy = p[1] - c[1], l = Math.hypot(dx, dy) || 1; return [p[0] + (dx / l) * d, p[1] + (dy / l) * d]; });
}
const addAmenRing = (ring, pad = 0) => { const r = pad ? growRing(ring, pad) : ring; amenGrid.insert(bboxOf(r), r); };
const rectAt = (c, a, L, W) => { const ux = Math.cos(a), uy = Math.sin(a); return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [c[0] + (ux * i * L) / 2 - (uy * j * W) / 2, c[1] + (uy * i * L) / 2 + (ux * j * W) / 2]); };
const ang3 = (a) => Math.round(a * 1000) / 1000;
{
  const ra = rng(7070);
  const ap = new URL('../data-raw/amenities.json', import.meta.url);
  const araw = existsSync(ap) ? JSON.parse(readFileSync(ap, 'utf8')) : { elements: [] };
  const pts = [];
  for (const e of araw.elements) if (e.type === 'node' && e.tags) { const p = project(e.lat, e.lon); if (inBox(p, -3)) pts.push({ p, t: e.tags, id: e.id }); }
  // ground (0), a low podium/roof deck (its height), or indoors / high up (null: skip)
  const surfaceZ = (c) => { const h = buildingAt(c); return h ? (h.h < 40 && !h.parts.length ? h.h : null) : 0; };
  // nearest edge of marina water or a lake
  const wSegs = new Grid(60);
  for (const poly of [...(areas.marina || []), ...(areas.water || [])]) for (const r of poly) for (let i = 0; i < r.length; i++) {
    const a = r[i], b2 = r[(i + 1) % r.length];
    wSegs.insert([Math.min(a[0], b2[0]) - 80, Math.min(a[1], b2[1]) - 80, Math.max(a[0], b2[0]) + 80, Math.max(a[1], b2[1]) + 80], [a, b2]);
  }
  const nearestWater = (p, maxD) => {
    let best = null;
    for (const [a, b2] of wSegs.query(p[0], p[1])) {
      const dx = b2[0] - a[0], dy = b2[1] - a[1], L2 = dx * dx + dy * dy || 1;
      let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const q = [a[0] + dx * t, a[1] + dy * t], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < maxD && (!best || d < best.d)) best = { d, q };
    }
    return best;
  };
  const pSegs = new Grid(40);
  for (const pth of pathsOut) for (let i = 1; i < pth.p.length; i++) {
    const bb = bboxOf([pth.p[i - 1], pth.p[i]]);
    pSegs.insert([bb[0] - 45, bb[1] - 45, bb[2] + 45, bb[3] + 45], [pth.p[i - 1], pth.p[i], pth.w || 2.4, pth.k]);
  }
  const nearestPath = (p) => {
    let best = null;
    for (const [a, b2, w, k] of pSegs.query(p[0], p[1])) { const d = distToSegment(p, a, b2); if (!best || d < best.d) best = { d, a, b: b2, w, k }; }
    return best;
  };
  const pathAngle = (p, fallback) => { const pd = nearestPath(p); return pd ? Math.atan2(pd.b[1] - pd.a[1], pd.b[0] - pd.a[0]) : fallback; };

  // ---- sports courts fitted to their pitch outlines
  const SPORT = { tennis: 'tennis', basketball: 'basketball', soccer: 'soccer', football: 'soccer', padel: 'padel', beachvolleyball: 'volley', volleyball: 'volley', multi: 'multi' };
  for (const w of ways.values()) {
    const t = w.tags; if (!t || t.leisure !== 'pitch' || !isClosed(w) || t.sport === 'golf') continue;
    const ring = openRing(wayPts(w)); if (ring.length < 3) continue;
    const c = centroid(ring); if (!inBox(c, -2)) continue;
    const ob = obb(ring); if (!ob || ob.len < 8) continue;
    const z = surfaceZ(c); if (z == null) continue;
    let s = SPORT[(t.sport || '').split(';')[0]] || 'multi';
    if (s === 'multi' && ob.len > 45) s = 'soccer'; // big unlabelled pitches are playing fields, not hard courts
    const n = s === 'tennis' ? Math.max(1, Math.min(6, Math.round(ob.wid / 17.5))) : s === 'padel' ? Math.max(1, Math.min(6, Math.round(ob.wid / 11))) : 1;
    const a = Math.atan2(ob.u[1], ob.u[0]);
    amen.courts.push({ s, c: rp(ob.center), a: ang3(a), L: r1(ob.len), W: r1(ob.wid), n, z: r1(z) });
    addAmenRing(rectAt(ob.center, a, ob.len + 2, ob.wid + 2));
  }
  // ---- running tracks (stadium ovals)
  for (const w of ways.values()) {
    const t = w.tags; if (!t || t.leisure !== 'track' || !isClosed(w)) continue;
    const ring = openRing(wayPts(w)); const ob = obb(ring); if (!ob || ob.len < 40) continue;
    if (!inBox(ob.center, -2)) continue;
    const a = Math.atan2(ob.u[1], ob.u[0]);
    amen.tracks.push({ c: rp(ob.center), a: ang3(a), L: r1(ob.len), W: r1(ob.wid) });
    addAmenRing(rectAt(ob.center, a, ob.len + 2, ob.wid + 2));
  }
  // ---- playgrounds: mapped outlines, mapped points, then illustrative ones in big parks
  const equipPts = pts.filter((q) => q.t.playground);
  const pgRings = [];
  const makePlayground = (ring, ill) => {
    const ob = obb(ring); if (!ob) return;
    const a = Math.atan2(ob.u[1], ob.u[0]);
    const area = Math.abs(signedArea(ring));
    const z = surfaceZ(ob.center); if (z == null) return;
    const loc = (fu, fv) => [ob.center[0] + (ob.u[0] * fu * ob.len) / 2 + (ob.v[0] * fv * ob.wid) / 2, ob.center[1] + (ob.u[1] * fu * ob.len) / 2 + (ob.v[1] * fv * ob.wid) / 2];
    const eq = [];
    const mapped = equipPts.filter((q) => pointInRing(q.p, ring));
    for (const q of mapped) eq.push([r1(q.p[0]), r1(q.p[1]), ang3(a), q.t.playground === 'springy' ? 2 : q.t.playground === 'swing' ? 1 : 0]);
    if (!mapped.length) {
      eq.push([...rp(loc(-0.35, 0.05)), ang3(a), 0]); // play tower with slide
      if (area > 160) eq.push([...rp(loc(0.42, -0.25)), ang3(a), 1]); // swings
      if (area > 120) eq.push([...rp(loc(0.38, 0.45)), ang3(a + ra() * 3), 2], [...rp(loc(0.15, 0.55)), ang3(a + ra() * 3), 2]); // springy riders
      if (area > 380) eq.push([...rp(loc(0.05, -0.5)), ang3(a), 3]); // climbing dome
    }
    // tensioned shade sails over the play area (one per ~140 m2, at most three along the long axis)
    const sails = [];
    const ns = Math.max(1, Math.min(3, Math.round(area / 140)));
    for (let k = 0; k < ns; k++) {
      const fu = ns === 1 ? 0 : -0.62 + (1.24 * k) / (ns - 1);
      sails.push([...rp(loc(fu, 0)), ang3(a), r1(Math.min(14, ob.len / ns + 1.5)), r1(Math.min(13, ob.wid + 1)), Math.floor(ra() * 4)]);
    }
    amen.playgrounds.push({ p: rRing(ring), c: rp(ob.center), a: ang3(a), L: r1(ob.len), W: r1(ob.wid), z: r1(z), eq, sails, ...(ill ? { ill: 1 } : {}) });
    pgRings.push(ring); addAmenRing(ring, 1.0);
  };
  for (const w of ways.values()) {
    const t = w.tags; if (!t || t.leisure !== 'playground' || !isClosed(w)) continue;
    let ring = openRing(wayPts(w)); if (ring.length < 3 || !inBox(centroid(ring), -2)) continue;
    if (Math.abs(signedArea(ring)) < 30) continue;
    if (signedArea(ring) < 0) ring = ring.slice().reverse();
    makePlayground(ring, false);
  }
  for (const q of pts.filter((q) => q.t.leisure === 'playground')) {
    if (pgRings.some((r) => pointInRing(q.p, r)) || buildingAt(q.p)) continue;
    makePlayground(rectAt(q.p, pathAngle(q.p, 0), 14, 10), false);
  }
  {
    const parks = (areas.park || []).filter((poly) => Math.abs(signedArea(poly[0])) >= 3000 && inBox(centroid(poly[0]), -10));
    let added = 0;
    for (const poly of parks) {
      if (added >= 18) break;
      const ring = poly[0], c0 = centroid(ring);
      if (pgRings.some((r) => { const c = centroid(r); return Math.hypot(c[0] - c0[0], c[1] - c0[1]) < 160; })) continue;
      const bb = bboxOf(ring);
      for (let k = 0; k < 60; k++) {
        const c = [bb[0] + ra() * (bb[2] - bb[0]), bb[1] + ra() * (bb[3] - bb[1])];
        const pd = nearestPath(c); const a = pd ? Math.atan2(pd.b[1] - pd.a[1], pd.b[0] - pd.a[0]) : ra() * Math.PI;
        const rect = rectAt(c, a, 16, 12);
        const probe = [...rect, c, ...rect.map((p) => [(p[0] + c[0]) / 2, (p[1] + c[1]) / 2])];
        if (!probe.every((p) => pointInPoly(p, poly))) continue;
        if (probe.some((p) => onRoad(p, 1.5) || isWater(p) || buildingAt(p) || amenAt(p))) continue;
        if (pd && pd.d < 3) continue;
        makePlayground(rect, true); added++; break;
      }
    }
  }
  // ---- fountains: basins on land, jets in the water
  const ftRings = [];
  for (const w of ways.values()) {
    const t = w.tags; if (!t || t.amenity !== 'fountain' || !isClosed(w)) continue;
    const ring = openRing(wayPts(w)); if (ring.length < 3) continue;
    const c = centroid(ring); if (!inBox(c, -2)) continue;
    const z = surfaceZ(c); if (z == null) continue;
    const ccwR = signedArea(ring) > 0 ? ring : ring.slice().reverse();
    const rad = Math.sqrt(Math.abs(signedArea(ring)) / Math.PI);
    amen.fountains.push({ c: rp(c), r: r1(rad), p: rRing(simplifyRing(ccwR, 0.2)), z: r1(z), w: isWater(c) ? 1 : 0 });
    ftRings.push(ccwR); addAmenRing(ccwR, 0.8);
  }
  for (const q of pts.filter((q) => q.t.amenity === 'fountain')) {
    if (ftRings.some((r) => pointInRing(q.p, r))) continue;
    const z = surfaceZ(q.p); if (z == null) continue;
    const wet = isWater(q.p), rad = wet ? 2 : 2.6 + ra() * 1.6;
    amen.fountains.push({ c: rp(q.p), r: r1(rad), z: r1(z), w: wet ? 1 : 0 });
    if (!wet) addAmenRing(rectAt(q.p, 0, rad * 2 + 2, rad * 2 + 2));
  }
  // lake aerators: nearly every lake on the Emirates Hills course and estate jets one (the landscape photographs; the
  // aerial views, a visual reference only, agree); where OSM maps none, one goes at the lake's centre
  {
    const ehw = ways.get(1012104272), eh = ehw && isClosed(ehw) ? wayPoly(ehw) : null;
    if (eh) for (const pl of areas.water || []) {
      const ring = pl[0], a = Math.abs(signedArea(ring)); if (a < 2500 || a > 400000) continue;
      const c = centroid(ring); if (!pointInPoly(c, eh) || !pointInPoly(c, pl)) continue;
      if (amen.fountains.some((f) => f.w && pointInPoly(f.c, pl))) continue;
      const z = surfaceZ(c); if (z == null) continue;
      amen.fountains.push({ c: rp(c), r: 2.2, z: r1(z), w: 1 });
    }
  }
  // ---- outdoor dining: restaurants, cafes and bars spill out onto the walkway in front of them
  // (JBR The Walk & The Beach, Marina Walk, Bluewaters, JLT promenades); else onto the waterfront.
  // Low pavilions with a restaurant also get rooftop dining.
  const FOOD = new Set(['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'ice_cream', 'food_court']);
  const closestOn = (p, a, b2) => { const dx = b2[0] - a[0], dy = b2[1] - a[1], L2 = dx * dx + dy * dy || 1; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t)); return [a[0] + dx * t, a[1] + dy * t]; };
  const tryTerrace = (q, target, halfW, z = 0) => {
    const D = Math.hypot(target[0] - q.p[0], target[1] - q.p[1]); if (D < 1) return false;
    const dx = (target[0] - q.p[0]) / D, dy = (target[1] - q.p[1]) / D;
    let s0 = -1;
    for (let st = 0; st <= D; st += 0.6) { if (!buildingAt([q.p[0] + dx * st, q.p[1] + dy * st])) { s0 = st; break; } }
    if (s0 < 0) return false;
    let depth = Math.min(6.5, D - s0 - halfW - 0.4), cd = s0 + 0.6 + depth / 2;
    if (depth < 2.6 && halfW >= 2.5) { depth = Math.min(4.5, halfW * 0.9); cd = D - halfW + depth / 2 + 0.3; } // tables spill onto a wide promenade
    if (depth < 2.6) return false;
    const c = [q.p[0] + dx * cd, q.p[1] + dy * cd], a = Math.atan2(dy, dx);
    const n = 2 + Math.floor(ra() * 3), rows = depth > 5.5 ? 2 : 1;
    const rect = rectAt(c, a, depth, n * 3.3);
    if (rect.some((p) => onRoad(p, 0.4) || isWater(p) || amenAt(p) || buildingAt(p))) return false;
    amen.cafes.push([r1(c[0]), r1(c[1]), ang3(a), n, rows, Math.floor(ra() * 4), z]);
    addAmenRing(rect);
    return true;
  };
  for (const q of pts.filter((q) => FOOD.has(q.t.amenity) || q.t.leisure === 'outdoor_seating')) {
    let placed = false;
    const pd = nearestPath(q.p);
    if (pd && pd.d < 42 && typeof pd.k === 'number' && pd.k !== 5) placed = tryTerrace(q, closestOn(q.p, pd.a, pd.b), pd.w / 2);
    if (!placed) { const nw = nearestWater(q.p, 75); if (nw) placed = tryTerrace(q, nw.q, 4.5); }
    const host = buildingAt(q.p);
    if (host && host.h > 3.5 && host.h < 14 && !host.parts.length && host.area > 160 && !host.roofDining && ra() < 0.5) {
      const ob = obb(host.polys[0][0]);
      if (ob && ob.len > 11 && ob.wid > 8) {
        host.roofDining = true;
        const n = Math.max(2, Math.min(6, Math.floor((ob.len - 5) / 3.3))), rows = ob.wid > 15 ? 2 : 1;
        amen.cafes.push([r1(ob.center[0]), r1(ob.center[1]), ang3(Math.atan2(ob.u[1], ob.u[0]) + Math.PI / 2), n, rows, Math.floor(ra() * 4), r1(host.h)]);
      }
    }
  }
  // ---- benches: mapped ones face the water or their path; plus benches along the Marina Walk
  const benchAt = (p, face) => {
    if (onRoad(p, 0.8) || isWater(p) || buildingAt(p) || amenAt(p)) return;
    amen.benches.push([r1(p[0]), r1(p[1]), ang3(face)]); addAmenRing(rectAt(p, face, 1.2, 2.2));
  };
  for (const q of pts.filter((q) => q.t.amenity === 'bench' || q.t.leisure === 'picnic_table')) {
    const nw = nearestWater(q.p, 30);
    if (nw) { benchAt(q.p, Math.atan2(nw.q[1] - q.p[1], nw.q[0] - q.p[0])); continue; }
    const pd = nearestPath(q.p);
    if (pd) {
      const ex = pd.b[0] - pd.a[0], ey = pd.b[1] - pd.a[1], el = Math.hypot(ex, ey) || 1;
      // face across the path: toward the side of the path line the bench is not on
      const side = (q.p[0] - pd.a[0]) * ey - (q.p[1] - pd.a[1]) * ex > 0 ? 1 : -1;
      benchAt(q.p, Math.atan2((ex / el) * side, (-ey / el) * side));
    } else benchAt(q.p, ra() * Math.PI * 2);
  }
  for (const poly of areas.marina || []) for (const ring of poly) {
    let acc = ra() * 34;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b2 = ring[(i + 1) % ring.length]; const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]); if (L < 1) continue;
      const ux = (b2[0] - a[0]) / L, uy = (b2[1] - a[1]) / L;
      for (let s = acc; s < L; s += 34) {
        const e = [a[0] + ux * s, a[1] + uy * s];
        for (const sd of [1, -1]) {
          const p = [e[0] - uy * 2.6 * sd, e[1] + ux * 2.6 * sd];
          if (isWater(p) || !inBox(p, -3)) continue;
          benchAt(p, Math.atan2(e[1] - p[1], e[0] - p[0]));
          break;
        }
      }
      acc = ((acc - L) % 34 + 34) % 34;
    }
  }
  // ---- artworks, fitness gear, shelters, flagpoles
  for (const q of pts) {
    const t = q.t, z = surfaceZ(q.p); if (z == null) continue;
    if (t.tourism === 'artwork') {
      if (amenAt(q.p) || onRoad(q.p, 1)) continue;
      amen.art.push([r1(q.p[0]), r1(q.p[1]), r1(z), Math.floor(ra() * 4), Math.round((0.8 + ra() * 0.6) * 100) / 100]);
      addAmenRing(rectAt(q.p, 0, 4, 4));
    } else if (t.leisure === 'fitness_station') {
      if (amenAt(q.p)) continue;
      const kind = t.fitness_station === 'parallel_bars' ? 1 : t.fitness_station === 'horizontal_ladder' ? 0 : Math.floor(ra() * 3);
      amen.fitness.push([r1(q.p[0]), r1(q.p[1]), r1(z), ang3(pathAngle(q.p, 0)), kind]);
      addAmenRing(rectAt(q.p, 0, 4, 4));
    } else if (t.amenity === 'shelter' || t.tourism === 'picnic_site') {
      if (amenAt(q.p) || onRoad(q.p, 1.5)) continue;
      amen.shelters.push([r1(q.p[0]), r1(q.p[1]), r1(z), ang3(pathAngle(q.p, ra() * Math.PI))]);
      addAmenRing(rectAt(q.p, 0, 7, 7));
    } else if (t.man_made === 'flagpole') amen.flags.push([r1(q.p[0]), r1(q.p[1]), r1(z), r1(12 + ra() * 10)]);
    else if (t.amenity === 'bicycle_rental' && !amenAt(q.p) && !onRoad(q.p, 0.8) && !buildingAt(q.p)) {
      amen.bikeDocks.push([r1(q.p[0]), r1(q.p[1]), ang3(pathAngle(q.p, ra() * Math.PI)), 6 + Math.floor(ra() * 6)]);
      addAmenRing(rectAt(q.p, 0, 9, 4));
    }
  }
  for (const w of ways.values()) {
    const t = w.tags; if (!t || !isClosed(w)) continue;
    if (t.leisure === 'dog_park') { const ring = openRing(wayPts(w)); if (ring.length >= 3 && inBox(centroid(ring), -2)) amen.dogParks.push(rRing(ring)); }
    if (t.leisure === 'fitness_station') {
      const ring = openRing(wayPts(w)); const ob = obb(ring); if (!ob || !inBox(ob.center, -2)) continue;
      const a = Math.atan2(ob.u[1], ob.u[0]);
      for (let k = 0; k < 4; k++) { const f = -0.6 + k * 0.4; amen.fitness.push([r1(ob.center[0] + (ob.u[0] * f * ob.len) / 2), r1(ob.center[1] + (ob.u[1] * f * ob.len) / 2), 0, ang3(a), k % 3]); }
      addAmenRing(ring);
    }
  }
  // ---- liveliness of each walkway (0..1): venues and shops close by, beach or marina at hand
  const poiGrid = new Grid(80);
  for (const q of pts) if (FOOD.has(q.t.amenity) || q.t.shop) poiGrid.insert([q.p[0] - 70, q.p[1] - 70, q.p[0] + 70, q.p[1] + 70], q.p);
  const beachPolys = areas.beach || [];
  const nearBeach = (p) => [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40]].some(([ox, oy]) => beachPolys.some((poly) => pointInPoly([p[0] + ox, p[1] + oy], poly)));
  const along = (pl, d) => { for (let i = 1; i < pl.length; i++) { const L = Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]); if (d <= L || i === pl.length - 1) { const t = L ? Math.min(1, d / L) : 0; return [pl[i - 1][0] + (pl[i][0] - pl[i - 1][0]) * t, pl[i - 1][1] + (pl[i][1] - pl[i - 1][1]) * t]; } d -= L; } return pl[0]; };
  for (const pth of pathsOut) {
    if (typeof pth.k !== 'number') continue;
    const L = polylineLength(pth.p), n = Math.max(1, Math.ceil(L / 30));
    let pois = 0, water = 0, beach = 0;
    for (let i = 0; i <= n; i++) {
      const q = along(pth.p, (i / n) * L);
      pois = Math.max(pois, poiGrid.query(q[0], q[1]).filter((o) => Math.hypot(o[0] - q[0], o[1] - q[1]) < 70).length);
      if (!water && nearestWater(q, 45)) water = 1;
      if (!beach && i % 2 === 0 && nearBeach(q)) beach = 1;
    }
    pth.l = Math.round(Math.min(1, pois / 6 + water * 0.35 + beach * 0.4 + (pth.k === 1 ? 0.2 : 0)) * 10) / 10;
  }
  // ---- beach promenades (JBR / The Beach style): a paved walk along the landward edge of every public
  // sandy beach with a rubber running track beside it, plus lifeguard towers along the waterline.
  // Hotel and resort beaches and the villa beaches of the Palm fronds stay private.
  // Umbrellas, palms and furniture keep clear of the band.
  {
    const offsetL = (pts, d) => pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b2 = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b2[0] - a[0], dy = b2[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [p[0] - (dy / l) * d, p[1] + (dx / l) * d];
    });
    const band = (line, d0, d1) => {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b2 = line[i], L = Math.hypot(b2[0] - a[0], b2[1] - a[1]); if (L < 0.5) continue;
        const ux = (b2[0] - a[0]) / L, uy = (b2[1] - a[1]) / L, nx = -uy, ny = ux;
        addAmenRing([[a[0] + nx * d0, a[1] + ny * d0], [b2[0] + nx * d0, b2[1] + ny * d0], [b2[0] + nx * d1, b2[1] + ny * d1], [a[0] + nx * d1, a[1] + ny * d1]]);
      }
    };
    let promM = 0, guards = 0;
    const cls = { public: 0, hotel: 0, villa: 0 };
    for (const poly of areas.beach || []) {
      let ring = poly[0]; if (signedArea(ring) < 0) ring = ring.slice().reverse();
      if (Math.abs(signedArea(ring)) < 4000) continue;
      const n = ring.length;
      const side = ring.map((a, i) => {
        const b2 = ring[(i + 1) % n], dx = b2[0] - a[0], dy = b2[1] - a[1], L = Math.hypot(dx, dy) || 1;
        const out = [(a[0] + b2[0]) / 2 + (dy / L) * 6, (a[1] + b2[1]) / 2 - (dx / L) * 6]; // just outside a CCW ring
        if (L < 0.5 || !inBox(out, -2)) return 0;
        return isWater(out) ? 2 : 1; // 1 landward edge, 2 waterline
      });
      // who owns the sand: villas backing onto it (Palm fronds), a hotel or resort, or the public
      {
        let nV = 0, nH = 0, nS = 0, nT = 0;
        for (let i = 0; i < n; i++) {
          if (side[i] !== 1) continue;
          const a = ring[i], b2 = ring[(i + 1) % n], L = Math.hypot(b2[0] - a[0], b2[1] - a[1]);
          for (let d = 0; d < L; d += 15) {
            const p = [a[0] + ((b2[0] - a[0]) * d) / L, a[1] + ((b2[1] - a[1]) * d) / L];
            nS++; if (villaNear(p, 45)) nV++; if (hotelNear(p, 110)) nH++; if (nearIn(tallGrid, p, 150)) nT++;
          }
        }
        const bc = centroid(ring), towers = nS && nT / nS > 0.3; // towers behind the sand: an urban beach (JBR, Beachfront)
        // explicit OSM hints win: Kite Beach, Jumeirah Public (Sunset) Beach... are public; access=customers is private
        const bt = beachTags.get(poly) || {};
        const bn = `${bt['name:en'] || bt.name || ''} ${bt['alt_name:en'] || ''}`;
        const tagPublic = /^(yes|public|permissive)$/.test(bt.access || '') || bt.fee === 'no' || bt.lifeguard === 'yes' || bt.tourism === 'attraction' ||
          /\b(public|kite|sunset|open) beach\b/i.test(bn) || /^\s*jumeirah beach\s*$/i.test(bn);
        const tagPrivate = /^(private|customers|members|no)$/.test(bt.access || '') || /\bprivate\b/i.test(bn);
        const villaFront = nS && nV / nS > 0.25 && !towers;
        const k = tagPublic ? 'public' : tagPrivate ? (villaFront ? 'villa' : 'hotel') : nS && nH / nS > 0.5 ? 'hotel' : villaFront ? 'villa' : 'public';
        var publicMain = k === 'public' && pointInRing(bc, mainland);
        beachClass.set(poly, k); cls[k]++;
        if (process.env.DEBUG_BEACH) console.log(`    beach ${k.padEnd(6)} [${bc.map(Math.round)}] area ${Math.round(Math.abs(signedArea(ring)))} villa ${nV}/${nS} hotel ${nH}/${nS}${towers ? ' towers' : ''} ${bn.trim()} ${bt.access || ''}`);
        if (k !== 'public') continue; // private sand: no public promenade, track or lifeguards
      }
      for (const want of [1, 2]) {
        let start = side.findIndex((v) => v !== want); if (start < 0) start = 0;
        let run = [];
        const flush = () => {
          if (run.length >= 2) {
            const L = polylineLength(run);
            if (want === 1 && L > 60) {
              const walk = offsetL(run, 4.2), track = offsetL(run, 8.8);
              for (const piece of clipPolyline(walk, Rpad)) pathsOut.push({ k: 1, w: 6, l: 1, p: simplifyLine(piece.pts, 0.3).map(rp) });
              if (publicMain) for (const piece of clipPolyline(track, Rpad)) pathsOut.push({ k: 7, w: 2.4, l: 1, p: simplifyLine(piece.pts, 0.3).map(rp) });
              band(run, 0.8, publicMain ? 10.4 : 7.4); promM += L;
            }
            if (want === 2 && L > 120 && publicMain) {
              // lifeguard towers every ~220 m, a few metres up the sand, looking out to sea
              const cum = [0]; for (let i = 1; i < run.length; i++) cum.push(cum[i - 1] + Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]));
              for (let d = 90; d < L - 40; d += 220) {
                let i = 1; while (i < run.length - 1 && cum[i] < d) i++;
                const a = run[i - 1], b2 = run[i], t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
                const ux = (b2[0] - a[0]) / ((cum[i] - cum[i - 1]) || 1), uy = (b2[1] - a[1]) / ((cum[i] - cum[i - 1]) || 1);
                const p = [a[0] + (b2[0] - a[0]) * t - uy * 9, a[1] + (b2[1] - a[1]) * t + ux * 9];
                if (isWater(p) || amenAt(p)) continue;
                amen.lifeguards.push([r1(p[0]), r1(p[1]), ang3(Math.atan2(-ux, uy))]); guards++;
                addAmenRing(rectAt(p, 0, 5, 5));
              }
            }
          }
          run = [];
        };
        for (let k = 1; k <= n; k++) {
          const i = (start + k) % n;
          if (side[i] === want) { if (!run.length) run.push(ring[i]); run.push(ring[(i + 1) % n]); } else flush();
        }
        flush();
      }
    }
    console.log(`  beaches: ${cls.public} public, ${cls.hotel} hotel/resort, ${cls.villa} villa-fronted; promenades ${Math.round(promM)} m (+ running track), lifeguard towers ${guards}`);
  }
  // ---- promenade lamps: slim lanterns along the lively walkways, alternating sides
  for (const pth of pathsOut) {
    if (typeof pth.k !== 'number' || (pth.l || 0) < 0.45 || ![0, 1, 3, 6].includes(pth.k)) continue;
    let acc = 9, side = 1;
    for (let i = 1; i < pth.p.length; i++) {
      const a = pth.p[i - 1], b2 = pth.p[i]; const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]); if (L < 0.5) continue;
      const ux = (b2[0] - a[0]) / L, uy = (b2[1] - a[1]) / L;
      for (let st = acc; st < L; st += 24) {
        const q = [a[0] + ux * st - uy * side * (pth.w / 2 + 0.5), a[1] + uy * st + ux * side * (pth.w / 2 + 0.5)];
        side = -side;
        if (!inBox(q, -2) || onRoad(q, 0.6) || isWater(q) || buildingAt(q) || amenAt(q)) continue;
        amen.plamps.push([r1(q[0]), r1(q[1])]);
      }
      acc = ((acc - L) % 24 + 24) % 24;
    }
  }
  const nIll = amen.playgrounds.filter((p) => p.ill).length;
  console.log(`  amenities: courts ${amen.courts.length}, playgrounds ${amen.playgrounds.length} (${nIll} illustrative), fountains ${amen.fountains.length}, tracks ${amen.tracks.length}, dining terraces ${amen.cafes.length}, promenade lamps ${amen.plamps.length}, benches ${amen.benches.length}, art ${amen.art.length}, fitness ${amen.fitness.length}, shelters ${amen.shelters.length}, flags ${amen.flags.length}`);
}

// ---------------------------------------------------------------- vegetation index (Sentinel-2, Oct 2026)
// scripts/fetch-ndvi.py resamples NDVI from a cloud-free 2026 scene onto this grid; it says where
// irrigated planting really is today, including the landscaping OSM never mapped.
let ndviMeta = null, ndviGrid = null;
{
  const mp = new URL('../data-raw/ndvi.json', import.meta.url), bp = new URL('../data-raw/ndvi.bin', import.meta.url);
  if (existsSync(mp) && existsSync(bp)) { ndviMeta = JSON.parse(readFileSync(mp, 'utf8')); ndviGrid = new Uint8Array(readFileSync(bp)); }
}
const ndviAt = (p) => {
  if (!ndviGrid) return 0;
  const { w, h, res, x0, y1 } = ndviMeta;
  const c = (p[0] - x0) / res - 0.5, r = (y1 - p[1]) / res - 0.5;
  const c0 = Math.max(0, Math.min(w - 2, Math.floor(c))), r0 = Math.max(0, Math.min(h - 2, Math.floor(r)));
  const fc = Math.max(0, Math.min(1, c - c0)), fr = Math.max(0, Math.min(1, r - r0));
  const v = (i, j) => ndviGrid[j * w + i];
  const val = v(c0, r0) * (1 - fc) * (1 - fr) + v(c0 + 1, r0) * fc * (1 - fr) + v(c0, r0 + 1) * (1 - fc) * fr + v(c0 + 1, r0 + 1) * fc * fr;
  return (val / 255) * 0.9 - 0.1;
};

// ---------------------------------------------------------------- trees
console.log('Trees...');
const rand = rng(20251105);
// Tree types: 0 date palm, 1 broadleaf, 2 Washingtonia fan palm, 3 shrub, 4 bougainvillea, 5 flame tree
// (royal poinciana), 6 yellow flame / golden shower, 7 ghaf, 8 neem, 9 conocarpus, 10 frangipani.
// Species mixes per setting, from how Dubai streets, parks and villa gardens are planted.
const MIX = {
  garden: [[0, 0.28], [8, 0.13], [5, 0.12], [6, 0.08], [10, 0.13], [9, 0.08], [1, 0.06], [3, 0.12]],
  park: [[0, 0.26], [5, 0.12], [6, 0.08], [8, 0.16], [7, 0.12], [1, 0.12], [2, 0.06], [10, 0.08]],
  communityStreet: [[0, 0.34], [8, 0.2], [5, 0.15], [7, 0.1], [6, 0.11], [9, 0.1]],
  boulevard: [[0, 0.72], [2, 0.14], [9, 0.07], [7, 0.07]],
  lake: [[0, 0.5], [5, 0.16], [8, 0.14], [6, 0.12], [10, 0.08]],
  dense: [[1, 0.18], [8, 0.24], [7, 0.16], [5, 0.12], [6, 0.1], [0, 0.2]],
  light: [[3, 0.32], [7, 0.26], [0, 0.2], [9, 0.22]],
};
const pickSpecies = (mix, rv = rand) => { let x = rv(); for (const [t, w] of mix) { if ((x -= w) <= 0) return t; } return mix[0][0]; };
const trees = []; // [x, y, z, type, scale]
const treeGrid = new Grid(6);
const tooClose = (pt, d) => { for (const q of treeGrid.query(pt[0], pt[1])) if (Math.hypot(q[0] - pt[0], q[1] - pt[1]) < d) return true; return false; };
function addTree(pt, type, scale, opts = {}) {
  if (!inBox(pt, -3)) return false;
  if (amenAt(pt)) return false;
  if (!opts.allowNear && tooClose(pt, opts.minDist || 3.2)) return false;
  if (isWater(pt)) return false;
  let z = 0;
  const host = buildingAt(pt);
  const worship = host && host.tags && (host.tags.building === 'mosque' || host.tags.amenity === 'place_of_worship');
  // roof gardens, never on a villa or a mosque, nor on a mall or souk that has its own roof model (mapped trees there
  // stand in lanes and courts the outline does not cut out)
  if (host) { if (host.h > 40 || host.parts.length || host.villa || host.annex || worship || /(^| )(mall|souk)( |$)|mercato/i.test(cleanName(host.tags) || '')) return false; z = host.h; }
  if (!opts.allowRoad && z === 0 && onRoad(pt, 0.6)) return false;
  const rec = [r1(pt[0]), r1(pt[1]), r1(z), type, Math.round(scale * 100) / 100];
  trees.push(rec); treeGrid.insert([pt[0], pt[1], pt[0], pt[1]], rec);
  return true;
}
// mapped trees
for (const n of nodes.values()) {
  if (n.tags && n.tags.natural === 'tree') {
    const p = project(n.lat, n.lon);
    const palm = /palm|phoenix|washingtonia|arecaceae/i.test(`${n.tags.species || ''}${n.tags.genus || ''}${n.tags['species:en'] || ''}${n.tags.leaf_type || ''}`) || n.tags.leaf_type !== 'broadleaved';
    addTree(p, palm ? 0 : 1, 0.85 + rand() * 0.4, { minDist: 1.5 });
  }
}
// tree rows
for (const w of ways.values()) {
  if (!w.tags || w.tags.natural !== 'tree_row') continue;
  const pts = wayPts(w); let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = (8 - acc); s < L; s += 8) addTree(lerpPt(a, b, s / L), 0, 0.9 + rand() * 0.3);
    acc = (acc + L) % 8;
  }
}
// palms lining major roads (both sides)
for (const r of roadWays) {
  if (r.bridge || !['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'trunk'].includes(r.kind)) continue;
  const pts = wayPts(r.w);
  const spacing = r.kind === 'residential' ? 13 : 11;
  const off = r.width / 2 + 2.2;
  let acc = rand() * spacing;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
    const nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
    const mixK = ['residential', 'unclassified'].includes(r.kind) ? MIX.communityStreet : MIX.boulevard;
    for (let s = acc; s < L; s += spacing) {
      const p = lerpPt(a, b, s / L);
      const sp = pickSpecies(mixK); // the same species along a stretch, as planted
      for (const side of r.oneway ? [1] : [1, -1]) {
        const q = [p[0] + nx * off * side, p[1] + ny * off * side];
        addTree(q, rand() < 0.85 ? sp : pickSpecies(mixK), 0.85 + rand() * 0.35);
      }
    }
    acc = (acc - L) % spacing; if (acc < 0) acc += spacing;
  }
}
// medians on dual carriageways get palms too (oneway roads: other side)
// scatter in parks / gardens / golf rough / wood
function scatter(poly, density, typeFn, minDist = 3.5) {
  const bb = bboxOf(poly[0]);
  const area = Math.abs(signedArea(poly[0]));
  const n = Math.min(4000, Math.round(area * density));
  for (let i = 0; i < n; i++) {
    const pt = [bb[0] + rand() * (bb[2] - bb[0]), bb[1] + rand() * (bb[3] - bb[1])];
    if (!pointInPoly(pt, poly)) continue;
    addTree(pt, typeFn(), 0.8 + rand() * 0.6, { minDist });
  }
}
const golfInner = [...(areas.fairway || []), ...(areas.golfgreen || []), ...(areas.bunker || []), ...(areas.water || [])];
const golfAreaGrid = new Grid(150); for (const pl of [...(areas.golf || []), ...(areas.fairway || []), ...(areas.rough || [])]) golfAreaGrid.insert(bboxOf(pl[0]), pl);
// the main roads (secondary and up), for the plot edges that face them
const majorGrid = new Grid(60);
for (const r of roadWays) if (r.rank >= 7 && !r.bridge) { const pts = wayPts(r.w); for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; majorGrid.insert([Math.min(a[0], b[0]) - 20, Math.min(a[1], b[1]) - 20, Math.max(a[0], b[0]) + 20, Math.max(a[1], b[1]) + 20], { a, b, hw: r.width / 2 }); } }
const giGrid = new Grid(100); golfInner.forEach((p) => giGrid.insert(bboxOf(p[0]), p));
for (const p of areas.park || []) scatter(p, 1 / 140, () => pickSpecies(MIX.park));
for (const p of areas.wood || []) scatter(p, 1 / 45, () => (rand() < 0.3 ? 0 : 1), 3);
for (const p of areas.grass || []) { const a = Math.abs(signedArea(p[0])); if (a > 150) scatter(p, 1 / 260, () => (rand() < 0.5 ? 0 : pickSpecies(MIX.park))); }
for (const p of areas.golf || []) {
  const bb = bboxOf(p[0]); const area = Math.abs(signedArea(p[0]));
  const n = Math.round(area / 220);
  for (let i = 0; i < n; i++) {
    const pt = [bb[0] + rand() * (bb[2] - bb[0]), bb[1] + rand() * (bb[3] - bb[1])];
    if (!pointInPoly(pt, p)) continue;
    let inner = false; for (const q of giGrid.query(pt[0], pt[1])) if (pointInPoly(pt, q)) { inner = true; break; }
    if (inner) continue;
    addTree(pt, rand() < 0.35 ? 0 : 1, 0.9 + rand() * 0.7, { minDist: 4 });
  }
}
// palms along the beach back edge
for (const p of areas.beach || []) scatter(p, 1 / 900, () => 0, 9);

// ---------------------------------------------------------------- boats berthed along pontoons
console.log('Boats...');
const boats = [];
{
  const segs = [];
  for (const pl of piersOut.lines) for (let i = 1; i < pl.p.length; i++) segs.push({ a: pl.p[i - 1], b: pl.p[i], w: pl.w });
  const sGrid = new Grid(30);
  segs.forEach((s) => sGrid.insert([Math.min(s.a[0], s.b[0]) - 4, Math.min(s.a[1], s.b[1]) - 4, Math.max(s.a[0], s.b[0]) + 4, Math.max(s.a[1], s.b[1]) + 4], s));
  const boatGrid = new Grid(20);
  const rb = rng(99);
  const clearOfPiers = (pt, r, self) => {
    for (const s of sGrid.query(pt[0], pt[1])) if (s !== self && distToSegment(pt, s.a, s.b) < s.w / 2 + r) return false;
    return true;
  };
  const clearOfBoats = (circles) => {
    for (const c of circles) for (const o of boatGrid.query(c[0], c[1])) if (Math.hypot(o[0] - c[0], o[1] - c[1]) < o[2] + c[2]) return false;
    return true;
  };
  for (const s of segs) {
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]); if (L < 6) continue;
    const ux = (s.b[0] - s.a[0]) / L, uy = (s.b[1] - s.a[1]) / L, nx = -uy, ny = ux;
    for (const side of [1, -1]) {
      let pos = 1;
      while (pos < L - 5) {
        const len = L < 26 ? Math.min(L * (0.85 + rb() * 0.2), 24) : 9 + rb() * rb() * 22;
        const beam = len * 0.3;
        if (pos + len > L + 1) break;
        const mid = pos + len / 2;
        const off = s.w / 2 + beam / 2 + 0.7;
        const c = [s.a[0] + ux * mid + nx * off * side, s.a[1] + uy * mid + ny * off * side];
        const circles = [-0.33, 0, 0.33].map((f) => [c[0] + ux * f * len, c[1] + uy * f * len, beam * 0.55]);
        const ok = rb() < 0.88 && circles.every((q) => isWater(q) && clearOfPiers(q, q[2] * 0.9, s)) && clearOfBoats(circles);
        if (ok) {
          boats.push([r1(c[0]), r1(c[1]), Math.round((Math.atan2(uy, ux) + (rb() < 0.5 ? Math.PI : 0)) * 1000) / 1000, r1(len)]);
          for (const q of circles) boatGrid.insert([q[0] - q[2], q[1] - q[2], q[0] + q[2], q[1] + q[2]], q);
        }
        pos += len + 1.2;
      }
    }
  }
}

// ---------------------------------------------------------------- neighbourhood character
console.log('Neighbourhoods...');
const placePolys = {};
for (const w of ways.values()) {
  if (!w.tags || !w.tags.place || !isClosed(w)) continue;
  const n = cleanName(w.tags); const p = wayPoly(w); if (n && p) (placePolys[n] = placePolys[n] || []).push(p);
}
for (const r of rels) {
  if (!r.tags || !r.tags.place) continue;
  const n = cleanName(r.tags); if (!n) continue;
  for (const p of relationPolys(r)) (placePolys[n] = placePolys[n] || []).push(p);
}
const polysMatching = (re) => Object.entries(placePolys).filter(([n]) => re.test(n)).flatMap(([, p]) => p);
const DP = {
  bluewaters: polysMatching(/^Bluewaters$/), beachfront: polysMatching(/^Emaar Beachfront$/), jlt: polysMatching(/^Jumeirah Lakes? Towers$/),
  meadows: polysMatching(/^Meadows/), springs: polysMatching(/^Springs/),
};
const inPolys = (pt, list) => list.some((p) => pointInPoly(pt, p));
// Sheikh Zayed Road as a straight line (it is straight through the area)
const szr = (() => {
  const pts = roadWays.filter((r) => r.kind === 'motorway').flatMap((r) => wayPts(r.w));
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxx = 0, sxy = 0; for (const p of pts) { sxx += (p[0] - mx) ** 2; sxy += (p[0] - mx) * (p[1] - my); }
  const a = Math.atan2(sxy, sxx); return { mx, my, ux: Math.cos(a), uy: Math.sin(a) };
})();
const seaSide = (p) => (p[0] - szr.mx) * szr.uy - (p[1] - szr.my) * szr.ux < 0;
const marinaEdges = (areas.marina || []).flatMap((poly) => poly.flatMap((r) => r.map((p, i) => [p, r[(i + 1) % r.length]])));
const distMarina = (p) => { let d = Infinity; for (const [a, b] of marinaEdges) d = Math.min(d, distToSegment(p, a, b)); return d; };
const JBR_RE = /^(Sadaf|Bahar|Rimal|Murjan|Amwaj|Shams)\b|\bJBR\b|Jumeirah Beach Residence/i;
const jbrTowers = buildings.filter((b) => JBR_RE.test(cleanName(b.tags)) && b.h > 60).map((b) => b.c);
const lakeGrid = new Grid(120); (areas.water || []).forEach((p) => lakeGrid.insert(bboxOf(p[0]), p));
const nearLake = (pt, d) => { for (const p of lakeGrid.query(pt[0], pt[1])) for (const r of p) for (let i = 0; i < r.length; i++) if (distToSegment(pt, r[i], r[(i + 1) % r.length]) < d) return true; return false; };
const indGrid = new Grid(200); (areas.industrial || []).forEach((p) => indGrid.insert(bboxOf(p[0]), p));
const resGrid = new Grid(200); (areas.residential || []).forEach((p) => resGrid.insert(bboxOf(p[0]), p));
const inGridPoly = (g, pt) => g.query(pt[0], pt[1]).some((p) => pointInPoly(pt, p));
const HOUSE = new Set(['house', 'detached', 'villa', 'semidetached_house', 'terrace', 'bungalow']);

for (const b of buildings) {
  const t = b.tags, c = b.c, name = cleanName(t);
  let d = 'other';
  if (inPolys(c, DP.bluewaters)) d = 'bluewaters';
  else if (inPolys(c, DP.beachfront)) d = 'beachfront';
  else if (inPolys(c, DP.jlt)) d = 'jlt';
  else if (inPolys(c, DP.meadows)) d = 'meadows';
  else if (inPolys(c, DP.springs)) d = 'springs';
  else if (JBR_RE.test(name) || jbrTowers.some((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) < 75)) d = 'jbr';
  else if (seaSide(c) && distMarina(c) < 520) d = 'marina';
  else if (['industrial', 'warehouse'].includes(t.building) || inGridPoly(indGrid, c)) d = 'industrial';
  else if (!seaSide(c) && b.h <= 14 && nearLake(c, 90)) d = 'islands';
  b.district = d;
  const ty = t.building || 'yes';
  const smallRes = b.h <= 12.5 && b.area >= 55 && b.area <= 1300 && !b.parts.length;
  // named or tagged buildings in villa areas are usually clinics, schools, shops, clubhouses...
  const civic = (!!name && !HOUSE.has(ty)) || !!(t.amenity || t.shop || t.office || t.leisure || t.tourism) ||
    ['commercial', 'retail', 'school', 'hospital', 'mosque', 'hotel', 'office', 'kindergarten', 'public', 'civic', 'church', 'clinic'].includes(ty);
  b.villa = smallRes && !civic && (HOUSE.has(ty) || ['meadows', 'springs', 'islands'].includes(d) || ((ty === 'yes' || ty === 'residential' || b.ml) && inGridPoly(resGrid, c) && d === 'other'));
}
// villa character per community (from aerial imagery): Meadows = cream, stepped flat roofs with parapets;
// Springs = white townhouses with dark roof decks; Jumeirah Islands = terracotta hip roofs (+ some contemporary).
{
  const rv = rng(4242);
  for (const b of buildings) {
    if (!b.villa) continue;
    const x = rv();
    b.vstyle = b.district === 'springs' ? 't' : b.district === 'islands' ? (x < 0.72 ? 'h' : 'm') : b.district === 'meadows' ? (x < 0.86 ? 'f' : 'h') : (x < 0.55 ? 'f' : x < 0.85 ? 'h' : 'm');
    b.h = b.vstyle === 't' ? 6.6 + rv() * 0.8 : 6.8 + rv() * 1.4; // two storeys (OSM heights for villas are mostly guesses)
    b.est = true;
  }
}

// ---------------------------------------------------------------- researched house kits
// Villa communities that have been researched (developer floor plans, brochures and photographs; see
// data-raw/research/) get their own house model instead of the generic villa styles. OSM maps each sub-community
// as named residential land; every villa inside is tagged with its kit, and later with the side facing its street.
const HOUSE_AREAS = [
  { re: /^Maple ?[123]?(, Dubai Hills Estate)?$/i, kit: 'maple' },
  { re: /^Sidra( ?[123]| Villas)?(, Dubai Hills Estate)?$/i, kit: 'sidra' },
  { re: /^Club Villas(, Dubai Hills Estate)?$/i, kit: 'club-villas' },
  { re: /^Golf Grove(, Dubai Hills Estate)?$/i, kit: 'golf-grove' },
  { re: /^Golf Place ?\d?(, Dubai Hills Estate)?$/i, kit: 'golf-place' },
  { re: /^Fairway Vistas(, Dubai Hills Estate)?$/i, kit: 'luxury' },
  { re: /^Parkway Vistas(, Dubai Hills Estate)?$/i, kit: 'luxury' },
  { re: /^(Dubai )?Hills Grove$/i, kit: 'mansion' },
  { re: /^(Dubai )?Hills View$/i, kit: 'mansion' },
  { re: /^Emerald Hills(, Dubai Hills Estate)?$/i, kit: 'custom' },
  { re: /^Fairways [12]$/i, kit: 'custom', name: 'The Fairway', landuse: 'construction' },
  // (OSM's "Majestic Vistas" polygon beside Sidra is mislabelled; the real Majestic Vistas and Palm Hills, round the
  // north golf loop, are not mapped in OSM yet)
];
// corrections from the research: the larger "Parkway Vistas" polygon also takes in the custom plots of The Parkway
// (only the relation outlines the two Vistas rows); Hills View runs well beyond its OSM place polygon
const AREA_FIX = { w1130773786: { kit: 'custom', name: 'The Parkway' } };
const EXTRA_AREAS = [{ kit: 'mansion', name: 'Hills View', box: [25.1128, 55.2640, 25.1188, 55.2714] }];
// communities taken by their OSM place outline (way id): Emirates Hills (the place=neighbourhood way; its landuse
// polygon of the same name sprawls over JLT and The Lakes)
const EXTRA_WAYS = [{ kit: 'eh', name: 'Emirates Hills', way: 1012104272 }];
// Jumeirah Islands (Nakheel, 2004-2006; data-raw/research/jumeirah-islands): OSM maps every residential island as
// landuse "Cluster N" inside the community's boundary way, and The Mansions as one more polygon. Each cluster was
// built in one theme; the list below is Property Finder's location tree (no Nakheel table was found; clusters 13 and
// 20 are its weakest entries, and 'cont' is the portal's "Contemporary" group: European-type houses in whiter paint).
const JI_BOUNDARY = 89567052, JI_MANSIONS = 1123286638;
const JI_THEMES = {
  med: [5, 6, 13, 14, 16, 20, 21, 24, 29, 30, 36, 38, 42, 43, 47, 50],
  oasis: [9, 17, 19, 23, 27, 31, 33, 44, 46, 49],
  islamic: [7, 12, 15, 26, 28, 34, 39, 45],
  euro: [10, 11, 22, 35, 40, 48],
  cont: [8, 18, 25, 32, 37, 41],
};
const jiTheme = (no) => { for (const [k, l] of Object.entries(JI_THEMES)) if (l.includes(no)) return k; return 'med'; };
let jiPoly = null;
// The 84 townhouses and the Pavilion (2016-2017) stand outside that boundary way, on the park to the north-west:
// they are taken by their OSM ways (eight terrace rows, seven retail blocks). The clubhouse is the building OSM tags
// as the community centre, with the two outlines beside it; its pool is mapped as a point only.
const JI_ROWS = new Set([1074989713, 1074989714, 1074989715, 1074989716, 1074989717, 1074989718, 1074989719, 1074989720].map((i) => 'w' + i));
const JI_PAVILION = new Set([627228787, 778927978, 778927979, 778927980, 778927981, 778927982, 778927983].map((i) => 'w' + i));
const JI_CLUB = 'w1217719777', JI_CLUB_POOL = 8520160375;
const houseAreas = [];
{
  const take = (t, poly, id) => {
    const n = cleanName(t); if (!n) return;
    const a = HOUSE_AREAS.find((h) => h.re.test(n) && (h.landuse || 'residential') === t.landuse); if (!a) return;
    const fix = AREA_FIX[id] || {};
    houseAreas.push({ kit: fix.kit || a.kit, name: fix.name || a.name || n.replace(/, Dubai Hills Estate$/i, ''), poly, area: Math.abs(signedArea(poly[0])) });
  };
  for (const w of ways.values()) if (w.tags && (w.tags.landuse === 'residential' || w.tags.landuse === 'construction') && isClosed(w)) { const p = wayPoly(w); if (p) take(w.tags, p, 'w' + w.id); }
  for (const r of rels) if (r.tags && r.tags.landuse === 'residential') for (const p of relationPolys(r)) take(r.tags, p, 'r' + r.id);
  for (const e of EXTRA_AREAS) {
    const [s, w0, n, e0] = e.box, a = project(s, w0), b = project(n, e0);
    const poly = [[[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]];
    houseAreas.push({ kit: e.kit, name: e.name, poly, area: Math.abs(signedArea(poly[0])) });
  }
  for (const e of EXTRA_WAYS) { const w = ways.get(e.way); const poly = w && isClosed(w) ? wayPoly(w) : null; if (poly) houseAreas.push({ kit: e.kit, name: e.name, poly, area: Math.abs(signedArea(poly[0])) }); }
  { const w = ways.get(JI_BOUNDARY); jiPoly = w && isClosed(w) ? wayPoly(w) : null; }
  if (jiPoly) for (const w of ways.values()) {
    if (!w.tags || w.tags.landuse !== 'residential' || !isClosed(w)) continue;
    const m = /^Cluster (\d+)$/.exec(w.tags.name || ''); if (!m && w.id !== JI_MANSIONS) continue;
    const poly = wayPoly(w); if (!poly || !pointInPoly(centroid(poly[0]), jiPoly)) continue;
    houseAreas.push({ kit: 'ji', name: m ? 'Cluster ' + +m[1] : 'The Mansions', poly, area: Math.abs(signedArea(poly[0])) });
  }
  // the most specific (smallest) area wins: "Sidra 2" inside "Sidra Villas"
  houseAreas.sort((a, b) => a.area - b.area);
  let n = 0;
  // (the Montgomerie Maisonettes, Emaar's townhouse clusters by the clubhouse, are building=terrace: not mansions)
  const EH_SKIP = new Set(['mosque', 'school', 'kindergarten', 'commercial', 'retail', 'hotel', 'industrial', 'apartments', 'guardhouse', 'construction', 'service', 'transportation', 'terrace']);
  let annexes = 0, jiDrop = 0; const jiLoose = [];
  // the Jumeirah Islands clubhouse group
  {
    const club = buildings.find((b) => b.osm === JI_CLUB);
    if (club) {
      club.tags = { ...club.tags, name: 'Jumeirah Islands Clubhouse' };
      for (const b of buildings) {
        if (b.skip || b.parts.length || Math.hypot(b.c[0] - club.c[0], b.c[1] - club.c[1]) > 50) continue;
        if (b.ml) { b.skip = true; continue; } // a machine-traced fragment of the same buildings
        if (b.area < 60) continue;
        b.hk = 'ji-club'; b.hs = 'Jumeirah Islands Clubhouse'; b.villa = false; b.vstyle = undefined; b.h = b === club ? 10.4 : 6; b.lv = b === club ? 2 : 1; b.est = false;
      }
      // the lagoon pool: OSM maps it as a point. An illustrative free-form pool is drawn there (the research describes
      // a large pool with one long curved edge; its real outline is not mapped), its long side toward the clubhouse.
      const pn = nodes.get(JI_CLUB_POOL);
      const pcN = pn ? project(pn.lat, pn.lon) : null;
      // (only where no pool outline is mapped nearby: at the time of writing OSM also outlines the club's pools)
      if (pn && !poolsOut.some((pl) => Math.hypot(pl.p[0][0][0] - pcN[0], pl.p[0][0][1] - pcN[1]) < 60)) {
        const pc = pcN; let dir = [club.c[0] - pc[0], club.c[1] - pc[1]]; const dl = Math.hypot(dir[0], dir[1]) || 1; dir = [dir[0] / dl, dir[1] / dl];
        const along = [-dir[1], dir[0]];
        for (const sc of [1, 0.8, 0.62, 0.48]) {
          const ring = Array.from({ length: 30 }, (_, k) => { const th = (k / 30) * Math.PI * 2, u = 12.5 * sc * Math.cos(th), v = (6.2 * Math.sin(th) + 1.5 * Math.cos(2 * th)) * sc; return [pc[0] + along[0] * u + dir[0] * v, pc[1] + along[1] * u + dir[1] * v]; });
          if (ring.every((q) => !isWater(q) && !buildingAt(q))) { poolsOut.push({ z: 0, p: [rRing(ring)] }); console.log(`  Jumeirah Islands: clubhouse pool drawn at the mapped point (illustrative outline, scale ${sc})`); break; }
        }
      }
    }
  }
  for (const b of buildings) {
    if (b.hk === 'ji-club') continue;
    if (JI_ROWS.has(b.osm)) { b.hk = 'ji-th'; b.hs = 'Jumeirah Islands Townhouses'; b.villa = false; b.vstyle = undefined; b.h = 9.6; b.lv = 3; b.est = false; continue; }
    if (JI_PAVILION.has(b.osm)) { b.hk = 'ji-pav'; b.hs = 'Pavilion Jumeirah Islands'; b.villa = false; b.vstyle = undefined; b.h = b.area > 550 ? 9.5 : b.area > 330 ? 6.3 : 5.7; b.est = false; continue; }
    // Jumeirah Islands: the 16 villas of each cluster and the 31 Mansions (OSM holds three copied outlines for
    // them; they are rebuilt on the researched villa types further down). The small machine-traced shapes in their
    // gardens (pergolas, shade sails) go.
    if (jiPoly && pointInPoly(b.c, jiPoly)) {
      const a = houseAreas.find((h) => h.kit === 'ji' && pointInPoly(b.c, h.poly));
      const house = b.area >= 150 && b.area <= 460 && !b.parts.length && !cleanName(b.tags);
      if (a) {
        if (house) { b.hk = 'ji'; b.hs = a.name; b.villa = true; n++; }
        else if (b.area < 120 && !cleanName(b.tags)) { b.skip = true; jiDrop++; }
        continue;
      }
      if (house && !b.ml) jiLoose.push(b);
    }
    // Emirates Hills: every unnamed low building is a mansion (to about 2,600 m2) or one of its outbuildings (guard
    // and staff houses, majlis, pool houses, garages)
    const ehCand = !b.parts.length && !cleanName(b.tags) && b.h <= 16 && b.area >= 12 && b.area <= 2600 && !EH_SKIP.has(b.tags.building);
    // mansions run to about 2,000 m2, beyond the generic villa test
    if (!b.villa && !ehCand && !(b.h <= 14 && b.area >= 150 && b.area <= 2200 && !b.parts.length && !cleanName(b.tags))) continue;
    const a = houseAreas.find((h) => pointInPoly(b.c, h.poly)); if (!a) continue;
    if (a.kit === 'eh') {
      if (!ehCand) continue;
      b.hk = 'eh'; b.hs = a.name;
      if (b.area < 140) { b.annex = true; b.villa = false; annexes++; continue; }
      b.villa = true; n++;
      continue;
    }
    if (!b.villa && a.kit !== 'mansion' && a.kit !== 'custom') continue;
    b.villa = true;
    b.hk = a.kit; b.hs = a.name; n++;
    // Dubai Hills is contemporary throughout: until a community has its own model, its villas use the flat-roofed
    // style, never the terracotta hip roofs
    b.vstyle = 'f';
  }
  // a cluster OSM has not outlined (42 at the time of writing): the villas left over inside the boundary, when they
  // stand together like one
  if (jiLoose.length >= 10) {
    const med = (k) => { const v = jiLoose.map((b) => b.c[k]).sort((x, y) => x - y); return v[v.length >> 1]; };
    const c0 = [med(0), med(1)], near = jiLoose.filter((b) => Math.hypot(b.c[0] - c0[0], b.c[1] - c0[1]) < 115);
    const have = new Set(houseAreas.filter((h) => h.kit === 'ji').map((h) => +h.name.replace(/\D+/g, '')));
    const missing = []; for (let k = 5; k <= 50; k++) if (!have.has(k)) missing.push(k);
    if (near.length >= 10 && near.length <= 18 && missing.length === 1) {
      const name = 'Cluster ' + missing[0], rad = Math.max(...near.map((b) => Math.hypot(b.c[0] - c0[0], b.c[1] - c0[1]))) + 24;
      for (const b of near) { b.hk = 'ji'; b.hs = name; b.villa = true; n++; }
      const poly = [Array.from({ length: 24 }, (_, k) => [c0[0] + Math.cos((k / 24) * Math.PI * 2) * rad, c0[1] + Math.sin((k / 24) * Math.PI * 2) * rad])];
      houseAreas.push({ kit: 'ji', name, poly, area: Math.abs(signedArea(poly[0])) });
      console.log(`  Jumeirah Islands: ${name} has no outline in OSM: ${near.length} villas taken by position (centre ${c0.map(Math.round)})`);
    } else console.log(`  Jumeirah Islands: ${jiLoose.length} villas outside every cluster outline left as they are (missing clusters: ${missing.join(', ') || 'none'})`);
  }
  if (jiPoly) console.log(`  Jumeirah Islands: ${houseAreas.filter((h) => h.kit === 'ji').length} cluster outlines, ${buildings.filter((b) => b.hk === 'ji').length} villas, ${jiDrop} garden shapes dropped`);
  console.log(`  house kits: ${n} villas (+${annexes} outbuildings) in ${houseAreas.length} researched areas (${[...new Set(houseAreas.map((h) => h.kit))].join(', ')})`);
}

// ---------------------------------------------------------------- JLT podiums
// Every JLT tower stands on a 3-4 level parking/retail podium with a landscaped deck, pool and palms
// (Esri World Imagery, Oct 2026, used as a visual reference); OSM maps only the tower footprints.
// Grow a podium around each footprint, pulled back from roads, lakes and neighbouring towers.
const podiumRings = [];
{
  const rq = rng(214);
  const jltTowers = buildings.filter((b) => b.district === 'jlt' && b.h > 60 && !b.parts.length && !b.skip);
  let pools = 0;
  for (const b of jltTowers) {
    const ob = obb(b.polys[0][0]); if (!ob) continue;
    const [cx, cy] = ob.center, u = ob.u, v = ob.v, hl = ob.len / 2, hw = ob.wid / 2;
    const ext = [0, 0, 0, 0].map(() => 9 + rq() * 7); // beyond the tower on +u, -u, +v, -v
    const corner = (su, sv) => [cx + u[0] * su + v[0] * sv, cy + u[1] * su + v[1] * sv];
    const rect = () => [corner(hl + ext[0], -(hw + ext[3])), corner(hl + ext[0], hw + ext[2]), corner(-(hl + ext[1]), hw + ext[2]), corner(-(hl + ext[1]), -(hw + ext[3]))];
    const blocked = (q) => {
      // keep clear of roads, and leave the lakeside promenade (~11 m) open between podium and water
      if (onRoad(q, 2.0) || isWater(q) || nearLake(q, 11)) return true;
      const host = buildingAt(q); if (host && host !== b && host.h > 20) return true;
      return podiumRings.some((r) => pointInRing(q, r));
    };
    for (let it = 0; it < 14; it++) {
      const R4 = rect(); let changed = false;
      const sides = [[R4[0], R4[1]], [R4[2], R4[3]], [R4[1], R4[2]], [R4[3], R4[0]]];
      for (let k = 0; k < 4; k++) {
        if (ext[k] <= 1.5) continue;
        const [a, c] = sides[k]; let hit = false;
        for (let t = 0; t <= 1.0001 && !hit; t += 0.125) hit = blocked([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]);
        if (hit) { ext[k] = Math.max(1.5, ext[k] - 1.6); changed = true; }
      }
      if (!changed) break;
    }
    let ring = rect();
    const area = Math.abs(signedArea(ring));
    if (area < b.area * 1.6) continue; // squeezed to nothing: the tower stays on its own
    if (signedArea(ring) < 0) ring = ring.reverse();
    const ph = 12 + Math.floor(rq() * 3) * 1.6, lv = Math.round(ph / 3.2);
    const rec = { osm: 'podium-' + b.osm, tags: { building: 'podium', 'building:levels': String(lv) }, polys: [[ring]], c: centroid(ring), area, h: ph, lv, parts: [], district: 'jlt' };
    buildings.push(rec); bGrid.insert(bboxOf(ring), rec); podiumRings.push(ring);
    // deck pool in the widest strip beside the tower
    const k = ext.indexOf(Math.max(...ext));
    if (ext[k] >= 9 && rq() < 0.75) {
      const endStrip = k < 2, sgn = k % 2 === 0 ? 1 : -1;
      const off = (endStrip ? hl : hw) + ext[k] / 2;
      const dir = endStrip ? u : v, across = endStrip ? v : u;
      const pl = Math.min(18, (endStrip ? ob.wid : ob.len) * 0.8), pw = Math.min(7, ext[k] - 3.5);
      const pc = [cx + dir[0] * off * sgn, cy + dir[1] * off * sgn];
      let pr = [[-pl / 2, -pw / 2], [pl / 2, -pw / 2], [pl / 2, pw / 2], [-pl / 2, pw / 2]].map(([a, c]) => [pc[0] + across[0] * a + dir[0] * c, pc[1] + across[1] * a + dir[1] * c]);
      if (signedArea(pr) < 0) pr = pr.reverse();
      poolsOut.push({ z: r1(ph), p: [rRing(pr)] }); pools++;
    }
  }
  // ground-level trees now inside a podium go; the decks get palms and planters instead
  const pg = new Grid(60); podiumRings.forEach((r) => pg.insert(bboxOf(r), r));
  const kept = trees.filter((t) => !(t[2] === 0 && pg.query(t[0], t[1]).some((r) => pointInRing(t, r))));
  const removed = trees.length - kept.length; trees.length = 0; for (const t of kept) trees.push(t);
  const rd = rng(215); let deck = 0;
  for (const ring of podiumRings) {
    const bb = bboxOf(ring);
    for (let n = 0; n < 40 && deck < 1e6; n++) {
      const q = [bb[0] + rd() * (bb[2] - bb[0]), bb[1] + rd() * (bb[3] - bb[1])];
      let de = Infinity; for (let i = 0; i < ring.length; i++) de = Math.min(de, distToSegment(q, ring[i], ring[(i + 1) % ring.length]));
      if (!pointInRing(q, ring) || de < 1.5 || de > 4.5) continue; // planters along the deck edge
      if (poolsOut.some((pl) => pl.z > 0 && pointInRing(q, pl.p[0]))) continue;
      if (addTree(q, rd() < 0.7 ? 0 : 3, 0.75 + rd() * 0.35, { minDist: 6 })) deck++;
    }
  }
  console.log(`  JLT podiums ${podiumRings.length} (deck pools ${pools}, ${deck} deck palms; ${removed} ground trees cleared)`);
}

// Emirates Hills: the style mix of the mansions (data-raw/research/emirates-hills/mansions/research.json), assigned
// per plot by hash since no plot-by-plot record exists (plots the research identifies get their own entry)
// (the aerial views, a visual reference only, show flat roofs almost everywhere: terracotta hips are rare)
// research: classic European 35-45 %, contemporary 30-40 % (rising), traditional Islamic 10-15 %, Mediterranean 10-15 %
// (mostly flat-roofed; clay-tile hips under 5 %)
const EH_STYLES = [['classic', 38], ['contemporary', 34], ['arabesque', 12], ['mediterranean', 12], ['tiled', 4]];
const EH_PLOTS = {}; // OSM house number -> style, from listings that name the plot
function ehStyle(b, h) {
  const no = (b.tags['addr:housenumber'] || '').replace(/\s+/g, '').toUpperCase();
  if (EH_PLOTS[no]) return EH_PLOTS[no];
  let x = h % 100; for (const [id, w] of EH_STYLES) { if ((x -= w) < 0) return id; } return EH_STYLES[0][0];
}

// ---------------------------------------------------------------- researched house kits: street side, type, mirroring
// Before the plots are laid out: each kit villa learns which side faces its street; Sidra villas also get their type
// (from the frontage of the two-storey block OSM traces) and are mirrored in pairs along the street, so neighbouring
// carports sit side by side as built. Driveways, carport cars and pools then follow the developer's plans.
{
  const streetDir = (c, R = 45) => {
    let best = null, bd = Infinity; const seen = new Set();
    for (const s of rGrid.query(c[0], c[1]).concat(rGrid.query(c[0] + 30, c[1]), rGrid.query(c[0] - 30, c[1]), rGrid.query(c[0], c[1] + 30), rGrid.query(c[0], c[1] - 30))) {
      if (seen.has(s)) continue; seen.add(s);
      const ax = s.b[0] - s.a[0], ay = s.b[1] - s.a[1], L2 = ax * ax + ay * ay || 1;
      const tt = Math.max(0, Math.min(1, ((c[0] - s.a[0]) * ax + (c[1] - s.a[1]) * ay) / L2));
      const q = [s.a[0] + ax * tt, s.a[1] + ay * tt];
      const dd = Math.hypot(c[0] - q[0], c[1] - q[1]); if (dd > R || dd < 0.5) continue;
      if (dd - s.hw < bd) { bd = dd - s.hw; best = [(q[0] - c[0]) / dd, (q[1] - c[1]) / dd]; }
    }
    return best;
  };
  const types = {};
  // Jumeirah Islands: every villa is rebuilt on one of the three Nakheel types, in its cluster's theme. Sourced: 16
  // villas a cluster, 10 Entertainment Foyer + 4 Garden Hall + 2 Master View; built-up 474-609 m2 over two floors.
  // Not sourced (no dimensioned plan was found): the footprints (estimates from the built-up areas and the room
  // layouts), and which type stands on which plot; here the Master Views take the plot OSM draws largest and the one
  // opposite, the Garden Halls four plots spread round the loop. The villas keep the position and the bearing of
  // their OSM outlines, face the loop road, and are mirrored in pairs so garages meet over shared forecourts.
  {
    const groups = new Map();
    for (const b of buildings) if (b.hk === 'ji' && !b.skip) { let l = groups.get(b.hs); if (!l) groups.set(b.hs, (l = [])); l.push(b); }
    const DIM = { ef: [18.5, 17], gh: [16, 19.5], mv: [22, 18], mn: [24, 19] };
    // villas since remodelled as white modern houses: about 35 % overall (estimate from the listings), most in the
    // Oasis clusters and in clusters 25 and 8, fewest in the Mediterranean ones
    const REMODEL = { med: 22, oasis: 42, islamic: 32, euro: 30, cont: 38, mansion: 12 };
    let nJ = 0;
    for (const [name, list] of groups) {
      const mans = name === 'The Mansions', no = mans ? 0 : +name.replace(/\D+/g, ''), theme = mans ? 'mansion' : jiTheme(no);
      const n = list.length, c0 = [list.reduce((a, b) => a + b.c[0], 0) / n, list.reduce((a, b) => a + b.c[1], 0) / n];
      list.sort((a, b) => Math.atan2(a.c[1] - c0[1], a.c[0] - c0[0]) - Math.atan2(b.c[1] - c0[1], b.c[0] - c0[0]));
      const lead = list.reduce((m, b, i) => (b.area > list[m].area ? i : m), 0), small = list.reduce((m, b, i) => (b.area < list[m].area ? i : m), 0);
      const typeOf = new Array(n).fill(mans ? 'mn' : 'ef');
      if (!mans && n >= 8) {
        typeOf[lead] = 'mv'; typeOf[(lead + (n >> 1)) % n] = 'mv';
        let gh = 0; for (const k of [small, lead + 4, lead + 12, lead + 2, lead + 10, lead + 6, lead + 14]) { const i = ((k % n) + n) % n; if (gh < 4 && typeOf[i] === 'ef') { typeOf[i] = 'gh'; gh++; } }
      }
      const at0 = list.map((b) => [b.c[0], b.c[1]]);
      list.forEach((b, i) => {
        let inward = [c0[0] - b.c[0], c0[1] - b.c[1]]; const il = Math.hypot(inward[0], inward[1]) || 1; inward = [inward[0] / il, inward[1] / il];
        let f = streetDir(b.c, 55);
        if (!mans && (!f || f[0] * inward[0] + f[1] * inward[1] < 0.35)) f = inward;
        if (!f) f = inward;
        const F0 = frame2D(b.polys[0][0], Math.atan2(f[1], f[0])); if (!F0) return;
        let gap = Infinity; at0.forEach((q, j) => { if (j !== i) gap = Math.min(gap, Math.hypot(q[0] - at0[i][0], q[1] - at0[i][1])); });
        const [W0, D] = DIM[typeOf[i]];
        const W = Math.round(Math.max(14.5, Math.min(W0, gap * (mans ? 1 : 0.87) - (mans ? 3 : 1.2))) * 10) / 10;
        const pc = F0.P(0, F0.D / 2);
        const rect = [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]].map(([x, y]) => [pc[0] + F0.xv[0] * x + F0.yv[0] * y, pc[1] + F0.xv[1] * x + F0.yv[1] * y]);
        if (signedArea(rect) < 0) rect.reverse();
        b.polys = [[rect]]; b.c = pc; b.area = W * D; b.h = mans ? 9.6 : 9.2; b.lv = 2; b.est = false;
        b.front = F0.front; b.hframe = frame2D(rect, Math.atan2(F0.front[1], F0.front[0]));
        b.hm = i % 2 ? -1 : 1;
        let h = 2166136261; for (const ch of String(b.osm || '') + Math.round(pc[0]) + ',' + Math.round(pc[1])) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } h >>>= 0;
        const share = no === 25 || no === 8 ? 62 : REMODEL[theme];
        b.ht = [theme, typeOf[i], (h >>> 9) % 4, h % 100 < share ? 'r' : 'o'].join(':');
        bGrid.insert(bboxOf(rect), b);
        types['ji-' + theme] = (types['ji-' + theme] || 0) + 1; nJ++;
      });
    }
    if (nJ) console.log(`  Jumeirah Islands: ${nJ} villas rebuilt on the researched types in ${groups.size} clusters`);
  }
  for (const b of buildings) {
    if (!b.hk) continue;
    if (b.hk === 'ji') continue; // laid out above
    if (b.hk.startsWith('ji-')) {
      // townhouse rows front their street with a long side; the Pavilion blocks and the clubhouse turn their
      // terraces away from the nearest road
      const f = streetDir(b.c, 60); if (f) b.front = f;
      if (b.hk === 'ji-th') b.hframe = frame2D(b.polys[0][0], f ? Math.atan2(f[1], f[0]) : null, { long: true });
      continue;
    }
    const f = streetDir(b.c, b.hk === 'eh' ? 75 : 45); if (f) b.front = f;
    if (b.annex) continue;
    if (b.hk === 'eh') {
      const F = frame2D(b.polys[0][0], b.front ? Math.atan2(b.front[1], b.front[0]) : null);
      if (!F) continue;
      b.hframe = F;
      let h = 2166136261; for (const ch of String(b.osm || '') + Math.round(b.c[0]) + ',' + Math.round(b.c[1])) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } h >>>= 0;
      b.hm = h % 2 ? -1 : 1;
      const style = ehStyle(b, h);
      b.ht = style + ':' + ((h >>> 9) % 4); // style and palette (outbuildings repeat both)
      types['eh-' + style] = (types['eh-' + style] || 0) + 1;
      continue;
    }
    if (b.hk === 'maple') {
      const F = frame2D(b.polys[0][0], b.front ? Math.atan2(b.front[1], b.front[0]) : null, { long: true });
      if (F) b.hframe = F;
      continue;
    }
    if (b.hk === 'luxury' || b.hk === 'mansion' || b.hk === 'custom') {
      const F = frame2D(b.polys[0][0], b.front ? Math.atan2(b.front[1], b.front[0]) : null);
      if (!F) continue;
      b.hframe = F;
      let h = 2166136261; for (const ch of String(b.osm || '') + Math.round(b.c[0]) + ',' + Math.round(b.c[1])) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } h >>>= 0;
      b.hm = h % 2 ? -1 : 1;
      const k = Math.floor(h / 2);
      if (b.hk === 'luxury') {
        // the plan type from the footprint, then one of that type's two façade options
        const t = luxuryType(F.W, F.D, /Parkway/.test(b.hs), k);
        b.ht = t + '-' + (t === 'B3' || t === 'B4' ? ['modern', 'classic'] : ['modern', 'arabesque'])[Math.floor(k / 2) % 2];
        types[b.ht] = (types[b.ht] || 0) + 1;
      }
      else if (b.hk === 'mansion') b.ht = /Grove/.test(b.hs) ? ['arabesque', 'arabesque', 'classic', 'contemporary', 'contemporary'][k % 5] : ['contemporary', 'contemporary', 'hipped', 'classic'][k % 4];
      else b.ht = ['travertine', 'corten', 'white', 'charcoal'][k % 4];
      continue;
    }
    if (b.hk === 'club-villas' || b.hk === 'golf-grove' || b.hk === 'golf-place') {
      const F = frame2D(b.polys[0][0], b.front ? Math.atan2(b.front[1], b.front[0]) : null);
      if (!F) continue;
      b.hframe = F;
      let h = 2166136261; for (const ch of String(b.osm || '') + Math.round(b.c[0]) + ',' + Math.round(b.c[1])) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } h >>>= 0;
      if (b.hk === 'golf-place') {
        b.hm = h % 2 ? -1 : 1; // the garage wing, left or right
        b.ht = ['contemporary', 'modern', 'elegant'][Math.floor(h / 2) % 3];
      } else if (b.hk === 'golf-grove') {
        // 4-bed Aalto pairs on the outer ring; the 3-bed pairs are Eames or Savoye
        b.ht = pairLayout(F.W, F.D).beds === 4 ? 'aalto' : h % 2 ? 'savoye' : 'eames';
      } else b.ht = pairLayout(F.W, F.D).beds === 4 ? 'club4' : 'club3';
      continue;
    }
    if (b.hk !== 'sidra') continue;
    const F = frame2D(b.polys[0][0], b.front ? Math.atan2(b.front[1], b.front[0]) : null, { short: true }); if (!F) continue;
    b.ht = sidraType(F.W);
    b.hframe = F;
    types[b.ht] = (types[b.ht] || 0) + 1;
  }
  // rows: villas side by side along the same street (same facing, offset along the frontage); alternate the mirroring
  // along each row so carports pair across every other boundary
  const sid = buildings.filter((b) => b.hk === 'sidra' && b.hframe);
  const g = new Grid(40); sid.forEach((b) => g.insert([b.c[0], b.c[1], b.c[0], b.c[1]], b));
  const up = new Map(sid.map((b) => [b, b]));
  const find = (b) => { while (up.get(b) !== b) { up.set(b, up.get(up.get(b))); b = up.get(b); } return b; };
  for (const b of sid) {
    const F = b.hframe, seen = new Set();
    for (const [dx, dy] of [[0, 0], [30, 0], [-30, 0], [0, 30], [0, -30]]) for (const n of g.query(b.c[0] + dx, b.c[1] + dy)) {
      if (n === b || seen.has(n)) continue; seen.add(n);
      const d = [n.c[0] - b.c[0], n.c[1] - b.c[1]];
      const along = d[0] * F.xv[0] + d[1] * F.xv[1], across = d[0] * F.front[0] + d[1] * F.front[1];
      if (Math.abs(along) < 26 && Math.abs(across) < 4.5 && n.hframe.front[0] * F.front[0] + n.hframe.front[1] * F.front[1] > 0.9) up.set(find(n), find(b));
    }
  }
  const rows = new Map();
  for (const b of sid) { const r = find(b); if (!rows.has(r)) rows.set(r, []); rows.get(r).push(b); }
  for (const [r, list] of rows) {
    const xv = r.hframe.xv;
    list.sort((p, q) => (p.c[0] * xv[0] + p.c[1] * xv[1]) - (q.c[0] * xv[0] + q.c[1] * xv[1]));
    list.forEach((b, k) => { b.hm = k % 2 ? -1 : 1; });
  }
  {
    const mains = buildings.filter((b) => b.hk === 'eh' && !b.annex && b.ht);
    const mg = new Grid(80); mains.forEach((m) => mg.insert([m.c[0], m.c[1], m.c[0], m.c[1]], m));
    for (const b of buildings) {
      if (!b.annex) continue;
      let best = null, bd = 90;
      for (const dx of [-80, 0, 80]) for (const dy of [-80, 0, 80]) for (const m of mg.query(b.c[0] + dx, b.c[1] + dy)) { const d = Math.hypot(m.c[0] - b.c[0], m.c[1] - b.c[1]); if (d < bd) { bd = d; best = m; } }
      b.ht = 'annex-' + (best ? best.ht : 'contemporary');
      b.owner = best;
    }
  }
  console.log(`  house types: ${JSON.stringify(types)}, ${rows.size} Sidra rows`);
}

// ---------------------------------------------------------------- villa plots, pools, driveways, gardens
console.log('Villa plots...');
const plots = [];
// distance from the carriageway edge to the plot boundary in the researched communities: kerb and footway (and a
// strip of planting) in the townhouse and villa communities; a deep planted verge in front of the Vistas, the
// mansions and the custom villas (street photographs)
const PLOT_SETBACK = { sidra: 2.0, maple: 1.9, 'club-villas': 2.0, 'golf-grove': 2.0, 'golf-place': 2.3, luxury: 3.6, mansion: 4.0, custom: 3.0, eh: 4.5, ji: 1.0 };
const parked = []; // [x, y, angle, colourSeed]
{
  const rp = rng(777);
  const villas = buildings.filter((b) => b.villa);
  const vGrid = new Grid(90); villas.forEach((v) => vGrid.insert([v.c[0], v.c[1], v.c[0], v.c[1]], v));
  const extent = (ring, c, dir) => { let m = 0; for (const p of ring) m = Math.max(m, (p[0] - c[0]) * dir[0] + (p[1] - c[1]) * dir[1]); return m; };
  for (const v of villas) {
    const ring = v.polys[0][0];
    const ob = obb(ring); if (!ob) continue;
    const c = v.c;
    // start from the footprint's oriented box grown by a generous setback
    const grow = v.hk === 'eh' ? 24 : 8; // Emirates Hills plots are a third of an acre to an acre and more
    const hl = ob.len / 2 + grow, hw = ob.wid / 2 + grow;
    let cell = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([a, b]) => [ob.center[0] + ob.u[0] * a + ob.v[0] * b, ob.center[1] + ob.u[1] * a + ob.v[1] * b]);
    // share space with neighbours (weighted bisectors through the gap between footprints)
    for (const n of vGrid.query(c[0], c[1]).concat(vGrid.query(c[0] + 45, c[1]), vGrid.query(c[0] - 45, c[1]), vGrid.query(c[0], c[1] + 45), vGrid.query(c[0], c[1] - 45))) {
      if (n === v) continue;
      const dx = n.c[0] - c[0], dy = n.c[1] - c[1], L = Math.hypot(dx, dy); if (L > 75 || L < 0.5) continue;
      const dir = [dx / L, dy / L];
      const rv0 = extent(ring, c, dir), rn = extent(n.polys[0][0], n.c, [-dir[0], -dir[1]]);
      const gap = Math.max(0, L - rv0 - rn);
      const m = [c[0] + dir[0] * (rv0 + gap * 0.5), c[1] + dir[1] * (rv0 + gap * 0.5)];
      cell = clipHalf(cell, m, [-dir[0], -dir[1]]);
      if (cell.length < 3) break;
    }
    if (cell.length < 3) continue;
    // stop at the street: keep a sidewalk between plot and carriageway
    let front = null, frontD = Infinity;
    const seen = new Set();
    for (const s of rGrid.query(c[0], c[1]).concat(rGrid.query(c[0] + 30, c[1]), rGrid.query(c[0] - 30, c[1]), rGrid.query(c[0], c[1] + 30), rGrid.query(c[0], c[1] - 30))) {
      if (seen.has(s)) continue; seen.add(s);
      const ax = s.b[0] - s.a[0], ay = s.b[1] - s.a[1], L2 = ax * ax + ay * ay || 1;
      let tt = ((c[0] - s.a[0]) * ax + (c[1] - s.a[1]) * ay) / L2; tt = Math.max(0, Math.min(1, tt));
      const q = [s.a[0] + ax * tt, s.a[1] + ay * tt];
      const dd = Math.hypot(c[0] - q[0], c[1] - q[1]); if (dd > (v.hk === 'eh' ? 75 : 45) || dd < 0.5) continue;
      const dir = [(c[0] - q[0]) / dd, (c[1] - q[1]) / dd];
      // the street kit's footways and verges (researched communities); elsewhere a 1.6 m sidewalk
      const off = s.hw + (PLOT_SETBACK[v.hk] ?? 1.6);
      cell = clipHalf(cell, [q[0] + dir[0] * off, q[1] + dir[1] * off], dir);
      if (dd - s.hw < frontD) { frontD = dd - s.hw; front = [-dir[0], -dir[1]]; }
      if (cell.length < 3) break;
    }
    if (cell.length < 3) continue;
    const plotArea = Math.abs(signedArea(cell));
    if (plotArea < v.area * 1.2) continue;
    const plot = { p: cell.map(rp2), b: v, front };
    if (!front) front = [-ob.v[0], -ob.v[1]];
    if (!v.front) v.front = front;
    if (v.hk === 'sidra' && v.hframe) {
      // Sidra: everything from the plan of the villa's type
      const S = SIDRA[v.ht], F = v.hframe, M = planMap(S, v.hm, F.D);
      const W = (xp, yp) => F.P(M.X(xp), M.Y(yp));
      plot.k = 'sidra';
      // owners have added pools to about a third of the gardens, along the rear boundary as the plans show
      if (rp() < 0.32) {
        const [x0, x1, y0, y1] = S.pool, pc = W((x0 + x1) / 2, (y0 + y1) / 2);
        if ([W(x0, y0), W(x1, y0), W(x1, y1), W(x0, y1)].every((q) => pointInRing(q, cell) && !pointInRing(q, ring) && !isWater(q))) {
          plot.pool = [r1(pc[0]), r1(pc[1]), Math.round(Math.atan2(F.xv[1], F.xv[0]) * 1000) / 1000, r1(x1 - x0), r1(y1 - y0)];
        }
      }
      // paving from the back of the open carport out to the street; one or two cars under the carport roof
      const [cx0, cx1, cy0, cy1] = S.carport, cxm = (cx0 + cx1) / 2;
      const back = W(cxm, cy1), mouth = W(cxm, cy0);
      const out = Math.max(0, frontD + (c[0] - mouth[0]) * F.front[0] + (c[1] - mouth[1]) * F.front[1] - 0.6);
      const end = [mouth[0] + F.front[0] * out, mouth[1] + F.front[1] * out];
      plot.drive = [r1(back[0]), r1(back[1]), r1(end[0]), r1(end[1]), r1(cx1 - cx0)];
      const n = rp() < 0.82 ? (rp() < 0.5 ? 2 : 1) : 0, ang = Math.atan2(F.yv[1], F.yv[0]);
      for (let k = 0; k < n; k++) {
        const cp = W(cxm + (n === 2 ? (k ? 1.55 : -1.55) : (rp() - 0.5)) * v.hm, (cy0 + cy1) / 2 + 0.2);
        if (carFits(cp, ang, cell, null)) parked.push([r1(cp[0]), r1(cp[1]), Math.round(ang * 1000) / 1000, Math.floor(rp() * 1000)]);
      }
      plots.push(plot);
      continue;
    }
    if ((v.hk === 'club-villas' || v.hk === 'golf-grove') && v.hframe) {
      // semi-detached pairs: open frontage, paving from both carports to the street, cars under the canopy
      const F = v.hframe, L = pairLayout(F.W, F.D), S = L.S;
      plot.k = 'pair';
      const ports = L.single ? [S.carports[0]] : S.carports;
      const x0 = L.X(ports[0][0]), x1 = L.X(ports[ports.length - 1][1]), yb = L.Y(S.carY[1]), yf = L.Y(S.carY[0]);
      const out = Math.max(0, frontD - (F.D / 2 - yf) - 0.6), xm = (x0 + x1) / 2;
      const a0 = F.P(xm, yb), a1 = F.P(xm, yf - out);
      plot.drive = [r1(a0[0]), r1(a0[1]), r1(a1[0]), r1(a1[1]), r1(x1 - x0)];
      const ang = Math.atan2(F.yv[1], F.yv[0]);
      for (const [p, q] of ports) {
        const n = rp() < 0.8 ? (rp() < 0.45 ? 2 : 1) : 0, cxm = (L.X(p) + L.X(q)) / 2;
        for (let k = 0; k < n; k++) {
          const cp = F.P(cxm + (n === 2 ? (k ? 1.5 : -1.5) : rp() - 0.5), (yb + yf) / 2);
          if (carFits(cp, ang, cell, null)) parked.push([r1(cp[0]), r1(cp[1]), Math.round(ang * 1000) / 1000, Math.floor(rp() * 1000)]);
        }
      }
      plots.push(plot);
      continue;
    }
    if (v.hk === 'eh' && v.hframe) {
      // Emirates Hills: a gated drive from the street to a paved forecourt under the porte-cochere, cars on the
      // forecourt, a large pool in the rear garden (towards the golf course or the lake where there is one)
      const F = v.hframe, m = v.hm || 1;
      plot.k = 'eh';
      const out = Number.isFinite(frontD) ? Math.max(0, frontD - F.D / 2 - 0.6) : 0; // no street in reach: no drive
      const gx = m * Math.min(F.W * 0.3, 9);
      const a0 = F.P(gx, -1.0), a1 = F.P(gx, -out);
      if (out > 2 && out < 60) plot.drive = [r1(a0[0]), r1(a0[1]), r1(a1[0]), r1(a1[1]), 6.5];
      // the forecourt before the entrance: [x, y, angle, length along the facade, depth]
      const fd = Math.min(14, Math.max(7, out * 0.7)), fl = Math.min(F.W * 0.9, 34), fc = F.P(0, -fd / 2 - 0.2);
      plot.fc = [r1(fc[0]), r1(fc[1]), Math.round(Math.atan2(F.xv[1], F.xv[0]) * 1000) / 1000, r1(fl), r1(fd)];
      const ang = Math.atan2(F.xv[1], F.xv[0]);
      const n = 1 + Math.floor(rp() * 4);
      for (let k = 0; k < n; k++) {
        const cp = F.P((k - (n - 1) / 2) * 3.4 + m * 2, -fd * 0.55);
        if (carFits(cp, ang + (k % 2 ? 0 : Math.PI), cell, ring)) parked.push([r1(cp[0]), r1(cp[1]), Math.round((ang + (k % 2 ? 0 : Math.PI)) * 1000) / 1000, Math.floor(rp() * 1000)]);
      }
      if (rp() < 0.95) {
        const PL = Math.min(26, Math.max(12, F.W * 0.5)), PW = 4.5 + rp() * 2.5;
        for (const back of [7, 5.5, 4]) {
          const pc = F.P(-m * F.W * 0.08, F.D + back), along = F.xv;
          const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b2]) => [pc[0] + along[0] * a * PL / 2 + F.yv[0] * b2 * PW / 2, pc[1] + along[1] * a * PL / 2 + F.yv[1] * b2 * PW / 2]);
          if (corners.every((q) => pointInRing(q, cell) && !pointInRing(q, ring) && !isWater(q))) { plot.pool = [r1(pc[0]), r1(pc[1]), Math.round(Math.atan2(along[1], along[0]) * 1000) / 1000, r1(PL), r1(PW)]; break; }
        }
      }
      // edges that open onto the golf course or a lake keep their view: a low wall with railings (walls in details.js)
      {
        const golfG = golfAreaGrid, cc = signedArea(cell) < 0 ? cell.slice().reverse() : cell, open = [];
        const onCourse = (q) => isWater(q) || golfG.query(q[0], q[1]).some((g) => pointInPoly(q, g));
        for (let i = 0; i < cc.length; i++) {
          const a = cc[i], b2 = cc[(i + 1) % cc.length], dx = b2[0] - a[0], dy = b2[1] - a[1], L = Math.hypot(dx, dy); if (L < 3) continue;
          const mx = (a[0] + b2[0]) / 2, my = (a[1] + b2[1]) / 2, nx = dy / L, ny = -dx / L;
          if (onCourse([mx + nx * 4, my + ny * 4]) || onCourse([mx + nx * 9, my + ny * 9])) open.push(i);
        }
        if (open.length) plot.ov = open;
        // edges onto the main roads round the community: screened by tall clipped hedges on a stone plinth
        const main = [];
        for (let i = 0; i < cc.length; i++) {
          const a = cc[i], b2 = cc[(i + 1) % cc.length], dx = b2[0] - a[0], dy = b2[1] - a[1], L = Math.hypot(dx, dy); if (L < 3) continue;
          const mx = (a[0] + b2[0]) / 2, my = (a[1] + b2[1]) / 2, nx = dy / L, ny = -dx / L;
          const near = (q) => majorGrid.query(q[0], q[1]).some((sg) => distToSegment(q, sg.a, sg.b) < sg.hw + 3);
          if (!open.includes(i) && (near([mx + nx * 6, my + ny * 6]) || near([mx + nx * 14, my + ny * 14]))) main.push(i);
        }
        if (main.length) plot.mr = main;
      }
      plots.push(plot);
      continue;
    }
    if (v.hk === 'luxury' && v.hframe) {
      // Fairway and Parkway Vistas: the plan's garage, carport or open parking, paved to the street; the pool where the
      // garden plan draws it, in most gardens (the developer did not build pools: owners did)
      const F = v.hframe, L = luxuryLayout(F.W, F.D, String(v.ht).split('-')[0], v.hm || 1), P = L.S;
      plot.k = 'luxury';
      // the fitted plan can reach past the OSM footprint (the garage stands forward, the roof slabs overhang): keep
      // garden trees off it
      plot.hull = [[-0.9, -0.9], [P.W + 0.9, -0.9], [P.W + 0.9, P.D + 0.9], [-0.9, P.D + 0.9]].map(([x, y]) => F.P(L.X(x), L.Y(y)));
      if (signedArea(plot.hull) < 0) plot.hull.reverse();
      const gx = (L.X(P.park[0]) + L.X(P.park[1])) / 2, gw = Math.abs(L.X(P.park[1]) - L.X(P.park[0]));
      const yb = L.Y(P.park[3]), yf = L.Y(P.park[2]), out = Math.max(0, frontD - (F.D / 2 - yf) - 0.6);
      const a0 = F.P(gx, yb - 0.5), a1 = F.P(gx, yf - out);
      plot.drive = [r1(a0[0]), r1(a0[1]), r1(a1[0]), r1(a1[1]), r1(Math.max(5.4, gw - 0.4))];
      const ang = Math.atan2(F.yv[1], F.yv[0]);
      const n = rp() < 0.85 ? (rp() < 0.55 ? 2 : 1) : 0;
      for (let k = 0; k < n; k++) {
        const cp = F.P(gx + (n === 2 ? (k ? 1.5 : -1.5) : 0), (yb + yf) / 2 + 0.3);
        if (carFits(cp, ang, cell, null)) parked.push([r1(cp[0]), r1(cp[1]), Math.round(ang * 1000) / 1000, Math.floor(rp() * 1000)]);
      }
      if (rp() < 0.85) {
        const [x0, x1, y0, y1] = P.pool, X0 = L.X(x0), X1 = L.X(x1), Y0 = L.Y(y0), Y1 = L.Y(y1);
        const wide = Math.abs(X1 - X0) >= Math.abs(Y1 - Y0), pc = F.P((X0 + X1) / 2, (Y0 + Y1) / 2), along = wide ? F.xv : F.yv;
        const PL = wide ? Math.abs(X1 - X0) : Math.abs(Y1 - Y0), PW = wide ? Math.abs(Y1 - Y0) : Math.abs(X1 - X0);
        const across = [-along[1], along[0]];
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b2]) => [pc[0] + along[0] * a * PL / 2 + across[0] * b2 * PW / 2, pc[1] + along[1] * a * PL / 2 + across[1] * b2 * PW / 2]);
        if (corners.every((q) => pointInRing(q, cell) && !isWater(q))) plot.pool = [r1(pc[0]), r1(pc[1]), Math.round(Math.atan2(along[1], along[0]) * 1000) / 1000, r1(PL), r1(PW)];
      }
      plots.push(plot);
      continue;
    }
    if (v.hk === 'ji' && v.hframe) {
      // Jumeirah Islands: an open front lawn, a paver drive from the double garage at the front corner to the street
      // (no gates), and the private pool every villa has in the back garden (about 8-10 x 4-5 m in the photographs)
      const F = v.hframe, m = v.hm || 1;
      plot.k = 'ji';
      const gx = m * (F.W / 2 - 3.3), out = Number.isFinite(frontD) ? Math.max(0, frontD - F.D / 2 - 0.4) : 0;
      if (out > 1.5 && out < 45) {
        const a0 = F.P(gx, 0.3), a1 = F.P(gx, -out);
        plot.drive = [r1(a0[0]), r1(a0[1]), r1(a1[0]), r1(a1[1]), 6.2];
        const ang = Math.atan2(F.yv[1], F.yv[0]);
        const nc = out > 6.5 && rp() < 0.6 ? (rp() < 0.4 ? 2 : 1) : 0;
        for (let k = 0; k < nc; k++) {
          const cp = F.P(gx + (nc === 2 ? (k ? 1.5 : -1.5) : (rp() < 0.5 ? 1.4 : -1.4)), -3.1);
          if (carFits(cp, ang, cell, ring)) parked.push([r1(cp[0]), r1(cp[1]), Math.round(ang * 1000) / 1000, Math.floor(rp() * 1000)]);
        }
      }
      const PL = 8 + rp() * 2, PW = 4 + rp();
      for (const [px, back] of [[-m * F.W * 0.12, 4.6], [-m * F.W * 0.12, 3.5], [0, 3.0], [m * F.W * 0.1, 3.0]]) {
        const pc = F.P(px, F.D + back), along = F.xv;
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b2]) => [pc[0] + along[0] * a * PL / 2 + F.yv[0] * b2 * PW / 2, pc[1] + along[1] * a * PL / 2 + F.yv[1] * b2 * PW / 2]);
        if (corners.every((q) => pointInRing(q, cell) && !pointInRing(q, ring) && !isWater(q))) { plot.pool = [r1(pc[0]), r1(pc[1]), Math.round(Math.atan2(along[1], along[0]) * 1000) / 1000, r1(PL), r1(PW)]; break; }
      }
      plots.push(plot);
      continue;
    }
    if ((v.hk === 'mansion' || v.hk === 'custom') && v.hframe) {
      // large villas: driveway from the garage side of the front to the street; the long pool along the rear in most gardens
      const F = v.hframe, m = v.hm || 1;
      plot.k = v.hk;
      const gx = m * (F.W / 2 - 3.6), out = Math.max(0, frontD - F.D / 2 - 0.6);
      const a0 = F.P(gx, 0.5), a1 = F.P(gx, -out);
      plot.drive = [r1(a0[0]), r1(a0[1]), r1(a1[0]), r1(a1[1]), v.hk === 'mansion' ? 7.5 : 6.4];
      const ang = Math.atan2(F.yv[1], F.yv[0]);
      const n = rp() < 0.85 ? (rp() < 0.55 ? 2 : 1) : 0;
      for (let k = 0; k < n; k++) {
        const cp = F.P(gx + (n === 2 ? (k ? 1.5 : -1.5) : 0), -2.6);
        if (carFits(cp, ang, cell, ring)) parked.push([r1(cp[0]), r1(cp[1]), Math.round(ang * 1000) / 1000, Math.floor(rp() * 1000)]);
      }
      if (rp() < (v.hk === 'custom' ? 0.6 : 0.85)) {
        const PL = Math.min(15, F.W * 0.62), PW = v.hk === 'mansion' ? 5 : 3.8;
        for (const back of [4.6, 3.6, 2.8]) {
          const pc = F.P(-m * F.W * 0.06, F.D + back), along = F.xv;
          const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b2]) => [pc[0] + along[0] * a * PL / 2 + F.yv[0] * b2 * PW / 2, pc[1] + along[1] * a * PL / 2 + F.yv[1] * b2 * PW / 2]);
          if (corners.every((q) => pointInRing(q, cell) && !pointInRing(q, ring) && !isWater(q))) { plot.pool = [r1(pc[0]), r1(pc[1]), Math.round(Math.atan2(along[1], along[0]) * 1000) / 1000, r1(PL), r1(PW)]; break; }
        }
      }
      plots.push(plot);
      continue;
    }
    if (v.hk === 'golf-place' && v.hframe) {
      // Golf Place: driveway to the garage wing; the plans' long pool along the rear boundary in about half the gardens
      const F = v.hframe, G = golfPlaceLayout(F.W, F.D, v.hm || 1);
      plot.k = 'golfplace';
      const gx = (G.garage[0] + G.garage[1]) / 2, gw = Math.abs(G.garage[1] - G.garage[0]);
      const out = Math.max(0, frontD - F.D / 2 - 0.6);
      const a0 = F.P(gx, 6.0), a1 = F.P(gx, -out);
      plot.drive = [r1(a0[0]), r1(a0[1]), r1(a1[0]), r1(a1[1]), r1(gw)];
      const ang = Math.atan2(F.yv[1], F.yv[0]);
      const n = rp() < 0.85 ? (rp() < 0.55 ? 2 : 1) : 0;
      for (let k = 0; k < n; k++) {
        const cp = F.P(gx + (n === 2 ? (k ? 1.5 : -1.5) : 0), 3.0);
        if (carFits(cp, ang, cell, null)) parked.push([r1(cp[0]), r1(cp[1]), Math.round(ang * 1000) / 1000, Math.floor(rp() * 1000)]);
      }
      if (rp() < 0.5) {
        const PL = Math.min(14, F.W * 0.62), PW = 3.6, pc = F.P(-v.hm * F.W * 0.08, F.D + 4.2);
        const along = F.xv;
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b2]) => [pc[0] + along[0] * a * PL / 2 + F.yv[0] * b2 * PW / 2, pc[1] + along[1] * a * PL / 2 + F.yv[1] * b2 * PW / 2]);
        if (corners.every((q) => pointInRing(q, cell) && !pointInRing(q, ring) && !isWater(q))) plot.pool = [r1(pc[0]), r1(pc[1]), Math.round(Math.atan2(along[1], along[0]) * 1000) / 1000, r1(PL), r1(PW)];
      }
      plots.push(plot);
      continue;
    }
    if (v.hk === 'maple' && v.hframe) {
      // Maple: open frontage; paving across the row of carports to the street, one or two cars in each carport
      const F = v.hframe, cl = mapleCluster(F.W);
      plot.k = 'maple';
      const [cy0, cy1] = MAPLE.carportY, yb = mapleY(F.D, cy0), yf = mapleY(F.D, cy1);
      const xs = cl.units.flatMap((u) => MAPLE[u.t].carport.map((x) => mapleX(cl, u, x)));
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const out = Math.max(0, frontD - (F.D / 2 - yf) - 0.6);
      const ym = (yb + yf - out) / 2;
      const p0 = F.P(x0, ym), p1 = F.P(x1, ym);
      plot.drive = [r1(p0[0]), r1(p0[1]), r1(p1[0]), r1(p1[1]), r1(yb - yf + out)];
      const ang = Math.atan2(F.yv[1], F.yv[0]);
      for (const u of cl.units) {
        const [a, bx] = MAPLE[u.t].carport, xm = (mapleX(cl, u, a) + mapleX(cl, u, bx)) / 2;
        const n = rp() < 0.8 ? (rp() < 0.45 ? 2 : 1) : 0;
        for (let k = 0; k < n; k++) {
          const cp = F.P(xm + (n === 2 ? (k ? 1.5 : -1.5) : rp() - 0.5), (yb + yf) / 2 + 0.2);
          if (carFits(cp, ang, cell, null)) parked.push([r1(cp[0]), r1(cp[1]), Math.round(ang * 1000) / 1000, Math.floor(rp() * 1000)]);
        }
      }
      plots.push(plot);
      continue;
    }
    // pool in the back garden (or a side garden)
    const poolProb = v.district === 'springs' ? 0.3 : v.vstyle === 'm' ? 0.85 : 0.68;
    if (rp() < poolProb) {
      const big = rp() < 0.2, PL = big ? 11 : 7.5 + rp() * 2.5, PW = big ? 5 : 3.6 + rp() * 1.2;
      const dirs = [[-front[0], -front[1]], [front[1], -front[0]], [-front[1], front[0]]];
      for (const dir of dirs) {
        const ext = extent(ring, c, dir);
        // align the pool's long side with the villa face it sits along
        const along = [-dir[1], dir[0]];
        const pc = [c[0] + dir[0] * (ext + PW / 2 + 2.2), c[1] + dir[1] * (ext + PW / 2 + 2.2)];
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b2]) => [pc[0] + along[0] * a * PL / 2 + dir[0] * b2 * PW / 2, pc[1] + along[1] * a * PL / 2 + dir[1] * b2 * PW / 2]);
        if (corners.every((q) => pointInRing(q, cell) && !pointInRing(q, ring) && !isWater(q))) {
          plot.pool = [r1(pc[0]), r1(pc[1]), Math.round(Math.atan2(along[1], along[0]) * 1000) / 1000, r1(PL), r1(PW)];
          break;
        }
      }
    }
    // paved driveway/forecourt from the front door to the street; cars park nose-in close to the house
    {
      const ext = extent(ring, c, front);
      const side = [-front[1], front[0]];
      const so = (rp() < 0.5 ? -1 : 1) * Math.min(ob.wid, ob.len) * 0.22;
      const p0 = [c[0] + front[0] * ext + side[0] * so, c[1] + front[1] * ext + side[1] * so];
      const len = Math.max(0, frontD - ext - 1.6);
      if (len > 3 && len < 25) {
        const p1 = [p0[0] + front[0] * len, p0[1] + front[1] * len];
        const wide = len > 6 && rp() < 0.35; // double-width forecourt for two cars
        plot.drive = [r1(p0[0]), r1(p0[1]), r1(p1[0]), r1(p1[1]), wide ? 7.5 : 5];
        if (len > 6.2) {
          const n = rp() < 0.62 ? (wide && rp() < 0.6 ? 2 : 1) : 0;
          for (let k = 0; k < n; k++) {
            const off = n === 2 ? (k ? 1.45 : -1.45) : 0;
            const cp = [p0[0] + front[0] * 3.2 + side[0] * off, p0[1] + front[1] * 3.2 + side[1] * off];
            const ang = Math.atan2(-front[1], -front[0]); // nose towards the house
            if (carFits(cp, ang, cell, ring)) parked.push([r1(cp[0]), r1(cp[1]), Math.round(ang * 1000) / 1000, Math.floor(rp() * 1000)]);
          }
        }
      }
    }
    plots.push(plot);
  }
  // Jumeirah Islands townhouses: cars under the open double carports (two bays a house; houses-kit jiRow lays the
  // row out the same way)
  for (const b of buildings) {
    if (b.hk !== 'ji-th' || !b.hframe || !b.front) continue;
    const F = b.hframe, n = Math.max(1, Math.round(F.W / 8)), u = F.W / n, cw = Math.min(6.2, u - 1.0), ang = Math.atan2(F.yv[1], F.yv[0]);
    for (let k = 0; k < n; k++) for (const s of [-1, 1]) {
      if (rp() > 0.6) continue;
      const cp = F.P(-F.W / 2 + k * u + 0.3 + cw / 2 + s * cw * 0.24, 2.9);
      parked.push([r1(cp[0]), r1(cp[1]), Math.round(ang * 1000) / 1000, Math.floor(rp() * 1000)]);
    }
  }
  // trees from the earlier passes (verges, greenery from the imagery) that now stand inside a fitted house go
  {
    const hg = new Grid(60); let nh = 0;
    for (const pl of plots) if (pl.hull) { hg.insert(bboxOf(pl.hull), pl.hull); nh++; }
    if (nh) {
      const kept = trees.filter((t) => !hg.query(t[0], t[1]).some((r) => pointInRing(t, r)));
      const gone = trees.length - kept.length; trees.length = 0; for (const t of kept) trees.push(t);
      console.log(`  trees inside fitted houses removed: ${gone}`);
    }
  }
  // Emirates Hills gardens (landscape research): palms in a row inside the boundary walls, an avenue of palms along
  // the drive, specimen trees across the lawns, frangipani and bougainvillea near the house
  const estateGarden = (pl) => {
    const ring = signedArea(pl.p) < 0 ? pl.p.slice().reverse() : pl.p, house = pl.b.polys[0][0];
    const pool = pl.pool, drive = pl.drive, fc = pl.fc;
    const clear = (q, d) => pointInRing(q, ring) && !pointInRing(q, house) && !(pool && Math.hypot(q[0] - pool[0], q[1] - pool[1]) < pool[3] / 2 + 2.5)
      && !(drive && distToSegment(q, [drive[0], drive[1]], [drive[2], drive[3]]) < drive[4] / 2 + d)
      && !(fc && Math.hypot(q[0] - fc[0], q[1] - fc[1]) < Math.max(fc[3], fc[4]) / 2 + 1)
      && !(pl.b.hull && pointInRing(q, pl.b.hull));
    // boundary palms, 1.8 m inside the walls
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b2 = ring[(i + 1) % ring.length], dx = b2[0] - a[0], dy = b2[1] - a[1], L = Math.hypot(dx, dy); if (L < 4) continue;
      const nx = -dy / L, ny = dx / L; // inward for a CCW ring
      // along the street front a row of tall Washingtonia behind the railings (the photographs); elsewhere mostly date
      // palms with dense broadleaf screening (ficus, neem, conocarpus)
      const front = pl.front && (-nx * pl.front[0] - ny * pl.front[1]) > 0.6;
      for (let t = 3; t < L - 2; t += front ? 7 : 8.5 + rp() * 3) {
        const q = [a[0] + (dx / L) * t + nx * (front ? 2.2 : 1.8), a[1] + (dy / L) * t + ny * (front ? 2.2 : 1.8)], x = rp();
        if (clear(q, 0.8)) addTree(q, front ? 2 : x < 0.5 ? 0 : x < 0.62 ? 2 : x < 0.8 ? 1 : x < 0.9 ? 5 : 8, front ? 1.15 + rp() * 0.2 : 0.95 + rp() * 0.4, { minDist: 4.5 });
      }
    }
    // palm avenue along the drive
    if (drive) {
      const ax = drive[2] - drive[0], ay = drive[3] - drive[1], L = Math.hypot(ax, ay);
      if (L > 4 && L < 80) for (let t = 2; t < L; t += 6) for (const sd of [-1, 1]) {
        const off = drive[4] / 2 + 1.4;
        addTree([drive[0] + (ax / L) * t - (ay / L) * off * sd, drive[1] + (ay / L) * t + (ax / L) * off * sd], 0, 1.05 + rp() * 0.2, { minDist: 3.5 });
      }
    }
    // specimen trees across the lawns and shrubs near the house
    const bb = bboxOf(ring), area = Math.abs(signedArea(ring));
    const nSpec = Math.min(26, Math.round(area / 180));
    for (let k = 0, placed = 0; k < nSpec * 6 && placed < nSpec; k++) {
      const q = [bb[0] + rp() * (bb[2] - bb[0]), bb[1] + rp() * (bb[3] - bb[1])];
      if (!clear(q, 1.5)) continue;
      const x = rp();
      // frangipani, flame trees, neem, fan palms, ficus-like broadleaf, date palms, shrubs (no Conocarpus: the
      // community manager no longer allows it)
      const type = x < 0.18 ? 10 : x < 0.3 ? 5 : x < 0.42 ? 8 : x < 0.52 ? 2 : x < 0.72 ? 1 : x < 0.86 ? 0 : 3;
      if (addTree(q, type, 0.9 + rp() * 0.5, { minDist: type === 3 ? 2.2 : 4.5 })) placed++;
    }
    // bougainvillea against the walls
    for (let k = 0; k < 6; k++) {
      const i = Math.floor(rp() * ring.length), a = ring[i], b2 = ring[(i + 1) % ring.length], t = 0.15 + rp() * 0.7;
      const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]) || 1, nx = -(b2[1] - a[1]) / L, ny = (b2[0] - a[0]) / L;
      addTree([a[0] + (b2[0] - a[0]) * t + nx * 0.9, a[1] + (b2[1] - a[1]) * t + ny * 0.9], 4, 0.9 + rp() * 0.5, { minDist: 1.5 });
    }
  };
  // garden planting: trees along the plot edges, flowering bushes by the walls
  for (const pl of plots) {
    if (pl.k === 'eh') { estateGarden(pl); continue; }
    const ring = pl.p; const bb = bboxOf(ring);
    const nTrees = (pl.k === 'ji' ? 2 : 0) + 2 + Math.floor(rp() * (pl.b.district === 'springs' ? 2 : 5));
    let placed = 0;
    for (let k = 0; k < 40 && placed < nTrees; k++) {
      const q = [bb[0] + rp() * (bb[2] - bb[0]), bb[1] + rp() * (bb[3] - bb[1])];
      if (!pointInRing(q, ring) || pointInRing(q, pl.b.polys[0][0]) || (pl.hull && pointInRing(q, pl.hull))) continue;
      let de = Infinity; for (let i = 0; i < ring.length; i++) de = Math.min(de, distToSegment(q, ring[i], ring[(i + 1) % ring.length]));
      if (de > 3.5) continue;
      if (pl.pool && Math.hypot(q[0] - pl.pool[0], q[1] - pl.pool[1]) < pl.pool[3] / 2 + 1.5) continue;
      const x = rp();
      if (addTree(q, pl.k === 'ji' ? (x < 0.42 ? 0 : x < 0.6 ? 10 : x < 0.82 ? 4 : 3) : x < 0.08 ? 3 : pickSpecies(MIX.garden, rp), 0.75 + rp() * 0.45, { minDist: 2.6 })) placed++;
    }
    // bougainvillea along a wall
    const nb = Math.floor(rp() * 4);
    for (let k = 0; k < nb; k++) {
      const i = Math.floor(rp() * ring.length), a = ring[i], b2 = ring[(i + 1) % ring.length], t = 0.2 + rp() * 0.6;
      const q = [a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t];
      const cc = centroid(ring); const dx = cc[0] - q[0], dy = cc[1] - q[1], L = Math.hypot(dx, dy) || 1;
      addTree([q[0] + (dx / L) * 1.0, q[1] + (dy / L) * 1.0], 4, 0.8 + rp() * 0.5, { minDist: 1.5 });
    }
  }
}
function rp2(p) { return [r1(p[0]), r1(p[1])]; }
// footprint corners of a parked vehicle (length along `ang`)
function carCorners(c, ang, L = 4.7, W = 2.0) {
  const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [c[0] + (ux * a * L) / 2 + (vx * b * W) / 2, c[1] + (uy * a * L) / 2 + (vy * b * W) / 2]);
}
// a car fits when it lies fully inside `inside`, misses `avoid`, stays off every road surface and out of water
function carFits(c, ang, inside, avoid) {
  const cs = carCorners(c, ang);
  if (inside && !cs.every((q) => pointInRing(q, inside))) return false;
  if (avoid && cs.some((q) => pointInRing(q, avoid))) return false;
  return cs.every((q) => !onRoad(q, 0.35) && !isWater(q));
}

// ---------------------------------------------------------------- the Burj Lake promenade (Downtown)
// The waterfront round the Burj Khalifa lake (data-raw/research/malls/dubai-mall): a promenade of grey-pink granite
// laid in bands that follow the water's edge, about 28 m wide in front of The Dubai Mall (OSM gap 10-50 m), with a
// row of date palms, lantern lamps near the water, and the restaurant terraces under white parasols along the
// fronts of the mall, Souk Al Bahar and the hotels. The ground painter draws the paving (world.burjWalk).
let burjWalk = [], burjLake = null;
{
  const w = ways.get(175110538), poly = w && isClosed(w) ? wayPoly(w) : null;
  if (poly) {
    const rb = rng(828);
    burjWalk = poly.map((r) => r.map(rp));
    let palms = 0, lamps = 0, terr = 0;
    // the paving is kept clear: trees from the earlier passes that stand within 30 m of the water go (the lawns of
    // Burj Park and the mapped gardens keep theirs), and later planting stays off it
    const BAND = 30, green = (areas.park || []).concat(areas.grass || []), inGreen = (q) => green.some((g) => pointInPoly(q, g));
    {
      const bb = bboxOf(poly[0]), segs = []; for (const ring of poly) for (let i = 0; i < ring.length; i++) segs.push([ring[i], ring[(i + 1) % ring.length]]);
      const kept = trees.filter((t) => t[2] > 0 || t[0] < bb[0] - BAND || t[0] > bb[2] + BAND || t[1] < bb[1] - BAND || t[1] > bb[3] + BAND || inGreen(t) || !segs.some(([a, b]) => distToSegment(t, a, b) < BAND));
      const gone = trees.length - kept.length; trees.length = 0; for (const t of kept) trees.push(t);
      console.log(`  Burj Lake promenade: ${gone} trees cleared off the paving`);
    }
    const bandRings = [];
    const FRONTS = /Dubai Mall|Souk Al Bahar|Palace|Address/i;
    // The Dubai Mall's own lake front is built in detail by src/layers/burjLake.js: restaurant terraces in two tiers
    // against the wall (each `TD(gap)` deep, where gap is the distance from wall to water), then the row of palms
    let mall = null;
    for (const ring of poly) for (let i = 0; i < ring.length && !mall; i += 3) for (const [dx, dy] of [[30, 0], [-30, 0], [0, 30], [0, -30], [21, 21], [-21, 21], [21, -21], [-21, -21]]) { const hb = buildingAt([ring[i][0] + dx, ring[i][1] + dy]); if (hb && cleanName(hb.tags) === 'The Dubai Mall') { mall = hb; break; } }
    const mallRing = mall ? (typeof mall.polys[0][0][0] === 'number' ? mall.polys[0] : mall.polys[0][0]) : null;
    const mallD = (q) => { if (!mallRing) return Infinity; let d = Infinity; for (let i = 0; i < mallRing.length; i++) { const e = distToSegment(q, mallRing[i], mallRing[(i + 1) % mallRing.length]); if (e < d) d = e; } return d; };
    const TD = (gap) => { const d = Math.min(7, (gap - 13) / 2); return d < 3.5 ? 0 : d; };
    const pylons = [], benches = [];
    for (const ring of poly) {
      const ccw = signedArea(ring) > 0;
      let accP = 4, accL = 10, accT = 6;
      // strollers: a walking line 7.5 m back from the water, broken where a building or a road comes to the edge
      let run = [];
      const flush = () => { if (run.length >= 5) for (const piece of clipPolyline(run, Rpad)) pathsOut.push({ k: 1, w: 6, l: 1, h: 1, p: simplifyLine(piece.pts, 0.3).map(rp) }); run = []; };
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
        const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
        // toward the land: the right of the direction of travel on a counter-clockwise outline of the water
        const nx = ccw ? uy : -uy, ny = ccw ? -ux : ux;
        const at = (s, off) => [a[0] + ux * s + nx * off, a[1] + uy * s + ny * off];
        const clear = (q) => inBox(q, -3) && !isWater(q) && !buildingAt(q) && !onRoad(q, 1.2);
        if (!inGreen(at(L / 2, 15))) bandRings.push([at(-1, 0), at(L + 1, 0), at(L + 1, BAND), at(-1, BAND)]);
        for (let s = 0; s < L; s += 8) { const q = at(s, 7.5); if (clear(q)) run.push(q); else flush(); }
        for (let s = accP; s < L; s += 13) {
          // along the mall's front the palms stand in a row at the outer edge of the restaurant terraces
          // (in front of the mall they are planted from the wall instead: one between each pair of terraces, see below)
          let front = false; if (mall) for (let o2 = 5; o2 <= 60 && !front; o2 += 1.5) if (buildingAt(at(s, o2)) === mall) front = true;
          const q = at(s, 11.5); if (!front && clear(q) && clear(at(s, 6)) && addTree(q, 0, 1.1 + rb() * 0.2, { minDist: 7 })) palms++;
        }
        accP = ((accP - L) % 13 + 13) % 13;
        for (let s = accL; s < L; s += 22) {
          // lantern pylons near the water's edge, a stone bench between each pair
          const q = at(s, 2.6); if (clear(q) && !amenAt(q)) { pylons.push([r1(q[0]), r1(q[1]), ang3(Math.atan2(uy, ux))]); lamps++; }
          const qb = at(s + 11, 5.2); if (s + 11 < L && clear(qb) && !amenAt(qb) && !inGreen(qb)) benches.push([r1(qb[0]), r1(qb[1]), ang3(Math.atan2(uy, ux))]);
        }
        accL = ((accL - L) % 22 + 22) % 22;
        for (let s = accT; s < L; s += 17) {
          // a terrace where a restaurant front stands 20-40 m back from the water
          let host = null, d0 = 0;
          for (let off = 9; off <= 46 && !host; off += 1.5) { const hb = buildingAt(at(s, off)); if (hb) { host = hb; d0 = off; } }
          if (!host || host === mall || !FRONTS.test(cleanName(host.tags) || '') || d0 < 13) continue;
          const c = at(s, d0 - 3.4), ang = Math.atan2(-ny, -nx), n = 3 + Math.floor(rb() * 2);
          const rect = rectAt(c, ang, 4.8, n * 3.3);
          if (rect.some((q) => onRoad(q, 0.4) || isWater(q) || amenAt(q) || buildingAt(q))) continue;
          amen.cafes.push([r1(c[0]), r1(c[1]), ang3(ang), n, 2, Math.floor(rb() * 4), 0]); addAmenRing(rect); terr++;
        }
        accT = ((accT - L) % 17 + 17) % 17;
      }
      flush();
    }
    // ---- the waterfront in detail, all from OSM vector data
    {
      const lakeSegs = []; for (const ring of poly) for (let i = 0; i < ring.length; i++) lakeSegs.push([ring[i], ring[(i + 1) % ring.length]]);
      const lakeD = (q) => { let d = Infinity; for (const [a, b] of lakeSegs) { const e = distToSegment(q, a, b); if (e < d) d = e; } return d; };
      const out = { front: [], souk: [], bridge: null, pois: [], doors: [], stripes: [], pylons, benches, rail: [] };
      // the mall's lake front: the stretches of its outline that look straight onto the water, 60 m away at most
      if (mallRing) {
        const closed = Math.hypot(mallRing[0][0] - mallRing[mallRing.length - 1][0], mallRing[0][1] - mallRing[mallRing.length - 1][1]) < 0.01;
        let R = closed ? mallRing.slice(0, -1) : mallRing.slice(); if (signedArea(R) < 0) R.reverse(); // counter-clockwise: outward is to the right
        let run = [];
        // one palm at each bay line (the bays are those of src/layers/burjLake.js: about 9 m), just outside the terraces
        const plantFront = (raw) => {
          const line = raw.map(rp), cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
          const L = cum[cum.length - 1]; if (L < 7) return;
          const P = (s) => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1); return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t]; };
          const n = Math.max(1, Math.round(L / 9)), bw = L / n;
          for (let k = 0; k <= n; k++) {
            const s = k * bw, p = P(s), pa = P(Math.max(0, s - 1.5)), pb = P(Math.min(L, s + 1.5)), l = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1, nx = (pb[1] - pa[1]) / l, ny = -(pb[0] - pa[0]) / l;
            let gap = 0; for (let e = 2; e <= 62; e += 1) if (isWater([p[0] + nx * e, p[1] + ny * e])) { gap = e; break; }
            if (!gap) continue;
            const td = TD(gap), off = td ? 2 * td + 1.3 : 3.2; if (gap - off < 4.5) continue;
            const q = [p[0] + nx * off, p[1] + ny * off];
            if (!buildingAt(q) && !isWater(q) && !onRoad(q, 1) && addTree(q, 0, 1.0 + rb() * 0.15, { minDist: 5 })) palms++;
          }
        };
        const flushF = () => { if (run.length >= 2) { plantFront(run); out.front.push(run.map(rp)); } run = []; };
        for (let i = 0; i < R.length; i++) {
          const a = R[i], b = R[(i + 1) % R.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.2) continue;
          const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L, m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          let gap = 0;
          for (let d = 2; d <= 60; d += 2) { const q = [m[0] + nx * d, m[1] + ny * d]; if (isWater(q) && lakeD(q) < 62) { gap = d; break; } const hb = buildingAt(q); if (hb && hb !== mall) break; }
          if (gap) { if (!run.length) run.push(a); run.push(b); } else flushF();
        }
        flushF();
        // the generic terraces placed earlier along this wall give way to the modelled ones
        const n0 = amen.cafes.length; amen.cafes = amen.cafes.filter((c) => !(mallD(c) < 17 && lakeD(c) < 62));
        console.log(`  Burj Lake: mall front ${out.front.length} stretches, ${Math.round(out.front.reduce((s, r) => s + polylineLength(r), 0))} m; ${n0 - amen.cafes.length} generic terraces replaced`);
      }
      // Souk Al Bahar's fronts on the water (its arcades): the stretches of its outline within 45 m of the lake
      {
        let souk = null;
        for (const ring of poly) for (let i = 0; i < ring.length && !souk; i += 2) for (const [dx, dy] of [[12, 0], [-12, 0], [0, 12], [0, -12], [18, 18], [-18, 18], [18, -18], [-18, -18]]) { const hb = buildingAt([ring[i][0] + dx, ring[i][1] + dy]); if (hb && cleanName(hb.tags) === 'Souk Al Bahar') { souk = hb; break; } }
        const sr = souk ? (typeof souk.polys[0][0][0] === 'number' ? souk.polys[0] : souk.polys[0][0]) : null;
        if (sr) {
          const closed = Math.hypot(sr[0][0] - sr[sr.length - 1][0], sr[0][1] - sr[sr.length - 1][1]) < 0.01;
          let R = closed ? sr.slice(0, -1) : sr.slice(); if (signedArea(R) < 0) R.reverse();
          let run = [];
          const flushK = () => { if (run.length >= 2) out.souk.push(run.map(rp)); run = []; };
          for (let i = 0; i < R.length; i++) {
            const a = R[i], b = R[(i + 1) % R.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.2) continue;
            const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L;
            // an edge counts when most of it looks onto the water
            let hit = 0, tot = 0;
            for (let s = Math.min(3, L / 2); s < L; s += 6) { tot++; for (let d = 1; d <= 45; d += 1.5) { const q = [a[0] + (b[0] - a[0]) * s / L + nx * d, a[1] + (b[1] - a[1]) * s / L + ny * d]; if (isWater(q) && lakeD(q) < 47) { hit++; break; } const hb = buildingAt(q); if (hb && hb !== souk) break; } }
            if (tot && hit / tot >= 0.6) { if (!run.length) run.push(a); run.push(b); } else flushK();
          }
          flushK();
          console.log(`  Burj Lake: Souk Al Bahar fronts ${out.souk.length} stretches, ${Math.round(out.souk.reduce((s, r) => s + polylineLength(r), 0))} m (outline ${R.length} pts)`);
        }
      }
      const bw = ways.get(906557187), bp = bw && isClosed(bw) ? wayPoly(bw) : null; if (bp) out.bridge = bp[0].map(rp);
      // mapped outlets round the lake (names and positions as OpenStreetMap has them) and the mall's main doors
      {
        const bb = bboxOf(poly[0]), seenP = new Set();
        const KIND = (t) => (/^(restaurant|food_court|pub|bar)$/.test(t.amenity || '') ? 0 : /^(cafe|ice_cream)$/.test(t.amenity || '') || /^(bakery|chocolate|confectionery|pastry)$/.test(t.shop || '') ? 1 : t.amenity === 'fast_food' ? 2 : t.shop ? 3 : -1);
        for (const n of nodes.values()) {
          const t = n.tags; if (!t) continue;
          if (!(t.amenity || t.shop || t.entrance)) continue;
          const p = project(n.lat, n.lon); if (p[0] < bb[0] - 90 || p[0] > bb[2] + 90 || p[1] < bb[1] - 90 || p[1] > bb[3] + 90) continue;
          if (t.entrance === 'main' && mallD(p) < 6 && lakeD(p) < 70) { out.doors.push(rp(p)); continue; }
          const k = KIND(t); if (k < 0 || lakeD(p) > 80) continue;
          const name = (t['name:en'] || t.name || '').split(' - ')[0].replace('Citchen', 'Kitchen').replace(/\s+/g, ' ').trim();
          if (!name || name.length > 30 || /^souk al bahar$/i.test(name) || seenP.has(name.toLowerCase())) continue;
          seenP.add(name.toLowerCase());
          out.pois.push([r1(p[0]), r1(p[1]), name, k, parseFloat(t.level) || 0]);
        }
      }
      // paving joints: darker lines every 4.2 m that follow the water's edge, where the ground is open paving
      for (const ring of poly) {
        const ccw = signedArea(ring) > 0;
        for (let k = 1; k <= 7; k++) {
          const off = k * 4.2; let run = [];
          const flushS = () => { if (run.length >= 3) out.stripes.push(simplifyLine(run, 0.12).map(rp)); run = []; };
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
            const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = ccw ? uy : -uy, ny = ccw ? -ux : ux;
            for (let s = 0; s < L; s += 2.5) {
              const q = [a[0] + ux * s + nx * off, a[1] + uy * s + ny * off];
              let ok = Math.abs(lakeD(q) - off) < 0.5 && inBox(q, -3) && !isWater(q) && !buildingAt(q) && !onRoad(q, 0.6) && !inGreen(q);
              if (ok && mallRing) { const md = mallD(q); if (md < 2 * TD(md + off) + 0.5) ok = false; }
              if (ok) run.push(q); else flushS();
            }
          }
          flushS();
        }
        // the railing along the water, left open where a wall, a deck or the bridge meets the edge
        let runR = [];
        const flushR = () => { if (runR.length >= 2) out.rail.push(simplifyLine(runR, 0.1).map(rp)); runR = []; };
        for (let i = 0; i <= ring.length; i++) {
          const a = ring[i % ring.length], b = ring[(i + 1) % ring.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = ccw ? uy : -uy, ny = ccw ? -ux : ux, land = [a[0] + nx * 1.6, a[1] + ny * 1.6];
          if (!isWater(land) && !buildingAt(land) && !pierAreas.some((pl) => pointInPoly(land, pl) || pointInPoly([a[0] - nx * 1.2, a[1] - ny * 1.2], pl))) runR.push([a[0] + nx * 0.35, a[1] + ny * 0.35]); else flushR();
        }
        flushR();
      }
      burjLake = out;
      for (const q of bandRings) addAmenRing(q); // later planting stays off the paving
      console.log(`  Burj Lake: ${out.pois.length} outlets, ${out.doors.length} mall doors, ${out.stripes.length} paving joints, ${out.rail.length} railing runs, ${pylons.length} pylons, ${benches.length} benches, bridge ${out.bridge ? out.bridge.length + ' pts' : 'missing'}`);
    }
    console.log(`  Burj Lake promenade: ${palms} palms, ${lamps} lamps, ${terr} terraces`);
  }
}

// ---------------------------------------------------------------- promenade & urban planting
{
  const rt = rng(5150);
  const marinaPolys = areas.marina || [];
  const inMarina = (p) => marinaPolys.some((poly) => pointInPoly(p, poly));
  const plantAlong = (ring, spacing, inset, test, typeFn) => {
    let acc = rt() * spacing;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b2 = ring[(i + 1) % ring.length]; const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]); if (L < 0.5) continue;
      const ux = (b2[0] - a[0]) / L, uy = (b2[1] - a[1]) / L, nx = -uy, ny = ux; // left normal = inland for CCW land rings
      for (let s = acc; s < L; s += spacing) {
        const p = [a[0] + ux * s, a[1] + uy * s];
        if (!test(p, [nx, ny])) continue;
        addTree([p[0] + nx * inset, p[1] + ny * inset], typeFn(), 0.9 + rt() * 0.3, { minDist: 4 });
      }
      acc = ((acc - L) % spacing + spacing) % spacing;
    }
  };
  // Marina Walk: palms along the canal edge
  for (const ring of coastResult.land) plantAlong(signedArea(ring) > 0 ? ring : ring.slice().reverse(), 11, 4, (p, n) => inMarina([p[0] - n[0] * 8, p[1] - n[1] * 8]), () => (rt() < 0.85 ? 0 : 2));
  // lake edges (JLT lakes, Meadows/Islands lakes)
  for (const poly of areas.water || []) {
    const ring = signedArea(poly[0]) > 0 ? poly[0].slice().reverse() : poly[0]; // CW so that the left normal points onto land
    plantAlong(ring, 13, 3.5, () => true, () => pickSpecies(MIX.lake, rt));
  }
  // footpaths outside villa plots
  for (const pth of pathsOut) {
    if (pth.k === 'breakwater' || pth.w > 4) continue;
    const pts = pth.p; let acc = rt() * 12;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b2 = pts[i]; const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]); if (L < 0.5) continue;
      const ux = (b2[0] - a[0]) / L, uy = (b2[1] - a[1]) / L;
      for (let s = acc; s < L; s += 12) addTree([a[0] + ux * s - uy * 2.2, a[1] + uy * s + ux * 2.2], rt() < 0.55 ? 0 : 1, 0.85 + rt() * 0.3, { minDist: 4.5 });
      acc = ((acc - L) % 12 + 12) % 12;
    }
  }
  // landscaped grounds around towers (Marina, JBR, JLT, Harbour, Bluewaters)
  const towerLand = [...(areas.residential || []), ...(areas.commercial || []), ...(areas.plaza || [])].filter((p) => {
    const c = centroid(p[0]); const a = Math.abs(signedArea(p[0]));
    return a < 250000 && (seaSide(c) || inPolys(c, DP.jlt));
  });
  for (const p of towerLand) scatter(p, 1 / 380, () => (rt() < 0.5 ? 0 : pickSpecies(MIX.park, rt)), 5);
}

// ---------------------------------------------------------------- planting where the 2026 imagery shows green
// Trees where NDVI says dense planting, shrubs where it is lighter; villa gardens, golf playing areas
// and car parks are planted by their own rules.
if (ndviGrid) {
  const rv = rng(2026);
  const plotGrid = new Grid(60); plots.forEach((pl) => plotGrid.insert(bboxOf(pl.p), pl));
  const lotGrid = new Grid(80); parkingLots.forEach((l) => lotGrid.insert(bboxOf(l.poly[0]), l));
  const inPlot = (q) => plotGrid.query(q[0], q[1]).some((pl) => pointInRing(q, pl.p));
  const inLot = (q) => lotGrid.query(q[0], q[1]).some((l) => pointInPoly(q, l.poly));
  const inGolfPlay = (q) => giGrid.query(q[0], q[1]).some((g) => pointInPoly(q, g));
  const S = 7; let added = 0;
  for (let x = R.x0 + S / 2; x < R.x1; x += S) for (let y = R.y0 + S / 2; y < R.y1; y += S) {
    const q = [x + (rv() - 0.5) * S * 0.9, y + (rv() - 0.5) * S * 0.9];
    const nd = ndviAt(q);
    if (nd < 0.36) continue;
    const t = Math.min(1, (nd - 0.36) / 0.26);
    if (rv() > t * t * (3 - 2 * t) * 0.5) continue;
    if (inPlot(q) || inLot(q) || inGolfPlay(q)) continue;
    const nearRoad = onRoad(q, 5.5);
    const type = nearRoad ? pickSpecies(MIX.boulevard, rv) : nd > 0.55 ? pickSpecies(MIX.dense, rv) : pickSpecies(MIX.light, rv);
    if (addTree(q, type, 0.8 + rv() * 0.5, { minDist: type === 3 ? 2.5 : 4.2 })) added++;
  }
  console.log(`  NDVI planting (${ndviMeta.scene}): ${added} trees & shrubs`);
}

// ---------------------------------------------------------------- parking lots: real surface lots, marked bays along aisles
// Reference: Esri World Imagery (Oct 2026). Dubai surface lots are double rows of nose-in bays (~5 m deep,
// ~2.5 m wide, red interlocking pavers or light paving with painted lines) either side of ~6 m asphalt aisles,
// typically 25-70% occupied. OSM also maps underground car parks at surface level - those must stay empty.
const lots = [], bays = [], canopies = [];
{
  const rc = rng(31337);
  const EXCLUDE = new Set([711083548]); // mapped as parking, imagery shows vacant sand
  // service lanes running through a lot are its aisles, whether or not OSM tags them parking_aisle
  const lotOf = new Map();
  for (const r of roadWays) {
    if (r.kind !== 'service' || r.t.service === 'driveway') continue;
    const pts = wayPts(r.w);
    for (const lot of parkingLots) if (pts.some((p) => pointInPoly(p, lot.poly))) { lotOf.set(r, lot); break; }
  }
  const isAisle = (r) => r.kind === 'service' && (r.t.service === 'parking_aisle' || lotOf.has(r));
  const aisles = roadWays.filter(isAisle).map((r) => ({ r, pts: wayPts(r.w) }));
  const nearInside = (q, poly, tol) => {
    if (pointInPoly(q, poly)) return true;
    for (const rr of poly) for (let i = 0; i < rr.length; i++) if (distToSegment(q, rr[i], rr[(i + 1) % rr.length]) < tol) return true;
    return false;
  };
  const roadGrid = new Grid(40);
  for (const r of roadWays) {
    if (isAisle(r)) continue;
    const pts = wayPts(r.w);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b2 = pts[i], m = r.width;
      roadGrid.insert([Math.min(a[0], b2[0]) - m, Math.min(a[1], b2[1]) - m, Math.max(a[0], b2[0]) + m, Math.max(a[1], b2[1]) + m], { a, b: b2, hw: r.width / 2 });
    }
  }
  const aisleGrid = new Grid(40);
  for (const a of aisles) for (let i = 1; i < a.pts.length; i++) {
    const p = a.pts[i - 1], q = a.pts[i];
    aisleGrid.insert([Math.min(p[0], q[0]) - 6, Math.min(p[1], q[1]) - 6, Math.max(p[0], q[0]) + 6, Math.max(p[1], q[1]) + 6], { a: p, b: q, hw: 2.7 });
  }
  const clear = (q, grid, m) => grid.query(q[0], q[1]).every((s) => distToSegment(q, s.a, s.b) >= s.hw + m);
  const plotGrid = new Grid(60); plots.forEach((pl) => plotGrid.insert(bboxOf(pl.p), pl.p));
  const inPlot = (q) => plotGrid.query(q[0], q[1]).some((r) => pointInRing(q, r));
  const bayGrid = new Grid(8);
  const bayFree = (q) => bayGrid.query(q[0], q[1]).every((o) => Math.hypot(o[0] - q[0], o[1] - q[1]) >= 2.35);

  for (const lot of parkingLots) {
    const t = lot.tags, kind = t.parking || '';
    if (EXCLUDE.has(lot.id) || t.building) continue;
    if (['underground', 'multi-storey', 'rooftop', 'sheds', 'carports', 'garage_boxes'].includes(kind)) continue;
    const poly = lot.poly, ring = poly[0], area = Math.abs(signedArea(ring));
    if (!inBox(centroid(ring), -5)) continue;
    const street = kind === 'street_side' || kind === 'lane';
    const myAisles = aisles.filter((a) => a.pts.some((p) => pointInPoly(p, poly)));
    // keep lots that are clearly real: mapped aisles, explicit surface lots, or small lots
    if (!street && !myAisles.length && !(kind === 'surface' && area < 15000) && area > 5000) continue;
    const style = street ? 0 : rc() < 0.45 ? 1 : rc() < 0.55 ? 2 : 0; // 0 asphalt, 1 red pavers, 2 light paving
    const occupancy = street ? 0.55 + rc() * 0.3 : 0.28 + rc() * 0.45;
    const lotBays = [];
    const rej = { out: 0, road: 0, aisle: 0, misc: 0, bld: 0, dup: 0 };
    const tryBay = (c, ang, D, W) => {
      const cs = carCorners(c, ang, D, W);
      if (!pointInPoly(c, poly) || !cs.every((q) => nearInside(q, poly, 1.0))) { rej.out++; return; }
      if (!cs.every((q) => clear(q, roadGrid, 0.25))) { rej.road++; return; }
      if (!cs.every((q) => clear(q, aisleGrid, 0.0))) { rej.aisle++; return; }
      if (!cs.every((q) => !isWater(q) && !inPlot(q))) { rej.misc++; return; }
      if (buildingAt(c) || cs.some((q) => buildingAt(q))) { rej.bld++; return; }
      if (!bayFree(c)) { rej.dup++; return; }
      bayGrid.insert([c[0], c[1], c[0], c[1]], c);
      lotBays.push([c, ang]);
    };
    const ob = obb(ring);
    if (street && ob) {
      for (let s = -ob.len / 2 + 3.2; s < ob.len / 2 - 3.1; s += 6.1) tryBay([ob.center[0] + ob.u[0] * s, ob.center[1] + ob.u[1] * s], Math.atan2(ob.u[1], ob.u[0]), 5.8, 2.3);
    } else if (myAisles.length) {
      for (const a of myAisles) for (let i = 1; i < a.pts.length; i++) {
        const p = a.pts[i - 1], q = a.pts[i], L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L < 4) continue;
        const ux = (q[0] - p[0]) / L, uy = (q[1] - p[1]) / L, nx = -uy, ny = ux;
        for (const sd of [1, -1]) for (let s = 1.5; s < L - 1.2; s += 2.5) {
          const off = 3.05 + 2.55;
          tryBay([p[0] + ux * s + nx * sd * off, p[1] + uy * s + ny * sd * off], Math.atan2(ny * sd, nx * sd), 5.1, 2.4);
        }
      }
    } else if (ob && ob.wid >= 10) {
      // no mapped aisles: double rows aligned with the lot, aisle after every pair
      for (let t0 = -ob.wid / 2 + 0.3; t0 + 10.2 <= ob.wid / 2; t0 += 16.6) {
        for (const [ro, fl] of [[2.55, 1], [7.65, -1]]) for (let s = -ob.len / 2 + 1.5; s < ob.len / 2 - 1.2; s += 2.5) {
          tryBay([ob.center[0] + ob.u[0] * s + ob.v[0] * (t0 + ro), ob.center[1] + ob.u[1] * s + ob.v[1] * (t0 + ro)], Math.atan2(ob.v[1] * fl, ob.v[0] * fl), 5.1, 2.4);
        }
      }
    }
    if (process.env.DEBUG_LOT && +process.env.DEBUG_LOT === lot.id) console.log('  lot', lot.id, 'aisles', myAisles.length, 'bays', lotBays.length, JSON.stringify(rej));
    if (!lotBays.length) continue;
    lots.push({ p: poly.map(rRing), s: style });
    const shade = !street && lotBays.length > 10 && rc() < 0.3 ? Math.floor(rc() * 4) : -1;
    for (const [c, ang] of lotBays) {
      bays.push([r1(c[0]), r1(c[1]), Math.round(ang * 1000) / 1000, street ? 3 : style]);
      if (rc() < occupancy) parked.push([r1(c[0]), r1(c[1]), Math.round((ang + (rc() < 0.85 ? 0 : Math.PI)) * 1000) / 1000, Math.floor(rc() * 1000)]);
      // canopies only over proper rows (a bay with a neighbour beside it, same orientation)
      const inRow = lotBays.some(([o, oa]) => o !== c && Math.hypot(o[0] - c[0], o[1] - c[1]) < 2.8 && Math.abs(Math.sin(oa - ang)) < 0.2 && Math.cos(oa - ang) > 0);
      if (shade >= 0 && inRow) canopies.push([r1(c[0]), r1(c[1]), Math.round(ang * 1000) / 1000, shade]);
    }
  }
  console.log(`  parking: ${lots.length} lots, ${bays.length} bays, ${canopies.length} shaded`);
}

// ---------------------------------------------------------------- street kit: Dubai Hills
// Kerbs, gutters and edge lines, footways, planted verges, dropped kerbs at the driveways and the estate's street
// lamps, from the research photographs (data-raw/research/dubai-hills/*/research.json 'streets'): ~7 m carriageways
// of light grey asphalt (Sidra 1/2, the Vistas, the estate roads) or grey interlocking pavers with a buff band at the
// kerb (Maple, Sidra 3); a yellow edge line along each kerb and no centre line; low light concrete kerbs; footways
// of grey pavers in the townhouse and villa communities, planted verges running straight to the walls of the
// mansions and the Vistas; driveway aprons in pavers to the dropped kerb; bronze L-arm lamp columns.
const kitKerbs = [], kitAprons = [], kitLamps = [];
{
  const hillsPolys = [];
  const HILLS = /^Dubai Hills( Estate)?$/i;
  for (const w of ways.values()) if (w.tags && isClosed(w) && HILLS.test(cleanName(w.tags) || '') && (w.tags.landuse === 'residential' || w.tags.boundary === 'administrative' || w.tags.place)) { const pl = wayPoly(w); if (pl) hillsPolys.push(pl); }
  for (const r of rels) if (r.tags && HILLS.test(cleanName(r.tags) || '')) for (const pl of relationPolys(r)) hillsPolys.push(pl);
  // every road within 150 m of a researched community belongs to the estate (its spine roads run between them)
  const areaBoxes = houseAreas.map((h) => { const bb = bboxOf(h.poly[0]); return { h, bb, near: [bb[0] - 150, bb[1] - 150, bb[2] + 150, bb[3] + 150] }; });
  const hillsBoxes = hillsPolys.map((pl) => ({ pl, bb: bboxOf(pl[0]) }));
  const inBB = (p, bb) => p[0] >= bb[0] && p[0] <= bb[2] && p[1] >= bb[1] && p[1] <= bb[3];
  // Emirates Hills by its outline (its box takes in parts of The Lakes and The Meadows): roads inside or within 60 m
  const nearPoly = (p, poly, d) => { if (pointInPoly(p, poly)) return true; for (const r of poly) for (let i = 0; i < r.length; i++) if (distToSegment(p, r[i], r[(i + 1) % r.length]) < d) return true; return false; };
  // (Jumeirah Islands by its boundary: every street inside it)
  const inJI = (p) => !!jiPoly && pointInPoly(p, jiPoly);
  const inHills = (p) => areaBoxes.some((a) => a.h.kit !== 'ji' && inBB(p, a.near) && (a.h.kit !== 'eh' || nearPoly(p, a.h.poly, 60))) || hillsBoxes.some((h) => inBB(p, h.bb) && pointInPoly(p, h.pl)) || inJI(p);
  const areaAt = (p) => { for (const a of areaBoxes) if (inBB(p, a.bb) && pointInPoly(p, a.h.poly)) return a.h; return null; };
  const KERBED = new Set(['residential', 'living_street', 'unclassified', 'road', 'service', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link']);
  const NO_KERB_SERVICE = new Set(['parking_aisle', 'driveway', 'drive-through']);
  const treated = roadWays.filter((r) => !r.bridge && KERBED.has(r.kind) && !(r.kind === 'service' && NO_KERB_SERVICE.has(r.t.service)) && (r.outs || []).some((o) => !o.b && o.p.some(inHills)));
  // ground-level pieces, merged end to end where a street simply continues (a fillet between the two halves of one
  // street would dent its kerb)
  const pieces = [];
  for (const r of treated) for (const o of r.outs) if (!o.b && o.p.length >= 2) pieces.push({ r, o, pts: o.p.map((q) => [q[0], q[1]]) });
  const key = (q) => q[0].toFixed(1) + ',' + q[1].toFixed(1);
  const atNode = new Map();
  pieces.forEach((pc, i) => { for (const end of [0, 1]) { const k = key(end ? pc.pts.at(-1) : pc.pts[0]); let a = atNode.get(k); if (!a) atNode.set(k, (a = [])); a.push([i, end]); } });
  const dirAt = (pc, end) => { const P = pc.pts, a = end ? P.at(-1) : P[0], b = end ? P[Math.max(0, P.length - 2)] : P[Math.min(P.length - 1, 1)]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const link = new Map(); // "i:end" -> [j, endJ]
  for (const list of atNode.values()) {
    const cands = [];
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const [i, ei] = list[x], [j, ej] = list[y]; if (i === j) continue;
      const A = pieces[i], B = pieces[j];
      if (Math.abs(A.r.width - B.r.width) > 0.6 || A.r.oneway !== B.r.oneway) continue;
      const da = dirAt(A, ei), db = dirAt(B, ej), straight = -(da[0] * db[0] + da[1] * db[1]); // 1 = straight on
      if (list.length > 2 && straight < Math.cos((30 * Math.PI) / 180)) continue;
      cands.push([straight, x, y]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    const taken = new Set();
    for (const [, x, y] of cands) {
      if (taken.has(x) || taken.has(y)) continue;
      taken.add(x); taken.add(y);
      const [i, ei] = list[x], [j, ej] = list[y];
      link.set(i + ':' + ei, [j, ej]); link.set(j + ':' + ej, [i, ei]);
    }
  }
  const usedPc = new Uint8Array(pieces.length);
  const chains = [];
  const RADIUS = (rank) => (rank <= 2 ? 4 : rank <= 4 ? 6 : 9);
  for (let i0 = 0; i0 < pieces.length; i0++) {
    if (usedPc[i0]) continue;
    // walk to one end of the chain, then collect forwards
    let i = i0, e = 0, guard = 0;
    while (guard++ < pieces.length) { const nx = link.get(i + ':' + e); if (!nx || usedPc[nx[0]] || nx[0] === i0) break; i = nx[0]; e = 1 - nx[1]; }
    // now leave piece i through its end (1 - e)
    const pts = [], members = [];
    let cur = i, entry = e;
    while (cur != null && !usedPc[cur]) {
      usedPc[cur] = 1; members.push(pieces[cur]);
      const P = entry === 0 ? pieces[cur].pts : pieces[cur].pts.slice().reverse();
      for (const q of pts.length ? P.slice(1) : P) pts.push(q);
      const nx = link.get(cur + ':' + (1 - entry));
      if (!nx) break;
      cur = nx[0]; entry = nx[1];
    }
    const r = members[0].r, mid = pts[Math.floor(pts.length / 2)], area = areaAt(mid);
    const surf = area && /^(Maple|Sidra (3|III))/i.test(area.name) ? 1 : 0;
    // Emirates Hills (landscape research): a dashed yellow centre line and no edge lines; tall grey columns on the
    // avenues and black post-top lamps on the residential streets; date palms along the lawn verges
    const ehs = area && area.kit === 'eh';
    // Jumeirah Islands (street photographs): grey asphalt with a dashed white centre line and no edge lines, low
    // pale kerbs, lawn and clipped hedges straight from the kerb (no footways), dark swan-neck lamps in the clusters
    // and tall plain columns along the spine road, date palms along the verges
    const jis = !ehs && ((area && area.kit === 'ji') || inJI(mid));
    chains.push({ pts, w: Math.max(...members.map((m) => m.r.width)), r: RADIUS(r.rank), rank: r.rank, oneway: r.oneway ? 1 : 0, surf, members,
      eh: ehs, ji: jis, edge: ehs || jis ? 0 : 1, lamp: ehs ? (r.rank >= 5 ? 2 : 3) : jis ? (r.rank >= 5 ? 2 : 4) : 1, verge: ehs || jis ? 1 : 0 });
  }
  // turning circles at the ends of cul-de-sacs
  for (const n of nodes.values()) {
    if (!n.tags || (n.tags.highway !== 'turning_circle' && n.tags.highway !== 'turning_loop')) continue;
    const pt = project(n.lat, n.lon); if (!inHills(pt)) continue;
    const near = chains.find((c) => c.pts.some((q) => Math.hypot(q[0] - pt[0], q[1] - pt[1]) < 3));
    if (near) chains.push({ pts: [pt, [pt[0] + 0.01, pt[1]]], w: 19, r: 5, rank: near.rank, oneway: 0, surf: near.surf, members: [] });
  }
  // every other ground-level carriageway near them stays as it is, and no kerb runs across it
  let cb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of chains) for (const q of c.pts) { cb = [Math.min(cb[0], q[0]), Math.min(cb[1], q[1]), Math.max(cb[2], q[0]), Math.max(cb[3], q[1])]; }
  const treatedSet = new Set(treated);
  const masks = [];
  for (const r of roadWays) {
    if (treatedSet.has(r) || r.bridge) continue;
    for (const o of r.outs || []) if (!o.b && o.p.some((q) => q[0] > cb[0] - 60 && q[0] < cb[2] + 60 && q[1] > cb[1] - 60 && q[1] < cb[3] + 60)) masks.push({ pts: o.p.map((q) => [q[0], q[1]]), w: o.w });
  }
  // footway width on the verge side of a kerb
  // Emirates Hills (landscape research): a strip of red pavers along every kerb, then lawn verges
  const FOOTWAY = { sidra: 1.5, maple: 1.5, 'club-villas': 1.5, 'golf-grove': 1.5, 'golf-place': 1.5, luxury: 0, mansion: 0, custom: 0, eh: 1.0, ji: 0 };
  // (Emirates Hills: the red paver strip runs along the avenues and their medians; the quiet residential streets have
  // lawn verges straight from the kerb)
  const sideAt = (p) => { const a = areaAt(p); return a ? [FOOTWAY[a.kit] ?? 1.5, a.kit === 'eh' ? 1 : 0, a.kit === 'eh' ? 5 : 0] : inJI(p) ? [0, 0, 0] : null; };
  // footways and paths mapped on their own
  const pgrid = new Grid(20);
  for (const pth of pathsOut) if (pth.k !== 'breakwater' && pth.p.length > 1) for (let i = 1; i < pth.p.length; i++) { const a = pth.p[i - 1], b = pth.p[i]; pgrid.insert([Math.min(a[0], b[0]) - 3, Math.min(a[1], b[1]) - 3, Math.max(a[0], b[0]) + 3, Math.max(a[1], b[1]) + 3], { a, b, hw: pth.w / 2 }); }
  const pathAt = (p) => pgrid.query(p[0], p[1]).some((sg) => distToSegment(p, sg.a, sg.b) < sg.hw + 0.3);
  // the driveways of the plots in the estate
  const drives = [];
  for (const pl of plots) {
    if (!pl.drive || !pl.b || !pl.b.hk) continue;
    const d = pl.drive; if (!d.every(Number.isFinite)) continue; // a villa with no street in reach
    if (pl.k === 'maple') {
      // Maple paves a band across the row of carports: run it to the street as one wide apron
      const f = pl.b.front; if (!f) continue;
      const fl = Math.hypot(f[0], f[1]) || 1, fx = f[0] / fl, fy = f[1] / fl, cx = (d[0] + d[2]) / 2, cy = (d[1] + d[3]) / 2, hd = d[4] / 2;
      drives.push({ a: [cx - fx * hd, cy - fy * hd], b: [cx + fx * hd, cy + fy * hd], w: Math.hypot(d[2] - d[0], d[3] - d[1]), pl, tone: 1 });
    } else {
      // apron pavers: grey-beige at Maple, grey or sand at Sidra (both in the photographs), sand elsewhere
      const tone = pl.k === 'sidra' ? ((Math.round(d[0] * 7 + d[1] * 13) & 1) ? 1 : 0) : 0;
      drives.push({ a: [d[0], d[1]], b: [d[2], d[3]], w: d[4], pl, tone });
    }
  }
  const t0 = Date.now();
  const out = streetKit({ chains, masks, sideAt, pathAt, drives, log: (m) => console.log('  ' + m) });
  for (const k of out.kerbs) kitKerbs.push(k);
  for (const a of out.aprons) kitAprons.push(a.map(r1));
  for (const l of out.lamps) if (inBox(l, -2) && !isWater(l) && !buildingAt(l)) kitLamps.push([r1(l[0]), r1(l[1]), Math.round(l[2] * 1000) / 1000, l[3]]);
  // the carriageways the kit owns: their ribbons draw the surface only (the kerb strips carry the edge lines)
  for (const c of chains) for (const m of c.members) { m.o.s = c.surf ? 2 : c.eh && !c.oneway ? 3 : c.ji && !c.oneway ? 4 : 1; m.r.kerbed = true; }
  for (const q of out.verge) addTree(q, 0, 1.0 + ((Math.round(q[0] * 7 + q[1] * 3) & 7) / 30), { minDist: 4 });
  console.log(`  street kit (Dubai Hills): ${chains.length} streets, ${masks.length} masked carriageways, ${kitKerbs.length} kerb pieces (${kitKerbs.reduce((n, k) => n + k.p.length, 0)} points), ${kitAprons.length} driveway aprons, ${kitLamps.length} lamps, ${Date.now() - t0} ms`);
}

// ---------------------------------------------------------------- crosswalks
// Zebra stripes only where OpenStreetMap maps a pedestrian crossing on the road (highway=crossing nodes that are
// not tagged unmarked), square across the carriageway at that node. Nothing is generated at junctions.
const xwalks = [];
{
  const seen = new Set();
  const UNMARKED = new Set(['no', 'unmarked', 'informal']);
  const EXPLICIT = new Set(['marked', 'zebra', 'traffic_signals']);
  for (const r of roadWays) {
    if (r.bridge || r.rank > 8 || r.kind === 'motorway_link' || r.kind === 'trunk_link' || (r.kerbed && r.rank <= 4)) continue;
    const ids = r.w.nodes, prof = lineXYZ(r.el), eids = r.el.ids || ids;
    for (let i = 0; i < ids.length; i++) {
      const nd = nodes.get(ids[i]); if (!nd || !nd.tags || nd.tags.highway !== 'crossing' || seen.has(ids[i])) continue;
      const kind = nd.tags.crossing || nd.tags['crossing:markings'] || '';
      if (UNMARKED.has(kind) || nd.tags['crossing:markings'] === 'no') continue;
      if (r.kind === 'service' && !EXPLICIT.has(kind)) continue;
      const q = nodeXY(ids[i]); if (!q || !inBox(q, -4)) continue;
      const ei = eids.indexOf(ids[i]);
      if (ei >= 0 && prof[ei] && (prof[ei][2] || 0) > 0.4) continue; // on a ramp or a deck
      const a = nodeXY(ids[Math.max(0, i - 1)]), b = nodeXY(ids[Math.min(ids.length - 1, i + 1)]);
      if (!a || !b) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1]; if (Math.hypot(dx, dy) < 0.5) continue;
      seen.add(ids[i]);
      xwalks.push([r1(q[0]), r1(q[1]), Math.round(Math.atan2(dy, dx) * 1000) / 1000, r1(r.width)]);
    }
  }
}

// ---------------------------------------------------------------- street lamps
const lamps = [];
{
  for (const r of roadWays) {
    if (r.bridge || r.rank < 5 || r.kerbed) continue;
    // lamps stand on the ground: leave out ramps that climb onto flyovers
    const pts = lineXYZ(r.el); let acc = 17;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b2 = pts[i]; const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]); if (L < 0.5) continue;
      if (a[2] > 0.3 || b2[2] > 0.3) { acc = ((acc - L) % 34 + 34) % 34; continue; }
      const ux = (b2[0] - a[0]) / L, uy = (b2[1] - a[1]) / L, nx = -uy, ny = ux;
      for (let s = acc; s < L; s += 34) {
        const p = [a[0] + ux * s, a[1] + uy * s];
        for (const side of r.oneway ? [-1] : [1, -1]) {
          const q = [p[0] + nx * side * (r.width / 2 + 1.0), p[1] + ny * side * (r.width / 2 + 1.0)];
          if (!inBox(q, -2) || isWater(q) || buildingAt(q)) continue;
          lamps.push([r1(q[0]), r1(q[1]), Math.round(Math.atan2(-ny * side, -nx * side) * 1000) / 1000]);
        }
      }
      acc = ((acc - L) % 34 + 34) % 34;
    }
  }
}

for (const l of kitLamps) lamps.push(l);

// ---------------------------------------------------------------- life on the courses and estates
// Golfers on some greens and tees and walking some holes, their buggies beside them or out on the buggy paths
// (OSM golf=green/tee/hole and the cart paths); gardeners at work in some Emirates Hills gardens; guards at the
// community's lift gates. figures: [x, y, angle, kind] (0 golfer, 1 gardener, 2 guard); buggies: [x, y, angle].
const figures = [], buggies = [];
{
  const rl = rng(4242);
  const greens = [], tees = [], holes = [], carts = [];
  for (const w of ways.values()) {
    const t = w.tags; if (!t || !w.nodes || w.nodes.length < 2) continue;
    if ((t.golf === 'green' || t.golf === 'tee') && isClosed(w)) { const pl = wayPoly(w); if (pl && inBox(centroid(pl[0]), -5)) (t.golf === 'green' ? greens : tees).push(pl[0]); }
    else if (t.golf === 'hole') holes.push(wayPts(w));
    else if (t.golf === 'cartpath' || (t.highway === 'path' && /buggy|cart/i.test(t.name || '')) || (t.highway === 'service' && t.golf === 'path')) carts.push(wayPts(w));
  }
  const cartPts = []; for (const c of carts) for (let i = 1; i < c.length; i++) { const a = c[i - 1], b = c[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let s = 0; s < L; s += 6) cartPts.push([a[0] + (b[0] - a[0]) * s / L, a[1] + (b[1] - a[1]) * s / L, Math.atan2(b[1] - a[1], b[0] - a[0])]); }
  const cg = new Grid(40); cartPts.forEach((q) => cg.insert([q[0], q[1], q[0], q[1]], q));
  const nearCart = (p, d) => { let best = null, bd = d; for (const dx of [-40, 0, 40]) for (const dy of [-40, 0, 40]) for (const q of cg.query(p[0] + dx, p[1] + dy)) { const e = Math.hypot(q[0] - p[0], q[1] - p[1]); if (e < bd) { bd = e; best = q; } } return best; };
  const group = (c, n, spread, face) => { for (let k = 0; k < n; k++) { const a = rl() * Math.PI * 2, r = spread * (0.3 + 0.7 * rl()); const q = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]; figures.push([r1(q[0]), r1(q[1]), Math.round((face != null ? face + (rl() - 0.5) * 0.8 : Math.atan2(c[1] - q[1], c[0] - q[0])) * 1000) / 1000, 0]); } };
  // a buggy on the nearest cart path, or parked on the fringe beside the group where none is mapped
  const parkBuggy = (p, d) => {
    const q = nearCart(p, d);
    if (q) { buggies.push([r1(q[0]), r1(q[1]), Math.round(q[2] * 1000) / 1000]); return; }
    const a = rl() * Math.PI * 2, b = [p[0] + Math.cos(a) * 9, p[1] + Math.sin(a) * 9];
    if (!isWater(b) && !buildingAt(b)) buggies.push([r1(b[0]), r1(b[1]), Math.round((a + Math.PI / 2) * 1000) / 1000]);
  };
  for (const g of greens) {
    if (rl() > 0.5) continue;
    const c = centroid(g); group(c, 2 + Math.floor(rl() * 3), 4.5, null); parkBuggy(c, 40);
  }
  for (const t of tees) {
    if (rl() > 0.3) continue;
    const c = centroid(t);
    const h = holes.find((L) => Math.hypot(L[0][0] - c[0], L[0][1] - c[1]) < 25);
    const face = h && h.length > 1 ? Math.atan2(h[1][1] - h[0][1], h[1][0] - h[0][0]) : rl() * Math.PI * 2;
    group(c, 2 + Math.floor(rl() * 2), 2.5, face); parkBuggy(c, 35);
  }
  for (const h of holes) {
    if (rl() > 0.3 || h.length < 2) continue;
    const L = polylineLength(h); let t = L * (0.35 + rl() * 0.4);
    for (let i = 1; i < h.length; i++) { const a = h[i - 1], b = h[i], sl = Math.hypot(b[0] - a[0], b[1] - a[1]); if (t > sl) { t -= sl; continue; }
      const q = [a[0] + (b[0] - a[0]) * t / sl, a[1] + (b[1] - a[1]) * t / sl]; group(q, 2 + Math.floor(rl() * 3), 3, Math.atan2(b[1] - a[1], b[0] - a[0])); parkBuggy(q, 45); break; }
  }
  // buggies out on the paths between holes
  for (let i = 0; i < cartPts.length; i += 40) if (rl() < 0.35) { const q = cartPts[i]; buggies.push([r1(q[0]), r1(q[1]), Math.round(q[2] * 1000) / 1000]); }
  // gardeners in some Emirates Hills gardens
  for (const pl of plots) {
    if (pl.k !== 'eh' || rl() > 0.3) continue;
    const ring = pl.p, bb = bboxOf(ring), house = pl.b.polys[0][0];
    for (let k = 0; k < 20; k++) {
      const q = [bb[0] + rl() * (bb[2] - bb[0]), bb[1] + rl() * (bb[3] - bb[1])];
      if (!pointInRing(q, ring) || pointInRing(q, house) || (pl.pool && Math.hypot(q[0] - pl.pool[0], q[1] - pl.pool[1]) < pl.pool[3] / 2 + 1.5)) continue;
      figures.push([r1(q[0]), r1(q[1]), Math.round(rl() * 6283) / 1000, 1]); break;
    }
  }
  // guards at the Emirates Hills gates
  const eh = houseAreas.find((h) => h.kit === 'eh');
  if (eh) for (const n of nodes.values()) {
    if (!n.tags || (n.tags.barrier !== 'lift_gate' && n.tags.barrier !== 'gate')) continue;
    const q = project(n.lat, n.lon); if (!pointInPoly(q, eh.poly)) continue;
    const a = rl() * Math.PI * 2;
    figures.push([r1(q[0] + Math.cos(a) * 3.2), r1(q[1] + Math.sin(a) * 3.2), Math.round((a + Math.PI) * 1000) / 1000, 2]);
  }
  console.log(`  life: ${figures.filter((f) => f[3] === 0).length} golfers, ${buggies.length} buggies, ${figures.filter((f) => f[3] === 1).length} gardeners, ${figures.filter((f) => f[3] === 2).length} guards (${greens.length} greens, ${tees.length} tees, ${holes.length} holes, ${carts.length} cart paths)`);
}

// ---------------------------------------------------------------- beach umbrellas (rows parallel to the water)
const umbrellas = [];
{
  const ru = rng(2024);
  const coastSegs = new Grid(60);
  for (const r of coastResult.land) for (let i = 0; i < r.length; i++) {
    const a = r[i], b2 = r[(i + 1) % r.length];
    const onEdge = (p) => Math.abs(p[0] - R.x0) < 1 || Math.abs(p[0] - R.x1) < 1 || Math.abs(p[1] - R.y0) < 1 || Math.abs(p[1] - R.y1) < 1;
    if (onEdge(a) && onEdge(b2)) continue;
    coastSegs.insert([Math.min(a[0], b2[0]) - 50, Math.min(a[1], b2[1]) - 50, Math.max(a[0], b2[0]) + 50, Math.max(a[1], b2[1]) + 50], [a, b2]);
  }
  for (const poly of areas.beach || []) {
    if (beachClass.get(poly) === 'villa') continue; // the Palm's frond beaches are private gardens
    const bb = bboxOf(poly[0]);
    for (let y = bb[1]; y < bb[3]; y += 6.5) for (let x = bb[0] + ((Math.round(y / 6.5) % 2) * 3.5); x < bb[2]; x += 7) {
      const p = [x, y]; if (!pointInPoly(p, poly)) continue;
      let d = Infinity; for (const [a, b2] of coastSegs.query(x, y)) d = Math.min(d, distToSegment(p, a, b2));
      if (d < 13 || d > 44 || ru() < 0.18 || amenAt(p)) continue;
      umbrellas.push([r1(x + (ru() - 0.5)), r1(y + (ru() - 0.5)), Math.floor(ru() * 1000)]);
    }
  }
}
console.log(`  villas ${buildings.filter((b) => b.villa).length}, plots ${plots.length} (pools ${plots.filter((p) => p.pool).length}), parked ${parked.length}, crosswalks ${xwalks.length}, lamps ${lamps.length}, umbrellas ${umbrellas.length}`);

// ---------------------------------------------------------------- metro stations & elevated footbridges
const stations = [], footbridges = [], tramStops = [], monoStops = [];
{
  const sp = new URL('../data-raw/stations.json', import.meta.url);
  if (existsSync(sp)) {
    const sraw = JSON.parse(readFileSync(sp, 'utf8'));
    const snodes = new Map(); for (const e of sraw.elements) if (e.type === 'node') snodes.set(e.id, e);
    for (const e of sraw.elements) {
      const t = e.tags; if (!t) continue;
      if (e.type === 'node' && t.railway === 'station' && t.station !== 'monorail') {
        const p = project(e.lat, e.lon); if (!inBox(p, -20)) continue;
        // only Red Line stations sit on the metro viaduct
        const metro = railsOut.filter((r) => r.k === 'metro');
        let best = Infinity; for (const r of metro) for (let i = 1; i < r.p.length; i++) best = Math.min(best, distToSegment(p, r.p[i - 1], r.p[i]));
        if (best < 60) stations.push({ n: t['name:en'] || t.name, x: r1(p[0]), y: r1(p[1]) });
      }
      if (e.type === 'node' && (t.station === 'monorail' || t.monorail === 'yes') && (t.railway === 'station' || t.public_transport === 'station' || t.railway === 'stop')) {
        const p = project(e.lat, e.lon);
        if (inBox(p, -10) && !monoStops.some((q) => Math.hypot(q.x - p[0], q.y - p[1]) < 40)) monoStops.push({ n: t['name:en'] || t.name || '', x: r1(p[0]), y: r1(p[1]) });
      }
      if (e.type === 'node' && t.railway === 'tram_stop') {
        const p = project(e.lat, e.lon);
        if (inBox(p, -10) && !tramStops.some((q) => Math.hypot(q.x - p[0], q.y - p[1]) < 25)) tramStops.push({ n: t['name:en'] || t.name || '', x: r1(p[0]), y: r1(p[1]) });
      }
      if (e.type === 'way' && t.highway === 'footway' && t.bridge === 'yes' && e.nodes) {
        const pts = e.nodes.map((id) => snodes.get(id)).filter(Boolean).map((n) => project(n.lat, n.lon));
        if (pts.length < 2 || !pts.some((p) => inBox(p))) continue;
        const L = polylineLength(pts); if (L < 12) continue;
        // (a walk across a mapped deck, such as the Souk Al Bahar bridge, is part of that deck, not a skybridge over it)
        if (pts.slice(1).some((p, i) => { const mid = [(p[0] + pts[i][0]) / 2, (p[1] + pts[i][1]) / 2]; return pierAreas.some((pl) => pointInPoly(mid, pl)); })) continue;
        footbridges.push({ l: Math.max(1, Math.min(3, parseLen(t.layer) || 1)), c: t.covered === 'yes' || t.tunnel === 'yes' ? 1 : 0, p: pts.map(rp) });
      }
    }
  }
  console.log(`  metro stations ${stations.length} (${stations.map((s) => s.n).join(', ')}), footbridges ${footbridges.length}, tram stops ${tramStops.length}, monorail stops ${monoStops.length} (${monoStops.map((s) => s.n).join(', ')})`);
}

// ---------------------------------------------------------------- labels
const districts = [];
for (const w of ways.values()) {
  if (!w.tags || !w.tags.place || !['suburb', 'neighbourhood', 'quarter', 'islet', 'island'].includes(w.tags.place)) continue;
  const n = cleanName(w.tags); if (!n || isArabic(n)) continue;
  const pts = openRing(wayPts(w)); if (pts.length < 3) continue;
  const c = centroid(pts); if (!inBox(c, -50)) continue;
  districts.push({ n, x: r1(c[0]), y: r1(c[1]), k: w.tags.place, a: Math.round(Math.abs(signedArea(pts))), p: rRing(simplifyRing(pts, 2)) });
}
for (const r of rels) {
  if (!r.tags || !r.tags.place || !['suburb', 'neighbourhood', 'quarter'].includes(r.tags.place)) continue;
  const n = cleanName(r.tags); if (!n || isArabic(n)) continue;
  const polys = relationPolys(r); if (!polys.length) continue;
  const c = centroid(polys[0][0]); if (!inBox(c, -50)) continue;
  districts.push({ n, x: r1(c[0]), y: r1(c[1]), k: r.tags.place, a: Math.round(Math.abs(signedArea(polys[0][0]))), p: rRing(simplifyRing(polys[0][0], 2)) });
}
// Dubai's numbered communities (Al Barsha 1-3, Umm Suqeim 1-3...) are often mapped as named residential land
// or as admin boundaries rather than places: keep those too (only these names, to avoid every compound)
{
  const COMMUNITY = /^(Al Barsha( South)? ?\d?|Umm Suqeim ?\d?|Al Q[ou]{2}z( Industrial Area)? ?\d?|Al Safa ?\d?|Al Manara|Jumeirah ?\d|Al Sufouh ?\d?|Madinat Jumeirah|Al Wasl|Dubai Hills( Estate)?|Business Bay|Al Habtoor City|Al Khail Gate( Residential)?|Downtown Dubai|Burj Khalifa|DIFC|Dubai International Financial Cent(er|re)|Trade Cent(er|re) ?\d?|Al Satwa|Za'?abeel ?\d?|Al Bada'?a|La Mer|City Walk|Meydan( City)?|Nad Al Sheba ?\d?|Dubai Design District|Al Kifaf)$/i;
  const have = new Set(districts.map((d) => d.n.toLowerCase()));
  const take = (n, kind, poly) => {
    if (!n || isArabic(n) || !COMMUNITY.test(n) || have.has(n.toLowerCase())) return;
    const c = centroid(poly[0]); if (!inBox(c, -50)) return;
    have.add(n.toLowerCase());
    districts.push({ n, x: r1(c[0]), y: r1(c[1]), k: kind, a: Math.round(Math.abs(signedArea(poly[0]))), p: rRing(simplifyRing(poly[0], 2)) });
  };
  for (const w of ways.values()) {
    if (!w.tags || !isClosed(w) || !(w.tags.landuse === 'residential' || w.tags.boundary === 'administrative')) continue;
    const p = wayPoly(w); if (p) take(cleanName(w.tags), 'community', p);
  }
  for (const r of rels) {
    if (!r.tags || !(r.tags.landuse === 'residential' || r.tags.boundary === 'administrative')) continue;
    const polys = relationPolys(r); if (polys.length) take(cleanName(r.tags), 'community', polys[0]);
  }
}

// ---------------------------------------------------------------- output buildings
const outB = [];
for (const b of buildings) {
  if (b.skip) continue;
  const t = b.tags;
  const o = {
    i: outB.length,
    h: r1(b.h), p: b.polys[0].map(rRing),
  };
  if (b.mh) o.mh = r1(b.mh);
  if (b.lv) o.lv = b.lv;
  if (b.est) o.e = 1;
  // unnamed outlines inherit name/year from their tallest named part (e.g. Marina 101)
  const namedPart = !cleanName(t) && b.parts.length ? b.parts.filter((pt) => cleanName(pt.tags)).sort((a, z) => z.h - a.h)[0] : null;
  const n = NAME_FIX[b.osm] || cleanName(t) || (namedPart ? cleanName(namedPart.tags) : ''); if (n) o.n = n;
  if (namedPart && !yearOf(t) && yearOf(namedPart.tags)) o.y = yearOf(namedPart.tags);
  if (t.name && t['name:en'] && t.name !== t['name:en']) o.na = t.name;
  const ty = t.building || t['building:part']; if (ty && ty !== 'yes') o.t = ty;
  // a mosque mapped as a plain building with the place of worship on it is still a mosque
  if (t.amenity === 'place_of_worship' && (t.religion === 'muslim' || /mosque|masjid|مسجد/i.test(t.name || '')) && !t['building:part']) o.t = 'mosque';
  const col = t['building:colour'] || t['building:facade:colour'];
  if (col && !/^#?a0a0a0$/i.test(col)) o.c = col;
  const rc = t['roof:colour']; if (rc && !/^#?a0a0a0$/i.test(rc)) o.rc = rc;
  const mat = t['building:material'] || t['building:facade:material']; if (mat && !(o.c == null && mat === 'concrete' && /a0a0a0/i.test(t['building:facade:colour'] || ''))) o.m = mat;
  const y = yearOf(t); if (y) o.y = y;
  if (t.wikidata) o.wd = t.wikidata;
  if (b.district && b.district !== 'other') o.d = b.district;
  if (b.vstyle) o.v = b.vstyle;
  if (b.hk) {
    o.hk = b.hk; o.hs = b.hs;
    if (b.front) o.hf = Math.round(Math.atan2(b.front[1], b.front[0]) * 1000) / 1000;
    if (b.ht) o.ht = b.ht;
    if (b.hm) o.hm = b.hm;
  }
  b.outIndex = o.i;
  if (b.ml) o.ml = 1;
  if (b.polys.length > 1) o.x = b.polys.slice(1).map((p) => p.map(rRing));
  if (b.parts.length) {
    o.oh = r1(b.h); // the outline's own height (podium reconstruction when parts don't cover it)
    o.parts = b.parts.map((pt) => {
      const q = { h: r1(pt.h), p: pt.polys[0].map(rRing) };
      if (pt.mh) q.mh = r1(pt.mh);
      const pc = pt.tags['building:colour']; if (pc && !/^#?a0a0a0$/i.test(pc)) q.c = pc;
      if (pt.tags['roof:shape'] && pt.tags['roof:shape'] !== 'flat') q.rs = pt.tags['roof:shape'];
      if (pt.lv) q.lv = pt.lv;
      return q;
    });
    o.h = r1(Math.max(o.h, ...b.parts.map((pt) => pt.h)));
    const plv = Math.max(0, ...b.parts.map((pt) => pt.lv || 0));
    if (plv > (o.lv || 0)) o.lv = plv;
    if (o.lv && o.lv * 2.6 < o.h * 0.5) o.lv = Math.round(o.h / 3.6); // outline levels describe a podium only
  }
  if (t['roof:shape'] && t['roof:shape'] !== 'flat') o.rs = t['roof:shape'];
  outB.push(o);
}

// ---------------------------------------------------------------- output: a world file + one file per section
// world.json: everything global (coast, areas, roads + traffic graph, rail, districts, berths, car parks) plus a
//   light record of every building (simplified footprint, height, style), so the whole city can be drawn,
//   searched and filtered at once.
// sections/<id>.json: the detail (full buildings, trees, villa plots, parking, street furniture, amenities and
//   walkways), streamed in near the camera. Buildings are ordered section by section, so each section owns a
//   contiguous range of global building ids.
const secRects = BUILT.map((s) => ({ id: s.id, rects: s.rects.map((q) => { const a = project(q.s, q.w), b = project(q.n, q.e); return [a[0], a[1], b[0], b[1]]; }) }));
const secOf = (p) => {
  for (const s of secRects) for (const r of s.rects) if (p[0] >= r[0] && p[0] < r[2] && p[1] >= r[1] && p[1] < r[3]) return s.id;
  let best = secRects[0].id, bd = Infinity; // just outside every rectangle (clipping margins): the nearest one
  for (const s of secRects) for (const r of s.rects) {
    const dx = Math.max(r[0] - p[0], 0, p[0] - r[2]), dy = Math.max(r[1] - p[1], 0, p[1] - r[3]);
    if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = s.id; }
  }
  return best;
};
const midOf = (pts) => pts[Math.floor(pts.length / 2)];
const SEC = Object.fromEntries(BUILT.map((s) => [s.id, {
  buildings: [], trees: [], plots: [], parked: [], bays: [], canopies: [], xwalks: [], lamps: [], umbrellas: [], paths: [], bikeLanes: [], kerbs: [], aprons: [], figures: [], buggies: [],
  amenities: Object.fromEntries(Object.keys(amen).map((k) => [k, []])),
}]));
// buildings, grouped by section (global id = section offset + local index)
const bSec = outB.map((b) => secOf(centroid(b.p[0])));
const localIdx = new Int32Array(outB.length);
outB.forEach((b, i) => { const L = SEC[bSec[i]].buildings; localIdx[i] = L.length; L.push(b); });
const offsets = {}; { let o = 0; for (const s of BUILT) { offsets[s.id] = o; o += SEC[s.id].buildings.length; } }
// light records for the whole-city view: outlines simplified to 1 m (no courtyards), tower parts kept so
// podiums and stepped towers keep their shape; hand-modelled landmarks keep their full record
const liteRing = (r) => rRing(simplifyRing(r, 1.0));
const liteB = [];
for (const s of BUILT) for (const b of SEC[s.id].buildings) {
  if (LANDMARK_NAMES.has(b.n)) { liteB.push(b); continue; }
  const o = { ...b, p: [liteRing(b.p[0])] };
  if (b.parts) o.parts = b.parts.map((pt) => ({ ...pt, p: [liteRing(pt.p[0])] }));
  if (b.x) o.x = b.x.map((x) => [liteRing(x[0])]);
  liteB.push(o);
}
for (const p of plots) {
  if (p.b.outIndex == null) continue;
  const sid = bSec[p.b.outIndex];
  const o = { b: localIdx[p.b.outIndex], p: p.p };
  if (p.pool) o.pool = p.pool;
  if (p.drive) o.dr = p.drive;
  if (p.k) o.k = p.k;
  if (p.fc) o.fc = p.fc;
  if (p.ov || p.mr) { if (p.ov) o.ov = p.ov; if (p.mr) o.mr = p.mr; if (signedArea(p.p) < 0) o.p = p.p.slice().reverse(); }
  SEC[sid].plots.push(o);
}
// Trees keep clear of what stands or runs beside them. Crown radius by species and size: a crown may not reach
// into a building (the tree is shown smaller, as a shrub, or left out), no trunk stands on or right beside a
// carriageway or inside a junction, and nothing grows up through a flyover.
{
  const CROWN = [3.4, 3.1, 2.0, 1.1, 1.5, 4.6, 3.2, 3.2, 3.2, 1.7, 2.0];
  const PALM = new Set([0, 2]);
  const distToBuilding = (pt, lim) => {
    let best = lim; const seenB = new Set();
    for (const ox of [-lim, 0, lim]) for (const oy of [-lim, 0, lim]) for (const b of bGrid.query(pt[0] + ox, pt[1] + oy)) {
      if (b.skip || seenB.has(b)) continue; seenB.add(b);
      const ring = b.polys[0][0];
      if (pointInPoly(pt, b.polys[0])) return 0;
      for (let i = 0; i < ring.length; i++) { const d = distToSegment(pt, ring[i], ring[(i + 1) % ring.length]); if (d < best) best = d; }
    }
    return best;
  };
  // junctions of real streets, and elevated decks
  const deg = gNodes.map(() => ({ n: 0, w: 0 }));
  for (const e of gEdges) { if (e.r.rank < 4) continue; for (const k of e.a === e.b ? [e.a] : [e.a, e.b]) { deg[k].n++; deg[k].w = Math.max(deg[k].w, e.r.width); } }
  const jGrid = new Grid(60);
  gNodes.forEach((q, i) => { if (deg[i].n >= 3 && (q[2] || 0) < 0.5) { const R = deg[i].w / 2 + 4; jGrid.insert([q[0] - R, q[1] - R, q[0] + R, q[1] + R], [q[0], q[1], R]); } });
  const dGrid = new Grid(60);
  for (const o of roadsOut) {
    if (!o.b) continue;
    for (let i = 1; i < o.p.length; i++) {
      const a = o.p[i - 1], b = o.p[i]; if (Math.max(a[2] || 0, b[2] || 0) < 2.5) continue;
      const m = o.w / 2 + 5;
      dGrid.insert([Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m], { a, b, hw: o.w / 2 });
    }
  }
  let dropped = 0, shrunk = 0, shrubbed = 0;
  const kept = [];
  for (const t of trees) {
    if (t[2] > 0) { kept.push(t); continue; } // roof and podium gardens were placed on their decks
    const pt = [t[0], t[1]], R = CROWN[t[3]] * t[4];
    if (onRoad(pt, 0.9)) { dropped++; continue; }
    if (jGrid.query(pt[0], pt[1]).some((q) => Math.hypot(q[0] - pt[0], q[1] - pt[1]) < q[2])) { dropped++; continue; }
    if (dGrid.query(pt[0], pt[1]).some((sg) => distToSegment(pt, sg.a, sg.b) < sg.hw + R * 0.6)) { dropped++; continue; }
    const dB = distToBuilding(pt, 6);
    if (PALM.has(t[3])) { if (dB < 2.3) { dropped++; continue; } kept.push(t); continue; }
    if (t[3] === 3 || t[3] === 4) { if (dB < 0.4) { dropped++; continue; } kept.push(t); continue; } // shrubs may hug a wall
    if (dB < 1.2) { dropped++; continue; }
    const need = R * 0.85 + 0.3;
    if (dB < need) {
      const k = (dB - 0.3) / (R * 0.85);
      if (k < 0.55) { if (dB < 1.5) { dropped++; continue; } t[3] = 3; t[4] = Math.round(Math.min(1.1, (dB - 0.3) / 1.1) * 100) / 100; shrubbed++; }
      else { t[4] = Math.round(t[4] * k * 100) / 100; shrunk++; }
    }
    kept.push(t);
  }
  trees.length = 0; for (const t of kept) trees.push(t);
  console.log(`  trees kept clear: ${dropped} removed (roads, junctions, flyovers, walls), ${shrunk} shown smaller, ${shrubbed} as shrubs; ${trees.length} left`);
}
for (const t of trees) SEC[secOf(t)].trees.push(t);
for (const k of ['parked', 'bays', 'canopies', 'xwalks', 'lamps', 'umbrellas', 'figures', 'buggies']) for (const q of eval(k)) SEC[secOf(q)][k].push(q);
const worldPaths = [];
for (const pth of pathsOut) { if (pth.k === 'breakwater') worldPaths.push(pth); else SEC[secOf(midOf(pth.p))].paths.push(pth); }
for (const l of bikeLanes) SEC[secOf(midOf(l.p))].bikeLanes.push(l);
for (const k of kitKerbs) SEC[secOf(midOf(k.p))].kerbs.push(k);
for (const a of kitAprons) SEC[secOf(a)].aprons.push(a);
for (const [k, list] of Object.entries(amen)) for (const q of list) {
  const at = Array.isArray(q) ? (Array.isArray(q[0]) ? q[0] : q) : q.c || (q.p && (Array.isArray(q.p[0][0]) ? q.p[0][0] : q.p[0])) || [0, 0];
  SEC[secOf(at)].amenities[k].push(q);
}

const meta = {
  lat0, lon0, mlat: MLAT, mlon: MLON,
  bounds: [r1(R.x0), r1(R.y0), r1(R.x1), r1(R.y1)],
  bbox: BBOX,
  sections: BUILT.map((s) => ({
    id: s.id, name: s.name, areas: s.areas, file: `data/sections/${s.id}.json`,
    rects: secRects.find((q) => q.id === s.id).rects.map((r) => r.map(r1)),
    b0: offsets[s.id], bn: SEC[s.id].buildings.length, trees: SEC[s.id].trees.length,
  })),
  attribution: '© OpenStreetMap contributors (ODbL); Microsoft ML Buildings via Overture Maps (ODbL)' + (ndviMeta ? '; Contains modified Copernicus Sentinel data 2026' : ''),
  ndvi: ndviMeta ? { src: 'data/ndvi.png', scene: ndviMeta.scene, date: ndviMeta.date, w: ndviMeta.w, h: ndviMeta.h, res: ndviMeta.res, x0: r1(ndviMeta.x0), y1: r1(ndviMeta.y1) } : null,
  generated: new Date().toISOString(),
};
const world = {
  meta,
  land: landOut,
  areas: areasOut,
  pools: poolsOut,
  piers: piersOut,
  paths: worldPaths, // breakwaters (the shore needs them everywhere)
  roads: roadsOut,
  graph: graphOut,
  rails: railsOut,
  buildings: liteB,
  boats,
  districts,
  landmarks,
  lots,
  stations,
  footbridges,
  tramStops,
  monoStops,
  // JLT: paved district ground and the promenades ringing its lakes
  zones: { jlt: DP.jlt.map((p) => clipPoly(p)).filter(Boolean).map((p) => p.map(rRing)) },
  burjWalk,
  burjLake,
  lakeWalks: (areas.water || []).filter((p) => inPolys(centroid(p[0]), DP.jlt)).map((p) => clipPoly(p, 0.3)).filter(Boolean).map((p) => p.map(rRing)),
  viaducts: viaductsOut,
  viaPiers: viaPiersOut,
};
mkdirSync(new URL('../public/data/sections/', import.meta.url), { recursive: true });
const json = JSON.stringify(world);
writeFileSync(new URL('../public/data/world.json', import.meta.url), json);
const secSizes = [];
for (const s of BUILT) {
  const txt = JSON.stringify(SEC[s.id]);
  writeFileSync(new URL(`../public/data/sections/${s.id}.json`, import.meta.url), txt);
  secSizes.push(`${s.id} ${(txt.length / 1e6).toFixed(1)} MB (${SEC[s.id].buildings.length} buildings, ${SEC[s.id].trees.length} trees)`);
}
if (existsSync(new URL('../public/data/map.json', import.meta.url))) unlinkSync(new URL('../public/data/map.json', import.meta.url));

// names list (for curation)
const names = outB.filter((b) => b.n && b.h >= 60).sort((a, b) => b.h - a.h).map((b) => `${b.n}\t${b.h}\t${b.lv || ''}\t${b.y || ''}`);
writeFileSync(new URL('../data-raw/tower-names.tsv', import.meta.url), names.join('\n'));

console.log(`buildings ${outB.length} (ml ${mlAdded}, orphan parts ${orphanParts}, outside ${skippedOutside}), with parts ${outB.filter((b) => b.parts).length}`);
console.log(`roads ${roadsOut.length}, paths ${pathsOut.length}, graph nodes ${gNodes.length} edges ${gEdges.length}, rails ${railsOut.length}`);
console.log(`areas: ${Object.entries(areasOut).map(([k, v]) => `${k}:${v.length}`).join(' ')}`);
console.log(`land ${landOut.length}, pools ${poolsOut.length}, piers ${piersOut.lines.length}+${piersOut.areas.length}, trees ${trees.length}, boats ${boats.length}, districts ${districts.length}`);
console.log(`landmarks ${JSON.stringify(landmarks)}`);
console.log(`=> public/data/world.json ${(json.length / 1e6).toFixed(2)} MB; sections: ${secSizes.join('; ')} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
