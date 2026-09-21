import { valideazaLead } from '../src/lead.js';

const check = (n, ok) => console.log(`  ${ok ? 'OK  ' : 'ESEC'}  ${n}`);
const bun = { nume: 'Ion Popescu', telefon: '0721 123 456', email: 'ion@exemplu.ro',
              oras: 'București', consimtamant: true };

console.log('\n### VALIDAREA LEAD-ULUI ###\n');

check('Lead complet trece', valideazaLead(bun).length === 0);
check('Doar telefon e suficient', valideazaLead({ ...bun, email: undefined }).length === 0);
check('Doar email e suficient', valideazaLead({ ...bun, telefon: undefined }).length === 0);
check('Fara contact e respins', valideazaLead({ ...bun, email: undefined, telefon: undefined }).length > 0);
check('Nume prea scurt e respins', valideazaLead({ ...bun, nume: 'A' }).length > 0);
check('Nume lipsa e respins', valideazaLead({ ...bun, nume: undefined }).length > 0);
check('Email invalid e respins', valideazaLead({ ...bun, email: 'ion@', telefon: undefined }).length > 0);
check('Telefon prea scurt e respins', valideazaLead({ ...bun, telefon: '0721', email: undefined }).length > 0);
check('Mesaj prea lung e respins', valideazaLead({ ...bun, mesaj: 'x'.repeat(2500) }).length > 0);
check('Nume absurd de lung e respins', valideazaLead({ ...bun, nume: 'x'.repeat(200) }).length > 0);

/* Consimtamantul e piesa juridica: se bifeaza, nu se presupune. */
check('Fara consimtamant e respins', valideazaLead({ ...bun, consimtamant: undefined }).length > 0);
check('Consimtamant false e respins', valideazaLead({ ...bun, consimtamant: false }).length > 0);
check('Consimtamant "true" ca text e respins', valideazaLead({ ...bun, consimtamant: 'true' }).length > 0);
check('Consimtamant 1 ca numar e respins', valideazaLead({ ...bun, consimtamant: 1 }).length > 0);

console.log(`
  Ultimele patru conteaza mai mult decat par: un consimtamant care se
  strecoara pe orice valoare "truthy" nu e consimtamant. Trebuie sa fie
  exact true, adica o bifa pe care omul a apasat-o.`);

/* --- injectie in antete --- */
import { curataPentruAntet } from '../src/lead.js';

console.log('\n### INJECTIE IN ANTETE ###\n');

const rau = 'Ion Popescu\r\nBcc: atacator@rau.ro';
check('Nume cu sfarsit de linie e respins', valideazaLead({ ...bun, nume: rau }).length > 0);
check('Nume cu tab/control e respins', valideazaLead({ ...bun, nume: 'Ion\u0007Popescu' }).length > 0);
check('Curatarea elimina CR si LF', !/[\r\n]/.test(curataPentruAntet(rau)));
check('Curatarea pastreaza textul util', curataPentruAntet(rau).startsWith('Ion Popescu'));
check('Curatarea taie separatorii Unicode', !/[\u2028\u2029]/.test(curataPentruAntet('a\u2028b')));
check('Curatarea limiteaza lungimea', curataPentruAntet('x'.repeat(500), 160).length <= 160);
check('Curatarea suporta null', curataPentruAntet(null) === '');

console.log(`
  Subiectul emailului se construieste din numele introdus de vizitator.
  Un sfarsit de linie in nume inchide antetul si deschide altul - un Bcc
  catre o adresa straina, de exemplu. Nodemailer 10 se apara si singur,
  dar nu ne bazam pe biblioteca: respingem la validare si curatam la
  scriere.`);
