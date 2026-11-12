import * as THREE from 'three';

const DISTRICTS = [
  { n: 'Dubai Marina', lat: 25.0812, lon: 55.1408, max: 2.4 },
  { n: 'JBR', lat: 25.0772, lon: 55.1326, max: 2.4 },
  { n: 'Bluewaters', lat: 25.0791, lon: 55.1188, max: 2.6 },
  { n: 'Dubai Harbour', lat: 25.0936, lon: 55.1318, max: 2.4 },
  { n: 'Jumeirah Lake Towers', lat: 25.0712, lon: 55.1448, max: 2.4 },
  { n: 'Emirates Golf Club', lat: 25.0858, lon: 55.1592, max: 2.6 },
  { n: 'Jumeirah Islands', lat: 25.0620, lon: 55.1560, max: 2.2 },
  // Palm Jumeirah, Al Sufouh & Media City section
  { n: 'Palm Jumeirah', lat: 25.1180, lon: 55.1352, max: 1.8 },
  { n: 'The Crescent', lat: 25.1385, lon: 55.1250, max: 2.6, min: 0.7 },
  { n: 'Media City', lat: 25.0932, lon: 55.1532, max: 2.6, min: 0.7 },
  { n: 'Internet City', lat: 25.0972, lon: 55.1640, max: 2.6, min: 0.7 },
  { n: 'Knowledge Park', lat: 25.1030, lon: 55.1668, max: 2.6, min: 0.9 },
  { n: 'Barsha Heights', lat: 25.0955, lon: 55.1770, max: 2.4, min: 0.6 },
  { n: 'Al Sufouh', lat: 25.1135, lon: 55.1755, max: 2.4, min: 0.6 },
  { n: 'Emirates Hills', lat: 25.0700, lon: 55.1745, max: 2.4, min: 0.6 },
  // Al Barsha, Umm Suqeim & Burj Al Arab section
  { n: 'Al Barsha', lat: 25.1085, lon: 55.1985, max: 1.9 },
  { n: 'Mall of the Emirates', lat: 25.1185, lon: 55.2005, max: 3.2, min: 0.8 },
  { n: 'Madinat Jumeirah', lat: 25.1330, lon: 55.1850, max: 3.2, min: 0.8 },
  { n: 'Umm Suqeim', lat: 25.1505, lon: 55.2130, max: 1.9 },
  { n: 'Kite Beach', lat: 25.1585, lon: 55.2035, max: 3.2, min: 0.8 },
  { n: 'Al Barsha South', lat: 25.0740, lon: 55.2240, max: 2.4, min: 0.6 },
  { n: 'Al Quoz', lat: 25.1420, lon: 55.2400, max: 2.4, min: 0.6 },
  // Al Quoz, Al Safa & Jumeirah 3 section
  { n: 'Dubai Hills', lat: 25.1030, lon: 55.2500, max: 2.4 },
  { n: 'Dubai Hills Mall', lat: 25.1024, lon: 55.2403, max: 3.2, min: 0.8 },
  { n: 'Al Safa', lat: 25.1760, lon: 55.2410, max: 2.4, min: 0.6 },
  { n: 'Safa Park', lat: 25.1849, lon: 55.2462, max: 3.2, min: 0.8 },
  { n: 'Jumeirah 3', lat: 25.1930, lon: 55.2330, max: 2.4, min: 0.6 },
  { n: 'Al Wasl', lat: 25.1990, lon: 55.2570, max: 2.4, min: 0.6 },
  { n: 'Business Bay', lat: 25.1855, lon: 55.2775, max: 2.4 },
  { n: 'Al Habtoor City', lat: 25.1832, lon: 55.2545, max: 3.2, min: 0.8 },
  { n: 'Al Khail Gate', lat: 25.1405, lon: 55.2529, max: 3.2, min: 0.8 },
  { n: 'Dubai Miracle Garden', lat: 25.0605, lon: 55.2444, max: 3.2, min: 0.8 },
  // Downtown, Business Bay & DIFC section
  { n: 'Downtown Dubai', lat: 25.1935, lon: 55.2745, max: 2.4 },
  { n: 'The Dubai Mall', lat: 25.1985, lon: 55.2795, max: 3.2, min: 0.8 },
  { n: 'DIFC', lat: 25.2125, lon: 55.2810, max: 2.4 },
  { n: 'Trade Centre', lat: 25.2235, lon: 55.2870, max: 2.4, min: 0.6 },
  { n: 'Al Satwa', lat: 25.2280, lon: 55.2735, max: 2.4, min: 0.6 },
  { n: 'City Walk', lat: 25.2070, lon: 55.2625, max: 3.2, min: 0.8 },
  { n: 'Dubai Design District', lat: 25.1870, lon: 55.2985, max: 3.2, min: 0.8 },
  { n: 'Meydan', lat: 25.1590, lon: 55.3010, max: 2.4, min: 0.6 },
  { n: 'Global Village', lat: 25.0700, lon: 55.3050, max: 3.2, min: 0.6 },
  { n: 'Jumeirah Bay', lat: 25.2115, lon: 55.2410, max: 3.2, min: 0.8 },
  { n: 'The World', lat: 25.2230, lon: 55.1700, max: 1.6 },
];

export function createLabels(ctx, buildings) {
  const { data } = ctx;
  const root = document.getElementById('labels');
  const toLocal = (lat, lon) => [(lon - data.meta.lon0) * data.meta.mlon, (lat - data.meta.lat0) * data.meta.mlat];
  const labels = [];
  const add = (kind, html, pos, opts = {}) => {
    const el = document.createElement('div');
    el.className = `lbl ${kind}`; el.innerHTML = html;
    root.appendChild(el);
    const l = { el, kind, pos, min: opts.min ?? 0, max: opts.max ?? 99, prio: opts.prio ?? 0, w: 0, h: 0, onClick: opts.onClick, data: opts.data };
    if (opts.onClick) el.addEventListener('click', (e) => { e.stopPropagation(); opts.onClick(l); });
    labels.push(l);
    return l;
  };

  // towers: dedupe by name, keep the tallest
  const byName = new Map();
  for (const b of buildings.info) {
    if (!b.name || b.height < 90 || /[؀-ۿ]/.test(b.name)) continue;
    const prev = byName.get(b.name);
    if (!prev || b.height > prev.height) byName.set(b.name, b);
  }
  const towers = [...byName.values()].sort((a, b) => b.height - a.height);
  towers.forEach((b, rank) => {
    const min = rank < 10 ? 0.5 : rank < 22 ? 1.4 : rank < 45 ? 3.0 : rank < 90 ? 6.0 : 99;
    add('tower', `${b.name}<small>${Math.round(b.height)} m</small>`, new THREE.Vector3(b.center[0], b.height + 6, -b.center[1]),
      { min, prio: 1000 - rank, onClick: () => ctx.emit('select-building', b.index), data: b });
  });
  for (const d of DISTRICTS) {
    const [x, y] = toLocal(d.lat, d.lon);
    add('district', d.n, new THREE.Vector3(x, 30, -y), { max: d.max, min: d.min ?? 0, prio: 2000 });
  }
  // OSM neighbourhoods (The Meadows, The Springs...)
  for (const d of data.districts) {
    if (DISTRICTS.some((x) => x.n.toLowerCase() === d.n.toLowerCase())) continue;
    if (!/meadows|springs/i.test(d.n)) continue;
    add('district', d.n, new THREE.Vector3(d.x, 20, -d.y), { max: 3.2, min: 0.9, prio: 1500 });
  }
  {
    const [x, y] = toLocal(25.1010, 55.1080); // open water between the Palm and Bluewaters
    add('water', 'Arabian Gulf', new THREE.Vector3(x, 0, -y), { prio: 3000, max: 3 });
    // Sheikh Zayed Road label at the motorway point nearest the map centre
    let best = null, bd = Infinity;
    for (const r of data.roads) if (r.k === 'motorway') for (const p of r.p) { const d = Math.hypot(p[0] - 700, p[1] + 350); if (d < bd) { bd = d; best = p; } }
    if (best) add('district', 'Sheikh Zayed Rd', new THREE.Vector3(best[0], 10, -best[1]), { max: 3.2, min: 0.8, prio: 1800 });
  }
  labels.forEach((l) => { const r = l.el.getBoundingClientRect(); l.w = r.width; l.h = r.height; });
  labels.sort((a, b) => b.prio - a.prio);

  let visible = true;
  const v = new THREE.Vector3();
  const placed = [];
  function update() {
    const cam = ctx.activeCamera;
    if (!visible || cam.isPerspectiveCamera) { for (const l of labels) l.el.classList.add('hidden'); return; }
    const W = window.innerWidth, H = window.innerHeight, zoom = cam.zoom;
    placed.length = 0;
    for (const l of labels) {
      let show = zoom >= l.min && zoom <= l.max && !ctx.labelsSuppressed;
      if (l.data && buildings.modes[l.data.index] >= 3) show = false; // flattened/hidden/cut buildings
      if (show) {
        v.copy(l.pos).project(cam);
        const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
        if (x < -50 || x > W + 50 || y < -20 || y > H + 50) show = false;
        else {
          const cx = l.kind === 'tower' ? x - l.w / 2 : x - l.w / 2, cy = l.kind === 'tower' ? y - l.h - 4 : y - l.h / 2;
          const box = [cx - 3, cy - 2, cx + l.w + 3, cy + l.h + 2];
          if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) show = false;
          else { placed.push(box); l.el.style.left = `${x}px`; l.el.style.top = `${y}px`; }
        }
      }
      l.el.classList.toggle('hidden', !show);
    }
  }
  ctx.updaters.push(update);
  return { labels, add, update, setVisible(on) { visible = on; update(); } };
}
