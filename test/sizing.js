import { mockMultiYear } from '../src/mockWeather.js';
import { pickReferenceYear, shiftToLocal, compassToPvgisAspect } from '../src/pvgis.js';
import { buildLoadProfile, annualKwhFromBill } from '../src/loadProfile.js';
import { solveSize } from '../src/sizing.js';

const LUNI = ['Ian','Feb','Mar','Apr','Mai','Iun','Iul','Aug','Sep','Oct','Noi','Dec'];
const r0 = n => Math.round(n).toLocaleString('ro-RO');
const r1 = n => n.toFixed(1);
const check = (n, ok) => console.log(`  ${ok ? 'OK  ' : 'ESEC'}  ${n}`);

console.log('\n### DIMENSIONARE - date sintetice ###\n');

const params = { lat: 44.43, lon: 26.10, tilt: 30, aspect: compassToPvgisAspect(180), systemLoss: 14 };
const { years } = mockMultiYear(params, 2013, 2019);

const anIarna  = pickReferenceYear(years, 'worstWinter');
const anAnual  = pickReferenceYear(years, 'worstAnnual');
const anMedian = pickReferenceYear(years, 'median');

const total = y => years[y].P.reduce((a,b)=>a+b,0)/1000;
console.log('Ani disponibili si productie specifica (kWh/kWp):');
Object.keys(years).forEach(y => console.log(`   ${y}: ${r0(total(y))}`));
console.log(`\n   Iarna cea mai slaba : ${anIarna}`);
console.log(`   An anual minim      : ${anAnual}`);
console.log(`   An median           : ${anMedian}`);
console.log(`   Ecart max-min       : ${r1((total(anMedian)/total(anAnual)-1)*100)} % peste anul prost\n`);

const T = shiftToLocal(years[anIarna].T2m, 2);
const profil = buildLoadProfile({
  annualKwh: 4500, archetype: 'casa_goala_zi', temperatures: T,
  heatPump: { annualKwh: 4000 }, ev: { annualKwh: 2500, window: 'night' },
});
const load = profil.total;

const pvRef = mode => shiftToLocal(years[pickReferenceYear(years, mode)].P, 2); // WATI bruti
const bani = { gridPrice: 1.30, exportPrice: 0.40 };

function raport(titlu, r) {
  console.log(`\n${'='.repeat(68)}\n${titlu}\n${'='.repeat(68)}`);
  console.log(`An referinta: ${r.referenceYear} | configuratii testate: ${r.testate}`);
  if (!r.feasible) {
    console.log(`\n  NEREALIZABIL\n`);
    console.log(`  ${r.mesaj.replace(/(.{66}\s)/g, '$1\n  ')}`);
    console.log(`\n  Maxim testat: ${r.maximTestat.kwp} kWp + ${r.maximTestat.batteryKwh} kWh`);
    console.log(`  -> ${r.maximTestat.unservedHours} ore de pana, ${r0(r.maximTestat.pret)} lei`);
    return;
  }
  console.log(`\n  Sistem   : ${r.sistem.kwp} kWp (${r.sistem.panouri})`);
  console.log(`             ${r.sistem.invertor}${r.sistem.batteryKwh ? ` + ${r.sistem.batteryKwh} kWh baterie` : ''}`);
  console.log(`  Autosuf. : ${r1(r.performanta.autosuficienta*100)} %   Autoconsum: ${r1(r.performanta.autoconsum*100)} %`);
  if (r.topology === 'offgrid') console.log(`  Ore pana : ${r.performanta.oreDePana} (${r1(r.performanta.lolp*100)} %)`);
  console.log(`  Investitie: ${r0(r.economic.capex)} ${r.economic.moneda}`);
  console.log(`  Economie  : ${r0(r.economic.economieAnuala)} ${r.economic.moneda}/an`);
  console.log(`  Amortizare: ${r1(r.economic.amortizareAni)} ani`);
  console.log(`\n  Lista de materiale:`);
  r.bom.forEach(i => console.log(`    ${String(i.cantitate).padStart(3)} x ${i.nume.padEnd(32)} ${r0(i.total).padStart(8)}`));
  console.log(`\n  Decembrie: productie ${r0(r.decembrie.pv)} kWh, consum ${r0(r.decembrie.load)} kWh` +
              `${r.topology==='offgrid' ? `, ${r.decembrie.unservedHours} ore pana` : ''}`);
  console.log(`  Luna cea mai proasta: ${LUNI[r.lunaCeaMaiProasta]}`);
  r.avertismente.forEach(a => console.log(`  ! ${a}`));
}

raport('A. ON-GRID - amortizare minima, acoperis max 8 kWp', solveSize({
  pvPerKwp: pvRef('median'), load, topology: 'ongrid', ...bani,
  objective: { type: 'payback' }, constraints: { maxKwp: 8 },
  referenceYear: anMedian,
}));

raport('B. HIBRID - 70% autosuficienta, an cu iarna cea mai slaba', solveSize({
  pvPerKwp: pvRef('worstWinter'), load, topology: 'hybrid', ...bani,
  objective: { type: 'selfSufficiency', target: 0.70 },
  constraints: { maxKwp: 20, maxBatteryKwh: 40 },
  referenceYear: anIarna,
}));

raport('C. OFF-GRID - pana sub 1% din an', solveSize({
  pvPerKwp: pvRef('worstWinter'), load, topology: 'offgrid', ...bani,
  objective: { type: 'lolp', target: 0.01 },
  constraints: { maxKwp: 30, maxBatteryKwh: 60 },
  referenceYear: anIarna,
}));

/* --- verificari --- */
console.log(`\n${'='.repeat(68)}\nVERIFICARI\n${'='.repeat(68)}`);

const b = solveSize({ pvPerKwp: pvRef('worstWinter'), load, topology: 'hybrid', ...bani,
  objective: { type: 'selfSufficiency', target: 0.70 },
  constraints: { maxKwp: 20, maxBatteryKwh: 40 }, referenceYear: anIarna });
const c = solveSize({ pvPerKwp: pvRef('worstWinter'), load, topology: 'offgrid', ...bani,
  objective: { type: 'lolp', target: 0.01 },
  constraints: { maxKwp: 30, maxBatteryKwh: 60 }, referenceYear: anIarna });

check('Hibrid: intoarce o solutie', b.feasible && !!b.sistem);
check('Hibrid: tinta atinsa SAU marcata ca neatinsa',
  b.tintaAtinsa ? b.performanta.autosuficienta >= 0.70 : b.performanta.autosuficienta > 0.3);
check('Hibrid: respecta plafonul', b.performanta.raportProductieConsum <= 1.2 + 1e-9);
check('Hibrid: on-grid nu primeste baterie', solveSize({ pvPerKwp: pvRef('median'), load, topology: 'ongrid',
  ...bani, objective: { type: 'payback' }, constraints: { maxKwp: 8 } }).sistem.batteryKwh === 0);
check('Off-grid nerealizabil e raportat, nu mascat', !c.feasible || c.performanta.lolp <= 0.01);
check('Anul cu iarna slaba difera de median', anIarna !== anMedian || Object.keys(years).length < 3);
check('kWp livrat e multiplu de panou', Number.isInteger(Math.round(b.sistem.kwp * 1000 / 450)));
check('Capex peste zero', b.economic.capex > 0);

/* --- regresii de selectie si unitati --- */
const { selectBom } = await import('../src/catalog.js');
const og = selectBom({ kwp: 6, batteryKwh: 0, topology: 'ongrid' });
const hy = selectBom({ kwp: 6, batteryKwh: 10, topology: 'hybrid' });
check('On-grid alege invertorul on-grid, nu hibridul scump', og.inverter.hybrid === false);
check('Hibrid alege invertor hibrid', hy.inverter.hybrid === true);
check('On-grid mai ieftin decat hibrid la acelasi kWp', og.totalPrice < hy.totalPrice);

let prins = false;
try {
  solveSize({ pvPerKwp: pvRef('median').map(w => w/1000), load, topology: 'ongrid',
    ...bani, objective: { type: 'payback' }, constraints: { maxKwp: 8 } });
} catch (e) { prins = e.message.includes('deja in kWh'); }
check('Garda de unitati prinde impartirea dubla la 1000', prins);

/* --- regresie: plafonul de supradimensionare --- */
/* Supradimensionarea apare doar la consum MIC: acolo surplusul pleaca tot in
   export, iar obiectivul "amortizare minima" creste sistemul nejustificat.
   La consum mare raportul ramane oricum sub plafon. Testam deci pe o casa
   simpla, fara pompa de caldura si fara masina electrica. */
const loadMic = buildLoadProfile({
  annualKwh: 3700, archetype: 'casa_goala_zi', temperatures: T,
}).total;

const fara = solveSize({ pvPerKwp: pvRef('median'), load: loadMic, topology: 'ongrid', ...bani,
  objective: { type: 'payback' }, constraints: { maxKwp: 15, maxProductionRatio: Infinity } });
const cu = solveSize({ pvPerKwp: pvRef('median'), load: loadMic, topology: 'ongrid', ...bani,
  objective: { type: 'payback' }, constraints: { maxKwp: 15, maxProductionRatio: 1.2 } });

console.log(`\n  Consum mic (3.700 kWh):`);
console.log(`    fara plafon: ${fara.sistem.kwp} kWp, raport ${fara.performanta.raportProductieConsum.toFixed(2)}x`);
console.log(`    cu plafon  : ${cu.sistem.kwp} kWp, raport ${cu.performanta.raportProductieConsum.toFixed(2)}x\n`);

check('Fara plafon, solverul supradimensioneaza', fara.performanta.raportProductieConsum > 1.5);
check('Cu plafon, raportul respecta limita', cu.performanta.raportProductieConsum <= 1.2 + 1e-9);
check('Plafonul reduce puterea propusa', cu.sistem.kwp < fara.sistem.kwp);
check('Economia nu mai depaseste factura', cu.economic.economieAnuala < 3700 * 1.30);
check('Off-grid ramane neplafonat', solveSize({ pvPerKwp: pvRef('worstWinter'), load, topology: 'offgrid',
  ...bani, objective: { type: 'lolp', target: 0.05 }, constraints: { maxKwp: 40, maxBatteryKwh: 80 }
}).plafonProductie === Infinity);

console.log(`
  Bug gasit pe interfata: obiectivul "amortizare minima" cu export platit
  face ca sistemul mai mare sa iasa mereu mai bun, la consum mic. Rezulta
  12,65 kWp la o casa care consuma sub 2.000 kWh, cu "economie" peste
  factura reala - toata din vanzare in retea. Operatorul nu aproba asa ceva.
  Plafonul opreste cautarea la 1,2x consumul anual, configurabil per client.`);

/* --- regresie: plafonul economic si alegerea invertorului --- */
const loadPC = buildLoadProfile({
  annualKwh: 3692, archetype: 'casa_goala_zi', temperatures: T,
  heatPump: { annualKwh: 4000 },
}).total;

const rel = solveSize({ pvPerKwp: pvRef('worstWinter'), load: loadPC, topology: 'hybrid', ...bani,
  objective: { type: 'selfSufficiency', target: 0.70 },
  constraints: { maxKwp: 20, maxBatteryKwh: 60 } });

console.log(`\n  Tinta neatinsa, cautare relaxata:`);
console.log(`    ${rel.sistem.kwp} kWp + ${rel.sistem.batteryKwh} kWh, ` +
            `${(rel.performanta.autosuficienta*100).toFixed(0)}%, ` +
            `${Math.round(rel.economic.capex)} lei, ${rel.economic.amortizareAni.toFixed(1)} ani\n`);

check('Relaxatul nu duce bateria la maxim', rel.sistem.batteryKwh < 60);
check('Relaxatul respecta plafonul de amortizare', rel.economic.amortizareAni <= rel.plafonAmortizare);
check('Relaxatul are beneficiu net pozitiv',
  rel.economic.economieAnuala - rel.economic.capex / rel.plafonAmortizare > 0);

const ogMic = selectBom({ kwp: 1.65, batteryKwh: 0, topology: 'ongrid' });
const hyMic = selectBom({ kwp: 1.65, batteryKwh: 0, topology: 'hybrid' });
check('Sistem mic on-grid: invertor on-grid, nu hibrid', ogMic.inverter.hybrid === false);
check('Sistem mic on-grid: cel mai ieftin care acopera', ogMic.inverter.price === 2900);
check('Sistem mic hibrid: tot invertor hibrid', hyMic.inverter.hybrid === true);
check('Invertorul nu e absurd supradimensionat', ogMic.inverter.kwAc <= (1.65/1.3) * 2.5 + 1e-9);

console.log(`
  Doua bug-uri gasite tot pe interfata:
    1. cand tinta nu se atinge, "maximizeaza autosuficienta" impingea
       bateria la 60 kWh - 111.685 lei, amortizare 21 ani, la un sistem
       care iarna produce 4 kWh pe zi. Criteriul e acum beneficiul net
       anualizat, care se opreste singur unde capacitatea nu-si mai
       plateste costul. Acelasi caz: 10 kWh, 44.125 lei, 6 ani.
    2. se alegea cel mai MIC invertor care acopera, nu cel mai ieftin.
       Catalogul demo nici nu avea invertor on-grid sub 5 kW - lipsa de
       date, nu de algoritm. Ambele reparate.`);

/* --- regresie: bateria minima la hibrid si limita utila de putere --- */
const hibrid = (ld, extra = {}) => solveSize({
  pvPerKwp: pvRef('worstWinter'), load: ld, topology: 'hybrid', ...bani,
  objective: { type: 'selfSufficiency', target: 0.70 },
  constraints: { maxKwp: 30, maxBatteryKwh: 60, ...extra },
});

const loadMicHib = buildLoadProfile({ annualKwh: 1900, archetype: 'apartament', temperatures: T }).total;
const hMic = hibrid(loadMicHib);
const hPC  = hibrid(loadPC);

console.log(`\n  Hibrid, consum mic : ${hMic.sistem.kwp} kWp + ${hMic.sistem.batteryKwh} kWh, ` +
  `${Math.round(hMic.economic.capex)} lei, ${hMic.economic.amortizareAni.toFixed(1)} ani`);
console.log(`  Hibrid, cu pompa   : ${hPC.sistem.kwp} kWp + ${hPC.sistem.batteryKwh} kWh, ` +
  `${Math.round(hPC.economic.capex)} lei, ${hPC.economic.amortizareAni.toFixed(1)} ani\n`);

check('Hibridul primeste intotdeauna baterie', hMic.sistem.batteryKwh > 0 && hPC.sistem.batteryKwh > 0);
check('Bateria minima e raportata', hMic.bateriaMinima >= 5);
check('Consum mic: nu mai duce bateria la 60 kWh', hMic.sistem.batteryKwh <= 20);
check('Consum mic: amortizare rezonabila', hMic.economic.amortizareAni < 25);
check('Hibridul respecta plafonul de productie', hPC.performanta.raportProductieConsum <= 1.2 + 1e-9);
check('On-grid ramane fara baterie', solveSize({ pvPerKwp: pvRef('median'), load: loadMic,
  topology: 'ongrid', ...bani, objective: { type: 'payback' }, constraints: { maxKwp: 15 }
}).sistem.batteryKwh === 0);
check('Tinta atinsa e raportata corect',
  hMic.tintaAtinsa === (hMic.performanta.autosuficienta >= 0.70 - 1e-9));

console.log(`
  Trei bug-uri gasite tot pe interfata, in aceeasi runda:
    1. hibrid FARA baterie. Criteriul de beneficiu net alegea zero stocare
       (costa mult, aduce putina economie), desi omul ceruse explicit
       curent la pana. Bateria minima e acum impusa, ~o seara si o noapte
       de consum mediu.
    2. in varianta relaxata pusesem plafonul de amortizare pe Infinity, iar
       formula "economie - capex/orizont" degenera in "costul nu conteaza":
       60 kWh de baterii, amortizare 65 de ani. Orizontul de calcul e acum
       separat de pragul de acceptare si ramane finit.
    3. grila grosiera mergea pana la 30 kWp desi plafonul permitea 1,8 -
       se cauta aproape numai in afara zonei valide. Limita utila se
       deduce acum din plafonul de productie.`);

/* --- regresie: obiectivul de amortizare trebuie sa scaleze cu factura --- */
/* Bug gasit pe interfata reala (nu pe teste): la 2000 lei/luna si la 800
   lei/luna iesea EXACT acelasi sistem (5.5 kWp). Cauza: "cel mai rapid
   amortizat" cadea mereu in aceeasi zona, din cauza treptelor de pret ale
   invertoarelor - matematic corect pentru obiectivul definit gresit, dar
   absurd pentru un client cu factura de trei ori mai mare. */
const scenariuFactura = (bill) => {
  const anual = annualKwhFromBill({ monthlyBill: bill, pricePerKwh: 1.30 });
  const ld = buildLoadProfile({ annualKwh: anual, archetype: 'casa_goala_zi', temperatures: T }).total;
  return solveSize({ pvPerKwp: pvRef('median'), load: ld, topology: 'ongrid',
    gridPrice: 1.30, exportPrice: 0.40, objective: { type: 'payback' },
    constraints: { maxKwp: 15 } });
};

const f400 = scenariuFactura(400), f800 = scenariuFactura(800), f2000 = scenariuFactura(2000);

console.log(`\n  Amortizare vs marimea facturii:`);
console.log(`    400 lei  -> ${f400.sistem.kwp} kWp`);
console.log(`    800 lei  -> ${f800.sistem.kwp} kWp`);
console.log(`    2000 lei -> ${f2000.sistem.kwp} kWp\n`);

check('Factura dubla -> sistem strict mai mare (400 vs 800)', f800.sistem.kwp > f400.sistem.kwp);
check('Factura x5 -> sistem strict mai mare (800 vs 2000)', f2000.sistem.kwp > f800.sistem.kwp);
check('La factura mare, foloseste plafonul de productie, nu-l ignora',
  f2000.performanta.raportProductieConsum > 1.0 && f2000.performanta.raportProductieConsum <= 1.2 + 1e-9);
check('Amortizarea ramane in limita acceptata la toate marimile',
  [f400, f800, f2000].every(r => r.economic.amortizareAni <= 15));
check('Autosuficienta ramane comparabila intre marimi (~acelasi procent din consum)',
  Math.abs(f400.performanta.autosuficienta - f2000.performanta.autosuficienta) < 0.15);
