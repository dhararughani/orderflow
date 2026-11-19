# /// script
# dependencies = ["aiohttp>=3.9", "async_rithmic==1.6.6"]
# ///
"""OrderFlow server. Run: uv run server.py  -> http://127.0.0.1:8770

Feeds (one per source+symbol, shared by every open window):
  rithmic  - live CME/CBOT/NYMEX/COMEX futures through the Rithmic R|Protocol API (trades with aggressor, full order book)
  bybit    - live Bybit USDT perpetuals (trades + 1000-level book), no login
  replay   - a recorded session played back at any speed
Every feed is normalised into 100 ms batches:  {"T": ms, "tr": [[ms, price, size, side(+1 buy/-1 sell)], ...],
  "bd": [[price, size], ...], "ad": [...], "full": 0/1, "bb": best bid, "ba": best ask}   (bd/ad = changed book levels, size 0 = removed)
The same lines are written to recordings/<src>_<SYM>_<UTC day>.jsonl.gz, so a replay is the live stream again.
Storage is bounded: everything stored is deleted after 14 days, oldest first above 4 GB (Settings -> Storage). Nothing is downloaded.

HTTP:  /ws (websocket: {"cmd":"sub", src, sym} / replay controls), /store/<name>, /rithmic/* (creds, connect, accounts, orders), /recordings
"""
import asyncio, base64, collections, ctypes, math, datetime as dt, gc, gzip, json, os, pathlib, re, shutil, subprocess, sys, time, traceback, uuid, zlib
import aiohttp
from aiohttp import web

HERE = pathlib.Path(__file__).parent
DATA = HERE / "data"; DATA.mkdir(exist_ok=True)
REC = HERE / "recordings"; REC.mkdir(exist_ok=True)      # full stream (trades + book) per UTC day, gzip: Market Replay + heatmap
HIST = HERE / "history"; HIST.mkdir(exist_ok=True)       # trades only per UTC day, gzip "t,price,size,side": <src>_<SYM>_<day>.rec.csv.gz
FLUSH = 0.1          # seconds between batches
KEYFRAME = 30        # seconds between full order-book snapshots in the stream/recording
MAXLEV = 400         # order-book levels kept per side (heatmap depth)

# ---------------------------------------------------------------- instruments
FUT = {  # root: exchange, tick, $ per point
    "NQ": ("CME", .25, 20), "MNQ": ("CME", .25, 2), "ES": ("CME", .25, 50), "MES": ("CME", .25, 5),
    "RTY": ("CME", .1, 50), "M2K": ("CME", .1, 5), "YM": ("CBOT", 1, 5), "MYM": ("CBOT", 1, .5),
    "CL": ("NYMEX", .01, 1000), "MCL": ("NYMEX", .01, 100), "GC": ("COMEX", .1, 100), "MGC": ("COMEX", .1, 10),
    "6E": ("CME", .00005, 125000), "ZN": ("CBOT", .015625, 1000),
}


# ---------------------------------------------------------------- settings / credential storage
def store_get(name):
    f = DATA / f"{name}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def store_put(name, obj):
    (DATA / f"{name}.json").write_text(json.dumps(obj), encoding="utf-8")


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def dpapi(data: bytes, protect: bool) -> bytes:  # Windows DPAPI: only this Windows user can decrypt
    buf = ctypes.create_string_buffer(data, len(data))
    bin_, bout = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), _Blob()
    fn = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
    if not fn(ctypes.byref(bin_), None, None, None, None, 0, ctypes.byref(bout)):
        raise OSError("DPAPI failed")
    try:
        return ctypes.string_at(bout.pbData, bout.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(bout.pbData)


CREDS = DATA / "rithmic.cred"


def creds_get():
    return json.loads(dpapi(base64.b64decode(CREDS.read_bytes()), False)) if CREDS.exists() else {}


def creds_put(new):
    c = creds_get()
    c.update({k: v for k, v in new.items() if v not in ("", None)})  # blank = keep stored value
    CREDS.write_bytes(base64.b64encode(dpapi(json.dumps(c).encode(), True)))


# ---------------------------------------------------------------- files: gzip, days, retention, memory
DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
def utc_day():
    return dt.datetime.now(dt.timezone.utc).date().isoformat()


def in_window(s):  # Settings -> Storage: record only between these local times (equal = all day)
    a, b = s.get("recFrom", "00:00"), s.get("recTo", "00:00")
    if a == b:
        return True
    now = time.strftime("%H:%M")
    return a <= now < b if a < b else (now >= a or now < b)


def gz_append(path, text):
    with open(path, "ab") as fh:
        fh.write(gzip.compress(text.encode(), 6))


def gz_lines(path):
    """Lines of a multi-member gzip file; a member cut short by a crash ends the file instead of failing it."""
    try:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            yield from fh
    except (EOFError, OSError, zlib.error):
        return


def read_trades(path):
    out = []
    for line in gz_lines(path):
        c = line.split(",")
        if len(c) == 4:
            out.append([int(c[0]), float(c[1]), float(c[2]), int(c[3])])
    return out


def stored_files():  # everything the app writes besides settings: replay recordings + recorded trades (+ legacy downloads)
    return [*REC.glob("*.jsonl*"), *HIST.glob("*.csv.gz"), *HIST.glob("*.part")]

def _size(p):
    try:
        return p.stat().st_size
    except OSError:
        return 0


def cleanup():
    """Delete (permanently, not to the Recycle Bin) every stored file older than `ret.days` days, then the oldest days
    until the total is under `ret.gb` GB. Files from old downloads (no longer made) are removed too."""
    r = SETTINGS().get("ret") or {}
    days, gb = float(r.get("days", 14)), float(r.get("gb", 4))
    today, freed = utc_day(), 0
    cutoff = (dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=days)).isoformat()
    day = lambda p: (DAY_RE.search(p.name) or [today])[0]
    keep = []
    for p in sorted(stored_files(), key=day):
        legacy = p.name.endswith(".part") or (p.parent == HIST and not p.name.endswith(".rec.csv.gz"))
        if legacy or day(p) < cutoff:
            sz = _size(p)
            try:
                p.unlink(); freed += sz
            except OSError:
                keep.append(p)
        else:
            keep.append(p)
    total = sum(map(_size, keep))
    for p in keep:  # oldest first
        if total <= gb * 1e9:
            break
        if day(p) == today and len({day(x) for x in keep}) > 1:
            continue  # today's file goes last
        sz = _size(p)
        try:
            p.unlink(); total -= sz; freed += sz
        except OSError:
            pass
    return freed

class _PMC(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong)] + [(n, ctypes.c_size_t) for n in (
        "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
        "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]


def _me():
    k32 = ctypes.windll.kernel32
    k32.GetCurrentProcess.restype = ctypes.c_void_p
    return ctypes.c_void_p(k32.GetCurrentProcess())


def ram_mb():  # this server's working set
    c = _PMC(); c.cb = ctypes.sizeof(c)
    ctypes.windll.psapi.GetProcessMemoryInfo(_me(), ctypes.byref(c), c.cb)
    return round(c.WorkingSetSize / 1e6)


def release_ram(minutes=10):
    """Shrink every cache to the last few minutes, collect garbage and hand the freed pages back to Windows."""
    for f in FEEDS.values():
        f.trim(minutes)
    gc.collect()
    ctypes.windll.kernel32.SetProcessWorkingSetSize(_me(), ctypes.c_size_t(-1), ctypes.c_size_t(-1))


def storage():
    fs = stored_files()
    out = {"files": len(fs), "mb": round(sum(map(_size, fs)) / 1e6, 1),
           "oldest": min(((DAY_RE.search(p.name) or [""])[0] for p in fs), default=None)}
    out.update(ramMB=ram_mb(), diskFreeGB=round(shutil.disk_usage(HERE).free / 1e9, 1), autostart=STARTUP_LNK.exists(),
               feeds=[{"src": f.src, "sym": f.sym, "viewers": len(f.clients), "background": (f.src, f.sym) in bg_wanted(),
                       "cacheMin": round((time.time() - f.log[0][0]) / 60, 1) if f.log else 0} for f in FEEDS.values()])
    return out


# ---------------------------------------------------------------- feed: book + trade batching, fan-out, recording
class Feed:
    def __init__(self, src, sym):
        self.src, self.sym = src, sym
        self.bids, self.asks = {}, {}
        self.sent_b, self.sent_a = {}, {}
        self.trades = []
        self.log = collections.deque()  # (inserted, T, line) of the last `cacheMin` minutes, for windows that join later
        self.clients = set()
        self.key_at = 0
        self.rec_day, self.rbuf, self.tbuf, self.flushed = None, [], [], time.time()
        self.status = "starting"
        self.task = None
        self.orders, self.ob = {}, {}
        self.liq = []  # liquidations since the last batch: [ms, price, size, side]; side -1 = longs liquidated (forced selling)  # order-by-order book (Bitfinex): id -> (price, signed size); changes since last batch

    # --- input from the source adapters
    def trade(self, ms, p, q, side):
        self.trades.append([int(ms), p, q, side])

    def level(self, side, p, q):
        book = self.bids if side > 0 else self.asks
        if q > 0:
            book[p] = q
        else:
            book.pop(p, None)

    def clear(self):
        self.bids.clear(); self.asks.clear()

    def order(self, oid, p, a):  # one resting order changed; the price levels are kept as the sum of their orders
        old = self.orders.pop(oid, None)
        if old:
            self._lv(*old, -1)
        if p and a:
            self.orders[oid] = (p, a); self._lv(p, a, 1)
            self.ob[oid] = [p, a]
        else:
            self.ob[oid] = [0, 0]

    def _lv(self, p, a, k):
        book = self.bids if a > 0 else self.asks
        q = round(book.get(p, 0) + k * abs(a), 8)
        if q > 1e-9:
            book[p] = q
        else:
            book.pop(p, None)

    def clear_orders(self):
        self.orders.clear(); self.ob.clear(); self.clear()

    def history(self, trades):  # backfill before live data: no book, flagged so the client does not build heatmap from it
        for i in range(0, len(trades), 5000):
            chunk = trades[i:i + 5000]
            line = json.dumps({"T": chunk[-1][0], "tr": chunk, "hist": 1})
            self.log.append((time.time(), chunk[-1][0], line))
            asyncio.get_running_loop().create_task(self.send(line))  # viewers that joined while history was loading

    # --- output
    def _trim(self, book, rev):
        if len(book) > MAXLEV * 2:
            for p in sorted(book, reverse=rev)[MAXLEV:]:
                del book[p]

    def batch(self):
        self._trim(self.bids, True); self._trim(self.asks, False)
        now = time.time()
        full = now - self.key_at > KEYFRAME
        if full:
            bd, ad = [[p, q] for p, q in self.bids.items()], [[p, q] for p, q in self.asks.items()]
            self.key_at = now
        else:
            bd = [[p, q] for p, q in self.bids.items() if self.sent_b.get(p) != q] + [[p, 0] for p in self.sent_b if p not in self.bids]
            ad = [[p, q] for p, q in self.asks.items() if self.sent_a.get(p) != q] + [[p, 0] for p in self.sent_a if p not in self.asks]
        if not (self.trades or bd or ad or self.ob or self.liq):
            return None
        self.sent_b, self.sent_a = dict(self.bids), dict(self.asks)
        b = {"T": int(now * 1000), "tr": self.trades, "bd": bd, "ad": ad, "full": int(full),
             "bb": max(self.bids) if self.bids else None, "ba": min(self.asks) if self.asks else None}
        if full and self.orders:
            b["obf"] = [[i, p, a] for i, (p, a) in self.orders.items()]
        elif self.ob:
            b["ob"] = [[i, p, a] for i, (p, a) in self.ob.items()]
        self.ob = {}
        if self.liq:
            b["lq"], self.liq = self.liq, []
        trades, self.trades = self.trades, []
        return json.dumps(b), trades, b["T"]

    def record(self, line, trades):
        s = SETTINGS()
        if self.src == "replay" or not s.get("record", True) or not in_window(s):
            return
        day = utc_day()
        if day != self.rec_day:
            self.flush()
            self.rec_day, self.key_at = day, 0  # every file starts with a full book: this diff is skipped, the next batch is a keyframe
            self.tbuf.extend(trades)
            return
        self.rbuf.append(line); self.tbuf.extend(trades)
        if time.time() - self.flushed > 30:
            self.flush()

    def flush(self):  # one gzip member per 30 s: a crash loses at most 30 s
        self.flushed = time.time()
        if not self.rec_day:
            return
        try:
            if self.rbuf:
                gz_append(REC / f"{self.src}_{self.sym}_{self.rec_day}.jsonl.gz", "\n".join(self.rbuf) + "\n")
            if self.tbuf:
                gz_append(HIST / f"{self.src}_{self.sym}_{self.rec_day}.rec.csv.gz", "".join(f"{t},{p},{q},{sd}\n" for t, p, q, sd in self.tbuf))
        except OSError as e:
            print("recording:", e)
        self.rbuf, self.tbuf = [], []

    async def pump(self):
        try:
            await self._pump()
        except asyncio.CancelledError:
            raise
        except Exception:
            traceback.print_exc()
            raise
        finally:
            self.flush()

    def trim(self, minutes):
        old = time.time() - minutes * 60
        while self.log and self.log[0][0] < old:
            self.log.popleft()

    async def _pump(self):
        while True:
            await asyncio.sleep(FLUSH)
            out = self.batch()
            if out is None:
                continue
            line, trades, T = out
            self.log.append((time.time(), trades[0][0] if trades else T, line))  # T = first trade: history is sent strictly before it
            self.trim(float(SETTINGS().get("cacheMin", 120)))
            self.record(line, trades)
            await self.send(line)

    async def send(self, line):
        for ws in list(self.clients):
            try:
                await ws.send_str(line)
            except Exception:
                self.clients.discard(ws)

    async def say(self, status, error=None):
        self.status = status
        await self.send(json.dumps({"status": status, "error": error, "src": self.src, "sym": self.sym}))


FEEDS = {}
_settings_cache = {"t": 0, "v": {}}


def SETTINGS():
    if time.time() - _settings_cache["t"] > 2:
        _settings_cache.update(t=time.time(), v=store_get("settings"))
    return _settings_cache["v"]


# ---------------------------------------------------------------- Bybit USDT perpetuals (public, no login; stream.bybit.com and Binance futures are blocked by the ISP here, bytick.com is Bybit's alternate domain)
BY = "https://api.bybit.com"
T20 = aiohttp.ClientTimeout(total=20)


async def bybit_feed(f: Feed):
    sym = f.sym.upper()
    async with aiohttp.ClientSession() as http:
        while True:
            try:
                await f.say("connecting")
                async with http.ws_connect("wss://stream.bytick.com/v5/public/linear", heartbeat=20) as ws:
                    await ws.send_json({"op": "subscribe", "args": [f"publicTrade.{sym}", f"orderbook.1000.{sym}", f"allLiquidation.{sym}"]})
                    await f.say("live")
                    async for msg in ws:
                        m = json.loads(msg.data)
                        topic, d = m.get("topic", ""), m.get("data")
                        if topic.startswith("publicTrade"):
                            for x in d:
                                f.trade(x["T"], float(x["p"]), float(x["v"]), 1 if x["S"] == "Buy" else -1)
                        elif topic.startswith("allLiquidation"):  # S = side of the liquidated position
                            for x in d:
                                f.liq.append([int(x["T"]), float(x["p"]), float(x["v"]), -1 if x["S"] == "Buy" else 1])
                        elif topic.startswith("orderbook"):
                            if m["type"] == "snapshot":
                                f.clear(); f.key_at = 0
                            for p, q in d["b"]:
                                f.level(1, float(p), float(q))
                            for p, q in d["a"]:
                                f.level(-1, float(p), float(q))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                await f.say("reconnecting", str(e))
                await asyncio.sleep(2)


# ---------------------------------------------------------------- Bitfinex (public, no login): the only big exchange with a free order-by-order book
BFX = "https://api-pub.bitfinex.com/v2"


async def bitfinex_feed(f: Feed):
    sym = "t" + f.sym
    async with aiohttp.ClientSession() as http:
        while True:
            try:
                await f.say("connecting")
                async with http.ws_connect("wss://api-pub.bitfinex.com/ws/2", heartbeat=20) as ws:
                    await ws.send_json({"event": "subscribe", "channel": "book", "symbol": sym, "prec": "R0", "len": "250"})
                    await ws.send_json({"event": "subscribe", "channel": "trades", "symbol": sym})
                    chans = {}
                    async for msg in ws:
                        m = json.loads(msg.data)
                        if isinstance(m, dict):
                            if m.get("event") == "subscribed":
                                chans[m["chanId"]] = m["channel"]
                                if m["channel"] == "book":
                                    f.clear_orders(); f.key_at = 0
                                if len(chans) == 2:
                                    await f.say("live")
                            elif m.get("event") == "error":
                                raise RuntimeError(m.get("msg"))
                            continue
                        ch, d = chans.get(m[0]), m[1]
                        if d == "hb":
                            continue
                        if ch == "book":  # [id, price, amount]; amount > 0 bid, < 0 ask; price 0 = order gone
                            for oid, p, a in (d if d and isinstance(d[0], list) else [d] if d else []):
                                f.order(oid, p, a)
                        elif ch == "trades" and d == "te":  # [id, ms, amount, price]; amount > 0 = buyer was the aggressor
                            _, t, a, p = m[2]
                            f.trade(t, p, abs(a), 1 if a > 0 else -1)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                await f.say("reconnecting", str(e))
                await asyncio.sleep(3)


async def bitfinex_symbols():  # USD pairs by 24 h volume; Bitfinex prices have 5 significant digits -> tick from the price
    async with aiohttp.ClientSession() as http:
        async with http.get(f"{BFX}/tickers", params={"symbols": "ALL"}, timeout=T20) as r:
            rows = await r.json()
    out = []
    for x in rows:
        s_, last = x[0], x[7] if len(x) > 8 else None
        if not s_.startswith("t") or ":" in s_ or s_.startswith("tTEST") or not s_.endswith("USD") or s_.startswith(("tUST", "tUDC", "tTSD", "tEUT")) or not last:
            continue
        out.append((x[8] * last, {"sym": s_[1:], "tick": round(10 ** (math.floor(math.log10(last)) - 4), 10), "pv": 1}))
    return [x for _, x in sorted(out, key=lambda v: -v[0])[:60]]


async def bybit_symbols():
    async with aiohttp.ClientSession() as http:
        async with http.get(BY + "/v5/market/instruments-info", params={"category": "linear", "limit": 1000}, timeout=T20) as r:
            j = await r.json()
    return sorted(({"sym": s["symbol"], "tick": float(s["priceFilter"]["tickSize"]), "pv": 1} for s in j["result"]["list"]
                   if s["quoteCoin"] == "USDT" and s["contractType"] == "LinearPerpetual" and s["status"] == "Trading"),
                  key=lambda x: (x["sym"] not in ("BTCUSDT", "ETHUSDT", "SOLUSDT"), x["sym"]))


# ---------------------------------------------------------------- Rithmic
class Rithmic:
    def __init__(self):
        self.client, self.state, self.error = None, "disconnected", None
        self.accounts, self.pnl, self.acct_pnl, self.orders = [], {}, {}, {}
        self.contracts = {}  # root -> front-month contract (e.g. NQ -> NQZ6)
        self.by_contract = {}  # contract -> Feed

    async def connect(self):
        from async_rithmic import RithmicClient
        c = creds_get()
        missing = [k for k in ("user", "password", "system", "gateway") if not c.get(k)]
        if missing:
            raise ValueError("Missing Rithmic settings: " + ", ".join(missing))
        await self.disconnect()
        self.state, self.error = "connecting", None
        cl = RithmicClient(user=c["user"], password=c["password"], system_name=c["system"], app_name=c.get("appName") or "OrderFlow",
                           app_version=c.get("appVersion") or "1.0", url=c["gateway"])
        cl.on_tick += self.on_tick
        cl.on_order_book += self.on_book
        cl.on_instrument_pnl_update += self.on_pnl
        cl.on_account_pnl_update += self.on_acct
        try:
            await cl.connect()
        except Exception as e:
            self.state, self.error = "error", str(e)
            raise
        self.client, self.state = cl, "connected"
        self.accounts = [{"id": a.account_id, "name": getattr(a, "account_name", "") or a.account_id, "fcm": getattr(a, "fcm_id", "")} for a in await cl.list_accounts()]
        try:
            await cl.subscribe_to_pnl_updates()
        except Exception as e:
            print("pnl subscribe", e)
        for f in FEEDS.values():  # re-attach open futures charts
            if f.src == "rithmic":
                await self.subscribe(f)

    async def disconnect(self):
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass
        self.client, self.state = None, "disconnected"

    async def contract(self, root):
        if root not in self.contracts:
            self.contracts[root] = await self.client.get_front_month_contract(root, FUT[root][0])
        return self.contracts[root]

    async def subscribe(self, f: Feed):
        from async_rithmic import DataType
        root = f.sym
        con = await self.contract(root)
        exch = FUT[root][0]
        self.by_contract[con] = f
        # backfill from the session open (18:00 New York) or the configured number of hours, whichever is shorter
        try:
            hrs = float(SETTINGS().get("histHours", 8))
            now = dt.datetime.now(dt.timezone.utc)
            ticks = await self.client.get_historical_tick_data(con, exch, now - dt.timedelta(hours=hrs), now, max_pages=2000)
            f.history([[int(_n(t.get("data_bar_ssboe")) * 1000 + _n(t.get("data_bar_usecs")) / 1000), _n(t.get("close_price")), _n(t.get("volume")),
                        1 if _n(t.get("ask_volume")) >= _n(t.get("bid_volume")) else -1] for t in ticks or [] if _n(t.get("volume")) > 0])
        except Exception as e:
            print("rithmic history", e)
        await self.client.subscribe_to_market_data(con, exch, DataType.LAST_TRADE | DataType.BBO | DataType.ORDER_BOOK)
        await f.say("live")

    async def unsubscribe(self, f: Feed):
        from async_rithmic import DataType
        con = self.contracts.get(f.sym)
        if self.client and con:
            self.by_contract.pop(con, None)
            await self.client.unsubscribe_from_market_data(con, FUT[f.sym][0], DataType.LAST_TRADE | DataType.BBO | DataType.ORDER_BOOK)

    async def on_tick(self, d):
        f = self.by_contract.get(d.get("symbol"))
        if not f or d.get("is_snapshot"):
            return
        if "trade_price" in d and "trade_size" in d:
            ms = d["datetime"].timestamp() * 1000 if d.get("datetime") else time.time() * 1000
            f.trade(ms, _n(d["trade_price"]), _n(d["trade_size"]), 1 if d.get("aggressor") in (1, "BUY") else -1)  # aggressor: 1 BUY, 2 SELL

    async def on_book(self, r):
        f = self.by_contract.get(r.symbol)
        if not f:
            return
        ut = r.update_type  # 1 CLEAR_ORDER_BOOK, 2 NO_BOOK, 3 SNAPSHOT_IMAGE, 4 BEGIN, 5 MIDDLE, 6 END, 7 SOLO
        if ut in (1, 2):
            f.clear(); return
        if ut == 3 and not getattr(self, "_snap_" + r.symbol, False):
            f.clear(); setattr(self, "_snap_" + r.symbol, True)
        for p, q in zip(r.bid_price, r.bid_size):
            f.level(1, p, q)
        for p, q in zip(r.ask_price, r.ask_size):
            f.level(-1, p, q)
        if ut != 3:
            setattr(self, "_snap_" + r.symbol, False)

    def _dict(self, m):
        from google.protobuf.json_format import MessageToDict
        return m if isinstance(m, dict) else MessageToDict(m, preserving_proto_field_name=True)

    async def on_pnl(self, m):
        d = self._dict(m)
        self.pnl[(d.get("account_id"), d.get("symbol"))] = d

    async def on_acct(self, m):
        d = self._dict(m)
        self.acct_pnl[d.get("account_id")] = d

    async def snapshot(self, acct):
        """Positions, open orders and account P&L for one account (polled by the client)."""
        cl = self.client
        orders = []
        for o in await cl.list_orders(account_id=acct) or []:
            d = self._dict(o)
            if d.get("status") in ("open", "partially filled", "trigger pending", "Open", "Trigger Pending") or d.get("total_unfilled_size", 0) > 0 and d.get("status") not in ("complete", "cancelled"):
                orders.append({"id": d.get("basket_id"), "symbol": d.get("symbol"), "side": 1 if d.get("transaction_type") in (1, "BUY") else -1,
                               "type": d.get("price_type"), "price": d.get("price") or d.get("trigger_price"), "qty": d.get("total_unfilled_size") or d.get("quantity"), "status": d.get("status")})
        pos = [v for (a, _), v in self.pnl.items() if a == acct]
        return {"orders": orders, "positions": pos, "account": self.acct_pnl.get(acct, {})}

    async def order(self, b):
        from async_rithmic import OrderType, TransactionType
        root = b["sym"]
        con, exch, tick = await self.contract(root), FUT[root][0], FUT[root][1]
        kw = {"account_id": b["account"]}
        typ = {"market": OrderType.MARKET, "limit": OrderType.LIMIT, "stop": OrderType.STOP_MARKET}[b["type"]]
        if b["type"] == "limit":
            kw["price"] = float(b["price"])
        if b["type"] == "stop":
            kw["trigger_price"] = float(b["price"])
        if b.get("sl"):
            kw["stop_ticks"] = int(b["sl"])
        if b.get("tp"):
            kw["target_ticks"] = int(b["tp"])
        oid = "of" + uuid.uuid4().hex[:10]
        await self.client.submit_order(oid, con, exch, int(b["qty"]), TransactionType.BUY if b["side"] > 0 else TransactionType.SELL, typ, **kw)
        return {"ok": True, "id": oid, "contract": con, "tick": tick}


def _report(fut):  # a feed task died: log why instead of failing silently
    e = None if fut.cancelled() else fut.exception()
    if e and not isinstance(e, asyncio.CancelledError):
        traceback.print_exception(e, file=sys.stderr)


def _n(v):  # protobuf -> dict gives 64-bit ints as strings and repeated fields as lists
    if isinstance(v, list):
        v = v[0] if v else 0
    return float(v or 0)


RITHMIC = Rithmic()


# ---------------------------------------------------------------- history for a window that opens a chart
async def send_history(ws, f, first_live):
    """Past days (exchange daily file, else what was recorded here) + today's recording + Bybit's last 1000 trades,
    all strictly before `first_live` (the first trade this window got live). Runs after the window is already live;
    ends with {"histDone": 1} so the window merges it once."""
    try:
        await _send_history(ws, f, first_live)
    except asyncio.CancelledError:
        raise
    except Exception:
        traceback.print_exc()
    if not ws.closed:
        await ws.send_str(json.dumps({"histDone": 1}))


async def _send_history(ws, f, first_live):
    """Trades this app recorded itself (today + `histDays` past days, at most the 14 kept). Nothing is downloaded."""
    days = max(0, int(SETTINGS().get("histDays", 1)))
    today = dt.datetime.now(dt.timezone.utc).date()
    for k in range(days, -1, -1):
        rec = HIST / f"{f.src}_{f.sym}_{(today - dt.timedelta(days=k)).isoformat()}.rec.csv.gz"
        if not rec.exists():
            continue
        rows = [r for r in await asyncio.to_thread(read_trades, rec) if r[0] < first_live]
        for i in range(0, len(rows), 20000):
            ch = rows[i:i + 20000]
            await ws.send_str(json.dumps({"T": ch[-1][0], "tr": ch, "hist": 1}))

def start_feed(src, sym):
    f = FEEDS[(src, sym)] = Feed(src, sym)
    if src in ("bybit", "bitfinex"):
        f.task = asyncio.gather((bybit_feed if src == "bybit" else bitfinex_feed)(f), f.pump())
        f.task.add_done_callback(_report)
    return f


async def stop_feed(f):
    FEEDS.pop((f.src, f.sym), None)
    f.task.cancel()
    if f.src == "rithmic":
        try:
            await RITHMIC.unsubscribe(f)
        except Exception:
            pass


BG_TASKS = []


def bg_wanted():  # Settings -> Storage: instruments recorded in the background, also with no window open
    b = SETTINGS().get("bg") or {}
    want = set()  # "BTCUSDT" = Bybit, "bitfinex:BTCUSD" = Bitfinex
    for x in b.get("syms", []) if b.get("on") else []:
        src, _, sym = x.strip().rpartition(":")
        if sym:
            want.add(((src or "bybit").lower(), sym.upper()))
    return want


async def bg_loop():
    while True:
        try:
            want = bg_wanted()
            for key in want:
                if key not in FEEDS:
                    start_feed(*key)
            for key, f in list(FEEDS.items()):
                if key not in want and not f.clients:
                    await stop_feed(f)
        except Exception:
            traceback.print_exc()
        await asyncio.sleep(10)


async def cleanup_loop():
    while True:
        try:
            freed = await asyncio.to_thread(cleanup)
            if freed:
                print(f"cleanup: freed {freed / 1e6:.1f} MB")
        except Exception:
            traceback.print_exc()
        await asyncio.sleep(3600)


# ---------------------------------------------------------------- replay of a recording
class Replay:
    """Plays one recording into one websocket. Controls: pause, speed (0 = as fast as possible), skip (seconds)."""

    def __init__(self, ws, path):
        self.ws, self.path = ws, path
        self.paused, self.speed, self.skip_to = False, 1.0, 0

    async def run(self):
        prev, n = None, 0
        lines = gz_lines(self.path) if self.path.suffix == ".gz" else open(self.path, encoding="utf-8")
        for line in lines:
            if True:
                try:
                    T = json.loads(line)["T"]
                except ValueError:
                    continue
                while self.paused:
                    await asyncio.sleep(0.1)
                if prev is not None and T > self.skip_to and self.speed > 0:
                    await asyncio.sleep(min(5.0, (T - prev) / 1000 / self.speed))
                prev = T
                await self.ws.send_str(line.rstrip("\n"))
                n += 1
                if T <= self.skip_to and n % 50 == 0:
                    await asyncio.sleep(0)
        await self.ws.send_str(json.dumps({"status": "replay finished"}))


# ---------------------------------------------------------------- HTTP / websocket
async def ws_handler(req):
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=0)
    await ws.prepare(req)
    feed, replay, rtask = None, None, None

    async def leave():
        nonlocal feed, replay, rtask
        if rtask:
            rtask.cancel(); rtask = replay = None
        if feed:
            feed.clients.discard(ws)
            if not feed.clients and (feed.src, feed.sym) not in bg_wanted():  # last viewer gone: stop the source
                await stop_feed(feed)
            feed = None

    try:
        async for msg in ws:
            c = json.loads(msg.data)
            cmd = c.get("cmd")
            if cmd == "sub":
                await leave()
                src, sym = c["src"], c["sym"]
                if src == "replay":
                    p = REC / pathlib.Path(c["file"]).name
                    if not p.exists():
                        await ws.send_str(json.dumps({"status": "error", "error": "recording not found"})); continue
                    replay = Replay(ws, p)
                    replay.speed = float(c.get("speed", 1))
                    await ws.send_str(json.dumps({"status": "replay", "src": "replay", "sym": sym}))
                    rtask = asyncio.create_task(replay.run())
                    continue
                key = (src, sym)
                f = FEEDS.get(key)
                if not f:
                    f = start_feed(src, sym)
                    if src == "rithmic":
                        if RITHMIC.state != "connected":
                            FEEDS.pop(key, None)
                            await ws.send_str(json.dumps({"status": "error", "error": "Rithmic is not connected: open Settings → Rithmic and connect", "src": src, "sym": sym})); continue
                        f.task = asyncio.create_task(f.pump())
                        try:
                            await RITHMIC.subscribe(f)
                        except Exception as e:
                            f.task.cancel(); FEEDS.pop(key, None)
                            await ws.send_str(json.dumps({"status": "error", "error": str(e), "src": src, "sym": sym})); continue
                feed = f
                await ws.send_str(json.dumps({"status": "loading", "src": src, "sym": sym}))
                log = list(f.log)
                first_live = log[0][1] if log else int(time.time() * 1000)
                for _, _, line in log:  # cached recent data, then live: the chart is usable right away
                    await ws.send_str(line)
                f.key_at = 0  # make sure this viewer gets a full book right away
                f.clients.add(ws)
                await ws.send_str(json.dumps({"status": f.status, "src": src, "sym": sym}))
                if src in ("bybit", "bitfinex"):  # older days fill in behind the live chart
                    rtask = asyncio.create_task(send_history(ws, f, first_live))
            elif cmd == "unsub":
                await leave()
            elif replay and cmd == "pause":
                replay.paused = bool(c.get("on"))
            elif replay and cmd == "speed":
                replay.speed = float(c["v"])
            elif replay and cmd == "skip":
                replay.skip_to = int(c["to"])
    finally:
        await leave()
    return ws


def jerr(e, code=400):
    return web.json_response({"error": str(e)}, status=code)


async def api_store(req):
    name = req.match_info["name"]
    if not re.fullmatch(r"settings|layout|sim|drawings|alerts|scripts|templates|workspaces|pane[1-4]", name):
        return jerr("unknown store", 404)
    if req.method == "POST":
        store_put(name, await req.json())
        _settings_cache["t"] = 0
        return web.json_response({"ok": True})
    return web.json_response(store_get(name))


async def api_rithmic(req):
    act = req.match_info["act"]
    try:
        if act == "creds" and req.method == "POST":
            creds_put(await req.json())
            return web.json_response({"ok": True})
        if act == "creds":
            c = creds_get()
            return web.json_response({k: ("••••" if k == "password" and v else v) for k, v in c.items()})
        if act == "connect":
            await RITHMIC.connect()
        if act == "disconnect":
            await RITHMIC.disconnect()
        if act == "status" or act in ("connect", "disconnect"):
            return web.json_response({"state": RITHMIC.state, "error": RITHMIC.error, "accounts": RITHMIC.accounts, "contracts": RITHMIC.contracts})
        if RITHMIC.state != "connected":
            return jerr("Rithmic is not connected")
        if act == "snapshot":
            return web.json_response(await RITHMIC.snapshot(req.query["account"]))
        b = await req.json()
        if act == "order":
            return web.json_response(await RITHMIC.order(b))
        if act == "cancel":
            if b.get("id"):
                await RITHMIC.client.cancel_order(basket_id=b["id"], account_id=b["account"])
            else:
                await RITHMIC.client.cancel_all_orders(account_id=b["account"])
            return web.json_response({"ok": True})
        if act == "flatten":
            root = b.get("sym")
            kw = {"account_id": b["account"]}
            if root:
                kw.update(symbol=await RITHMIC.contract(root), exchange=FUT[root][0])
            await RITHMIC.client.exit_position(**kw)
            return web.json_response({"ok": True})
        return jerr("unknown action", 404)
    except Exception as e:
        traceback.print_exc()
        RITHMIC.error = str(e) if act == "connect" else RITHMIC.error
        return jerr(e, 500)


_inst = {"t": 0, "v": None}


async def api_instruments(req):  # cached 10 minutes: every chart in a layout asks for it
    if _inst["v"] and time.time() - _inst["t"] < 600:
        return web.json_response(_inst["v"])
    fut = [{"sym": k, "exch": v[0], "tick": v[1], "pv": v[2]} for k, v in FUT.items()]
    try:
        crypto = await bybit_symbols()
    except Exception:
        crypto = [{"sym": "BTCUSDT", "tick": .1, "pv": 1}, {"sym": "ETHUSDT", "tick": .01, "pv": 1}]
    try:
        bfx = await bitfinex_symbols()
    except Exception:
        bfx = [{"sym": "BTCUSD", "tick": 1, "pv": 1}, {"sym": "ETHUSD", "tick": .1, "pv": 1}]
    v = {"rithmic": fut, "bybit": crypto, "bitfinex": bfx}
    if len(crypto) > 2 and len(bfx) > 2:  # don't cache the fallback lists
        _inst.update(t=time.time(), v=v)
    return web.json_response(v)


async def api_recordings(req):
    out = []
    for p in sorted(REC.glob("*.jsonl*"), key=lambda p: p.name.split("_")[-1], reverse=True):
        src, sym, day = (p.name.split(".")[0].split("_", 2) + ["", ""])[:3]
        out.append({"file": p.name, "src": src, "sym": sym, "day": day, "mb": round(p.stat().st_size / 1e6, 1)})
    return web.json_response(out)


async def index(req):
    return web.FileResponse(HERE / "index.html", headers={"Cache-Control": "no-cache"})


async def static(req):
    p = HERE / req.match_info["f"]
    if p.suffix not in (".js", ".css", ".png", ".svg", ".ico", ".wav") or not p.exists():
        raise web.HTTPNotFound()
    return web.FileResponse(p, headers={"Cache-Control": "no-cache"})


async def shutdown(req):
    if bg_wanted() and req.query.get("force") != "1":  # background recorder on: closing the window keeps recording
        release_ram()
        return web.json_response({"ok": True, "kept": True})
    for f in FEEDS.values():
        f.flush()
    asyncio.get_running_loop().call_later(0.3, os._exit, 0)
    return web.json_response({"ok": True})


async def api_storage(req):
    if req.method == "POST":  # "Clean up now": retention rules + caches trimmed + memory handed back
        freed = await asyncio.to_thread(cleanup)
        release_ram()
        return web.json_response({**storage(), "freedMB": round(freed / 1e6, 1)})
    return web.json_response(storage())


STARTUP_LNK = pathlib.Path(os.environ.get("APPDATA", "")) / r"Microsoft\Windows\Start Menu\Programs\Startup\OrderFlow Recorder.lnk"


async def api_autostart(req):
    """Settings -> Storage: start the background recorder (server only, no window) when Windows starts."""
    on = (await req.json()).get("on")
    if on:
        pyw = shutil.which("pythonw.exe") or r"C:\Program Files\Python311\pythonw.exe"
        launcher = HERE / "OrderFlow.pyw"
        ps = (f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{STARTUP_LNK}');$s.TargetPath='{pyw}';"
              f"$s.Arguments='\"{launcher}\" --background';$s.WorkingDirectory='{HERE}';$s.WindowStyle=7;$s.Save()")
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], creationflags=0x08000000, check=True, timeout=30)
    else:
        STARTUP_LNK.unlink(missing_ok=True)
    return web.json_response({"on": STARTUP_LNK.exists()})


@web.middleware
async def local_only(req, handler):  # credentials and order routing: never reachable from outside this computer
    if req.remote not in ("127.0.0.1", "::1"):
        return jerr("forbidden", 403)
    return await handler(req)


def app():
    a = web.Application(middlewares=[local_only])
    a.add_routes([web.get("/", index), web.get("/ws", ws_handler), web.route("*", "/store/{name}", api_store),
                  web.route("*", "/rithmic/{act}", api_rithmic), web.get("/instruments", api_instruments),
                  web.get("/recordings", api_recordings), web.get("/shutdown", shutdown), web.route("*", "/storage", api_storage),
                  web.post("/autostart", api_autostart), web.get("/{f}", static)])

    async def autoconnect(_):
        BG_TASKS.extend([asyncio.create_task(bg_loop()), asyncio.create_task(cleanup_loop()),
                         asyncio.create_task(_try(api_instruments(None)))])  # warm the instrument list before the window asks
        if SETTINGS().get("rithmicAuto") and creds_get():
            asyncio.create_task(_try(RITHMIC.connect()))
    a.on_startup.append(autoconnect)
    return a


async def _try(coro):
    try:
        await coro
    except Exception as e:
        print("autoconnect:", e)


if __name__ == "__main__":
    print("OrderFlow on http://127.0.0.1:8770")
    web.run_app(app(), host="127.0.0.1", port=8770, print=None)
