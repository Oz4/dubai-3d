// Street kit: kerbs, gutters, footways, dropped kerbs at driveways and street lamps for a neighbourhood, built from
// the OSM street centrelines.
//
// The carriageways form a signed distance field (each street a band of its own width; where two streets meet they
// join with a round fillet of the kerb radius, so junction corners and roundabout islands come out as real kerb
// lines). The field is sampled on a fine lattice tile by tile, and the kerb lines are its zero contour (marching
// squares). Contour points sit on lattice edges, so the pieces from neighbouring tiles join exactly.
//
// chains: [{ pts: [[x, y], ...], w, r (kerb radius at junctions), rank, oneway, surf (0 asphalt, 1 pavers) }]
//   streets merged end to end where they simply continue (a fillet between two halves of one street would dent it)
// masks: [{ pts, w }] carriageways that get no kerbs of their own (motorways, roads outside the neighbourhood):
//   kerb lines inside them are dropped
// sideAt(p): [footway width (m), footway style (0 grey pavers, 1 red pavers), lowest road rank given a footway] on the
//   verge side of a kerb at p, or null when p lies in no known community
// chains may also carry: edge (0: no edge line along their kerbs), lamp (lamp style), verge (palms along the verges)
// pathAt(p): true where a footway mapped on its own (OSM) runs (the kerb then gets a planted verge, not a footway)
// drives: [{ a: [x, y] (inner end), b: [x, y] (street end), w }]
// Returns { kerbs: [{ p, f (gutter + fillet strip width per vertex), d (dropped kerb 0..1 per vertex), fw, s, c }],
//   aprons: [[x0, y0, x1, y1, w]], lamps: [[x, y, angle, style]] }


function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return Math.sqrt(qx * qx + qy * qy);
}

// a uniform grid of segments for nearest / intersection queries
class SegGrid {
  constructor(cell = 16) { this.cell = cell; this.map = new Map(); }
  add(ax, ay, bx, by, item) {
    const c = this.cell;
    const i0 = Math.floor(Math.min(ax, bx) / c), i1 = Math.floor(Math.max(ax, bx) / c), j0 = Math.floor(Math.min(ay, by) / c), j1 = Math.floor(Math.max(ay, by) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i * 1000003 + j; let a = this.map.get(k); if (!a) this.map.set(k, (a = [])); a.push(item); }
  }
  near(x, y, r = 1) {
    const c = this.cell, i = Math.floor(x / c), j = Math.floor(y / c), out = new Set();
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) { const a = this.map.get((i + di) * 1000003 + (j + dj)); if (a) for (const it of a) out.add(it); }
    return out;
  }
}

export function streetKit({ chains, masks = [], sideAt = () => 0, pathAt = () => false, drives = [], H = 0.5, TILE = 384, log = () => {} }) {
  if (!chains.length) return { kerbs: [], aprons: [], lamps: [] };
  const T0 = Date.now(), ms = () => Date.now() - T0 + ' ms';
  // ---- the lattice over every chain's reach. The field is clamped at FAR: beyond the largest kerb radius nothing
  // changes the zero contour (clamping any nearer would make the round fillets see streets that are not there)
  const FAR = Math.max(...chains.map((c) => c.r)) + 1.5;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  chains.forEach((c, id) => {
    c.id = id;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of c.pts) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; }
    c.ext = c.w / 2 + FAR + H;
    c.bb = [x0 - c.ext, y0 - c.ext, x1 + c.ext, y1 + c.ext];
    minx = Math.min(minx, c.bb[0]); miny = Math.min(miny, c.bb[1]); maxx = Math.max(maxx, c.bb[2]); maxy = Math.max(maxy, c.bb[3]);
  });
  const X0 = Math.floor(minx / H) * H, Y0 = Math.floor(miny / H) * H;
  const NI = Math.ceil((maxx - X0) / H) + 2, NJ = Math.ceil((maxy - Y0) / H) + 2;
  // kerb radius between two streets: none between the two carriageways of a dual road (their median keeps its own
  // kerbs) and where a slip road merges
  const pairR = (A, B) => (A.oneway && B.oneway ? 0 : Math.min(A.r, B.r));

  // ---- field and contour, tile by tile
  const segA = [], segB = [], segK0 = [], segK1 = [];
  let tilesDone = 0;
  for (let tj = 0; tj * TILE < NJ - 1; tj++) for (let ti = 0; ti * TILE < NI - 1; ti++) {
    const i0 = ti * TILE, j0 = tj * TILE, i1 = Math.min(NI - 1, i0 + TILE), j1 = Math.min(NJ - 1, j0 + TILE);
    const bx0 = X0 + i0 * H, by0 = Y0 + j0 * H, bx1 = X0 + i1 * H, by1 = Y0 + j1 * H;
    const rel = chains.filter((c) => c.bb[2] >= bx0 && c.bb[0] <= bx1 && c.bb[3] >= by0 && c.bb[1] <= by1);
    if (!rel.length) continue;
    tilesDone++;
    const W = i1 - i0 + 1, Hn = j1 - j0 + 1;
    const field = new Float32Array(W * Hn).fill(FAR), owner = new Int32Array(W * Hn).fill(-1);
    // the chain's own field (a hard minimum over its segments), only on the cells its band reaches
    const tmp = new Float32Array(W * Hn), stamp = new Int32Array(W * Hn), touched = new Int32Array(W * Hn);
    for (const c of rel) {
      const hw = c.w / 2, reach = c.ext, P = c.pts, tag = c.id + 1;
      let n = 0;
      for (let s = 0; s < Math.max(1, P.length - 1); s++) {
        const a = P[s], b = P[Math.min(P.length - 1, s + 1)];
        const si0 = Math.max(i0, Math.floor((Math.min(a[0], b[0]) - reach - X0) / H)), si1 = Math.min(i1, Math.ceil((Math.max(a[0], b[0]) + reach - X0) / H));
        const sj0 = Math.max(j0, Math.floor((Math.min(a[1], b[1]) - reach - Y0) / H)), sj1 = Math.min(j1, Math.ceil((Math.max(a[1], b[1]) + reach - Y0) / H));
        if (si1 < si0 || sj1 < sj0) continue;
        for (let j = sj0; j <= sj1; j++) {
          const y = Y0 + j * H, row = (j - j0) * W - i0;
          for (let i = si0; i <= si1; i++) {
            const d = segDist(X0 + i * H, y, a[0], a[1], b[0], b[1]) - hw;
            if (d >= FAR) continue;
            const k = row + i;
            if (stamp[k] !== tag) { stamp[k] = tag; tmp[k] = d; touched[n++] = k; } else if (d < tmp[k]) tmp[k] = d;
          }
        }
      }
      // join it to the streets already in the field with a round fillet
      for (let q = 0; q < n; q++) {
        const k = touched[q], b = tmp[k], a = field[k], o = owner[k];
        const r = o >= 0 ? pairR(chains[o], c) : 0;
        let v;
        if (r > 0 && a < r && b < r) { const ua = r - a, ub = r - b; v = r - Math.sqrt(ua * ua + ub * ub); } else v = a < b ? a : b;
        field[k] = v < FAR ? v : FAR;
        if (o < 0 || b < a) owner[k] = c.id;
      }
    }
    // marching squares on the tile's cells; each segment runs with the carriageway on its left
    const V = (i, j) => field[(j - j0) * W + i - i0];
    const hKey = (i, j) => (j * NI + i) * 2, vKey = (i, j) => (j * NI + i) * 2 + 1;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const a = V(i, j), b = V(i + 1, j), c = V(i + 1, j + 1), d = V(i, j + 1);
      const ia = a < 0, ib = b < 0, ic = c < 0, id = d < 0;
      const cs = (ia ? 1 : 0) | (ib ? 2 : 0) | (ic ? 4 : 0) | (id ? 8 : 0);
      if (cs === 0 || cs === 15) continue;
      // crossing points on the cell's edges: bottom, right, top, left
      const E = [];
      if (ia !== ib) { const t = a / (a - b); E[0] = [X0 + (i + t) * H, Y0 + j * H, hKey(i, j)]; }
      if (ib !== ic) { const t = b / (b - c); E[1] = [X0 + (i + 1) * H, Y0 + (j + t) * H, vKey(i + 1, j)]; }
      if (id !== ic) { const t = d / (d - c); E[2] = [X0 + (i + t) * H, Y0 + (j + 1) * H, hKey(i, j + 1)]; }
      if (ia !== id) { const t = a / (a - d); E[3] = [X0 + i * H, Y0 + (j + t) * H, vKey(i, j)]; }
      let pairs;
      if (cs === 5 || cs === 10) {
        const mIn = (a + b + c + d) / 4 < 0;
        // a, c inside (5): a joined centre cuts off corners b and d; b, d inside (10): the mirror
        pairs = (cs === 5) === mIn ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]];
      } else { const e = [0, 1, 2, 3].filter((q) => E[q]); pairs = [[e[0], e[1]]]; }
      for (const [p0, p1] of pairs) {
        let P0 = E[p0], P1 = E[p1];
        // orient: the field's gradient points out of the carriageway; it must lie on the segment's right
        const fx = ((P0[0] + P1[0]) / 2 - X0) / H - i, fy = ((P0[1] + P1[1]) / 2 - Y0) / H - j;
        const gx = (b - a) * (1 - fy) + (c - d) * fy, gy = (d - a) * (1 - fx) + (c - b) * fx;
        const dx = P1[0] - P0[0], dy = P1[1] - P0[1];
        if (dy * gx - dx * gy < 0) { const t = P0; P0 = P1; P1 = t; }
        segA.push(P0); segB.push(P1); segK0.push(P0[2]); segK1.push(P1[2]);
      }
    }
  }
  // ---- join the segments into polylines
  const start = new Map(); segK0.forEach((k, s) => start.set(k, s));
  const ends = new Map(); segK1.forEach((k, s) => ends.set(k, s));
  const used = new Uint8Array(segA.length);
  let lines = [];
  for (let s0 = 0; s0 < segA.length; s0++) {
    if (used[s0]) continue;
    // walk back to the start of an open line
    let s = s0, guard = 0;
    while (guard++ < segA.length) { const p = ends.get(segK0[s]); if (p == null || p === s0 || used[p]) break; s = p; }
    const first = s, pts = [[segA[s][0], segA[s][1]]];
    let closed = false;
    for (;;) {
      used[s] = 1; pts.push([segB[s][0], segB[s][1]]);
      const n = start.get(segK1[s]);
      if (n == null) break;
      if (n === first) { closed = true; break; }
      if (used[n]) break;
      s = n;
    }
    if (pts.length > 2) lines.push({ pts, closed });
  }
  log(`street kit: ${tilesDone} tiles, ${segA.length} contour cells, ${lines.length} kerb lines (${ms()}; lattice ${NI} x ${NJ})`);

  // ---- nearest-street lookups
  const cgrid = new SegGrid(16);
  for (const c of chains) for (let s = 0; s < Math.max(1, c.pts.length - 1); s++) { const a = c.pts[s], b = c.pts[Math.min(c.pts.length - 1, s + 1)]; cgrid.add(a[0], a[1], b[0], b[1], [c, s]); }
  const nearest = (x, y) => {
    let best = null, bd = Infinity;
    for (const [c, s] of cgrid.near(x, y, 1)) {
      const a = c.pts[s], b = c.pts[Math.min(c.pts.length - 1, s + 1)];
      const d = segDist(x, y, a[0], a[1], b[0], b[1]) - c.w / 2;
      if (d < bd) { bd = d; best = { c, a, b }; }
    }
    return best ? { ...best, d: bd } : null;
  };
  const mgrid = new SegGrid(24);
  for (const m of masks) for (let s = 0; s < m.pts.length - 1; s++) { const a = m.pts[s], b = m.pts[s + 1]; mgrid.add(a[0], a[1], b[0], b[1], [m, s]); }
  const masked = (x, y) => {
    for (const [m, s] of mgrid.near(x, y, 1)) { const a = m.pts[s], b = m.pts[s + 1]; if (segDist(x, y, a[0], a[1], b[0], b[1]) < m.w / 2 + 0.3) return true; }
    return false;
  };

  // ---- simplify (keep curves), drop what falls inside masked carriageways
  const dp = (pts, tol) => {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [i0, i1] = st.pop(); let md = -1, mi = -1;
      for (let i = i0 + 1; i < i1; i++) { const d = segDist(pts[i][0], pts[i][1], pts[i0][0], pts[i0][1], pts[i1][0], pts[i1][1]); if (d > md) { md = d; mi = i; } }
      if (md > tol) { keep[mi] = 1; st.push([i0, mi], [mi, i1]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  const pieces = [];
  const area = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  for (const L of lines) {
    let pts = L.pts;
    // a small closed loop with the carriageway outside it is a traffic island or a roundabout's centre: planted
    const island = L.closed && area(L.pts) < 0 && area(L.pts) > -1800;
    if (L.closed && pts.length > 3) pts = pts.slice(0, -1).concat([pts[0]]);
    pts = dp(pts, 0.03);
    // densify long straight runs so per-vertex attributes (footway, fillets, dropped kerbs) have somewhere to live
    const dense = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.floor(l / 6);
      for (let k = 1; k <= n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / (n + 1), a[1] + ((b[1] - a[1]) * k) / (n + 1)]);
      dense.push(b);
    }
    let cur = [];
    for (const p of dense) {
      if (masked(p[0], p[1])) { if (cur.length > 1) pieces.push(Object.assign(cur, { island })); cur = []; continue; }
      cur.push(p);
    }
    if (cur.length > 1) pieces.push(Object.assign(cur, { island }));
  }

  log(`street kit: ${pieces.length} pieces after masks (${ms()})`);
  // ---- per vertex: outward normal, gutter / fillet strip width, the street it belongs to and which side
  const lens = (pts) => { const s = [0]; for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return s; };
  const normalAt = (pts, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l]; // right of the direction = away from the carriageway
  };
  const K = [];
  for (const pts of pieces) {
    if (lens(pts).at(-1) < 1.5) continue;
    const info = pts.map((p, i) => {
      const n = normalAt(pts, i), nr = nearest(p[0], p[1]);
      const d = nr ? Math.max(0, nr.d) : 0;
      let left = 1, rank = 4, oneway = 0, surf = 0, edge = 1, lamp = 1, verge = 0;
      if (nr) {
        const { c, a, b } = nr; rank = c.rank; oneway = c.oneway; surf = c.surf; edge = c.edge ?? 1; lamp = c.lamp || 1; verge = c.verge || 0;
        left = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 0 ? 1 : 0;
      }
      // the community beyond the verge (its outline usually stops at the plots, metres behind the kerb)
      let fw = 2.0, fs = 0, minRank = 0;
      for (const o of [1.2, 4, 8]) { const v = sideAt([p[0] + n[0] * o, p[1] + n[1] * o]); if (v != null) { fw = v[0]; fs = v[1] || 0; minRank = v[2] || 0; break; } }
      if (nr && nr.c.rank < minRank) fw = 0; // quiet streets: the lawn verge runs from the kerb
      if (pts.island) fw = 0;
      // a footway OSM maps on its own already runs here: leave the verge planted
      if (fw > 0) for (const o of [1, 2.5, 4.5]) if (pathAt([p[0] + n[0] * o, p[1] + n[1] * o])) { fw = 0; break; }
      // a median: another carriageway just beyond the kerb leaves no room for a footway
      if (fw > 0) { const pr = nearest(p[0] + n[0] * (fw + 1.2), p[1] + n[1] * (fw + 1.2)); if (pr && pr.d < 0.8) fw = 0; }
      // edge lines: yellow along both kerbs of two-way streets; on one-way carriageways yellow on the left (the
      // median side) and white on the right; none on service lanes
      const c = rank <= 2 || !edge ? 0 : oneway ? (left ? 1 : 2) : 1;
      return { n, f: Math.min(9, Math.max(0.8, d + 0.45)), fw, fs: fw > 0 ? fs : 0, s: surf, c, left, rank, oneway, lamp, verge, island: !!pts.island };
    });
    K.push({ pts, info, gaps: [] });
  }

  log(`street kit: attributes (${ms()})`);
  // ---- driveways: the drive runs on to the kerb, which drops for it
  const kgrid = new SegGrid(16);
  K.forEach((k, ki) => { for (let i = 0; i < k.pts.length - 1; i++) { const a = k.pts[i], b = k.pts[i + 1]; kgrid.add(a[0], a[1], b[0], b[1], [ki, i]); } });
  const aprons = [];
  for (const dr of drives) {
    const ux = dr.b[0] - dr.a[0], uy = dr.b[1] - dr.a[1], L = Math.hypot(ux, uy); if (!(L >= 0.5 && L < 80)) continue; // no street within reach: no apron
    const dx = ux / L, dy = uy / L, reach = L + 16;
    let hit = null;
    const seen = new Set();
    for (let s = 0; s <= reach; s += 12) for (const it of kgrid.near(dr.a[0] + dx * s, dr.a[1] + dy * s, 1)) {
      const key = it[0] * 1e6 + it[1]; if (seen.has(key)) continue; seen.add(key);
      const pts = K[it[0]].pts, p = pts[it[1]], q = pts[it[1] + 1];
      const ex = q[0] - p[0], ey = q[1] - p[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-6) continue;
      const wx = p[0] - dr.a[0], wy = p[1] - dr.a[1];
      const t = (wx * ey - wy * ex) / den, u = (wx * dy - wy * dx) / den;
      if (t < L * 0.5 || t > reach || u < 0 || u > 1) continue;
      if (!hit || t < hit.t) hit = { t, ki: it[0], i: it[1], u };
    }
    if (!hit) continue;
    const kx = dr.a[0] + dx * hit.t, ky = dr.a[1] + dy * hit.t;
    aprons.push([dr.a[0], dr.a[1], kx, ky, dr.w, dr.tone || 0]);
    const k = K[hit.ki], sl = lens(k.pts);
    k.gaps.push([sl[hit.i] + (sl[hit.i + 1] - sl[hit.i]) * hit.u, dr.w / 2]);
  }
  // insert vertices at the ends of each drop and its ramps; drop value per vertex
  for (const k of K) {
    if (!k.gaps.length) { k.drop = k.pts.map(() => 0); continue; }
    const sl = lens(k.pts), cuts = [];
    for (const [sk, hw] of k.gaps) for (const o of [-(hw + 1.7), -(hw + 0.9), hw + 0.9, hw + 1.7]) { const s = sk + o; if (s > 0.05 && s < sl.at(-1) - 0.05) cuts.push(s); }
    cuts.sort((a, b) => a - b);
    const P = [], I = [], S = [];
    let ci = 0;
    for (let i = 0; i < k.pts.length; i++) {
      while (ci < cuts.length && i > 0 && cuts[ci] < sl[i]) {
        if (cuts[ci] > sl[i - 1] + 0.05 && cuts[ci] < sl[i] - 0.05) {
          const t = (cuts[ci] - sl[i - 1]) / (sl[i] - sl[i - 1]), a = k.pts[i - 1], b = k.pts[i];
          P.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); I.push(t < 0.5 ? k.info[i - 1] : k.info[i]); S.push(cuts[ci]);
        }
        ci++;
      }
      P.push(k.pts[i]); I.push(k.info[i]); S.push(sl[i]);
    }
    k.pts = P; k.info = I;
    k.drop = S.map((s) => {
      let v = 0;
      for (const [sk, hw] of k.gaps) { const e = Math.abs(s - sk); v = Math.max(v, e <= hw + 0.9 ? 1 : e >= hw + 1.7 ? 0 : (hw + 1.7 - e) / 0.8); }
      return v;
    });
  }

  log(`street kit: driveways (${ms()})`);
  // ---- street lamps in the verge: one side of residential streets every 30 m, the outer side of main roads every 34 m
  const lamps = [];
  for (const k of K) {
    const sl = lens(k.pts);
    let next = 12;
    for (let i = 0; i < k.pts.length; i++) {
      const inf = k.info[i];
      const wanted = inf.island || inf.rank <= 2 ? false : inf.rank <= 4 ? inf.left === 1 : inf.oneway ? inf.left === 0 : true;
      if (sl[i] < next) continue;
      if (!wanted || k.drop[i] > 0 || inf.f > 1.0) { next = sl[i] + 3; continue; }
      const off = inf.fw + 0.75, p = k.pts[i];
      lamps.push([p[0] + inf.n[0] * off, p[1] + inf.n[1] * off, Math.atan2(-inf.n[1], -inf.n[0]), inf.lamp]);
      next = sl[i] + (inf.lamp === 3 ? 26 : inf.rank <= 4 ? 30 : 34);
    }
  }

  // ---- palms along the lawn verges of the streets that have them (date palms about 8 m apart)
  const verge = [];
  for (const k of K) {
    const sl = lens(k.pts); let next = 4;
    for (let i = 0; i < k.pts.length; i++) {
      const inf = k.info[i]; if (sl[i] < next) continue;
      if (!inf.verge || inf.island || k.drop[i] > 0 || inf.f > 1.0) { next = sl[i] + 2; continue; }
      const off = inf.fw + 2.3, p = k.pts[i];
      verge.push([p[0] + inf.n[0] * off, p[1] + inf.n[1] * off]);
      next = sl[i] + 8 + ((i * 7) % 3);
    }
  }

  // ---- pieces of constant footway width, surface and line colour
  const kerbs = [];
  const r2 = (v) => Math.round(v * 100) / 100;
  for (const k of K) {
    let s0 = 0;
    const key = (inf) => inf.fw + '|' + inf.fs + '|' + inf.s + '|' + inf.c;
    for (let i = 1; i <= k.pts.length; i++) {
      if (i < k.pts.length && key(k.info[i]) === key(k.info[s0])) continue;
      const a = s0, b = Math.min(k.pts.length - 1, i); // share the boundary vertex with the next piece
      if (b > a) {
        const inf = k.info[a];
        kerbs.push({
          p: k.pts.slice(a, b + 1).map((p) => [r2(p[0]), r2(p[1])]),
          f: k.info.slice(a, b + 1).map((q) => Math.round(q.f * 10) / 10),
          d: k.drop.slice(a, b + 1).map((v) => Math.round(v * 10) / 10),
          fw: inf.fw, fs: inf.fs, s: inf.s, c: inf.c,
        });
      }
      s0 = i;
    }
  }
  return { kerbs, aprons, lamps, verge };
}
