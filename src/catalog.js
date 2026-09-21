/**
 * Maparea sistemului dimensionat pe catalogul CLIENTULUI.
 *
 * Aici e punctul comercial al intregului produs. PVGIS spune cat produce
 * un sistem. Un instrument neutru nu poate spune niciodata "iti trebuie
 * 24 de panouri model X si invertorul Y de la firma asta" - tocmai
 * neutralitatea il impiedica. Noi putem, si de aia ne plateste
 * instalatorul.
 */

/** Catalog demonstrativ. In productie vine din baza de date, per tenant. */
export const CATALOG_DEMO = {
  currency: 'RON',
  panels: [
    { id: 'p450', name: 'Mono 450W',  wp: 450, areaM2: 2.10, price: 620 },
    { id: 'p550', name: 'Mono 550W',  wp: 550, areaM2: 2.58, price: 740 },
  ],
  inverters: [
    { id: 'i3h',  name: 'Hibrid 3 kW',  kwAc: 3,  hybrid: true,  price: 4200 },
    { id: 'i5h',  name: 'Hibrid 5 kW',  kwAc: 5,  hybrid: true,  price: 5600 },
    { id: 'i8h',  name: 'Hibrid 8 kW',  kwAc: 8,  hybrid: true,  price: 8100 },
    { id: 'i12h', name: 'Hibrid 12 kW', kwAc: 12, hybrid: true,  price: 11800 },
    { id: 'i3g',  name: 'On-grid 3 kW', kwAc: 3,  hybrid: false, price: 2900 },
    { id: 'i5g',  name: 'On-grid 5 kW', kwAc: 5,  hybrid: false, price: 3900 },
    { id: 'i10g', name: 'On-grid 10 kW',kwAc: 10, hybrid: false, price: 6800 },
  ],
  batteries: [
    { id: 'b5',  name: 'LFP 5 kWh',  kwhNominal: 5,  chemistry: 'lfp', pKw: 2.5, price: 7500 },
    { id: 'b10', name: 'LFP 10 kWh', kwhNominal: 10, chemistry: 'lfp', pKw: 5,   price: 13500 },
  ],
  labour: { perKwp: 900, perBatteryKwh: 150, fixed: 2500 },
  rules: { maxDcAcRatio: 1.3 },
};

/** Cate kWp incap pe o suprafata data, cu panoul ales. */
export function maxKwpForArea(areaM2, panel, packingFactor = 0.80) {
  const usable = areaM2 * packingFactor;
  return Math.floor(usable / panel.areaM2) * panel.wp / 1000;
}

/**
 * Construieste lista de materiale pentru un sistem dimensionat.
 * @returns {{ items, totalPrice, actualKwp, actualBatteryKwh, warnings }}
 */
export function selectBom({ kwp, batteryKwh = 0, topology = 'hybrid', catalog = CATALOG_DEMO, panelId = null }) {
  const warnings = [];

  /* --- panouri: implicit cel mai ieftin pe Wp --- */
  const panel = panelId
    ? catalog.panels.find(p => p.id === panelId)
    : [...catalog.panels].sort((a, b) => a.price / a.wp - b.price / b.wp)[0];
  if (!panel) throw new Error('Catalog fara panouri');

  const panelCount = Math.ceil((kwp * 1000) / panel.wp);
  const actualKwp = (panelCount * panel.wp) / 1000;

  /* --- invertor: cel mai mic care acopera, hibrid daca e nevoie --- */
  const needHybrid = topology !== 'ongrid';
  const ratio = catalog.rules?.maxDcAcRatio ?? 1.3;
  const minKwAc = actualKwp / ratio;

  // Alegem cel mai IEFTIN invertor care acopera, nu cel mai mic. La sisteme
  // mici catalogul poate sa nu aiba invertor on-grid sub o anumita putere,
  // si atunci se ajungea la un hibrid de 3 kW la 4.200 lei acolo unde unul
  // on-grid de 5 kW costa 3.900. Limita superioara impiedica alegerea unui
  // invertor absurd de mare doar pentru ca e ieftin (randament slab la
  // sarcina partiala).
  const potriviti = catalog.inverters
    .filter(i => (needHybrid ? i.hybrid : true))
    .filter(i => i.kwAc >= minKwAc);

  const celMaiMic = potriviti.length ? Math.min(...potriviti.map(i => i.kwAc)) : Infinity;
  const plafonPutere = Math.max(minKwAc * 2.5, celMaiMic);
  const candidati = potriviti
    .filter(i => i.kwAc <= plafonPutere)
    .sort((a, b) => a.price - b.price || a.kwAc - b.kwAc);

  let inverter = candidati[0];
  let inverterCount = 1;
  if (!inverter) {
    const toate = catalog.inverters
      .filter(i => (needHybrid ? i.hybrid : true))
      .sort((a, b) => b.kwAc - a.kwAc);
    inverter = toate[0];
    if (!inverter) throw new Error('Catalog fara invertoare potrivite');
    inverterCount = Math.ceil(minKwAc / inverter.kwAc);
    warnings.push(`Niciun invertor unic nu acopera ${actualKwp.toFixed(1)} kWp; ${inverterCount} unitati in paralel.`);
  }

  /* --- baterii: module pana la capacitatea ceruta --- */
  const items = [
    { tip: 'panou', ref: panel.id, nume: panel.name, cantitate: panelCount, pretUnitar: panel.price, total: panelCount * panel.price },
    { tip: 'invertor', ref: inverter.id, nume: inverter.name, cantitate: inverterCount, pretUnitar: inverter.price, total: inverterCount * inverter.price },
  ];

  let actualBatteryKwh = 0;
  if (batteryKwh > 0 && topology !== 'ongrid') {
    const bat = [...catalog.batteries].sort((a, b) => a.price / a.kwhNominal - b.price / b.kwhNominal)[0];
    if (!bat) throw new Error('Catalog fara baterii');
    const n = Math.ceil(batteryKwh / bat.kwhNominal);
    actualBatteryKwh = n * bat.kwhNominal;
    items.push({ tip: 'baterie', ref: bat.id, nume: bat.name, cantitate: n, pretUnitar: bat.price, total: n * bat.price });
  }

  /* --- manopera --- */
  const l = catalog.labour ?? { perKwp: 0, perBatteryKwh: 0, fixed: 0 };
  const manopera = l.fixed + l.perKwp * actualKwp + l.perBatteryKwh * actualBatteryKwh;
  items.push({ tip: 'manopera', ref: 'labour', nume: 'Montaj si punere in functiune', cantitate: 1, pretUnitar: manopera, total: manopera });

  return {
    items,
    totalPrice: items.reduce((s, i) => s + i.total, 0),
    actualKwp,
    actualBatteryKwh,
    panel, inverter,
    currency: catalog.currency ?? 'RON',
    warnings,
  };
}
