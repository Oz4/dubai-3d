// Viaduct spines from individual track centrelines.
//
// OSM maps each metro track as its own line (plus crossovers and pocket tracks). A real Dubai Metro
// viaduct is one twin-track box girder on a single row of piers, so the deck has to follow the middle
// of the tracks and widen where a third track runs between them. Greedy sweep: the longest track
// becomes a spine; at each sample, every other track point within `reach` sideways widens the deck
// to cover it; covered points are consumed, and whatever is left (diverging branches) forms its own
// narrower spine.

function resample(pl, step) {
  const out = [];
  for (let i = 1; i < pl.length; i++) {
    const a = pl[i - 1], b = pl[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1e-6) continue;
    const n = Math.max(1, Math.round(L / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t]);
    }
  }
  // tangents
  for (let i = 0; i < out.length; i++) {
    const p = out[Math.max(0, i - 2)], q = out[Math.min(out.length - 1, i + 2)];
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
    out[i].t = [dx / l, dy / l];
  }
  return out;
}

export function viaductSpines(tracks, { step = 3, reach = 13, half = 2.9, minLen = 24 } = {}) {
  const samples = [];
  const sets = tracks.map((pl, ti) => {
    const rs = resample(pl, step);
    rs.forEach((p, k) => { p.ti = ti; p.k = k; p.covered = false; samples.push(p); });
    return rs;
  });
  const CELL = 16, grid = new Map();
  for (const p of samples) {
    const key = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
    let c = grid.get(key); if (!c) grid.set(key, (c = [])); c.push(p);
  }
  const near = (x, y, r) => {
    const out = [];
    for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++)
      for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy++) {
        const c = grid.get(`${gx},${gy}`); if (c) for (const p of c) if (Math.hypot(p[0] - x, p[1] - y) <= r) out.push(p);
      }
    return out;
  };
  const order = sets.map((s, i) => [i, s.length]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const spines = [];
  for (const ti of order) {
    const rs = sets[ti];
    let run = [];
    const flush = () => {
      if (run.length * step >= minLen) spines.push(run);
      run = [];
    };
    for (const p of rs) {
      if (p.covered) { flush(); continue; }
      const nx = -p.t[1], ny = p.t[0];
      let lo = 0, hi = 0; let zs = p[2], zn = 1;
      const cand = near(p[0], p[1], reach + step);
      for (const q of cand) {
        const dx = q[0] - p[0], dy = q[1] - p[1];
        const along = dx * p.t[0] + dy * p.t[1], side = dx * nx + dy * ny;
        if (Math.abs(along) > step * 0.75 || Math.abs(side) > reach) continue;
        lo = Math.min(lo, side); hi = Math.max(hi, side);
        if (q.ti !== ti) { zs += q[2]; zn++; }
      }
      for (const q of cand) {
        if (q.ti === ti) continue; // never consume this track's own next samples
        const dx = q[0] - p[0], dy = q[1] - p[1];
        const along = dx * p.t[0] + dy * p.t[1], side = dx * nx + dy * ny;
        if (Math.abs(along) <= step * 0.75 && side >= lo - 0.5 && side <= hi + 0.5) q.covered = true;
      }
      p.covered = true;
      run.push({ x: p[0], y: p[1], z: zs / zn, nx, ny, lo, hi });
    }
    flush();
  }
  // smooth the deck edges (dilate, then average) and emit [x, y, z, w] every ~3 samples
  return spines.map((run) => {
    const n = run.length, W = 4;
    const lo = run.map((_, i) => { let m = 0; for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) m = Math.min(m, run[k].lo); return m; });
    const hi = run.map((_, i) => { let m = 0; for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) m = Math.max(m, run[k].hi); return m; });
    const avg = (arr, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) { s += arr[k]; c++; } return s / c; };
    const pts = [];
    for (let i = 0; i < n; i++) {
      if (i % 3 !== 0 && i !== n - 1) continue;
      const r = run[i], l = avg(lo, i), h = avg(hi, i), mid = (l + h) / 2;
      pts.push([r.x + r.nx * mid, r.y + r.ny * mid, r.z, h - l + 2 * half]);
    }
    return pts;
  });
}

// Pier stations along a spine: every `span` metres, nudged along the deck so a column never stands
// in a carriageway; skipped (longer span) when no clear spot exists nearby.
export function placePiers(spine, { span = 30, blocked, tries = [0, 3, -3, 6, -6, 9, -9, 12, -12] }) {
  const cum = [0];
  for (let i = 1; i < spine.length; i++) cum.push(cum[i - 1] + Math.hypot(spine[i][0] - spine[i - 1][0], spine[i][1] - spine[i - 1][1]));
  const L = cum[cum.length - 1];
  const at = (s) => {
    s = Math.max(0, Math.min(L, s));
    let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
    const a = spine[i - 1], b = spine[i], t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t, w: a[3] + (b[3] - a[3]) * t, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  };
  const out = [];
  const nSpans = Math.max(1, Math.round(L / span)), step = L / nSpans;
  for (let k = 0; k <= nSpans; k++) {
    for (const d of tries) {
      const s = k * step + d; if (s < 0 || s > L) continue;
      const p = at(s);
      if (blocked(p)) continue;
      out.push(p); break;
    }
  }
  return out;
}
