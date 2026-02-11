// Local server that serves static files and proxies METAR + TAF requests
// to aviationweather.gov (which doesn't allow CORS)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5556;
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const WEATHER_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const AIRPORT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_FILE = path.join(__dirname, '.cache.json');

// In-memory cache keyed by request URL
const cache = new Map();

// Load cache from disk on startup
function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      let loaded = 0;
      for (const [key, entry] of Object.entries(data)) {
        cache.set(key, entry);
        loaded++;
      }
      console.log(`Loaded ${loaded} cache entries from disk`);
    }
  } catch (err) {
    console.warn('Failed to load cache from disk:', err.message);
  }
}

// Save cache to disk
function saveCacheToDisk() {
  try {
    const data = Object.fromEntries(cache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
    if (VERBOSE) console.log(`Saved ${cache.size} cache entries to disk`);
  } catch (err) {
    console.warn('Failed to save cache to disk:', err.message);
  }
}

// Auto-save cache every 5 minutes
setInterval(saveCacheToDisk, 5 * 60 * 1000);

function getCached(key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > ttl) {
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
  airports: { total: 0, cached: 0, errors: 0, log: [] },
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

function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
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

  const cached = getCached(cacheKey, WEATHER_CACHE_TTL);
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

  const cached = getCached(cacheKey, WEATHER_CACHE_TTL);
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
  const apiKey = req.headers['x-openaip-api-key'];
  if (!apiKey) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing x-openaip-api-key header' }));
    return;
  }

  const country = query.country || 'AT';
  const page = query.page || '1';
  const limit = query.limit || '100';
  const force = query.force === '1';

  stats.airports.total++;
  const cacheKey = `airports:${country}:${page}:${limit}`;

  if (force) {
    cache.delete(cacheKey);
    if (VERBOSE) console.log(`[AIRPORTS] CACHE INVALIDATED (force refresh)`);
  }

  const cached = getCached(cacheKey, AIRPORT_CACHE_TTL);
  if (cached) {
    stats.airports.cached++;
    logCall('airports', { time: Date.now(), cached: true, age: Math.round((Date.now() - cached.time) / 1000) });
    if (VERBOSE) console.log(`[AIRPORTS] CACHE HIT (age ${Math.round((Date.now() - cached.time) / 1000)}s)`);
    res.writeHead(cached.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Cache, X-Fetch-Time', 'X-Cache': 'HIT', 'X-Fetch-Time': new Date(cached.time).toISOString() });
    res.end(cached.body);
    return;
  }

  const openaipUrl = `https://api.core.openaip.net/api/airports?country=${encodeURIComponent(country)}&page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`;
  const startTime = Date.now();

  if (VERBOSE) console.log(`[AIRPORTS] --> GET ${openaipUrl}`);

  const options = new URL(openaipUrl);
  options.headers = { 'x-openaip-api-key': apiKey };

  https.get(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      const duration = Date.now() - startTime;
      if (VERBOSE) console.log(`[AIRPORTS] <-- ${proxyRes.statusCode} (${body.length} bytes, ${duration}ms)`);
      if (proxyRes.statusCode === 200) setCache(cacheKey, proxyRes.statusCode, body);
      logCall('airports', { time: Date.now(), cached: false, status: proxyRes.statusCode, bytes: body.length, duration });
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
    stats.airports.errors++;
    logCall('airports', { time: Date.now(), cached: false, error: err.message, duration: Date.now() - startTime });
    if (VERBOSE) console.log(`[AIRPORTS] <-- ERROR ${err.message} (${Date.now() - startTime}ms)`);
    console.error('Airports proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch airport data' }));
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
  } else if (parsed.pathname === '/api/stats') {
    const cacheEntries = [];
    for (const [key, entry] of cache) {
      cacheEntries.push({ key, age: Math.round((Date.now() - entry.time) / 1000), bytes: entry.body.length });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      uptime: Math.round((Date.now() - serverStartTime) / 1000),
      weatherCacheTTL: WEATHER_CACHE_TTL / 1000,
      airportCacheTTL: AIRPORT_CACHE_TTL / 1000,
      cache: cacheEntries,
      metar: { total: stats.metar.total, cached: stats.metar.cached, errors: stats.metar.errors, log: stats.metar.log },
      taf: { total: stats.taf.total, cached: stats.taf.cached, errors: stats.taf.errors, log: stats.taf.log },
      airports: { total: stats.airports.total, cached: stats.airports.cached, errors: stats.airports.errors, log: stats.airports.log },
    }));
  } else {
    serveStatic(req, res);
  }
});

// Load cache from disk before starting server
loadCacheFromDisk();

server.listen(PORT, () => {
  console.log(`\n  Austria Airport VFR Status Map`);
  console.log(`  ==============================`);
  console.log(`  Server running at:  http://localhost:${PORT}`);
  console.log(`  METAR proxy at:     http://localhost:${PORT}/api/metar?ids=LOWW`);
  console.log(`  TAF proxy at:       http://localhost:${PORT}/api/taf?ids=LOWW`);
  console.log(`  Airports proxy at:  http://localhost:${PORT}/api/airports?country=AT&page=1&limit=100`);
  console.log(`  Weather cache TTL:  ${WEATHER_CACHE_TTL / 1000}s (1 hour)`);
  console.log(`  Airport cache TTL:  ${AIRPORT_CACHE_TTL / 1000}s (7 days)`);
  console.log(`  Verbose mode:       ${VERBOSE ? 'ON' : 'OFF (use --verbose or -v)'}`);
  console.log(`\n  Press Ctrl+C to stop.\n`);
});

// Save cache on graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down gracefully...');
  saveCacheToDisk();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\nShutting down gracefully...');
  saveCacheToDisk();
  process.exit(0);
});
