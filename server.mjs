import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA_DIR = process.env.WAITLIST_DATA_DIR || path.join(ROOT, 'data');
const WAITLIST_FILE = process.env.WAITLIST_FILE || path.join(DATA_DIR, 'waitlist.txt');
const ADMIN_PASSWORD = process.env.WAITLIST_ADMIN_PASSWORD || '88488848';
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/waitlist') {
      await handleWaitlist(req, res, url);
      return;
    }

    if (url.pathname === '/api/market-history') {
      await handleMarketHistory(req, res, url);
      return;
    }

    if (url.pathname === '/api/btc-price') {
      await handleBtcPrice(req, res);
      return;
    }

    if (url.pathname === '/api/yaobi-radar') {
      await handleYaobiRadar(req, res, url);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bigfoot Capital site listening on http://${HOST}:${PORT}`);
  console.log(`Waitlist file: ${WAITLIST_FILE}`);
});

const PRICE_SOURCES = [
  {
    source: 'binance',
    url: 'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT',
    parse: (json) => ({ price: Number(json.lastPrice), change: Number(json.priceChangePercent) }),
  },
  {
    source: 'okx',
    url: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
    parse: (json) => {
      const row = json?.data?.[0];
      const price = Number(row?.last);
      const open = Number(row?.open24h);
      return { price, change: open ? ((price - open) / open) * 100 : null };
    },
  },
  {
    source: 'coingecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
    parse: (json) => ({ price: Number(json?.bitcoin?.usd), change: Number(json?.bitcoin?.usd_24h_change) }),
  },
];

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: {
        'User-Agent': 'Mozilla/5.0 Bigfoot BTC price proxy',
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
    if (!upstream.ok) throw new Error(`upstream_${upstream.status}`);
    return upstream.json();
  } finally {
    clearTimeout(timer);
  }
}

async function handleBtcPrice(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const attempts = {};
  for (const item of PRICE_SOURCES) {
    try {
      const json = await fetchJsonWithTimeout(item.url);
      const parsed = item.parse(json);
      if (Number.isFinite(parsed.price)) {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
          pragma: 'no-cache',
          expires: '0',
        });
        res.end(JSON.stringify({
          source: item.source,
          price: parsed.price,
          change: Number.isFinite(parsed.change) ? parsed.change : null,
          fetchedAt: new Date().toISOString(),
          attempts,
        }));
        return;
      }
      attempts[item.source] = 'invalid_price';
    } catch (error) {
      attempts[item.source] = error?.message || 'fetch_failed';
    }
  }

  sendJson(res, 502, { error: 'all_price_sources_failed', attempts });
}

async function handleMarketHistory(req, res, url) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
  if (!['GLD', 'QQQ'].includes(symbol)) {
    sendJson(res, 400, { error: 'unsupported_symbol' });
    return;
  }

  try {
    const upstreamUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d`;
    const upstream = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 Bigfoot BTC market data proxy',
        Accept: 'application/json',
      },
    });

    if (!upstream.ok) {
      sendJson(res, upstream.status, { error: 'upstream_failed', status: upstream.status });
      return;
    }

    const json = await upstream.json();
    const result = json?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const rows = timestamps
      .map((timestamp, index) => ({ timestamp, close: closes[index] }))
      .filter((row) => Number.isFinite(row.close));

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
      expires: '0',
    });
    res.end(JSON.stringify({ symbol, source: 'Yahoo Finance chart via Bigfoot proxy', rows }));
  } catch (error) {
    sendJson(res, 500, { error: 'proxy_error', message: error.message });
  }
}

async function handleWaitlist(req, res, url) {
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const source = String(body.source || 'web').slice(0, 80);
    const platform = String(body.platform || '').slice(0, 40);

    if (!isValidEmail(email)) {
      sendJson(res, 400, { ok: false, error: '请输入有效的电子邮件。' });
      return;
    }

    await mkdir(DATA_DIR, { recursive: true });
    const record = {
      createdAt: new Date().toISOString(),
      email,
      platform,
      source,
      ip: getClientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 240),
    };
    await appendFile(WAITLIST_FILE, JSON.stringify(record) + '\n', 'utf8');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.searchParams.get('action') === 'list') {
    const password = req.headers['x-admin-password'] || url.searchParams.get('password') || '';
    if (String(password) !== ADMIN_PASSWORD) {
      sendJson(res, 401, { ok: false, error: '密码错误' });
      return;
    }

    const items = await readWaitlistItems();
    sendJson(res, 200, { ok: true, items });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function readWaitlistItems() {
  let text = '';
  try {
    text = await readFile(WAITLIST_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .reverse();
}

async function serveStatic(rawPathname, res) {
  let pathname = decodeURIComponent(rawPathname || '/');
  if (pathname === '/') pathname = '/zh.html';
  const safePath = path.normalize(pathname).replace(/^([.][.][/\\])+/, '');
  let filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      if (!pathname.endsWith('/') && pathname !== '/Yaobi') {
        res.writeHead(301, { location: pathname + '/' });
        res.end();
        return;
      }
      filePath = path.join(filePath, 'index.html');
      const indexInfo = await stat(filePath);
      if (!indexInfo.isFile()) throw Object.assign(new Error('Not file'), { code: 'ENOENT' });
    } else if (!info.isFile()) {
      throw Object.assign(new Error('Not file'), { code: 'ENOENT' });
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendText(res, 404, 'Not found');
      return;
    }
    throw error;
  }

  const isDynamicDashboardAsset = pathname === '/btc' || pathname.startsWith('/btc/') || pathname === '/Yaobi' || pathname.startsWith('/Yaobi/');
  const cacheControl = isDynamicDashboardAsset
    ? 'no-store, no-cache, must-revalidate, max-age=0'
    : 'public, max-age=60';
  const headers = {
    'content-type': MIME.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
    'cache-control': cacheControl,
  };
  if (isDynamicDashboardAsset) {
    headers.pragma = 'no-cache';
    headers.expires = '0';
  }

  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

function getClientIp(req) {
  return String(
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    ''
  ).split(',')[0].trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}


const YAOBI_CACHE_MS = 25_000;
const YAOBI_TIMEOUT_MS = 8000;
let yaobiCache = { at: 0, data: null, error: null };

async function handleYaobiRadar(req, res, url) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const force = url.searchParams.get('force') === '1';
  if (!force && yaobiCache.data && Date.now() - yaobiCache.at < YAOBI_CACHE_MS) {
    sendJson(res, 200, { ...yaobiCache.data, cache: 'hit' });
    return;
  }
  try {
    const data = await buildYaobiRadar();
    yaobiCache = { at: Date.now(), data, error: null };
    sendJson(res, 200, { ...data, cache: 'miss' });
  } catch (error) {
    yaobiCache.error = error;
    if (yaobiCache.data) {
      sendJson(res, 200, { ...yaobiCache.data, cache: 'stale', warning: error.message });
      return;
    }
    sendJson(res, 502, { error: error.message, generatedAt: new Date().toISOString() });
  }
}

async function yaobiFetchJson(url, timeoutMs = YAOBI_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: {
        'User-Agent': 'Mozilla/5.0 Bigfoot Yaobi radar',
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
    if (!upstream.ok) throw new Error(`upstream_${upstream.status}_${url}`);
    return upstream.json();
  } finally {
    clearTimeout(timer);
  }
}

function yNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function yClamp(n, min = 0, max = 100) { return Math.max(min, Math.min(max, n)); }
function yBaseSymbol(symbol) { return String(symbol || '').replace(/USDT$/, ''); }
function yMedian(values) {
  const arr = values.filter(Number.isFinite).sort((a, b) => a - b);
  return arr.length ? arr[Math.floor(arr.length / 2)] : null;
}
function yCompactUsd(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

async function getYaobiOiHistory(symbol) {
  try {
    const rows = await yaobiFetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=1h&limit=25`, 6000);
    if (!Array.isArray(rows) || rows.length < 2) return { ok: false };
    const vals = rows.map((row) => yNum(row.sumOpenInterestValue || row.sumOpenInterest, NaN));
    const last = vals[vals.length - 1];
    const at = (back) => vals[Math.max(0, vals.length - 1 - back)];
    const pct = (from) => Number.isFinite(from) && from > 0 && Number.isFinite(last) ? ((last - from) / from) * 100 : null;
    const mid = yMedian(vals);
    return {
      ok: true,
      oi1h: pct(at(1)),
      oi6h: pct(at(6)),
      oi24h: pct(vals[0]),
      oiVsMedian: mid && last ? ((last - mid) / mid) * 100 : null,
      points: rows.length,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function getYaobiKlineStats(symbol) {
  try {
    const rows = await yaobiFetchJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=31`, 6000);
    if (!Array.isArray(rows) || rows.length < 8) return { ok: false };
    const closed = rows.slice(0, -1);
    const last6 = closed.slice(-6).reduce((sum, row) => sum + yNum(row[7], 0), 0);
    const prev24 = closed.slice(0, -6).slice(-24);
    const prev6Avg = prev24.length ? prev24.reduce((sum, row) => sum + yNum(row[7], 0), 0) / Math.max(1, prev24.length / 6) : 0;
    const volume6hRatio = prev6Avg > 0 ? (last6 / prev6Avg) * 100 : null;
    const closeNow = yNum(closed[closed.length - 1]?.[4], NaN);
    const close6 = yNum(closed[Math.max(0, closed.length - 7)]?.[4], NaN);
    const price6h = Number.isFinite(closeNow) && Number.isFinite(close6) && close6 > 0 ? ((closeNow - close6) / close6) * 100 : null;
    return { ok: true, quoteVolume6h: last6, volume6hRatio, price6h, points: closed.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function getYaobiDexHit(ticker) {
  try {
    const json = await yaobiFetchJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker)}`, 5000);
    const pairs = Array.isArray(json.pairs) ? json.pairs : [];
    const hits = pairs.filter((pair) => String(pair.baseToken?.symbol || '').toUpperCase() === ticker).slice(0, 6);
    const liquidity = hits.reduce((sum, pair) => sum + yNum(pair.liquidity?.usd, 0), 0);
    const volume24 = hits.reduce((sum, pair) => sum + yNum(pair.volume?.h24, 0), 0);
    return { ok: true, hits: hits.length, liquidity, volume24 };
  } catch (error) {
    return { ok: false, hits: 0, error: error.message };
  }
}

async function getYaobiBitgetMap() {
  try {
    const json = await yaobiFetchJson('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', 8000);
    const rows = Array.isArray(json.data) ? json.data : [];
    const map = new Map();
    rows.forEach((row) => {
      const ticker = String(row.symbol || '').replace(/USDT$/, '');
      if (ticker) map.set(ticker, { volume24: yNum(row.usdtVolume || row.quoteVolume, 0), funding: yNum(row.fundingRate, NaN) });
    });
    return { ok: true, map, count: map.size };
  } catch (error) {
    return { ok: false, map: new Map(), count: 0, error: error.message };
  }
}

async function getYaobiOkxSet() {
  try {
    const json = await yaobiFetchJson('https://www.okx.com/api/v5/market/tickers?instType=SWAP', 8000);
    const rows = Array.isArray(json.data) ? json.data : [];
    const set = new Set();
    rows.forEach((row) => {
      const inst = String(row.instId || '');
      if (inst.endsWith('-USDT-SWAP')) set.add(inst.split('-')[0]);
    });
    return { ok: true, set, count: set.size };
  } catch (error) {
    return { ok: false, set: new Set(), count: 0, error: error.message };
  }
}

function scoreYaobiItem(item) {
  const oiScore = item.oi24h == null ? 0 : yClamp(item.oi24h >= 0 && item.oi24h <= 45 ? 8 + item.oi24h * 0.45 : 2, 0, 25);
  const priceScore = item.price24h < -20 ? 8 : (item.price24h < 0 ? 14 : item.price24h < 15 ? 20 : item.price24h < 35 ? 12 : 2);
  const fundingAbs = Math.abs(item.funding || 0);
  const fundingScore = fundingAbs <= 0.0003 ? 15 : fundingAbs <= 0.0008 ? 9 : 2;
  const volumeRatio = item.kline?.volume6hRatio;
  const volumeScore = volumeRatio == null ? yClamp((Math.log10(Math.max(item.quoteVolume, 1)) - 6) / 2 * 10, 0, 10) : yClamp((volumeRatio - 60) / 8, 0, 15);
  const dexScore = yClamp((item.dex?.hits || 0) * 3 + Math.log10(Math.max(item.dex?.volume24 || 0, 1)), 0, 15);
  const venueScore = yClamp((item.bitget ? 3 : 0) + (item.okx ? 3 : 0) + (item.dex?.hits ? 2 : 0), 0, 10);
  const score = Math.round(oiScore + priceScore + fundingScore + volumeScore + dexScore + venueScore);
  return { score, breakdown: { oi: Math.round(oiScore), price: Math.round(priceScore), funding: Math.round(fundingScore), volume: Math.round(volumeScore), dex: Math.round(dexScore), venue: Math.round(venueScore) } };
}

function classifyYaobiItem(item) {
  const evidence = ['Binance'];
  const oi1h = item.oi1h;
  const oi6h = item.oi6h;
  const oi24h = item.oi24h;
  const volume6 = item.kline?.quoteVolume6h || 0;
  const volumeRatio = item.kline?.volume6hRatio;
  const fundingAbs = Math.abs(item.funding || 0);
  if (oi24h > 0) evidence.push('OI');
  if (volume6 >= 1_200_000 && volumeRatio >= 120) evidence.push('6h放量');
  else if (item.quoteVolume > 8_000_000) evidence.push('24h成交');
  if (item.dex?.hits) evidence.push('DEX');
  if (item.bitget) evidence.push('Bitget');
  if (item.okx) evidence.push('OKX');
  if (item.funding < 0 && fundingAbs < 0.0003) evidence.push('温和负费率');

  const gates = [];
  const gate = (id, label, pass, reason) => gates.push({ id, label, pass, reason });
  gate('tradeable-universe', '交易宇宙', true, '来自 Binance USDT-M 永续公开交易对。');
  const earlyDiscovery = (item.dex?.hits || 0) > 0 || (oi24h > 0 && item.price24h < 35) || (item.bitget || item.okx);
  gate('early-discovery', '早期痕迹', earlyDiscovery, '至少命中 DEX、OI 健康上升或多交易所确认。');
  const currentWindow = item.price24h < 35 && oi24h != null && oi24h >= 0 && oi24h <= 45 && fundingAbs <= 0.0008;
  gate('current-window', '当前位置', currentWindow, '价格、24h OI、资金费率没有明显过热/退潮。');
  const oiTiming = (oi1h != null && oi1h >= 4 && oi1h <= 12) || (oi6h != null && oi6h >= 8 && oi6h <= 35);
  const volumeTiming = volume6 >= 1_200_000 && volumeRatio != null && volumeRatio >= 120;
  const nonOiConfirm = volumeTiming || (item.dex?.hits || 0) > 0 || (item.funding < 0 && fundingAbs < 0.0003) || item.score >= 80;
  const timingConfirm = oiTiming && volumeTiming && nonOiConfirm;
  gate('timing-confirm', '交易确认', timingConfirm, '需要 OI1h 4%..12% 或 OI6h 8%..35%，6h 成交额 >= $1.2M 且 6h 量比 >= 120%，并有非 OI 确认。');

  let stage = 'early';
  if (gates.every((row) => row.pass)) stage = 'entry';
  else if (item.price24h >= 35 || (oi24h != null && oi24h > 45)) stage = 'pullback';
  else if (!currentWindow || fundingAbs > 0.0008 || item.score < 45) stage = 'risk';
  return { stage, evidence, gates, entryPassed: gates.every((row) => row.pass) };
}

async function buildYaobiRadar() {
  const sources = [];
  const [tickers, premiums, bitget, okx] = await Promise.all([
    yaobiFetchJson('https://fapi.binance.com/fapi/v1/ticker/24hr'),
    yaobiFetchJson('https://fapi.binance.com/fapi/v1/premiumIndex'),
    getYaobiBitgetMap(),
    getYaobiOkxSet(),
  ]);
  sources.push({ name: 'Binance futures 24hr ticker', status: 'ok', rows: Array.isArray(tickers) ? tickers.length : 0 });
  sources.push({ name: 'Binance premiumIndex / funding', status: 'ok', rows: Array.isArray(premiums) ? premiums.length : 0 });
  sources.push({ name: 'Bitget USDT futures', status: bitget.ok ? 'ok' : '请求失败', rows: bitget.count, error: bitget.error });
  sources.push({ name: 'OKX USDT swaps', status: okx.ok ? 'ok' : '请求失败', rows: okx.count, error: okx.error });

  const fundingMap = new Map((Array.isArray(premiums) ? premiums : []).map((row) => [row.symbol, yNum(row.lastFundingRate, 0)]));
  const excluded = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX']);
  const raw = (Array.isArray(tickers) ? tickers : [])
    .filter((row) => String(row.symbol).endsWith('USDT') && !String(row.symbol).includes('_') && yNum(row.quoteVolume) > 2_000_000)
    .map((row) => ({
      symbol: row.symbol,
      ticker: yBaseSymbol(row.symbol),
      price: yNum(row.lastPrice),
      price24h: yNum(row.priceChangePercent),
      quoteVolume: yNum(row.quoteVolume),
      trades: yNum(row.count),
      funding: fundingMap.get(row.symbol) || 0,
    }))
    .filter((row) => !excluded.has(row.ticker));

  const candidates = raw.sort((a, b) => {
    const wa = Math.abs(a.price24h) * 1.2 + Math.log10(a.quoteVolume) * 5 + (a.funding < 0 ? 4 : 0);
    const wb = Math.abs(b.price24h) * 1.2 + Math.log10(b.quoteVolume) * 5 + (b.funding < 0 ? 4 : 0);
    return wb - wa;
  }).slice(0, 36);

  const enriched = [];
  for (let i = 0; i < candidates.length; i += 6) {
    const chunk = candidates.slice(i, i + 6);
    const rows = await Promise.all(chunk.map(async (candidate) => {
      const [oi, dex, kline] = await Promise.all([
        getYaobiOiHistory(candidate.symbol),
        getYaobiDexHit(candidate.ticker),
        getYaobiKlineStats(candidate.symbol),
      ]);
      const item = {
        ...candidate,
        oi1h: oi.oi1h,
        oi6h: oi.oi6h,
        oi24h: oi.oi24h,
        oiOk: oi.ok,
        oiError: oi.error,
        oiPoints: oi.points,
        kline,
        dex,
        bitget: bitget.map.has(candidate.ticker) ? bitget.map.get(candidate.ticker) : null,
        okx: okx.set.has(candidate.ticker),
      };
      Object.assign(item, scoreYaobiItem(item));
      Object.assign(item, classifyYaobiItem(item));
      item.volumeLabel = yCompactUsd(item.quoteVolume);
      item.dexVolumeLabel = yCompactUsd(item.dex?.volume24 || 0);
      return item;
    }));
    enriched.push(...rows);
  }

  sources.push({ name: 'Binance openInterestHist 1h x 24', status: 'ok', rows: enriched.filter((row) => row.oiOk).length });
  sources.push({ name: 'Binance klines 1h x 30 / 6h volume ratio', status: 'ok', rows: enriched.filter((row) => row.kline?.ok).length });
  sources.push({ name: 'DexScreener search', status: 'ok', rows: enriched.filter((row) => row.dex?.ok).length });

  const sorted = enriched.sort((a, b) => b.score - a.score).slice(0, 30);
  const counts = {
    all: sorted.length,
    entry: sorted.filter((row) => row.stage === 'entry').length,
    early: sorted.filter((row) => row.stage === 'early').length,
    pullback: sorted.filter((row) => row.stage === 'pullback').length,
    risk: sorted.filter((row) => row.stage === 'risk').length,
  };
  return {
    generatedAt: new Date().toISOString(),
    refreshMs: YAOBI_CACHE_MS,
    counts,
    sources,
    rules: {
      price: '24h涨幅 < 35% 优先；>=35% 进入回踩/风险',
      oi: 'OI 交易确认用 OI1h 4%..12% 或 OI6h 8%..35%，且 OI24h 0%..45%',
      funding: '-0.03% < funding < +0.03% 视为干净；极端费率降级',
      evidence: 'entry-window 必须四道门全过：交易宇宙、早期痕迹、当前位置、交易确认；高分只进入早发现，不等于可入',
    },
    items: sorted,
  };
}
