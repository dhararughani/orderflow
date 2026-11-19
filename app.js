// OrderFlow UI: footprint / heatmap chart, profiles, cluster statistic, indicators, Smart DOM, Smart Tape, Chart Trader, replay.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = m => { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => t.style.display = 'none', 4000); };
async function api(u, body) {
  const r = await fetch(u, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

// ---------------------------------------------------------------- settings (data/settings.json)
const PRESETS = [ // the Cluster Search templates from the user's ATAS install
  { name: 'Ask Imbalance (NQ)', on: false, type: 'volume', min: 200, max: '', deltaPct: 75, dir: 'any', loc: 'any', range: 1, one: true, color: '#4bacc6', shape: 'rect', alert: false },
  { name: 'Bid Imbalance (NQ)', on: false, type: 'volume', min: 200, max: '', deltaPct: -75, dir: 'any', loc: 'any', range: 1, one: true, color: '#c0504d', shape: 'rect', alert: false },
  { name: 'Large Volume (BTC)', on: false, type: 'volume', min: 1000, max: '', deltaPct: 0, dir: 'any', loc: 'any', range: 5, one: true, color: '#f79646', shape: 'circle', alert: false },
  { name: 'Strong Negative Delta (ES)', on: false, type: 'delta', min: '', max: -500, deltaPct: 0, dir: 'any', loc: 'any', range: 1, one: true, color: '#ff4d6d', shape: 'circle', alert: false },
  { name: 'Strong Positive Delta (ES)', on: false, type: 'delta', min: 500, max: '', deltaPct: 0, dir: 'any', loc: 'any', range: 1, one: true, color: '#2ee6a6', shape: 'circle', alert: false },
];
const DEF = {
  src: 'bybit', sym: 'BTCUSDT', syms: { rithmic: 'NQ', bybit: 'BTCUSDT', bitfinex: 'BTCUSD' }, tf: { type: 'time', n: 60 }, rowTicks: 0, mode: 'bidask', visual: 'fill',
  barW: 96, rowH: 16, rightPad: 140,
  show: { heat: true, profile: true, domHist: true, big: true, vwap: true, stats: true, delta: true, cvd: true, vol: false, liq: true, sweep: true, ice: true, stopRun: true, exh: true, dturn: true, tapePat: true, domLv: true, imb: true, stack: true, search: true, dom: true, tape: true, trader: true, grid: true, poc: true, va: false },
  imb: { ratio: 150, min: 0, ignoreZero: false }, stackN: 3,
  heat: { contrast: 35, cut: 20, keepMin: 120, mode: 'total' }, profile: { src: 'session', type: 'volume', va: 70, w: 150 },
  big: { min: 0 }, sweep: { levels: 4 }, ice: { mult: 2 }, stopRun: { ms: 300, rows: 5, mult: 10 }, exh: { pct: 10, lv: 2 }, tapePat: { n: 5, ms: 2000, min: 0 }, domLv: { mult: 10 }, tape: { ms: 100, min: 0, max: 0, alerts: [{ min: 0, color: '#2c2c60', sound: false }, { min: 0, color: '#50582d', sound: false }, { min: 0, color: '#6c3c5a', sound: false }, { min: 0, color: '#39635a', sound: false }] },
  searches: PRESETS, risk: { on: false, maxLoss: 500, maxQty: 5, flatten: true }, comm: { NQ: 2, ES: 2, MNQ: .5, MES: .5 },
  trader: { account: 'sim', qty: 1, sl: 0, tp: 0 }, record: true, histHours: 8, histMin: 30, rithmicAuto: false, draw: {},
  histDays: 1, keepHours: 48, cacheMin: 120, recFrom: '00:00', recTo: '00:00', ret: { days: 14, gb: 4 }, bg: { on: false, syms: ['BTCUSDT'] },
};
let CFG;
const PANE = +new URLSearchParams(location.search).get('pane') || 0; // multi-chart: each chart is this page in an iframe with its own settings
const STORE = PANE ? 'pane' + PANE : 'settings';
const merge = (d, s) => { const o = structuredClone(d); for (const k in s || {}) o[k] = d[k] && typeof d[k] === 'object' && !Array.isArray(d[k]) ? merge(d[k], s[k]) : s[k]; return o; };
let saveT;
const saveCfg = () => { clearTimeout(saveT); saveT = setTimeout(() => api('/store/' + STORE, CFG).catch(e => toast('Settings not saved: ' + e.message)), 400); };

// ---------------------------------------------------------------- market state
let INST = { rithmic: [], bybit: [] }, RECS = [];
const M = { t: [], p: [], q: [], s: [], bids: new Map(), asks: new Map(), bb: null, ba: null, last: null, now: 0, frames: [], fT: 0, big: [], tape: [], bars: null, live: false, hist: true, alerted: new Set() };
const spec = () => {
  const src = CFG.src === 'replay' ? (M.rsrc || 'bybit') : CFG.src;
  const i = (INST[src] || []).find(x => x.sym === M.sym) || { tick: M.sym && /USDT$/.test(M.sym) ? .1 : .25, pv: 1 };
  return { tick: i.tick, pv: i.pv, comm: CFG.comm[M.sym] || 0, dec: decimalsOf(i.tick) };
};
const fp = p => p == null ? '—' : (+p).toFixed(spec().dec);
const nyFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const nyDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
const fT = (ms, sec = true) => { const s = nyFmt.format(ms); return sec ? s : s.slice(0, 5); };
const offC = {};
function nyOff(t) { const k = Math.floor(t / 36e5); if (offC[k] == null) { const p = Object.fromEntries(nyDay.formatToParts(k * 36e5).map(x => [x.type, x.value])); offC[k] = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24) - k * 36e5; } return offC[k]; }
// session id: futures roll at 18:00 New York, crypto at 00:00 UTC
const crypto_ = () => ['bybit', 'bitfinex'].includes(CFG.src === 'replay' ? M.rsrc : CFG.src);
const sessionOf = t => crypto_() ? Math.floor(t / 864e5) : Math.floor((t + nyOff(t) + 6 * 36e5) / 864e5);

function resetMarket() {
  Object.assign(M, { t: [], p: [], q: [], s: [], bids: new Map(), asks: new Map(), bb: null, ba: null, last: null, now: 0, frames: [], fT: 0, big: [], tape: [], live: false, hist: true, alerted: new Set(), bigCur: null, tapeCur: null, hmMax: 0, orders: new Map(), liqs: [], sweeps: [], icebergs: [], ice: new Map(), lvSeen: new Map(), prevLive: null, late: null });
  rebuild();
}
function rebuild() {
  const sp = spec();
  M.bars = new Bars(CFG.tf, sp.tick, sessionOf);
  M.big = []; M.bigCur = null; M.sweeps = []; M.stopRuns = []; M.sr = null; M.tps = []; M.tpc = null; autoBig();
  for (let i = 0; i < M.t.length; i++) { M.bars.add(M.t[i], M.p[i], M.q[i], M.s[i]); bigTrade(M.t[i], M.p[i], M.q[i], M.s[i]); flowTrade(M.t[i], M.p[i], M.q[i], M.s[i]); }
  autoRows(); dirty = true;
}
// Big Trades threshold: the setting, or 0 = automatic (the largest ~0.3% of recent trades, so it suits BTC and XRP alike)
const bigMin = () => CFG.big.min || M.bigAuto || Infinity;
function autoBig() { const n = M.q.length; if (n < 300) return; const x = M.q.slice(-30000).sort((a, b) => a - b); M.bigAuto = x[Math.floor(x.length * .997)]; }
function autoRows() { // "auto" ticks per row: keep a typical bar about 25 rows tall
  if (CFG.rowTicks) { M.rt = CFG.rowTicks; return; }
  const L = M.bars.list.slice(-60), tick = spec().tick;
  const rng = L.map(b => (b.h - b.l) / tick).sort((a, b) => a - b)[L.length >> 1] || 10;
  M.rt = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find(x => rng / x <= 25) || 5000;
}
// cumulative trades (same ms + side) above the Big Trades filter
function bigTrade(t, p, q, s) {
  const c = M.bigCur;
  if (c && c.t === t && c.s === s) { c.q += q; c.pq += p * q; c.p = c.pq / c.q; c.lo = Math.min(c.lo, p); c.hi = Math.max(c.hi, p); return; }
  if (c && c.q >= bigMin()) M.big.push({ t: c.t, p: c.p, q: c.q, s: c.s });
  if (c) sweepCheck(c);
  M.bigCur = { t, s, q, pq: p * q, p, lo: p, hi: p };
}
function tapeTrade(t, p, q, s) { // Smart Tape: trades of one side within the interval are summed into one print
  const c = M.tapeCur;
  if (c && c.s === s && t - c.t0 <= CFG.tape.ms) { c.q += q; c.p = p; c.n++; c.t = t; return; }
  if (c) { M.tape.push(c); if (M.tape.length > 2000) M.tape.splice(0, 500); tapeAlert(c); }
  M.tapeCur = { t0: t, t, p, q, s, n: 1, bb: M.bb, ba: M.ba };
}

// ---------------------------------------------------------------- incoming stream
let ws, wsWant = null;
function connect() {
  const want = { cmd: 'sub', src: CFG.src, sym: M.sym };
  if (CFG.src === 'replay') { const f = $('recFile').value; if (!f) { setFeed('No recordings yet', 'amber'); return; } const r = RECS.find(x => x.file === f); want.file = f; want.sym = r.sym; M.sym = r.sym; M.rsrc = r.src; want.speed = +$('rpSpeed').value; }
  wsWant = want; M.wait = want.sym; resetMarket(); // ignore the old feed's in-flight batches until the new one confirms
  if (ws && ws.readyState === 1) return ws.send(JSON.stringify(want));
  if (ws && ws.readyState === 0) return;
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => wsWant && ws.send(JSON.stringify(wsWant));
  ws.onclose = () => { setFeed('disconnected', 'bad'); setTimeout(() => { ws = null; if (wsWant) connect(); }, 2000); };
  ws.onmessage = e => { const d = JSON.parse(e.data); if (d.status) return onStatus(d); ingest(d); };
}
function setFeed(t, c) { const s = $('stFeed'); s.textContent = t; s.className = 'pill ' + (c || ''); }
function onStatus(d) {
  if (d.status === 'error') { setFeed('error', 'bad'); toast(d.error); return; }
  if (d.sym && M.wait) { if (d.sym !== M.wait) return; M.wait = null; resetMarket(); }
  if (d.status === 'live' || d.status === 'replay') { M.hist = false; M.live = true; }
  if (/^loading history/.test(d.status) && M.live) return setFeed(`${M.sym} · live · ${d.status.slice(8)}…`, 'live');
  setFeed(`${CFG.src === 'replay' ? 'Replay · ' + M.sym : M.sym} · ${d.status}`, d.status === 'live' || d.status === 'replay' ? 'live' : d.status === 'reconnecting' ? 'bad' : 'amber');
  if (d.error) toast(d.error);
}
function ingest(d) {
  if (M.wait) return;
  if (d.histDone) { // older days arrived behind the live chart: they all precede it, so prepend once and rebuild
    const L_ = M.late; M.late = null;
    if (L_ && L_.length) { M.t = L_.map(x => x[0]).concat(M.t); M.p = L_.map(x => x[1]).concat(M.p); M.q = L_.map(x => x[2]).concat(M.q); M.s = L_.map(x => x[3]).concat(M.s); rebuild(); }
    setFeed(`${M.sym} · live`, 'live'); return;
  }
  if (d.hist && M.live) { (M.late || (M.late = [])).push(...d.tr); return; }
  if (d.hist) { // backfill: may arrive after some live trades -> merge in time order
    const tr = d.tr; if (!tr.length) return;
    if (M.t.length && tr[0][0] < M.t[M.t.length - 1]) {
      const all = tr.concat(M.t.map((t, i) => [t, M.p[i], M.q[i], M.s[i]])).sort((a, b) => a[0] - b[0]);
      M.t = all.map(x => x[0]); M.p = all.map(x => x[1]); M.q = all.map(x => x[2]); M.s = all.map(x => x[3]);
      if (!M.reb) M.reb = setTimeout(() => { M.reb = null; rebuild(); }, 50);
    } else for (const [t, p, q, s] of tr) { pushTrade(t, p, q, s, true); }
    M.last = M.p[M.p.length - 1]; dirty = true; return;
  }
  if (d.full) { M.bids.clear(); M.asks.clear(); }
  if (d.obf) { M.orders.clear(); for (const [id, p, a] of d.obf) M.orders.set(id, [p, a]); }
  for (const [id, p, a] of d.ob || []) p ? M.orders.set(id, [p, a]) : M.orders.delete(id);
  for (const [p, q] of d.bd || []) q > 0 ? M.bids.set(p, q) : M.bids.delete(p);
  for (const [p, q] of d.ad || []) q > 0 ? M.asks.set(p, q) : M.asks.delete(p);
  M.bb = d.bb ?? M.bb; M.ba = d.ba ?? M.ba; M.now = d.T;
  for (const x of d.lq || []) M.liqs.push(x);
  for (const [t, p, q, s] of d.tr || []) pushTrade(t, p, q, s, false);
  captureFrame(d.T);
  if (CFG.src === 'replay') $('rpClock').textContent = fT(d.T);
  dirty = true;
}
function pushTrade(t, p, q, s, hist) {
  M.t.push(t); M.p.push(p); M.q.push(q); M.s.push(s); M.last = p;
  const fresh = M.bars.add(t, p, q, s); bigTrade(t, p, q, s); flowTrade(t, p, q, s);
  if (fresh && M.bars.list.length % 20 === 0) { autoRows(); if (!CFG.big.min) autoBig(); }
  if (!hist) { tapeTrade(t, p, q, s); SIM.onTrade(p); simChanged(); if (fresh) checkSearchAlerts(M.bars.list.length - 2); checkPriceAlerts(p); iceTrack(t, p, q, s); }
}
// heatmap: book snapshot every 500 ms (stream time, so replay at any speed works), nearest 150 levels per side
function captureFrame(T) {
  if (!M.bids.size && !M.asks.size) return;
  if (T - M.fT < 500) return;
  M.fT = T;
  const b = [...M.bids].sort((x, y) => y[0] - x[0]).slice(0, 150), a = [...M.asks].sort((x, y) => x[0] - y[0]).slice(0, 150), n = b.length + a.length;
  const fr = { t: T, p: new Float32Array(n), q: new Float32Array(n), nb: b.length };
  let i = 0; for (const [p, q] of b) { fr.p[i] = p; fr.q[i++] = q; } for (const [p, q] of a) { fr.p[i] = p; fr.q[i++] = q; }
  if (M.orders.size) { // order-by-order: also keep the largest single order at each price
    const mo = new Map(); for (const [p, a] of M.orders.values()) mo.set(p, Math.max(mo.get(p) || 0, Math.abs(a)));
    fr.m = new Float32Array(n); for (let k = 0; k < n; k++) fr.m[k] = mo.get(fr.p[k]) || fr.q[k];
  }
  M.frames.push(fr);
  const keep = CFG.heat.keepMin * 120; if (M.frames.length > keep * 1.1) M.frames.splice(0, M.frames.length - keep);
}

// ---------------------------------------------------------------- chart geometry
const cv = $('cv'), ctx = cv.getContext('2d');
let dirty = true, W = 0, H = 0, DPR = 1, L = {};
const view = { off: 0, center: null, follow: true };
const AXIS = 76, TIMEH = 20;
function layout() {
  const st = CFG.show, panes = [];
  if (st.stats) panes.push(['stats', 9 * 14 + 4]);
  for (const sc of scriptPanes()) panes.push(['sc:' + sc.id, 80]);
  if (st.delta) panes.push(['delta', 70]); if (st.cvd) panes.push(['cvd', 80]); if (st.vol) panes.push(['vol', 60]);
  const below = panes.reduce((a, x) => a + x[1], 0);
  L = { cw: W - AXIS, top: 0, mh: Math.max(120, H - TIMEH - below), panes: [] };
  let y = L.mh + TIMEH;
  for (const [k, h] of panes) { L.panes.push({ k, y, h }); y += h; }
}
const N = () => M.bars.list.length;
const xR = i => L.cw - CFG.rightPad - (N() - 1 - i - view.off) * CFG.barW; // right edge of bar i
const iAt = x => N() - 1 - Math.floor((L.cw - CFG.rightPad + view.off * CFG.barW - x) / CFG.barW);
const rowSize = () => spec().tick * M.rt;
const yRow = r => L.mh / 2 - (r - view.center) * CFG.rowH; // centre of row r
const yP = p => yRow(p / rowSize() - (M.rt > 1 ? .5 : 0)); // price -> y (a row holds [r*size, (r+1)*size))
const pAt = y => (view.center + (L.mh / 2 - y) / CFG.rowH) * rowSize();
const rowOfP = p => Math.floor(Math.round(p / spec().tick) / M.rt);
function barEnd(i) { const b = M.bars.list[i]; return CFG.tf.type === 'time' ? b.t0 + CFG.tf.n * 1000 : i < N() - 1 ? M.bars.list[i + 1].t0 : Math.max(b.t1, M.now || b.t1); }
function xT(t) { const i = M.bars.at(t); if (i < 0) return null; const b = M.bars.list[i], e = barEnd(i); return xR(i) - CFG.barW + CFG.barW * Math.min(1, (t - b.t0) / Math.max(1, e - b.t0)); }
function follow() {
  if (M.last == null) return;
  const r = M.last / rowSize();
  if (view.center == null) view.center = r;
  if (view.follow) { const span = L.mh / CFG.rowH / 2; if (Math.abs(r - view.center) > span * .6) view.center = r; }
}

// ---------------------------------------------------------------- painting
const C = { bg: '#151b26', grid: '#1e2636', text: '#c8cdd6', mut: '#7d889c', buy: '#089981', sell: '#f2385a', buyT: '#2ee6a6', sellT: '#ff6b84', acc: '#2196f3', poc: '#ffd54f' };
function paint() {
  const r = cv.getBoundingClientRect(); DPR = devicePixelRatio || 1;
  if (cv.width !== Math.round(r.width * DPR) || cv.height !== Math.round(r.height * DPR)) { cv.width = Math.round(r.width * DPR); cv.height = Math.round(r.height * DPR); }
  W = r.width; H = r.height; layout();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  if (!M.bars || !N()) { ctx.fillStyle = C.mut; ctx.font = '14px Segoe UI'; ctx.textAlign = 'center'; ctx.fillText(M.live ? 'Waiting for trades…' : 'Loading…', W / 2, H / 2); return; }
  follow();
  const i0 = Math.max(0, iAt(0)), i1 = Math.min(N() - 1, iAt(L.cw));
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, L.cw, L.mh); ctx.clip();
  if (CFG.show.grid) grid();
  if (CFG.show.heat) heatmap();
  if (CFG.show.profile) profile(i0, i1);
  if (CFG.show.stack || CFG.show.imb) stackedZones(i0, i1);
  for (let i = i0; i <= i1; i++) drawBar(i);
  if (CFG.show.vwap) vwap(i0, i1);
  drawScripts(i0, i1);
  if (CFG.show.search) searches(i0, i1);
  if (CFG.show.big) bigTrades(i0, i1);
  flowMarks(i0, i1); flowMarks2(i0, i1);
  drawings(); drawAlerts(); ordersOnChart();
  if (CFG.show.domHist) domHist();
  lastLine();
  ctx.restore();
  priceAxis(); timeAxis(i0, i1);
  for (const p of L.panes) pane(p, i0, i1);
  crosshair();
}
function grid() {
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath();
  const st = labelStep(); const r0 = Math.floor(view.center - L.mh / 2 / CFG.rowH), r1 = Math.ceil(view.center + L.mh / 2 / CFG.rowH);
  for (let r = Math.ceil(r0 / st) * st; r <= r1; r += st) { const y = Math.round(yRow(r)) + .5; ctx.moveTo(0, y); ctx.lineTo(L.cw, y); }
  ctx.stroke();
}
// grid / label step in rows: the smallest round price step (1, 2, 2.5, 5 x 10^k) that is at least 22 px tall
function labelStep() {
  const rs = rowSize();
  for (let e = -8; e <= 8; e++) for (const m of [1, 2, 2.5, 5]) { const st = m * 10 ** e / rs; if (st >= 1 && Math.abs(st - Math.round(st)) < 1e-6 && st * CFG.rowH >= 22) return Math.round(st); }
  return Math.max(1, Math.ceil(22 / CFG.rowH));
}

// heat colour table: background -> blue -> cyan -> yellow -> orange -> red
const LUT = (() => {
  const st = [[0, 21, 27, 38], [.12, 16, 38, 84], [.32, 0, 92, 170], [.52, 0, 180, 200], [.72, 236, 220, 60], [.88, 255, 140, 30], [1, 255, 56, 40]], out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255, k = st.findIndex(s => s[0] >= x), a = st[Math.max(0, k - 1)], b = st[k], f = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
    const c = [1, 2, 3].map(j => Math.round(a[j] + (b[j] - a[j]) * f));
    out[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
  }
  return out;
})();
const hcv = document.createElement('canvas'), hctx = hcv.getContext('2d');
function heatmap() {
  if (!M.frames.length) return;
  const w = Math.max(1, Math.floor(L.cw)), h = Math.max(1, Math.floor(L.mh));
  if (hcv.width !== w || hcv.height !== h) { hcv.width = w; hcv.height = h; }
  const img = hctx.createImageData(w, h), u = new Uint32Array(img.data.buffer), F = M.frames, tick = spec().tick;
  const scale = Math.max(1e-9, (M.hmMax || 1) * (100 - CFG.heat.cut) / 100), gam = 1 - CFG.heat.contrast / 150;
  const vals = new Float32Array(h), col = new Uint32Array(h); let lastF = -2, maxSeen = 0;
  for (let x = 0; x < w; x++) {
    const i = iAt(x); if (i < 0 || i >= N()) { continue; }
    const b = M.bars.list[i], e = barEnd(i), t = b.t0 + (x - (xR(i) - CFG.barW)) / CFG.barW * (e - b.t0);
    if (i === N() - 1 && t > (M.now || b.t1)) continue;
    let lo = 0, hi = F.length - 1, f = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (F[m].t <= t) { f = m; lo = m + 1; } else hi = m - 1; }
    if (f < 0 || t - F[f].t > 3000) continue;
    if (f !== lastF) {
      vals.fill(0); const fr = F[f], byOrder = CFG.heat.mode === 'order' && fr.m, src = byOrder ? fr.m : fr.q;
      for (let k = 0; k < fr.q.length; k++) {
        const yc = yRow(Math.floor(Math.round(fr.p[k] / tick) / M.rt)), y0 = Math.max(0, Math.floor(yc - CFG.rowH / 2)), y1 = Math.min(h, Math.ceil(yc + CFG.rowH / 2));
        for (let y = y0; y < y1; y++) vals[y] = byOrder ? Math.max(vals[y], src[k]) : vals[y] + src[k];
      }
      for (let y = 0; y < h; y++) { const v = vals[y]; if (v > maxSeen) maxSeen = v; col[y] = v ? LUT[Math.min(255, Math.round(Math.pow(Math.min(1, v / scale), gam) * 255))] : 0; }
      lastF = f;
    }
    for (let y = 0; y < h; y++) if (col[y]) u[y * w + x] = col[y];
  }
  M.hmMax = M.hmMax ? M.hmMax * .8 + maxSeen * .2 : maxSeen;
  hctx.putImageData(img, 0, 0); ctx.drawImage(hcv, 0, 0, w, h);
}
function drawBar(i) {
  const b = M.bars.list[i], x1 = xR(i), x0 = x1 - CFG.barW, rows = rowsOf(b, M.rt), rh = CFG.rowH;
  const up = b.c >= b.o, col = up ? C.buy : C.sell;
  const fpMode = CFG.mode !== 'none' && CFG.barW >= 34 && rh >= 6;
  if (!fpMode) { // candles
    const bw = Math.max(1, CFG.barW * .7), cx = x0 + CFG.barW / 2;
    ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(Math.round(cx) + .5, yP(b.h)); ctx.lineTo(Math.round(cx) + .5, yP(b.l)); ctx.stroke();
    const yo = yP(b.o), yc = yP(b.c); ctx.fillStyle = col; ctx.fillRect(cx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    return;
  }
  const cw = 5, cx0 = x0 + cw + 2, cW = CFG.barW - cw - 4;
  // candle strip at the left of the cluster
  ctx.fillStyle = col; const yo = yP(b.o), yc = yP(b.c); ctx.fillRect(x0 + 1, Math.min(yo, yc) - rh / 2, cw - 1, Math.abs(yc - yo) + rh);
  ctx.fillRect(x0 + 3, yP(b.h) - rh / 2, 1, yP(b.l) - yP(b.h) + rh);
  const imb = CFG.show.imb ? imbOf(b) : null, mxSide = Math.max(1e-9, ...[...rows.m.values()].map(z => Math.max(z[0], z[1])));
  const fs = Math.min(12, rh - 3), txt = fs >= 7, vis = CFG.visual, mode = CFG.mode;
  ctx.font = `${fs}px Consolas, monospace`; ctx.textBaseline = 'middle';
  for (const [r, x] of rows.m) {
    const y = yRow(r); if (y < -rh || y > L.mh + rh) continue;
    const v = x[0] + x[1], d = x[1] - x[0], top = Math.round(y - rh / 2) + .5;
    if (vis !== 'none') {
      if (mode === 'delta') { ctx.fillStyle = d >= 0 ? `rgba(8,153,129,${.12 + .7 * Math.abs(d) / (rows.maxD || 1)})` : `rgba(242,56,90,${.12 + .7 * Math.abs(d) / (rows.maxD || 1)})`; }
      else ctx.fillStyle = `rgba(33,110,220,${.1 + .65 * v / rows.maxV})`;
      if (vis === 'fill') ctx.fillRect(cx0, top, cW, rh - 1);
      else if (mode === 'bidask') { const mx = mxSide, hw = cW / 2;
        ctx.fillStyle = 'rgba(242,56,90,.45)'; ctx.fillRect(cx0 + hw - hw * x[0] / mx, top, hw * x[0] / mx, rh - 1);
        ctx.fillStyle = 'rgba(8,153,129,.45)'; ctx.fillRect(cx0 + hw, top, hw * x[1] / mx, rh - 1); }
      else ctx.fillRect(cx0, top, cW * v / rows.maxV, rh - 1);
    }
    if (CFG.show.poc && r === rows.poc) { ctx.strokeStyle = C.poc; ctx.lineWidth = 1; ctx.strokeRect(cx0 + .5, top, cW - 1, rh - 1); }
    if (!txt) continue;
    const f = imb && imb.get(r), bold = r === rows.poc ? 'bold ' : '';
    ctx.font = `${bold}${fs}px Consolas, monospace`;
    if (mode === 'bidask') {
      ctx.textAlign = 'right'; ctx.fillStyle = f === -1 || f === 2 ? C.sellT : C.text; ctx.fillText(fv(x[0]), cx0 + cW / 2 - 4, y);
      ctx.textAlign = 'left'; ctx.fillStyle = f === 1 || f === 2 ? C.buyT : C.text; ctx.fillText(fv(x[1]), cx0 + cW / 2 + 4, y);
      ctx.fillStyle = C.mut; ctx.textAlign = 'center'; ctx.fillText('×', cx0 + cW / 2, y);
    } else {
      const s = mode === 'volume' ? fv(v) : mode === 'delta' ? fv(d) : mode === 'trades' ? String(x[2]) : `${fv(v)} ${d >= 0 ? '+' : ''}${fv(d)}`;
      ctx.textAlign = 'left'; ctx.fillStyle = f === 1 ? C.buyT : f === -1 ? C.sellT : mode === 'delta' ? (d >= 0 ? C.buyT : C.sellT) : C.text; ctx.fillText(s, cx0 + 3, y);
    }
  }
  ctx.strokeStyle = '#3a4559'; ctx.lineWidth = 1; ctx.strokeRect(Math.round(cx0) + .5, Math.round(yP(b.h) - rh / 2) + .5, Math.round(cW), Math.round(yP(b.l) - yP(b.h) + rh));
}
function stackedZones(i0, i1) {
  const tick = spec().tick, rs = rowSize();
  for (let i = Math.max(0, i0 - 200); i <= i1; i++) {
    if (!CFG.show.stack) break;
    const b = M.bars.list[i];
    for (const z of stacked(imbOf(b), CFG.stackN)) {
      const pLo = z.lo * rs, pHi = (z.hi + 1) * rs - tick; let e = i + 1; // extend until price trades back into the zone
      while (e < N() && !(M.bars.list[e].l <= pHi && M.bars.list[e].h >= pLo)) e++;
      const xa = xR(i), xb = e < N() ? xR(e) - CFG.barW : L.cw; if (xb < 0) continue;
      ctx.fillStyle = z.side > 0 ? 'rgba(46,230,166,.13)' : 'rgba(255,107,132,.13)';
      const ya = yRow(z.hi) - CFG.rowH / 2, yb = yRow(z.lo) + CFG.rowH / 2; ctx.fillRect(xa, ya, xb - xa, yb - ya);
      ctx.fillStyle = z.side > 0 ? C.buyT : C.sellT; ctx.fillRect(xa, z.side > 0 ? yb - 1 : ya, xb - xa, 1);
    }
  }
}
function imbOf(b) { // cached per bar until it changes or the imbalance settings change
  const k = `${M.rt}|${b.ver}|${CFG.imb.ratio}|${CFG.imb.min}|${CFG.imb.ignoreZero}`;
  if (b._ik !== k) { b._ik = k; b._imb = imbalances(rowsOf(b, M.rt), CFG.imb.ratio, CFG.imb.min, CFG.imb.ignoreZero); }
  return b._imb;
}
function profileMap(i0, i1) {
  if (CFG.profile.src === 'session') return M.bars.profile;
  const m = new Map(); for (let i = i0; i <= i1; i++) for (const [pi, L] of M.bars.list[i].lv) { let x = m.get(pi); if (!x) m.set(pi, x = [0, 0]); x[0] += L[0]; x[1] += L[1]; }
  return m;
}
function profile(i0, i1) {
  const src = profileMap(i0, i1), rows = new Map();
  for (const [pi, x] of src) { const r = Math.floor(pi / M.rt); let y = rows.get(r); if (!y) rows.set(r, y = [0, 0]); y[0] += x[0]; y[1] += x[1]; }
  if (!rows.size) return;
  const va = valueArea(rows, CFG.profile.va), W_ = CFG.profile.w, typ = CFG.profile.type;
  let mx = 0; for (const x of rows.values()) mx = Math.max(mx, typ === 'delta' ? Math.abs(x[1] - x[0]) : x[0] + x[1]);
  for (const [r, x] of rows) {
    const y = yRow(r); if (y < -CFG.rowH || y > L.mh + CFG.rowH) continue;
    const inVA = r >= va.val && r <= va.vah, hh = Math.max(1, CFG.rowH - 1), top = y - CFG.rowH / 2;
    if (typ === 'bidask') { const v = x[0] + x[1], w = W_ * v / mx; ctx.fillStyle = 'rgba(242,56,90,.55)'; ctx.fillRect(0, top, w * x[0] / v, hh); ctx.fillStyle = 'rgba(8,153,129,.55)'; ctx.fillRect(w * x[0] / v, top, w * x[1] / v, hh); }
    else if (typ === 'delta') { const d = x[1] - x[0]; ctx.fillStyle = d >= 0 ? 'rgba(8,153,129,.6)' : 'rgba(242,56,90,.6)'; ctx.fillRect(0, top, W_ * Math.abs(d) / mx, hh); }
    else { ctx.fillStyle = r === va.poc ? 'rgba(255,213,79,.8)' : inVA ? 'rgba(52,104,214,.7)' : 'rgba(52,104,214,.35)'; ctx.fillRect(0, top, W_ * (x[0] + x[1]) / mx, hh); }
  }
  ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  for (const [r, c, lbl] of [[va.poc, C.poc, 'POC'], [va.vah, '#7aa2ff', 'VAH'], [va.val, '#7aa2ff', 'VAL']]) {
    const y = Math.round(yRow(r)) + .5; ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.cw, y); ctx.stroke();
    ctx.fillStyle = c; ctx.font = '10px Segoe UI'; ctx.textAlign = 'left'; ctx.fillText(lbl, 4, y - 6);
  }
  ctx.setLineDash([]);
}
function vwap(i0, i1) {
  const lines = [['vw', 0, '#e040fb'], ['vw', 1, 'rgba(224,64,251,.45)'], ['vw', -1, 'rgba(224,64,251,.45)'], ['vw', 2, 'rgba(224,64,251,.25)'], ['vw', -2, 'rgba(224,64,251,.25)']];
  for (const [, k, c] of lines) {
    ctx.strokeStyle = c; ctx.lineWidth = k ? 1 : 1.5; ctx.beginPath(); let pen = false, ss = null;
    for (let i = i0; i <= i1; i++) { const b = M.bars.list[i]; if (b.vw == null) continue; const y = yP(b.vw + k * b.sd), x = xR(i) - CFG.barW / 2; if (!pen || b.ss !== ss) ctx.moveTo(x, y); else ctx.lineTo(x, y); pen = true; ss = b.ss; }
    ctx.stroke();
  }
}
function searches(i0, i1) {
  const tick = spec().tick;
  for (const s of CFG.searches) {
    if (!s.on) continue;
    for (let i = i0; i <= i1; i++) {
      const b = M.bars.list[i];
      for (const h of clusterSearch(b, rowsOf(b, M.rt), M.rt, tick, s)) {
        const ya = yRow(h.r + h.R - 1) - CFG.rowH / 2, yb = yRow(h.r) + CFG.rowH / 2, x0 = xR(i) - CFG.barW + 6, w = CFG.barW - 8;
        ctx.strokeStyle = s.color; ctx.fillStyle = s.color + '55'; ctx.lineWidth = 2;
        if (s.shape === 'circle') { const r = Math.max(5, Math.min(CFG.barW / 2, (yb - ya) / 2 + 4)); ctx.beginPath(); ctx.arc(x0 + w / 2, (ya + yb) / 2, r, 0, 7); ctx.fill(); ctx.stroke(); }
        else { ctx.fillRect(x0, ya, w, yb - ya); ctx.strokeRect(x0, ya, w, yb - ya); }
      }
    }
  }
  ctx.lineWidth = 1;
}
function checkSearchAlerts(i) { // a bar just closed: alert on its matches once
  if (i < 0 || M.hist) return;
  const b = M.bars.list[i];
  for (const s of CFG.searches) if (s.on && s.alert) for (const h of clusterSearch(b, rowsOf(b, M.rt), M.rt, spec().tick, s)) {
    const k = `${s.name}:${b.t0}:${h.r}`; if (M.alerted.has(k)) continue; M.alerted.add(k);
    beep(660); toast(`Cluster Search: ${s.name} at ${fp(h.r * rowSize())} (${fv(h.v)})`);
  }
}
function bigTrades(i0, i1) {
  const t0 = M.bars.list[i0].t0, mn = bigMin();
  for (const g of M.big) {
    if (g.t < t0) continue; const x = xT(g.t); if (x == null || x > L.cw) continue;
    const y = yP(g.p), r = Math.max(4, Math.min(38, Math.sqrt(g.q / mn) * 6));
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = g.s > 0 ? 'rgba(46,230,166,.35)' : 'rgba(255,107,132,.35)'; ctx.fill();
    ctx.strokeStyle = g.s > 0 ? C.buyT : C.sellT; ctx.lineWidth = 1.2; ctx.stroke();
    if (r > 11) { ctx.fillStyle = '#fff'; ctx.font = '10px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(fv(g.q), x, y); }
  }
  ctx.lineWidth = 1;
}
function domHist() { // order book sizes at the right edge of the chart
  const W_ = CFG.rightPad - 10, rows = new Map(), tick = spec().tick; let mx = 0;
  if (M.orders.size) return domOrders(W_, tick);
  for (const [m, side] of [[M.bids, 1], [M.asks, -1]]) for (const [p, q] of m) { const r = Math.floor(Math.round(p / tick) / M.rt), k = r * 2 + (side > 0 ? 0 : 1); rows.set(k, (rows.get(k) || 0) + q); }
  for (const [k, q] of rows) { const y = yRow(k >> 1); if (y > -20 && y < L.mh + 20) mx = Math.max(mx, q); }
  ctx.font = '10px Consolas'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  for (const [k, q] of rows) {
    const y = yRow(k >> 1); if (y < -CFG.rowH || y > L.mh + CFG.rowH) continue;
    const w = W_ * q / (mx || 1); ctx.fillStyle = k & 1 ? 'rgba(242,56,90,.6)' : 'rgba(8,153,129,.6)'; ctx.fillRect(L.cw - w, y - CFG.rowH / 2, w, Math.max(1, CFG.rowH - 1));
    if (CFG.rowH >= 11) { ctx.fillStyle = '#dfe5ee'; ctx.fillText(fv(q), L.cw - 3, y); }
  }
}
function domOrders(W_, tick) { // order-by-order: every resting order is its own segment, largest at the right
  const seg = new Map(); let mx = 0;
  for (const [p, a] of M.orders.values()) { const k = Math.floor(Math.round(p / tick) / M.rt) * 2 + (a > 0 ? 0 : 1); let x = seg.get(k); if (!x) seg.set(k, x = []); x.push(Math.abs(a)); }
  for (const [k, x] of seg) { const y = yRow(k >> 1); if (y > -20 && y < L.mh + 20) mx = Math.max(mx, x.reduce((a, b) => a + b, 0)); }
  ctx.font = '10px Consolas'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  for (const [k, x] of seg) {
    const y = yRow(k >> 1); if (y < -CFG.rowH || y > L.mh + CFG.rowH) continue;
    x.sort((a, b) => b - a); let xr = L.cw; const h = Math.max(1, CFG.rowH - 1), tot = x.reduce((a, b) => a + b, 0);
    for (const q of x) { const w = W_ * q / (mx || 1); xr -= w; ctx.fillStyle = `rgba(${k & 1 ? '242,56,90' : '8,153,129'},${.3 + .65 * q / x[0]})`; ctx.fillRect(xr, y - CFG.rowH / 2, Math.max(1, w - 1), h); }
    if (CFG.rowH >= 11) { ctx.fillStyle = '#dfe5ee'; ctx.fillText(`${fv(tot)} ·${x.length}`, L.cw - 3, y); }
  }
}
function lastLine() {
  if (M.last == null) return;
  const y = Math.round(yP(M.last)) + .5; ctx.strokeStyle = 'rgba(46,230,166,.6)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.cw, y); ctx.stroke(); ctx.setLineDash([]);
}
function priceAxis() {
  ctx.fillStyle = '#111722'; ctx.fillRect(L.cw, 0, AXIS, L.mh); ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(L.cw + .5, 0); ctx.lineTo(L.cw + .5, H); ctx.stroke();
  ctx.font = '11px Segoe UI'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = C.mut;
  const st = labelStep(), r0 = Math.floor(view.center - L.mh / 2 / CFG.rowH), r1 = Math.ceil(view.center + L.mh / 2 / CFG.rowH);
  for (let r = Math.ceil(r0 / st) * st; r <= r1; r += st) { const y = yRow(r); if (y > 8 && y < L.mh - 8) ctx.fillText(fp(r * rowSize()), L.cw + 6, y); }
  const tag = (p, bg, fg = '#fff') => { if (p == null) return; const y = yP(p); if (y < 0 || y > L.mh) return; ctx.fillStyle = bg; ctx.fillRect(L.cw + 1, y - 8, AXIS - 1, 16); ctx.fillStyle = fg; ctx.fillText(fp(p), L.cw + 6, y); };
  tag(M.bb, '#0b5e4b'); tag(M.ba, '#8e1f35'); tag(M.last, '#2ee6a6', '#04130e');
}
function timeAxis(i0, i1) {
  const y = L.mh; ctx.fillStyle = '#111722'; ctx.fillRect(0, y, W, TIMEH); ctx.fillStyle = C.mut; ctx.font = '11px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const every = Math.max(1, Math.ceil(90 / CFG.barW));
  for (let i = i0; i <= i1; i++) if (i % every === 0) ctx.fillText(fT(M.bars.list[i].t0, CFG.tf.type !== 'time' || CFG.tf.n < 60), xR(i) - CFG.barW / 2, y + TIMEH / 2);
}
const STATS = [['Volume', b => b.v, 'v'], ['Delta', b => b.d, 'd'], ['Delta %', b => b.v ? b.d / b.v * 100 : 0, 'p'], ['Max Δ', b => b.maxD, 'd'], ['Min Δ', b => b.minD, 'd'],
  ['Trades', b => b.n, 'v'], ['Bid vol', b => b.bv, 's'], ['Ask vol', b => b.av, 'b'], ['Time', b => (b.t1 - b.t0) / 1000, 't']];
function pane(p, i0, i1) {
  ctx.save(); ctx.beginPath(); ctx.rect(0, p.y, W, p.h); ctx.clip();
  ctx.fillStyle = C.bg; ctx.fillRect(0, p.y, W, p.h); ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(0, p.y + .5); ctx.lineTo(W, p.y + .5); ctx.stroke();
  ctx.fillStyle = '#111722'; ctx.fillRect(L.cw, p.y, AXIS, p.h);
  const bars = M.bars.list, cxOf = i => xR(i) - CFG.barW / 2;
  if (p.k.startsWith('sc:')) { scriptPane(p, i0, i1); ctx.restore(); return; }
  if (p.k === 'stats') {
    const rh = 14; ctx.font = '10px Consolas'; ctx.textBaseline = 'middle';
    STATS.forEach(([name, fn, kind], j) => {
      const y = p.y + 3 + j * rh; let mx = 0; for (let i = i0; i <= i1; i++) mx = Math.max(mx, Math.abs(fn(bars[i])));
      ctx.fillStyle = C.mut; ctx.textAlign = 'left'; ctx.fillText(name, L.cw + 6, y + rh / 2);
      for (let i = i0; i <= i1; i++) {
        const v = fn(bars[i]), a = mx ? Math.abs(v) / mx : 0, x0 = xR(i) - CFG.barW + 1;
        ctx.fillStyle = kind === 'd' || kind === 'p' ? (v >= 0 ? `rgba(8,153,129,${.1 + .6 * a})` : `rgba(242,56,90,${.1 + .6 * a})`) : kind === 's' ? `rgba(242,56,90,${.1 + .5 * a})` : kind === 'b' ? `rgba(8,153,129,${.1 + .5 * a})` : `rgba(33,110,220,${.1 + .55 * a})`;
        ctx.fillRect(x0, y, CFG.barW - 2, rh - 1);
        if (CFG.barW >= 30) { ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.fillText(kind === 'p' ? v.toFixed(1) + '%' : kind === 't' ? (v >= 60 ? (v / 60).toFixed(1) + 'm' : v.toFixed(1) + 's') : fv(v), x0 + CFG.barW / 2 - 1, y + rh / 2); }
      }
    });
  } else {
    const val = p.k === 'delta' ? b => [b.d] : p.k === 'vol' ? b => [b.v] : b => [b.cdo, b.cdh, b.cdl, b.cdc];
    let lo = Infinity, hi = -Infinity; for (let i = i0; i <= i1; i++) for (const v of val(bars[i])) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (p.k !== 'cvd') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = 6, Y = v => p.y + pad + (hi - v) / ((hi - lo) || 1) * (p.h - 2 * pad), bw = Math.max(1, CFG.barW * .6);
    for (let i = i0; i <= i1; i++) {
      const b = bars[i], cx = cxOf(i);
      if (p.k === 'cvd') { const up = b.cdc >= b.cdo; ctx.fillStyle = ctx.strokeStyle = up ? C.buy : C.sell; ctx.beginPath(); ctx.moveTo(cx, Y(b.cdh)); ctx.lineTo(cx, Y(b.cdl)); ctx.stroke(); ctx.fillRect(cx - bw / 2, Math.min(Y(b.cdo), Y(b.cdc)), bw, Math.max(1, Math.abs(Y(b.cdo) - Y(b.cdc)))); }
      else { const v = p.k === 'delta' ? b.d : b.v; ctx.fillStyle = (p.k === 'delta' ? v : b.d) >= 0 ? C.buy : C.sell; ctx.fillRect(cx - bw / 2, Math.min(Y(0), Y(v)), bw, Math.max(1, Math.abs(Y(v) - Y(0)))); }
    }
    ctx.fillStyle = C.mut; ctx.font = '11px Segoe UI'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText({ delta: 'Delta', cvd: 'Cumulative Delta', vol: 'Volume' }[p.k], 6, p.y + 4);
    ctx.textBaseline = 'middle'; ctx.fillText(fv(hi), L.cw + 6, p.y + 10); ctx.fillText(fv(lo), L.cw + 6, p.y + p.h - 10);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- crosshair, tooltip
let mouse = null;
function crosshair() {
  if (!mouse || mouse.x > L.cw || mouse.y > L.mh) { $('tip').style.display = 'none'; return; }
  const { x, y } = mouse; ctx.strokeStyle = 'rgba(200,210,230,.35)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(L.cw, y + .5); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, L.mh); ctx.stroke(); ctx.setLineDash([]);
  const p = pAt(y); ctx.fillStyle = '#3b4a63'; ctx.fillRect(L.cw + 1, y - 8, AXIS - 1, 16); ctx.fillStyle = '#fff'; ctx.font = '11px Segoe UI'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(fp(Math.round(p / spec().tick) * spec().tick), L.cw + 6, y);
  const i = iAt(x), b = M.bars.list[i], tip = $('tip');
  if (!b) { tip.style.display = 'none'; return; }
  const r = rowOfP(p), lv = rowsOf(b, M.rt).m.get(r);
  tip.textContent = `${fT(b.t0)}  O ${fp(b.o)} H ${fp(b.h)} L ${fp(b.l)} C ${fp(b.c)}\nVol ${fv(b.v)}  Δ ${fv(b.d)}  Trades ${b.n}  CumΔ ${fv(b.cdc)}` + (lv ? `\n@${fp(r * rowSize())}  bid ${fv(lv[0])} × ask ${fv(lv[1])}  Δ ${fv(lv[1] - lv[0])}` : '');
  tip.style.display = 'block'; tip.style.left = Math.min(x + 16, L.cw - tip.offsetWidth - 4) + 'px'; tip.style.top = Math.max(4, y - tip.offsetHeight - 12) + 'px';
}

// ---------------------------------------------------------------- drawings (per instrument)
let tool = null, dragRect = null;
const myDraw = () => CFG.draw[M.sym] || (CFG.draw[M.sym] = []);
function drawings() {
  for (const d of [...myDraw(), ...(dragRect ? [dragRect] : [])]) {
    ctx.strokeStyle = d.c || '#ffb74d'; ctx.lineWidth = 1;
    if (d.k === 'h') { const y = Math.round(yP(d.p)) + .5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.cw, y); ctx.stroke(); ctx.fillStyle = d.c || '#ffb74d'; ctx.font = '10px Segoe UI'; ctx.textAlign = 'right'; ctx.fillText(fp(d.p), L.cw - CFG.rightPad - 4, y - 7); }
    if (d.k === 'r') { const xa = xT(d.t0) ?? 0, xb = xT(d.t1) ?? L.cw, ya = yP(d.p0), yb = yP(d.p1); ctx.fillStyle = 'rgba(255,183,77,.12)'; ctx.fillRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya)); ctx.strokeRect(Math.min(xa, xb), Math.min(ya, yb), Math.abs(xb - xa), Math.abs(yb - ya)); }
  }
}
function tAtX(x) { const i = Math.max(0, Math.min(N() - 1, iAt(x))), b = M.bars.list[i]; return b.t0 + (x - (xR(i) - CFG.barW)) / CFG.barW * (barEnd(i) - b.t0); }

// ---------------------------------------------------------------- mouse / keyboard
let drag = null;
cv.addEventListener('mousemove', e => {
  const r = cv.getBoundingClientRect(); mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (drag) {
    if (drag.axis) { CFG.rowH = Math.max(3, Math.min(60, drag.rowH * Math.exp((mouse.y - drag.y) / 120))); }
    else { view.off = drag.off + (mouse.x - drag.x) / CFG.barW; view.center = drag.center + (mouse.y - drag.y) / CFG.rowH; if (Math.abs(mouse.y - drag.y) > 4) view.follow = false; }
    view.off = Math.max(-5, Math.min(N() - 1, view.off));
  }
  if (dragRect) { dragRect.t1 = tAtX(mouse.x); dragRect.p1 = pAt(mouse.y); }
  dirty = true;
});
cv.addEventListener('mouseleave', () => { mouse = null; dirty = true; });
cv.addEventListener('mousedown', e => {
  if (e.button !== 0 || !M.bars || !N()) return;
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, p = Math.round(pAt(y) / spec().tick) * spec().tick;
  if (tool === 'h') { myDraw().push({ k: 'h', p }); tool = null; saveCfg(); setTool(); dirty = true; return; }
  if (tool === 'a' || e.altKey) { addAlert(p); tool = null; setTool(); return; }
  if (tool === 'r') { dragRect = { k: 'r', t0: tAtX(x), t1: tAtX(x), p0: pAt(y), p1: pAt(y) }; return; }
  if (e.shiftKey || e.ctrlKey) { // chart trading: Shift = limit, Ctrl = stop; side from where the price is
    const above = p > (M.last ?? p); return trade({ side: e.shiftKey ? (above ? -1 : 1) : (above ? 1 : -1), type: e.shiftKey ? 'limit' : 'stop', price: p });
  }
  drag = { x, y, off: view.off, center: view.center, rowH: CFG.rowH, axis: x > L.cw };
});
addEventListener('mouseup', () => { if (drag) { drag = null; saveCfg(); } if (dragRect) { myDraw().push(dragRect); dragRect = null; tool = null; setTool(); saveCfg(); } });
cv.addEventListener('dblclick', e => { const r = cv.getBoundingClientRect(); if (e.clientX - r.left > L.cw) { view.follow = true; view.center = null; dirty = true; } });
cv.addEventListener('contextmenu', e => { // right-click a drawing to delete it
  e.preventDefault(); const r = cv.getBoundingClientRect(), y = e.clientY - r.top, ds = myDraw();
  if (removeAlertAt(y)) return;
  const k = ds.findIndex(d => d.k === 'h' ? Math.abs(yP(d.p) - y) < 5 : Math.min(yP(d.p0), yP(d.p1)) <= y && y <= Math.max(yP(d.p0), yP(d.p1)));
  if (k >= 0) { ds.splice(k, 1); saveCfg(); dirty = true; }
});
cv.addEventListener('wheel', e => {
  e.preventDefault(); const r = cv.getBoundingClientRect(), x = e.clientX - r.left, k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  if (x > L.cw || e.ctrlKey) CFG.rowH = Math.max(3, Math.min(60, CFG.rowH * k));
  else if (e.shiftKey) view.off = Math.max(-5, Math.min(N() - 1, view.off + (e.deltaY > 0 ? 3 : -3)));
  else CFG.barW = Math.max(3, Math.min(400, CFG.barW * k));
  saveCfg(); dirty = true;
}, { passive: false });
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === ' ' || e.key === 'Home') { view.off = 0; view.follow = true; view.center = null; dirty = true; e.preventDefault(); }
  if (e.key === 'Escape') { tool = null; dragRect = null; setTool(); }
  if (e.key === '+' || e.key === '=') { CFG.barW *= 1.15; dirty = true; } if (e.key === '-') { CFG.barW /= 1.15; dirty = true; }
});
function setTool() { $('dAlert').classList.toggle('on', tool === 'a'); $('dHline').classList.toggle('on', tool === 'h'); $('dRect').classList.toggle('on', tool === 'r'); cv.style.cursor = tool ? 'cell' : 'crosshair'; }
$('dHline').onclick = () => { tool = tool === 'h' ? null : 'h'; setTool(); };
$('dRect').onclick = () => { tool = tool === 'r' ? null : 'r'; setTool(); };
$('dAlert').onclick = () => { tool = tool === 'a' ? null : 'a'; setTool(); };
$('dClear').onclick = () => { CFG.draw[M.sym] = []; saveCfg(); dirty = true; };
$('shot').onclick = () => cv.toBlob(b => navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).then(() => toast('Chart copied to the clipboard'), e => toast('Copy failed: ' + e.message)));

// ---------------------------------------------------------------- Smart DOM
let domTop = null;
const domRows = () => Math.max(10, Math.floor($('domBody').clientHeight / 17));
function renderDom() {
  if (!CFG.show.dom || M.last == null) return;
  const tick = spec().tick, n = domRows(), lastI = Math.round(M.last / tick);
  if (domTop == null || lastI > domTop - n * .2 || lastI < domTop - n * .8) domTop = lastI + (n >> 1); // keep the last price in the middle 60%
  const ords = openOrders(), posPx = position().qty ? Math.round(position().avg / tick) : null;
  let mxv = 0; const vol = i => { const x = M.bars.profile.get(i); return x ? x[0] + x[1] : 0; };
  for (let k = 0; k < n; k++) mxv = Math.max(mxv, vol(domTop - k));
  let h = ''; const oc = new Map(); // order count per price: +i bids, -i asks
  for (const [op, a] of M.orders.values()) { const k = Math.round(op / tick) * (a > 0 ? 1 : -1); oc.set(k, (oc.get(k) || 0) + 1); }
  const cnt = k => oc.get(k) ? `<small class="mut"> ·${oc.get(k)}</small>` : '';
  for (let k = 0; k < n; k++) {
    const i = domTop - k, p = +(i * tick).toFixed(10), bq = M.bids.get(p), aq = M.asks.get(p), v = vol(i);
    const ob = ords.filter(o => Math.round(o.price / tick) === i && o.side > 0).reduce((a, o) => a + o.qty, 0), os = ords.filter(o => Math.round(o.price / tick) === i && o.side < 0).reduce((a, o) => a + o.qty, 0);
    h += `<div class="dr${i === lastI ? ' last' : ''}${M.bb != null && i === Math.round(M.bb / tick) ? ' bb' : ''}${M.ba != null && i === Math.round(M.ba / tick) ? ' ba' : ''}${i === posPx ? ' pos' : ''}" data-i="${i}">`
      + `<span class="ord" style="color:#2ee6a6" data-c="1">${ob || ''}</span><span class="bid" data-s="1" style="color:#6fe3bf">${bq ? fv(bq) : ''}${cnt(i)}</span><span class="px">${fp(p)}</span>`
      + `<span class="ask" data-s="-1" style="color:#ff8ea2">${aq ? fv(aq) : ''}${cnt(-i)}</span><span class="ord" style="color:#ff6b84" data-c="-1">${os || ''}</span><span class="vol"><i style="width:${mxv ? v / mxv * 100 : 0}%"></i>${v ? fv(v) : ''}</span></div>`;
  }
  $('domBody').innerHTML = h;
}
$('domBody').addEventListener('click', e => {
  const s = +e.target.dataset.s, row = e.target.closest('.dr'); if (!s || !row) return;
  const p = +row.dataset.i * spec().tick, ref = M.last ?? p;
  // bid column = buy: below the market a limit, above it a stop; ask column = sell, mirrored
  trade({ side: s, type: s > 0 ? (p <= ref ? 'limit' : 'stop') : (p >= ref ? 'limit' : 'stop'), price: p });
});
$('domBody').addEventListener('contextmenu', e => { e.preventDefault(); const row = e.target.closest('.dr'); if (!row) return; const i = +row.dataset.i, tick = spec().tick; cancelWhere(o => Math.round(o.price / tick) === i); });
$('domBody').addEventListener('wheel', e => { e.preventDefault(); domTop = (domTop ?? 0) + (e.deltaY < 0 ? 3 : -3); renderDom(); }, { passive: false });
$('domCenter').onclick = () => { domTop = null; renderDom(); };

// ---------------------------------------------------------------- Smart Tape
let tapeFrozen = false;
function renderTape() {
  if (!CFG.show.tape || tapeFrozen) return;
  const T = CFG.tape, rows = [];
  for (let k = M.tape.length - 1; k >= 0 && rows.length < 200; k--) { const r = M.tape[k]; if (T.min && r.q < T.min) continue; if (T.max && r.q > T.max) continue; rows.push(r); }
  const lvl = q => { let c = null; for (const a of T.alerts) if (a.min && q >= a.min) c = a.color; return c; };
  $('tapeBody').innerHTML = '<div class="tr h"><span>Time</span><span>Price</span><span>Volume</span></div>' + rows.map(r => {
    const c = lvl(r.q), at = r.s > 0 ? (r.ba != null && r.p > r.ba ? ' ▲' : '') : (r.bb != null && r.p < r.bb ? ' ▼' : '');
    return `<div class="tr" style="${c ? `background:${c};` : ''}color:${r.s > 0 ? '#2ee6a6' : '#ff6b84'}"><span>${fT(r.t)}</span><span>${fp(r.p)}${at}</span><span>${fv(r.q)}${r.n > 1 ? `<small class="mut"> ×${r.n}</small>` : ''}</span></div>`;
  }).join('');
}
function tapeAlert(r) { if (M.hist) return; const a = [...CFG.tape.alerts].reverse().find(a => a.min && r.q >= a.min); if (a && a.sound) beep(440 + 110 * CFG.tape.alerts.indexOf(a)); }
$('tapeFreeze').onclick = () => { tapeFrozen = !tapeFrozen; $('tapeFreeze').textContent = tapeFrozen ? '▶' : '❚❚'; };
let actx;
function beep(f) { try { actx = actx || new AudioContext(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = .08; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + .15); } catch (e) { } }

// ---------------------------------------------------------------- accounts: Sim (local) + Rithmic
let SIM, RSTATE = { state: 'disconnected', accounts: [] }, RSNAP = null;
const isSim = () => CFG.trader.account === 'sim';
function simChanged() { if (!SIM) return; riskCheck(); simSave(); }
let simT; const simSave = () => { clearTimeout(simT); simT = setTimeout(() => { SIMALL[M.sym] = SIM.state; api('/store/sim', SIMALL).catch(() => { }); }, 1000); };
let SIMALL = {};
function loadSim() { SIM = new Sim(SIMALL[M.sym], spec); }
function openOrders() {
  if (isSim()) return SIM ? SIM.orders : [];
  return (RSNAP?.orders || []).filter(o => (o.symbol || '').startsWith(M.sym)).map(o => ({ ...o, price: +o.price, qty: +o.qty }));
}
function position() {
  if (isSim()) return { qty: SIM?.pos || 0, avg: SIM?.avg || 0, open: SIM ? SIM.pnl(M.last) : 0, closed: SIM ? SIM.real - SIM.comm : 0 };
  const p = (RSNAP?.positions || []).find(x => (x.symbol || '').startsWith(M.sym)) || {};
  const qty = +(p.net_quantity ?? ((+p.buy_qty || 0) - (+p.sell_qty || 0)) ?? 0);
  return { qty, avg: +(p.avg_open_fill_price || 0), open: +(p.open_position_pnl || 0), closed: +(p.closed_position_pnl || 0) };
}
async function trade(o) {
  try {
    const qty = Math.max(1, +$('qty').value || 1), sl = +$('slT').value || 0, tp = +$('tpT').value || 0;
    const block = riskBlock(qty * (o.side > 0 ? 1 : -1)); if (block) throw new Error(block);
    if (o.price != null) o.price = +(Math.round(o.price / spec().tick) * spec().tick).toFixed(10);
    if (isSim()) { SIM.place({ ...o, qty, sl, tp }, M.bb, M.ba, M.last); simChanged(); toast(`Sim: ${o.side > 0 ? 'Buy' : 'Sell'} ${qty} ${o.type}${o.price != null && o.type !== 'market' ? ' @ ' + fp(o.price) : ''}`); }
    else {
      if (CFG.src !== 'rithmic') throw new Error('Rithmic accounts trade futures: switch the data source to Rithmic');
      const r = await api('/rithmic/order', { account: CFG.trader.account, sym: M.sym, side: o.side, type: o.type, price: o.price, qty, sl, tp });
      toast(`Rithmic order sent (${r.contract})`); pollRithmic();
    }
  } catch (e) { toast('❌ ' + e.message); }
  dirty = true; renderTrader();
}
async function cancelWhere(f) {
  if (isSim()) { SIM.cancel(f); simChanged(); }
  else for (const o of openOrders().filter(f)) await api('/rithmic/cancel', { account: CFG.trader.account, id: o.id }).catch(e => toast(e.message));
  renderTrader(); dirty = true; pollRithmic();
}
async function flatten() {
  if (isSim()) { SIM.cancel(() => true); const q = SIM.pos; if (q) SIM.place({ side: -Math.sign(q), type: 'market', qty: Math.abs(q) }, M.bb, M.ba, M.last); simChanged(); }
  else { await api('/rithmic/cancel', { account: CFG.trader.account }).catch(() => { }); await api('/rithmic/flatten', { account: CFG.trader.account, sym: M.sym }).catch(e => toast(e.message)); pollRithmic(); }
}
$('trader').addEventListener('click', async e => {
  const k = e.target.dataset.o; if (!k) return;
  const tick = spec().tick;
  if (k === 'buyMkt') return trade({ side: 1, type: 'market' }); if (k === 'sellMkt') return trade({ side: -1, type: 'market' });
  if (k === 'buyAsk') return trade({ side: 1, type: 'limit', price: M.ba }); if (k === 'sellAsk') return trade({ side: -1, type: 'limit', price: M.ba });
  if (k === 'buyBid') return trade({ side: 1, type: 'limit', price: M.bb }); if (k === 'sellBid') return trade({ side: -1, type: 'limit', price: M.bb });
  if (k === 'cancelBids') return cancelWhere(o => o.side > 0); if (k === 'cancelAsks') return cancelWhere(o => o.side < 0); if (k === 'cancelAll') return cancelWhere(() => true);
  if (k === 'close') return flatten().then(() => toast('Position closed'));
  const p = position(); if (!p.qty) return toast('No open position');
  if (k === 'reverse') { const q = Math.abs(p.qty) * 2; if (isSim()) { SIM.place({ side: -Math.sign(p.qty), type: 'market', qty: q }, M.bb, M.ba, M.last); simChanged(); } else await api('/rithmic/order', { account: CFG.trader.account, sym: M.sym, side: -Math.sign(p.qty), type: 'market', qty: q }).catch(e => toast(e.message)); return toast('Reversed'); }
  if (k === 'breakeven') { // move the protective stop to the entry price
    await cancelWhere(o => o.type === 'stop' && o.side === -Math.sign(p.qty));
    if (isSim()) { SIM.place({ side: -Math.sign(p.qty), type: 'stop', price: +(Math.round(p.avg / tick) * tick).toFixed(10), qty: Math.abs(p.qty), bracket: 1 }); simChanged(); }
    else await api('/rithmic/order', { account: CFG.trader.account, sym: M.sym, side: -Math.sign(p.qty), type: 'stop', price: Math.round(p.avg / tick) * tick, qty: Math.abs(p.qty) }).catch(e => toast(e.message));
    toast('Stop moved to breakeven');
  }
});
$('qtyPre').onclick = e => { if (e.target.tagName === 'BUTTON') { $('qty').value = e.target.textContent; CFG.trader.qty = +e.target.textContent; saveCfg(); } };
for (const id of ['qty', 'slT', 'tpT']) $(id).onchange = () => { CFG.trader.qty = +$('qty').value; CFG.trader.sl = +$('slT').value; CFG.trader.tp = +$('tpT').value; saveCfg(); };
$('acct').onchange = () => { CFG.trader.account = $('acct').value; saveCfg(); RSNAP = null; pollRithmic(); renderTrader(); dirty = true; };
function renderAccounts() {
  const opts = [['sim', 'Sim account (local)'], ...RSTATE.accounts.map(a => [a.id, `Rithmic · ${a.name}${a.fcm ? ' (' + a.fcm + ')' : ''}`])];
  if (!opts.some(o => o[0] === CFG.trader.account)) CFG.trader.account = 'sim';
  $('acct').innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}"${v === CFG.trader.account ? ' selected' : ''}>${esc(l)}</option>`).join('');
}
function renderTrader() {
  if (!CFG.show.trader || !SIM) return;
  const p = position(), sp = spec(), money = v => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
  const bal = isSim() ? SIM.bal0 + SIM.real - SIM.comm + p.open : +(RSNAP?.account?.account_balance ?? NaN);
  $('posBox').innerHTML = `<div class="kv"><span class="mut">Position</span><b class="${p.qty > 0 ? 'pos' : p.qty < 0 ? 'neg' : ''}">${p.qty ? (p.qty > 0 ? '+' : '') + p.qty + ' @ ' + fp(p.avg) : 'Flat'}</b></div>
    <div class="kv"><span class="mut">Open P&L</span><b class="${p.open >= 0 ? 'pos' : 'neg'}">${money(p.open)}</b></div>
    <div class="kv"><span class="mut">Closed P&L</span><b class="${p.closed >= 0 ? 'pos' : 'neg'}">${money(p.closed)}</b></div>
    <div class="kv"><span class="mut">Balance</span><b>${isNaN(bal) ? '—' : money(bal)}</b></div>
    <div class="kv"><span class="mut">Orders</span><b>${openOrders().length}</b></div>
    ${isSim() ? `<button class="ob" id="simReset">Reset sim account</button>` : `<div class="mut" style="font-size:11px">${RSTATE.state === 'connected' ? 'Rithmic positions / orders refresh every 2 s' : 'Rithmic not connected'}</div>`}`;
  const r = CFG.risk, rs = riskState();
  $('riskBox').innerHTML = `<div class="kv"><b>Risk Manager</b><span class="pill ${!r.on ? '' : rs.locked ? 'bad' : 'live'}">${!r.on ? 'off' : rs.locked ? 'LOCKED' : 'active'}</span></div>
    ${r.on ? `<div class="kv"><span class="mut">Today's P&L</span><b class="${rs.day >= 0 ? 'pos' : 'neg'}">${money(rs.day)}</b></div><div class="kv"><span class="mut">Max daily loss</span><b>${money(r.maxLoss)}</b></div><div class="kv"><span class="mut">Max contracts</span><b>${r.maxQty}</b></div>` : '<span class="mut" style="font-size:11px">Settings → Risk Manager</span>'}`;
  const b = $('simReset'); if (b) b.onclick = () => { if (!confirm('Reset the sim account for ' + M.sym + '? Its position, orders and P&L are cleared.')) return; SIM = new Sim({}, spec); simChanged(); renderTrader(); };
}
async function pollRithmic() {
  try { RSTATE = await api('/rithmic/status'); } catch (e) { }
  const s = $('stRith'); s.textContent = 'Rithmic: ' + RSTATE.state; s.className = 'pill ' + (RSTATE.state === 'connected' ? 'live' : RSTATE.state === 'error' ? 'bad' : '');
  s.title = RSTATE.error || '';
  renderAccounts();
  if (!isSim() && RSTATE.state === 'connected') try { RSNAP = await api('/rithmic/snapshot?account=' + encodeURIComponent(CFG.trader.account)); } catch (e) { RSNAP = null; }
  renderTrader();
}
setInterval(pollRithmic, 2000);
function ordersOnChart() {
  const tick = spec().tick;
  for (const o of openOrders()) {
    const y = Math.round(yP(o.price)) + .5, c = o.type === 'stop' ? '#ff9800' : o.side > 0 ? '#2ee6a6' : '#ff6b84';
    ctx.strokeStyle = c; ctx.setLineDash([6, 3]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.cw, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = c; ctx.fillRect(L.cw - CFG.rightPad - 92, y - 8, 90, 16); ctx.fillStyle = '#0b0f17'; ctx.font = '10px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`${o.side > 0 ? 'BUY' : 'SELL'} ${o.type.toUpperCase()} ${o.qty}`, L.cw - CFG.rightPad - 47, y);
  }
  const p = position(); if (!p.qty) return;
  const y = Math.round(yP(p.avg)) + .5, c = p.open >= 0 ? '#2ee6a6' : '#ff6b84'; ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.cw, y); ctx.stroke();
  ctx.fillStyle = c; ctx.fillRect(4, y - 8, 150, 16); ctx.fillStyle = '#0b0f17'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '11px Segoe UI';
  ctx.fillText(`${p.qty > 0 ? '+' : ''}${p.qty} @ ${fp(p.avg)}  ${(p.open < 0 ? '-$' : '$') + Math.abs(p.open).toFixed(2)}`, 8, y);
}

// ---------------------------------------------------------------- Risk Manager: daily loss limit, max contracts, auto-flatten
const today = () => new Date(M.now || Date.now()).toISOString().slice(0, 10);
function riskState() {
  const r = CFG.risk, key = CFG.trader.account + ':' + today(); const p = position();
  if (isSim() && SIM && SIM.day !== today()) { SIM.day = today(); SIM.dayStart = SIM.real - SIM.comm; }
  const day = isSim() ? (SIM.real - SIM.comm - (SIM.dayStart || 0)) + p.open : +(RSNAP?.account?.day_pnl ?? (p.open + p.closed));
  return { day, locked: CFG.riskLock === key || (r.on && day <= -r.maxLoss), key };
}
function riskBlock(dq) {
  const r = CFG.risk; if (!r.on) return null; const s = riskState();
  if (s.locked) return 'Risk Manager: daily loss limit reached — trading is locked for today';
  if (Math.abs(position().qty + dq) > r.maxQty) return `Risk Manager: max ${r.maxQty} contracts`;
  return null;
}
let flattening = false;
function riskCheck() {
  const r = CFG.risk; if (!r.on || flattening) return; const s = riskState();
  if (s.day <= -r.maxLoss && CFG.riskLock !== s.key) {
    CFG.riskLock = s.key; saveCfg(); beep(300); toast('Risk Manager: daily loss limit hit' + (r.flatten ? ' — flattening' : ''));
    if (r.flatten) { flattening = true; flatten().finally(() => flattening = false); }
  }
}

// ---------------------------------------------------------------- toolbar
const TFS = [['S15', 'time', 15], ['S30', 'time', 30], ['M1', 'time', 60], ['M5', 'time', 300], ['M15', 'time', 900], ['M30', 'time', 1800], ['H1', 'time', 3600]];
const CHIP_TIPS = { domHist: 'Order book sizes at the right edge', domLv: 'DOM levels: big resting orders as lines', big: 'Big trades', liq: 'Liquidations (Bybit)', ice: 'Icebergs',
  stopRun: 'Stop runs', exh: 'Exhaustion', dturn: 'Delta turnaround', tapePat: 'Tape patterns (repeating order sizes)', search: 'Cluster search', stats: 'Statistic table', cvd: 'Cumulative delta' };
const CHIPS = [['heat', 'Heatmap'], ['profile', 'Profile'], ['domHist', 'Book'], ['domLv', 'DOM levels'], ['big', 'Big'], ['liq', 'Liqs'], ['sweep', 'Sweeps'], ['ice', 'Ice'], ['stopRun', 'Stops'], ['exh', 'Exhaust'], ['dturn', 'Δ turn'], ['tapePat', 'Tape pat'], ['vwap', 'VWAP'], ['imb', 'Imbalance'], ['stack', 'Stacked'], ['search', 'Search'], ['stats', 'Stats'], ['delta', 'Delta'], ['cvd', 'CumΔ'], ['vol', 'Volume'], ['dom', 'DOM'], ['tape', 'Tape'], ['trader', 'Trader']];
function drawToolbar() {
  $('tfBtns').innerHTML = TFS.map(([l, t, n]) => `<button class="tb${CFG.tf.type === t && CFG.tf.n === n ? ' on' : ''}" data-tf="${t}:${n}">${l}</button>`).join('');
  $('tfType').value = CFG.tf.type; $('tfN').value = CFG.tf.n;
  $('rowT').innerHTML = '<option value="0">Rows: auto' + (CFG.rowTicks ? '' : ` (${M.rt || '…'})`) + '</option>' + [1, 2, 4, 5, 10, 20, 25, 50, 100, 200, 500].map(x => `<option value="${x}">${x} tick${x > 1 ? 's' : ''}/row</option>`).join('');
  $('rowT').value = CFG.rowTicks; $('mode').value = CFG.mode; $('visual').value = CFG.visual;
  $('chips').innerHTML = CHIPS.map(([k, l]) => `<button class="chip${CFG.show[k] ? ' on' : ''}" data-chip="${k}" title="${CHIP_TIPS[k] || l}">${l}</button>`).join(' ');
  for (const k of ['dom', 'tape', 'trader']) $(k).classList.toggle('off', !CFG.show[k]);
  $('stRec').style.display = CFG.record && CFG.src !== 'replay' ? '' : 'none';
  $('replayBar').classList.toggle('on', CFG.src === 'replay'); $('sym').style.display = CFG.src === 'replay' ? 'none' : '';
}
function setTf(type, n) { CFG.tf = { type, n: Math.max(1, +n || 1) }; saveCfg(); rebuild(); view.off = 0; drawToolbar(); }
$('tfBtns').onclick = e => { const v = e.target.dataset.tf; if (v) { const [t, n] = v.split(':'); setTf(t, +n); } };
$('tfType').onchange = () => setTf($('tfType').value, { time: 60, tick: 500, volume: 1000, range: 20 }[$('tfType').value]);
$('tfN').onchange = () => setTf(CFG.tf.type, $('tfN').value);
$('rowT').onchange = () => { CFG.rowTicks = +$('rowT').value; autoRows(); saveCfg(); dirty = true; };
$('mode').onchange = () => { CFG.mode = $('mode').value; saveCfg(); dirty = true; };
$('visual').onchange = () => { CFG.visual = $('visual').value; saveCfg(); dirty = true; };
$('chipsBtn').onclick = () => $('chips').classList.toggle('open');
$('chips').onclick = e => { const k = e.target.dataset.chip; if (!k) return; CFG.show[k] = !CFG.show[k]; saveCfg(); drawToolbar(); dirty = true; renderDom(); renderTape(); renderTrader(); };
$('src').onchange = async () => { CFG.src = $('src').value; if (CFG.src === 'replay') await loadRecs(); else M.sym = CFG.syms[CFG.src]; afterSymbol(); };
$('sym').onchange = () => { const s = $('sym').value.trim().toUpperCase(); if (!(INST[CFG.src] || []).some(x => x.sym === s)) { toast('Unknown instrument: ' + s); $('sym').value = M.sym; return; } M.sym = s; CFG.syms[CFG.src] = s; afterSymbol(); };
function afterSymbol() {
  CFG.sym = M.sym; saveCfg(); fillSymList(); $('src').value = CFG.src; $('sym').value = M.sym;
  view.off = 0; view.center = null; view.follow = true; domTop = null; loadSim(); drawToolbar(); connect(); renderTrader();
}
function fillSymList() { $('symList').innerHTML = (INST[CFG.src] || []).map(x => `<option value="${x.sym}">`).join(''); }
async function loadRecs() {
  RECS = await api('/recordings').catch(() => []);
  $('recFile').innerHTML = RECS.map(r => `<option value="${esc(r.file)}">${esc(r.day)} · ${esc(r.sym)} (${esc(r.src)}, ${r.mb} MB)</option>`).join('') || '<option value="">No recordings yet</option>';
}
$('recFile').onchange = () => connect();
let rpPaused = false;
$('rpPlay').onclick = () => { rpPaused = !rpPaused; $('rpPlay').textContent = rpPaused ? '▶' : '⏸'; ws?.send(JSON.stringify({ cmd: 'pause', on: rpPaused })); };
$('rpSpeed').onchange = () => ws?.send(JSON.stringify({ cmd: 'speed', v: +$('rpSpeed').value }));
$('rpSkip1').onclick = () => ws?.send(JSON.stringify({ cmd: 'skip', to: M.now + 60e3 }));
$('rpSkip10').onclick = () => ws?.send(JSON.stringify({ cmd: 'skip', to: M.now + 600e3 }));

// ---------------------------------------------------------------- settings dialog (generated from a schema)
// ---------------------------------------------------------------- memory: drop trades older than keepHours and rebuild (heatmap frames are capped in captureFrame)
function trimMemory(hours = CFG.keepHours) {
  const cut = (M.now || Date.now()) - hours * 36e5; let k = 0;
  while (k < M.t.length && M.t[k] < cut) k++;
  if (!k) return 0;
  for (const a of [M.t, M.p, M.q, M.s]) a.splice(0, k);
  const old = M.frames.findIndex(f => f.t >= cut); if (old > 0) M.frames.splice(0, old);
  M.tape = M.tape.slice(-500); M.liqs = M.liqs.filter(x => x[0] >= cut); M.icebergs = M.icebergs.filter(x => x.t >= cut); rebuild(); return k;
}
setInterval(() => { if (M.t.length && !M.hist) trimMemory(); }, 5 * 60e3);

const TABS = {
  'Footprint': [['imb.ratio', 'Imbalance ratio %', 'n'], ['imb.min', 'Imbalance minimum volume', 'n'], ['imb.ignoreZero', 'Ignore imbalances against an empty level', 'b'], ['stackN', 'Stacked imbalance: minimum levels', 'n'],
    ['show.poc', 'Highlight each bar\'s POC', 'b'], ['show.grid', 'Price grid', 'b'], ['rightPad', 'Space right of the last bar (px)', 'n']],
  'Heatmap': [['heat.mode', 'Colour by', 's', [['total', 'Total size at each price'], ['order', 'Largest single order (order-by-order, Bitfinex)']]], ['heat.contrast', 'Contrast (0-100)', 'n'], ['heat.cut', 'Upper cut-off % (larger = more levels saturate)', 'n'], ['heat.keepMin', 'History kept (minutes)', 'n'],
    [null, 'The heatmap is built from the live order book (one snapshot every 500 ms) and from recordings during replay.']],
  'Profile': [['profile.src', 'Range', 's', [['session', 'Current session'], ['visible', 'Visible bars']]], ['profile.type', 'Type', 's', [['volume', 'Volume'], ['bidask', 'Bid / Ask'], ['delta', 'Delta']]], ['profile.va', 'Value area %', 'n'], ['profile.w', 'Width (px)', 'n']],
  'Big Trades': [['big.min', 'Minimum cumulative trade size (0 = adaptive: the largest 0.3% of the last 30,000 trades, re-checked every 20 bars)', 'n'], [null, 'Trades with the same timestamp and aggressor side are summed (one market order hitting several resting orders).'],
    ['sweep.levels', 'Sweep: one big market order clears at least this many chart rows', 'n'], ['ice.mult', 'Iceberg: a level trades at least this many times the size it showed and is still there', 'n'],
    [null, 'Liquidations (Bybit): forced closes of leveraged positions — red diamonds = longs liquidated (forced selling), green = shorts liquidated (forced buying). Icebergs are detected live from the order book; sweeps also on history.']],
  'Signals': [[null, 'Stop runs: a fast one-sided burst of market orders (a cascade of stop orders) that moves price several rows. Boxed with STOPS.'],
    ['stopRun.ms', 'Stop run: max gap between trades (ms)', 'n'], ['stopRun.rows', 'Stop run: price moves at least (rows)', 'n'], ['stopRun.mult', 'Stop run: volume at least × big-trade size', 'n'],
    [null, "Exhaustion: buy (sell) volume shrinks level by level into the bar's high (low), the extreme trades almost nothing and the bar closes away from it, so buyers (sellers) ran out. Marked E."], ['exh.pct', "Exhaustion: extreme level volume ≤ % of the bar's average level", 'n'], ['exh.lv', 'Exhaustion: levels of shrinking volume into the extreme', 'n'],
    [null, "Delta turnaround: the bar breaks the previous bar's low (high), closes the other way and its delta flips sign. Marked with an arrow."],
    [null, 'Tape patterns: the same order size printing again and again on one side (an algorithm slicing a large order). Boxed with size×count.'],
    ['tapePat.n', 'Tape pattern: at least this many equal prints', 'n'], ['tapePat.ms', 'Tape pattern: max gap between them (ms)', 'n'], ['tapePat.min', 'Tape pattern: minimum print size (0 = automatic, 5% of big-trade size)', 'n'],
    [null, 'DOM levels: large resting limit orders drawn as lines from when they appeared until they are pulled or filled (live only).'], ['domLv.mult', 'DOM level: size at least × the average book level', 'n']],
  'Smart Tape': [['tape.ms', 'Combine same-side trades within (ms)', 'n'], ['tape.min', 'Minimum print volume (0 = off)', 'n'], ['tape.max', 'Maximum print volume (0 = off)', 'n'],
    ...[0, 1, 2, 3].flatMap(k => [[`tape.alerts.${k}.min`, `Highlight ${k + 1}: volume ≥ (0 = off)`, 'n'], [`tape.alerts.${k}.color`, `Highlight ${k + 1} colour`, 'c'], [`tape.alerts.${k}.sound`, `Highlight ${k + 1} sound`, 'b']])],
  'Cluster Search': 'search',
  'Risk Manager': [['risk.on', 'Enable the Risk Manager', 'b'], ['risk.maxLoss', 'Max daily loss $', 'n'], ['risk.maxQty', 'Max contracts in position', 'n'], ['risk.flatten', 'Flatten and cancel orders when the limit is hit', 'b'],
    [null, 'Applies to the selected account (Sim or Rithmic). When the daily loss limit is reached, new orders are blocked until the next day. Your prop firm\'s own limits still apply on their side.']],
  'Sim commissions': 'comm',
  'Price Alerts': 'alerts',
  'Scripts': 'scripts',
  'Templates': 'templates',
  'Storage': 'storage',
  'Rithmic': 'rithmic',
  'Data': [['histHours', 'Rithmic: hours of tick history to load', 'n'],
    [null, 'Recordings are saved in the app folder under recordings\\ (one file per instrument per day) and appear under Data source → Market Replay.']],
};
const getK = k => k.split('.').reduce((o, x) => o?.[x], CFG);
const setK = (k, v) => { const ks = k.split('.'), last = ks.pop(); ks.reduce((o, x) => o[x], CFG)[last] = v; };
let setTab = 'Footprint';
function openSet(tab) { setTab = tab || setTab; $('mSet').classList.add('open'); drawSet(); }
function closeSet() { $('mSet').classList.remove('open'); }
$('setBtn').onclick = () => openSet();
function drawSet() {
  const hide = PANE ? GLOBAL_TABS : document.body.classList.contains('multi') ? CHART_TABS : [];
  if (hide.includes(setTab)) setTab = Object.keys(TABS).find(t => !hide.includes(t));
  $('setTabs').innerHTML = Object.keys(TABS).filter(t => !hide.includes(t)).map(t => `<button class="${t === setTab ? 'on' : ''}" data-t="${t}">${t}</button>`).join('');
  const s = TABS[setTab], B = $('setBody');
  if (s === 'search') return drawSearchEditor();
  if (s === 'alerts') return drawAlertsTab();
  if (s === 'scripts') return drawScriptsTab();
  if (s === 'templates') return drawTemplatesTab();
  if (s === 'rithmic') return drawRithmic();
  if (s === 'storage') return drawStorage();
  if (s === 'comm') { B.innerHTML = `<div class="full mut">Commission per contract per side, charged on Sim fills.</div>` + (INST.rithmic || []).map(x => `<div><label>${x.sym}</label><input type="number" step="0.01" data-comm="${x.sym}" value="${CFG.comm[x.sym] ?? 0}"></div>`).join(''); return; }
  B.innerHTML = s.map(([k, l, t, opts]) => !k ? `<div class="full note">${l}</div>` :
    t === 'b' ? `<label class="cb full"><input type="checkbox" data-k="${k}"${getK(k) ? ' checked' : ''}> ${l}</label>` :
      t === 's' ? `<div><label>${l}</label><select data-k="${k}">${opts.map(([v, n]) => `<option value="${v}"${getK(k) === v ? ' selected' : ''}>${n}</option>`).join('')}</select></div>` :
        `<div><label>${l}</label><input data-k="${k}" type="${t === 'c' ? 'color' : t === 't' ? 'time' : 'number'}" value="${esc(getK(k))}"${t === 'n' ? ' step="any"' : ''}></div>`).join('');
}
$('setTabs').onclick = e => { if (e.target.dataset.t) { setTab = e.target.dataset.t; drawSet(); } };
$('setBody').addEventListener('change', e => {
  const t = e.target, k = t.dataset.k;
  if (k) { setK(k, t.type === 'checkbox' ? t.checked : t.type === 'number' ? +t.value : t.value); if (k === 'big.min') rebuild(); }
  if (t.dataset.comm) CFG.comm[t.dataset.comm] = +t.value;
  if (t.dataset.cs) { const [i, f] = t.dataset.cs.split(':'), s = CFG.searches[+i]; s[f] = t.type === 'checkbox' ? t.checked : ['min', 'max'].includes(f) ? (t.value === '' ? '' : +t.value) : ['deltaPct', 'range'].includes(f) ? +t.value : t.value; }
  saveCfg(); drawToolbar(); dirty = true; renderTrader();
});
function drawSearchEditor() {
  const sel = (i, f, o) => `<select data-cs="${i}:${f}">${o.map(v => `<option${CFG.searches[i][f] === v ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
  $('setBody').innerHTML = `<div class="full note">Marks price levels matching the filter on every bar (ATAS Cluster Search). "Δ%" = level delta as % of its volume (+75: buyers ≥75%, −75: sellers). Range = rows summed. Alerts fire when a bar closes with a match.</div>
  <div class="full" style="overflow:auto"><table class="cs"><tr><th>On</th><th>Name</th><th>Type</th><th>Min</th><th>Max</th><th>Δ%</th><th>Candle</th><th>Location</th><th>Range</th><th>1/bar</th><th>Shape</th><th>Colour</th><th>Alert</th><th></th></tr>
  ${CFG.searches.map((s, i) => `<tr><td><input type="checkbox" data-cs="${i}:on"${s.on ? ' checked' : ''}></td><td><input data-cs="${i}:name" value="${esc(s.name)}" style="min-width:150px"></td>
    <td>${sel(i, 'type', ['volume', 'delta', 'bid', 'ask', 'trades'])}</td><td><input type="number" data-cs="${i}:min" value="${s.min}" style="width:70px"></td><td><input type="number" data-cs="${i}:max" value="${s.max}" style="width:70px"></td>
    <td><input type="number" data-cs="${i}:deltaPct" value="${s.deltaPct}" style="width:56px"></td><td>${sel(i, 'dir', ['any', 'bull', 'bear'])}</td><td>${sel(i, 'loc', ['any', 'high', 'low', 'body', 'upperWick', 'lowerWick'])}</td>
    <td><input type="number" min="1" data-cs="${i}:range" value="${s.range}" style="width:48px"></td><td><input type="checkbox" data-cs="${i}:one"${s.one ? ' checked' : ''}></td><td>${sel(i, 'shape', ['rect', 'circle'])}</td>
    <td><input type="color" data-cs="${i}:color" value="${s.color}"></td><td><input type="checkbox" data-cs="${i}:alert"${s.alert ? ' checked' : ''}></td><td><button class="btn red" data-csdel="${i}">✕</button></td></tr>`).join('')}</table></div>
  <div class="full"><button class="btn" id="csAdd">+ Add search</button></div>`;
  $('csAdd').onclick = () => { CFG.searches.push({ ...PRESETS[0], name: 'New search', on: true }); saveCfg(); drawSearchEditor(); };
  $('setBody').querySelectorAll('[data-csdel]').forEach(b => b.onclick = () => { CFG.searches.splice(+b.dataset.csdel, 1); saveCfg(); drawSearchEditor(); dirty = true; });
}
const STORAGE = [['ret.days', 'Delete stored data after (days)', 'n'], ['ret.gb', 'Max disk space, oldest deleted first (GB)', 'n'],
  ['histDays', 'Past days of your recordings to show when a chart opens', 'n'], ['keepHours', 'Keep trades in the chart for (hours)', 'n'],
  ['heat.keepMin', 'Keep heatmap in the chart for (minutes)', 'n'], ['cacheMin', 'Server cache for reconnecting windows (minutes)', 'n'],
  ['record', 'Record live data for Market Replay', 'b'], ['recFrom', 'Record from (local time)', 't'], ['recTo', 'Record until (same = all day)', 't']];
async function drawStorage() {
  const B = $('setBody'); B.innerHTML = '<div class="full mut">Loading…</div>';
  const u = await api('/storage').catch(e => ({ error: e.message }));
  const field = ([k, l, t]) => t === 'b' ? `<label class="cb full"><input type="checkbox" data-k="${k}"${getK(k) ? ' checked' : ''}> ${l}</label>`
    : `<div><label>${l}</label><input data-k="${k}" type="${t === 't' ? 'time' : 'number'}" value="${esc(getK(k))}"${t === 'n' ? ' step="any" min="0"' : ''}></div>`;
  const ram = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
  B.innerHTML = `<div class="full note">${u.error ? esc(u.error) : `<b>Disk</b>: ${u.mb} MB in ${u.files} files${u.oldest ? ` (oldest ${u.oldest})` : ''} · ${u.diskFreeGB} GB free on the drive<br>
      <b>Memory</b>: server ${u.ramMB} MB${ram ? ` · this chart ${ram} MB` : ''} · ${M.t.length.toLocaleString()} trades, ${M.frames.length.toLocaleString()} heatmap snapshots`}<br>
      Nothing is downloaded: charts show live data plus what this app recorded itself. Stored files are permanently deleted (not to the Recycle Bin) when older than the limit, checked at start-up and every hour; above the size limit the oldest days go first. Chart memory is trimmed every 5 minutes.</div>
    ${STORAGE.map(field).join('')}
    <div class="full" style="display:flex;gap:8px;align-items:center"><button class="btn blue" id="stClean">Clean up now</button><span class="mut" id="stMsg"></span></div>
    <div class="full note"><b>Background recorder</b>: keeps recording these crypto instruments while the app window is closed (only while the laptop is on and awake). Uses about 0.5–1 GB of disk per instrument per week with the limits above.</div>
    <label class="cb full"><input type="checkbox" data-k="bg.on"${CFG.bg.on ? ' checked' : ''}> Keep recording when the window is closed</label>
    <div><label>Instruments (comma separated)</label><input id="bgSyms" value="${esc(CFG.bg.syms.join(', '))}"></div>
    <label class="cb full"><input type="checkbox" id="bgAuto"${u.autostart ? ' checked' : ''}> Start the background recorder with Windows</label>`;
  $('bgSyms').onchange = () => { CFG.bg.syms = $('bgSyms').value.split(',').map(x => x.trim().toUpperCase()).filter(Boolean); saveCfg(); };
  $('bgAuto').onchange = e => api('/autostart', { on: e.target.checked }).then(r => toast(r.on ? 'Recorder starts with Windows' : 'Removed from Windows startup')).catch(err => toast(err.message));
  $('stClean').onclick = async () => {
    $('stMsg').textContent = 'Cleaning…'; const n = trimMemory();
    await new Promise(r => setTimeout(r, 300)); // let saved settings reach the server first
    const r = await api('/storage', {}).catch(e => ({ error: e.message }));
    toast(r.error ? 'Clean-up failed: ' + r.error : `Freed ${r.freedMB} MB of disk${n ? `, ${n.toLocaleString()} old trades from memory` : ''}`); drawStorage();
  };
}
async function drawRithmic() {
  const c = await api('/rithmic/creds').catch(() => ({}));
  const GW = [['rprotocol.rithmic.com:443', 'Chicago (production)'], ['rituz00100.rithmic.com:443', 'Rithmic Test (conformance)']];
  $('setBody').innerHTML = `<div class="full note">Your prop firm's Rithmic login works here once Rithmic has approved this app for API access: write to Rithmic (rapi@rithmic.com) for R|Protocol API access. They give you a test login and an app name prefix, and you pass a short conformance test on the Test gateway. Until then use Bybit or Market Replay.<br>System name examples: <i>Rithmic Paper Trading</i>, <i>Apex</i>, <i>MES Funded Futures</i>, <i>Rithmic 01</i>. A wrong system name makes the error list the valid names.</div>
    <div><label>Username</label><input id="rUser" value="${esc(c.user || '')}" autocomplete="off"></div><div><label>Password</label><input id="rPass" type="password" placeholder="${c.password ? '(unchanged)' : ''}" autocomplete="new-password"></div>
    <div><label>System name</label><input id="rSys" value="${esc(c.system || '')}" placeholder="e.g. Apex"></div>
    <div><label>Gateway</label><input id="rGw" list="gwList" value="${esc(c.gateway || GW[0][0])}"><datalist id="gwList">${GW.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</datalist></div>
    <div><label>App name (from Rithmic)</label><input id="rApp" value="${esc(c.appName || 'OrderFlow')}"></div><div><label>App version</label><input id="rVer" value="${esc(c.appVersion || '1.0')}"></div>
    <label class="cb full"><input type="checkbox" data-k="rithmicAuto"${CFG.rithmicAuto ? ' checked' : ''}> Connect automatically when the app starts</label>
    <div class="full" style="display:flex;gap:8px"><button class="btn blue" id="rSave">Save &amp; connect</button><button class="btn" id="rDisc">Disconnect</button></div>
    <div class="full" id="rStat">State: ${esc(RSTATE.state)}${RSTATE.error ? `<div class="note" style="margin-top:6px;color:#ff9aaa">${esc(RSTATE.error)}</div>` : ''}${RSTATE.accounts.length ? '<br>Accounts: ' + RSTATE.accounts.map(a => esc(a.name)).join(', ') : ''}</div>
    <div class="full mut">Credentials are stored only on this computer, encrypted with Windows DPAPI (data\\rithmic.cred).</div>`;
  $('rSave').onclick = async () => {
    try { await api('/rithmic/creds', { user: $('rUser').value.trim(), password: $('rPass').value, system: $('rSys').value.trim(), gateway: $('rGw').value.trim(), appName: $('rApp').value.trim(), appVersion: $('rVer').value.trim() });
      $('rStat').textContent = 'Connecting…'; await api('/rithmic/connect', {}); toast('Rithmic connected'); }
    catch (e) { toast('Rithmic: ' + e.message); }
    await pollRithmic(); if (setTab === 'Rithmic') drawRithmic(); if (CFG.src === 'rithmic') connect();
  };
  $('rDisc').onclick = async () => { await api('/rithmic/disconnect', {}).catch(() => { }); await pollRithmic(); drawRithmic(); };
}

// ---------------------------------------------------------------- loop
let lastPaint = 0, lastPanels = 0;
function loop(ts) {
  if (dirty && ts - lastPaint > 50) { dirty = false; lastPaint = ts; try { paint(); } catch (e) { console.error(e); } }
  if (ts - lastPanels > 200) { lastPanels = ts; renderDom(); renderTape(); if (isSim()) renderTrader(); $('clock').textContent = fT(Date.now()) + ' NY'; if (!CFG.rowTicks && $('rowT').options[0]) $('rowT').options[0].text = `Rows: auto (${M.rt})`; }
  requestAnimationFrame(loop);
}
addEventListener('resize', () => dirty = true);

(async function init() {
  const instP = api('/instruments').catch(() => api('/instruments')).catch(() => INST), simP = api('/store/sim').catch(() => ({})); // in parallel
  const [main, paneCfg] = await Promise.all([api('/store/settings').catch(() => ({})), PANE ? api('/store/' + STORE).catch(() => ({})) : null]);
  let mine = PANE ? paneCfg : main;
  if (PANE && !Object.keys(mine).length) { // a new chart in a layout: start from the main chart's look, side panels off
    mine = structuredClone(main); delete mine.layout; mine.src = 'bybit';
    mine.show = { ...(main.show || {}), dom: false, tape: false, trader: false, stats: false }; mine.big = { min: 0 };
    mine.syms = { ...(main.syms || {}), bybit: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'][PANE - 1] };
  }
  CFG = merge(DEF, mine);
  document.body.classList.toggle('pane', !!PANE);
  await initExtras();
  if (!PANE && CFG.layout && CFG.layout !== '1') return enterMulti();
  if (!CFG.searches?.length) CFG.searches = structuredClone(PRESETS);
  [SIMALL, INST] = await Promise.all([simP, instP]);
  M.sym = CFG.src === 'replay' ? CFG.syms.bybit : CFG.syms[CFG.src] || CFG.sym;
  $('qty').value = CFG.trader.qty; $('slT').value = CFG.trader.sl; $('tpT').value = CFG.trader.tp;
  if (CFG.src === 'replay') await loadRecs();
  M.bars = new Bars(CFG.tf, spec().tick, sessionOf); M.rt = CFG.rowTicks || 1;
  afterSymbol(); pollRithmic(); requestAnimationFrame(loop);
})();
