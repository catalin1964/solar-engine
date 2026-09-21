/**
 * Orchestrare: input utilizator -> meteo -> profil consum -> simulare.
 *
 * Sursa meteo e injectabila: PVGIS in productie, generatorul sintetic
 * doar pentru teste offline.
 */

import { fetchPvgisHourly, shiftToLocal, compassToPvgisAspect, ORIENTATIONS, TILT_PRESETS } from './pvgis.js';
import { mockPvgisHourly } from './mockWeather.js';
import { buildLoadProfile, annualKwhFromBill } from './loadProfile.js';
import { simulate, scalePv } from './simulate.js';

export async function runScenario({
  // locatie
  lat, lon,
  orientation = 'S',            // cheie din ORIENTATIONS sau grade busola
  tiltPreset = 'medie',
  utcOffset = 2,

  // consum
  annualKwh = null,
  monthlyBill = null,
  gridPrice = 1.0,
  exportPrice = 0.0,
  archetype = 'casa_goala_zi',
  heatPump = null,
  ev = null,

  // sistem
  kwp = 5,
  topology = 'hybrid',
  battery = null,

  // sursa meteo
  useMock = false,
  systemLoss = 14,
}) {
  const compass = typeof orientation === 'number' ? orientation : ORIENTATIONS[orientation];
  if (compass === undefined) throw new Error(`Orientare necunoscuta: ${orientation}`);
  const aspect = compassToPvgisAspect(compass);
  const tilt = TILT_PRESETS[tiltPreset] ?? Number(tiltPreset);

  const weather = useMock
    ? mockPvgisHourly({ lat, lon, tilt, aspect, systemLoss })
    : await fetchPvgisHourly({ lat, lon, tilt, aspect, systemLoss });

  // PVGIS livreaza UTC -> aliniaza la ora locala inainte de orice
  const P    = shiftToLocal(weather.P, utcOffset);
  const T2m  = shiftToLocal(weather.T2m, utcOffset);

  const annual = annualKwh ?? annualKwhFromBill({ monthlyBill, pricePerKwh: gridPrice });

  const load = buildLoadProfile({
    annualKwh: annual,
    archetype,
    temperatures: T2m,
    heatPump,
    ev,
  });

  const pvKwh = scalePv(P, kwp);
  const result = simulate(pvKwh, load.total, { topology, battery, gridPrice, exportPrice });

  return {
    inputs: { lat, lon, orientation, compass, aspect, tilt, kwp, topology, utcOffset },
    weatherSource: weather.source,
    specificYield: result.totals.pvKwh / kwp,   // kWh/kWp/an - metrica de validare
    load: {
      annualTotal: load.annualTotal,
      baseKwh: load.base.reduce((a, b) => a + b, 0),
      heatPumpKwh: load.heatPump.reduce((a, b) => a + b, 0),
      evKwh: load.ev.reduce((a, b) => a + b, 0),
    },
    ...result,
  };
}

export { ORIENTATIONS, TILT_PRESETS, buildLoadProfile, simulate, scalePv };
