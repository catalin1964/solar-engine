/**
 * Client PVGIS (JRC, Comisia Europeana) + cache.
 *
 * Serviciu public si gratuit. NU il lovi la fiecare cerere de utilizator:
 * cache obligatoriu pe grila de 0.1 grade (~11 km). Datele sunt istorice,
 * deci practic statice -> TTL foarte lung.
 *
 * ATENTIE la doua capcane, ambele produc rezultate gresite in tacere:
 *   1. Azimut: PVGIS foloseste 0 = SUD, +90 = VEST, -90 = EST.
 *      Nu e conventia busolei. Vezi compassToPvgisAspect().
 *   2. Timp: PVGIS returneaza UTC. Profilul de consum e in ora locala.
 *      Daca nu decalezi, varful PV si varful de consum de seara sunt
 *      nealiniate si autoconsumul iese fals. Vezi shiftToLocal().
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// PVGIS 6 a introdus un API nou. Verifica documentatia curenta inainte de
// productie: https://joint-research-centre.ec.europa.eu/pvgis...
// Endpoint-ul de mai jos este cel folosit si de biblioteca pvlib.
const PVGIS_BASE = 'https://re.jrc.ec.europa.eu/api/v5_2';

const CACHE_DIR = process.env.PVGIS_CACHE_DIR || '.cache';
const GRID_DEG = 0.1; // ~11 km

/**
 * PVGIS v5.2: baza de date de radiatie acopera doar 2005-2020.
 * Ironia: ultimul an disponibil, 2020, e bisect - adica exact anul cu cele
 * mai recente date e si cel care sparge motorul (8784 ore in loc de 8760).
 * Ultimul an nebisect disponibil este 2019.
 *
 * PVGIS 6 merge pana in 2024, dar are alt API. Vezi nota din README.
 */
export const YEAR_RANGE = { min: 2005, max: 2020 };
export const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/* ------------------------------------------------------------------ */
/* Conversii                                                           */
/* ------------------------------------------------------------------ */

/**
 * Directie busola (0=N, 90=E, 180=S, 270=V) -> azimut PVGIS (0=S, 90=V, -90=E).
 */
export function compassToPvgisAspect(compassDeg) {
  let a = ((compassDeg - 180) % 360 + 540) % 360 - 180; // -> [-180, 180)
  return a;
}

export const ORIENTATIONS = {
  N: 0, NE: 45, E: 90, SE: 135, S: 180, SV: 225, V: 270, NV: 315,
};

export const TILT_PRESETS = { mica: 15, medie: 30, mare: 45 };

function gridKey(lat, lon, tilt, aspect, year) {
  const rl = (Math.round(lat / GRID_DEG) * GRID_DEG).toFixed(1);
  const rg = (Math.round(lon / GRID_DEG) * GRID_DEG).toFixed(1);
  return `${rl}|${rg}|${tilt}|${aspect}|${year}`;
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

let pgPool = null;
async function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (pgPool) return pgPool;
  const { default: pg } = await import('pg');
  pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS pvgis_cache (
      cache_key TEXT PRIMARY KEY,
      payload   JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  return pgPool;
}

async function cacheGet(key) {
  const pool = await getPool();
  if (pool) {
    const r = await pool.query('SELECT payload FROM pvgis_cache WHERE cache_key = $1', [key]);
    return r.rows[0]?.payload ?? null;
  }
  try {
    const f = path.join(CACHE_DIR, encodeURIComponent(key) + '.json');
    return JSON.parse(await fs.readFile(f, 'utf8'));
  } catch { return null; }
}

async function cacheSet(key, payload) {
  const pool = await getPool();
  if (pool) {
    await pool.query(
      `INSERT INTO pvgis_cache (cache_key, payload) VALUES ($1, $2)
       ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload`,
      [key, payload]
    );
    return;
  }
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, encodeURIComponent(key) + '.json'),
    JSON.stringify(payload));
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

/**
 * Elimina 29 februarie dintr-o serie de an bisect (8784 -> 8760).
 *
 * Restul motorului lucreaza pe 8760 fix: profilul de consum, harta lunilor
 * si simularea. Un an bisect cerut din greseala arunca eroare la simulare,
 * departe de cauza reala. Taiem aici, la sursa.
 *
 * Ian = 744 ore (0..743), Feb 1-28 = 672 ore (744..1415),
 * deci 29 februarie ocupa orele 1416..1439.
 */
export function normalizeToNonLeap(series) {
  if (series.length === 8760) return series;
  if (series.length === 8784) return series.slice(0, 1416).concat(series.slice(1440));
  throw new Error(`Lungime de serie neasteptata: ${series.length} (astept 8760 sau 8784)`);
}

/**
 * Aduce o serie orara PVGIS pentru 1 kWp instalat.
 * Scalarea la kWp-ul real se face liniar mai tarziu -> un singur apel
 * per locatie/orientare, indiferent cate dimensiuni testeaza rezolvitorul.
 *
 * @returns {{ P: number[], G: number[], T2m: number[], WS10m: number[],
 *             timestamps: string[], source: string }}
 */
export async function fetchPvgisHourly({
  lat, lon,
  tilt = 30,
  aspect = 0,          // conventie PVGIS: 0 = sud
  year = 2019,         // ultimul an NEBISECT disponibil in PVGIS v5.2
  systemLoss = 14,     // %
}) {
  if (!Number.isInteger(year) || year < YEAR_RANGE.min || year > YEAR_RANGE.max) {
    throw new Error(
      `An ${year} in afara intervalului PVGIS v5.2 (${YEAR_RANGE.min}-${YEAR_RANGE.max}). ` +
      `Ultimul an nebisect disponibil: 2019.`
    );
  }
  const key = gridKey(lat, lon, tilt, aspect, year);
  const cached = await cacheGet(key);
  if (cached) {
    // Intrari salvate inainte de reparatia anului bisect pot avea 8784 ore.
    return {
      timestamps: normalizeToNonLeap(cached.timestamps),
      P: normalizeToNonLeap(cached.P),
      G: normalizeToNonLeap(cached.G),
      T2m: normalizeToNonLeap(cached.T2m),
      WS10m: normalizeToNonLeap(cached.WS10m),
      source: 'cache',
    };
  }

  const qs = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    startyear: String(year),
    endyear: String(year),
    pvcalculation: '1',
    peakpower: '1',            // 1 kWp -> scalare liniara ulterioara
    loss: String(systemLoss),
    angle: String(tilt),
    aspect: String(aspect),
    outputformat: 'json',
    browser: '0',
  });

  const url = `${PVGIS_BASE}/seriescalc?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`PVGIS ${res.status}: ${await res.text()}`);
  const json = await res.json();

  const hourly = json?.outputs?.hourly;
  if (!Array.isArray(hourly) || hourly.length < 8000) {
    throw new Error('Raspuns PVGIS neasteptat sau incomplet');
  }

  // Al doilea strat de aparare: chiar daca cineva cere explicit un an
  // bisect, taiem 29 februarie aici si nu se sparge nimic mai jos.
  const out = {
    timestamps: normalizeToNonLeap(hourly.map(h => h.time)),
    P:     normalizeToNonLeap(hourly.map(h => h.P ?? 0)),          // W, pentru 1 kWp
    G:     normalizeToNonLeap(hourly.map(h => h['G(i)'] ?? 0)),    // W/m2 in planul modulului
    T2m:   normalizeToNonLeap(hourly.map(h => h.T2m ?? 0)),        // grade C
    WS10m: normalizeToNonLeap(hourly.map(h => h.WS10m ?? 0)),      // m/s la 10 m
  };
  await cacheSet(key, out);
  return { ...out, source: 'pvgis' };
}

/**
 * PVGIS livreaza in UTC. Decaleaza seriile in ora locala.
 * Rotire circulara: pentru un an intreg eroarea de capat e neglijabila.
 */
export function shiftToLocal(series, utcOffsetHours) {
  const n = series.length;
  const k = ((Math.round(utcOffsetHours) % n) + n) % n;
  return series.slice(n - k).concat(series.slice(0, n - k));
}

/**
 * Aduce mai multi ani intr-un SINGUR apel si ii imparte pe ani.
 *
 * De ce conteaza: un an calendaristic nu e reprezentativ. Masurat real
 * la Bucuresti, 2019 da 1304 kWh/kWp iar 2020 da 1343 - 3% doar intre
 * doi ani vecini. Pe on-grid e neglijabil. Pe off-grid, daca dimensionezi
 * pe anul bun, sistemul cade in anul prost.
 *
 * Impartirea se face dupa anul din marca de timp ("20190101:0010"), nu
 * prin taiere din 8760 in 8760 - altfel anii bisecti din interval
 * decaleaza tot ce urmeaza.
 */
export async function fetchPvgisMultiYear({
  lat, lon, tilt = 30, aspect = 0,
  startYear = 2013, endYear = 2019,
  systemLoss = 14,
}) {
  for (const y of [startYear, endYear]) {
    if (!Number.isInteger(y) || y < YEAR_RANGE.min || y > YEAR_RANGE.max) {
      throw new Error(`An ${y} in afara intervalului PVGIS v5.2 (${YEAR_RANGE.min}-${YEAR_RANGE.max})`);
    }
  }
  if (endYear < startYear) throw new Error('endYear inainte de startYear');

  const key = gridKey(lat, lon, tilt, aspect, `${startYear}-${endYear}`);
  const cached = await cacheGet(key);
  if (cached) return { years: cached.years, source: 'cache' };

  const qs = new URLSearchParams({
    lat: String(lat), lon: String(lon),
    startyear: String(startYear), endyear: String(endYear),
    pvcalculation: '1', peakpower: '1', loss: String(systemLoss),
    angle: String(tilt), aspect: String(aspect),
    outputformat: 'json', browser: '0',
  });

  const res = await fetch(`${PVGIS_BASE}/seriescalc?${qs}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`PVGIS ${res.status}: ${await res.text()}`);
  const hourly = (await res.json())?.outputs?.hourly;
  if (!Array.isArray(hourly)) throw new Error('Raspuns PVGIS neasteptat');

  // Grupare pe an dupa marca de timp
  const buckets = new Map();
  for (const h of hourly) {
    const y = Number(String(h.time).slice(0, 4));
    if (!buckets.has(y)) buckets.set(y, []);
    buckets.get(y).push(h);
  }

  const years = {};
  for (const [y, rows] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (rows.length < 8000) continue;              // an incomplet, ignorat
    years[y] = {
      P:     normalizeToNonLeap(rows.map(r => r.P ?? 0)),
      T2m:   normalizeToNonLeap(rows.map(r => r.T2m ?? 0)),
      WS10m: normalizeToNonLeap(rows.map(r => r.WS10m ?? 0)),
    };
  }
  if (Object.keys(years).length === 0) throw new Error('Niciun an complet in raspuns');

  await cacheSet(key, { years });
  return { years, source: 'pvgis' };
}

/**
 * Alege anul de referinta din setul multi-an.
 *
 *   'worstWinter' - productia minima noiembrie-februarie. Constrangerea
 *                   reala pentru off-grid si hibrid; acolo cedeaza sistemele.
 *   'worstAnnual' - productia anuala minima.
 *   'median'      - anul median ca productie anuala. Pentru on-grid, unde
 *                   te intereseaza economia tipica, nu scenariul negru.
 */
export function pickReferenceYear(years, mode = 'worstWinter') {
  const IARNA = [...Array(1416).keys()]                    // ian + feb
    .concat([...Array(8760 - 7296).keys()].map(i => i + 7296)); // noi + dec

  const scor = Object.entries(years).map(([y, d]) => {
    const anual = d.P.reduce((a, b) => a + b, 0);
    const iarna = IARNA.reduce((s, i) => s + d.P[i], 0);
    return { year: Number(y), anual, iarna };
  });

  if (mode === 'median') {
    const s = [...scor].sort((a, b) => a.anual - b.anual);
    return s[Math.floor(s.length / 2)].year;
  }
  const cheie = mode === 'worstAnnual' ? 'anual' : 'iarna';
  return scor.reduce((min, c) => (c[cheie] < min[cheie] ? c : min)).year;
}
