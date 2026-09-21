/**
 * Rezolvitorul de dimensionare.
 *
 * Utilizatorul nu introduce kWp si kWh - nu are de unde sa le stie.
 * Introduce un obiectiv, iar rezolvitorul cauta cea mai ieftina
 * configuratie care il atinge.
 *
 * Doua reguli de onestitate, ambele operationale aici:
 *
 *   1. Cautarea ruleaza pe ANUL DE REFERINTA ales din setul multi-an -
 *      pentru off-grid si hibrid, anul cu iarna cea mai slaba. Nu pe medie.
 *
 *   2. Daca obiectivul NU e realizabil in limitele date, spunem asta
 *      explicit si recomandam alternativa. Nu returnam sistemul cel mai
 *      mare posibil facandu-ne ca e solutie. Un instalator care livreaza
 *      un off-grid subdimensionat primeste un client furios si da vina
 *      pe instrument.
 */

import { simulate, scalePv } from './simulate.js';
import { selectBom, CATALOG_DEMO } from './catalog.js';

const OBIECTIVE = ['lolp', 'selfSufficiency', 'payback'];

function evalueaza(kwp, batteryKwh, ctx) {
  const pv = scalePv(ctx.pvPerKwp, kwp);
  const battery = batteryKwh > 0 && ctx.topology !== 'ongrid'
    ? { nominalKwh: batteryKwh, chemistry: 'lfp',
        pChargeKw: batteryKwh * 0.5, pDischargeKw: batteryKwh * 0.5 }
    : null;

  const sim = simulate(pv, ctx.load, {
    topology: ctx.topology, battery,
    gridPrice: ctx.gridPrice, exportPrice: ctx.exportPrice,
  });

  const bom = selectBom({ kwp, batteryKwh, topology: ctx.topology, catalog: ctx.catalog });
  const payback = sim.annualSaving > 0 ? bom.totalPrice / sim.annualSaving : Infinity;
  // Beneficiu net anualizat = economie - capex/durata de viata considerata.
  // Calculat pentru FIECARE candidat, nu doar in cautarea relaxata - vezi
  // maiBun() mai jos pentru de ce conteaza si la obiectivul de amortizare.
  const beneficiuNet = sim.annualSaving - bom.totalPrice / ctx.orizontEconomic;

  return { kwp, batteryKwh, sim, bom, payback, beneficiuNet };
}

/**
 * Plafonul economic. Fara el, cautarea relaxata (cand tinta nu e atinsa)
 * maximizeaza autosuficienta fara sa-i pese de cost: cum panourile sunt
 * deja plafonate, singura parghie ramasa e bateria, si o duce la maxim.
 * Rezultat real observat: 60 kWh de baterii, 111.685 lei, amortizare in
 * 21 de ani - la un sistem care iarna produce 4 kWh pe zi, deci bateria
 * nici nu se umple. Nu propunem sisteme care nu se amortizeaza in durata
 * lor de viata. La off-grid nu se aplica: acolo nu exista alternativa de
 * la retea fata de care sa calculezi o amortizare.
 */
function respectaEconomia(c, ctx) {
  if (ctx.topology === 'offgrid') return true;
  return c.payback <= ctx.maxPaybackYears;
}

/** Plafonul de supradimensionare, verificat separat de pragul obiectivului. */
function respectaPlafon(c, ctx) {
  if (ctx.topology === 'offgrid' || ctx.maxProductionRatio === Infinity) return true;
  return c.sim.totals.pvKwh <= ctx.maxProductionRatio * c.sim.totals.loadKwh;
}

function indeplineste(c, objective, ctx) {
  // Plafonul de supradimensionare. Fara el, obiectivul "amortizare minima"
  // creste sistemul pana loveste limita: fiecare kWp in plus se exporta si
  // aduce bani, deci mai mare pare mereu mai bun. Rezulta 12 kWp la o casa
  // care consuma 2.000 kWh - absurd comercial (operatorul nu aproba
  // racordul) si "economie" mai mare decat factura, tot din vanzare.
  // Regula uzuala: productia anuala nu depaseste semnificativ consumul.
  // Nu se aplica la off-grid, unde surplusul de vara e inevitabil.
  if (!respectaPlafon(c, ctx)) return false;
  if (!respectaEconomia(c, ctx)) return false;

  switch (objective.type) {
    case 'lolp':            return c.sim.lolp <= objective.target;
    case 'selfSufficiency': return c.sim.selfSufficiency >= objective.target;
    case 'payback':         return c.sim.annualSaving > 0;
    default: throw new Error(`Obiectiv necunoscut: ${objective.type}`);
  }
}

/**
 * Intre candidatii valizi la obiectivul 'payback': NU cel cu amortizarea
 * cea mai rapida, ci cel cu beneficiul net cel mai mare dintre cei care
 * se amortizeaza in limita acceptata (vezi respectaEconomia).
 *
 * De ce conteaza distinctia: cu treptele de pret ale invertoarelor din
 * catalog (un invertor ieftin acopera pana la ~6 kWp, apoi urmeaza un
 * salt de pret), "cel mai rapid amortizat" cade mereu in aceeasi zona
 * mica, INDIFERENT de cat de mare e factura clientului. O factura de
 * 2000 lei/luna iesea cu exact acelasi sistem ca una de 800 lei/luna -
 * corect matematic pentru "amortizare minima", dar gresit pentru ce
 * asteapta clientul: un consum mare ar trebui sa justifice un sistem
 * mai mare, nu identic. Beneficiul net scaleaza firesc cu factura si
 * impinge spre plafonul de productie cand chiar se justifica.
 *
 * La celelalte obiective (lolp, selfSufficiency), odata atinsa tinta,
 * cel mai ieftin castiga - acolo diferenta nu mai conteaza.
 */
function maiBun(a, b, objective) {
  if (!a) return b;
  if (!b) return a;
  if (objective.type === 'payback') return b.beneficiuNet > a.beneficiuNet ? b : a;
  return b.bom.totalPrice < a.bom.totalPrice ? b : a;
}

function cautaGrila(kwpList, batList, ctx, objective, relaxat = false) {
  let best = null, valizi = 0, testate = 0;
  for (const kwp of kwpList) {
    for (const bat of batList) {
      testate++;
      const c = evalueaza(kwp, bat, ctx);
      if (relaxat) {
        // Fara pragul obiectivului: cautam pur si simplu maximul atins.
        if (!respectaPlafon(c, ctx) || !respectaEconomia(c, ctx)) continue;
        valizi++;
        // Criteriul: beneficiu net anualizat = economie - capex/durata.
        //
        // "Maximizeaza autosuficienta" pare rezonabil dar produce monstri:
        // impinge bateria pana la limita, pentru ca fiecare kWh in plus mai
        // adauga o farama de procent, indiferent cat costa. Observat real:
        // 50 kWh de baterii, 104.000 lei, pentru 60% autosuficienta.
        //
        // Beneficiul net e deja calculat in evalueaza(), pe orizontEconomic
        // fix - nu pe maxPaybackYears, ca sa nu degenereze cand acesta e
        // pus pe Infinity (vezi apelul cu {...ctx, maxPaybackYears:Infinity}
        // mai jos, pentru cazul hibrid fara solutie sub plafonul de cost).
        if (!best || c.beneficiuNet > best.beneficiuNet + 1e-9) best = c;
      } else if (indeplineste(c, objective, ctx)) {
        valizi++; best = maiBun(best, c, objective);
      }
    }
  }
  return { best, valizi, testate };
}

const interval = (min, max, pas) => {
  const out = [];
  for (let v = min; v <= max + 1e-9; v += pas) out.push(Number(v.toFixed(3)));
  return out;
};

/**
 * @param {object} o
 * @param {number[]} o.pvPerKwp   productie orara pentru 1 kWp, kWh (an de referinta, ora locala)
 * @param {number[]} o.load       consum orar, kWh
 * @param {string} o.topology     ongrid | hybrid | offgrid
 * @param {object} o.objective    { type: 'lolp'|'selfSufficiency'|'payback', target }
 * @param {object} o.constraints  { maxKwp, maxBatteryKwh, minKwp }
 */
export function solveSize({
  pvPerKwp, load,
  topology = 'hybrid',
  objective = { type: 'selfSufficiency', target: 0.7 },
  constraints = {},
  gridPrice = 1.0,
  exportPrice = 0.0,
  catalog = CATALOG_DEMO,
  referenceYear = null,
}) {
  if (!OBIECTIVE.includes(objective.type)) {
    throw new Error(`Obiectiv necunoscut: ${objective.type}. Valide: ${OBIECTIVE.join(', ')}`);
  }

  /* Garda de unitati.
   * pvPerKwp trebuie sa fie seria BRUTA PVGIS, in WATI pentru 1 kWp.
   * Suma anuala iese atunci intre 500.000 si 2.500.000 (adica 500-2500
   * kWh/kWp). Daca cineva a impartit deja la 1000, suma iese ~1300 si
   * scalePv mai imparte o data - productia devine practic zero, iar
   * rezultatele arata plauzibil dar sunt absurde (amortizare in 2000 de
   * ani). Eroare care trece usor neobservata, deci o prindem aici. */
  const sumaPv = pvPerKwp.reduce((a, b) => a + b, 0);
  if (sumaPv > 0 && sumaPv < 100000) {
    throw new Error(
      `pvPerKwp pare sa fie deja in kWh (suma anuala ${Math.round(sumaPv)}). ` +
      `Se astepta seria bruta PVGIS in WATI pentru 1 kWp (suma tipica 500.000-2.500.000). ` +
      `Nu imparti la 1000 inainte - o face scalePv().`
    );
  }

  const minKwp = constraints.minKwp ?? 1;
  const maxKwpCerut = constraints.maxKwp ?? 30;
  const maxProductionRatio = topology === 'offgrid'
    ? Infinity
    : (constraints.maxProductionRatio ?? 1.2);
  const maxBat = topology === 'ongrid' ? 0 : (constraints.maxBatteryKwh ?? 60);

  /* Bateria minima la hibrid.
   *
   * Omul care alege hibrid a cerut explicit curent cand cade reteaua.
   * Criteriul de beneficiu net, lasat liber, alege zero baterii: costa
   * mult si aduc putina economie, deci optimul matematic e sa nu pui
   * niciuna. Dar atunci nu mai e sistem hibrid, e on-grid cu invertor
   * hibrid - adica fix ce omul nu a cerut.
   *
   * Pragul: aproximativ o seara si o noapte de consum mediu, cu podea la
   * cel mai mic modul din catalog. Nu optimizam sub cerinta utilizatorului. */
  const consumAnual = load.reduce((a, b) => a + b, 0);
  const consumMediuOrar = consumAnual / 8760;

  /* Limita superioara utila de putere.
   *
   * Fara asta, grila grosiera mergea de la 1 la 30 kWp cu pasul 2,4, desi
   * plafonul de productie permitea maximum 1,8 kWp la consumuri mici -
   * adica se cauta aproape numai in afara zonei valide, si solutia buna
   * era gasita din intamplare abia la rafinare. Taiem din start. */
  const productieSpecifica = pvPerKwp.reduce((a, b) => a + b, 0) / 1000;
  const maxKwp = (topology === 'offgrid' || maxProductionRatio === Infinity)
    ? maxKwpCerut
    : Math.min(maxKwpCerut, Math.max(minKwp + 0.5,
        (maxProductionRatio * consumAnual) / Math.max(productieSpecifica, 1)));
  const minBat = topology === 'hybrid'
    ? (constraints.minBatteryKwh ?? Math.max(5, Math.round(8 * consumMediuOrar)))
    : 0;

  const maxPaybackYears = constraints.maxPaybackYears ?? 15;
  const orizontEconomic = constraints.orizontEconomic ?? 15;   // durata de viata considerata
  const ctx = { pvPerKwp, load, topology, gridPrice, exportPrice, catalog,
                maxProductionRatio, maxPaybackYears, orizontEconomic };

  /* --- faza 1: grosier --- */
  const pasKwpGrosier = Math.max(1, (maxKwp - minKwp) / 12);
  const pasBatGrosier = maxBat > 0 ? Math.max(2.5, maxBat / 10) : 1;

  const g = cautaGrila(
    interval(minKwp, maxKwp, pasKwpGrosier),
    maxBat > 0 ? interval(minBat, maxBat, pasBatGrosier) : [0],
    ctx, objective
  );

  /* Tinta de autosuficienta e o dorinta, nu o conditie de siguranta.
   * Daca plafonul de supradimensionare o face imposibila, returnam cel mai
   * bun rezultat atins si spunem clar cat s-a atins - mult mai util decat
   * un refuz. La off-grid ramane refuz: acolo pragul e despre a avea sau
   * nu curent, nu despre preferinte. */
  let tintaAtinsa = true;
  if (!g.best && objective.type === 'selfSufficiency') {
    const r = cautaGrila(
      interval(minKwp, maxKwp, pasKwpGrosier),
      maxBat > 0 ? interval(minBat, maxBat, pasBatGrosier) : [0],
      ctx, objective, true
    );
    // Daca nici asa nu iese nimic, plafonul economic e cel care blocheaza.
    // La hibrid bateria minima e ceruta de utilizator, deci o pastram si
    // lasam cifra de amortizare sa vorbeasca singura.
    if (!r.best && topology === 'hybrid') {
      const fara = cautaGrila(
        interval(minKwp, maxKwp, pasKwpGrosier),
        interval(minBat, maxBat, pasBatGrosier),
        { ...ctx, maxPaybackYears: Infinity }, objective, true   // orizontEconomicE ramane finit
      );
      if (fara.best) { g.best = fara.best; g.testate += fara.testate; tintaAtinsa = false; }
    }
    if (r.best) { g.best = r.best; g.testate += r.testate; tintaAtinsa = false; }
  }

  if (!g.best) {
    /* --- nerealizabil: raportam cinstit, cu dovada --- */
    const maxim = evalueaza(maxKwp, maxBat, ctx);
    return {
      feasible: false,
      topology, objective, referenceYear,
      testate: g.testate,
      maximTestat: {
        kwp: maxKwp, batteryKwh: maxBat,
        lolp: maxim.sim.lolp,
        selfSufficiency: maxim.sim.selfSufficiency,
        unservedHours: maxim.sim.totals.unservedHours,
        decembrie: maxim.sim.december,
        pret: maxim.bom.totalPrice,
      },
      plafonProductie: maxProductionRatio,
      mesaj: topology === 'offgrid'
        ? `Obiectivul nu e realizabil la aceasta locatie in limitele date. Nici ${maxKwp} kWp cu ${maxBat} kWh nu ajunge: raman ${maxim.sim.totals.unservedHours} ore de pana pe an, aproape toate in noiembrie-februarie. Cauza e nepotrivirea sezoniera - surplusul din iulie nu poate fi stocat pana in decembrie. Recomanda hibrid, sau off-grid cu generator de rezerva pentru iarna.`
        : `Obiectivul nu e realizabil in limitele date (max ${maxKwp} kWp, ${maxBat} kWh). Relaxeaza tinta sau creste limitele.`,
    };
  }

  /* --- faza 2: rafinare in jurul solutiei grosiere --- */
  const pasKwpFin = Math.max(0.25, pasKwpGrosier / 5);
  const pasBatFin = maxBat > 0 ? Math.max(1, pasBatGrosier / 5) : 1;

  // Rafinarea pastreaza acelasi mod ca faza grosiera: daca tinta nu a fost
  // atinsa, cautam tot maximul posibil, nu pragul care oricum nu se atinge.
  const f = cautaGrila(
    interval(Math.max(minKwp, g.best.kwp - pasKwpGrosier), Math.min(maxKwp, g.best.kwp + pasKwpGrosier), pasKwpFin),
    maxBat > 0
      ? interval(Math.max(minBat, g.best.batteryKwh - pasBatGrosier), Math.min(maxBat, g.best.batteryKwh + pasBatGrosier), pasBatFin)
      : [0],
    ctx, objective, !tintaAtinsa
  );

  const bestPre = !tintaAtinsa
    ? ((f.best && f.best.beneficiuNet > (g.best.beneficiuNet ?? -Infinity)) ? f.best : g.best)
    : (maiBun(g.best, f.best, objective) ?? g.best);

  // Rafinarea poate depasi tinta chiar daca faza grosiera nu a gasit-o.
  // Verificam pe rezultatul FINAL, nu pe starea din timpul cautarii, ca sa
  // nu afisam "tinta neatinsa" langa un procent care o depaseste.
  const best = bestPre;
  if (!tintaAtinsa && objective.type === 'selfSufficiency'
      && best.sim.selfSufficiency >= objective.target) tintaAtinsa = true;

  const s = best.sim;

  return {
    feasible: true,
    tintaAtinsa,
    topology, objective, referenceYear,
    plafonProductie: maxProductionRatio,
    plafonAmortizare: maxPaybackYears,
    bateriaMinima: minBat,
    testate: g.testate + f.testate,
    sistem: {
      kwp: best.bom.actualKwp,
      batteryKwh: best.bom.actualBatteryKwh,
      panouri: `${best.bom.items[0].cantitate} x ${best.bom.panel.name}`,
      invertor: best.bom.inverter.name,
    },
    performanta: {
      productieKwh: s.totals.pvKwh,
      consumKwh: s.totals.loadKwh,
      autoconsum: s.selfConsumption,
      autosuficienta: s.selfSufficiency,
      importKwh: s.totals.gridImportKwh,
      exportKwh: s.totals.gridExportKwh,
      raportProductieConsum: s.totals.pvKwh / s.totals.loadKwh,
      oreDePana: s.totals.unservedHours,
      lolp: s.lolp,
    },
    economic: {
      capex: best.bom.totalPrice,
      economieAnuala: s.annualSaving,
      amortizareAni: best.payback,
      moneda: best.bom.currency,
    },
    bom: best.bom.items,
    avertismente: best.bom.warnings,
    lunar: s.monthly,
    lunaCeaMaiProasta: s.worstMonth,
    decembrie: s.december,
  };
}
