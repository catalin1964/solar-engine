/**
 * !!! DATE SINTETICE - NUMAI PENTRU TESTE OFFLINE !!!
 *
 * Model simplificat de cer senin + factor de innorare lunar.
 * Serveste EXCLUSIV la validarea lantului de calcul cand PVGIS nu e
 * accesibil. NU folosi niciodata in productie si nu arata cifre din
 * el unui client. Cifrele reale vin din PVGIS.
 *
 * Interfata e identica cu fetchPvgisHourly() ca sa poti schimba sursa
 * fara sa atingi restul motorului.
 */

const DEG = Math.PI / 180;
const DAYS = 365;

// Factor de innorare mediu lunar (fractiune din radiatia de cer senin).
// Tipar european: iarna mult mai innorata decat vara.
const CLOUD = [0.40, 0.48, 0.58, 0.66, 0.72, 0.78, 0.82, 0.80, 0.70, 0.54, 0.38, 0.34];

/** Sudul Europei e mai senin decat nordul. Ajustare grosiera pe latitudine. */
function clarity(lat) {
  return Math.min(1.15, Math.max(0.85, 1 + (48 - Math.abs(lat)) * 0.014));
}
const MONTH_LEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function monthOfDay(n) {
  let d = n, m = 0;
  while (d > MONTH_LEN[m]) { d -= MONTH_LEN[m]; m++; }
  return m;
}

function declination(n) {
  return 23.45 * DEG * Math.sin(2 * Math.PI * (284 + n) / 365);
}

/** Cosinusul unghiului de incidenta pe plan inclinat. gamma: 0=S, +V, -E. */
function cosIncidence(phi, delta, omega, beta, gamma) {
  return (
    Math.sin(delta) * Math.sin(phi) * Math.cos(beta)
    - Math.sin(delta) * Math.cos(phi) * Math.sin(beta) * Math.cos(gamma)
    + Math.cos(delta) * Math.cos(phi) * Math.cos(beta) * Math.cos(omega)
    + Math.cos(delta) * Math.sin(phi) * Math.sin(beta) * Math.cos(gamma) * Math.cos(omega)
    + Math.cos(delta) * Math.sin(beta) * Math.sin(gamma) * Math.sin(omega)
  );
}

export function mockPvgisHourly({
  lat, lon,
  tilt = 30,
  aspect = 0,
  systemLoss = 14,
  meanTemp = null,
  albedo = 0.2,
}) {
  const phi = lat * DEG;
  const beta = tilt * DEG;
  const gamma = aspect * DEG;

  // Temperatura medie anuala aproximata din latitudine daca nu e data.
  const Tmean = meanTemp ?? (30 - 0.43 * Math.abs(lat));
  const Tamp = 11;   // amplitudine anuala
  const Tdiu = 5;    // amplitudine diurna

  const P = [], G = [], T2m = [], WS10m = [], timestamps = [];
  const lossFactor = 1 - systemLoss / 100;

  for (let n = 1; n <= DAYS; n++) {
    const delta = declination(n);
    const m = monthOfDay(n);
    const cloud = Math.min(0.95, CLOUD[m] * clarity(lat));
    const Tday = Tmean + Tamp * Math.sin(2 * Math.PI * (n - 105) / 365);

    for (let h = 0; h < 24; h++) {
      const omega = 15 * (h + 0.5 - 12) * DEG;
      const sinAlt = Math.sin(phi) * Math.sin(delta)
                   + Math.cos(phi) * Math.cos(delta) * Math.cos(omega);

      let ghi = 0, poa = 0;
      if (sinAlt > 0.01) {
        // Haurwitz, cer senin
        ghi = 1098 * sinAlt * Math.exp(-0.059 / sinAlt) * cloud;
        const dhi = ghi * (0.15 + 0.55 * (1 - cloud));   // difuz mai mare cand e innorat
        const dni = Math.max(0, (ghi - dhi) / sinAlt);
        const cosTheta = Math.max(0, cosIncidence(phi, delta, omega, beta, gamma));
        poa = dni * cosTheta
            + dhi * (1 + Math.cos(beta)) / 2
            + ghi * albedo * (1 - Math.cos(beta)) / 2;
      }

      const Tamb = Tday + Tdiu * Math.sin(2 * Math.PI * (h - 9) / 24);
      const Tcell = Tamb + (poa / 800) * 25;             // NOCT ~45 C
      const tempDerate = 1 - 0.004 * (Tcell - 25);

      // 1 kWp
      const p = Math.max(0, (poa / 1000) * 1000 * tempDerate * lossFactor);

      P.push(p);
      G.push(poa);
      T2m.push(Tamb);
      WS10m.push(3);
      const mm = String(m + 1).padStart(2, '0');
      timestamps.push(`MOCK${mm}:${String(h).padStart(2, '0')}00`);
    }
  }

  return { P, G, T2m, WS10m, timestamps, source: 'MOCK-SINTETIC' };
}

/**
 * Set multi-an sintetic, cu variatie de la an la an.
 * Variatia e deterministica (nu aleatoare) ca testele sa fie repetabile.
 * Doar pentru teste offline.
 */
export function mockMultiYear(params, startYear = 2013, endYear = 2019) {
  const years = {};
  for (let y = startYear; y <= endYear; y++) {
    // +/- 6% in jurul mediei, tipar fix pe an
    const k = 1 + 0.06 * Math.sin((y - 2013) * 1.7);
    const base = mockPvgisHourly(params);
    years[y] = {
      P: base.P.map(v => v * k),
      T2m: base.T2m,
      WS10m: base.WS10m,
    };
  }
  return { years, source: 'MOCK-SINTETIC' };
}
