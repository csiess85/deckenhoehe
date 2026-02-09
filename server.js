// Local server that serves static files and proxies METAR + TAF requests
// to aviationweather.gov (which doesn't allow CORS)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5556;
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

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

  const awcUrl = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ids)}&format=json`;
  const startTime = Date.now();

  if (VERBOSE) console.log(`[METAR] --> GET ${awcUrl}`);

  https.get(awcUrl, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      if (VERBOSE) console.log(`[METAR] <-- ${proxyRes.statusCode} (${body.length} bytes, ${Date.now() - startTime}ms)`);
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    });
  }).on('error', (err) => {
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

  const awcUrl = `https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(ids)}&format=json`;
  const startTime = Date.now();

  if (VERBOSE) console.log(`[TAF]   --> GET ${awcUrl}`);

  https.get(awcUrl, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      if (VERBOSE) console.log(`[TAF]   <-- ${proxyRes.statusCode} (${body.length} bytes, ${Date.now() - startTime}ms)`);
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
    });
  }).on('error', (err) => {
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
  console.log(`  Verbose mode:      ${VERBOSE ? 'ON' : 'OFF (use --verbose or -v)'}`);
  console.log(`\n  Press Ctrl+C to stop.\n`);
});
