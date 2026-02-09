// Local server that serves static files and proxies METAR + TAF requests
// to aviationweather.gov (which doesn't allow CORS)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5556;
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

  stats.metar.total++;
  const cacheKey = `metar:${ids}`;
  const cached = getCached(cacheKey);
  if (cached) {
    stats.metar.cached++;
    logCall('metar', { time: Date.now(), cached: true, age: Math.round((Date.now() - cached.time) / 1000) });
    if (VERBOSE) console.log(`[METAR] CACHE HIT (age ${Math.round((Date.now() - cached.time) / 1000)}s)`);
    res.writeHead(cached.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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

  stats.taf.total++;
  const cacheKey = `taf:${ids}`;
  const cached = getCached(cacheKey);
  if (cached) {
    stats.taf.cached++;
    logCall('taf', { time: Date.now(), cached: true, age: Math.round((Date.now() - cached.time) / 1000) });
    if (VERBOSE) console.log(`[TAF]   CACHE HIT (age ${Math.round((Date.now() - cached.time) / 1000)}s)`);
    res.writeHead(cached.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const query = Object.fromEntries(parsed.searchParams);

  if (parsed.pathname === '/api/metar') {
    proxyMetar(req, res, query);
  } else if (parsed.pathname === '/api/taf') {
    proxyTaf(req, res, query);
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
    serveStatic(req, res);
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
