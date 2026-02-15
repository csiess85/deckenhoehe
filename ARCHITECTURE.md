# Architecture & Database Layout

## System Overview

```
+------------------+       +-------------------+       +------------------------+
|                  |       |                   |       |    External APIs        |
|  Browser Client  | <---> |  Node.js Server   | <---> |                        |
|  (Vanilla JS)    |       |  (server.js)      |       |  - aviationweather.gov |
|                  |       |  Port 5556        |       |  - api.core.openaip.net|
+------------------+       +-------------------+       +------------------------+
                                    |
                                    v
                    +-------------------------------+
                    |  Persistence Layer             |
                    |  ./data/                       |
                    |  - weather_history.db (SQLite) |
                    |  - config.json (API key)       |
                    |  - .cache.json (proxy cache)   |
                    +-------------------------------+
```

The application is a self-contained Node.js server with zero npm dependencies. It serves static HTML/JS/CSS files, proxies external API requests (solving CORS and API key security), caches responses in memory, and persists weather observations/forecasts into SQLite for long-term historical analysis.

---

## File Inventory

| File | Size | Purpose |
|------|------|---------|
| `server.js` | 981 lines | HTTP server, proxy, cache, SQLite history, scheduled fetching, all API endpoints |
| `app.js` | 1,579 lines | All frontend logic: map, markers, popups, TAF timeline, flight category computation, horizon selector, UX behaviors. Injects its own CSS. |
| `index.html` | 523 lines | Main page shell: header, map container, API key dialog, loading overlay, stats bar, floating horizon pill |
| `history.html` | 784 lines | Self-contained history comparison page (HTML + CSS + JS inline) |
| `help.html` | 272 lines | User-facing documentation |
| `stats.html` | 307 lines | Internal API proxy stats dashboard |
| `log.html` | ~330 lines | Server log viewer with level/category filters, auto-refresh |
| `favicon.svg` | SVG icon | |
| `Dockerfile` | 10 lines | `node:22-alpine` image, copies files, exposes 5556 |
| `docker-compose.yml` | 10 lines | Single service, mounts `./data` volume |
| `package.json` | 9 lines | Name, version, `npm start` script. **No dependencies.** |

### `./data/` directory (gitignored, Docker volume)

| File | Description |
|------|-------------|
| `config.json` | Stores the OpenAIP API key on disk: `{"openaipApiKey": "..."}` |
| `weather_history.db` | SQLite database for METAR/TAF history (~73 KB initial, grows ~170 MB/year) |
| `server.log` | Append-only TSV log file (rotated at 5 MB). Format: `timestamp\tlevel\tcategory\tmessage\tdetail` |

### `.cache.json` (gitignored)

Serialized in-memory proxy cache. Written to disk every 5 minutes and on graceful shutdown. Loaded on startup so the server survives restarts without cold-fetching everything.

---

## Server Architecture (`server.js`)

### Module Structure (top to bottom)

```
1.  Constants & Configuration          (lines 1-22)
2.  Config read/write (API key)        (lines 24-36)
3.  In-memory proxy cache              (lines 38-70)
4.  SQLite Database Init               (lines 72-135)
5.  Flight Category Functions          (lines 137-214)
6.  HTTPS JSON Helper                  (lines 216-239)
7.  Weather History Storage            (lines 241-304)
8.  Airport List Management            (lines 306-355)
9.  Scheduled History Fetch            (lines 357-420)
10. Data Purge (3-year retention)      (lines 422-437)
11. Proxy Cache Helpers                (lines 439-451)
12. API Call Statistics                 (lines 453-465)
13. Static File Server                 (lines 467-497)
14. Proxy: METAR                       (lines 499-565)
15. Proxy: TAF                         (lines 567-631)
16. Proxy: Airports (OpenAIP)          (lines 633-699)
17. Config API (GET/POST)              (lines 701-753)
18. History API Endpoints              (lines 755-888)
19. HTTP Server & Router               (lines 890-932)
20. Startup Sequence                   (lines 934-969)
21. Graceful Shutdown                  (lines 971-981)
```

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `PORT` | `5556` | HTTP server port (env `PORT` overrides) |
| `WEATHER_CACHE_TTL` | 1 hour | In-memory cache lifetime for METAR/TAF proxy responses |
| `AIRPORT_CACHE_TTL` | 7 days | In-memory cache lifetime for OpenAIP airport responses |
| `HISTORY_FETCH_INTERVAL` | 2 hours | How often the server autonomously fetches weather for all airports |
| `HISTORY_RETENTION_DAYS` | 1,095 days (~3 years) | Records older than this are purged daily |
| `AIRPORT_LIST_REFRESH_INTERVAL` | 7 days | How often the server re-fetches the airport list from OpenAIP |

### API Key Resolution

```
getApiKey():
  1. process.env.OPENAIP_API_KEY   (highest priority, for Docker)
  2. data/config.json → openaipApiKey
  3. null (prompts user via UI)
```

### In-Memory Proxy Cache

```
Map<string, { statusCode: number, body: string, time: number }>
```

- Keys: `metar:{ids}`, `taf:{ids}`, `airports:{country}:{page}:{limit}`
- TTL checked on read via `getCached(key, ttl)`
- Saved to `.cache.json` every 5 minutes + on shutdown
- Loaded from disk on startup
- `force=1` query param deletes the cache entry before lookup

### HTTP Router

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/metar?ids=...&force=0|1` | `proxyMetar` | Proxy to aviationweather.gov METAR endpoint |
| GET | `/api/taf?ids=...&force=0|1` | `proxyTaf` | Proxy to aviationweather.gov TAF endpoint |
| GET | `/api/airports?country=AT&page=1&limit=100&force=0|1` | `proxyAirports` | Proxy to OpenAIP (injects API key server-side) |
| GET | `/api/config` | `handleConfigGet` | Returns `{hasKey: bool}` |
| POST | `/api/config` | `handleConfigPost` | Validates and saves OpenAIP API key |
| GET | `/api/stats` | inline | Proxy cache stats, request log (for stats.html) |
| GET | `/api/history/timeline?icao=all&from=...&to=...` | `handleHistoryTimeline` | METAR + TAF flight categories over time |
| GET | `/api/history/detail?icao=LOWW&time=...` | `handleHistoryDetail` | Full METAR + TAF at a specific point in time |
| GET | `/api/history/airports` | `handleHistoryAirports` | All tracked airports with snapshot counts |
| GET | `/api/history/stats` | `handleHistoryStats` | DB stats: counts, size, range, next fetch timer |
| GET | `/api/log?n=200&level=...&category=...` | `handleLogApi` | Server log entries (TSV file, newest last) |
| GET | `/*` | `serveStatic` | Static file serving (blocks `/data/*`) |

### Custom Response Headers

| Header | Values | Description |
|--------|--------|-------------|
| `X-Cache` | `HIT` / `MISS` | Whether the response came from the in-memory cache |
| `X-Fetch-Time` | ISO 8601 timestamp | When the upstream data was actually fetched from the external API |

### Proxy Flow

```
Client request → Check force=1? → Delete cache entry
                → Check cache    → HIT: return cached response with X-Cache: HIT
                → MISS:          → Fetch from upstream API
                                 → Cache the response
                                 → Store in SQLite history (METAR/TAF only)
                                 → Return with X-Cache: MISS
```

For METAR proxy with `force=1`, the 2-hour history fetch timer is also reset via `scheduleHistoryFetch()`.

### Scheduled Background Tasks

| Task | Interval | Mechanism | Description |
|------|----------|-----------|-------------|
| Weather history fetch | 2 hours | `setTimeout` (recursive) | Fetches METAR+TAF for all tracked airports, stores in SQLite |
| Airport list refresh | 7 days | `setInterval` | Re-fetches airport list from OpenAIP, updates `tracked_airports` table |
| Data purge | 24 hours | `setInterval` | Deletes history records older than 3 years |
| Cache save to disk | 5 minutes | `setInterval` | Writes in-memory cache to `.cache.json` |

The 2-hour history fetch uses `setTimeout` (not `setInterval`) so it can be reset when a manual refresh occurs. The chain is: `setTimeout` fires -> `performHistoryFetch()` -> `scheduleHistoryFetch()` (arms next timeout).

### Startup Sequence

```
1. Load proxy cache from disk (.cache.json)
2. Initialize SQLite database (CREATE TABLE IF NOT EXISTS)
3. Prepare INSERT statements
4. Start HTTP server on PORT
5. Bootstrap tracked_airports (fetch from OpenAIP if table is empty)
6. Perform initial weather history fetch
7. Schedule recurring 2-hour fetch
8. Run initial data purge
```

### Graceful Shutdown (SIGINT / SIGTERM)

```
1. Save proxy cache to disk
2. Close SQLite database
3. process.exit(0)
```

---

## Database Layout (SQLite)

File: `data/weather_history.db`
Engine: `node:sqlite` built-in module (`DatabaseSync`, synchronous API)
Estimated growth: ~170 MB/year (9 airports x 12 fetches/day x 365 days)

### Table: `metar_history`

Stores one row per airport per fetch cycle. Contains both extracted queryable fields and the complete raw JSON for drill-down.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | INTEGER | PK AUTO | Primary key |
| `fetch_time` | TEXT | NOT NULL | ISO 8601 UTC timestamp of when the server fetched the data |
| `icao_id` | TEXT | NOT NULL | ICAO airport code (e.g., `LOWW`) |
| `flt_cat` | TEXT | yes | Flight category from AWC: `VFR`, `MVFR`, `IFR`, `LIFR` |
| `temp` | REAL | yes | Temperature in Celsius |
| `dewp` | REAL | yes | Dewpoint in Celsius |
| `wdir` | INTEGER | yes | Wind direction in degrees |
| `wspd` | INTEGER | yes | Wind speed in knots |
| `wgst` | INTEGER | yes | Wind gust in knots |
| `visib` | TEXT | yes | Visibility in statute miles (stored as text to preserve `"6+"` format) |
| `altim` | REAL | yes | Altimeter setting (QNH) in hPa |
| `ceiling` | INTEGER | yes | Computed ceiling in feet AGL (lowest BKN/OVC/OVX layer) |
| `wx_string` | TEXT | yes | Weather phenomena string (e.g., `BCFG`, `-RA`) |
| `raw_ob` | TEXT | yes | Complete raw METAR string as reported |
| `report_time` | TEXT | yes | ISO 8601 UTC of the actual METAR observation time |
| `metar_json` | TEXT | yes | Full JSON blob from aviationweather.gov (for drill-down detail) |

**Indexes:**
- `idx_metar_icao_time` on `(icao_id, fetch_time)` - Primary query pattern: airport + time range
- `idx_metar_time` on `(fetch_time)` - For time-range-only queries and purge operations

### Table: `taf_history`

Stores one row per airport per fetch cycle. Pre-computes flight categories at five time horizons to avoid reprocessing TAF period logic on every read.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | INTEGER | PK AUTO | Primary key |
| `fetch_time` | TEXT | NOT NULL | ISO 8601 UTC timestamp of when the server fetched the data |
| `icao_id` | TEXT | NOT NULL | ICAO airport code |
| `valid_from` | TEXT | yes | TAF validity start (ISO 8601 UTC) |
| `valid_to` | TEXT | yes | TAF validity end (ISO 8601 UTC) |
| `flt_cat_now` | TEXT | yes | Computed flight category at fetch time |
| `flt_cat_2h` | TEXT | yes | Computed flight category at fetch time + 2 hours |
| `flt_cat_4h` | TEXT | yes | Computed flight category at fetch time + 4 hours |
| `flt_cat_8h` | TEXT | yes | Computed flight category at fetch time + 8 hours |
| `flt_cat_24h` | TEXT | yes | Computed flight category at fetch time + 24 hours |
| `raw_taf` | TEXT | yes | Complete raw TAF string |
| `taf_json` | TEXT | yes | Full JSON blob from aviationweather.gov |

**Indexes:**
- `idx_taf_icao_time` on `(icao_id, fetch_time)` - Primary query pattern
- `idx_taf_time` on `(fetch_time)` - For time-range-only queries and purge operations

**Why pre-computed horizon categories?** TAF parsing is complex (base periods, BECMG transitions, TEMPO/PROB overlays, worst-case logic). Computing this once at write time means the timeline API can return results with a single indexed SELECT rather than deserializing and reprocessing JSON blobs.

### Table: `tracked_airports`

Registry of airports the server fetches weather for. Populated from OpenAIP, refreshed weekly.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `icao_id` | TEXT | PK | ICAO airport code (e.g., `LOWW`) |
| `name` | TEXT | yes | Airport name |
| `lat` | REAL | yes | Latitude |
| `lon` | REAL | yes | Longitude |
| `updated_at` | TEXT | NOT NULL | Last time this record was updated |

Uses `INSERT OR REPLACE` for upsert behavior.

### Why Separate METAR and TAF Tables?

1. **Different data shapes** - METAR has 13 weather fields; TAF has validity periods and pre-computed horizon categories
2. **Different query patterns** - Timeline view needs two independent rows per airport (actuals vs. forecast)
3. **Different data availability** - Not all airports have TAF (only ~8-10 out of ~50 tracked); separate tables avoid sparse rows
4. **Independent lifecycle** - METAR observations and TAF forecasts have different update cadences and validity periods

### Data Ingestion Paths

Weather data enters the history tables through two paths:

```
Path 1: Scheduled fetch (every 2 hours)
  performHistoryFetch()
    → httpsGetJson() to aviationweather.gov/api/data/metar
    → httpsGetJson() to aviationweather.gov/api/data/taf
    → storeMetarSnapshots()  → INSERT into metar_history (transaction)
    → storeTafSnapshots()    → INSERT into taf_history   (transaction)
    → Update in-memory cache (so next client request gets fresh data)

Path 2: Client-triggered proxy fetch (cache miss)
  proxyMetar() / proxyTaf()
    → Upstream fetch from aviationweather.gov
    → Cache the response
    → Parse JSON, store in history tables
```

Both paths use the same `storeMetarSnapshots()` / `storeTafSnapshots()` functions. All inserts are wrapped in explicit `BEGIN`/`COMMIT` transactions with `ROLLBACK` on error.

### History API Endpoint Details

**`GET /api/history/timeline`**
```
Parameters: ?icao=all|LOWW,LOWI&from=2026-02-15T00:00:00Z&to=2026-02-15T23:59:59Z
Response:
{
  "metar": {
    "LOWW": [{"t": "2026-02-15T06:00:00.000Z", "cat": "VFR"}, ...],
    "LOWI": [{"t": "...", "cat": "MVFR"}, ...]
  },
  "taf": {
    "LOWW": [{"t": "...", "cat_now": "VFR", "cat_2h": "VFR", "cat_4h": "MVFR", "cat_8h": "IFR", "cat_24h": "VFR"}, ...],
    ...
  }
}
```
The history page uses `cat_now` from the TAF result for the TAF timeline row. The other horizon columns (`cat_2h` through `cat_24h`) are available for future detail views.

**`GET /api/history/detail`**
```
Parameters: ?icao=LOWW&time=2026-02-15T06:00:00.000Z
Response:
{
  "metar": { ...all metar_history columns..., "metar_json": {...parsed object...} },
  "taf":   { ...all taf_history columns..., "taf_json": {...parsed object...} }
}
```
Uses `julianday()` difference to find the closest snapshot to the requested time, so it works even if the exact timestamp doesn't match.

**`GET /api/history/airports`**
```
Response:
{
  "airports": [
    {"icao_id": "LOWW", "name": "Wien-Schwechat", "lat": 48.11, "lon": 16.57, "metar_count": 142, "taf_count": 130},
    ...
  ]
}
```

**`GET /api/history/stats`**
```
Response:
{
  "total_metar": 1420, "total_taf": 1130,
  "oldest": "2026-02-15T06:00:00.000Z",
  "newest": "2026-02-15T16:00:00.000Z",
  "airport_count": 50,
  "db_size_bytes": 73728,
  "next_fetch_in_seconds": 5832
}
```

---

## Flight Category Logic

Duplicated on both server (for history storage) and client (for real-time display). Both use identical algorithms.

### Computation

```
Input: ceiling (ft AGL), visibility (SM)

Ceiling categories:        Visibility categories:
  < 500 ft   → LIFR         < 1 SM    → LIFR
  500-999 ft → IFR           1-2.99 SM → IFR
  1000-3000  → MVFR          3-5 SM    → MVFR
  > 3000 ft  → VFR           > 5 SM    → VFR

Result: worse of the two (higher severity wins)
Severity: LIFR(3) > IFR(2) > MVFR(1) > VFR(0)
```

### Ceiling Determination

The ceiling is the base altitude of the **first** BKN (Broken), OVC (Overcast), or OVX (Obscured) cloud layer. FEW and SCT layers do not define a ceiling.

### TAF Forecast Category at a Target Time

```
1. Find the base forecast period covering targetTime
2. Apply all BECMG (becoming) groups whose start time <= targetTime
   → take the worse of base and BECMG categories
3. Overlay all TEMPO/PROB groups whose time range covers targetTime
   → take the worst of all applicable categories

Result: worst-case flight category at targetTime
```

This worst-case approach is conservative by design: if a TEMPO group predicts IFR conditions temporarily during a VFR base period, the displayed category will be IFR.

### Functions (server-side)

| Function | Description |
|----------|-------------|
| `getCeilingFromClouds(clouds)` | Returns ft AGL of lowest BKN/OVC/OVX layer, or null |
| `computeFlightCategory(ceilingFt, visibSM)` | Returns VFR/MVFR/IFR/LIFR from ceiling + visibility |
| `getTafPeriodCategory(period)` | Returns flight category for a single TAF period |
| `worseCat(a, b)` | Returns the more severe of two categories |
| `getForecastCategoryFromTaf(taf, targetTime)` | Full TAF evaluation at a UNIX timestamp |

### Functions (client-side, `app.js`)

Same logic, slightly different naming:

| Function | Description |
|----------|-------------|
| `getCeilingFromClouds(clouds)` | Same as server |
| `computeFlightCategory(ceilingFt, visibSM)` | Same as server |
| `getTafPeriodCategory(period)` | Same as server |
| `worseCat(a, b)` | Same as server |
| `getForecastCategory(icao, targetTime)` | Looks up tafData[icao], then evaluates (uses client-side data store) |
| `getDisplayCategory(icao)` | Dispatches based on selected horizon: current=METAR, others=TAF |

---

## Frontend Architecture (`app.js`)

### Data Flow

```
init()
  → Check /api/config for API key
  → If no key: show API key dialog
  → If key exists: loadAirports()
      → fetchAirports() (from OpenAIP via proxy, with localStorage 24h cache)
      → fetchMetar() + fetchTaf() (from AWC via proxy, batches of 40)
      → displayAirports() (create Leaflet markers)
      → Start 30-minute auto-refresh timer
      → Start 10-second age display update timer
```

### State Management (module-level variables)

| Variable | Type | Description |
|----------|------|-------------|
| `map` | L.Map | Leaflet map instance |
| `airportMarkers` | L.Marker[] | Currently displayed markers (cleared on each displayAirports) |
| `airportsData` | Object[] | Raw airport data from OpenAIP |
| `metarData` | Object (keyed by ICAO) | Current METAR data for each airport |
| `tafData` | Object (keyed by ICAO) | Current TAF data for each airport |
| `selectedHorizon` | string | `'current'`, `'2h'`, `'4h'`, `'8h'`, or `'24h'` |
| `lastApiFetch` | Date | When AWC data was last fetched (from X-Fetch-Time header) |
| `refreshTimer` | interval ID | 30-minute weather auto-refresh |

### Marker System

Each airport gets a `L.divIcon` marker with:
- **Color-coded dot** (VFR green, MVFR blue, IFR red, LIFR purple, no data gray)
- **Size** based on major airport status (20px major, 12px minor)
- **Trend arrow** (green up / red down) showing next-horizon trend
- **Gust label** (orange badge showing `G{value}`) when gusts >= 20kt
- **Permanent tooltip** for major airports showing ICAO code and category

### Popup Content

Built dynamically via `buildPopupContent(airport)`:
1. Airport name + ICAO/IATA codes
2. Flight category badge + traffic type badge + gust warning badge
3. Forecast outlook row (4 colored dots for +2h/+4h/+8h/+24h)
4. METAR section (visibility, ceiling, clouds, wind, temp/dew, QNH, weather, raw)
5. TAF timeline (visual bar + overlay + time axis + now marker + period details + raw TAF)
6. Airport details (type, elevation, position, runway, PPR, frequencies)

### Horizon Selector

Two identical sets of buttons (header + floating mobile pill) stay synchronized:
- Click handler on `document` catches all `.horizon-btn` clicks
- Updates `selectedHorizon`, toggles `.active` on all buttons via `querySelectorAll`
- Calls `displayAirports()` to re-render all markers with new colors
- Mobile: swipe left/right on floating pill cycles through horizons

### Mobile UX Features

| Feature | Behavior |
|---------|----------|
| Auto-hide header | Header slides up when map is panned downward, reappears on upward pan or tap |
| Floating horizon pill | Bottom-centered pill replaces header horizon selector on mobile |
| Swipe gestures | Horizontal swipe on floating pill changes horizon (40px threshold) |
| Touch targets | All buttons minimum 36px (40px on mobile) |
| Popup scroll fade | Gradient fade indicator at bottom of popup when content overflows |

### Client-Side Caching

| Cache | Storage | TTL | Key |
|-------|---------|-----|-----|
| Airport data | localStorage | 24 hours | `openaip_airports_cache` |

Weather data is not cached client-side; the server-side proxy cache handles this.

---

## Page Descriptions

### `index.html` — Main Map Page

The map page with Leaflet.js. Structure:
- **Header**: Title, horizon selector buttons, legend, navigation links (History, Help, Stats)
- **Map**: Full-viewport Leaflet map (`#map`)
- **Floating horizon pill**: Mobile-only bottom bar with horizon buttons
- **API key overlay**: Modal dialog for initial OpenAIP key entry
- **Loading overlay**: Spinner shown during initial data fetch
- **Error banner**: Temporary error message bar
- **Stats bar**: Bottom bar showing airport counts by flight category
- **Attribution**: Data source credits

### `history.html` — Weather History Comparison

Self-contained page (all CSS + JS inline). Structure:
- **Stats cards**: METAR/TAF snapshot counts, history range, DB size, next fetch countdown
- **Controls**: Airport selector dropdown, time range presets (24h/48h/7d/30d), custom datetime pickers, color legend
- **Detail panel**: Click-to-expand panel showing full METAR (left) + TAF (right) for a selected point
- **Timeline section**: Dual-row colored bar per airport:
  - Top row: **METAR** (actual observed flight category)
  - Bottom row: **TAF** (what the forecast predicted, using `flt_cat_now`)
  - Shared time axis with UTC labels and NOW marker
  - Click any segment to drill down via `/api/history/detail`

### `stats.html` — API Proxy Stats Dashboard

Auto-refreshes every 5 seconds. Shows:
- Server uptime, total requests, API calls to AWC, cache hit rate, errors
- Active cache entries with age and size
- METAR and TAF request logs (last 100 each) with cache hit/miss/error tags

### `help.html` — User Documentation

Static documentation covering: map markers, trend arrows, airport popups, forecast horizons, flight category criteria, TAF timeline, data sources.

---

## Deployment

### Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY server.js app.js index.html help.html stats.html history.html favicon.svg package.json ./
ENV PORT=5556
EXPOSE 5556
CMD ["node", "server.js"]
```

```yaml
# docker-compose.yml
services:
  app:
    build: .
    ports:
      - "5556:5556"
    environment:
      - PORT=5556
    volumes:
      - ./data:/app/data    # Persists config.json + weather_history.db
    restart: unless-stopped
```

The `./data` volume mount is critical: it persists the SQLite database and API key configuration across container restarts.

### Local Development

```bash
node server.js           # Start on port 5556
node server.js --verbose # Start with detailed logging
```

No `npm install` needed. The only runtime requirement is Node.js >= 22.5.0 (for `node:sqlite`).

---

## External API Integration

### aviationweather.gov (AWC/NOAA)

| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /api/data/metar?ids={icaos}&format=json` | Current observations | Array of METAR objects |
| `GET /api/data/taf?ids={icaos}&format=json` | Forecasts | Array of TAF objects |

- No API key required
- Requests are batched in groups of 40 ICAO codes
- Proxied through server to solve CORS restrictions

### OpenAIP v2

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `GET /api/airports?country=AT&page=N&limit=100` | Austrian airport data | `x-openaip-api-key` header |

- Requires free API key from openaip.net
- Key is injected server-side (never exposed to browser)
- Paginated; server fetches all pages
- Airports with `type === 4` (military heliport) and `type === 7` (civil heliport) are filtered out

---

## Color System

| Category | Hex | Usage |
|----------|-----|-------|
| VFR | `#2ecc71` | Map markers, legend dots, timeline bars, badges |
| MVFR | `#3498db` | Same |
| IFR | `#e74c3c` | Same |
| LIFR | `#9b59b6` | Same |
| No Data | `#95a5a6` | Airports without weather data |
| Gust Warning | `#e67e22` | Gust badge, gust label on marker |
| Primary Dark | `#1a1a2e` | Headers, active buttons, text |
| Accent Red | `#e63946` | Title accent color |
