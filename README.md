# Austria Airport VFR Status Map

Interactive map showing real-time VFR flight conditions for all Austrian airports. Color-coded markers display current and forecast flight categories (VFR, MVFR, IFR, LIFR) based on live METAR and TAF data.

## Features

- **Live weather markers** — color-coded dots for every Austrian airport based on current flight category
- **Flight conditions forecast** — toggle between Now, +2h, +4h, +8h, and +24h to see how conditions will evolve across the map
- **Detailed airport popups** — click any airport for METAR details, TAF timeline, forecast outlook, runway info, frequencies, and more
- **Major airport labels** — LOWW, LOWS, LOWG, LOWI, LOWK, LOWL shown with permanent labels
- **Auto-refresh** — weather data updates every 5 minutes

## Data Sources

- **Airport data** — [OpenAIP](https://www.openaip.net) (requires free API key)
- **METAR / TAF** — [Aviation Weather Center (NOAA)](https://aviationweather.gov) (no key required)

## Setup

### Prerequisites

- [Node.js](https://nodejs.org) (any recent version)
- A free OpenAIP API key from [openaip.net](https://www.openaip.net)

### Running locally

```bash
node server.js
```

Open [http://localhost:5556](http://localhost:5556) in your browser. On first load, enter your OpenAIP API key when prompted (stored in localStorage for future visits).

Use `--verbose` (or `-v`) to log all requests to aviationweather.gov:

```bash
node server.js --verbose
```

### Running with Docker Compose

```bash
docker compose up
```

Open [http://localhost:5556](http://localhost:5556). To run in the background:

```bash
docker compose up -d
```

To rebuild after code changes:

```bash
docker compose up --build
```

## Architecture

```
index.html   — HTML structure + CSS
app.js       — All frontend logic (Leaflet map, weather parsing, popups, forecast)
server.js    — Static file server + CORS proxy for aviationweather.gov
```

The Node.js server is needed because aviationweather.gov does not support CORS. It proxies two endpoints:

- `/api/metar?ids=LOWW,LOWS,...` — proxies METAR data
- `/api/taf?ids=LOWW,LOWS,...` — proxies TAF data

No build tools, no frameworks — vanilla JavaScript with Leaflet.js loaded from CDN.

## Flight Category Criteria

Based on [AWC standards](https://aviationweather.gov/gfa/help/):

| Category | Ceiling         | Visibility   | Color  |
|----------|-----------------|--------------|--------|
| VFR      | > 3,000 ft AGL  | > 5 SM       | Green  |
| MVFR     | 1,000–3,000 ft  | 3–5 SM       | Blue   |
| IFR      | 500–999 ft      | 1–2.99 SM    | Red    |
| LIFR     | < 500 ft        | < 1 SM       | Purple |

The worse of ceiling and visibility determines the category. Forecast horizons use worst-case analysis (base TAF + any overlapping TEMPO/PROB groups).

### Cloud Cover and Ceiling

The ceiling is defined as the lowest cloud layer reported as **broken** or **overcast**. Not all cloud cover types count as a ceiling:

| Cover | Meaning             | Defines Ceiling? |
|-------|---------------------|------------------|
| SKC   | Sky Clear           | No — no clouds present, no ceiling |
| CLR   | Clear               | No — no clouds detected, no ceiling |
| FEW   | Few (1/8–2/8)       | No — too sparse to form a ceiling |
| SCT   | Scattered (3/8–4/8) | No — not enough coverage for a ceiling |
| BKN   | Broken (5/8–7/8)    | **Yes** — lowest BKN layer sets the ceiling |
| OVC   | Overcast (8/8)      | **Yes** — complete cloud cover |
| OVX   | Obscured            | **Yes** — sky obscured (e.g. fog, heavy precip) |

When multiple cloud layers are reported, the app scans from lowest to highest and uses the first BKN, OVC, or OVX layer as the ceiling height. If only SKC, CLR, FEW, or SCT layers are present, there is no ceiling and the ceiling component defaults to VFR.
