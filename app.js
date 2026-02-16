// Austria Airport VFR Status Map
// Uses OpenAIP API v2 for airport data + aviationweather.gov METAR/TAF for live weather

const METAR_PROXY = '/api/metar';
const TAF_PROXY = '/api/taf';
const AIRPORTS_PROXY = '/api/airports';
const AUSTRIA_CENTER = [47.85, 16.26]; // LOAV Bad Vöslau
const AUSTRIA_ZOOM = 10;
const METAR_REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
const AIRPORT_CACHE_KEY = 'openaip_airports_cache';
const AIRPORT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Airport type labels
const AIRPORT_TYPES = {
  0: 'Airport (Civil/Military)', 1: 'Glider Site', 2: 'Airfield Civil',
  3: 'International Airport', 4: 'Heliport Military', 5: 'Military Aerodrome',
  6: 'Ultra Light Site', 7: 'Heliport Civil', 8: 'Closed',
  9: 'Airfield IFR', 10: 'Airfield Water', 11: 'Landing Strip',
  12: 'Agricultural Strip', 13: 'Altiport',
};

// Frequency type labels
const FREQ_TYPES = {
  0: 'Approach', 1: 'APRON', 2: 'Arrival', 3: 'Center', 4: 'CTAF',
  5: 'Delivery', 6: 'Departure', 7: 'FIS', 8: 'Gliding', 9: 'Ground',
  10: 'Info', 11: 'Multicom', 12: 'Radar', 13: 'Tower', 14: 'ATIS',
  15: 'Radio', 16: 'Other', 17: 'AIRMET', 18: 'AWOS', 19: 'Lights', 20: 'VOLMET',
};

// Flight category colors & labels
const FLIGHT_CATEGORIES = {
  VFR:  { color: '#2ecc71', label: 'VFR',  desc: 'Visual Flight Rules' },
  IFR:  { color: '#e74c3c', label: 'IFR',  desc: 'Instrument Flight Rules' },
};

const NO_DATA_COLOR = '#95a5a6';
const GUST_WARNING_KT = 20; // Show warning when gusts >= this value

// Major Austrian airports (ICAO codes)
const MAJOR_AIRPORTS = new Set([
  'LOWW', 'LOWS', 'LOWG', 'LOWI', 'LOWK', 'LOWL', 'LOAV',
]);

let map;
let airportMarkers = [];
let airportsData = [];
let metarData = {};  // keyed by ICAO code
let tafData = {};    // keyed by ICAO code
let refreshTimer = null;
let ageTimer = null;
let lastWeatherFetch = null;
let lastApiFetch = null; // last time data was actually fetched from AWC API (not from cache)
let selectedHorizon = 'current'; // 'current', '2h', '4h', '8h', '24h'

// ─── Map Init ──────────────────────────────────────────────

function initMap() {
  map = L.map('map', { zoomControl: true }).setView(AUSTRIA_CENTER, AUSTRIA_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);
  map.panBy([0, -30]);
}

// ─── Flight Category Logic ─────────────────────────────────

// Compute flight category from ceiling (ft AGL) and visibility (SM)
// Using AWC criteria: https://aviationweather.gov/gfa/help/
function computeFlightCategory(ceilingFt, visibSM) {
  // ICAO/Austrian VFR: ceiling > 1500 ft AND visibility > 5 km (~3.107 SM)
  const VFR_CEIL = 1500;
  const VFR_VIS_SM = 5 / 1.60934; // 5 km in statute miles

  // Parse visibility — AWC uses "6+" to mean > 6 SM
  let vis = null;
  if (visibSM != null && visibSM !== '') {
    if (typeof visibSM === 'string') {
      if (visibSM.includes('+')) vis = parseFloat(visibSM) + 0.1; // "6+" → treat as > 6
      else vis = parseFloat(visibSM);
    } else {
      vis = visibSM;
    }
  }

  if (ceilingFt != null && ceilingFt <= VFR_CEIL) return 'IFR';
  if (vis != null && vis <= VFR_VIS_SM) return 'IFR';
  return 'VFR';
}

function getCeilingFromClouds(clouds) {
  if (!clouds || !Array.isArray(clouds)) return null;
  for (const c of clouds) {
    if (c.cover === 'BKN' || c.cover === 'OVC' || c.cover === 'OVX') {
      return c.base;
    }
  }
  return null;
}

function getFlightCategory(metar) {
  if (!metar) return null;
  const ceiling = getCeilingFromClouds(metar.clouds);
  return computeFlightCategory(ceiling, metar.visib);
}

function getMarkerColor(icao) {
  const cat = getDisplayCategory(icao);
  if (cat && FLIGHT_CATEGORIES[cat]) return FLIGHT_CATEGORIES[cat].color;
  return NO_DATA_COLOR;
}

function getCategoryClass(icao) {
  const cat = getDisplayCategory(icao);
  return cat ? cat.toLowerCase() : 'nodata';
}

function getCategoryLabel(icao) {
  const cat = getDisplayCategory(icao);
  return (cat && FLIGHT_CATEGORIES[cat]) ? FLIGHT_CATEGORIES[cat].label : 'No WX Data';
}

// ─── TAF Flight Category for a Forecast Period ─────────────

function getTafPeriodCategory(period) {
  const ceiling = getCeilingFromClouds(period.clouds);
  const vis = period.visib;
  // Only compute if we have at least one data point
  if (ceiling == null && (vis == null || vis === '')) return null;
  return computeFlightCategory(ceiling, vis);
}

// ─── Forecast Category at Future Time ───────────────────────

const CATEGORY_SEVERITY = { VFR: 0, IFR: 1 };

function worseCat(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (CATEGORY_SEVERITY[a] || 0) >= (CATEGORY_SEVERITY[b] || 0) ? a : b;
}

function getForecastCategory(icao, targetTime) {
  const taf = tafData[icao];
  if (!taf || !taf.fcsts || taf.fcsts.length === 0) return null;
  if (targetTime < taf.validTimeFrom || targetTime >= taf.validTimeTo) return null;

  const basePeriods = taf.fcsts.filter(f => !f.fcstChange);
  const changeGroups = taf.fcsts.filter(f => f.fcstChange);

  // Find base forecast period covering targetTime
  let baseCat = null;
  for (const period of basePeriods) {
    if (period.timeFrom <= targetTime && targetTime < period.timeTo) {
      baseCat = getTafPeriodCategory(period);
      break;
    }
  }

  // Apply BECMG groups
  for (const cg of changeGroups) {
    if (cg.fcstChange !== 'BECMG') continue;
    const completionTime = cg.timeBec || cg.timeTo;
    if (cg.timeFrom <= targetTime) {
      const becmgCat = getTafPeriodCategory(cg);
      baseCat = worseCat(baseCat, becmgCat);
    }
  }

  // Overlay TEMPO/PROB groups — worst case
  let worstCat = baseCat;
  for (const cg of changeGroups) {
    if (cg.fcstChange === 'BECMG') continue;
    if (cg.timeFrom <= targetTime && targetTime < cg.timeTo) {
      worstCat = worseCat(worstCat, getTafPeriodCategory(cg));
    }
  }

  return worstCat;
}

function getDisplayCategory(icao) {
  if (selectedHorizon === 'current') {
    return getFlightCategory(metarData[icao]);
  }
  const hoursMap = { '2h': 2, '4h': 4, '8h': 8, '24h': 24 };
  const hours = hoursMap[selectedHorizon];
  if (!hours) return getFlightCategory(metarData[icao]);
  const targetTime = Math.floor(Date.now() / 1000) + hours * 3600;
  return getForecastCategory(icao, targetTime) || getFlightCategory(metarData[icao]);
}

function getTrendForAirport(icao) {
  const horizonChain = { 'current': '2h', '2h': '4h', '4h': '8h', '8h': '24h', '24h': null };
  const nextHorizon = horizonChain[selectedHorizon];
  if (!nextHorizon) return null;

  const currentCat = getDisplayCategory(icao);
  if (!currentCat) return null;

  const hoursMap = { '2h': 2, '4h': 4, '8h': 8, '24h': 24 };
  const nextTime = Math.floor(Date.now() / 1000) + hoursMap[nextHorizon] * 3600;
  const nextCat = getForecastCategory(icao, nextTime) || getFlightCategory(metarData[icao]);
  if (!nextCat) return null;

  const currentSev = CATEGORY_SEVERITY[currentCat];
  const nextSev = CATEGORY_SEVERITY[nextCat];
  if (nextSev > currentSev) return 'deteriorating';
  if (nextSev < currentSev) return 'improving';
  return null;
}

// ─── Wind Gust Warning ────────────────────────────────────

function hasCurrentGustWarning(icao) {
  const metar = metarData[icao];
  if (!metar) return false;
  return metar.wgst >= GUST_WARNING_KT;
}

function hasForecastGustWarning(icao) {
  const taf = tafData[icao];
  if (!taf || !taf.fcsts) return false;
  const now = Math.floor(Date.now() / 1000);
  for (const period of taf.fcsts) {
    if (period.timeTo <= now) continue;
    if (period.wgst >= GUST_WARNING_KT) return true;
  }
  return false;
}

function hasGustWarning(icao) {
  return hasCurrentGustWarning(icao) || hasForecastGustWarning(icao);
}

function getMaxGust(icao) {
  let max = 0;
  const metar = metarData[icao];
  if (metar && metar.wgst) max = metar.wgst;
  const taf = tafData[icao];
  if (taf && taf.fcsts) {
    const now = Math.floor(Date.now() / 1000);
    for (const period of taf.fcsts) {
      if (period.timeTo <= now) continue;
      if (period.wgst > max) max = period.wgst;
    }
  }
  return max;
}

function getForecastGustAt(icao, targetTime) {
  const taf = tafData[icao];
  if (!taf || !taf.fcsts) return 0;
  let maxGust = 0;
  for (const period of taf.fcsts) {
    if (period.timeFrom <= targetTime && targetTime < period.timeTo) {
      if (period.wgst > maxGust) maxGust = period.wgst;
    }
  }
  return maxGust;
}

// ─── Marker Icons ──────────────────────────────────────────

function createAirportIcon(icao, isMajor, trend, gustWarn, gustValue) {
  const color = getMarkerColor(icao);
  const size = isMajor ? 20 : 12;
  const border = isMajor ? 3 : 2;
  const shadow = isMajor ? '0 0 10px rgba(0,0,0,0.3)' : '0 1px 3px rgba(0,0,0,0.3)';

  let arrowHtml = '';
  if (trend === 'improving') {
    const arrowSize = isMajor ? 14 : 10;
    arrowHtml = `<div class="trend-arrow trend-improving" style="font-size:${arrowSize}px;">&#9650;</div>`;
  } else if (trend === 'deteriorating') {
    const arrowSize = isMajor ? 14 : 10;
    arrowHtml = `<div class="trend-arrow trend-deteriorating" style="font-size:${arrowSize}px;">&#9660;</div>`;
  }

  let gustHtml = '';
  if (gustWarn && gustValue) {
    gustHtml = `<div class="gust-label${isMajor ? ' gust-label-major' : ''}" title="Gusts ≥ ${GUST_WARNING_KT}kt">G${gustValue}</div>`;
  }

  const dotWidth = size + border * 2;
  const arrowExtra = trend ? (isMajor ? 18 : 13) : 0;

  return L.divIcon({
    className: 'airport-marker',
    html: `<div class="marker-wrapper"><div style="
      width: ${size}px; height: ${size}px; background: ${color};
      border: ${border}px solid white; border-radius: 50%;
      box-shadow: ${shadow};
      ${isMajor ? 'outline: 2px solid ' + color + '40;' : ''}
    "></div>${arrowHtml}${gustHtml}</div>`,
    iconSize: [dotWidth + arrowExtra + 20, dotWidth + 10],
    iconAnchor: [dotWidth / 2, dotWidth / 2],
  });
}

// ─── Time Formatting Helpers ───────────────────────────────

function fmtUtc(ts) {
  const d = new Date(ts * 1000);
  return d.toUTCString().replace(/ GMT$/, '').slice(0, -3) + 'Z';
}

function fmtUtcShort(ts) {
  const d = new Date(ts * 1000);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hr = String(d.getUTCHours()).padStart(2, '0');
  const mn = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day}/${hr}${mn}Z`;
}

function fmtUtcHour(ts) {
  const d = new Date(ts * 1000);
  return String(d.getUTCHours()).padStart(2, '0') + 'Z';
}

// ─── TAF Timeline Builder ──────────────────────────────────

function buildTafTimeline(taf) {
  if (!taf || !taf.fcsts || taf.fcsts.length === 0) return '';

  const validFrom = taf.validTimeFrom;
  const validTo = taf.validTimeTo;
  const totalDuration = validTo - validFrom;
  if (totalDuration <= 0) return '';

  let html = `<div class="taf-section">`;
  html += `<div class="section-title">Forecast (TAF) &mdash; Valid ${fmtUtcShort(validFrom)} to ${fmtUtcShort(validTo)}</div>`;

  // Build the visual timeline bar
  html += `<div class="taf-timeline">`;

  // Separate base forecasts and change groups
  const basePeriods = taf.fcsts.filter(f => !f.fcstChange);
  const changeGroups = taf.fcsts.filter(f => f.fcstChange);

  // Render base forecast periods as the main bar
  html += `<div class="taf-bar">`;
  for (const period of basePeriods) {
    const from = period.timeFrom;
    const to = period.timeTo;
    const cat = getTafPeriodCategory(period);
    const color = cat && FLIGHT_CATEGORIES[cat] ? FLIGHT_CATEGORIES[cat].color : NO_DATA_COLOR;
    const left = ((from - validFrom) / totalDuration) * 100;
    const width = ((to - from) / totalDuration) * 100;

    html += `<div class="taf-bar-segment" style="left:${left}%;width:${width}%;background:${color};" title="${cat || '?'} ${fmtUtcShort(from)}-${fmtUtcShort(to)}"></div>`;
  }
  html += `</div>`; // taf-bar

  // Overlay TEMPO/BECMG/PROB as hatched segments
  if (changeGroups.length > 0) {
    html += `<div class="taf-bar taf-bar-overlay">`;
    for (const period of changeGroups) {
      const from = period.timeFrom;
      const to = period.timeTo;
      const cat = getTafPeriodCategory(period);
      const color = cat && FLIGHT_CATEGORIES[cat] ? FLIGHT_CATEGORIES[cat].color : 'transparent';
      const left = ((from - validFrom) / totalDuration) * 100;
      const width = ((to - from) / totalDuration) * 100;
      const label = period.fcstChange + (period.probability ? ` ${period.probability}%` : '');

      if (color === 'transparent' && !period.wxString) continue;

      const bgStyle = period.fcstChange === 'TEMPO' || period.fcstChange === 'PROB'
        ? `background: repeating-linear-gradient(45deg, ${color}88, ${color}88 3px, ${color}44 3px, ${color}44 6px);`
        : `background: ${color}88;`;

      html += `<div class="taf-bar-segment taf-change" style="left:${left}%;width:${width}%;${bgStyle}" title="${label}: ${cat || '?'} ${fmtUtcShort(from)}-${fmtUtcShort(to)}${period.wxString ? ' ' + period.wxString : ''}"></div>`;
    }
    html += `</div>`; // taf-bar-overlay
  }

  // Time axis labels
  html += `<div class="taf-time-axis">`;
  const stepHours = totalDuration > 86400 ? 6 : 3;
  for (let t = validFrom; t <= validTo; t += stepHours * 3600) {
    const left = ((t - validFrom) / totalDuration) * 100;
    html += `<span class="taf-time-label" style="left:${left}%">${fmtUtcHour(t)}</span>`;
  }
  html += `</div>`;

  // Now-marker
  const now = Date.now() / 1000;
  if (now >= validFrom && now <= validTo) {
    const nowLeft = ((now - validFrom) / totalDuration) * 100;
    html += `<div class="taf-now-marker" style="left:${nowLeft}%" title="Now">&#9660;</div>`;
  }

  html += `</div>`; // taf-timeline

  // Detailed forecast periods table
  html += `<div class="taf-details">`;
  for (const period of taf.fcsts) {
    const cat = getTafPeriodCategory(period);
    const catColor = cat && FLIGHT_CATEGORIES[cat] ? FLIGHT_CATEGORIES[cat].color : '#999';
    const changeLabel = period.fcstChange
      ? `<span class="taf-change-badge">${period.fcstChange}${period.probability ? ' ' + period.probability + '%' : ''}</span>`
      : '<span class="taf-change-badge taf-base">BASE</span>';

    const timeRange = period.fcstChange === 'BECMG' && period.timeBec
      ? `${fmtUtcShort(period.timeFrom)} → ${fmtUtcShort(period.timeBec)}`
      : `${fmtUtcShort(period.timeFrom)} - ${fmtUtcShort(period.timeTo)}`;

    html += `<div class="taf-period">`;
    html += `<div class="taf-period-header">`;
    html += changeLabel;
    html += `<span class="taf-period-time">${timeRange}</span>`;
    if (cat) html += `<span class="badge" style="background:${catColor};font-size:10px;padding:1px 6px;">${cat}</span>`;
    html += `</div>`;

    // Period details
    const details = [];

    if (period.visib != null && period.visib !== '') {
      const visNum = typeof period.visib === 'number' ? period.visib : parseFloat(period.visib);
      const visKm = (visNum * 1.60934).toFixed(1);
      details.push(`Vis: ${visKm} km`);
    }

    const ceiling = getCeilingFromClouds(period.clouds);
    if (period.clouds && period.clouds.length > 0) {
      const cloudStr = period.clouds.map(c => `${c.cover} ${c.base}ft`).join(', ');
      details.push(`Clouds: ${cloudStr}`);
    }

    if (period.wdir != null && period.wspd != null) {
      let w = `Wind: ${String(period.wdir).padStart(3,'0')}°/${period.wspd}kt`;
      if (period.wgst) {
        const gwClass = period.wgst >= GUST_WARNING_KT ? 'gust-warn' : '';
        w += ` <span class="${gwClass}">G${period.wgst}</span>`;
      }
      details.push(w);
    }

    if (period.wxString) {
      details.push(`Wx: ${period.wxString}`);
    }

    if (details.length > 0) {
      html += `<div class="taf-period-details">${details.join(' &middot; ')}</div>`;
    }

    html += `</div>`; // taf-period
  }
  html += `</div>`; // taf-details

  // Raw TAF
  if (taf.rawTAF) {
    html += `<div class="metar-raw">${taf.rawTAF}</div>`;
  }

  html += `</div>`; // taf-section
  return html;
}

// ─── Forecast Outlook for Popup ─────────────────────────────

function buildForecastOutlook(icao) {
  const taf = tafData[icao];
  if (!taf || !taf.fcsts || taf.fcsts.length === 0) return '';

  const nowSec = Math.floor(Date.now() / 1000);
  const horizons = [
    { label: '+2h', hours: 2 },
    { label: '+4h', hours: 4 },
    { label: '+8h', hours: 8 },
    { label: '+24h', hours: 24 },
  ];

  const hasAny = horizons.some(h => {
    const t = nowSec + h.hours * 3600;
    return t >= taf.validTimeFrom && t < taf.validTimeTo;
  });
  if (!hasAny) return '';

  let html = `<div class="forecast-outlook">`;
  html += `<div class="forecast-outlook-title">Flight Conditions Outlook</div>`;
  html += `<div class="forecast-outlook-row">`;

  for (const h of horizons) {
    const targetTime = nowSec + h.hours * 3600;
    const inRange = targetTime >= taf.validTimeFrom && targetTime < taf.validTimeTo;
    const cat = inRange ? getForecastCategory(icao, targetTime) : null;
    const color = cat && FLIGHT_CATEGORIES[cat] ? FLIGHT_CATEGORIES[cat].color : NO_DATA_COLOR;
    const catLabel = cat || 'N/A';

    const gustAt = inRange ? getForecastGustAt(icao, targetTime) : 0;
    const gustWarnAt = gustAt >= GUST_WARNING_KT;

    html += `<div class="forecast-outlook-item${inRange ? '' : ' forecast-outlook-na'}">`;
    html += `<div class="forecast-outlook-dot" style="background:${color}"></div>`;
    html += `<div class="forecast-outlook-label">${h.label}</div>`;
    html += `<div class="forecast-outlook-cat">${catLabel}</div>`;
    if (gustWarnAt) {
      html += `<div class="forecast-outlook-gust">G${gustAt}kt</div>`;
    }
    html += `</div>`;
  }

  html += `</div></div>`;
  return html;
}

// ─── Popup Content ─────────────────────────────────────────

function buildPopupContent(airport) {
  const icao = airport.icaoCode;
  const metar = metarData[icao];
  const taf = tafData[icao];
  const catClass = getCategoryClass(icao);
  const catLabel = getCategoryLabel(icao);
  const coords = airport.geometry?.coordinates || [];
  const elev = airport.elevation;
  const isMajor = MAJOR_AIRPORTS.has(icao);

  const tt = airport.trafficType || [];
  const hasVfr = tt.includes(0);
  const hasIfr = tt.includes(1);
  let trafficLabel = hasVfr && hasIfr ? 'VFR/IFR' : hasIfr ? 'IFR Only' : 'VFR Only';

  let html = `<div class="airport-popup">`;
  html += `<h3>${airport.name}${isMajor ? ' &#9992;' : ''}</h3>`;

  if (icao) {
    html += `<div class="icao">${icao}`;
    if (airport.iataCode) html += ` / ${airport.iataCode}`;
    html += `</div>`;
  }

  html += `<div class="badge-row">`;
  html += `<span class="badge ${catClass}">${catLabel}</span>`;
  html += `<span class="badge type-badge">${trafficLabel}</span>`;
  if (hasGustWarning(icao)) {
    const maxG = getMaxGust(icao);
    html += `<span class="badge gust-badge">&#9888; G${maxG}kt</span>`;
  }
  html += `</div>`;

  // Forecast outlook row
  html += buildForecastOutlook(icao);

  // METAR section
  if (metar) {
    html += `<div class="weather-section">`;
    html += `<div class="section-title">Current Weather (METAR)</div>`;

    const cat = getFlightCategory(metar);
    if (cat && FLIGHT_CATEGORIES[cat]) {
      html += `<div class="detail-row"><span class="detail-label">Flight Cat.</span><span class="detail-value" style="color:${FLIGHT_CATEGORIES[cat].color};font-weight:700">${FLIGHT_CATEGORIES[cat].desc}</span></div>`;
    }

    if (metar.visib != null) {
      const visSM = metar.visib;
      const visNum = typeof visSM === 'string' ? parseFloat(visSM) : visSM;
      const visKm = (visNum * 1.60934).toFixed(1);
      html += `<div class="detail-row"><span class="detail-label">Visibility</span><span class="detail-value">${visKm} km</span></div>`;
    }

    const ceiling = getCeilingFromClouds(metar.clouds);
    if (ceiling != null) {
      html += `<div class="detail-row"><span class="detail-label">Ceiling</span><span class="detail-value">${ceiling} ft AGL</span></div>`;
    } else if (metar.clouds && metar.clouds.length > 0) {
      const topCover = metar.clouds[metar.clouds.length - 1].cover;
      html += `<div class="detail-row"><span class="detail-label">Ceiling</span><span class="detail-value">None (${topCover})</span></div>`;
    }

    if (metar.clouds && metar.clouds.length > 0) {
      const cloudStr = metar.clouds.map(c => `${c.cover}${c.base != null ? ' ' + c.base + 'ft' : ''}`).join(', ');
      html += `<div class="detail-row"><span class="detail-label">Clouds</span><span class="detail-value">${cloudStr}</span></div>`;
    }

    if (metar.wdir != null && metar.wspd != null) {
      let windStr = `${String(metar.wdir).padStart(3, '0')}° / ${metar.wspd} kt`;
      if (metar.wgst) {
        const gustClass = metar.wgst >= GUST_WARNING_KT ? ' gust-warn' : '';
        windStr += ` <span class="gust-value${gustClass}">(G${metar.wgst})</span>`;
      }
      html += `<div class="detail-row"><span class="detail-label">Wind</span><span class="detail-value">${windStr}</span></div>`;
    }

    if (metar.temp != null) {
      html += `<div class="detail-row"><span class="detail-label">Temp / Dew</span><span class="detail-value">${metar.temp}°C / ${metar.dewp ?? '—'}°C</span></div>`;
    }

    if (metar.altim != null) {
      html += `<div class="detail-row"><span class="detail-label">QNH</span><span class="detail-value">${Math.round(metar.altim)} hPa</span></div>`;
    }

    if (metar.wxString) {
      html += `<div class="detail-row"><span class="detail-label">Weather</span><span class="detail-value">${metar.wxString}</span></div>`;
    }

    if (metar.reportTime) {
      const t = new Date(metar.reportTime);
      html += `<div class="detail-row"><span class="detail-label">Observed</span><span class="detail-value">${t.toUTCString().slice(0,-4)} UTC</span></div>`;
    }

    if (metar.rawOb) {
      html += `<div class="metar-raw">${metar.rawOb}</div>`;
    }

    html += `</div>`;
  } else {
    html += `<div class="weather-section"><div class="section-title">Weather</div><div style="color:#999">No METAR data available for this station</div></div>`;
  }

  // TAF section
  html += buildTafTimeline(taf);

  // Airport details
  html += `<div class="detail-row"><span class="detail-label">Type</span><span class="detail-value">${AIRPORT_TYPES[airport.type] || 'Unknown'}</span></div>`;

  if (elev && elev.value != null) {
    const elevFt = Math.round(elev.value * 3.28084);
    html += `<div class="detail-row"><span class="detail-label">Elevation</span><span class="detail-value">${elevFt} ft / ${Math.round(elev.value)} m</span></div>`;
  }

  if (coords.length >= 2) {
    const lat = typeof coords[1] === 'number' ? coords[1].toFixed(4) : coords[1];
    const lon = typeof coords[0] === 'number' ? coords[0].toFixed(4) : coords[0];
    html += `<div class="detail-row"><span class="detail-label">Position</span><span class="detail-value">${lat}N, ${lon}E</span></div>`;
  }

  if (airport.runways && airport.runways.length > 0) {
    const rwy = airport.runways[0];
    let rwyInfo = rwy.designator || '';
    if (rwy.dimension) {
      const len = rwy.dimension.length?.value;
      const wid = rwy.dimension.width?.value;
      if (len) rwyInfo += ` (${Math.round(len)}m`;
      if (wid) rwyInfo += ` x ${Math.round(wid)}m`;
      if (len) rwyInfo += ')';
    }
    if (rwy.surface?.mainComposite != null) {
      const surfaces = {0:'Asphalt',1:'Concrete',2:'Grass',3:'Sand',4:'Water',5:'Bituminous',6:'Brick',7:'Macadam',8:'Stone',9:'Coral',10:'Clay',11:'Laterite',12:'Gravel',13:'Earth',14:'Ice',15:'Snow',16:'Rubber',17:'Metal',18:'PSP',19:'Mixed',20:'Unknown'};
      rwyInfo += ` - ${surfaces[rwy.surface.mainComposite] || ''}`;
    }
    html += `<div class="detail-row"><span class="detail-label">Runway</span><span class="detail-value">${rwyInfo}</span></div>`;
  }

  if (airport.ppr) {
    html += `<div class="detail-row"><span class="detail-label">PPR</span><span class="detail-value" style="color:#e74c3c;">Required</span></div>`;
  }

  if (airport.frequencies && airport.frequencies.length > 0) {
    html += `<div class="freq-list"><strong>Frequencies:</strong>`;
    airport.frequencies.forEach(f => {
      const typeName = FREQ_TYPES[f.type] || 'Other';
      const freq = typeof f.value === 'number' ? f.value.toFixed(3) : f.value;
      html += `<div class="freq-item">${typeName}: ${freq} MHz${f.name ? ' (' + f.name + ')' : ''}</div>`;
    });
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ─── Display Airports on Map ───────────────────────────────

function displayAirports() {
  airportMarkers.forEach(m => map.removeLayer(m));
  airportMarkers = [];

  let stats = { total: 0, VFR: 0, IFR: 0, nodata: 0 };

  const sorted = [...airportsData].sort((a, b) => {
    return (MAJOR_AIRPORTS.has(a.icaoCode) ? 1 : 0) - (MAJOR_AIRPORTS.has(b.icaoCode) ? 1 : 0);
  });

  sorted.forEach(airport => {
    const coords = airport.geometry?.coordinates;
    if (!coords || coords.length < 2) return;

    const icao = airport.icaoCode;
    const isMajor = MAJOR_AIRPORTS.has(icao);
    const trend = getTrendForAirport(icao);
    const gustWarn = hasGustWarning(icao);
    const gustValue = gustWarn ? getMaxGust(icao) : 0;
    const icon = createAirportIcon(icao, isMajor, trend, gustWarn, gustValue);

    const marker = L.marker([coords[1], coords[0]], {
      icon, zIndexOffset: isMajor ? 1000 : 0,
    });

    const isMobile = window.innerWidth <= 768;
    marker.bindPopup(() => buildPopupContent(airport), {
      maxWidth: isMobile ? 280 : 380,
      className: 'airport-popup-container',
      autoPanPaddingTopLeft: L.point(10, 60),
    });

    marker.on('popupopen', (e) => {
      const wrapper = e.popup.getElement()?.querySelector('.leaflet-popup-content-wrapper');
      const content = e.popup.getElement()?.querySelector('.leaflet-popup-content');
      if (!wrapper || !content) return;

      // Add fade indicator
      const fade = document.createElement('div');
      fade.className = 'popup-scroll-fade';
      wrapper.appendChild(fade);

      function updateFade() {
        const atBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 8;
        const hasOverflow = content.scrollHeight > content.clientHeight + 8;
        fade.style.opacity = hasOverflow && !atBottom ? '1' : '0';
      }
      content.addEventListener('scroll', updateFade);
      // Initial check after content renders
      setTimeout(updateFade, 50);
    });

    if (isMajor) {
      const cat = getDisplayCategory(icao);
      marker.bindTooltip(cat ? `${icao} (${cat})` : icao, {
        permanent: true, direction: 'top', offset: [0, -14], className: 'airport-label',
      });
    }

    marker.addTo(map);
    airportMarkers.push(marker);

    const cat = getDisplayCategory(icao);
    stats.total++;
    if (cat && stats[cat] != null) stats[cat]++;
    else stats.nodata++;
  });

  document.getElementById('statTotal').textContent = stats.total;
  document.getElementById('statVfr').textContent = stats.VFR;
  document.getElementById('statIfr').textContent = stats.IFR;
  document.getElementById('statNodata').textContent = stats.nodata;
  document.getElementById('statsBar').style.display = 'flex';

  updateRefreshInfo();
}

function formatTimestamp(date) {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${day}.${month}. ${hours}:${minutes}Z`;
}

function formatAge(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m ago`;
}

function updateRefreshInfo() {
  const el = document.getElementById('refreshInfo');
  const headerEl = document.getElementById('headerRefreshInfo');
  const horizonLabels = { 'current': 'Current conditions', '2h': '+2h forecast', '4h': '+4h forecast', '8h': '+8h forecast', '24h': '+24h forecast' };
  const horizonText = horizonLabels[selectedHorizon] || 'Current conditions';

  if (!lastApiFetch) {
    if (el) el.innerHTML = horizonText;
    if (headerEl) headerEl.innerHTML = horizonText;
    return;
  }

  const apiAge = Date.now() - lastApiFetch.getTime();
  const timestampText = formatTimestamp(lastApiFetch);
  const ageText = formatAge(apiAge);
  const stale = apiAge > 30 * 60 * 1000; // > 30 min = stale styling

  const fullText = `${horizonText} | <span class="wx-timestamp${stale ? ' wx-stale' : ''}">WX data: ${timestampText} (${ageText})</span>`;
  if (el) el.innerHTML = fullText;

  // Short version for mobile header
  if (headerEl) {
    headerEl.innerHTML = `<span class="wx-timestamp${stale ? ' wx-stale' : ''}">${timestampText} (${ageText})</span>`;
    document.getElementById('headerRefresh').style.display = '';
  }
}

// ─── Fetch METAR Data ──────────────────────────────────────

async function fetchMetar(icaoCodes, force = false) {
  if (icaoCodes.length === 0) return { data: {}, fetchTime: null };
  const results = {};
  let fetchTime = null;

  try {
    const ids = icaoCodes.join(',');
    const url = `${METAR_PROXY}?ids=${encodeURIComponent(ids)}${force ? '&force=1' : ''}`;
    const res = await fetch(url);
    if (res.ok) {
      const ft = res.headers.get('X-Fetch-Time');
      if (ft) fetchTime = new Date(ft);
      const data = await res.json();
      if (Array.isArray(data)) data.forEach(m => { if (m.icaoId) results[m.icaoId] = m; });
    }
  } catch (err) { console.warn('METAR fetch failed:', err); }

  return { data: results, fetchTime };
}

// ─── Fetch TAF Data ────────────────────────────────────────

async function fetchTaf(icaoCodes, force = false) {
  if (icaoCodes.length === 0) return { data: {}, fetchTime: null };
  const results = {};
  let fetchTime = null;

  try {
    const ids = icaoCodes.join(',');
    const url = `${TAF_PROXY}?ids=${encodeURIComponent(ids)}${force ? '&force=1' : ''}`;
    const res = await fetch(url);
    if (res.ok) {
      const ft = res.headers.get('X-Fetch-Time');
      if (ft) fetchTime = new Date(ft);
      const data = await res.json();
      if (Array.isArray(data)) data.forEach(t => { if (t.icaoId) results[t.icaoId] = t; });
    }
  } catch (err) { console.warn('TAF fetch failed:', err); }

  return { data: results, fetchTime };
}

// ─── Fetch Airports from OpenAIP ───────────────────────────

function getCachedAirports() {
  try {
    const raw = localStorage.getItem(AIRPORT_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached.time || !cached.data) return null;
    if (Date.now() - cached.time > AIRPORT_CACHE_TTL) {
      localStorage.removeItem(AIRPORT_CACHE_KEY);
      return null;
    }
    console.log(`Airport cache hit (age ${Math.round((Date.now() - cached.time) / 60000)} min, ${cached.data.length} airports)`);
    return cached.data;
  } catch (e) {
    localStorage.removeItem(AIRPORT_CACHE_KEY);
    return null;
  }
}

function setCachedAirports(airports) {
  try {
    localStorage.setItem(AIRPORT_CACHE_KEY, JSON.stringify({ data: airports, time: Date.now() }));
  } catch (e) {
    console.warn('Failed to cache airport data:', e.message);
  }
}

async function fetchAirports() {
  // Return cached airports if available
  const cached = getCachedAirports();
  if (cached) return cached;

  const allAirports = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const url = `${AIRPORTS_PROXY}?country=AT&page=${page}&limit=${limit}`;
    const response = await fetch(url);
    if (response.status === 401) throw new Error('NO_API_KEY');
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Airport fetch failed (${response.status}): ${text}`);
    }
    const data = await response.json();
    const items = data.items || data;
    if (Array.isArray(items)) allAirports.push(...items);
    const totalPages = data.totalPages || Math.ceil((data.totalCount || 0) / limit);
    if (page >= totalPages || !Array.isArray(items) || items.length < limit) break;
    page++;
  }

  setCachedAirports(allAirports);
  return allAirports;
}

// ─── Refresh Weather Data ──────────────────────────────────

async function refreshWeather(force = false) {
  const icaoCodes = airportsData.filter(a => a.icaoCode).map(a => a.icaoCode);
  if (icaoCodes.length === 0) return;

  try {
    const [metarResult, tafResult] = await Promise.all([
      fetchMetar(icaoCodes, force),
      fetchTaf(icaoCodes, force),
    ]);
    metarData = metarResult.data;
    tafData = tafResult.data;
    lastWeatherFetch = new Date();

    // Use the server-reported fetch time (when data was actually fetched from AWC API)
    const serverFetchTime = metarResult.fetchTime || tafResult.fetchTime;
    if (serverFetchTime) lastApiFetch = serverFetchTime;

    console.log(`Weather refresh: ${Object.keys(metarData).length} METARs, ${Object.keys(tafData).length} TAFs (API fetch: ${lastApiFetch ? lastApiFetch.toISOString() : 'unknown'})`);
    displayAirports();
  } catch (err) {
    console.warn('Weather refresh failed:', err);
  }
}

// ─── Main Load ─────────────────────────────────────────────

function showError(message) {
  const banner = document.getElementById('errorBanner');
  banner.textContent = message;
  banner.style.display = 'block';
  setTimeout(() => { banner.style.display = 'none'; }, 8000);
}

async function loadAirports() {
  const loading = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');
  loading.style.display = 'flex';

  try {
    loadingText.textContent = 'Fetching airports from OpenAIP...';
    const airports = await fetchAirports();

    if (airports.length === 0) {
      showError('No airports found.');
      loading.style.display = 'none';
      return;
    }

    airportsData = airports.filter(a => a.type !== 4 && a.type !== 7);

    loadingText.textContent = `Fetching METAR & TAF for ${airports.length} airports...`;
    const icaoCodes = airports.filter(a => a.icaoCode).map(a => a.icaoCode);

    const [metarResult, tafResult] = await Promise.all([
      fetchMetar(icaoCodes),
      fetchTaf(icaoCodes),
    ]);
    metarData = metarResult.data;
    tafData = tafResult.data;
    lastWeatherFetch = new Date();
    const serverFetchTime = metarResult.fetchTime || tafResult.fetchTime;
    if (serverFetchTime) lastApiFetch = serverFetchTime;
    console.log(`Loaded ${Object.keys(metarData).length} METARs, ${Object.keys(tafData).length} TAFs (API fetch: ${lastApiFetch ? lastApiFetch.toISOString() : 'unknown'})`);

    displayAirports();

    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshWeather, METAR_REFRESH_INTERVAL);

    // Update age display every 10 seconds
    if (ageTimer) clearInterval(ageTimer);
    ageTimer = setInterval(updateRefreshInfo, 10000);

  } catch (err) {
    console.error('Failed to load:', err);
    if (err.message === 'NO_API_KEY') {
      document.getElementById('apiKeyOverlay').style.display = 'flex';
    } else {
      showError(`Failed to load airports: ${err.message}`);
      document.getElementById('apiKeyOverlay').style.display = 'flex';
    }
  } finally {
    loading.style.display = 'none';
  }
}

// ─── Init ──────────────────────────────────────────────────

async function init() {
  initMap();

  const overlay = document.getElementById('apiKeyOverlay');
  const input = document.getElementById('apiKeyInput');
  const submit = document.getElementById('apiKeySubmit');

  // Check if server has an API key configured
  let serverHasKey = false;
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    serverHasKey = config.hasKey;
  } catch (e) { /* server unreachable */ }

  if (serverHasKey) {
    overlay.style.display = 'none';
    loadAirports();
  } else {
    overlay.style.display = 'flex';
  }

  submit.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) { input.style.borderColor = '#e74c3c'; return; }

    submit.disabled = true;
    submit.textContent = 'Validating...';

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });
      const result = await res.json();

      if (result.ok) {
        overlay.style.display = 'none';
        localStorage.removeItem(AIRPORT_CACHE_KEY);
        loadAirports();
      } else {
        showError(result.error || 'Invalid API key');
        input.style.borderColor = '#e74c3c';
      }
    } catch (e) {
      showError('Failed to save API key: ' + e.message);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Load Airports';
    }
  });

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click(); });
  input.addEventListener('input', () => { input.style.borderColor = '#ddd'; });

  // Horizon selector — sync both header and floating pill
  document.addEventListener('click', (e) => {
    if (!e.target.classList.contains('horizon-btn')) return;
    const horizon = e.target.dataset.horizon;
    document.querySelectorAll('.horizon-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.horizon === horizon);
    });
    selectedHorizon = horizon;
    displayAirports();
  });

  // Mobile: auto-hide header on map drag
  if (window.innerWidth <= 768) {
    const header = document.querySelector('.header');
    let lastCenter = null;
    map.on('movestart', () => {
      lastCenter = map.getCenter();
    });
    map.on('move', () => {
      const center = map.getCenter();
      if (lastCenter && center.lat < lastCenter.lat) {
        header.classList.add('header-hidden');
      } else if (lastCenter && center.lat > lastCenter.lat) {
        header.classList.remove('header-hidden');
      }
      lastCenter = center;
    });
    // Tap on map area re-shows header
    map.on('click', () => {
      header.classList.remove('header-hidden');
    });

    // Swipe gesture on floating horizon pill
    const horizonFloat = document.getElementById('horizonFloat');
    const horizons = ['current', '2h', '4h', '8h', '24h'];
    let touchStartX = null;
    let touchStartY = null;

    horizonFloat.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    horizonFloat.addEventListener('touchend', (e) => {
      if (touchStartX === null) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartX = null;
      touchStartY = null;

      // Only handle horizontal swipes (not taps or vertical gestures)
      if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx)) return;

      const currentIdx = horizons.indexOf(selectedHorizon);
      let newIdx;
      if (dx < 0) {
        // Swipe left → next horizon
        newIdx = Math.min(currentIdx + 1, horizons.length - 1);
      } else {
        // Swipe right → previous horizon
        newIdx = Math.max(currentIdx - 1, 0);
      }
      if (newIdx !== currentIdx) {
        selectedHorizon = horizons[newIdx];
        document.querySelectorAll('.horizon-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.horizon === selectedHorizon);
        });
        displayAirports();
      }
    }, { passive: true });
  }

  // Refresh weather button — forces a fresh fetch from AWC API (bypasses server cache)
  async function handleRefresh() {
    const btn = document.getElementById('refreshBtn');
    const hdrBtn = document.getElementById('headerRefreshBtn');
    btn.disabled = true;
    btn.textContent = 'Fetching...';
    if (hdrBtn) { hdrBtn.disabled = true; hdrBtn.textContent = '...'; }
    await refreshWeather(true);
    btn.disabled = false;
    btn.textContent = '\u21BB Refresh WX';
    if (hdrBtn) { hdrBtn.disabled = false; hdrBtn.textContent = '\u21BB'; }
  }
  document.getElementById('refreshBtn').addEventListener('click', handleRefresh);
  document.getElementById('headerRefreshBtn').addEventListener('click', handleRefresh);
}

// ─── Injected CSS ──────────────────────────────────────────

const style = document.createElement('style');
style.textContent = `
  .airport-label {
    background: rgba(26, 26, 46, 0.85) !important;
    color: white !important;
    border: none !important;
    border-radius: 4px !important;
    padding: 2px 6px !important;
    font-size: 11px !important;
    font-weight: 600 !important;
    letter-spacing: 0.5px !important;
    box-shadow: 0 1px 4px rgba(0,0,0,0.2) !important;
  }
  .airport-label::before {
    border-top-color: rgba(26, 26, 46, 0.85) !important;
  }
  .airport-marker {
    background: transparent !important;
    border: none !important;
  }
  .marker-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    gap: 1px;
  }
  .trend-arrow {
    line-height: 1;
    font-weight: 700;
    text-shadow: 0 0 2px rgba(255,255,255,0.9), 0 0 1px rgba(255,255,255,0.9);
    pointer-events: none;
  }
  .trend-improving { color: #27ae60; }
  .trend-deteriorating { color: #c0392b; }

  /* Gust Warning */
  .gust-label {
    position: absolute;
    top: -8px;
    right: -16px;
    background: #e67e22;
    color: white;
    font-size: 8px;
    font-weight: 800;
    padding: 1px 3px;
    border-radius: 3px;
    border: 1.5px solid white;
    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
    white-space: nowrap;
    line-height: 1.2;
    pointer-events: none;
    z-index: 10;
  }
  .gust-label-major {
    font-size: 9px;
    padding: 1px 4px;
    top: -10px;
    right: -20px;
  }
  .gust-badge {
    background: #e67e22 !important;
    color: white !important;
    font-weight: 700;
  }
  .gust-value.gust-warn {
    color: #e67e22;
    font-weight: 700;
  }
  .gust-warn {
    color: #e67e22;
    font-weight: 700;
  }
  .forecast-outlook-gust {
    font-size: 8px;
    font-weight: 700;
    color: #e67e22;
    margin-top: -1px;
  }

  /* TAF Timeline */
  .taf-section {
    background: #f8f9fa;
    border-radius: 8px;
    padding: 8px 10px;
    margin: 8px 0;
    font-size: 12px;
  }
  .taf-timeline {
    position: relative;
    height: 40px;
    margin: 8px 0 18px 0;
  }
  .taf-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 18px;
    border-radius: 4px;
    overflow: hidden;
  }
  .taf-bar-overlay {
    top: 20px;
    height: 14px;
    border-radius: 3px;
  }
  .taf-bar-segment {
    position: absolute;
    top: 0;
    height: 100%;
    min-width: 2px;
  }
  .taf-change {
    border: 1px solid rgba(0,0,0,0.15);
    border-radius: 2px;
    cursor: help;
  }
  .taf-time-axis {
    position: absolute;
    bottom: -14px;
    left: 0;
    right: 0;
    height: 12px;
  }
  .taf-time-label {
    position: absolute;
    transform: translateX(-50%);
    font-size: 9px;
    color: #999;
    font-family: 'SF Mono', monospace;
  }
  .taf-now-marker {
    position: absolute;
    top: -6px;
    transform: translateX(-50%);
    font-size: 10px;
    color: #e74c3c;
    text-shadow: 0 0 2px white;
    z-index: 5;
    cursor: help;
  }

  /* TAF Detail Periods */
  .taf-details {
    margin-top: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .taf-period {
    background: white;
    border-radius: 4px;
    padding: 4px 6px;
    border-left: 3px solid #ddd;
  }
  .taf-period-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .taf-change-badge {
    font-size: 9px;
    font-weight: 700;
    background: #eee;
    color: #555;
    padding: 1px 5px;
    border-radius: 3px;
    letter-spacing: 0.3px;
  }
  .taf-change-badge.taf-base {
    background: #1a1a2e;
    color: white;
  }
  .taf-period-time {
    font-family: 'SF Mono', monospace;
    font-size: 10px;
    color: #666;
  }
  .taf-period-details {
    font-size: 10px;
    color: #777;
    margin-top: 2px;
    line-height: 1.3;
  }

  /* Horizon Selector */
  .horizon-selector {
    display: flex;
    gap: 3px;
    background: #f0f0f0;
    border-radius: 8px;
    padding: 3px;
  }
  .horizon-btn {
    padding: 5px 12px;
    border: none;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    background: transparent;
    color: #666;
    transition: all 0.2s;
    min-height: 36px;
  }
  .horizon-btn:hover {
    background: rgba(0,0,0,0.05);
  }
  .horizon-btn.active {
    background: #1a1a2e;
    color: white;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  }

  /* Help Button */
  .help-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: #f0f0f0;
    color: #666;
    font-size: 14px;
    font-weight: 700;
    text-decoration: none;
    transition: all 0.2s;
    flex-shrink: 0;
  }
  .help-btn:hover {
    background: #1a1a2e;
    color: white;
  }
  @media (max-width: 768px) {
    .help-btn {
      width: 40px;
      height: 40px;
      font-size: 16px;
    }
  }

  /* Forecast Outlook in Popup */
  .forecast-outlook {
    background: #f0f4f8;
    border-radius: 8px;
    padding: 8px 10px;
    margin: 6px 0;
  }
  .forecast-outlook-title {
    font-size: 11px;
    font-weight: 600;
    color: #1a1a2e;
    margin-bottom: 6px;
  }
  .forecast-outlook-row {
    display: flex;
    gap: 8px;
    justify-content: space-around;
  }
  .forecast-outlook-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .forecast-outlook-dot {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 2px solid white;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
  }
  .forecast-outlook-label {
    font-size: 10px;
    font-weight: 600;
    color: #666;
  }
  .forecast-outlook-cat {
    font-size: 9px;
    color: #999;
    font-weight: 500;
  }
  .forecast-outlook-na {
    opacity: 0.35;
  }

  /* Refresh button & data age */
  .refresh-btn {
    padding: 4px 12px;
    border: 1.5px solid #1a1a2e;
    border-radius: 12px;
    background: transparent;
    color: #1a1a2e;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }
  .refresh-btn:hover {
    background: #1a1a2e;
    color: white;
  }
  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  .wx-timestamp {
    color: #666;
  }
  .wx-stale {
    color: #e67e22;
    font-weight: 600;
  }
  .wx-api-time {
    color: #27ae60;
    font-weight: 500;
  }

  /* Responsive header */
  @media (max-width: 768px) {
    .header h1 {
      font-size: 15px;
    }
  }

  /* Scrollable popup content with fade indicator */
  .airport-popup-container .leaflet-popup-content-wrapper {
    position: relative;
  }
  .airport-popup-container .leaflet-popup-content {
    max-height: 60vh;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }
  .airport-popup-container .leaflet-popup-content .airport-popup {
    padding-right: 8px;
  }
  .popup-scroll-fade {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 32px;
    background: linear-gradient(to bottom, transparent, rgba(255,255,255,0.95));
    pointer-events: none;
    border-radius: 0 0 12px 12px;
    z-index: 10;
    transition: opacity 0.2s;
  }

  /* Mobile popup sizing */
  @media (max-width: 768px) {
    .airport-popup-container .leaflet-popup-content-wrapper {
      border-radius: 10px;
    }
    .airport-popup-container .leaflet-popup-content {
      margin: 8px 10px;
      max-height: 55vh;
      -webkit-overflow-scrolling: touch;
    }
    .airport-popup-container .leaflet-popup-content .airport-popup {
      padding-right: 10px;
    }
    .taf-section {
      padding: 6px 8px;
      font-size: 11px;
    }
    .taf-period-header {
      font-size: 10px;
    }
    .taf-period-details {
      font-size: 9px;
    }
    .taf-change-badge {
      font-size: 8px;
      padding: 1px 4px;
    }
    .taf-period-time {
      font-size: 9px;
    }
    .forecast-outlook {
      padding: 6px 8px;
      margin: 4px 0;
    }
    .forecast-outlook-title {
      font-size: 10px;
      margin-bottom: 4px;
    }
    .forecast-outlook-dot {
      width: 16px;
      height: 16px;
    }
    .forecast-outlook-label {
      font-size: 9px;
    }
    .forecast-outlook-cat {
      font-size: 8px;
    }
  }
`;
document.head.appendChild(style);

document.addEventListener('DOMContentLoaded', init);
