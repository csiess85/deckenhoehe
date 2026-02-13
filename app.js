// Austria Airport VFR Status Map
// Uses OpenAIP API v2 for airport data + aviationweather.gov METAR/TAF for live weather

const METAR_PROXY = '/api/metar';
const TAF_PROXY = '/api/taf';
const AIRPORTS_PROXY = '/api/airports';
const AUSTRIA_CENTER = [47.5, 13.5];
const AUSTRIA_ZOOM = 8;
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
  MVFR: { color: '#3498db', label: 'MVFR', desc: 'Marginal VFR' },
  IFR:  { color: '#e74c3c', label: 'IFR',  desc: 'Instrument Flight Rules' },
  LIFR: { color: '#9b59b6', label: 'LIFR', desc: 'Low IFR' },
};

const NO_DATA_COLOR = '#95a5a6';
const GUST_WARNING_KT = 20; // Show warning when gusts >= this value

// Major Austrian airports (ICAO codes)
const MAJOR_AIRPORTS = new Set([
  'LOWW', 'LOWS', 'LOWG', 'LOWI', 'LOWK', 'LOWL',
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

  // Determine category from ceiling
  let ceilCat = 'VFR';
  if (ceilingFt != null) {
    if (ceilingFt < 500) ceilCat = 'LIFR';
    else if (ceilingFt < 1000) ceilCat = 'IFR';
    else if (ceilingFt <= 3000) ceilCat = 'MVFR';
    else ceilCat = 'VFR';
  }

  // Determine category from visibility
  let visCat = 'VFR';
  if (vis != null) {
    if (vis < 1) visCat = 'LIFR';
    else if (vis < 3) visCat = 'IFR';
    else if (vis <= 5) visCat = 'MVFR';
    else visCat = 'VFR';
  }

  // Return the worse of the two
  const severity = { LIFR: 3, IFR: 2, MVFR: 1, VFR: 0 };
  return severity[ceilCat] >= severity[visCat] ? ceilCat : visCat;
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
  if (metar && metar.fltCat) return metar.fltCat;
  return null;
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

const CATEGORY_SEVERITY = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

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

function createAirportIcon(icao, isMajor, trend, gustWarn) {
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
  if (gustWarn) {
    const gustSize = isMajor ? 16 : 13;
    gustHtml = `<div class="gust-indicator" style="font-size:${gustSize}px;" title="Gusts ≥ ${GUST_WARNING_KT}kt">&#9888;</div>`;
  }

  const dotWidth = size + border * 2;
  const arrowExtra = trend ? (isMajor ? 18 : 13) : 0;
  const gustExtra = gustWarn ? (isMajor ? 18 : 15) : 0;

  return L.divIcon({
    className: 'airport-marker',
    html: `<div class="marker-wrapper"><div style="
      width: ${size}px; height: ${size}px; background: ${color};
      border: ${border}px solid white; border-radius: 50%;
      box-shadow: ${shadow};
      ${isMajor ? 'outline: 2px solid ' + color + '40;' : ''}
    "></div>${arrowHtml}${gustHtml}</div>`,
    iconSize: [dotWidth + arrowExtra + gustExtra, dotWidth],
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
      const visSM = period.visib;
      if (typeof visSM === 'number') {
        details.push(`Vis: ${visSM.toFixed(1)} SM`);
      } else {
        details.push(`Vis: ${visSM} SM`);
      }
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
      html += `<div class="detail-row"><span class="detail-label">Visibility</span><span class="detail-value">${visSM} SM (${visKm} km)</span></div>`;
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

  let stats = { total: 0, VFR: 0, MVFR: 0, IFR: 0, LIFR: 0, nodata: 0 };

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
    const icon = createAirportIcon(icao, isMajor, trend, gustWarn);

    const marker = L.marker([coords[1], coords[0]], {
      icon, zIndexOffset: isMajor ? 1000 : 0,
    });

    const isMobile = window.innerWidth <= 768;
    marker.bindPopup(() => buildPopupContent(airport), {
      maxWidth: isMobile ? 280 : 380,
      className: 'airport-popup-container',
      autoPanPaddingTopLeft: L.point(10, 60),
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
  document.getElementById('statMvfr').textContent = stats.MVFR;
  document.getElementById('statIfr').textContent = stats.IFR;
  document.getElementById('statLifr').textContent = stats.LIFR;
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
  if (!el) return;
  const horizonLabels = { 'current': 'Current conditions', '2h': '+2h forecast', '4h': '+4h forecast', '8h': '+8h forecast', '24h': '+24h forecast' };
  const horizonText = horizonLabels[selectedHorizon] || 'Current conditions';

  if (!lastApiFetch) {
    el.innerHTML = horizonText;
    return;
  }

  const apiAge = Date.now() - lastApiFetch.getTime();
  const timestampText = formatTimestamp(lastApiFetch);
  const ageText = formatAge(apiAge);
  const stale = apiAge > 10 * 60 * 1000; // > 10 min = stale styling

  el.innerHTML = `${horizonText} | <span class="wx-timestamp${stale ? ' wx-stale' : ''}">WX data: ${timestampText} (${ageText})</span>`;
}

// ─── Fetch METAR Data ──────────────────────────────────────

async function fetchMetar(icaoCodes, force = false) {
  if (icaoCodes.length === 0) return { data: {}, fetchTime: null };
  const results = {};
  let latestFetchTime = null;
  const batchSize = 40;

  for (let i = 0; i < icaoCodes.length; i += batchSize) {
    const ids = icaoCodes.slice(i, i + batchSize).join(',');
    try {
      const url = `${METAR_PROXY}?ids=${encodeURIComponent(ids)}${force ? '&force=1' : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const ft = res.headers.get('X-Fetch-Time');
        if (ft) {
          const t = new Date(ft);
          if (!latestFetchTime || t > latestFetchTime) latestFetchTime = t;
        }
        const data = await res.json();
        if (Array.isArray(data)) data.forEach(m => { if (m.icaoId) results[m.icaoId] = m; });
      }
    } catch (err) { console.warn('METAR fetch failed:', err); }
  }
  return { data: results, fetchTime: latestFetchTime };
}

// ─── Fetch TAF Data ────────────────────────────────────────

async function fetchTaf(icaoCodes, force = false) {
  if (icaoCodes.length === 0) return { data: {}, fetchTime: null };
  const results = {};
  let latestFetchTime = null;
  const batchSize = 40;

  for (let i = 0; i < icaoCodes.length; i += batchSize) {
    const ids = icaoCodes.slice(i, i + batchSize).join(',');
    try {
      const url = `${TAF_PROXY}?ids=${encodeURIComponent(ids)}${force ? '&force=1' : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const ft = res.headers.get('X-Fetch-Time');
        if (ft) {
          const t = new Date(ft);
          if (!latestFetchTime || t > latestFetchTime) latestFetchTime = t;
        }
        const data = await res.json();
        if (Array.isArray(data)) data.forEach(t => { if (t.icaoId) results[t.icaoId] = t; });
      }
    } catch (err) { console.warn('TAF fetch failed:', err); }
  }
  return { data: results, fetchTime: latestFetchTime };
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

    airportsData = airports;

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

  // One-time migration from localStorage to server
  const legacyKey = localStorage.getItem('openaip_api_key');
  if (legacyKey && !serverHasKey) {
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: legacyKey }),
      });
      const result = await res.json();
      if (result.ok) {
        localStorage.removeItem('openaip_api_key');
        serverHasKey = true;
      }
    } catch (e) { /* migration failed, user will re-enter */ }
  }
  if (legacyKey && serverHasKey) localStorage.removeItem('openaip_api_key');

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

  // Horizon selector
  document.addEventListener('click', (e) => {
    if (!e.target.classList.contains('horizon-btn')) return;
    document.querySelectorAll('.horizon-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    selectedHorizon = e.target.dataset.horizon;
    displayAirports();
  });

  // Refresh weather button — forces a fresh fetch from AWC API (bypasses server cache)
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.disabled = true;
    btn.textContent = 'Fetching from API...';
    await refreshWeather(true);
    btn.disabled = false;
    btn.textContent = '\u21BB Refresh WX';
  });
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
  .gust-indicator {
    line-height: 1;
    color: #e67e22;
    text-shadow:
      0 0 3px rgba(255,255,255,1),
      0 0 6px rgba(255,255,255,0.8),
      0 1px 2px rgba(0,0,0,0.3);
    filter: drop-shadow(0 0 2px rgba(230,126,34,0.6));
    pointer-events: none;
    animation: gust-pulse 1.5s ease-in-out infinite;
  }
  @keyframes gust-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.7; transform: scale(1.15); }
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
    width: 28px;
    height: 28px;
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
    .header {
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
    }
    .header h1 {
      font-size: 15px;
      width: 100%;
      text-align: center;
    }
    .horizon-selector { order: 2; }
    .legend { order: 3; font-size: 11px; gap: 8px; }
    .horizon-btn { padding: 4px 8px; font-size: 11px; }
  }

  /* Scrollable popup content */
  .airport-popup-container .leaflet-popup-content {
    max-height: 60vh;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }
  .airport-popup-container .leaflet-popup-content .airport-popup {
    padding-right: 8px;
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
