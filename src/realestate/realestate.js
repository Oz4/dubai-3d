import * as THREE from 'three';
import devData from './developer-data.json';
import { MODE } from '../layers/buildings.js';
import { pointInPoly, signedArea, rng } from '../core/util.js';
import { createExplorer, STATUS_COLORS } from './explorer.js';
import { buildSurfaceGrid, viewChips, sunHours } from './analysis.js';
import { dubaiDate } from '../core/environment.js';

const $ = (id) => document.getElementById(id);
const FRUSTUM_H = 2400;
const DEV_COLORS = {
  'Emaar Properties': '#2f80ed', 'Dubai Properties': '#eb5757', 'Select Group': '#f2994a', 'DAMAC Properties': '#9b51e0',
  Meraas: '#14b8a6', 'Tameer Holding': '#f2c94c', 'Cayan Group': '#ff6fa8', DMCC: '#27ae60', 'Sobha Realty': '#c9a56b',
  'The First Group': '#56ccf2', Hiranandani: '#bb6bd9', 'Sheffield Holdings': '#6fcf97', 'Al Habtoor Group': '#e2b93b', 'London Gate': '#f78fb3',
  Nakheel: '#d9a441', 'TECOM Group': '#7f8cff', 'Kerzner International': '#ff8a65', 'Binghatti Developers': '#4dd0e1', 'Emirates Group': '#e57373',
};
const CIVIC_TYPES = new Set(['mosque', 'school', 'college', 'university', 'hospital', 'government', 'public', 'civic', 'train_station', 'transportation', 'fire_station', 'police']);
const HOME_TYPES = new Set(['villa', 'building', 'residential', 'apartments', 'house', 'detached', 'semidetached_house', 'terrace', 'construction']);
const EXTRA_COLORS = ['#7f8cff', '#ff8a65', '#4dd0e1', '#aed581', '#ba68c8', '#ffd54f', '#90a4ae', '#f06292', '#4db6ac', '#dce775', '#9575cd', '#ffb74d'];
const COMMUNITY_COLORS = {
  'Dubai Marina & JBR': '#f4b942', Bluewaters: '#14b8a6', 'Emaar Beachfront': '#2f80ed', 'Jumeirah Lake Towers': '#27ae60', 'The Meadows & Springs': '#eb7f57',
  'Palm Jumeirah': '#ff6fa8', 'Media City & Internet City': '#9b8cff', 'Barsha Heights': '#f2c94c', 'Al Sufouh': '#56ccf2', 'Emirates Hills & The Lakes': '#6fcf97',
  'Al Barsha': '#ffb74d', 'Umm Suqeim': '#4dd0e1',
  'Al Quoz': '#b0bec5', 'Al Safa & Al Wasl': '#ffd54f', Jumeirah: '#81d4fa', 'Dubai Hills Estate': '#a5d6a7',
  'Downtown Dubai': '#f06292', 'Business Bay': '#7986cb', 'DIFC & Trade Centre': '#4db6ac', "Al Satwa & Za'abeel": '#ffb300', 'City Walk': '#ba68c8',
  'Dubai Design District': '#ff8a65', Meydan: '#9ccc65',
};
const VIEW_COLORS = { sea: '#2f86c9', marina: '#3ec1d3', lake: '#62b8ea', golf: '#6cbf4f', park: '#8bc34a', beach: '#f2d08a', city: '#8a94a8' };

const fmtAED = (n) => 'AED ' + Math.round(n).toLocaleString('en-US');
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

export async function createRealEstate(ctx, { buildings, ground }) {
  const { data } = ctx;
  const info = buildings.info;

  // ------------------------------------------------------------ developer attribution
  const byName = new Map(devData.towers.map((t) => [t.name.toLowerCase(), t]));
  const groups = devData.groups.map((g) => ({ ...g, re: new RegExp(g.regex.replace('\\d+$', '\\d+( ?& ?\\d+)?$'), 'i') }));
  const districtPoly = (name) => { const d = data.districts.find((x) => x.n === name && x.p); return d ? [d.p] : null; };
  const districtPolys = (re) => data.districts.filter((x) => re.test(x.n) && x.p).map((x) => [x.p]);
  const bluewaters = districtPoly('Bluewaters'), beachfront = districtPoly('Emaar Beachfront');
  const palm = districtPolys(/^Palm Jumeirah$/), mediaCity = districtPolys(/^Al Sufouh 2$/);
  const dubaiHills = districtPolys(/^(Dubai Hills( Estate)?|Maple \d|Sidra \d|Hadaeq Sheikh Mohammed Bin Rashid|Hills View|Hills Grove)$/);
  const downtown = districtPolys(/^(Downtown Dubai|Burj Khalifa)$/), cityWalk = districtPolys(/^City Walk$/), d3 = districtPolys(/^Dubai Design District$/);
  // bounding boxes first: most buildings are nowhere near most polygons
  const bbOf = new WeakMap();
  const inPoly = (pt, poly) => {
    let bb = bbOf.get(poly);
    if (!bb) { bb = [Infinity, Infinity, -Infinity, -Infinity]; for (const q of poly[0]) { if (q[0] < bb[0]) bb[0] = q[0]; if (q[1] < bb[1]) bb[1] = q[1]; if (q[0] > bb[2]) bb[2] = q[0]; if (q[1] > bb[3]) bb[3] = q[1]; } bbOf.set(poly, bb); }
    return pt[0] >= bb[0] && pt[0] <= bb[2] && pt[1] >= bb[1] && pt[1] <= bb[3] && pointInPoly(pt, poly);
  };
  const inAny = (pt, polys) => polys.some((p) => inPoly(pt, p));
  const developers = new Map();
  const devEntry = (name) => {
    if (!developers.has(name)) developers.set(name, { name, color: DEV_COLORS[name] || EXTRA_COLORS[developers.size % EXTRA_COLORS.length], buildings: [] });
    return developers.get(name);
  };
  for (const b of info) {
    let hit = null;
    if (b.name) {
      const t = byName.get(b.name.toLowerCase());
      if (t) hit = { developer: t.developer, source: t.source, confidence: t.confidence, rule: 'tower' };
      else for (const g of groups) if (g.re.test(b.name)) { hit = { developer: g.developer, source: g.source, confidence: 'high', rule: g.note }; break; }
    }
    if (!hit && bluewaters && b.height >= 15 && inPoly(b.center, bluewaters)) hit = { developer: 'Meraas', source: null, confidence: 'high', rule: 'Located on Bluewaters Island (Meraas master development)' };
    if (!hit && beachfront && b.height >= 30 && inPoly(b.center, beachfront)) hit = { developer: 'Emaar Properties', source: null, confidence: 'medium', rule: 'Located in Emaar Beachfront (Emaar master community)' };
    if (!hit && b.height >= 30 && inAny(b.center, palm)) hit = { developer: 'Nakheel', source: null, confidence: 'medium', rule: 'Located on Palm Jumeirah (Nakheel master development); the tower itself may be by another developer' };
    if (!hit && b.height >= 20 && inAny(b.center, mediaCity)) hit = { developer: 'TECOM Group', source: null, confidence: 'medium', rule: 'Located in Dubai Media City / Internet City / Knowledge Park (TECOM Group business districts)' };
    if (!hit && !CIVIC_TYPES.has(b.type) && inAny(b.center, downtown)) hit = { developer: 'Emaar Properties', source: 'https://en.wikipedia.org/wiki/Downtown_Dubai', confidence: 'medium', rule: 'Located in Downtown Dubai (Emaar master development: Burj Khalifa, The Dubai Mall, the Address hotels and most towers). A few plots may be by other developers.' };
    if (!hit && !CIVIC_TYPES.has(b.type) && inAny(b.center, cityWalk)) hit = { developer: 'Meraas', source: 'https://www.benoy.com/projects/city-walk', confidence: 'medium', rule: 'Located in City Walk (Meraas mixed-use district)' };
    if (!hit && !CIVIC_TYPES.has(b.type) && inAny(b.center, d3)) hit = { developer: 'TECOM Group', source: 'https://tecomgroup.ae/press-release/d3-celebrates-milestone-anniversary-of-nurturing-creativity-and-innovation', confidence: 'medium', rule: 'Located in Dubai Design District (d3, a TECOM Group business district)' };
    // homes only: the estate's schools, hospital, mosques and shops are not necessarily Emaar's
    if (!hit && HOME_TYPES.has(b.type) && inAny(b.center, dubaiHills)) hit = { developer: 'Emaar Properties', source: 'https://cdn.properties.emaar.com/wp-content/uploads/2021/04/2013-08-jun-regulatory-disclosures.pdf', confidence: 'medium', rule: 'Located in Dubai Hills Estate (Emaar and Meraas joint venture; Emaar builds the residential districts). A few plots may be by other developers.' };
    if (hit) {
      const d = devEntry(hit.developer);
      b.developer = { name: d.name, color: d.color, source: hit.source, confidence: hit.confidence, rule: hit.rule };
      d.buildings.push(b.index);
    }
  }

  // ------------------------------------------------------------ communities
  const szr = (() => { // least-squares line through Sheikh Zayed Road
    const pts = data.roads.filter((r) => r.k === 'motorway').flatMap((r) => r.p);
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    let sxx = 0, sxy = 0; for (const p of pts) { sxx += (p[0] - mx) ** 2; sxy += (p[0] - mx) * (p[1] - my); }
    const ang = Math.atan2(sxy, sxx);
    return { mx, my, ux: Math.cos(ang), uy: Math.sin(ang) };
  })();
  const seaSideOfSZR = (p) => (p[0] - szr.mx) * szr.uy - (p[1] - szr.my) * szr.ux < 0;
  const marinaRects = ((data.meta.sections || []).find((s) => s.id === 'marina') || { rects: [[-1e9, -1e9, 1e9, 1e9]] }).rects;
  const inMarinaSection = (p) => marinaRects.some((r) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3]);
  const marinaEdges = (data.areas.marina || []).flatMap((poly) => poly.flatMap((r) => r.map((p, i) => [p, r[(i + 1) % r.length]])));
  const distToMarina = (p) => { let d = Infinity; for (const [a, b] of marinaEdges) { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy; let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); d = Math.min(d, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1])); } return d; };
  const comPolys = [
    ['Palm Jumeirah', palm],
    ['Media City & Internet City', mediaCity],
    ['Barsha Heights', districtPolys(/^(Dubai Media City 2|Al Thanyah 1)$/)],
    ['Al Sufouh', districtPolys(/^(Al Sufouh 1|Sufouh Gardens)$/)],
    ['Emirates Hills & The Lakes', districtPolys(/^(Emirates Hills|The Lakes|Hattan \d)$/)],
    ['Umm Suqeim', districtPolys(/^Umm Suqeim( \d)?$/)],
    ['Al Barsha', districtPolys(/^Al Barsha( \d| South( \d)?)?$/)],
    ['Dubai Hills Estate', dubaiHills],
    ['Downtown Dubai', downtown],
    ['Business Bay', districtPolys(/^Business Bay$/)],
    ['DIFC & Trade Centre', districtPolys(/^(Dubai International Financial Cent(er|re)|DIFC|Trade Cent(er|re)( \d)?|Sheikh Zayed Road)$/)],
    ['City Walk', cityWalk],
    ['Dubai Design District', d3],
    ["Al Satwa & Za'abeel", districtPolys(/^(Al Satwa|Al Bada'?a|Al Kifaf|Za'?abeel( \d)?)$/)],
    ['Meydan', districtPolys(/^(Meydan( City| Gated Community)?|Nad Al Sheba( \d)?)$/)],
    ['Jumeirah', districtPolys(/^Jumeirah \d$/)],
    ['Al Safa & Al Wasl', districtPolys(/^(Al Safa( \d)?|Al Wasl)$/)],
    ['Al Quoz', districtPolys(/^(Al Q[ou]{2}z( Industrial Area)?( \d)?|Al Khail Gate Residential)$/)],
    ['Bluewaters', bluewaters ? [bluewaters] : []],
    ['Emaar Beachfront', beachfront ? [beachfront] : []],
    ['Jumeirah Lake Towers', [districtPoly('Jumeirah Lakes Towers')].filter(Boolean)],
    ['The Meadows & Springs', data.districts.filter((d) => /^(Meadows|Springs)/.test(d.n) && d.p).map((d) => [d.p])],
  ];
  const communities = new Map(Object.keys(COMMUNITY_COLORS).map((n) => [n, { name: n, color: COMMUNITY_COLORS[n], buildings: [] }]));
  for (const b of info) {
    let com = null;
    for (const [name, polys] of comPolys) if (inAny(b.center, polys)) { com = name; break; }
    if (!com && inMarinaSection(b.center) && seaSideOfSZR(b.center) && distToMarina(b.center) < 520) com = 'Dubai Marina & JBR';
    if (com) { b.community = com; communities.get(com).buildings.push(b.index); }
  }

  // ------------------------------------------------------------ analysis + explorer
  const grid = buildSurfaceGrid(data, ground.landPolys, ctx.bounds);
  const explorer = createExplorer(ctx, { buildings, grid });

  // ------------------------------------------------------------ filter state
  const filter = { devs: new Set(), community: null, mode: 'highlight' };
  let selected = -1;
  const selColor = new THREE.Color('#ffcf4a');

  function applyStates() {
    const active = filter.devs.size > 0 || !!filter.community;
    const col = new THREE.Color();
    // the change ripples outward from the developer's towers (or from the view centre when clearing)
    {
      let fx = 0, fy = 0, fn = 0;
      if (active) for (let i = 0; i < info.length; i++) {
        const b = info[i];
        if ((!filter.devs.size || (b.developer && filter.devs.has(b.developer.name))) && (!filter.community || b.community === filter.community)) { fx += b.center[0]; fy += b.center[1]; fn++; }
      }
      if (fn) buildings.setFocus(fx / fn, fy / fn);
      else { const f = ctx.focus ? ctx.focus() : ctx.controls.target; buildings.setFocus(f.x, -f.z); }
    }
    for (let i = 0; i < info.length; i++) {
      const b = info[i];
      if (!active) { buildings.setState(i, MODE.NORMAL); continue; }
      const okDev = !filter.devs.size || (b.developer && filter.devs.has(b.developer.name));
      const okCom = !filter.community || b.community === filter.community;
      if (okDev && okCom) { col.set(filter.devs.size ? b.developer.color : COMMUNITY_COLORS[filter.community]); buildings.setState(i, MODE.HIGHLIGHT, col); }
      else buildings.setState(i, filter.mode === 'isolate' ? MODE.FLAT : MODE.DIM);
    }
    // while exploring floors, slice nearby buildings at the floor height so the plan is never occluded
    const exploring = explorer.active && explorer.state.info && !explorer.state.firstPerson;
    if (exploring) {
      const c0 = explorer.state.info.center;
      for (let i = 0; i < info.length; i++) {
        const c = info[i].center;
        if (i !== explorer.state.info.index && Math.hypot(c[0] - c0[0], c[1] - c0[1]) < 450 && info[i].height > explorer.state.floor * explorer.state.fh - 2) buildings.setState(i, MODE.CUT);
      }
      buildings.uCut.value = Math.max(0, explorer.state.floor * explorer.state.fh - 2);
    }
    if (selected >= 0) buildings.setState(selected, exploring && explorer.state.info.index === selected ? MODE.HIDDEN : MODE.SELECTED, selColor);
    buildings.commit();
    $('clear-filter').hidden = !active;
    ctx.labelsSuppressed = exploring;
  }

  function fitTo(indices) {
    if (!indices.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, hmax = 0;
    for (const i of indices) { const c = info[i].center; x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); hmax = Math.max(hmax, info[i].height); }
    const ext = Math.max(x1 - x0, y1 - y0, 250) + hmax * 0.8;
    ctx.flyTo({ target: new THREE.Vector3((x0 + x1) / 2, 0, -(y0 + y1) / 2), zoom: THREE.MathUtils.clamp(FRUSTUM_H / (ext * 1.45), 0.55, 5), duration: 1.1 });
  }

  // ------------------------------------------------------------ left panel: developer + community lists
  const devList = $('dev-list'), comList = $('community-list');
  const devs = [...developers.values()].sort((a, b) => b.buildings.length - a.buildings.length || a.name.localeCompare(b.name));
  let showAllDevs = false;
  function renderDevList() {
    const items = showAllDevs ? devs : devs.slice(0, 9);
    devList.innerHTML = items.map((d) => `<li data-dev="${esc(d.name)}" class="${filter.devs.has(d.name) ? 'on' : ''}"><span class="dot" style="background:${d.color}"></span><span class="name">${esc(d.name)}</span><span class="count">${d.buildings.length}</span></li>`).join('')
      + (devs.length > 9 ? `<li class="more" data-more="1"><span class="name" style="color:var(--muted)">${showAllDevs ? 'Show fewer' : `Show all ${devs.length} developers`}</span></li>` : '');
  }
  function renderComList() {
    comList.innerHTML = [...communities.values()].filter((c) => c.buildings.length).map((c) => `<li data-com="${esc(c.name)}" class="${filter.community === c.name ? 'on' : ''}" style="color:${c.color}"><span class="dot"></span><span class="name" style="color:var(--text)">${esc(c.name)}</span><span class="count">${c.buildings.length}</span></li>`).join('');
  }
  devList.addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    if (li.dataset.more) { showAllDevs = !showAllDevs; renderDevList(); return; }
    const n = li.dataset.dev;
    if (filter.devs.has(n)) filter.devs.delete(n); else filter.devs.add(n);
    renderDevList(); applyStates();
    const idx = [...filter.devs].flatMap((d) => developers.get(d).buildings).filter((i) => !filter.community || info[i].community === filter.community);
    if (idx.length) fitTo(idx);
  });
  comList.addEventListener('click', (e) => {
    const li = e.target.closest('li'); if (!li) return;
    filter.community = filter.community === li.dataset.com ? null : li.dataset.com;
    renderComList(); applyStates();
    if (filter.community) fitTo(communities.get(filter.community).buildings.filter((i) => info[i].height > 6));
  });
  document.querySelectorAll('#filter-mode button').forEach((b) => b.addEventListener('click', () => {
    filter.mode = b.dataset.mode;
    document.querySelectorAll('#filter-mode button').forEach((x) => x.classList.toggle('on', x === b));
    applyStates();
  }));
  $('clear-filter').addEventListener('click', () => { filter.devs.clear(); filter.community = null; renderDevList(); renderComList(); applyStates(); });
  renderDevList(); renderComList();

  // ------------------------------------------------------------ search
  const search = $('search'), results = $('search-results');
  const named = []; { const seen = new Set(); for (const b of [...info].sort((a, b) => b.height - a.height)) if (b.name && !seen.has(b.name)) { seen.add(b.name); named.push(b); } }
  let active = 0, current = [];
  function renderResults() {
    const q = search.value.trim().toLowerCase();
    if (!q) { results.hidden = true; return; }
    current = named.filter((b) => b.name.toLowerCase().includes(q) || (b.developer && b.developer.name.toLowerCase().includes(q))).slice(0, 9);
    active = 0;
    results.innerHTML = current.map((b, i) => `<li data-i="${b.index}" class="${i === active ? 'active' : ''}">${esc(b.name)}<span>${Math.round(b.height)} m</span></li>`).join('') || '<li style="color:var(--muted)">No match</li>';
    results.hidden = false;
  }
  search.addEventListener('input', renderResults);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + current.length) % Math.max(1, current.length); [...results.children].forEach((li, i) => li.classList.toggle('active', i === active)); e.preventDefault(); }
    if (e.key === 'Enter' && current[active]) { selectBuilding(current[active].index); results.hidden = true; search.blur(); }
    if (e.key === 'Escape') { search.value = ''; results.hidden = true; }
  });
  results.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (!li) return; selectBuilding(+li.dataset.i); results.hidden = true; });
  search.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));

  // ------------------------------------------------------------ details panel
  const panel = $('details');
  const floorPicker = $('floor-picker'), floorRange = $('floor-range'), floorLabel = $('floor-label');

  function inventory(b) {
    const r = rng(b.index * 31 + 7);
    const floors = b.levels;
    const perFloor = Math.max(1, Math.min(12, Math.round(Math.abs(signedArea(b.plate[0])) / 110)));
    const total = Math.max(1, floors * perFloor);
    const avail = Math.round(total * (0.18 + r() * 0.3)), reserved = Math.round(total * (0.05 + r() * 0.1));
    return { total, avail, reserved, sold: Math.max(0, total - avail - reserved) };
  }

  function showBuilding(i) {
    const b = info[i];
    const inv = inventory(b);
    const dev = b.developer;
    const title = b.name || (b.type && !['yes', 'building'].includes(b.type) ? cap(b.type) : 'Unnamed building');
    const isRes = b.height >= 12;
    panel.innerHTML = `
      <div class="card-hero">
        <div class="eyebrow">${esc(b.community || 'Dubai')}${b.type && !['yes', 'building'].includes(b.type) ? ' · ' + esc(cap(b.type)) : ''}</div>
        <h3>${esc(title)}</h3>
        ${b.altName && b.altName !== b.name ? `<div class="note" style="margin:-4px 0 8px">${esc(b.altName)}</div>` : ''}
        ${dev ? `<span class="badge"><i style="background:${dev.color}"></i>${esc(dev.name)}</span>` : '<span class="badge" style="color:var(--muted)">Developer not attributed</span>'}
        <button class="close" data-act="close" title="Close">✕</button>
      </div>
      <div class="stats">
        <div><b>${Math.round(b.height)} m</b><span>Height${b.estimated ? ' (est.)' : ''}</span></div>
        <div><b>${b.levels}</b><span>Floors</span></div>
        <div><b>${b.year || '—'}</b><span>Completed</span></div>
      </div>
      <div class="card-body">
        ${dev ? `<div class="row"><span>Attribution</span><span style="text-align:right;max-width:190px">${dev.source ? `<a href="${esc(dev.source)}" target="_blank" rel="noopener" style="color:var(--accent-2)">source</a> · ` : ''}${esc(dev.confidence)} confidence</span></div>` : ''}
        ${isRes ? `<div>
          <div class="row" style="margin-bottom:6px"><span>Sample inventory</span><span><b>${inv.avail}</b> of ${inv.total} units available</span></div>
          <div class="avail-bar"><i style="width:${(inv.avail / inv.total) * 100}%;background:${STATUS_COLORS.available}"></i><i style="width:${(inv.reserved / inv.total) * 100}%;background:${STATUS_COLORS.reserved}"></i><i style="width:${(inv.sold / inv.total) * 100}%;background:${STATUS_COLORS.sold}"></i></div>
          <div class="legend" style="margin-top:6px"><span style="--c:${STATUS_COLORS.available}">Available</span><span style="--c:${STATUS_COLORS.reserved}">Reserved</span><span style="--c:${STATUS_COLORS.sold}">Sold</span></div>
        </div>` : ''}
        <div class="btn-row">
          ${isRes ? '<button class="btn primary" data-act="floors">Explore floors</button>' : ''}
          ${dev ? `<button class="btn secondary" data-act="portfolio">${esc(dev.name.split(' ')[0])} portfolio</button>` : '<button class="btn secondary" data-act="fly">Fly around</button>'}
        </div>
        <p class="note">Geometry: OpenStreetMap. Floor plans, prices and availability in this demo are generated samples.</p>
      </div>`;
    panel.hidden = false;
  }

  function showFloor() {
    const st = explorer.state; const b = st.info; if (!b) return;
    const units = st.layout.units;
    const avail = units.filter((u) => u.status === 'available');
    const from = avail.length ? Math.min(...avail.map((u) => u.price)) : null;
    panel.innerHTML = `
      <div class="card-hero">
        <div class="eyebrow">${esc(b.name || 'Building')}</div>
        <h3>Floor ${st.floor + 1} <span style="color:var(--muted);font-weight:500;font-size:14px">of ${st.floors}</span></h3>
        <span class="badge">${units.length} units · use ▲▼ or the slider</span>
        <button class="close" data-act="back-building" title="Back">←</button>
      </div>
      <div class="stats">
        <div><b>${units.length}</b><span>Units</span></div>
        <div><b style="color:${STATUS_COLORS.available}">${avail.length}</b><span>Available</span></div>
        <div><b>${from ? (from / 1e6).toFixed(2) + 'M' : '—'}</b><span>From (AED)</span></div>
      </div>
      <div class="card-body">
        <div style="display:grid;gap:4px">
          ${units.map((u) => `<div class="row unit-row" data-unit="${u.k}" style="cursor:pointer;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,0.04)">
            <span style="color:var(--text)"><span class="status"><i style="background:${STATUS_COLORS[u.status]}"></i></span> ${u.number} · ${u.beds}</span>
            <span>${Math.round(u.sqft).toLocaleString()} sq ft${u.status !== 'sold' ? ' · ' + (u.price / 1e6).toFixed(2) + 'M' : ''}</span></div>`).join('')}
        </div>
        <div class="legend"><span style="--c:${STATUS_COLORS.available}">Available</span><span style="--c:${STATUS_COLORS.reserved}">Reserved</span><span style="--c:${STATUS_COLORS.sold}">Sold</span></div>
        <p class="note">Click a unit on the plan or in the list for views, sunlight and an inside-out view.</p>
      </div>`;
  }

  function viewCone(v) {
    if (!v) return '';
    const cx = 48, cy = 48, R = 42;
    const step = v.rays.length > 1 ? Math.abs(v.rays[1].a - v.rays[0].a) : 0.2;
    const wedges = v.rays.map((r) => {
      const a0 = r.a - step / 2, a1 = r.a + step / 2;
      const rr = r.near ? R * 0.35 : R;
      const c = r.near ? '#ff5a5f' : VIEW_COLORS[r.seen] || VIEW_COLORS.city;
      const p = (a, rad) => `${(cx + Math.cos(a) * rad).toFixed(1)},${(cy - Math.sin(a) * rad).toFixed(1)}`;
      return `<path d="M${cx},${cy} L${p(a0, rr)} A${rr},${rr} 0 0 0 ${p(a1, rr)} Z" fill="${c}" opacity="0.9"/>`;
    }).join('');
    return `<svg viewBox="0 0 96 96"><circle cx="48" cy="48" r="44" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.15)"/>${wedges}<circle cx="48" cy="48" r="3" fill="#fff"/><text x="48" y="9" text-anchor="middle" font-size="8" fill="#9aa6bf" font-weight="700">N</text></svg>`;
  }

  function showUnit(u) {
    const st = explorer.state; const b = st.info;
    const v = u.view;
    const chips = viewChips(v);
    const cur = ctx.ui ? ctx.ui.current : null;
    const day = cur ? dubaiDate(cur.y, cur.m, cur.d, 0) : dubaiDate(2026, 11, 5, 0);
    const sun = sunHours(ctx, buildings, b, u, st.floor * st.fh, day);
    const mix = v ? Object.entries({ sea: v.sea, marina: v.marina, golf: v.golf, lake: v.lake, beach: v.beach, park: v.park, city: v.city }).filter(([, x]) => x > 0.01).sort((a, b2) => b2[1] - a[1]) : [];
    panel.innerHTML = `
      <div class="card-hero">
        <div class="eyebrow">${esc(b.name || 'Building')} · Floor ${st.floor + 1}</div>
        <h3>Unit ${u.number}</h3>
        <span class="status" style="color:${STATUS_COLORS[u.status]}"><i style="background:${STATUS_COLORS[u.status]}"></i>${cap(u.status)}</span>
        <button class="close" data-act="back-floor" title="Back to floor">←</button>
      </div>
      <div class="stats">
        <div><b>${u.beds.replace(' Bedroom', ' BR')}</b><span>Type</span></div>
        <div><b>${Math.round(u.sqft).toLocaleString()}</b><span>sq ft (${Math.round(u.m2)} m²)</span></div>
        <div><b>${u.facing}</b><span>Facing</span></div>
      </div>
      <div class="card-body">
        ${u.status === 'sold' ? `<div class="price" style="color:var(--muted)">Sold <small>· last indicative ${fmtAED(u.price)}</small></div>` : `<div class="price">${fmtAED(u.price)} <small>${fmtAED(u.psf)} / sq ft</small></div>`}
        <div>
          <div class="section-head" style="margin:4px 0 8px"><h2>View from the windows</h2></div>
          <div class="chips">${chips.map(([t, k]) => `<span class="chip ${k}">${esc(t)}</span>`).join('')}</div>
        </div>
        <div class="viewcone">${viewCone(v)}
          <div style="display:grid;gap:3px;font-size:12px;flex:1">
            ${mix.map(([k, x]) => `<div class="row"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${VIEW_COLORS[k]};margin-right:6px"></span>${cap(k)}</span><span>${Math.round(x * 100)}%</span></div>`).join('')}
            ${v && v.blocked > 0.01 ? `<div class="row"><span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#ff5a5f;margin-right:6px"></span>Close obstruction</span><span>${Math.round(v.blocked * 100)}%</span></div>` : ''}
          </div>
        </div>
        <div class="row"><span>Direct sun on this day</span><span>${sun && sun.hours > 0 ? `${sun.hours.toFixed(1)} h · ${hhmm(sun.first)}–${hhmm(sun.last + 15)}` : 'No direct sun'}</span></div>
        <div class="row"><span>Window height</span><span>${Math.round(st.floor * st.fh + 1.6)} m above ground</span></div>
        <div class="btn-row">
          <button class="btn primary" data-act="fp">View from this unit</button>
          <button class="btn secondary" data-act="back-floor">Back to floor</button>
        </div>
        <p class="note">Views and sunlight are computed live from the 3D model by tracing sightlines from the unit's window. Prices and availability are illustrative samples.</p>
      </div>`;
  }

  panel.addEventListener('click', (e) => {
    const row = e.target.closest('[data-unit]');
    if (row && explorer.active) { const u = explorer.state.layout.units[+row.dataset.unit]; if (u) explorer.selectUnit(u); return; }
    const act = e.target.closest('[data-act]'); if (!act) return;
    const a = act.dataset.act;
    if (a === 'close') deselect();
    if (a === 'floors') openFloors();
    if (a === 'portfolio') { const d = info[selected].developer; if (d) { filter.devs = new Set([d.name]); filter.community = null; renderDevList(); renderComList(); applyStates(); fitTo(developers.get(d.name).buildings); } }
    if (a === 'fly') { const b = info[selected]; const s = new THREE.Spherical().setFromVector3(ctx.camera.position.clone().sub(ctx.controls.target)); ctx.flyTo({ azimuth: s.theta + Math.PI / 2, duration: 1.6 }); void b; }
    if (a === 'back-building') { closeFloors(); }
    if (a === 'back-floor') { explorer.selectUnit(null); showFloor(); }
    if (a === 'fp' && explorer.state.selected) explorer.viewFromUnit(explorer.state.selected);
  });

  function selectBuilding(i, fly = true) {
    if (explorer.active && explorer.state.info.index !== i) closeFloors(true);
    selected = i;
    applyStates();
    showBuilding(i);
    if (fly) {
      const b = info[i];
      const zoom = THREE.MathUtils.clamp(FRUSTUM_H / (b.height * 2.4 + 220), 1.1, 9);
      ctx.flyTo({ target: new THREE.Vector3(b.center[0], b.height * 0.3, -b.center[1]), zoom: Math.max(zoom, ctx.camera.zoom * 0.9 > 9 ? 9 : zoom), duration: 1.1 });
    }
  }
  function deselect() {
    if (explorer.active) closeFloors(true);
    selected = -1; panel.hidden = true;
    applyStates();
  }
  function openFloors() {
    if (selected < 0) return;
    explorer.open(info[selected]);
    applyStates();
    floorPicker.hidden = false;
    $('filter').hidden = true;
    floorRange.max = explorer.state.floors; floorRange.value = explorer.state.floor + 1;
    floorLabel.textContent = `F${explorer.state.floor + 1}`;
    showFloor();
  }
  function closeFloors(silent) {
    explorer.close(true);
    floorPicker.hidden = true;
    $('filter').hidden = false;
    applyStates();
    if (!silent && selected >= 0) { showBuilding(selected); const b = info[selected]; ctx.flyTo({ target: new THREE.Vector3(b.center[0], b.height * 0.3, -b.center[1]), zoom: THREE.MathUtils.clamp(FRUSTUM_H / (b.height * 2.4 + 220), 1.1, 9), polar: THREE.MathUtils.degToRad(54), duration: 1 }); }
  }

  ctx.on('select-building', (i) => selectBuilding(i));
  ctx.on('deselect', () => { if (!explorer.active) deselect(); });
  ctx.on('unit-selected', (u) => { if (u) showUnit(u); });
  ctx.on('floor-changed', ({ floor }) => { floorRange.value = floor + 1; floorLabel.textContent = `F${floor + 1}`; applyStates(); showFloor(); });
  ctx.on('first-person', () => applyStates());

  // floor picker
  let floorTimer = null;
  floorRange.addEventListener('input', () => {
    floorLabel.textContent = `F${floorRange.value}`;
    clearTimeout(floorTimer); floorTimer = setTimeout(() => explorer.setFloor(+floorRange.value - 1), 120);
  });
  $('floor-up').addEventListener('click', () => explorer.setFloor(explorer.state.floor + 1));
  $('floor-down').addEventListener('click', () => explorer.setFloor(explorer.state.floor - 1));
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (explorer.active && !explorer.state.firstPerson && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { explorer.setFloor(explorer.state.floor + (e.key === 'ArrowUp' ? 1 : -1)); e.preventDefault(); }
    if (e.key === 'Escape') { if (explorer.state.firstPerson) explorer.exitView(); else if (explorer.active) closeFloors(); else deselect(); }
  });

  // first-person overlay
  ctx.on('first-person', ({ on, unit, info: b }) => {
    $('exit-view').hidden = !on; $('window-frame').hidden = !on;
    panel.hidden = on; floorPicker.hidden = on || !explorer.active; $('filter').hidden = on || explorer.active; $('toolbar').hidden = on; $('compass').hidden = on;
    if (on) $('exit-view-title').textContent = `View from Unit ${unit.number} · ${b.name || 'Building'} · ${Math.round(explorer.state.floor * explorer.state.fh + 1.6)} m`;
    else if (explorer.state.selected) showUnit(explorer.state.selected);
  });
  $('exit-view-btn').addEventListener('click', () => explorer.exitView());

  return {
    developers, communities, explorer, grid,
    selectBuilding, deselect,
    handleClick(raycaster) {
      if (!explorer.active) return false;
      const u = explorer.pickUnit(raycaster);
      if (u) { explorer.selectUnit(u); return true; }
      const hit = buildings.pick(raycaster);
      if (hit && hit.index !== explorer.state.info.index) { closeFloors(true); selectBuilding(hit.index); return true; }
      return true; // swallow clicks on empty space while exploring floors
    },
    handleHover(raycaster, e) {
      if (!explorer.active) return false;
      const u = explorer.pickUnit(raycaster);
      explorer.setHover(u);
      const tip = ctx.ui.tooltip;
      if (u) {
        tip.innerHTML = `<b>Unit ${u.number}</b><span>${u.beds} · ${Math.round(u.sqft).toLocaleString()} sq ft · ${cap(u.status)}</span>`;
        tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 12}px`; tip.hidden = false;
        ctx.renderer.domElement.style.cursor = 'pointer';
        return true;
      }
      tip.hidden = true; ctx.renderer.domElement.style.cursor = '';
      return true;
    },
  };
}
