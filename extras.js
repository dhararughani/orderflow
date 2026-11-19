// OrderFlow extras: price alerts, scripts (custom indicators), chart templates, multi-chart workspaces.
// Uses app.js globals (CFG, M, api, toast, beep, fp, fv, yP, xR, ctx, L, ...). Alerts and scripts are shared by every chart.

// ---------------------------------------------------------------- notifications
function notify(msg, freq = 880) {
  beep(freq); setTimeout(() => beep(freq), 220); toast('🔔 ' + msg);
  try { if (window.Notification && Notification.permission === 'granted') new Notification('OrderFlow', { body: msg, icon: 'icon.png?v=2' }); } catch (e) { }
}

// ---------------------------------------------------------------- price alerts (store "alerts": [{id, src, sym, p, note, fired, created}])
let ALERTS = [];
const alertSrc = () => CFG.src === 'replay' ? M.rsrc : CFG.src;
const saveAlerts = () => api('/store/alerts', ALERTS).catch(e => toast('Alerts not saved: ' + e.message));
function addAlert(p, note = '', sym = M.sym, src = alertSrc()) {
  ALERTS.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), src, sym, p, note, fired: null, created: Date.now() });
  saveAlerts(); dirty = true; toast(`Alert set: ${sym} at ${fp(p)}`);
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) { }
}
function checkPriceAlerts(p) { // fires when a live trade crosses or touches the alert price; each alert fires once
  const prev = M.prevLive; M.prevLive = p;
  if (prev == null || CFG.src === 'replay') return;
  for (const a of ALERTS) {
    if (a.fired || a.sym !== M.sym || a.src !== CFG.src) continue;
    if ((prev < a.p && p >= a.p) || (prev > a.p && p <= a.p)) {
      a.fired = Date.now(); saveAlerts(); dirty = true;
      notify(`${a.sym} ${p >= prev ? 'rose to' : 'fell to'} ${fp(a.p)}${a.note ? ' — ' + a.note : ''}`);
    }
  }
}
function drawAlerts() {
  for (const a of ALERTS) {
    if (a.fired || a.sym !== M.sym || a.src !== alertSrc()) continue;
    const y = Math.round(yP(a.p)) + .5; if (y < 0 || y > L.mh) continue;
    ctx.strokeStyle = '#ffd54f'; ctx.setLineDash([8, 4]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.cw, y); ctx.stroke(); ctx.setLineDash([]);
    const t = `🔔 ${fp(a.p)}${a.note ? '  ' + a.note : ''}`; ctx.font = '11px Segoe UI'; const w = ctx.measureText(t).width + 10, x = L.cw - CFG.rightPad - w - 100;
    ctx.fillStyle = '#ffd54f'; ctx.fillRect(x, y - 8, w, 16); ctx.fillStyle = '#1a1300'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, x + 5, y);
  }
}
function removeAlertAt(y) {
  const k = ALERTS.findIndex(a => !a.fired && a.sym === M.sym && a.src === alertSrc() && Math.abs(yP(a.p) - y) < 6);
  if (k < 0) return false;
  ALERTS.splice(k, 1); saveAlerts(); dirty = true; toast('Alert removed'); return true;
}
function drawAlertsTab() {
  const B = $('setBody'), row = a => `<tr><td>${esc(a.sym)} <span class="mut">${esc(a.src)}</span></td><td><input type="number" step="any" data-al="${a.id}:p" value="${a.p}" style="width:110px"></td>
    <td><input data-al="${a.id}:note" value="${esc(a.note)}" placeholder="note"></td><td>${a.fired ? `<span class="mut">fired ${new Date(a.fired).toLocaleString()}</span>` : '<span class="pos">active</span>'}</td>
    <td style="white-space:nowrap">${a.fired ? `<button class="btn" data-alre="${a.id}">Re-arm</button> ` : ''}<button class="btn red" data-aldel="${a.id}">✕</button></td></tr>`;
  B.innerHTML = `<div class="full note">An alert sounds, shows a message and a Windows notification when a live trade reaches its price, then turns off (Re-arm to use it again).
    Add one with the 🔔 tool or Alt+click on the chart; right-click its line to remove it. Alerts work while a chart of that instrument is open (or the window is open in a layout).</div>
    <div><label>New alert for ${esc(M.sym || '')}: price</label><input type="number" step="any" id="alP" value="${M.last ?? ''}"></div><div><label>Note</label><input id="alN" placeholder="e.g. PDH, breakout level"></div>
    <div class="full"><button class="btn blue" id="alAdd">Add alert</button></div>
    <div class="full"><table class="cs"><tr><th>Instrument</th><th>Price</th><th>Note</th><th>Status</th><th></th></tr>${ALERTS.slice().reverse().map(row).join('') || '<tr><td colspan="5" class="mut">No alerts yet</td></tr>'}</table></div>`;
  $('alAdd').onclick = () => { const v = parseFloat($('alP').value); if (!isFinite(v) || !M.sym) return toast('Enter a price'); addAlert(v, $('alN').value.trim()); drawAlertsTab(); };
  B.querySelectorAll('[data-al]').forEach(i => i.onchange = () => { const [id, f] = i.dataset.al.split(':'), a = ALERTS.find(x => x.id === id); if (!a) return; a[f] = f === 'p' ? parseFloat(i.value) : i.value; saveAlerts(); dirty = true; });
  B.querySelectorAll('[data-alre]').forEach(b => b.onclick = () => { const a = ALERTS.find(x => x.id === b.dataset.alre); a.fired = null; M.prevLive = null; saveAlerts(); dirty = true; drawAlertsTab(); });
  B.querySelectorAll('[data-aldel]').forEach(b => b.onclick = () => { ALERTS = ALERTS.filter(x => x.id !== b.dataset.aldel); saveAlerts(); dirty = true; drawAlertsTab(); });
}

// ---------------------------------------------------------------- scripts: custom indicators in JavaScript (store "scripts")
const EXAMPLES = [
  { name: 'EMA 21', where: 'overlay', type: 'line', color: '#ffb74d', code:
`// Runs once per bar, oldest first. Return a number to plot it (null = nothing).
// b = this bar, i = its index, bars = all bars, s = an object kept between bars.
s.ema = s.ema == null ? b.c : s.ema + (b.c - s.ema) * 2 / (21 + 1);
return s.ema;` },
  { name: 'Bollinger Bands 20, 2', where: 'overlay', type: 'line', color: '#4dd0e1', code:
`// Return an object to plot several lines.
const mid = ta.sma(bars, i, 20), sd = ta.stdev(bars, i, 20);
return { mid, upper: mid + 2 * sd, lower: mid - 2 * sd };` },
  { name: 'Delta %', where: 'pane', type: 'hist', color: '#2ee6a6', code:
`// Delta as a percentage of the bar's volume (buyers vs sellers).
return b.v ? b.d / b.v * 100 : 0;` },
  { name: 'Absorption alert', where: 'pane', type: 'hist', color: '#ba68c8', code:
`// High volume but a small body: aggressive orders absorbed by limit orders.
// alert() fires once per bar, on the live (last) bar only.
const avg = ta.sma(bars, i, 20, x => x.v);
if (i > 20 && b.v > 2 * avg && Math.abs(b.c - b.o) < (b.h - b.l) * 0.3) {
  alert('Absorption: volume ' + b.v.toFixed(1) + ', small body');
  return b.v;
}
return 0;` },
];
const TA = {
  sma(bars, i, n, f = b => b.c) { let s = 0, k = 0; for (let j = Math.max(0, i - n + 1); j <= i; j++, k++) s += f(bars[j]); return k ? s / k : null; },
  stdev(bars, i, n, f = b => b.c) { const m = TA.sma(bars, i, n, f); let s = 0, k = 0; for (let j = Math.max(0, i - n + 1); j <= i; j++, k++) s += (f(bars[j]) - m) ** 2; return k ? Math.sqrt(s / k) : null; },
  highest(bars, i, n, f = b => b.h) { let m = -Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, f(bars[j])); return m; },
  lowest(bars, i, n, f = b => b.l) { let m = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, f(bars[j])); return m; },
};
let SCRIPTS = [], scriptsJSON = '';
const scriptCache = new Map(), PALETTE = ['#ffb74d', '#4dd0e1', '#ba68c8', '#aed581', '#f06292'];
const cleanScripts = () => SCRIPTS.map(({ id, name, on, where, type, color, code }) => ({ id, name, on, where, type, color, code }));
function saveScripts() { const c = cleanScripts(); scriptsJSON = JSON.stringify(c); scriptCache.clear(); dirty = true; return api('/store/scripts', c).catch(e => toast('Scripts not saved: ' + e.message)); }
function compileScript(sc) {
  if (sc._src !== sc.code) {
    sc._src = sc.code;
    try { sc._fn = new Function('b', 'i', 'bars', 's', 'ta', 'alert', '"use strict";\n' + sc.code); sc._err = null; }
    catch (e) { sc._fn = null; sc._err = 'Syntax error: ' + e.message; }
  }
  return sc._fn;
}
// ponytail: recomputes every bar (throttled to 4x/s); an infinite loop in a script freezes the chart until it is fixed
function runScript(sc) {
  const bars = M.bars.list, n = bars.length, last = bars[n - 1], ver = last ? last.ver : 0;
  let c = scriptCache.get(sc.id);
  if (c && c.bars === M.bars && c.code === sc.code && c.n === n && (c.ver === ver || performance.now() - c.t < 250)) return c;
  c = { bars: M.bars, code: sc.code, n, ver, t: performance.now(), series: new Map(), err: null };
  const fn = compileScript(sc); c.err = sc._err;
  if (fn) {
    const st = {}, put = (k, i, v) => { if (typeof v !== 'number' || !isFinite(v)) return; let a = c.series.get(k); if (!a) c.series.set(k, a = new Array(n).fill(null)); a[i] = v; };
    let i = 0;
    try {
      for (; i < n; i++) {
        const b = bars[i], v = fn(b, i, bars, st, TA, msg => scriptAlert(sc, b, i, n, msg));
        if (v == null) continue;
        if (typeof v === 'number') put('value', i, v); else for (const k in v) put(k, i, v[k]);
      }
    } catch (e) { c.err = `Error on bar ${i}: ${e.message}`; }
  }
  if (c.err && c.err !== sc._shown) { sc._shown = c.err; toast(`Script "${sc.name}": ${c.err}`); }
  scriptCache.set(sc.id, c); return c;
}
function scriptAlert(sc, b, i, n, msg) {
  if (i !== n - 1 || M.hist || !M.live) return;
  const k = `script:${sc.id}:${b.t0}:${msg}`; if (M.alerted.has(k)) return; M.alerted.add(k);
  notify(`${M.sym} · ${sc.name}: ${msg}`, 660);
}
const scriptPanes = () => SCRIPTS.filter(s => s.on && s.where === 'pane');
function drawScripts(i0, i1) {
  for (const sc of SCRIPTS) {
    if (!sc.on || sc.where !== 'overlay') continue;
    let j = 0;
    for (const [, a] of runScript(sc).series) {
      ctx.strokeStyle = ctx.fillStyle = j ? PALETTE[j % PALETTE.length] : sc.color; ctx.lineWidth = 1.5; ctx.beginPath(); let pen = false;
      for (let i = i0; i <= i1; i++) {
        const v = a[i], x = xR(i) - CFG.barW / 2; if (v == null) { pen = false; continue; }
        if (sc.type === 'dots') { ctx.fillRect(x - 2, yP(v) - 2, 4, 4); continue; }
        pen ? ctx.lineTo(x, yP(v)) : ctx.moveTo(x, yP(v)); pen = true;
      }
      ctx.stroke(); j++;
    }
  }
  ctx.lineWidth = 1;
}
function scriptPane(p, i0, i1) {
  const sc = SCRIPTS.find(s => 'sc:' + s.id === p.k); if (!sc) return;
  const c = runScript(sc); let lo = Infinity, hi = -Infinity;
  for (const a of c.series.values()) for (let i = i0; i <= i1; i++) if (a[i] != null) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
  if (sc.type === 'hist') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  ctx.fillStyle = C.mut; ctx.font = '11px Segoe UI'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(sc.name + (c.err ? '  ⚠ ' + c.err : ''), 6, p.y + 4);
  if (!isFinite(lo)) return;
  const pad = 6, Y = v => p.y + pad + (hi - v) / ((hi - lo) || 1) * (p.h - 2 * pad), bw = Math.max(1, CFG.barW * .6);
  let j = 0;
  for (const [, a] of c.series) {
    const col = j ? PALETTE[j % PALETTE.length] : sc.color; ctx.strokeStyle = col; ctx.beginPath(); let pen = false;
    for (let i = i0; i <= i1; i++) {
      const v = a[i], x = xR(i) - CFG.barW / 2; if (v == null) { pen = false; continue; }
      if (sc.type === 'hist') { ctx.fillStyle = v >= 0 ? col : C.sell; ctx.fillRect(x - bw / 2, Math.min(Y(0), Y(v)), bw, Math.max(1, Math.abs(Y(v) - Y(0)))); }
      else if (sc.type === 'dots') { ctx.fillStyle = col; ctx.fillRect(x - 2, Y(v) - 2, 4, 4); }
      else { pen ? ctx.lineTo(x, Y(v)) : ctx.moveTo(x, Y(v)); pen = true; }
    }
    ctx.stroke(); j++;
  }
  ctx.fillStyle = C.mut; ctx.textBaseline = 'middle'; ctx.fillText(fv(hi), L.cw + 6, p.y + 10); ctx.fillText(fv(lo), L.cw + 6, p.y + p.h - 10);
}
let scSel = 0;
function drawScriptsTab() {
  const B = $('setBody'), sc = SCRIPTS[scSel] || SCRIPTS[0]; scSel = SCRIPTS.indexOf(sc);
  const opt = (v, l, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`;
  B.innerHTML = `<div class="full" style="display:flex;gap:8px"><select id="scList" style="flex:1">${SCRIPTS.map((s, k) => `<option value="${k}"${k === scSel ? ' selected' : ''}>${s.on ? '● ' : '○ '}${esc(s.name)}</option>`).join('')}</select>
      <button class="btn" id="scNew">+ New</button><button class="btn red" id="scDel"${sc ? '' : ' disabled'}>Delete</button></div>
    ${sc ? `<div><label>Name</label><input id="scName" value="${esc(sc.name)}"></div>
    <div><label>Show on</label><select id="scWhere">${opt('overlay', 'Price chart', sc.where)}${opt('pane', 'Own pane below the chart', sc.where)}</select></div>
    <div><label>Style</label><select id="scType">${opt('line', 'Line', sc.type)}${opt('hist', 'Histogram', sc.type)}${opt('dots', 'Dots', sc.type)}</select></div>
    <div><label>Colour</label><input type="color" id="scColor" value="${sc.color}"></div>
    <label class="cb full"><input type="checkbox" id="scOn"${sc.on ? ' checked' : ''}> Show on the charts</label>
    <div class="full"><textarea id="scCode" spellcheck="false">${esc(sc.code)}</textarea></div>
    <div class="full" style="display:flex;gap:10px;align-items:center"><button class="btn blue" id="scRun">Save &amp; run</button><span id="scMsg" class="mut"></span></div>` : ''}
    <div class="full note">The code runs once for every bar, oldest first, and <b>returns</b> a number to plot, an object like <code>{fast: x, slow: y}</code> for several lines, or <code>null</code>.<br>
      <code>b</code> this bar: <code>o h l c</code> prices, <code>v</code> volume, <code>d</code> delta, <code>bv av</code> bid/ask volume, <code>n</code> trades, <code>maxD minD</code>, <code>cdo cdh cdl cdc</code> cumulative delta, <code>vw sd</code> VWAP and its deviation, <code>t0 t1</code> times (ms), <code>lv</code> footprint (Map price index → [bid, ask, trades]).<br>
      <code>i</code> its index · <code>bars</code> all bars · <code>s</code> an object kept from bar to bar · <code>ta.sma / ta.stdev / ta.highest / ta.lowest(bars, i, length, [x =&gt; x.v])</code> · <code>alert('text')</code> sounds and notifies once per bar on the live bar.</div>`;
  $('scList').onchange = e => { scSel = +e.target.value; drawScriptsTab(); };
  $('scNew').onclick = () => { SCRIPTS.push({ id: Date.now().toString(36), name: 'My indicator', on: true, where: 'pane', type: 'line', color: '#4dd0e1', code: '// return a number for each bar\nreturn b.d;' }); scSel = SCRIPTS.length - 1; saveScripts(); drawScriptsTab(); };
  if (!sc) return;
  $('scDel').onclick = () => { if (!confirm(`Delete the script "${sc.name}"?`)) return; SCRIPTS.splice(scSel, 1); scSel = 0; saveScripts(); drawScriptsTab(); };
  const ta = $('scCode'); ta.onkeydown = e => { if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); } };
  $('scRun').onclick = async () => {
    Object.assign(sc, { name: $('scName').value.trim() || 'Script', where: $('scWhere').value, type: $('scType').value, color: $('scColor').value, on: $('scOn').checked, code: ta.value });
    sc._shown = null; await saveScripts();
    const c = M.bars && N() ? runScript(sc) : { err: compileScript(sc) ? null : sc._err, series: new Map() };
    const msg = $('scMsg'); msg.textContent = c.err ? '⚠ ' + c.err : `✓ Running: ${c.series.size} line(s)${sc.on ? '' : ' (hidden: tick "Show on the charts")'}`; msg.className = c.err ? 'neg' : 'pos';
    $('scList').options[scSel].text = (sc.on ? '● ' : '○ ') + sc.name;
  };
}

// Built-in indicator library (switch on in Settings -> Scripts; edit freely, your changes are kept)
const LIBRARY = [
  { id: 'lib-rsi', name: 'RSI 14', where: 'pane', type: 'line', color: '#ba68c8', code:
`const n = 14, ch = i ? b.c - bars[i - 1].c : 0;
s.up = s.up == null ? Math.max(ch, 0) : (s.up * (n - 1) + Math.max(ch, 0)) / n;
s.dn = s.dn == null ? Math.max(-ch, 0) : (s.dn * (n - 1) + Math.max(-ch, 0)) / n;
return i < n ? null : (s.dn ? 100 - 100 / (1 + s.up / s.dn) : 100);` },
  { id: 'lib-macd', name: 'MACD 12 26 9', where: 'pane', type: 'line', color: '#4dd0e1', code:
`const k = n => 2 / (n + 1);
s.f = s.f == null ? b.c : s.f + (b.c - s.f) * k(12);
s.sl = s.sl == null ? b.c : s.sl + (b.c - s.sl) * k(26);
const macd = s.f - s.sl;
s.sig = s.sig == null ? macd : s.sig + (macd - s.sig) * k(9);
return i < 26 ? null : { macd, signal: s.sig };` },
  { id: 'lib-atr', name: 'ATR 14', where: 'pane', type: 'line', color: '#ffb74d', code:
`const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l;
s.atr = s.atr == null ? tr : (s.atr * 13 + tr) / 14;
return i < 14 ? null : s.atr;` },
  { id: 'lib-stoch', name: 'Stochastic 14 3', where: 'pane', type: 'line', color: '#aed581', code:
`const hh = ta.highest(bars, i, 14), ll = ta.lowest(bars, i, 14);
const k = hh > ll ? (b.c - ll) / (hh - ll) * 100 : 50;
(s.k = s.k || []).push(k); if (s.k.length > 3) s.k.shift();
return i < 14 ? null : { k, d: s.k.reduce((a, x) => a + x, 0) / s.k.length };` },
  { id: 'lib-sma50', name: 'SMA 50', where: 'overlay', type: 'line', color: '#90caf9', code: `return i < 49 ? null : ta.sma(bars, i, 50);` },
  { id: 'lib-speed', name: 'Speed of Tape (trades / second)', where: 'pane', type: 'hist', color: '#00e5ff', code:
`// Highlight when the tape speeds up: trades per second in each bar.
return b.n / Math.max(1, (b.t1 - b.t0) / 1000);` },
  { id: 'lib-vpt', name: 'Volume per trade', where: 'pane', type: 'hist', color: '#f06292', code: `return b.n ? b.v / b.n : 0;` },
  { id: 'lib-daily', name: 'Previous day high / low / close', where: 'overlay', type: 'dots', color: '#ffd54f', code:
`// Sessions: crypto 00:00 UTC, futures 18:00 New York.
if (s.ss !== b.ss) { if (s.cur) s.prev = s.cur; s.cur = { h: b.h, l: b.l }; s.ss = b.ss; }
s.cur.h = Math.max(s.cur.h, b.h); s.cur.l = Math.min(s.cur.l, b.l); s.cur.c = b.c;
return s.prev ? { prevHigh: s.prev.h, prevLow: s.prev.l, prevClose: s.prev.c } : null;` },
  { id: 'lib-ib', name: 'Initial Balance (first hour)', where: 'overlay', type: 'dots', color: '#ce93d8', code:
`if (s.ss !== b.ss) { s.ss = b.ss; s.t = b.t0; s.h = b.h; s.l = b.l; }
if (b.t0 < s.t + 3600e3) { s.h = Math.max(s.h, b.h); s.l = Math.min(s.l, b.l); }
return { ibHigh: s.h, ibLow: s.l };` },
];

// ---------------------------------------------------------------- chart templates (store "templates": {name: settings})
const TPL_KEYS = ['tf', 'rowTicks', 'mode', 'visual', 'barW', 'rowH', 'rightPad', 'show', 'imb', 'stackN', 'heat', 'profile', 'big', 'tape', 'searches'];
async function drawTemplatesTab() {
  const T = await api('/store/templates').catch(() => ({})), names = Object.keys(T).sort(), B = $('setBody');
  B.innerHTML = `<div class="full note">A template stores this chart's look: bar type and size, cluster mode, rows, zoom, which tools are shown, footprint, heatmap, profile, big trades, tape and Cluster Search settings. It does not change the instrument.</div>
    <div><label>Saved templates</label><select id="tpSel">${names.map(n => `<option>${esc(n)}</option>`).join('') || '<option value="">None yet</option>'}</select></div>
    <div style="display:flex;gap:8px;align-items:end"><button class="btn blue" id="tpApply"${names.length ? '' : ' disabled'}>Apply</button><button class="btn red" id="tpDel"${names.length ? '' : ' disabled'}>Delete</button></div>
    <div><label>Save this chart as</label><input id="tpName" placeholder="e.g. Scalping 15s footprint"></div><div style="display:flex;align-items:end"><button class="btn" id="tpSave">Save template</button></div>`;
  $('tpSave').onclick = async () => {
    const n = $('tpName').value.trim(); if (!n) return toast('Give the template a name');
    T[n] = Object.fromEntries(TPL_KEYS.map(k => [k, structuredClone(CFG[k])])); await api('/store/templates', T); toast(`Template "${n}" saved`); drawTemplatesTab();
  };
  $('tpApply').onclick = () => {
    const t = T[$('tpSel').value]; if (!t) return;
    for (const k of TPL_KEYS) if (k in t) CFG[k] = structuredClone(t[k]);
    CFG = merge(DEF, CFG); saveCfg(); rebuild(); drawToolbar(); renderDom(); renderTape(); renderTrader(); dirty = true; toast(`Template "${$('tpSel').value}" applied`);
  };
  $('tpDel').onclick = async () => { const n = $('tpSel').value; if (!n || !confirm(`Delete the template "${n}"?`)) return; delete T[n]; await api('/store/templates', T); drawTemplatesTab(); };
}

// ---------------------------------------------------------------- multi-chart layouts and workspaces (store "workspaces": {name: {layout, panes}})
const LAYOUT_N = { '1': 1, '2h': 2, '2v': 2, '3': 3, '4': 4 };
function enterMulti() {
  document.body.classList.add('multi');
  const g = $('ws'); g.className = 'l' + CFG.layout;
  g.innerHTML = Array.from({ length: LAYOUT_N[CFG.layout] || 1 }, (_, k) => `<iframe src="/?pane=${k + 1}" title="Chart ${k + 1}"></iframe>`).join('');
  loadWorkspaces();
}
async function loadWorkspaces(sel = '') {
  const W = await api('/store/workspaces').catch(() => ({}));
  $('wsSel').innerHTML = '<option value="">Workspaces…</option>' + Object.keys(W).sort().map(n => `<option${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('');
  return W;
}
$('layout').onchange = async () => { CFG.layout = $('layout').value; clearTimeout(saveT); await api('/store/settings', CFG); location.reload(); };
$('wsSave').onclick = async () => {
  const n = (prompt('Workspace name:', $('wsSel').value || 'My workspace') || '').trim(); if (!n) return;
  const W = await api('/store/workspaces').catch(() => ({})), k = LAYOUT_N[CFG.layout];
  W[n] = { layout: CFG.layout, panes: await Promise.all(Array.from({ length: k }, (_, j) => api('/store/pane' + (j + 1)).catch(() => ({})))) };
  await api('/store/workspaces', W); loadWorkspaces(n); toast(`Workspace "${n}" saved`);
};
$('wsSel').onchange = async () => {
  const n = $('wsSel').value; if (!n) return;
  const W = await api('/store/workspaces'), w = W[n]; if (!w) return;
  if (!confirm(`Open the workspace "${n}"? The current charts are replaced (save them first if you want to keep them).`)) { $('wsSel').value = ''; return; }
  await Promise.all(w.panes.map((c, j) => api('/store/pane' + (j + 1), c)));
  CFG.layout = w.layout; await api('/store/settings', CFG); location.reload();
};
$('wsDel').onclick = async () => {
  const n = $('wsSel').value; if (!n) return toast('Pick a workspace first');
  if (!confirm(`Delete the workspace "${n}"?`)) return;
  const W = await api('/store/workspaces'); delete W[n]; await api('/store/workspaces', W); loadWorkspaces();
};

// ---------------------------------------------------------------- start-up + keeping charts in sync (alerts / scripts edited in another chart)
async function initExtras() {
  $('layout').value = CFG.layout || '1';
  const [a, sc] = await Promise.all([api('/store/alerts').catch(() => []), api('/store/scripts').catch(() => null)]);
  ALERTS = Array.isArray(a) ? a : [];
  if (Array.isArray(sc)) { SCRIPTS = sc; scriptsJSON = JSON.stringify(sc); }
  else SCRIPTS = EXAMPLES.map((x, k) => ({ id: 'ex' + k, on: false, ...x }));
  const missing = LIBRARY.filter(l => !SCRIPTS.some(x => x.id === l.id)); // add library entries once; never overwrite edits
  if (missing.length || !Array.isArray(sc)) { SCRIPTS.push(...missing.map(l => ({ on: false, ...l }))); if (!PANE) saveScripts(); }
}
setInterval(async () => {
  try {
    const [a, sc] = await Promise.all([api('/store/alerts'), api('/store/scripts')]);
    if (Array.isArray(a) && JSON.stringify(a) !== JSON.stringify(ALERTS)) { ALERTS = a; dirty = true; }
    if (Array.isArray(sc)) { const j = JSON.stringify(sc); if (j !== scriptsJSON) { scriptsJSON = j; SCRIPTS = sc; scriptCache.clear(); dirty = true; } }
  } catch (e) { }
}, 5000);
// Settings tabs that belong to the whole app (hidden inside layout charts) vs. to one chart (hidden on the layout page itself)
const GLOBAL_TABS = ['Risk Manager', 'Sim commissions', 'Storage', 'Rithmic', 'Data'];
const CHART_TABS = ['Footprint', 'Heatmap', 'Profile', 'Big Trades', 'Smart Tape', 'Cluster Search', 'Templates'];

// ---------------------------------------------------------------- order-flow events: sweeps, icebergs, liquidations
function sweepCheck(c) { // one aggressive order (same ms + side) that cleared several price levels
  // measured in chart rows (so it scales with the instrument) and only for orders of big-trade size
  const lv = Math.floor(c.hi / rowSize()) - Math.floor(c.lo / rowSize()) + 1;
  if (lv >= (CFG.sweep.levels || 4) && c.q >= bigMin()) M.sweeps.push({ t: c.t, p0: c.s > 0 ? c.lo : c.hi, p1: c.s > 0 ? c.hi : c.lo, q: c.q, s: c.s, lv });
}
function iceTrack(t, p, q, s) { // live only: a passive level that keeps absorbing more than it ever showed
  const book = s > 0 ? M.asks : M.bids, shown = book.get(p) || 0, k = s > 0 ? p : -p;
  let e = M.ice.get(k);
  if (!e || t - e.t > 60000) { e = { shown, exec: 0, t, done: false }; M.ice.set(k, e); if (M.ice.size > 5000) M.ice.clear(); }
  e.exec += q; e.t = t; e.shown = Math.max(e.shown, shown);
  if (!e.done && e.shown > 0 && shown > 0 && e.exec >= (CFG.ice.mult || 2) * e.shown && e.exec >= bigMin() / 2) {
    e.done = true; M.icebergs.push({ t, p, q: e.exec, shown: e.shown, s: -s }); // s: side of the hidden order (opposite the aggressor)
  }
}
function flowMarks(i0, i1) {
  const t0 = M.bars.list[i0].t0, mn = bigMin();
  ctx.lineWidth = 2; ctx.font = '10px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (CFG.show.sweep) for (const w of M.sweeps) { // arrow from the first to the last price swept
    if (w.t < t0) continue; const x = xT(w.t); if (x == null || x > L.cw) continue;
    const ya = yP(w.p0), yb = yP(w.p1), c = w.s > 0 ? '#00e5ff' : '#ff9100', d = w.s > 0 ? -1 : 1;
    ctx.strokeStyle = ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x, ya); ctx.lineTo(x, yb); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, yb + d * 2); ctx.lineTo(x - 5, yb - d * 6); ctx.lineTo(x + 5, yb - d * 6); ctx.fill();
  }
  if (CFG.show.ice) for (const g of M.icebergs) {
    if (g.t < t0) continue; const x = xT(g.t); if (x == null || x > L.cw) continue;
    const y = yP(g.p); ctx.fillStyle = g.s > 0 ? 'rgba(0,229,255,.85)' : 'rgba(255,145,0,.85)'; ctx.fillRect(x - 7, y - 7, 14, 14);
    ctx.fillStyle = '#04121a'; ctx.fillText('I', x, y + .5);
  }
  if (CFG.show.liq) for (const [t, p, q, s] of M.liqs) {
    if (t < t0) continue; const x = xT(t); if (x == null || x > L.cw) continue;
    const y = yP(p), r = Math.max(5, Math.min(22, Math.sqrt(q / mn) * 7));
    ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
    ctx.fillStyle = s > 0 ? 'rgba(46,230,166,.75)' : 'rgba(255,107,132,.75)'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
    if (r > 10) { ctx.fillStyle = '#fff'; ctx.fillText(fv(q), x, y); }
  }
  ctx.lineWidth = 1;
}

// ---------------------------------------------------------------- stop runs, tape patterns (trade stream, history too)
function flowTrade(t, p, q, s) {
  const R = CFG.stopRun, r = M.sr; // stop run: consecutive aggression in one direction with no pause
  if (r && t - r.t1 <= R.ms) { if (s === r.s) { r.q += q; r.p1 = p; } else r.opp += q; r.t1 = t; }
  else { if (r) stopRunEnd(r); M.sr = { s, t0: t, t1: t, p0: p, p1: p, q, opp: 0 }; }
  const c = M.tpc, P = CFG.tapePat; // tape pattern: identical sizes repeating on one side
  if (q < (P.min || bigMin() * .05)) return;
  if (c && c.s === s && Math.abs(c.q - q) < 1e-9 && t - c.t1 <= P.ms) {
    c.n++; c.t1 = t; c.lo = Math.min(c.lo, p); c.hi = Math.max(c.hi, p);
    if (c.n === P.n) M.tps.push(c);
  } else M.tpc = { s, q, n: 1, t0: t, t1: t, lo: p, hi: p };
}
function stopRunEnd(r) {
  const rows = Math.abs(r.p1 - r.p0) / rowSize();
  if ((r.p1 - r.p0) * r.s > 0 && rows >= CFG.stopRun.rows && r.q >= CFG.stopRun.mult * bigMin() && r.opp <= .2 * r.q) M.stopRuns.push(r);
}
// ---------------------------------------------------------------- per-bar signals: exhaustion, delta turnaround (finished bars)
function barSignals(i0, i1) {
  const tick = spec().tick, last = M.bars.list.length - 1;
  const mark = (x, y, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill(); ctx.fillStyle = '#111'; ctx.fillText('E', x, y + .5); };
  const arrow = (x, y, d) => { // d = 1 up (bullish), -1 down
    ctx.fillStyle = d > 0 ? '#2ee6a6' : '#ff6b84'; ctx.beginPath();
    ctx.moveTo(x, y - d * 9); ctx.lineTo(x - 7, y + d * 3); ctx.lineTo(x - 2.5, y + d * 3); ctx.lineTo(x - 2.5, y + d * 9);
    ctx.lineTo(x + 2.5, y + d * 9); ctx.lineTo(x + 2.5, y + d * 3); ctx.lineTo(x + 7, y + d * 3); ctx.closePath(); ctx.fill();
  };
  ctx.font = 'bold 10px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = Math.max(1, i0); i <= Math.min(i1, last - 1); i++) {
    const b = M.bars.list[i], a = M.bars.list[i - 1], x = xR(i) - CFG.barW / 2;
    if (CFG.show.exh && (b.h - b.l) / rowSize() >= 3 && b.lv.size) {
      const lim = b.v / b.lv.size * CFG.exh.pct / 100, n = CFG.exh.lv || 2, rg = b.h - b.l;
      // side 1 = ask volume into the high, 0 = bid volume into the low; strictly shrinking toward the extreme
      const fade = (from, dir, side) => { const v = []; for (let k = 0; k < n; k++) v.push((b.lv.get(from + dir * k) || [0, 0])[side]);
        return v[0] > 0 && v[0] <= lim && v.every((x, k) => !k || x > v[k - 1]); };
      if (b.c < b.h - rg * .3 && fade(Math.round(b.h / tick), -1, 1)) mark(x, yP(b.h) - 9, '#ffb300');
      if (b.c > b.l + rg * .3 && fade(Math.round(b.l / tick), 1, 0)) mark(x, yP(b.l) + 9, '#ffb300');
    }
    if (CFG.show.dturn) {
      if (b.l < a.l && b.c > b.o && b.d > 0 && a.d < 0) arrow(x, yP(b.l) + 22, 1);
      if (b.h > a.h && b.c < b.o && b.d < 0 && a.d > 0) arrow(x, yP(b.h) - 22, -1);
    }
  }
}
// ---------------------------------------------------------------- DOM levels: big resting orders as lines from when they appeared (live book)
function domLevels() {
  const all = [...M.bids].map(([p, q]) => [p, q, 1]).concat([...M.asks].map(([p, q]) => [p, q, -1]));
  if (!all.length) return;
  const lim = all.reduce((a, x) => a + x[1], 0) / all.length * CFG.domLv.mult, now = M.now || Date.now(), seen = M.lvSeen, big = new Set();
  ctx.font = '10px Consolas'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  for (const [p, q, s] of all) {
    if (q < lim) continue;
    const k = s * p; big.add(k); if (!seen.has(k)) seen.set(k, now);
    const y = yP(p); if (y < 0 || y > L.mh) continue;
    const x = Math.max(0, xT(seen.get(k)) ?? 0);
    ctx.strokeStyle = ctx.fillStyle = s > 0 ? 'rgba(46,230,166,.8)' : 'rgba(255,107,132,.8)'; ctx.lineWidth = Math.min(4, 1 + q / lim);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(L.cw, y); ctx.stroke(); ctx.fillText(fv(q), x + 3, y - 2);
  }
  for (const k of seen.keys()) if (!big.has(k)) seen.delete(k); // pulled or filled
  ctx.lineWidth = 1;
}
function flowMarks2(i0, i1) {
  const t0 = M.bars.list[i0].t0;
  barSignals(i0, i1);
  if (CFG.show.stopRun) for (const r of M.stopRuns) {
    if (r.t1 < t0) continue; const xa = xT(r.t0), xb = xT(r.t1); if (xa == null || xa > L.cw) continue;
    const ya = yP(r.p0), yb = yP(r.p1), c = r.s > 0 ? '#2979ff' : '#d500f9', w = Math.max(xb - xa, 6) + 6, top = Math.min(ya, yb);
    ctx.fillStyle = c + '33'; ctx.fillRect(xa - 3, top, w, Math.abs(yb - ya));
    ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.strokeRect(xa - 3, top, w, Math.abs(yb - ya));
    ctx.fillStyle = c; ctx.font = 'bold 10px Segoe UI'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('STOPS ' + fv(r.q), xa + w, yb);
  }
  if (CFG.show.tapePat) for (const c of M.tps) {
    if (c.t1 < t0) continue; const xa = xT(c.t0), xb = xT(c.t1); if (xa == null || xa > L.cw) continue;
    const ya = yP(c.hi) - 5, yb = yP(c.lo) + 5;
    ctx.setLineDash([3, 2]); ctx.strokeStyle = ctx.fillStyle = c.s > 0 ? '#80deea' : '#ffab91'; ctx.lineWidth = 1.5;
    ctx.strokeRect(xa - 4, ya, Math.max(8, xb - xa + 8), yb - ya); ctx.setLineDash([]);
    ctx.font = '10px Segoe UI'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`${fv(c.q)}×${c.n}`, xa - 4, ya - 1);
  }
  if (CFG.show.domLv) domLevels();
  ctx.lineWidth = 1;
}
