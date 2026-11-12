// Downloads raw OpenStreetMap data for the built map sections (scripts/sections.json).
//
// Each rectangle of a built section is read in small tiles from the OpenStreetMap API (complete ways,
// cached under data-raw/tiles/osmapi/). A section fetched earlier through Overpass keeps its cached
// whole-rectangle file (data-raw/tiles/<name>/rect_*.json). Multipolygon relations that reach outside
// the tiles are completed afterwards, and the point amenities and transit stations the build also
// needs are filtered out of the same data.
// Outputs: data-raw/osm.json, data-raw/amenities.json, data-raw/stations.json (not committed).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { REGION } from './config.mjs';
import { osmMap, osmMulti } from './lib/osmapi.mjs';

const STEP = 0.01; // degrees (~1.1 km); dense villa tiles split themselves further
const root = (p) => new URL(`../data-raw/${p}`, import.meta.url);
mkdirSync(root('tiles/osmapi/'), { recursive: true });
const key = (t) => `${t.s.toFixed(4)}_${t.w.toFixed(4)}_${t.n.toFixed(4)}_${t.e.toFixed(4)}`;
function split(r, step) {
  const ny = Math.max(1, Math.ceil((r.n - r.s) / step - 1e-9)), nx = Math.max(1, Math.ceil((r.e - r.w) / step - 1e-9));
  const out = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out.push({ s: r.s + ((r.n - r.s) * j) / ny, n: r.s + ((r.n - r.s) * (j + 1)) / ny, w: r.w + ((r.e - r.w) * i) / nx, e: r.w + ((r.e - r.w) * (i + 1)) / nx });
  return out;
}

const byKey = new Map();
const add = (els) => {
  for (const e of els) {
    const k = e.type[0] + e.id, prev = byKey.get(k);
    if (!prev || (!prev.tags && e.tags) || (e.nodes && !prev.nodes) || (e.members && !prev.members)) byKey.set(k, e);
  }
};
const extra = { amenities: [], stations: [] }; // earlier Overpass extracts of the same rectangles

let fetched = 0, cached = 0;
for (const rect of REGION) {
  const rk = key(rect);
  if (existsSync(root(`tiles/osm/rect_${rk}.json`))) {
    add(JSON.parse(readFileSync(root(`tiles/osm/rect_${rk}.json`), 'utf8')).elements); cached++;
    for (const n of ['amenities', 'stations']) if (existsSync(root(`tiles/${n}/rect_${rk}.json`))) extra[n].push(...JSON.parse(readFileSync(root(`tiles/${n}/rect_${rk}.json`), 'utf8')).elements);
    continue;
  }
  const list = split(rect, STEP);
  for (const [i, t] of list.entries()) {
    const file = root(`tiles/osmapi/${key(t)}.json`);
    if (existsSync(file)) { add(JSON.parse(readFileSync(file, 'utf8'))); cached++; continue; }
    const label = `${rect.section} ${i + 1}/${list.length}`;
    const els = await osmMap(t, label);
    writeFileSync(file, JSON.stringify(els));
    add(els); fetched++;
    if (fetched % 10 === 0) console.log(`  ${label}: ${els.length.toLocaleString()} elements`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
console.log(`tiles: ${fetched} fetched, ${cached} cached; ${byKey.size.toLocaleString()} elements`);

// ---- complete multipolygons that reach beyond the fetched tiles (golf courses, parks, islands...)
const USE = ['building', 'building:part', 'landuse', 'leisure', 'natural', 'water', 'amenity', 'place', 'man_made', 'tourism', 'golf'];
for (let round = 0; round < 2; round++) {
  const wayIds = new Set();
  for (const e of byKey.values()) {
    if (e.type !== 'relation' || !e.tags || !USE.some((k) => e.tags[k])) continue;
    if (e.tags.type && e.tags.type !== 'multipolygon') continue;
    for (const m of e.members) if (m.type === 'way' && !byKey.has('w' + m.ref)) wayIds.add(m.ref);
  }
  if (!wayIds.size) break;
  console.log(`completing relations: ${wayIds.size} ways`);
  add(await osmMulti('way', [...wayIds], 'relation members'));
}
{
  const nodeIds = new Set();
  for (const e of byKey.values()) if (e.type === 'way') for (const n of e.nodes) if (!byKey.has('n' + n)) nodeIds.add(n);
  if (nodeIds.size) { console.log(`completing ways: ${nodeIds.size} nodes`); add(await osmMulti('node', [...nodeIds], 'way nodes')); }
}

const elements = [...byKey.values()];
const write = (name, els) => {
  const txt = JSON.stringify({ version: 0.6, generator: 'dubai-3d (OSM API + cached Overpass)', elements: els });
  writeFileSync(root(`${name}.json`), txt);
  console.log(`${name}: ${els.length.toLocaleString()} elements (${(txt.length / 1e6).toFixed(1)} MB)`);
};
write('osm', elements);

// ---- the point extracts the build reads (same filters as the old Overpass queries)
const AMEN = /^(fountain|bench|shelter|bbq|drinking_water|toilets|waste_basket|ice_cream|cafe|restaurant|bar|pub|fast_food|food_court|bicycle_rental)$/;
const isAmenity = (e) => {
  const t = e.tags; if (!t) return false;
  if (e.type === 'node') return !!(t.leisure || t.playground || (t.amenity && AMEN.test(t.amenity)) || t.shop || t.sport || /^(flagpole|water_tap)$/.test(t.man_made || '') || /^(picnic_site|viewpoint|artwork)$/.test(t.tourism || ''));
  if (e.type === 'way') return !!(t.playground || t.tourism === 'artwork' || (t.barrier === 'fence' && t.leisure));
  return false;
};
const isStation = (e) => {
  const t = e.tags; if (!t) return false;
  return t.railway === 'station' || t.public_transport === 'station' || t.railway === 'tram_stop' || t.building === 'train_station' ||
    (e.type === 'way' && (t.railway === 'platform' || t.public_transport === 'platform' || (t.highway === 'footway' && t.bridge === 'yes')));
};
const withNodes = (sel, more) => {
  const out = new Map();
  for (const e of [...more, ...elements.filter(sel)]) out.set(e.type[0] + e.id, e);
  for (const e of [...out.values()]) if (e.type === 'way') for (const n of e.nodes) { const nd = byKey.get('n' + n); if (nd && !out.has('n' + n)) out.set('n' + n, nd); }
  return [...out.values()];
};
write('amenities', withNodes(isAmenity, extra.amenities));
write('stations', withNodes(isStation, extra.stations));
