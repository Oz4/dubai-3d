// Network elevation solver for road and rail centrelines.
//
// OSM `layer` only says which way passes over which; it is not a height. Solving heights way by way
// left steps wherever a layer-4 flyover met a layer-1 ramp, and short bridges dipped to the ground in
// the middle of an interchange. Here every node gets one height shared by all ways through it:
//   1. each in-plan crossing pins the upper way above the lower one with clearance,
//   2. bridges hold a cruise height away from the points where they land (and over water),
//   3. grade-limited cones turn those pins into ramps along whatever is connected
//      (max-plus propagation: h(v) = max(h(v), h(u) - grade * |uv|)),
//   4. valleys between two high points on elevated chains are filled, so viaducts stay level,
//   5. an upward-only smoothing pass rounds the vertical curves (it never steepens a grade),
// and repeats until every crossing has its clearance.

class Heap {
  constructor(max) { this.v = []; this.id = []; this.s = max ? 1 : -1; }
  get size() { return this.v.length; }
  push(val, id) {
    const v = this.v, d = this.id; let i = v.length; v.push(val * this.s); d.push(id);
    while (i > 0) { const p = (i - 1) >> 1; if (v[p] >= v[i]) break; [v[p], v[i]] = [v[i], v[p]]; [d[p], d[i]] = [d[i], d[p]]; i = p; }
  }
  pop() {
    const v = this.v, d = this.id; const top = [v[0] * this.s, d[0]];
    const lv = v.pop(), ld = d.pop();
    if (v.length) {
      v[0] = lv; d[0] = ld; let i = 0; const n = v.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < n && v[l] > v[m]) m = l; if (r < n && v[r] > v[m]) m = r;
        if (m === i) break; [v[m], v[i]] = [v[i], v[m]]; [d[m], d[i]] = [d[i], d[m]]; i = m;
      }
    }
    return top;
  }
}

function segX(p, q, r, s) {
  const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
  const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return [t, u];
}

/**
 * @param {object} o
 * @param {{nodes:number[], mode:string, bridge:boolean, order:number}[]} o.lines  ways (mutated: gets .ids)
 * @param {(id:number)=>number[]|null} o.pos   real node id -> [x, y]
 * @param {Record<string,{grade:number,cruise:number,water:number,envelope:number,deck:number}>} o.modes
 * @param {(p:number[])=>boolean} o.isWater
 * @param {(p:number[])=>boolean} o.inside     dead ends inside the area count as landings
 */
export function solveElevations({ lines, pos, modes, isWater, inside, extraLB = null, skip = [], step = 12, maxH = 34, log = console.log }) {
  const vpos = new Map(); let nextId = -1;
  const P = (id) => (id < 0 ? vpos.get(id) : pos(id));
  const vnode = (p) => { const id = nextId--; vpos.set(id, p); return id; };

  // 1. densify every way so ramps can bend between sparse OSM nodes
  for (const L of lines) {
    const src = L.nodes.filter((n) => pos(n));
    const ids = []; let len = 0;
    for (let i = 0; i < src.length; i++) {
      if (i > 0) {
        const a = pos(src[i - 1]), b = pos(src[i]);
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]); len += d;
        const n = Math.ceil(d / step);
        for (let k = 1; k < n; k++) ids.push(vnode([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]));
      }
      ids.push(src[i]);
    }
    L.ids = ids; L.len = len;
  }

  // 2. crossings between ways of different order that share no node: a node on each at the crossing
  const CELL = 40; const grid = new Map(); const segs = [];
  lines.forEach((L, li) => { for (let i = 0; i < L.ids.length - 1; i++) segs.push([li, i]); });
  segs.forEach((s, k) => {
    const L = lines[s[0]]; const a = P(L.ids[s[1]]), b = P(L.ids[s[1] + 1]);
    for (let gx = Math.floor(Math.min(a[0], b[0]) / CELL); gx <= Math.floor(Math.max(a[0], b[0]) / CELL); gx++)
      for (let gy = Math.floor(Math.min(a[1], b[1]) / CELL); gy <= Math.floor(Math.max(a[1], b[1]) / CELL); gy++) {
        const kk = `${gx},${gy}`; let c = grid.get(kk); if (!c) grid.set(kk, (c = [])); c.push(k);
      }
  });
  const inserts = new Map(); const crossings = []; const seen = new Set();
  const addIns = (li, si, t, id) => { let m = inserts.get(li); if (!m) inserts.set(li, (m = new Map())); let a = m.get(si); if (!a) m.set(si, (a = [])); a.push({ t, id }); };
  for (const cell of grid.values()) {
    for (let i = 0; i < cell.length; i++) for (let j = i + 1; j < cell.length; j++) {
      const sA = segs[cell[i]], sB = segs[cell[j]];
      if (sA[0] === sB[0]) continue;
      const LA = lines[sA[0]], LB = lines[sB[0]];
      if (LA.order === LB.order) continue; // at-grade crossings (or same level) need no separation
      const a0 = LA.ids[sA[1]], a1 = LA.ids[sA[1] + 1], b0 = LB.ids[sB[1]], b1 = LB.ids[sB[1] + 1];
      if (a0 === b0 || a0 === b1 || a1 === b0 || a1 === b1) continue;
      const pa = P(a0), pb = P(a1);
      const r = segX(pa, pb, P(b0), P(b1)); if (!r) continue;
      const key = cell[i] < cell[j] ? cell[i] * 1e7 + cell[j] : cell[j] * 1e7 + cell[i];
      if (seen.has(key)) continue; seen.add(key);
      const pt = [pa[0] + (pb[0] - pa[0]) * r[0], pa[1] + (pb[1] - pa[1]) * r[0]];
      // (crossings the data makes impossible, found by an earlier solve, are left at grade)
      if (skip.some((q) => Math.abs(q[0] - pt[0]) < 3 && Math.abs(q[1] - pt[1]) < 3)) continue;
      const ia = vnode(pt), ib = vnode(pt.slice());
      addIns(sA[0], sA[1], r[0], ia); addIns(sB[0], sB[1], r[1], ib);
      const [hi, lo, Lh, Ll] = LA.order > LB.order ? [ia, ib, LA, LB] : [ib, ia, LB, LA];
      crossings.push({ hi, lo, C: modes[Ll.mode].envelope + modes[Lh.mode].deck, hiLine: Lh, loLine: Ll });
    }
  }
  for (const [li, m] of inserts) {
    const L = lines[li]; const out = [];
    for (let i = 0; i < L.ids.length; i++) {
      out.push(L.ids[i]);
      const a = m.get(i); if (a) { a.sort((x, y) => x.t - y.t); for (const e of a) out.push(e.id); }
    }
    L.ids = out;
  }

  // 3. graph
  const adj = new Map(), badj = new Map(), lineOf = new Map();
  const link = (M, a, b, d, g) => { let x = M.get(a); if (!x) M.set(a, (x = [])); x.push({ to: b, d, g }); };
  for (const L of lines) {
    const g = modes[L.mode].grade;
    for (let i = 0; i < L.ids.length; i++) {
      const id = L.ids[i];
      let a = lineOf.get(id); if (!a) lineOf.set(id, (a = [])); if (!a.includes(L)) a.push(L);
      if (i === 0) continue;
      const u = L.ids[i - 1], pu = P(u), pv = P(id); const d = Math.hypot(pv[0] - pu[0], pv[1] - pu[1]);
      if (d < 1e-6 && u === id) continue;
      link(adj, u, id, d, g); link(adj, id, u, d, g);
      if (L.bridge) { link(badj, u, id, d, g); link(badj, id, u, d, g); }
    }
  }

  // 4. distance along bridges to where they land (meet a non-bridge way, or dead-end inside the area)
  const landDist = new Map();
  {
    const heap = new Heap(false);
    for (const [id, Ls] of lineOf) {
      if (!Ls.some((L) => L.bridge)) continue;
      const ground = Ls.some((L) => !L.bridge);
      // a road that dead-ends on a bridge has landed on something unmapped; rail sidings stay up
      const dead = (adj.get(id) || []).length <= 1 && inside(P(id)) && Ls.some((L) => L.bridge && modes[L.mode].deadEndLands !== false);
      if (ground || dead) { landDist.set(id, 0); heap.push(0, id); }
    }
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > landDist.get(u) + 1e-9) continue;
      for (const e of badj.get(u) || []) {
        const nd = d + e.d;
        if (nd < (landDist.has(e.to) ? landDist.get(e.to) : Infinity) - 1e-9) { landDist.set(e.to, nd); heap.push(nd, e.to); }
      }
    }
  }

  // 5. base lower bounds: cruise height away from landings, water clearance
  const LB = new Map();
  const raise = (M, id, v) => { if (v > (M.get(id) || 0)) M.set(id, Math.min(maxH, v)); };
  for (const L of lines) {
    if (!L.bridge) continue;
    const m = modes[L.mode];
    for (const id of L.ids) {
      const s = landDist.has(id) ? landDist.get(id) : Infinity;
      raise(LB, id, Math.min(m.cruise, m.grade * s));
      if (m.water && isWater(P(id))) raise(LB, id, m.water);
      if (extraLB) { const v = extraLB(L, P(id)); if (v) raise(LB, id, v); }
    }
  }

  function propagate(init) {
    const h = new Map(init); const heap = new Heap(true);
    for (const [id, v] of h) if (v > 0) heap.push(v, id);
    while (heap.size) {
      const [v, u] = heap.pop();
      if (v < (h.get(u) || 0) - 1e-9) continue;
      for (const e of adj.get(u) || []) {
        const c = v - e.g * e.d;
        if (c > (h.get(e.to) || 0) + 1e-6) { h.set(e.to, c); heap.push(c, e.to); }
      }
    }
    return h;
  }

  // valleys between two higher points on an elevated chain are filled to the lower of the two
  function fill(h) {
    const fadj = new Map();
    const add = (a, b) => { if (a === b) return; let x = fadj.get(a); if (!x) fadj.set(a, (x = new Set())); x.add(b); let y = fadj.get(b); if (!y) fadj.set(b, (y = new Set())); y.add(a); };
    for (const L of lines) {
      let use = L.bridge;
      // short ordinary ways between two raised ends (embankment links mid-viaduct) stay up too
      if (!use) use = (h.get(L.ids[0]) || 0) > 1 && (h.get(L.ids[L.ids.length - 1]) || 0) > 1 && L.len < 120;
      if (use) for (let i = 1; i < L.ids.length; i++) add(L.ids[i - 1], L.ids[i]);
    }
    const done = new Set(); const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
    let filled = 0;
    for (const [n, nb] of fadj) {
      if (nb.size === 2) continue;
      for (const m of nb) {
        if (done.has(ek(n, m))) continue;
        done.add(ek(n, m));
        const chain = [n]; let prev = n, cur = m;
        for (;;) {
          chain.push(cur);
          const nbs = fadj.get(cur); if (nbs.size !== 2) break;
          let next = null; for (const x of nbs) if (x !== prev) next = x;
          if (next == null || done.has(ek(cur, next))) break;
          done.add(ek(cur, next)); prev = cur; cur = next;
        }
        const c = chain, n2 = c.length; if (n2 < 3) continue;
        const v = c.map((id) => h.get(id) || 0);
        const pm = v.slice(), sm = v.slice();
        for (let i = 1; i < n2; i++) pm[i] = Math.max(pm[i - 1], v[i]);
        for (let i = n2 - 2; i >= 0; i--) sm[i] = Math.max(sm[i + 1], v[i]);
        for (let i = 1; i < n2 - 1; i++) { const f = Math.min(pm[i], sm[i]); if (f > v[i] + 1e-6) { h.set(c[i], f); filled++; } }
      }
    }
    return filled;
  }

  // upward-only smoothing: rounds crests and ramp feet; a node is only ever raised to its
  // neighbourhood mean, which can only flatten grades
  function smoothUp(h, iters) {
    for (let k = 0; k < iters; k++) {
      const cand = new Set();
      for (const [id, v] of h) if (v > 0.01) { cand.add(id); for (const e of adj.get(id) || []) cand.add(e.to); }
      const upd = [];
      for (const id of cand) {
        const nb = adj.get(id); if (!nb) continue;
        const v = h.get(id) || 0; let s = 2 * v, w = 2;
        for (const e of nb) { s += h.get(e.to) || 0; w++; }
        const m = s / w; if (m > v + 1e-4) upd.push([id, m]);
      }
      for (const [id, m] of upd) h.set(id, m);
    }
  }

  let h = null, it = 0, bad = [];
  for (it = 0; it < 24; it++) {
    h = propagate(LB);
    fill(h);
    h = propagate(h);
    smoothUp(h, 4);
    bad = [];
    for (const c of crossings) {
      const need = (h.get(c.lo) || 0) + c.C, have = h.get(c.hi) || 0;
      if (have < need - 0.05) { bad.push(c); raise(LB, c.hi, need); }
    }
    if (!bad.length) break;
  }
  const unresolved = crossings.filter((c) => (h.get(c.hi) || 0) < (h.get(c.lo) || 0) + c.C - 0.3);
  let top = 0; for (const v of h.values()) top = Math.max(top, v);
  log(`  elevation: ${lines.length} ways, ${crossings.length} grade-separated crossings, ${it + 1} passes, max ${top.toFixed(1)} m, unresolved ${unresolved.length}`);
  return { h, pos: P, crossings, unresolved, lineOf };
}
