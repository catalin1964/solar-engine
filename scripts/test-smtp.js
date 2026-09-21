/**
 * Test SMTP izolat, inainte de deploy.
 *
 * Verifica DOAR conexiunea si trimiterea unui email real - nu atinge
 * baza de date, nu porneste serverul. Ruleaza-l cand ai variabilele SMTP
 * gata, ca sa prinzi o parola gresita sau un port blocat local, nu in
 * fata unui prospect la targ.
 *
 * Rulare:
 *   node --env-file=.env scripts/test-smtp.js destinatar@exemplu.ro
 *
 * Daca nu ai Node 20+ cu --env-file, exporta variabilele manual inainte:
 *   export SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASS=...
 *   node scripts/test-smtp.js destinatar@exemplu.ro
 */

const dest = process.argv[2];
if (!dest) {
  console.error('Foloseste: node scripts/test-smtp.js destinatar@exemplu.ro');
  process.exit(1);
}

const cfg = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.SMTP_FROM,
};

const lipsa = Object.entries({ SMTP_HOST: cfg.host, SMTP_USER: cfg.user, SMTP_PASS: cfg.pass })
  .filter(([, v]) => !v).map(([k]) => k);
if (lipsa.length) {
  console.error(`Lipsesc variabilele: ${lipsa.join(', ')}`);
  console.error('Vezi .env.example pentru lista completa.');
  process.exit(1);
}

console.log(`Conectare la ${cfg.host}:${cfg.port} ca ${cfg.user}...`);

const { default: nodemailer } = await import('nodemailer');
const transport = nodemailer.createTransport({
  host: cfg.host, port: cfg.port, secure: cfg.port === 465,
  auth: { user: cfg.user, pass: cfg.pass },
});

try {
  await transport.verify();
  console.log('OK   Conexiunea si autentificarea functioneaza.');
} catch (err) {
  console.error('ESEC Conexiune/autentificare:', err.message);
  console.error('Verifica host, port, user, parola (pentru Gmail: parola de aplicatie, nu cea de cont).');
  process.exit(1);
}

try {
  const info = await transport.sendMail({
    from: cfg.from || cfg.user,
    to: dest,
    subject: 'Test SMTP - calculator fotovoltaic',
    text: `Daca citesti asta, SMTP-ul e configurat corect.\n\nTrimis: ${new Date().toISOString()}`,
  });
  console.log(`OK   Email trimis, id: ${info.messageId}`);
  console.log(`Verifica inboxul (si spam-ul) pentru ${dest}.`);
} catch (err) {
  console.error('ESEC Trimiterea a esuat:', err.message);
  process.exit(1);
}
