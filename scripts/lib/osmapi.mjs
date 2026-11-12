// OpenStreetMap API v0.6 reader: complete data for small bounding boxes (`/map`), converted to the
// same { type, id, lat, lon, nodes, members, tags } elements Overpass returns. Used when the public
// Overpass servers are overloaded. Tiles that hold too many nodes are split; relations whose members
// lie outside the fetched tiles are completed with the multi-fetch calls.
const API = 'https://api.openstreetmap.org/api/0.6';
const UA = { 'User-Agent': 'dubai-3d-demo/0.2 (data pipeline; occasional small-area reads)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));
const attrs = (s) => { const o = {}; for (const m of s.matchAll(/(\w+)="([^"]*)"/g)) o[m[1]] = unesc(m[2]); return o; };

export function parseOsmXml(xml) {
  const out = [];
  const re = /<(node|way|relation)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of xml.matchAll(re)) {
    const type = m[1], a = attrs(m[2]), body = m[4] || '';
    if (a.visible === 'false') continue;
    const e = { type, id: +a.id };
    if (type === 'node') { e.lat = +a.lat; e.lon = +a.lon; }
    if (type === 'way') e.nodes = [...body.matchAll(/<nd ref="(\d+)"/g)].map((x) => +x[1]);
    if (type === 'relation') e.members = [...body.matchAll(/<member\b([^>]*)\/>/g)].map((x) => { const t = attrs(x[1]); return { type: t.type, ref: +t.ref, role: t.role || '' }; });
    const tags = {}; let n = 0;
    for (const t of body.matchAll(/<tag\b([^>]*)\/>/g)) { const ta = attrs(t[1]); tags[ta.k] = ta.v; n++; }
    if (n) e.tags = tags;
    out.push(e);
  }
  return out;
}

async function get(url, label) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(180000) });
      if (res.status === 400 && /too many nodes|maximum|You requested/i.test(await res.clone().text())) return { tooBig: true };
      if (res.status === 509 || res.status === 429) { console.warn(`  ${label}: rate limited, waiting`); await sleep(30000 * (attempt + 1)); continue; }
      if (res.status === 404 || res.status === 410) return { missing: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { xml: await res.text() };
    } catch (err) {
      console.warn(`  ${label}: ${err.message}`);
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error('OSM API failed: ' + label);
}

// all data in a bbox {s,w,n,e}; splits itself when the API refuses a tile with too many nodes
export async function osmMap(t, label = '', depth = 0) {
  const r = await get(`${API}/map?bbox=${t.w.toFixed(6)},${t.s.toFixed(6)},${t.e.toFixed(6)},${t.n.toFixed(6)}`, label);
  if (!r.tooBig) return parseOsmXml(r.xml);
  if (depth > 4) throw new Error('tile still too big: ' + label);
  const ms = (t.s + t.n) / 2, mw = (t.w + t.e) / 2, els = [];
  for (const q of [{ s: t.s, w: t.w, n: ms, e: mw }, { s: t.s, w: mw, n: ms, e: t.e }, { s: ms, w: t.w, n: t.n, e: mw }, { s: ms, w: mw, n: t.n, e: t.e }]) {
    els.push(...(await osmMap(q, label + '.', depth + 1)));
    await sleep(400);
  }
  return els;
}

// multi-fetch ways / nodes / relations by id (chunks keep the URL short)
export async function osmMulti(kind, ids, label = '') {
  const out = [];
  const run = async (chunk) => {
    const r = await get(`${API}/${kind}s?${kind}s=${chunk.join(',')}`, `${label} ${kind}s x${chunk.length}`);
    await sleep(300);
    if (r.xml) { out.push(...parseOsmXml(r.xml)); return; }
    // a deleted element fails the whole request: halve until it is isolated
    if (r.missing && chunk.length > 1) { const h = chunk.length >> 1; await run(chunk.slice(0, h)); await run(chunk.slice(h)); }
  };
  for (let i = 0; i < ids.length; i += 300) await run(ids.slice(i, i + 300));
  return out;
}
