/**
 * Preluarea si livrarea lead-urilor.
 *
 * Din momentul in care apare formularul, colectam date personale ale unor
 * consumatori din UE: nume, telefon, email, adresa. Nu e opțional juridic.
 *
 *   - instalatorul e OPERATOR, noi suntem PERSOANA IMPUTERNICITA
 *     -> fiecare contract are nevoie de un act adițional de prelucrare (DPA)
 *   - consimtamant explicit, bifat de om, nu presupus
 *   - fara date personale in log-uri
 *   - retentie declarata
 *
 * Ordinea de livrare conteaza: salvam INTAI in baza de date, apoi trimitem
 * emailul. Daca serverul de mail e picat, lead-ul nu se pierde - altfel
 * instalatorul plateste pentru clienti care nu ajung niciodata la el.
 */

const RETENTIE_ZILE = 365;

/* ------------------------------------------------------------------ */
/* Validare                                                            */
/* ------------------------------------------------------------------ */

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * Curata un text inainte sa ajunga intr-un ANTET de email.
 *
 * Subiectul se construieste din numele introdus de vizitator. Un nume care
 * contine un sfarsit de linie inchide antetul si deschide altul - de exemplu
 * un Bcc catre o adresa straina, sau un Reply-To schimbat. Bibliotecile bune
 * se apara singure, dar nu ne bazam pe asta: taiem aici, la sursa, orice
 * caracter de control.
 *
 * Se aplica la ORICE text care pleaca intr-un antet, nu doar la nume.
 */
export function curataPentruAntet(v, maxLen = 120) {
  return String(v ?? '')
    .replace(/[\r\n\u0000-\u001F\u007F\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function valideazaLead(b) {
  const e = [];
  const text = (v, min, max, nume) => {
    if (typeof v !== 'string' || v.trim().length < min) { e.push(`${nume} lipseste`); return false; }
    if (v.length > max) { e.push(`${nume} e prea lung`); return false; }
    return true;
  };

  text(b.nume, 2, 120, 'Numele');
  // Respingem din start, ca omul sa vada ca ceva e in neregula, nu sa
  // primeasca o curatare tacuta.
  if (typeof b.nume === 'string' && /[\r\n\u0000-\u001F]/.test(b.nume)) {
    e.push('Numele contine caractere nepermise');
  }

  // Cel putin una din cele doua cai de contact, altfel lead-ul e inutil.
  const areEmail = typeof b.email === 'string' && RE_EMAIL.test(b.email.trim());
  const areTelefon = typeof b.telefon === 'string' && b.telefon.replace(/\D/g, '').length >= 9;
  if (!areEmail && !areTelefon) e.push('Lasa un email sau un telefon valid');
  if (b.email && !areEmail) e.push('Emailul nu pare valid');

  if (b.oras != null) text(b.oras, 0, 120, 'Orasul');
  if (b.mesaj != null && typeof b.mesaj === 'string' && b.mesaj.length > 2000) e.push('Mesajul e prea lung');

  // Consimtamantul se bifeaza, nu se presupune.
  if (b.consimtamant !== true) e.push('Confirma acordul privind prelucrarea datelor');

  return e;
}

/* ------------------------------------------------------------------ */
/* Persistenta                                                         */
/* ------------------------------------------------------------------ */

let pool = null;
async function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (pool) return pool;
  const { default: pg } = await import('pg');
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaduri (
      id            BIGSERIAL PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      nume          TEXT NOT NULL,
      email         TEXT,
      telefon       TEXT,
      oras          TEXT,
      mesaj         TEXT,
      dimensionare  JSONB,
      consimtamant_la TIMESTAMPTZ NOT NULL,
      expira_la     TIMESTAMPTZ NOT NULL,
      creat_la      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  return pool;
}

async function salveaza(tenantId, b, rezumat) {
  const p = await getPool();
  if (!p) return { salvat: false, motiv: 'fara DATABASE_URL' };
  const acum = new Date();
  const expira = new Date(acum.getTime() + RETENTIE_ZILE * 864e5);
  const r = await p.query(
    `INSERT INTO leaduri (tenant_id, nume, email, telefon, oras, mesaj,
                          dimensionare, consimtamant_la, expira_la)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tenantId, b.nume.trim(), b.email?.trim() || null, b.telefon?.trim() || null,
     b.oras?.trim() || null, b.mesaj?.trim() || null, rezumat, acum, expira]
  );
  return { salvat: true, id: r.rows[0].id };
}

/** De rulat periodic. Retentia declarata trebuie sa fie si aplicata. */
export async function stergeLeaduriExpirate() {
  const p = await getPool();
  if (!p) return 0;
  const r = await p.query('DELETE FROM leaduri WHERE expira_la < now()');
  return r.rowCount;
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

function corpEmail(t, b, rezumat) {
  const L = [];
  L.push(`Cerere de oferta prin calculatorul de pe site.`);
  L.push('');
  L.push(`Nume    : ${b.nume.trim()}`);
  if (b.telefon) L.push(`Telefon : ${b.telefon.trim()}`);
  if (b.email)   L.push(`Email   : ${b.email.trim()}`);
  if (b.oras)    L.push(`Oras    : ${b.oras.trim()}`);
  L.push('');

  if (rezumat?.feasible) {
    L.push(`Sistem propus de calculator:`);
    L.push(`  ${rezumat.kwp} kWp${rezumat.batteryKwh ? ` + ${rezumat.batteryKwh} kWh baterii` : ''}`);
    L.push(`  ${rezumat.panouri}, ${rezumat.invertor}`);
    L.push(`  Autosuficienta ${(rezumat.autosuficienta * 100).toFixed(0)}%` +
           `${rezumat.tintaAtinsa === false ? ' (sub tinta ceruta)' : ''}`);
    L.push(`  Investitie estimata ${Math.round(rezumat.capex)} ${rezumat.moneda}`);
    L.push(`  Amortizare ${rezumat.amortizareAni?.toFixed(1)} ani`);
  } else if (rezumat) {
    L.push(`Calculatorul NU a putut recomanda un sistem independent.`);
    L.push(`Solicitantul a cerut off-grid, dar nu e realizabil la locatia lui.`);
    L.push(`Merita sunat: are nevoie de varianta hibrida sau de generator.`);
  }

  L.push('');
  L.push(`Tip sistem cerut : ${rezumat?.topology ?? 'necunoscut'}`);
  L.push(`Consum declarat  : ${rezumat?.consumAnual ?? '?'} kWh/an`);
  L.push(`Locatie          : ${rezumat?.lat}, ${rezumat?.lon}`);
  if (b.mesaj) { L.push(''); L.push(`Mesaj: ${b.mesaj.trim()}`); }
  L.push('');
  L.push(`Consimtamant pentru prelucrarea datelor: DA, ${new Date().toISOString()}`);
  L.push(`Estimare orientativa. Necesita evaluare la fata locului.`);
  return L.join('\n');
}

async function trimiteEmail(t, b, rezumat, dryRun = false) {
  const dest = t.lead?.email;
  if (!dest) return { trimis: false, motiv: 'tenant fara adresa de lead' };

  const cfg = {
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
  };

  const subiect = curataPentruAntet(`Cerere oferta fotovoltaic - ${b.nume}`, 160);
  const corp = corpEmail(t, b, rezumat);

  if (!cfg.host || !cfg.user || !cfg.pass) {
    // Fara SMTP configurat nu trimitem nimic, dar nici nu pretindem ca am
    // trimis. In dezvoltare afisam corpul ca sa se poata verifica textul.
    console.log(`\n--- EMAIL NETRIMIS (SMTP neconfigurat) -> ${dest} ---`);
    console.log(subiect); console.log(corp);
    console.log('--- sfarsit ---\n');
    if (!dryRun) {
      console.warn('ATENTIE: SMTP neconfigurat in productie. Lead-ul NU a ajuns la instalator.');
    }
    return { trimis: false, motiv: 'SMTP neconfigurat', simulat: true };
  }

  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  await transport.sendMail({
    from: cfg.from || cfg.user, to: dest, subject: subiect, text: corp,
    // replyTo trece deja prin RE_EMAIL, care exclude spatiile albe, deci nu
    // poate contine CRLF. Curatam totusi: e antet, si apararea in adancime
    // costa o linie.
    replyTo: b.email ? curataPentruAntet(b.email, 200) : undefined,
  });
  return { trimis: true };
}

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

async function trimiteWebhook(t, b, rezumat) {
  const url = t.lead?.webhook;
  if (!url) return { trimis: false, motiv: 'tenant fara webhook' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant: t.id,
        contact: { nume: b.nume.trim(), email: b.email?.trim() || null,
                   telefon: b.telefon?.trim() || null, oras: b.oras?.trim() || null },
        mesaj: b.mesaj?.trim() || null,
        dimensionare: rezumat,
        consimtamantLa: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(10000),
    });
    return { trimis: res.ok, status: res.status };
  } catch (err) {
    return { trimis: false, motiv: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* Orchestrare                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {boolean} dryRun  Modul de demonstratie (--mock). Emailul simulat
 *   conteaza ca livrat, ca fluxul sa fie parcurgibil fara SMTP. In productie
 *   NU se aplica: daca nu exista nici baza de date, nici mail, nici webhook,
 *   omul primeste numarul de telefon in loc de o falsa confirmare.
 */
export async function preiaLead({ tenant, corp: b, rezumat, dryRun = false }) {
  // Baza de date INAINTE de email: daca mailul cade, lead-ul nu se pierde.
  let db = { salvat: false };
  try { db = await salveaza(tenant.id, b, rezumat); }
  catch (err) { console.error('Salvarea lead-ului a eșuat:', err.message); }

  const [email, webhook] = await Promise.all([
    trimiteEmail(tenant, b, rezumat, dryRun).catch(e => ({ trimis: false, motiv: e.message })),
    trimiteWebhook(tenant, b, rezumat).catch(e => ({ trimis: false, motiv: e.message })),
  ]);

  // Pentru om, cererea a reusit daca a ajuns undeva: baza de date sau mail.
  // Daca nu a ajuns nicaieri, ii spunem sa sune, nu il lasam sa creada ca
  // il va contacta cineva.
  const primit = db.salvat || email.trimis || webhook.trimis
                 || (dryRun && email.simulat === true);
  return { primit, db, email, webhook, dryRun, retentieZile: RETENTIE_ZILE };
}

export { RETENTIE_ZILE };
