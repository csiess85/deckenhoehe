# Deckenhöhe — Austria Airport VFR Status Map

## Project Overview
Austrian airport VFR weather map app showing real-time flight conditions (VFR/MVFR/IFR/LIFR) with forecast horizons (+2h, +4h, +8h, +24h).

## Tech Stack
- **Frontend**: Vanilla JavaScript + Leaflet.js (no frameworks)
- **Backend**: Node.js HTTP server (no dependencies) - static files + CORS proxy
- **APIs**: OpenAIP v2 (airports), aviationweather.gov (METAR/TAF)
- **Deployment**: Docker (node:22-alpine), docker-compose

## Key Files
- `app.js` - All frontend logic (~1160 lines), includes injected CSS
- `server.js` - Node.js server with proxy, caching, stats (~224 lines)
- `index.html` - Main page with Leaflet map
- `help.html` - User documentation
- `stats.html` - Internal API stats dashboard

## Architecture
- Server proxies METAR/TAF requests to aviationweather.gov (CORS bypass)
- Server proxies OpenAIP airport requests (API key stored server-side in `data/config.json`)
- `OPENAIP_API_KEY` env var takes precedence over config file (for Docker)
- Server-side in-memory cache (1h TTL for weather, 7d for airports) with stable keys (`metar:all`, `taf:all`)
- Client-side localStorage cache (24h TTL) for airport data
- `force=1` query param on proxy endpoints bypasses server cache
- `X-Cache` and `X-Fetch-Time` response headers track cache status
- Weather auto-refreshes every 30 minutes; manual refresh via button
- OpenAIP API key entered once via UI, validated against OpenAIP, stored on server disk

## Running
- `node server.js` (or `node server.js --verbose`)
- Port: `process.env.PORT || 5556`
- Docker: `docker compose up`

## GitHub
- Repo: https://github.com/csiess85/deckenhoehe (private)
- Account: csiess85
