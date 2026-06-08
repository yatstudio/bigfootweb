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
      'cache-control': 's-maxage=1800, stale-while-revalidate=3600',
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
      if (!pathname.endsWith('/')) {
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

  res.writeHead(200, {
    'content-type': MIME.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
    'cache-control': 'public, max-age=60',
  });
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
