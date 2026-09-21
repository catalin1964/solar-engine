/**
 * Sinteza profilului orar de consum (8760 valori, kWh/ora).
 *
 * Premisa de produs: utilizatorul final NU isi cunoaste profilul orar.
 * Stie cat plateste pe luna. Deci construim profilul din:
 *   consum anual + arhetip de cladire + 2-3 bife de comportament.
 *
 * Diferentiatorul tehnic: pompa de caldura e modelata pe temperatura
 * ORARA reala din PVGIS (acelasi set de date ca radiatia), nu pe un
 * profil mediu fix. Acolo gresesc masiv calculatoarele gratuite, si
 * gresesc exact in lunile care conteaza.
 *
 * IMPORTANT: seria de temperaturi primita trebuie sa fie deja decalata
 * in ora locala (vezi shiftToLocal din pvgis.js). Altfel pompa de
 * caldura si consumul casnic sunt nealiniate.
 */

const H = 8760;

/* Forme orare normalizate: [zi lucratoare(24), weekend(24)] */
export const ARCHETYPES = {
  apartament: {
    label: 'Apartament',
    weekday: [0.50,0.45,0.42,0.40,0.42,0.50,0.90,1.10,0.90,0.60,0.55,0.55,
              0.70,0.60,0.55,0.55,0.65,1.00,1.40,1.80,1.90,1.70,1.30,0.80],
    weekend: [0.55,0.48,0.44,0.42,0.42,0.48,0.60,0.80,1.10,1.20,1.15,1.10,
              1.20,1.05,0.95,0.95,1.05,1.30,1.60,1.85,1.85,1.60,1.25,0.85],
  },
  casa_goala_zi: {
    label: 'Casa, nimeni acasa ziua',
    weekday: [0.45,0.40,0.38,0.36,0.38,0.55,1.10,1.40,0.85,0.45,0.40,0.38,
              0.40,0.38,0.38,0.42,0.70,1.20,1.75,2.00,1.90,1.55,1.10,0.70],
    weekend: [0.55,0.48,0.44,0.42,0.42,0.50,0.65,0.90,1.20,1.35,1.30,1.25,
              1.30,1.15,1.05,1.05,1.15,1.40,1.70,1.90,1.85,1.55,1.20,0.85],
  },
  casa_ocupata_zi: {
    label: 'Casa, cineva acasa ziua',
    weekday: [0.55,0.50,0.46,0.44,0.46,0.60,0.95,1.15,1.10,1.05,1.00,1.00,
              1.15,1.05,0.95,0.95,1.05,1.25,1.55,1.70,1.65,1.40,1.05,0.75],
    weekend: [0.58,0.50,0.46,0.44,0.46,0.52,0.70,0.95,1.20,1.30,1.25,1.20,
              1.30,1.15,1.05,1.05,1.15,1.35,1.60,1.75,1.70,1.45,1.15,0.85],
  },
  firma_9_17: {
    label: 'Firma mica, program de zi',
    weekday: [0.12,0.12,0.12,0.12,0.12,0.15,0.35,0.90,1.80,2.10,2.20,2.20,
              2.00,2.15,2.20,2.10,1.90,1.20,0.50,0.25,0.18,0.15,0.13,0.12],
    weekend: [0.12,0.12,0.12,0.12,0.12,0.12,0.14,0.18,0.22,0.25,0.25,0.25,
              0.25,0.25,0.24,0.22,0.20,0.18,0.16,0.15,0.14,0.13,0.12,0.12],
  },
  continuu: {
    label: 'Activitate continua 24/7',
    weekday: new Array(24).fill(1),
    weekend: new Array(24).fill(1),
  },
};

/* Sezonalitate consum de baza (iluminat etc.), factor lunar */
const SEASON = [1.12,1.08,1.02,0.96,0.92,0.90,0.90,0.92,0.96,1.02,1.09,1.13];
const MONTH_LEN = [31,28,31,30,31,30,31,31,30,31,30,31];

function monthIndexByHour() {
  const idx = new Int8Array(H);
  let h = 0;
  for (let m = 0; m < 12; m++)
    for (let d = 0; d < MONTH_LEN[m]; d++)
      for (let k = 0; k < 24; k++) idx[h++] = m;
  return idx;
}

const MONTH_OF_HOUR = monthIndexByHour();
export { MONTH_OF_HOUR };

function scaleTo(arr, targetTotal) {
  const s = arr.reduce((a, b) => a + b, 0);
  if (s <= 0) return arr.map(() => 0);
  const k = targetTotal / s;
  return arr.map(v => v * k);
}

/**
 * @param {object} o
 * @param {number} o.annualKwh        consum de baza anual (fara PC si masina electrica)
 * @param {string} o.archetype        cheie din ARCHETYPES
 * @param {number[]} o.temperatures   T2m orar, ORA LOCALA, 8760 valori
 * @param {object|null} o.heatPump    { annualKwh, baseTempC=15, cop=3.2 }
 * @param {object|null} o.ev          { annualKwh=2500, window='night'|'day' }
 * @param {number} o.startDayOfWeek   0=luni
 */
export function buildLoadProfile({
  annualKwh,
  archetype = 'casa_goala_zi',
  temperatures = null,
  heatPump = null,
  ev = null,
  startDayOfWeek = 0,
}) {
  const arch = ARCHETYPES[archetype];
  if (!arch) throw new Error(`Arhetip necunoscut: ${archetype}`);

  /* --- consum de baza --- */
  const base = new Array(H);
  for (let h = 0; h < H; h++) {
    const day = Math.floor(h / 24);
    const hour = h % 24;
    const dow = (day + startDayOfWeek) % 7;
    const shape = dow >= 5 ? arch.weekend : arch.weekday;
    base[h] = shape[hour] * SEASON[MONTH_OF_HOUR[h]];
  }
  const baseScaled = scaleTo(base, annualKwh);

  /* --- pompa de caldura: grade-ora pe temperatura reala --- */
  let hp = new Array(H).fill(0);
  if (heatPump && heatPump.annualKwh > 0) {
    if (!temperatures || temperatures.length !== H) {
      throw new Error('Pompa de caldura necesita seria orara de temperaturi (ora locala)');
    }
    const baseT = heatPump.baseTempC ?? 15;
    const raw = temperatures.map(t => Math.max(0, baseT - t));
    hp = scaleTo(raw, heatPump.annualKwh);
  }

  /* --- masina electrica --- */
  let evArr = new Array(H).fill(0);
  if (ev && ev.annualKwh > 0) {
    const win = ev.window === 'day' ? [10,11,12,13,14,15] : [22,23,0,1,2,3,4,5];
    const raw = new Array(H).fill(0);
    for (let h = 0; h < H; h++) if (win.includes(h % 24)) raw[h] = 1;
    evArr = scaleTo(raw, ev.annualKwh);
  }

  const total = new Array(H);
  for (let h = 0; h < H; h++) total[h] = baseScaled[h] + hp[h] + evArr[h];

  return {
    total,
    base: baseScaled,
    heatPump: hp,
    ev: evArr,
    annualTotal: total.reduce((a, b) => a + b, 0),
  };
}

/** Estimare consum anual din factura medie lunara. */
export function annualKwhFromBill({ monthlyBill, pricePerKwh }) {
  if (!pricePerKwh || pricePerKwh <= 0) throw new Error('pricePerKwh invalid');
  return (monthlyBill / pricePerKwh) * 12;
}
