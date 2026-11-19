// Order-flow engine: bars with per-price bid/ask volume, imbalances, value area, cluster search, simulated account.
// Pure logic (no DOM) so `node test_flow.js` can check it.

// ---------------------------------------------------------------- formatting
function fv(v) { // compact volume: 12, 1.5, 0.003, 12.4k, 3.1M
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 100 || Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  if (a >= 1) return v.toFixed(1);
  if (a >= .001) return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return a ? String(+v.toPrecision(2)) : '0'; // tiny crypto sizes, e.g. 0.00012
}
const decimalsOf = tick => { let d = 0; while (d < 8 && Math.abs(Math.round(tick * 10 ** d) - tick * 10 ** d) > 1e-9) d++; return d; };

// ---------------------------------------------------------------- bars
// cfg: {type: 'time'|'tick'|'volume'|'range', n}  (time: seconds; tick: trades; volume: contracts; range: ticks)
// bar: t0,t1 (ms) o h l c v d n bv av maxD minD cdo cdh cdl cdc vw sd lv(Map priceIndex -> [bid, ask, trades])
class Bars {
  constructor(cfg, tick, sessionStart) {
    this.cfg = cfg; this.tick = tick; this.list = []; this.cd = 0; this.sessionStart = sessionStart || (() => 0);
    this.sess = null; this.sv = 0; this.spq = 0; this.sp2q = 0; this.profile = new Map(); this.pver = 0;
  }
  key(t) { return Math.floor(t / (this.cfg.n * 1000)); }
  add(t, p, q, s) {
    const c = this.cfg, pi = Math.round(p / this.tick), ss = this.sessionStart(t);
    let b = this.list[this.list.length - 1];
    if (ss !== this.sess) { this.sess = ss; this.sv = this.spq = this.sp2q = 0; this.profile = new Map(); }
    const fresh = !b || ss !== b.ss ||
      (c.type === 'time' ? this.key(t) !== b.k :
        c.type === 'tick' ? b.n >= c.n :
          c.type === 'volume' ? b.v >= c.n :
            (Math.max(b.h, p) - Math.min(b.l, p)) / this.tick > c.n + 1e-9);
    if (fresh) {
      b = { t0: c.type === 'time' ? this.key(t) * c.n * 1000 : t, t1: t, k: c.type === 'time' ? this.key(t) : 0, ss,
        o: p, h: p, l: p, c: p, v: 0, d: 0, n: 0, bv: 0, av: 0, maxD: 0, minD: 0, cdo: this.cd, cdh: this.cd, cdl: this.cd, cdc: this.cd, lv: new Map(), ver: 0 };
      this.list.push(b);
    }
    b.t1 = t; b.c = p; if (p > b.h) b.h = p; if (p < b.l) b.l = p;
    b.v += q; b.n++; b.ver++;
    const dq = s > 0 ? q : -q;
    b.d += dq; if (s > 0) b.av += q; else b.bv += q;
    if (b.d > b.maxD) b.maxD = b.d; if (b.d < b.minD) b.minD = b.d;
    this.cd += dq; b.cdc = this.cd; if (this.cd > b.cdh) b.cdh = this.cd; if (this.cd < b.cdl) b.cdl = this.cd;
    let L = b.lv.get(pi); if (!L) b.lv.set(pi, L = [0, 0, 0]);
    L[s > 0 ? 1 : 0] += q; L[2]++;
    let P = this.profile.get(pi); if (!P) this.profile.set(pi, P = [0, 0]);
    P[s > 0 ? 1 : 0] += q; this.pver++;
    this.sv += q; this.spq += p * q; this.sp2q += p * p * q; // session VWAP + standard deviation
    b.vw = this.spq / this.sv; b.sd = Math.sqrt(Math.max(0, this.sp2q / this.sv - b.vw * b.vw));
    return fresh;
  }
  // index of the bar holding time t (last bar with t0 <= t), -1 before the first
  at(t) { let lo = 0, hi = this.list.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (this.list[m].t0 <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
}

// rows of a bar for a given "ticks per row" (cached until the bar changes)
function rowsOf(b, rt) {
  if (b._rt === rt && b._rv === b.ver) return b._r;
  const m = new Map();
  for (const [pi, L] of b.lv) { const r = Math.floor(pi / rt); let x = m.get(r); if (!x) m.set(r, x = [0, 0, 0]); x[0] += L[0]; x[1] += L[1]; x[2] += L[2]; }
  let maxV = 0, poc = null, maxD = 0;
  for (const [r, x] of m) { const v = x[0] + x[1]; if (v > maxV) { maxV = v; poc = r; } maxD = Math.max(maxD, Math.abs(x[1] - x[0])); }
  b._rt = rt; b._rv = b.ver; b._r = { m, maxV, poc, maxD };
  return b._r;
}

// diagonal imbalance: ask at row r vs bid at row r-1 (buyers lifting), bid at r vs ask at r+1 (sellers hitting)
// ratio in % (150 = 1.5x), minVol = ignore when the dominant side is smaller, ignoreZero = an empty opposite level is no imbalance.
// Returns Map row -> +1 ask imbalance, -1 bid, 2 both
function imbalances(rows, ratio, minVol, ignoreZero) {
  const out = new Map(), k = ratio / 100;
  for (const [r, x] of rows.m) {
    const below = rows.m.get(r - 1), above = rows.m.get(r + 1);
    const ab = below ? below[0] : 0, aa = above ? above[1] : 0;
    let f = 0;
    if (x[1] > 0 && x[1] >= minVol && (ab === 0 ? !ignoreZero : x[1] >= ab * k)) f = 1;
    if (x[0] > 0 && x[0] >= minVol && (aa === 0 ? !ignoreZero : x[0] >= aa * k)) f = f ? 2 : -1;
    if (f) out.set(r, f);
  }
  return out;
}
// runs of >= n consecutive same-side imbalances -> zones {lo, hi, side}
function stacked(imb, n) {
  const zones = [];
  for (const side of [1, -1]) {
    const rows = [...imb].filter(([, f]) => f === side || f === 2).map(([r]) => r).sort((a, b) => a - b);
    let s = 0;
    for (let i = 1; i <= rows.length; i++) if (i === rows.length || rows[i] !== rows[i - 1] + 1) { if (i - s >= n) zones.push({ lo: rows[s], hi: rows[i - 1], side }); s = i; }
  }
  return zones;
}

// value area (default 70%) of a Map key -> volume (number or [bid, ask])
function valueArea(m, pct = 70) {
  const keys = [...m.keys()].sort((a, b) => a - b); if (!keys.length) return null;
  const vol = k => { const x = m.get(k); return x == null ? 0 : typeof x === 'number' ? x : x[0] + x[1]; };
  let tot = 0, poc = keys[0]; for (const k of keys) { tot += vol(k); if (vol(k) > vol(poc)) poc = k; }
  let i = keys.indexOf(poc), j = i, acc = vol(poc);
  while (acc < tot * pct / 100 && (i > 0 || j < keys.length - 1)) {
    const dn = i > 0 ? vol(keys[i - 1]) : -1, up = j < keys.length - 1 ? vol(keys[j + 1]) : -1;
    if (up >= dn) acc += vol(keys[++j]); else acc += vol(keys[--i]);
  }
  return { poc, val: keys[i], vah: keys[j], total: tot };
}

// ---------------------------------------------------------------- cluster search (settings follow ATAS's Cluster Search)
// s: {type: volume|delta|bid|ask|trades, min, max (null = off), deltaPct (0 = off; +75 = ask >= 75% of the level, -75 = bid), dir: any|bull|bear,
//     loc: any|high|low|body|upperWick|lowerWick, range (rows summed), one (one match per bar)}
function clusterSearch(b, rows, rt, tick, s) {
  const out = [], R = Math.max(1, s.range | 0), rs = rt * tick;
  if (s.dir === 'bull' && b.c <= b.o) return out; if (s.dir === 'bear' && b.c >= b.o) return out;
  const hiR = Math.floor(Math.round(b.h / tick) / rt), loR = Math.floor(Math.round(b.l / tick) / rt);
  const top = Math.max(b.o, b.c), bot = Math.min(b.o, b.c);
  for (let r = loR; r <= hiR - R + 1; r++) {
    let bid = 0, ask = 0, n = 0;
    for (let k = 0; k < R; k++) { const x = rows.m.get(r + k); if (x) { bid += x[0]; ask += x[1]; n += x[2]; } }
    const vol = bid + ask; if (!vol) continue;
    const v = { volume: vol, delta: ask - bid, bid, ask, trades: n }[s.type || 'volume'];
    if (s.min != null && s.min !== '' && v < +s.min) continue;
    if (s.max != null && s.max !== '' && v > +s.max) continue;
    const dp = (ask - bid) / vol * 100;
    if (+s.deltaPct > 0 && dp < +s.deltaPct) continue;
    if (+s.deltaPct < 0 && dp > +s.deltaPct) continue;
    const pLo = r * rs, pHi = (r + R) * rs - tick;
    const ok = { any: true, high: pHi >= b.h, low: pLo <= b.l, body: pLo >= bot - 1e-9 && pHi <= top + 1e-9, upperWick: pLo > top, lowerWick: pHi < bot }[s.loc || 'any'];
    if (ok) out.push({ r, R, v });
  }
  if (s.one && out.length > 1) { out.sort((a, b) => Math.abs(b.v) - Math.abs(a.v)); out.length = 1; }
  return out;
}

// ---------------------------------------------------------------- simulated account (fills against the live / replayed tape)
// orders: {id, side, type: market|limit|stop, price, qty, oco}; brackets in ticks are attached on the entry fill
class Sim {
  constructor(state, spec) { Object.assign(this, { bal0: 50000, real: 0, comm: 0, pos: 0, avg: 0, orders: [], fills: [], seq: 0, day: '' }, state || {}); this.spec = spec; }
  get state() { const { spec, ...s } = this; return s; }
  pnl(last) { return this.pos && last != null ? (last - this.avg) * this.pos * this.spec().pv : 0; }
  place(o, bb, ba, last) {
    const x = { id: ++this.seq, ...o };
    if (x.type === 'market') { const p = x.side > 0 ? (ba ?? last) : (bb ?? last); if (p == null) throw new Error('No price yet'); this.fill(x, p); return x; }
    this.orders.push(x); return x;
  }
  cancel(f) { this.orders = this.orders.filter(o => !f(o)); }
  onTrade(p) { // limit: fills when traded through or at the price; stop: triggers when touched, fills at the trade price
    for (const o of [...this.orders]) {
      if (!this.orders.includes(o)) continue;
      const hit = o.type === 'limit' ? (o.side > 0 ? p <= o.price : p >= o.price) : (o.side > 0 ? p >= o.price : p <= o.price);
      if (hit) { this.orders.splice(this.orders.indexOf(o), 1); this.fill(o, o.type === 'limit' ? o.price : p); }
    }
  }
  fill(o, p) {
    const sp = this.spec(), q = o.side * o.qty, before = this.pos;
    this.comm += (sp.comm || 0) * o.qty;
    if (!before || Math.sign(before) === o.side) { this.avg = (this.avg * Math.abs(before) + p * o.qty) / (Math.abs(before) + o.qty); this.pos = before + q; }
    else {
      const closed = Math.min(Math.abs(before), o.qty);
      this.real += (p - this.avg) * Math.sign(before) * closed * sp.pv;
      this.pos = before + q;
      if (Math.sign(this.pos) === o.side && this.pos) this.avg = p; // flipped through zero
      if (!this.pos) this.avg = 0;
    }
    this.fills.push({ t: Date.now(), side: o.side, qty: o.qty, price: p, id: o.id });
    if (o.oco) this.orders = this.orders.filter(x => x.oco !== o.oco);
    if (!this.pos) this.orders = this.orders.filter(x => !x.bracket);
    if ((o.sl || o.tp) && this.pos && Math.sign(this.pos) === o.side) { // attach the bracket to this entry
      const oco = 'b' + o.id, t = sp.tick;
      if (o.tp) this.orders.push({ id: ++this.seq, side: -o.side, type: 'limit', price: +(p + o.side * o.tp * t).toFixed(10), qty: o.qty, oco, bracket: 1 });
      if (o.sl) this.orders.push({ id: ++this.seq, side: -o.side, type: 'stop', price: +(p - o.side * o.sl * t).toFixed(10), qty: o.qty, oco, bracket: 1 });
    }
  }
}

if (typeof module !== 'undefined') module.exports = { fv, decimalsOf, Bars, rowsOf, imbalances, stacked, valueArea, clusterSearch, Sim };
