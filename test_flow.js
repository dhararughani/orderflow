// node test_flow.js — checks the order-flow engine
const assert = require('assert');
const { fv, decimalsOf, Bars, rowsOf, imbalances, stacked, valueArea, clusterSearch, Sim } = require('./flow.js');

assert.strictEqual(fv(12), '12'); assert.strictEqual(fv(0.0030000001), '0.003'); assert.strictEqual(fv(15234), '15.2k'); assert.strictEqual(fv(-2.5), '-2.5'); assert.strictEqual(fv(0.0001246), '0.00012'); assert.strictEqual(fv(0), '0');
assert.strictEqual(decimalsOf(0.25), 2); assert.strictEqual(decimalsOf(0.00005), 5); assert.strictEqual(decimalsOf(1), 0);

// 1-minute bars: two bars, bid/ask per price, delta, cumulative delta, session VWAP
const B = new Bars({ type: 'time', n: 60 }, 0.25);
B.add(0, 100, 5, 1); B.add(1000, 100.25, 3, -1); B.add(2000, 100.25, 2, 1); B.add(61000, 99.75, 4, -1);
assert.strictEqual(B.list.length, 2);
const b0 = B.list[0];
assert.deepStrictEqual([b0.o, b0.h, b0.l, b0.c, b0.v, b0.d, b0.n], [100, 100.25, 100, 100.25, 10, 4, 3]);
assert.deepStrictEqual(b0.lv.get(401), [3, 2, 2]);
assert.strictEqual(B.list[1].cdc, 0); assert.strictEqual(B.list[1].cdo, 4);
assert.ok(Math.abs(B.list[1].vw - (100 * 5 + 100.25 * 5 + 99.75 * 4) / 14) < 1e-9);
assert.strictEqual(B.at(30000), 0); assert.strictEqual(B.at(61000), 1); assert.strictEqual(B.at(-5), -1);

// tick / volume / range bars
const T = new Bars({ type: 'tick', n: 2 }, 1); for (let i = 0; i < 5; i++) T.add(i, 10, 1, 1); assert.strictEqual(T.list.length, 3);
const R = new Bars({ type: 'range', n: 2 }, 1); [10, 11, 12, 13, 9].forEach((p, i) => R.add(i, p, 1, 1)); assert.strictEqual(R.list.length, 3);

// rows (2 ticks per row), POC
const r2 = rowsOf(b0, 2); assert.strictEqual(r2.m.size, 1); assert.deepStrictEqual(r2.m.get(200), [3, 7, 3]); assert.strictEqual(r2.poc, 200);

// diagonal imbalance: ask 30 at row 1 vs bid 10 at row 0 -> ask imbalance (300% >= 150%)
const rows = { m: new Map([[0, [10, 1, 1]], [1, [2, 30, 1]], [2, [1, 40, 1]], [3, [1, 50, 1]]]) };
const im = imbalances(rows, 150, 5, true);
assert.strictEqual(im.get(1), 1); assert.strictEqual(im.get(0), undefined); // bid 10 vs ask 30 above: no
assert.deepStrictEqual(stacked(im, 3), [{ lo: 1, hi: 3, side: 1 }]);

// value area
const va = valueArea(new Map([[1, 5], [2, 20], [3, 10], [4, 1], [5, 1]]), 70);
assert.deepStrictEqual([va.poc, va.val, va.vah], [2, 2, 3]);

// cluster search: ask-dominated level >= 200 volume (user's "Ask Imbalance (NQ)" preset)
const C = new Bars({ type: 'time', n: 60 }, 0.25); C.add(0, 100, 180, 1); C.add(1, 100, 40, -1); C.add(2, 100.25, 10, -1);
const hits = clusterSearch(C.list[0], rowsOf(C.list[0], 1), 1, 0.25, { type: 'volume', min: 200, deltaPct: 60 });
assert.deepStrictEqual(hits.map(h => h.r), [400]);
assert.strictEqual(clusterSearch(C.list[0], rowsOf(C.list[0], 1), 1, 0.25, { type: 'delta', max: -100 }).length, 0);

// sim: market buy 2 @ ask, bracket TP 4 ticks / SL 2 ticks, TP fills, OCO cancels SL
const S = new Sim({}, () => ({ pv: 20, tick: 0.25, comm: 0 }));
S.place({ side: 1, type: 'market', qty: 2, tp: 4, sl: 2 }, 99.75, 100, 100);
assert.strictEqual(S.pos, 2); assert.strictEqual(S.orders.length, 2);
S.onTrade(100.5); assert.strictEqual(S.pos, 2); S.onTrade(101); assert.strictEqual(S.pos, 0); assert.strictEqual(S.orders.length, 0);
assert.strictEqual(S.real, 1 * 2 * 20);
S.place({ side: -1, type: 'limit', price: 102, qty: 1 }); S.onTrade(101.75); assert.strictEqual(S.pos, 0); S.onTrade(102); assert.strictEqual(S.pos, -1);
S.place({ side: 1, type: 'market', qty: 2 }, 101, 101.25, 101); assert.strictEqual(S.pos, 1); assert.strictEqual(S.avg, 101.25);
console.log('flow ok');
