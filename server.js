// Local server that serves static files and proxies METAR + TAF + airport requests
// to aviationweather.gov (CORS bypass) and api.core.openaip.net (key on server)
// Also stores weather history in SQLite for long-term comparison

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 5556;
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const PURGE_ON_START = process.argv.includes('--purge');
const WEATHER_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const AIRPORT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_FILE = path.join(__dirname, 'data', '.cache.json');
const HISTORY_DB_PATH = path.join(__dirname, 'data', 'weather_history.db');
const HISTORY_FETCH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours
const HISTORY_RETENTION_DAYS = 3 * 365; // ~1095 days
const PURGE_OLDER_THAN_DAYS = (() => {
  const idx = process.argv.indexOf('--older-than');
  if (idx === -1 || idx + 1 >= process.argv.length) return HISTORY_RETENTION_DAYS;
  const val = parseInt(process.argv[idx + 1]);
  return isNaN(val) || val < 1 ? HISTORY_RETENTION_DAYS : val;
})();
const AIRPORT_LIST_REFRESH_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days
const LOG_FILE = path.join(__dirname, 'data', 'server.log');
const LOG_MAX_ENTRIES = 200; // max entries returned via API

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

// ─── Structured Log File ────────────────────────────────────

function appendLog(level, category, message, detail) {
  const ts = new Date().toISOString();
  const line = `${ts}\t${level}\t${category}\t${message}\t${detail || ''}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) { /* ignore write errors */ }
  // Also log to console
  const prefix = category ? `[${category}]` : '';
  if (level === 'ERROR') console.error(`${prefix} ${message}`, detail || '');
  else if (level === 'WARN') console.warn(`${prefix} ${message}`, detail || '');
  else if (VERBOSE || level !== 'DEBUG') console.log(`${prefix} ${message}`, detail || '');
}

function readLog(n, levelFilter, categoryFilter) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').splitlines ?
      fs.readFileSync(LOG_FILE, 'utf-8').split('\n') :
      fs.readFileSync(LOG_FILE, 'utf-8').split('\n');
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const entry = { time: parts[0], level: parts[1], category: parts[2], message: parts[3] || '', detail: parts[4] || '' };
      if (levelFilter && entry.level !== levelFilter) continue;
      if (categoryFilter && entry.category !== categoryFilter) continue;
      entries.push(entry);
    }
    return entries.slice(-n);
  } catch (e) {
    return [];
  }
}

function logInfo(category, message, detail) { appendLog('INFO', category, message, detail); }
function logWarn(category, message, detail) { appendLog('WARN', category, message, detail); }
function logError(category, message, detail) { appendLog('ERROR', category, message, detail); }
function logDebug(category, message, detail) { appendLog('DEBUG', category, message, detail); }

// ─── Log File Rotation ──────────────────────────────────────

function rotateLogIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) { // > 5 MB
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
      const rotated = LOG_FILE.replace('.log', `.${ts}.log`);
      fs.renameSync(LOG_FILE, rotated);
      appendLog('INFO', 'SYSTEM', `Log file rotated (exceeded 5 MB)`, rotated);
    }
  } catch (e) { /* ignore */ }
}

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
      logInfo('CACHE', `Loaded ${loaded} cache entries from disk`);
    }
  } catch (err) {
    logWarn('CACHE', 'Failed to load cache from disk', err.message);
  }
}

// Save cache to disk
function saveCacheToDisk() {
  try {
    const data = Object.fromEntries(cache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
    logDebug('CACHE', `Saved ${cache.size} cache entries to disk`);
  } catch (err) {
    logWarn('CACHE', 'Failed to save cache to disk', err.message);
  }
}

// Auto-save cache every 5 minutes
setInterval(saveCacheToDisk, 5 * 60 * 1000);

// ─── SQLite Weather History Database ────────────────────────

fs.mkdirSync(path.dirname(HISTORY_DB_PATH), { recursive: true });
const db = new DatabaseSync(HISTORY_DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS metar_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fetch_time   TEXT NOT NULL,
    icao_id      TEXT NOT NULL,
    flt_cat      TEXT,
    temp         REAL,
    dewp         REAL,
    wdir         INTEGER,
    wspd         INTEGER,
    wgst         INTEGER,
    visib        TEXT,
    altim        REAL,
    ceiling      INTEGER,
    cloud_base   INTEGER,
    wx_string    TEXT,
    raw_ob       TEXT,
    report_time  TEXT,
    metar_json   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_metar_icao_time ON metar_history (icao_id, fetch_time);
  CREATE INDEX IF NOT EXISTS idx_metar_time ON metar_history (fetch_time);

  CREATE TABLE IF NOT EXISTS taf_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fetch_time      TEXT NOT NULL,
    icao_id         TEXT NOT NULL,
    valid_from      TEXT,
    valid_to        TEXT,
    flt_cat_now     TEXT,
    flt_cat_2h      TEXT,
    flt_cat_4h      TEXT,
    flt_cat_8h      TEXT,
    flt_cat_24h     TEXT,
    raw_taf         TEXT,
    taf_json        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_taf_icao_time ON taf_history (icao_id, fetch_time);
  CREATE INDEX IF NOT EXISTS idx_taf_time ON taf_history (fetch_time);
  CREATE INDEX IF NOT EXISTS idx_metar_report ON metar_history (icao_id, report_time);
  CREATE INDEX IF NOT EXISTS idx_taf_valid ON taf_history (icao_id, valid_from);

  CREATE TABLE IF NOT EXISTS tracked_airports (
    icao_id    TEXT PRIMARY KEY,
    name       TEXT,
    lat        REAL,
    lon        REAL,
    updated_at TEXT NOT NULL
  );
`);

// Migration: add cloud_base column if missing
try { db.exec(`ALTER TABLE metar_history ADD COLUMN cloud_base INTEGER`); } catch (e) { /* already exists */ }

// Purge duplicate rows (keep earliest fetch per unique observation)
db.exec(`
  DELETE FROM metar_history WHERE id NOT IN (
    SELECT MIN(id) FROM metar_history WHERE report_time IS NOT NULL GROUP BY icao_id, report_time
  ) AND report_time IS NOT NULL;
  DELETE FROM taf_history WHERE id NOT IN (
    SELECT MIN(id) FROM taf_history WHERE valid_from IS NOT NULL GROUP BY icao_id, valid_from
  ) AND valid_from IS NOT NULL;
`);

const insertMetarStmt = db.prepare(`
  INSERT INTO metar_history (fetch_time, icao_id, flt_cat, temp, dewp, wdir, wspd, wgst, visib, altim, ceiling, cloud_base, wx_string, raw_ob, report_time, metar_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const metarExistsStmt = db.prepare(`
  SELECT 1 FROM metar_history WHERE icao_id = ? AND report_time = ? LIMIT 1
`);

const insertTafStmt = db.prepare(`
  INSERT INTO taf_history (fetch_time, icao_id, valid_from, valid_to, flt_cat_now, flt_cat_2h, flt_cat_4h, flt_cat_8h, flt_cat_24h, raw_taf, taf_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const tafExistsStmt = db.prepare(`
  SELECT 1 FROM taf_history WHERE icao_id = ? AND valid_from = ? LIMIT 1
`);

// Backfill null flt_cat_now from stored taf_json (fix for TAFs fetched before validity start)
{
  const nullRows = db.prepare(`SELECT id, fetch_time, taf_json FROM taf_history WHERE flt_cat_now IS NULL AND taf_json IS NOT NULL`).all();
  if (nullRows.length > 0) {
    const updateStmt = db.prepare(`UPDATE taf_history SET flt_cat_now = ? WHERE id = ?`);
    let fixed = 0;
    db.exec('BEGIN');
    for (const row of nullRows) {
      try {
        const taf = JSON.parse(row.taf_json);
        const fetchSec = Math.floor(new Date(row.fetch_time).getTime() / 1000);
        const evalTime = (taf.validTimeFrom && fetchSec < taf.validTimeFrom) ? taf.validTimeFrom : fetchSec;
        const cat = getForecastCategoryFromTaf(taf, evalTime);
        if (cat) { updateStmt.run(cat, row.id); fixed++; }
      } catch (e) { /* skip unparseable */ }
    }
    db.exec('COMMIT');
    if (fixed > 0) logInfo('DB', `Backfilled ${fixed} null flt_cat_now values`);
  }
}

// Backfill null cloud_base from stored metar_json (lowest cloud base regardless of coverage)
{
  const nullRows = db.prepare(`SELECT id, metar_json FROM metar_history WHERE cloud_base IS NULL AND metar_json IS NOT NULL`).all();
  if (nullRows.length > 0) {
    const updateStmt = db.prepare(`UPDATE metar_history SET cloud_base = ? WHERE id = ?`);
    let fixed = 0;
    db.exec('BEGIN');
    for (const row of nullRows) {
      try {
        const metar = JSON.parse(row.metar_json);
        const base = getLowestCloudBase(metar.clouds);
        if (base != null) { updateStmt.run(base, row.id); fixed++; }
      } catch (e) { /* skip unparseable */ }
    }
    db.exec('COMMIT');
    if (fixed > 0) logInfo('DB', `Backfilled ${fixed} cloud_base values`);
  }
}

logInfo('DB', `Weather history DB initialized: ${HISTORY_DB_PATH}`);

// ─── Flight Category Computation (ported from app.js) ───────

function getCeilingFromClouds(clouds) {
  if (!clouds || !Array.isArray(clouds)) return null;
  for (const c of clouds) {
    if (c.cover === 'BKN' || c.cover === 'OVC' || c.cover === 'OVX') {
      return c.base;
    }
  }
  return null;
}

function getLowestCloudBase(clouds) {
  if (!clouds || !Array.isArray(clouds)) return null;
  let lowest = null;
  for (const c of clouds) {
    if (c.base != null && (lowest === null || c.base < lowest)) {
      lowest = c.base;
    }
  }
  return lowest;
}

function computeFlightCategory(ceilingFt, visibSM) {
  let vis = null;
  if (visibSM != null && visibSM !== '') {
    if (typeof visibSM === 'string') {
      vis = visibSM.includes('+') ? parseFloat(visibSM) + 0.1 : parseFloat(visibSM);
    } else {
      vis = visibSM;
    }
  }
  let ceilCat = 'VFR';
  if (ceilingFt != null) {
    if (ceilingFt < 500) ceilCat = 'LIFR';
    else if (ceilingFt < 1000) ceilCat = 'IFR';
    else if (ceilingFt <= 3000) ceilCat = 'MVFR';
  }
  let visCat = 'VFR';
  if (vis != null) {
    if (vis < 1) visCat = 'LIFR';
    else if (vis < 3) visCat = 'IFR';
    else if (vis <= 5) visCat = 'MVFR';
  }
  const severity = { LIFR: 3, IFR: 2, MVFR: 1, VFR: 0 };
  return severity[ceilCat] >= severity[visCat] ? ceilCat : visCat;
}

function getTafPeriodCategory(period) {
  const ceiling = getCeilingFromClouds(period.clouds);
  const vis = period.visib;
  if (ceiling == null && (vis == null || vis === '')) return null;
  return computeFlightCategory(ceiling, vis);
}

function worseCat(a, b) {
  if (!a) return b;
  if (!b) return a;
  const s = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
  return (s[a] || 0) >= (s[b] || 0) ? a : b;
}

function getForecastCategoryFromTaf(taf, targetTime) {
  if (!taf || !taf.fcsts || taf.fcsts.length === 0) return null;
  if (targetTime < taf.validTimeFrom || targetTime >= taf.validTimeTo) return null;
  const basePeriods = taf.fcsts.filter(f => !f.fcstChange);
  const changeGroups = taf.fcsts.filter(f => f.fcstChange);
  let baseCat = null;
  for (const period of basePeriods) {
    if (period.timeFrom <= targetTime && targetTime < period.timeTo) {
      baseCat = getTafPeriodCategory(period);
      break;
    }
  }
  for (const cg of changeGroups) {
    if (cg.fcstChange !== 'BECMG') continue;
    if (cg.timeFrom <= targetTime) {
      baseCat = worseCat(baseCat, getTafPeriodCategory(cg));
    }
  }
  let worstCat = baseCat;
  for (const cg of changeGroups) {
    if (cg.fcstChange === 'BECMG') continue;
    if (cg.timeFrom <= targetTime && targetTime < cg.timeTo) {
      worstCat = worseCat(worstCat, getTafPeriodCategory(cg));
    }
  }
  return worstCat;
}

function getForecastWeatherFromTaf(taf, targetTimeSec) {
  if (!taf || !taf.fcsts || taf.fcsts.length === 0) return null;
  if (targetTimeSec < taf.validTimeFrom || targetTimeSec >= taf.validTimeTo) return null;

  const basePeriods = taf.fcsts.filter(f => !f.fcstChange);
  const changeGroups = taf.fcsts.filter(f => f.fcstChange);

  let result = { wspd: null, wgst: null, wdir: null, ceiling: null };

  // Base forecast period covering targetTime
  for (const period of basePeriods) {
    if (period.timeFrom <= targetTimeSec && targetTimeSec < period.timeTo) {
      result.wspd = period.wspd ?? null;
      result.wgst = period.wgst ?? null;
      result.wdir = period.wdir ?? null;
      result.ceiling = getCeilingFromClouds(period.clouds);
      break;
    }
  }

  // BECMG groups: overwrite values (permanent transitions)
  for (const cg of changeGroups) {
    if (cg.fcstChange !== 'BECMG') continue;
    if (cg.timeFrom <= targetTimeSec) {
      if (cg.wspd != null) result.wspd = cg.wspd;
      if (cg.wgst != null) result.wgst = cg.wgst;
      if (cg.wdir != null) result.wdir = cg.wdir;
      const becmgCeiling = getCeilingFromClouds(cg.clouds);
      if (becmgCeiling != null) result.ceiling = becmgCeiling;
    }
  }

  // TEMPO/PROB groups: worst case (highest wind, lowest ceiling)
  for (const cg of changeGroups) {
    if (cg.fcstChange === 'BECMG') continue;
    if (cg.timeFrom <= targetTimeSec && targetTimeSec < cg.timeTo) {
      if (cg.wspd != null && (result.wspd == null || cg.wspd > result.wspd)) result.wspd = cg.wspd;
      if (cg.wgst != null && (result.wgst == null || cg.wgst > result.wgst)) result.wgst = cg.wgst;
      const tempoCeiling = getCeilingFromClouds(cg.clouds);
      if (tempoCeiling != null && (result.ceiling == null || tempoCeiling < result.ceiling)) result.ceiling = tempoCeiling;
    }
  }

  return result;
}

// ─── HTTPS JSON Helper ──────────────────────────────────────

function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: headers || {},
    };
    https.get(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Invalid JSON from ${url}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
      });
    }).on('error', reject);
  });
}

// ─── Weather History Storage ────────────────────────────────

function storeMetarSnapshots(fetchTime, metarArray) {
  if (!Array.isArray(metarArray) || metarArray.length === 0) return 0;
  const ft = fetchTime.toISOString();
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const m of metarArray) {
      if (!m.icaoId) continue;
      // Skip if we already have this exact observation
      if (m.reportTime && metarExistsStmt.get(m.icaoId, m.reportTime)) continue;
      const ceiling = getCeilingFromClouds(m.clouds);
      const cloudBase = getLowestCloudBase(m.clouds);
      insertMetarStmt.run(
        ft, m.icaoId, m.fltCat || null,
        m.temp ?? null, m.dewp ?? null,
        m.wdir ?? null, m.wspd ?? null, m.wgst ?? null,
        m.visib != null ? String(m.visib) : null,
        m.altim ?? null, ceiling, cloudBase,
        m.wxString || null, m.rawOb || null,
        m.reportTime || null,
        JSON.stringify(m)
      );
      count++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    logError('HISTORY', 'Failed to store METAR snapshots', err.message);
    return 0;
  }
  return count;
}

function storeTafSnapshots(fetchTime, tafArray) {
  if (!Array.isArray(tafArray) || tafArray.length === 0) return 0;
  const ft = fetchTime.toISOString();
  const nowSec = Math.floor(fetchTime.getTime() / 1000);
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const t of tafArray) {
      if (!t.icaoId) continue;
      // Skip if we already have this exact forecast
      const validFrom = t.validTimeFrom ? new Date(t.validTimeFrom * 1000).toISOString() : null;
      if (validFrom && tafExistsStmt.get(t.icaoId, validFrom)) continue;
      // Clamp to validity start so TAFs fetched before they're valid don't get null cat_now
      const catNowTime = (t.validTimeFrom && nowSec < t.validTimeFrom) ? t.validTimeFrom : nowSec;
      const catNow = getForecastCategoryFromTaf(t, catNowTime);
      const cat2h = getForecastCategoryFromTaf(t, nowSec + 2 * 3600);
      const cat4h = getForecastCategoryFromTaf(t, nowSec + 4 * 3600);
      const cat8h = getForecastCategoryFromTaf(t, nowSec + 8 * 3600);
      const cat24h = getForecastCategoryFromTaf(t, nowSec + 24 * 3600);
      const validTo = t.validTimeTo ? new Date(t.validTimeTo * 1000).toISOString() : null;
      insertTafStmt.run(
        ft, t.icaoId, validFrom, validTo,
        catNow, cat2h, cat4h, cat8h, cat24h,
        t.rawTAF || null,
        JSON.stringify(t)
      );
      count++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    logError('HISTORY', 'Failed to store TAF snapshots', err.message);
    return 0;
  }
  return count;
}

// ─── Airport List Management ────────────────────────────────

async function refreshAirportList() {
  const apiKey = getApiKey();
  if (!apiKey) {
    logDebug('HISTORY', 'No API key, skipping airport list refresh');
    return [];
  }
  try {
    const allAirports = [];
    let page = 1;
    const limit = 100;
    while (true) {
      const url = `https://api.core.openaip.net/api/airports?country=AT&page=${page}&limit=${limit}`;
      const data = await httpsGetJson(url, { 'x-openaip-api-key': apiKey });
      const items = data.items || data;
      if (Array.isArray(items)) allAirports.push(...items);
      const totalPages = data.totalPages || Math.ceil((data.totalCount || 0) / limit);
      if (page >= totalPages || !Array.isArray(items) || items.length < limit) break;
      page++;
    }

    // Filter out heliports (type 4 and 7) — same filter as app.js
    const filtered = allAirports.filter(a => a.type !== 4 && a.type !== 7 && a.icaoCode);

    // Store in tracked_airports
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO tracked_airports (icao_id, name, lat, lon, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    db.exec('BEGIN');
    for (const a of filtered) {
      const coords = a.geometry?.coordinates;
      upsert.run(a.icaoCode, a.name || '', coords?.[1] ?? null, coords?.[0] ?? null, now);
    }
    db.exec('COMMIT');

    logInfo('HISTORY', `Updated tracked airports: ${filtered.length}`);
    return filtered.map(a => a.icaoCode);
  } catch (err) {
    logError('HISTORY', 'Failed to refresh airport list', err.message);
    return [];
  }
}

function getTrackedIcaoCodes() {
  const rows = db.prepare('SELECT icao_id FROM tracked_airports').all();
  return rows.map(r => r.icao_id);
}

// ─── Scheduled History Fetch ────────────────────────────────

let historyFetchTimer = null;
let nextHistoryFetchTime = null;

async function performHistoryFetch() {
  let icaoCodes = getTrackedIcaoCodes();
  if (icaoCodes.length === 0) {
    logDebug('HISTORY', 'No tracked airports, refreshing list...');
    icaoCodes = await refreshAirportList();
  }
  if (icaoCodes.length === 0) {
    logWarn('HISTORY', 'No airports to fetch weather for');
    return;
  }

  const fetchTime = new Date();
  const batchSize = 40;
  let allMetar = [];
  let allTaf = [];

  for (let i = 0; i < icaoCodes.length; i += batchSize) {
    const batch = icaoCodes.slice(i, i + batchSize).join(',');
    try {
      const metarUrl = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(batch)}&format=json&hours=3`;
      const metarData = await httpsGetJson(metarUrl);
      if (Array.isArray(metarData)) allMetar.push(...metarData);
    } catch (err) {
      logWarn('HISTORY', 'METAR batch fetch failed', err.message);
    }
    try {
      const tafUrl = `https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(batch)}&format=json`;
      const tafData = await httpsGetJson(tafUrl);
      if (Array.isArray(tafData)) allTaf.push(...tafData);
    } catch (err) {
      logWarn('HISTORY', 'TAF batch fetch failed', err.message);
    }
  }

  const metarCount = storeMetarSnapshots(fetchTime, allMetar);
  const tafCount = storeTafSnapshots(fetchTime, allTaf);

  // Also update the in-memory cache so client requests benefit
  if (allMetar.length > 0) {
    setCache('metar:all', 200, JSON.stringify(allMetar));
  }
  if (allTaf.length > 0) {
    setCache('taf:all', 200, JSON.stringify(allTaf));
  }

  logInfo('HISTORY', `Stored ${metarCount} METARs, ${tafCount} TAFs`, fetchTime.toISOString());
  return { metarCount, tafCount };
}

function scheduleHistoryFetch() {
  if (historyFetchTimer) clearTimeout(historyFetchTimer);
  nextHistoryFetchTime = Date.now() + HISTORY_FETCH_INTERVAL;
  const nextAt = new Date(nextHistoryFetchTime).toISOString();
  logInfo('SCHEDULER', `Next weather fetch scheduled`, `${HISTORY_FETCH_INTERVAL / 1000 / 60}min from now (${nextAt})`);
  historyFetchTimer = setTimeout(async () => {
    logInfo('SCHEDULER', 'Scheduled weather fetch triggered');
    try {
      const result = await performHistoryFetch();
      if (result) {
        logInfo('SCHEDULER', `Fetch complete: ${result.metarCount} METARs, ${result.tafCount} TAFs stored`);
      } else {
        logWarn('SCHEDULER', 'Fetch returned no results (no airports tracked)');
      }
    } catch (err) { logError('SCHEDULER', 'Scheduled fetch failed', err.message); }
    scheduleHistoryFetch();
  }, HISTORY_FETCH_INTERVAL);
}

// ─── Data Purge (3-year retention) ──────────────────────────

function purgeOldData(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const metarResult = db.prepare('DELETE FROM metar_history WHERE fetch_time < ?').run(cutoff);
  const tafResult = db.prepare('DELETE FROM taf_history WHERE fetch_time < ?').run(cutoff);
  const total = metarResult.changes + tafResult.changes;
  logInfo('HISTORY', `Purged ${metarResult.changes} METARs + ${tafResult.changes} TAFs older than ${days} days (cutoff: ${cutoff})`);
  return total;
}

// Refresh airport list weekly
setInterval(() => {
  logInfo('SCHEDULER', 'Weekly airport list refresh triggered');
  refreshAirportList().catch(e => logError('SCHEDULER', 'Airport list refresh failed', e.message));
}, AIRPORT_LIST_REFRESH_INTERVAL);

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

async function proxyMetar(req, res, query) {
  const ids = query.ids || '';
  if (!ids) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing ids parameter' }));
    return;
  }

  const force = query.force === '1';
  stats.metar.total++;
  const cacheKey = 'metar:all';

  if (force) {
    cache.delete(cacheKey);
    logDebug('METAR', 'Cache invalidated (force refresh)');
    // Reset the 2h history fetch timer on manual refresh
    logInfo('SCHEDULER', 'Timer reset by manual refresh');
    scheduleHistoryFetch();
  }

  const cached = getCached(cacheKey, WEATHER_CACHE_TTL);
  if (cached) {
    stats.metar.cached++;
    logCall('metar', { time: Date.now(), cached: true, age: Math.round((Date.now() - cached.time) / 1000) });
    logDebug('METAR', `Cache hit (age ${Math.round((Date.now() - cached.time) / 1000)}s)`);
    res.writeHead(cached.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Cache, X-Fetch-Time', 'X-Cache': 'HIT', 'X-Fetch-Time': new Date(cached.time).toISOString() });
    res.end(cached.body);
    return;
  }

  const startTime = Date.now();
  const icaoList = ids.split(',');
  const batchSize = 40;
  let allResults = [];

  try {
    for (let i = 0; i < icaoList.length; i += batchSize) {
      const batch = icaoList.slice(i, i + batchSize).join(',');
      const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(batch)}&format=json`;
      logDebug('METAR', `Fetching from upstream`, url);
      const data = await httpsGetJson(url);
      if (Array.isArray(data)) allResults.push(...data);
    }

    const duration = Date.now() - startTime;
    const body = JSON.stringify(allResults);
    logDebug('METAR', `Upstream complete`, `${allResults.length} results, ${body.length} bytes, ${duration}ms`);

    setCache(cacheKey, 200, body);
    storeMetarSnapshots(new Date(), allResults);

    logCall('metar', { time: Date.now(), cached: false, status: 200, bytes: body.length, duration });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Cache, X-Fetch-Time',
      'X-Cache': 'MISS',
      'X-Fetch-Time': new Date().toISOString(),
    });
    res.end(body);
  } catch (err) {
    const duration = Date.now() - startTime;
    stats.metar.errors++;
    logCall('metar', { time: Date.now(), cached: false, error: err.message, duration });
    logError('METAR', 'Proxy error', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch METAR data' }));
  }
}

async function proxyTaf(req, res, query) {
  const ids = query.ids || '';
  if (!ids) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing ids parameter' }));
    return;
  }

  const force = query.force === '1';
  stats.taf.total++;
  const cacheKey = 'taf:all';

  if (force) {
    cache.delete(cacheKey);
    logDebug('TAF', 'Cache invalidated (force refresh)');
  }

  const cached = getCached(cacheKey, WEATHER_CACHE_TTL);
  if (cached) {
    stats.taf.cached++;
    logCall('taf', { time: Date.now(), cached: true, age: Math.round((Date.now() - cached.time) / 1000) });
    logDebug('TAF', `Cache hit (age ${Math.round((Date.now() - cached.time) / 1000)}s)`);
    res.writeHead(cached.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Cache, X-Fetch-Time', 'X-Cache': 'HIT', 'X-Fetch-Time': new Date(cached.time).toISOString() });
    res.end(cached.body);
    return;
  }

  const startTime = Date.now();
  const icaoList = ids.split(',');
  const batchSize = 40;
  let allResults = [];

  try {
    for (let i = 0; i < icaoList.length; i += batchSize) {
      const batch = icaoList.slice(i, i + batchSize).join(',');
      const url = `https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(batch)}&format=json`;
      logDebug('TAF', 'Fetching from upstream', url);
      const data = await httpsGetJson(url);
      if (Array.isArray(data)) allResults.push(...data);
    }

    const duration = Date.now() - startTime;
    const body = JSON.stringify(allResults);
    logDebug('TAF', `Upstream complete`, `${allResults.length} results, ${body.length} bytes, ${duration}ms`);

    setCache(cacheKey, 200, body);
    storeTafSnapshots(new Date(), allResults);

    logCall('taf', { time: Date.now(), cached: false, status: 200, bytes: body.length, duration });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Cache, X-Fetch-Time',
      'X-Cache': 'MISS',
      'X-Fetch-Time': new Date().toISOString(),
    });
    res.end(body);
  } catch (err) {
    const duration = Date.now() - startTime;
    stats.taf.errors++;
    logCall('taf', { time: Date.now(), cached: false, error: err.message, duration });
    logError('TAF', 'Proxy error', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch TAF data' }));
  }
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
  const force = query.force === '1';

  stats.airports.total++;
  const cacheKey = `airports:${country}:${page}:${limit}`;

  if (force) {
    cache.delete(cacheKey);
    logDebug('AIRPORTS', 'Cache invalidated (force refresh)');
  }

  const cached = getCached(cacheKey, AIRPORT_CACHE_TTL);
  if (cached) {
    stats.airports.cached++;
    logCall('airports', { time: Date.now(), cached: true, age: Math.round((Date.now() - cached.time) / 1000) });
    logDebug('AIRPORTS', `Cache hit (age ${Math.round((Date.now() - cached.time) / 1000)}s)`);
    res.writeHead(cached.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Cache, X-Fetch-Time', 'X-Cache': 'HIT', 'X-Fetch-Time': new Date(cached.time).toISOString() });
    res.end(cached.body);
    return;
  }

  const openaipUrl = `https://api.core.openaip.net/api/airports?country=${encodeURIComponent(country)}&page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`;
  const startTime = Date.now();

  logDebug('AIRPORTS', 'Fetching from upstream', openaipUrl);

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
      logDebug('AIRPORTS', `Upstream response ${proxyRes.statusCode}`, `${body.length} bytes, ${duration}ms`);
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
    logError('AIRPORTS', 'Proxy error', err.message);
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
    logDebug('CONFIG', 'Validating API key...');
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
          logInfo('CONFIG', 'API key saved');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          logWarn('CONFIG', `API key invalid (${testRes.statusCode})`);
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

// ─── History API Endpoints ──────────────────────────────────

function handleHistoryTimeline(req, res, query) {
  const from = query.from;
  const to = query.to;
  if (!from || !to) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing from/to parameters' }));
    return;
  }

  let icaoFilter = null;
  if (query.icao && query.icao !== 'all') {
    icaoFilter = query.icao.split(',').map(s => s.trim().toUpperCase());
  }

  // METAR timeline — use report_time (observation time)
  const metarResult = {};
  let metarRows;
  if (icaoFilter) {
    const placeholders = icaoFilter.map(() => '?').join(',');
    metarRows = db.prepare(`
      SELECT icao_id, COALESCE(report_time, fetch_time) AS obs_time, flt_cat FROM metar_history
      WHERE icao_id IN (${placeholders}) AND fetch_time >= ? AND fetch_time <= ?
      ORDER BY icao_id, obs_time
    `).all(...icaoFilter, from, to);
  } else {
    metarRows = db.prepare(`
      SELECT icao_id, COALESCE(report_time, fetch_time) AS obs_time, flt_cat FROM metar_history
      WHERE fetch_time >= ? AND fetch_time <= ?
      ORDER BY icao_id, obs_time
    `).all(from, to);
  }
  for (const row of metarRows) {
    if (!metarResult[row.icao_id]) metarResult[row.icao_id] = [];
    metarResult[row.icao_id].push({ t: row.obs_time, cat: row.flt_cat });
  }

  // TAF timeline
  const tafResult = {};
  let tafRows;
  if (icaoFilter) {
    const placeholders = icaoFilter.map(() => '?').join(',');
    tafRows = db.prepare(`
      SELECT icao_id, fetch_time, flt_cat_now, flt_cat_2h, flt_cat_4h, flt_cat_8h, flt_cat_24h FROM taf_history
      WHERE icao_id IN (${placeholders}) AND fetch_time >= ? AND fetch_time <= ?
      ORDER BY icao_id, fetch_time
    `).all(...icaoFilter, from, to);
  } else {
    tafRows = db.prepare(`
      SELECT icao_id, fetch_time, flt_cat_now, flt_cat_2h, flt_cat_4h, flt_cat_8h, flt_cat_24h FROM taf_history
      WHERE fetch_time >= ? AND fetch_time <= ?
      ORDER BY icao_id, fetch_time
    `).all(from, to);
  }
  for (const row of tafRows) {
    if (!tafResult[row.icao_id]) tafResult[row.icao_id] = [];
    tafResult[row.icao_id].push({
      t: row.fetch_time,
      cat_now: row.flt_cat_now, cat_2h: row.flt_cat_2h,
      cat_4h: row.flt_cat_4h, cat_8h: row.flt_cat_8h, cat_24h: row.flt_cat_24h,
    });
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ metar: metarResult, taf: tafResult }));
}

function handleHistoryDetail(req, res, query) {
  const icao = (query.icao || '').toUpperCase();
  const time = query.time;
  if (!icao || !time) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing icao/time parameters' }));
    return;
  }

  const metar = db.prepare(`
    SELECT * FROM metar_history WHERE icao_id = ?
    ORDER BY ABS(julianday(fetch_time) - julianday(?)) LIMIT 1
  `).get(icao, time);

  const taf = db.prepare(`
    SELECT * FROM taf_history WHERE icao_id = ?
    ORDER BY ABS(julianday(fetch_time) - julianday(?)) LIMIT 1
  `).get(icao, time);

  const result = {};
  if (metar) {
    result.metar = { ...metar };
    try { result.metar.metar_json = JSON.parse(metar.metar_json); } catch (e) {}
  }
  if (taf) {
    result.taf = { ...taf };
    try { result.taf.taf_json = JSON.parse(taf.taf_json); } catch (e) {}
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(result));
}

function handleHistoryWeather(req, res, query) {
  const from = query.from;
  const to = query.to;
  if (!from || !to) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing from/to parameters' }));
    return;
  }

  let icaoFilter = null;
  if (query.icao && query.icao !== 'all') {
    icaoFilter = query.icao.split(',').map(s => s.trim().toUpperCase());
  }

  // METAR weather data — use report_time (observation time)
  const metarResult = {};
  let metarRows;
  if (icaoFilter) {
    const placeholders = icaoFilter.map(() => '?').join(',');
    metarRows = db.prepare(`
      SELECT icao_id, COALESCE(report_time, fetch_time) AS obs_time, wdir, wspd, wgst, ceiling, cloud_base
      FROM metar_history
      WHERE icao_id IN (${placeholders}) AND fetch_time >= ? AND fetch_time <= ?
      ORDER BY icao_id, obs_time
    `).all(...icaoFilter, from, to);
  } else {
    metarRows = db.prepare(`
      SELECT icao_id, COALESCE(report_time, fetch_time) AS obs_time, wdir, wspd, wgst, ceiling, cloud_base
      FROM metar_history
      WHERE fetch_time >= ? AND fetch_time <= ?
      ORDER BY icao_id, obs_time
    `).all(from, to);
  }
  for (const row of metarRows) {
    if (!metarResult[row.icao_id]) metarResult[row.icao_id] = [];
    metarResult[row.icao_id].push({
      t: row.obs_time, wspd: row.wspd, wgst: row.wgst, wdir: row.wdir, ceil: row.ceiling, cbase: row.cloud_base
    });
  }

  // TAF weather data — expand each TAF into hourly samples across its validity.
  // Each TAF is authoritative from its fetch_time until the next TAF's fetch_time.
  const tafResult = {};
  let tafRows;
  if (icaoFilter) {
    const placeholders = icaoFilter.map(() => '?').join(',');
    tafRows = db.prepare(`
      SELECT icao_id, fetch_time, taf_json
      FROM taf_history
      WHERE icao_id IN (${placeholders}) AND fetch_time >= ? AND fetch_time <= ?
      ORDER BY icao_id, fetch_time
    `).all(...icaoFilter, from, to);
  } else {
    tafRows = db.prepare(`
      SELECT icao_id, fetch_time, taf_json
      FROM taf_history
      WHERE fetch_time >= ? AND fetch_time <= ?
      ORDER BY icao_id, fetch_time
    `).all(from, to);
  }
  // Group TAF rows by ICAO
  const tafByIcao = {};
  for (const row of tafRows) {
    if (!row.taf_json) continue;
    if (!tafByIcao[row.icao_id]) tafByIcao[row.icao_id] = [];
    tafByIcao[row.icao_id].push(row);
  }
  const fromSec = Math.floor(new Date(from).getTime() / 1000);
  const toSec = Math.floor(new Date(to).getTime() / 1000);
  for (const [icao, rows] of Object.entries(tafByIcao)) {
    tafResult[icao] = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        const taf = JSON.parse(rows[i].taf_json);
        if (!taf.validTimeFrom || !taf.validTimeTo) continue;
        const fetchSec = Math.floor(new Date(rows[i].fetch_time).getTime() / 1000);
        // This TAF is authoritative from fetch_time until the next TAF's fetch_time
        const nextFetchSec = i < rows.length - 1
          ? Math.floor(new Date(rows[i + 1].fetch_time).getTime() / 1000)
          : toSec;
        const sampleFrom = Math.max(taf.validTimeFrom, fetchSec, fromSec);
        const sampleTo = Math.min(taf.validTimeTo, nextFetchSec, toSec);
        for (let t = sampleFrom; t <= sampleTo; t += 3600) {
          const weather = getForecastWeatherFromTaf(taf, t);
          tafResult[icao].push({
            t: new Date(t * 1000).toISOString(),
            wspd: weather?.wspd ?? null, wgst: weather?.wgst ?? null,
            wdir: weather?.wdir ?? null, ceil: weather?.ceiling ?? null
          });
        }
      } catch (e) { /* skip unparseable TAF JSON */ }
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ metar: metarResult, taf: tafResult }));
}

function handleHistoryAirports(req, res) {
  const rows = db.prepare(`
    SELECT t.icao_id, t.name, t.lat, t.lon,
      (SELECT COUNT(*) FROM metar_history m WHERE m.icao_id = t.icao_id) as metar_count,
      (SELECT COUNT(*) FROM taf_history f WHERE f.icao_id = t.icao_id) as taf_count
    FROM tracked_airports t
    ORDER BY t.name
  `).all();

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ airports: rows }));
}

function handleHistoryStats(req, res) {
  const totalMetar = db.prepare('SELECT COUNT(*) as c FROM metar_history').get().c;
  const totalTaf = db.prepare('SELECT COUNT(*) as c FROM taf_history').get().c;
  const oldest = db.prepare('SELECT MIN(fetch_time) as t FROM metar_history').get().t;
  const newest = db.prepare('SELECT MAX(fetch_time) as t FROM metar_history').get().t;
  const airportCount = db.prepare('SELECT COUNT(*) as c FROM tracked_airports').get().c;

  let dbSizeBytes = 0;
  try { dbSizeBytes = fs.statSync(HISTORY_DB_PATH).size; } catch (e) {}

  const nextFetchIn = nextHistoryFetchTime ? Math.max(0, Math.round((nextHistoryFetchTime - Date.now()) / 1000)) : null;

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    total_metar: totalMetar, total_taf: totalTaf,
    oldest, newest, airport_count: airportCount,
    db_size_bytes: dbSizeBytes,
    next_fetch_in_seconds: nextFetchIn,
  }));
}

// ─── Log API Endpoint ───────────────────────────────────────

function handleLogApi(req, res, query) {
  const n = Math.min(parseInt(query.n) || LOG_MAX_ENTRIES, LOG_MAX_ENTRIES);
  const level = query.level || null;
  const category = query.category || null;
  const entries = readLog(n, level, category);

  // Also include log file stats
  let fileSize = 0;
  try { fileSize = fs.statSync(LOG_FILE).size; } catch (e) {}

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({
    entries: entries,
    total: entries.length,
    file_size_bytes: fileSize,
    log_file: LOG_FILE,
  }));
}

// ─── HTTP Server ────────────────────────────────────────────

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
  } else if (parsed.pathname === '/api/history/timeline') {
    handleHistoryTimeline(req, res, query);
  } else if (parsed.pathname === '/api/history/detail') {
    handleHistoryDetail(req, res, query);
  } else if (parsed.pathname === '/api/history/weather') {
    handleHistoryWeather(req, res, query);
  } else if (parsed.pathname === '/api/history/airports') {
    handleHistoryAirports(req, res);
  } else if (parsed.pathname === '/api/history/stats') {
    handleHistoryStats(req, res);
  } else if (parsed.pathname === '/api/log') {
    handleLogApi(req, res, query);
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
    serveStatic(req, res, parsed.pathname);
  }
});

// Load cache from disk before starting server
loadCacheFromDisk();

server.listen(PORT, async () => {
  console.log(`\n  Austria Airport VFR Status Map`);
  console.log(`  ==============================`);
  console.log(`  Server running at:  http://localhost:${PORT}`);
  console.log(`  Weather history:    http://localhost:${PORT}/history.html`);
  console.log(`  Server log:         http://localhost:${PORT}/log.html`);
  console.log(`  Verbose mode:       ${VERBOSE ? 'ON' : 'OFF (use --verbose or -v)'}`);
  console.log(`\n  Press Ctrl+C to stop.\n`);

  logInfo('SYSTEM', 'Server started', `http://localhost:${PORT}`);
  rotateLogIfNeeded();

  // Bootstrap airport list and perform initial history fetch
  try {
    const icaos = getTrackedIcaoCodes();
    if (icaos.length === 0) {
      logInfo('HISTORY', 'No tracked airports, fetching airport list...');
      await refreshAirportList();
    }
    logInfo('HISTORY', `Tracked airports: ${getTrackedIcaoCodes().length}`);

    // Skip initial fetch if last fetch was less than 30 minutes ago
    const lastFetchRow = db.prepare('SELECT MAX(fetch_time) AS last FROM metar_history').get();
    const lastFetchAge = lastFetchRow?.last ? Date.now() - new Date(lastFetchRow.last).getTime() : Infinity;
    const SKIP_THRESHOLD = 30 * 60 * 1000; // 30 minutes
    if (lastFetchAge < SKIP_THRESHOLD) {
      logInfo('HISTORY', `Skipping initial fetch (last fetch ${Math.round(lastFetchAge / 60000)}min ago)`);
    } else {
      logInfo('HISTORY', 'Performing initial weather fetch...');
      const result = await performHistoryFetch();
      if (result) {
        logInfo('SCHEDULER', `Initial fetch complete: ${result.metarCount} METARs, ${result.tafCount} TAFs stored`);
      }
    }
  } catch (err) {
    logError('HISTORY', 'Initial fetch failed', err.message);
  }

  // Schedule recurring fetches
  scheduleHistoryFetch();

  // Only purge old data when explicitly requested via --purge flag
  if (PURGE_ON_START) {
    logInfo('SYSTEM', `Purging data older than ${PURGE_OLDER_THAN_DAYS} days (--purge flag)`);
    purgeOldData(PURGE_OLDER_THAN_DAYS);
  }
});

// Save cache and close DB on graceful shutdown
function shutdown() {
  logInfo('SYSTEM', 'Server shutting down');
  saveCacheToDisk();
  try { db.close(); } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
