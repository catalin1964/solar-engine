/**
 * Simulare orara pe 8760 de ore, cu stare de incarcare a bateriei.
 *
 * Topologii:
 *   ongrid  - fara baterie, surplusul pleaca in retea
 *   hybrid  - baterie + retea ca rezerva
 *   offgrid - baterie, fara retea; surplusul neutilizabil se pierde,
 *             deficitul neacoperit se numara ca ore de pana
 *
 * Regula de onestitate (vezi specificatia, sectiunea 3.3): rezultatele
 * lunare se raporteaza INTOTDEAUNA separat. Media anuala ascunde
 * decembrie, si acolo mor sistemele off-grid.
 */

import { MONTH_OF_HOUR } from './loadProfile.js';

const H = 8760;

export const BATTERY_PRESETS = {
  lfp:  { dodMax: 0.80, roundTripEff: 0.92, label: 'LiFePO4' },
  plumb:{ dodMax: 0.50, roundTripEff: 0.80, label: 'Plumb-acid' },
};

/**
 * @param {number[]} pv     productie orara, kWh (deja scalata la kWp real, ora locala)
 * @param {number[]} load   consum orar, kWh (ora locala)
 * @param {object} opts
 */
export function simulate(pv, load, {
  topology = 'hybrid',
  battery = null,          // { nominalKwh, chemistry='lfp', pChargeKw, pDischargeKw }
  gridPrice = 1.0,         // moneda/kWh
  exportPrice = 0.0,       // moneda/kWh
} = {}) {
  if (pv.length !== H || load.length !== H) {
    throw new Error(`Seriile trebuie sa aiba ${H} valori (pv=${pv.length}, load=${load.length})`);
  }

  const hasBattery = topology !== 'ongrid' && battery && battery.nominalKwh > 0;
  let usable = 0, etaC = 1, etaD = 1, pCh = Infinity, pDis = Infinity;

  if (hasBattery) {
    const chem = BATTERY_PRESETS[battery.chemistry ?? 'lfp'];
    usable = battery.nominalKwh * chem.dodMax;
    const rt = Math.sqrt(chem.roundTripEff);
    etaC = rt; etaD = rt;
    pCh  = battery.pChargeKw    ?? battery.nominalKwh * 0.5;
    pDis = battery.pDischargeKw ?? battery.nominalKwh * 0.5;
  }

  let soc = usable * 0.5;

  const acc = {
    pv: 0, load: 0, direct: 0, toBattery: 0, fromBattery: 0,
    gridImport: 0, gridExport: 0, curtailed: 0, unserved: 0, unservedHours: 0,
  };
  const monthly = Array.from({ length: 12 }, () => ({
    pv: 0, load: 0, gridImport: 0, gridExport: 0, unserved: 0, unservedHours: 0,
  }));

  for (let h = 0; h < H; h++) {
    const p = pv[h], l = load[h];
    const direct = Math.min(p, l);
    let surplus = p - direct;
    let deficit = l - direct;

    let toBat = 0, fromBat = 0;
    if (hasBattery) {
      if (surplus > 0 && soc < usable) {
        const room = (usable - soc) / etaC;
        toBat = Math.min(surplus, pCh, room);
        soc += toBat * etaC;
      }
      if (deficit > 0 && soc > 0) {
        const avail = soc * etaD;
        fromBat = Math.min(deficit, pDis, avail);
        soc -= fromBat / etaD;
      }
    }

    const leftoverPv = surplus - toBat;
    const leftoverLoad = deficit - fromBat;

    let imp = 0, exp = 0, curt = 0, uns = 0;
    if (topology === 'offgrid') {
      curt = leftoverPv;
      uns = leftoverLoad;
    } else {
      exp = leftoverPv;
      imp = leftoverLoad;
    }

    const m = MONTH_OF_HOUR[h];
    acc.pv += p; acc.load += l; acc.direct += direct;
    acc.toBattery += toBat; acc.fromBattery += fromBat;
    acc.gridImport += imp; acc.gridExport += exp;
    acc.curtailed += curt; acc.unserved += uns;
    if (uns > 1e-6) { acc.unservedHours++; monthly[m].unservedHours++; }

    monthly[m].pv += p; monthly[m].load += l;
    monthly[m].gridImport += imp; monthly[m].gridExport += exp;
    monthly[m].unserved += uns;
  }

  const selfConsumption = acc.pv > 0 ? (acc.direct + acc.toBattery) / acc.pv : 0;
  const selfSufficiency = acc.load > 0 ? (acc.direct + acc.fromBattery) / acc.load : 0;

  // ATENTIE: la off-grid, energia neacoperita NU e energie economisita.
  // Fara corectia asta, un sistem subdimensionat care lasa clientul pe
  // intuneric jumatate din an raporteaza "economie" maxima. Economia se
  // calculeaza doar pe consumul chiar acoperit.
  const servedLoad = acc.load - acc.unserved;
  const baselineCost = servedLoad * gridPrice;
  const newCost = acc.gridImport * gridPrice - acc.gridExport * exportPrice;
  const annualSaving = baselineCost - newCost;

  // Luna cea mai proasta: pentru off-grid dupa ore de pana, altfel dupa
  // ponderea consumului acoperit din retea.
  let worstMonth = 0, worstScore = -Infinity;
  for (let m = 0; m < 12; m++) {
    const score = topology === 'offgrid'
      ? monthly[m].unservedHours
      : (monthly[m].load > 0 ? monthly[m].gridImport / monthly[m].load : 0);
    if (score > worstScore) { worstScore = score; worstMonth = m; }
  }

  return {
    topology,
    totals: {
      pvKwh: acc.pv,
      loadKwh: acc.load,
      directUseKwh: acc.direct,
      batteryInKwh: acc.toBattery,
      batteryOutKwh: acc.fromBattery,
      gridImportKwh: acc.gridImport,
      gridExportKwh: acc.gridExport,
      curtailedKwh: acc.curtailed,
      unservedKwh: acc.unserved,
      unservedHours: acc.unservedHours,
    },
    selfConsumption,
    selfSufficiency,
    lolp: acc.unservedHours / H,          // probabilitate de deficit
    annualSaving,
    monthly,
    worstMonth,                            // 0 = ianuarie
    december: monthly[11],
  };
}

/** Scaleaza seria PVGIS de 1 kWp (W) la kWp real, in kWh/ora. */
export function scalePv(seriesWattsPerKwp, kwp) {
  return seriesWattsPerKwp.map(w => (w * kwp) / 1000);
}
