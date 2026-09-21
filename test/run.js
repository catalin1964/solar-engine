import { runScenario } from '../src/index.js';

const LUNI = ['Ian','Feb','Mar','Apr','Mai','Iun','Iul','Aug','Sep','Oct','Noi','Dec'];
const r1 = n => n.toFixed(1);
const r0 = n => Math.round(n).toLocaleString('ro-RO');

function raport(titlu, r) {
  console.log(`\n${'='.repeat(66)}\n${titlu}`);
  console.log(`${'='.repeat(66)}`);
  console.log(`Sursa meteo        : ${r.weatherSource}`);
  console.log(`Sistem             : ${r.inputs.kwp} kWp, ${r.inputs.orientation}, ${r.inputs.tilt}deg, ${r.topology}`);
  console.log(`Productie specifica: ${r0(r.specificYield)} kWh/kWp/an   <-- verifica contra PVGIS`);
  console.log(`Productie totala   : ${r0(r.totals.pvKwh)} kWh/an`);
  console.log(`Consum total       : ${r0(r.totals.loadKwh)} kWh/an  ` +
              `(baza ${r0(r.load.baseKwh)}, PC ${r0(r.load.heatPumpKwh)}, EV ${r0(r.load.evKwh)})`);
  console.log(`Autoconsum         : ${r1(r.selfConsumption * 100)} %`);
  console.log(`Autosuficienta     : ${r1(r.selfSufficiency * 100)} %`);
  console.log(`Import din retea   : ${r0(r.totals.gridImportKwh)} kWh`);
  console.log(`Export in retea    : ${r0(r.totals.gridExportKwh)} kWh`);
  if (r.topology === 'offgrid') {
    console.log(`Energie pierduta   : ${r0(r.totals.curtailedKwh)} kWh`);
    console.log(`ORE DE PANA        : ${r.totals.unservedHours} h  (${r1(r.lolp * 100)} % din an)`);
    console.log(`Deficit neacoperit : ${r0(r.totals.unservedKwh)} kWh`);
  }
  console.log(`Economie anuala    : ${r0(r.annualSaving)} lei`);
  console.log(`Luna cea mai proasta: ${LUNI[r.worstMonth]}`);

  console.log(`\n  Luna | Productie | Consum |  Import | Pana(h)`);
  console.log(`  -----|-----------|--------|---------|--------`);
  r.monthly.forEach((m, i) => {
    console.log(`  ${LUNI[i].padEnd(4)} | ${r0(m.pv).padStart(9)} | ${r0(m.load).padStart(6)} | ` +
                `${r0(m.gridImport).padStart(7)} | ${String(m.unservedHours).padStart(7)}`);
  });
}

const BUCURESTI = { lat: 44.43, lon: 26.10, utcOffset: 2 };
const BRUXELLES = { lat: 50.85, lon: 4.35, utcOffset: 1 };

const casa = {
  archetype: 'casa_goala_zi',
  annualKwh: 4500,
  heatPump: { annualKwh: 4000, baseTempC: 15 },
  ev: { annualKwh: 2500, window: 'night' },
  gridPrice: 1.30,
  exportPrice: 0.40,
  useMock: true,
};

console.log('\n### DATE SINTETICE - validare lant de calcul, NU cifre reale ###');

raport('1. Bucuresti - on-grid, 6 kWp, fara baterie', await runScenario({
  ...BUCURESTI, ...casa, kwp: 6, topology: 'ongrid',
}));

raport('2. Bucuresti - hibrid, 6 kWp + 10 kWh LFP', await runScenario({
  ...BUCURESTI, ...casa, kwp: 6, topology: 'hybrid',
  battery: { nominalKwh: 10, chemistry: 'lfp', pChargeKw: 5, pDischargeKw: 5 },
}));

raport('3. Bucuresti - OFF-GRID, 6 kWp + 10 kWh (subdimensionat intentionat)', await runScenario({
  ...BUCURESTI, ...casa, kwp: 6, topology: 'offgrid',
  battery: { nominalKwh: 10, chemistry: 'lfp', pChargeKw: 5, pDischargeKw: 5 },
}));

raport('4. Bucuresti - OFF-GRID, 16 kWp + 40 kWh', await runScenario({
  ...BUCURESTI, ...casa, kwp: 16, topology: 'offgrid',
  battery: { nominalKwh: 40, chemistry: 'lfp', pChargeKw: 15, pDischargeKw: 10 },
}));

raport('5. Bruxelles - hibrid, 6 kWp + 10 kWh (comparatie de latitudine)', await runScenario({
  ...BRUXELLES, ...casa, kwp: 6, topology: 'hybrid',
  battery: { nominalKwh: 10, chemistry: 'lfp', pChargeKw: 5, pDischargeKw: 5 },
}));

/* --- verificari de coerenta --- */
console.log(`\n${'='.repeat(66)}\nVERIFICARI DE COERENTA\n${'='.repeat(66)}`);

const t = await runScenario({
  ...BUCURESTI, ...casa, kwp: 6, topology: 'hybrid',
  battery: { nominalKwh: 10, chemistry: 'lfp', pChargeKw: 5, pDischargeKw: 5 },
});

const bilantPv = t.totals.directUseKwh + t.totals.batteryInKwh + t.totals.gridExportKwh;
const bilantLoad = t.totals.directUseKwh + t.totals.batteryOutKwh + t.totals.gridImportKwh;
const check = (nume, ok) => console.log(`  ${ok ? 'OK  ' : 'ESEC'}  ${nume}`);

check('Bilant energetic PV inchis', Math.abs(bilantPv - t.totals.pvKwh) < 1);
check('Bilant energetic consum inchis', Math.abs(bilantLoad - t.totals.loadKwh) < 1);
check('Pierderi baterie pozitive', t.totals.batteryInKwh > t.totals.batteryOutKwh);
check('Consum anual respectat', Math.abs(t.load.annualTotal - 11000) < 1);
check('Autoconsum in [0,1]', t.selfConsumption > 0 && t.selfConsumption <= 1);
check('Hibrid nu are ore de pana', t.totals.unservedHours === 0);
check('Decembrie sub iunie ca productie', t.monthly[11].pv < t.monthly[5].pv);

const raport_dec = t.monthly[11].pv / t.monthly[5].pv;
console.log(`\n  Raport productie decembrie/iunie: ${r1(raport_dec * 100)} %`);
console.log('  (in Europa centrala valoarea reala e tipic 10-20 % - de aici');
console.log('   vine regula de dimensionare pe luna cea mai proasta)');

/* --- regresie: anul bisect si intervalul PVGIS --- */
console.log(`\n${'='.repeat(66)}\nANUL BISECT SI INTERVALUL PVGIS (regresie)\n${'='.repeat(66)}`);
const { normalizeToNonLeap, isLeap, YEAR_RANGE, fetchPvgisHourly } = await import('../src/pvgis.js');
const leap = Array.from({ length: 8784 }, (_, i) => i);
const fixed = normalizeToNonLeap(leap);

check('8784 ore -> 8760', fixed.length === 8760);
check('Ultima ora din 28 feb pastrata', fixed[1415] === 1415);
check('29 feb eliminat (1415 urmat de 1440)', fixed[1416] === 1440);
check('Serie de 8760 trece neatinsa', normalizeToNonLeap(new Array(8760).fill(1)).length === 8760);
try { normalizeToNonLeap(new Array(5000).fill(1)); check('Lungime invalida arunca eroare', false); }
catch { check('Lungime invalida arunca eroare', true); }

check('2020 detectat ca bisect', isLeap(2020));
check('2019 detectat ca nebisect', !isLeap(2019));
check('Interval PVGIS v5.2 = 2005-2020', YEAR_RANGE.min === 2005 && YEAR_RANGE.max === 2020);

const anRespins = async (y) => {
  try { await fetchPvgisHourly({ lat: 44.43, lon: 26.1, year: y }); return false; }
  catch (e) { return e.message.includes('in afara intervalului'); }
};
check('An in afara intervalului respins local', await anRespins(2023));

console.log(`
  Doua bug-uri gasite la rularile reale contra PVGIS:
    1. anul implicit 2020 e bisect -> 8784 ore, simularea cere fix 8760
    2. PVGIS v5.2 accepta doar 2005-2020, deci 2023 era respins de server
  Ultimul an nebisect disponibil, si cel folosit acum, este 2019.`);
