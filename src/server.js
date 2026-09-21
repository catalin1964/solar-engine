/**
 * API HTTP peste motorul de calcul.
 *
 * Doua rute:
 *   GET  /api/tenant/:id  - brand si tarife implicite pentru widget
 *   POST /api/size        - dimensionare completa
 *
 * Modul MOCK (USE_MOCK=1) foloseste generatorul sintetic in loc de PVGIS.
 * Serveste doar la dezvoltare offline; niciodata in productie.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchPvgisMultiYear, pickReferenceYear, shiftToLocal,
         compassToPvgisAspect, ORIENTATIONS, TILT_PRESETS } from './pvgis.js';
import { mockMultiYear } from './mockWeather.js';
import { buildLoadProfile, annualKwhFromBill, ARCHETYPES } from './loadProfile.js';
import { solveSize } from './sizing.js';
import { getTenant, tenantPublic } from './tenants.js';
import { valideazaLead, preiaLead, RETENTIE_ZILE } from './lead.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Acceptam si argument, nu doar variabila de mediu: pe Windows npm ruleaza
// scripturile prin cmd.exe, unde "USE_MOCK=1 node ..." nu functioneaza.
const USE_MOCK = process.env.USE_MOCK === '1' || process.argv.includes('--mock');

export const app = express();
app.use(express.json({ limit: '32kb' }));
app.set('trust proxy', 2);           // Railway sta in spatele a doua proxy-uri

/* ------------------------------------------------------------------ */
/* Limitare de rata: fereastra glisanta, in memorie                     */
/* Pentru mai multe instante muta contorul in Postgres sau Redis.       */
/* ------------------------------------------------------------------ */
const hits = new Map();
const LIMITA = 20, FEREASTRA = 60 * 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip ?? 'necunoscut';
  const acum = Date.now();
  const lista = (hits.get(ip) ?? []).filter(t => acum - t < FEREASTRA);
  if (lista.length >= LIMITA) {
    return res.status(429).json({
      eroare: 'Prea multe calcule din aceeasi retea. Incearca peste o ora.',
    });
  }
  lista.push(acum);
  hits.set(ip, lista);
  next();
}

setInterval(() => {
  const acum = Date.now();
  for (const [ip, l] of hits) {
    const f = l.filter(t => acum - t < FEREASTRA);
    f.length ? hits.set(ip, f) : hits.delete(ip);
  }
}, FEREASTRA).unref();

/* ------------------------------------------------------------------ */
/* Validare                                                            */
/* ------------------------------------------------------------------ */
const TOPOLOGII = ['ongrid', 'hybrid', 'offgrid'];

function valideaza(b) {
  const e = [];
  const num = (v, min, max, nume) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { e.push(`${nume} lipseste sau nu e numar`); return false; }
    if (v < min || v > max) { e.push(`${nume} in afara intervalului ${min}-${max}`); return false; }
    return true;
  };

  num(b.lat, -60, 70, 'Latitudinea');
  num(b.lon, -180, 180, 'Longitudinea');

  if (!(b.orientation in ORIENTATIONS)) e.push('Orientare necunoscuta');
  if (!(b.tiltPreset in TILT_PRESETS)) e.push('Inclinatie necunoscuta');
  if (!TOPOLOGII.includes(b.topology)) e.push('Tip de sistem necunoscut');
  if (!(b.archetype in ARCHETYPES)) e.push('Tip de cladire necunoscut');

  const areAnual = typeof b.annualKwh === 'number';
  const areFactura = typeof b.monthlyBill === 'number';
  if (!areAnual && !areFactura) e.push('Lipseste consumul anual sau factura lunara');
  if (areAnual) num(b.annualKwh, 300, 500000, 'Consumul anual');
  if (areFactura) num(b.monthlyBill, 20, 200000, 'Factura lunara');

  if (b.heatPumpKwh != null) num(b.heatPumpKwh, 0, 100000, 'Consumul pompei de caldura');
  if (b.evKwh != null) num(b.evKwh, 0, 50000, 'Consumul masinii electrice');
  if (b.maxKwp != null) num(b.maxKwp, 1, 200, 'Puterea maxima');

  return e;
}

/* ------------------------------------------------------------------ */
/* Rute                                                               */
/* ------------------------------------------------------------------ */

app.get('/api/tenant/:id', (req, res) => {
  res.json(tenantPublic(getTenant(req.params.id)));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mock: USE_MOCK });
});

app.post('/api/size', rateLimit, async (req, res) => {
  const b = req.body ?? {};
  const erori = valideaza(b);
  if (erori.length) return res.status(400).json({ eroare: erori[0], erori });

  const t = getTenant(b.tenantId);

  try {
    const aspect = compassToPvgisAspect(ORIENTATIONS[b.orientation]);
    const tilt = TILT_PRESETS[b.tiltPreset];
    const params = { lat: b.lat, lon: b.lon, tilt, aspect, systemLoss: 14 };

    const { years, source } = USE_MOCK
      ? mockMultiYear(params, 2013, 2019)
      : await fetchPvgisMultiYear({ ...params, startYear: 2013, endYear: 2019 });

    // On-grid: economia tipica, deci anul median. Hibrid si off-grid:
    // anul cu iarna cea mai slaba, pentru ca acolo cedeaza sistemul.
    const mod = b.topology === 'ongrid' ? 'median' : 'worstWinter';
    const an = pickReferenceYear(years, mod);

    const utcOffset = b.utcOffset ?? 2;
    const P = shiftToLocal(years[an].P, utcOffset);
    const T = shiftToLocal(years[an].T2m, utcOffset);

    const gridPrice = b.gridPrice ?? t.tarife.gridPrice;
    const exportPrice = b.exportPrice ?? t.tarife.exportPrice;
    const anual = b.annualKwh ?? annualKwhFromBill({ monthlyBill: b.monthlyBill, pricePerKwh: gridPrice });

    const profil = buildLoadProfile({
      annualKwh: anual,
      archetype: b.archetype,
      temperatures: T,
      heatPump: b.heatPumpKwh ? { annualKwh: b.heatPumpKwh } : null,
      ev: b.evKwh ? { annualKwh: b.evKwh, window: b.evWindow ?? 'night' } : null,
    });

    const objective = b.topology === 'offgrid'
      ? { type: 'lolp', target: 0.01 }
      : b.topology === 'hybrid'
        ? { type: 'selfSufficiency', target: b.target ?? 0.70 }
        : { type: 'payback' };

    const rezultat = solveSize({
      pvPerKwp: P,
      load: profil.total,
      topology: b.topology,
      objective,
      constraints: {
        maxKwp: b.maxKwp ?? (b.topology === 'ongrid' ? 15 : 30),
        maxBatteryKwh: b.topology === 'ongrid' ? 0 : 60,
        maxProductionRatio: t.maxProductionRatio ?? 1.2,
        maxPaybackYears: t.maxPaybackYears ?? 15,
      },
      gridPrice, exportPrice,
      catalog: t.catalog,
      referenceYear: an,
    });

    res.json({
      ...rezultat,
      consum: {
        anual: Math.round(profil.annualTotal),
        baza: Math.round(profil.base.reduce((a, c) => a + c, 0)),
        pompaCaldura: Math.round(profil.heatPump.reduce((a, c) => a + c, 0)),
        masinaElectrica: Math.round(profil.ev.reduce((a, c) => a + c, 0)),
      },
      surse: { meteo: source, anReferinta: an, modAn: mod },
      tenant: tenantPublic(t),
    });
  } catch (err) {
    console.error('Eroare la dimensionare:', err.message);
    res.status(502).json({
      eroare: 'Calculul nu a putut fi finalizat. Datele meteo nu sunt disponibile momentan.',
      detaliu: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

/* Limitare separata, mai stransa, pentru lead-uri: formularul e o tinta
 * evidenta de spam, iar fiecare cerere ajunge in inboxul instalatorului. */
const hitsLead = new Map();
function rateLimitLead(req, res, next) {
  const ip = req.ip ?? 'necunoscut';
  const acum = Date.now();
  const lista = (hitsLead.get(ip) ?? []).filter(t => acum - t < FEREASTRA);
  if (lista.length >= 5) {
    return res.status(429).json({ eroare: 'Ai trimis deja o cerere. Te contactam in scurt timp.' });
  }
  lista.push(acum);
  hitsLead.set(ip, lista);
  next();
}

app.post('/api/lead', rateLimitLead, async (req, res) => {
  const b = req.body ?? {};
  const erori = valideazaLead(b);
  if (erori.length) return res.status(400).json({ eroare: erori[0], erori });

  const t = getTenant(b.tenantId);
  try {
    const r = await preiaLead({ tenant: t, corp: b, rezumat: b.rezumat ?? null, dryRun: USE_MOCK });
    if (!r.primit) {
      // Nu pretindem ca a ajuns cand nu a ajuns nicaieri.
      return res.status(502).json({
        eroare: `Cererea nu a putut fi transmisa. Suna direct la ${t.telefon}.`,
      });
    }
    res.json({ ok: true, retentieZile: r.retentieZile, telefon: t.telefon, email: t.email,
                simulat: r.dryRun && !r.db.salvat && !r.email.trimis && !r.webhook.trimis });
  } catch (err) {
    console.error('Eroare la preluarea lead-ului:', err.message);
    res.status(500).json({ eroare: `Cererea nu a putut fi transmisa. Suna direct la ${t.telefon}.` });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server pornit pe :${port}${USE_MOCK ? '  [MOCK - date sintetice]' : ''}`);
  });
}
