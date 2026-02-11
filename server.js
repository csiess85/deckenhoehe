// Local server that serves static files and proxies METAR + TAF + airport requests
// to aviationweather.gov (CORS bypass) and api.core.openaip.net (key on server)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5556;
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Persistent config stored in data/config.json
const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch (e) { return {}; }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getApiKey() {
  return process.env.OPENAIP_API_KEY || readConfig().openaipApiKey || null;
}

// In-memory cache keyed by request URL
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key, statusCode, body) {
  cache.set(key, { statusCode, body, time: Date.now() });
}

// API call statistics
const serverStartTime = Date.now();
const stats = {
  metar: { total: 0, cached: 0, errors: 0, log: [] },
  taf:   { total: 0, cached: 0, errors: 0, log: [] },
};
const MAX_LOG_ENTRIES = 100;

function logCall(type, entry) {
  stats[type].log.unshift(entry);
  if (stats[type].log.length > MAX_LOG_ENTRIES) stats[type].log.pop();
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/data/')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function proxyMetar(req, res, query) {
  const ids = query.ids || '';
  if (!ids) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing ids parameter' }));
    return;
  }

  const force = query.force === '1';
  stats.metar.total++;
  const cacheKey = `metar:${ids}`;

  if (force) {
    cache.delete(cacheKey);
    if (VERBOSE) console.log(`[METAR] CACHE INVALIDATED (force refresh)`);
  }

  const cached = getCached(cacheKey);
  if (cached) {
    stats.metar.cached++;
    logCall('metar', { time: Date.now(), cached: true, age: Math.round((Date.now() - cached.time) / 1000) });
    if (VERBOSE) console.log(`[METAR] CACHE HIT (age ${Math.round((Date.now() - cached.time) / 1000)}s)`);
    res.writeHead(cached.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Cache, X-Fetch-Time', 'X-Cache': 'HIT', 'X-Fetch-Time': new Date(cached.time).toISOString() });
    res.end(cached.body);
    return;
  }

  const awcUrl = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ids)}&format=json`;
  const startTime = Date.now();

  if (VERBOSE) console.log(`[METAR] --> GET ${awcUrl}`);

  https.get(awcUrl, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      const duration = Date.now() - startTime;
      if (VERBOSE) console.log(`[METAR] <-- ${proxyRes.statusCode} (${body.length} bytes, ${duration}ms)`);
      if (proxyRes.statusCode === 200) setCache(cacheKey, proxyRes.statusCode, body);
      logCall('metar', { time: Date.now(), cached: false, status: proxyRes.statusCode, bytes: body.length, duration });
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Cache, X-Fetch-Time',
        'X-Cache': 'MISS',
        'X-Fetch-Time': new Date().toISOString(),
      });
      res.end(body);
    });
  }).on('error', (err) => {
    stats.metar.errors++;
    logCall('metar', { time: Date.now(), cached: false, error: err.message, duration: Date.now() - startTime });
    if (VERBOSE) console.log(`[METAR] <-- ERROR ${err.message} (${Date.now() - startTime}ms)`);
    console.error('METAR proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch METAR data' }));
  });
}

function proxyTaf(req, res, query) {
  const ids = query.ids || '';
  if (!ids) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing ids parameter' }));
    return;
  }

  const force = query.force === '1';
  stats.taf.total++;
  const cacheKey = `taf:${ids}`;

  if (force) {
    cache.delete(cacheKey);
    if (VERBOSE) console.log(`[TAF]   CACHE INVALIDATED (force refresh)`);
  }

  const cached = getCached(cacheKey);
  if (cached) {
    stats.taf.cached++;
    logCall('taf', { time: Date.now(), cached: true, age: Math.round((Date.now() - cached.time) / 1000) });
    if (VERBOSE) console.log(`[TAF]   CACHE HIT (age ${Math.round((Date.now() - cached.time) / 1000)}s)`);
    res.writeHead(cached.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Cache, X-Fetch-Time', 'X-Cache': 'HIT', 'X-Fetch-Time': new Date(cached.time).toISOString() });
    res.end(cached.body);
    return;
  }

  const awcUrl = `https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(ids)}&format=json`;
  const startTime = Date.now();

  if (VERBOSE) console.log(`[TAF]   --> GET ${awcUrl}`);

  https.get(awcUrl, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      const duration = Date.now() - startTime;
      if (VERBOSE) console.log(`[TAF]   <-- ${proxyRes.statusCode} (${body.length} bytes, ${duration}ms)`);
      if (proxyRes.statusCode === 200) setCache(cacheKey, proxyRes.statusCode, body);
      logCall('taf', { time: Date.now(), cached: false, status: proxyRes.statusCode, bytes: body.length, duration });
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Cache, X-Fetch-Time',
        'X-Cache': 'MISS',
        'X-Fetch-Time': new Date().toISOString(),
      });
      res.end(body);
    });
  }).on('error', (err) => {
    stats.taf.errors++;
    logCall('taf', { time: Date.now(), cached: false, error: err.message, duration: Date.now() - startTime });
    if (VERBOSE) console.log(`[TAF]   <-- ERROR ${err.message} (${Date.now() - startTime}ms)`);
    console.error('TAF proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch TAF data' }));
  });
}

function proxyAirports(req, res, query) {
  const apiKey = getApiKey();
  if (!apiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No API key configured' }));
    return;
  }

  const country = query.country || 'AT';
  const page = query.page || '1';
  const limit = query.limit || '100';
  const cacheKey = `airports:${country}:${page}:${limit}`;

  const cached = getCached(cacheKey);
  if (cached) {
    if (VERBOSE) console.log(`[AIRPORTS] CACHE HIT (age ${Math.round((Date.now() - cached.time) / 1000)}s)`);
    res.writeHead(cached.statusCode, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
    res.end(cached.body);
    return;
  }

  const openaipUrl = `https://api.core.openaip.net/api/airports?country=${encodeURIComponent(country)}&page=${page}&limit=${limit}`;
  const startTime = Date.now();
  if (VERBOSE) console.log(`[AIRPORTS] --> GET ${openaipUrl}`);

  const parsed = new URL(openaipUrl);
  https.get({
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    headers: { 'x-openaip-api-key': apiKey },
  }, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      const duration = Date.now() - startTime;
      if (VERBOSE) console.log(`[AIRPORTS] <-- ${proxyRes.statusCode} (${body.length} bytes, ${duration}ms)`);
      if (proxyRes.statusCode === 200) setCache(cacheKey, proxyRes.statusCode, body);
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
      res.end(body);
    });
  }).on('error', (err) => {
    if (VERBOSE) console.log(`[AIRPORTS] <-- ERROR ${err.message} (${Date.now() - startTime}ms)`);
    console.error('Airports proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch airport data' }));
  });
}

function handleConfigGet(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ hasKey: !!getApiKey() }));
}

function handleConfigPost(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let apiKey;
    try { apiKey = JSON.parse(body).apiKey; }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or empty apiKey' }));
      return;
    }
    apiKey = apiKey.trim();

    // Validate by test-fetching from OpenAIP
    const testUrl = new URL('https://api.core.openaip.net/api/airports?country=AT&page=1&limit=1');
    if (VERBOSE) console.log(`[CONFIG] Validating API key...`);
    https.get({
      hostname: testUrl.hostname,
      path: testUrl.pathname + testUrl.search,
      headers: { 'x-openaip-api-key': apiKey },
    }, (testRes) => {
      let testBody = '';
      testRes.on('data', chunk => testBody += chunk);
      testRes.on('end', () => {
        if (testRes.statusCode === 200) {
          const config = readConfig();
          config.openaipApiKey = apiKey;
          writeConfig(config);
          if (VERBOSE) console.log(`[CONFIG] API key saved`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          if (VERBOSE) console.log(`[CONFIG] API key invalid (${testRes.statusCode})`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid API key (OpenAIP returned ${testRes.statusCode})` }));
        }
      });
    }).on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to validate key: ${err.message}` }));
    });
  });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const query = Object.fromEntries(parsed.searchParams);

  if (parsed.pathname === '/api/metar') {
    proxyMetar(req, res, query);
  } else if (parsed.pathname === '/api/taf') {
    proxyTaf(req, res, query);
  } else if (parsed.pathname === '/api/airports') {
    proxyAirports(req, res, query);
  } else if (parsed.pathname === '/api/config' && req.method === 'GET') {
    handleConfigGet(req, res);
  } else if (parsed.pathname === '/api/config' && req.method === 'POST') {
    handleConfigPost(req, res);
  } else if (parsed.pathname === '/api/stats') {
    const cacheEntries = [];
    for (const [key, entry] of cache) {
      cacheEntries.push({ key, age: Math.round((Date.now() - entry.time) / 1000), bytes: entry.body.length });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      uptime: Math.round((Date.now() - serverStartTime) / 1000),
      cacheTTL: CACHE_TTL / 1000,
      cache: cacheEntries,
      metar: { total: stats.metar.total, cached: stats.metar.cached, errors: stats.metar.errors, log: stats.metar.log },
      taf: { total: stats.taf.total, cached: stats.taf.cached, errors: stats.taf.errors, log: stats.taf.log },
    }));
  } else {
    serveStatic(req, res, parsed.pathname);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Austria Airport VFR Status Map`);
  console.log(`  ==============================`);
  console.log(`  Server running at: http://localhost:${PORT}`);
  console.log(`  METAR proxy at:    http://localhost:${PORT}/api/metar?ids=LOWW`);
  console.log(`  TAF proxy at:      http://localhost:${PORT}/api/taf?ids=LOWW`);
  console.log(`  Cache TTL:         ${CACHE_TTL / 1000}s`);
  console.log(`  Verbose mode:      ${VERBOSE ? 'ON' : 'OFF (use --verbose or -v)'}`);
  console.log(`\n  Press Ctrl+C to stop.\n`);
});
