/**
 * Validare contra PVGIS real.
 *
 * Ruleaza asta LOCAL, unde ai acces la internet. Face trei lucruri:
 *   1. testeaza conversia de azimut fara retea
 *   2. verifica daca apelul PVGIS functioneaza si ce campuri intoarce
 *   3. auto-testeaza conventia de azimut: sud trebuie sa bata nord clar
 *
 * Rulare:  node test/validate-pvgis.js
 */

import { fetchPvgisHourly, compassToPvgisAspect, ORIENTATIONS } from '../src/pvgis.js';

const ok = (n, cond) => console.log(`  ${cond ? 'OK  ' : 'ESEC'}  ${n}`);
const kwh = a => a.reduce((s, w) => s + w, 0) / 1000;

/* ---------- 1. Conversia de azimut, fara retea ---------- */
console.log('\n1. CONVERSIA DE AZIMUT (busola -> PVGIS)\n');
console.log('   PVGIS:  0 = sud,  +90 = vest,  -90 = est,  180 = nord');
for (const [nume, grade] of Object.entries(ORIENTATIONS)) {
  console.log(`   ${nume.padEnd(3)} busola ${String(grade).padStart(3)}deg  ->  PVGIS ${compassToPvgisAspect(grade)}`);
}
console.log();
ok('Sud -> 0',    compassToPvgisAspect(180) === 0);
ok('Vest -> 90',  compassToPvgisAspect(270) === 90);
ok('Est -> -90',  compassToPvgisAspect(90) === -90);
ok('Nord -> -180 sau 180', Math.abs(compassToPvgisAspect(0)) === 180);

/* ---------- 2. Apelul real ---------- */
const LAT = 44.43, LON = 26.10, TILT = 30, LOSS = 14;

console.log('\n2. APEL PVGIS REAL (Bucuresti, sud, 30 grade, 1 kWp, 14% pierderi)\n');

let sud;
try {
  sud = await fetchPvgisHourly({ lat: LAT, lon: LON, tilt: TILT, aspect: 0, systemLoss: LOSS });
} catch (e) {
  console.error(`   ESEC la apel: ${e.message}`);
  console.error('\n   Daca a picat aici, verifica in documentatia PVGIS 6:');
  console.error('     - endpoint-ul curent (PVGIS_BASE din src/pvgis.js)');
  console.error('     - numele parametrilor din querystring');
  console.error('     - numele campurilor din raspuns: P, G(i), T2m, WS10m');
  process.exit(1);
}

console.log(`   Sursa              : ${sud.source}`);
console.log(`   Valori orare       : ${sud.P.length}`);
ok('8760 valori orare', sud.P.length === 8760);
ok('Temperaturi prezente', sud.T2m.some(v => v !== 0));
ok('Viteza vantului prezenta', sud.WS10m.some(v => v !== 0));

const prodSud = kwh(sud.P);
console.log(`\n   >>> PRODUCTIE SPECIFICA: ${prodSud.toFixed(0)} kWh/kWp/an <<<`);

console.log(`
   COMPARA ACUM MANUAL:
   1. Deschide interfata web PVGIS (unealta interactiva)
   2. Introduce exact: lat ${LAT}, lon ${LON}
   3. Tab "Grid connected", siliciu cristalin
   4. Putere instalata 1 kWp, pierderi ${LOSS}%, montaj fix
   5. Inclinatie ${TILT} grade, azimut 0
   6. Citeste "Yearly PV energy production"

   Trebuie sa fie practic acelasi numar ca cel de mai sus.
   Diferenta mare = trimiti gresit un parametru.
   Reper real pentru Bucuresti: 1300-1400 kWh/kWp/an.`);

/* ---------- 3. Auto-test conventie azimut ---------- */
console.log('\n3. AUTO-TEST CONVENTIE AZIMUT\n');

const nord = await fetchPvgisHourly({ lat: LAT, lon: LON, tilt: TILT, aspect: 180, systemLoss: LOSS });
const prodNord = kwh(nord.P);
const raport = prodNord / prodSud;

console.log(`   Sud  (aspect 0)   : ${prodSud.toFixed(0)} kWh/kWp/an`);
console.log(`   Nord (aspect 180) : ${prodNord.toFixed(0)} kWh/kWp/an`);
console.log(`   Raport nord/sud   : ${(raport * 100).toFixed(0)} %`);

ok('Sudul produce mai mult decat nordul', prodSud > prodNord);
ok('Raportul e in intervalul asteptat (45-75%)', raport > 0.45 && raport < 0.75);

if (prodNord >= prodSud) {
  console.log(`
   ATENTIE: nordul produce mai mult decat sudul. Semnul azimutului e
   inversat undeva. Verifica compassToPvgisAspect() si parametrul
   'aspect' trimis catre API.`);
}

console.log(`
${'='.repeat(60)}
CE VALIDEAZA TESTUL ASTA — SI CE NU

  Valideaza : lantul PVGIS, parametrii trimisi, conventia de azimut,
              productia fotovoltaica.
  NU valideaza: profilul de consum sintetizat, logica de descarcare a
              bateriei, cifrele de autoconsum.

Pentru partea de consum nu exista oracol extern. Sunt estimari facute
din arhetipuri. Se valideaza altfel: le arati unui instalator care
vede sute de curbe reale, sau le compari cu date de contor inteligent
daca poti obtine un set.
${'='.repeat(60)}`);
