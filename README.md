# solar-engine — v1, săptămâna 1

Motorul de calcul pentru instrumentul de dimensionare fotovoltaică white-label.
Fără interfață, fără API HTTP încă — doar nucleul, testabil din linia de comandă.

## Ce e făcut

- **`src/pvgis.js`** — client PVGIS + cache pe grilă de 0.1° (Postgres dacă există `DATABASE_URL`, altfel fișiere)
- **`src/loadProfile.js`** — sinteza profilului orar de consum din consum anual + arhetip + bife
- **`src/simulate.js`** — simulare 8760 h cu stare de încărcare a bateriei, trei topologii
- **`src/mockWeather.js`** — generator sintetic, **numai pentru teste offline**
- **`src/index.js`** — orchestrare

## Rulare

```bash
npm install
node test/run.js
```

Rulează cinci scenarii pe date sintetice și șapte verificări de coerență.

## Trecerea pe date reale

În `runScenario()`, scoate `useMock: true`. Atât. Interfața sursei de date e identică.

Containerul în care a fost scris codul nu are acces la `re.jrc.ec.europa.eu`,
deci clientul PVGIS **nu a fost testat contra serviciului real**. Primul lucru
de făcut local:

```js
import { fetchPvgisHourly } from './src/pvgis.js';
const d = await fetchPvgisHourly({ lat: 44.43, lon: 26.10, tilt: 30, aspect: 0 });
console.log(d.P.length, d.P.reduce((a,b)=>a+b,0)/1000); // ~8760, ~1300 kWh/kWp
```

Verifică și numele exact al câmpurilor din răspuns (`G(i)`, `T2m`, `WS10m`) —
PVGIS 6 a introdus un API nou și formatul se poate să difere de v5.2.

## Validarea motorului — oracolul gratuit

```bash
node test/validate-pvgis.js
```

Rulează asta **local**, unde ai internet. Face trei lucruri: testează conversia
de azimut fără rețea, verifică dacă apelul PVGIS funcționează și ce câmpuri
întoarce, și auto-testează convenția de azimut (sudul trebuie să bată nordul
clar — dacă nu, semnul e inversat undeva).

Apoi compară manual cu interfața web PVGIS: aceleași date de intrare,
aceeași producție anuală. Pentru că am pus `pvcalculation=1`, PVGIS face
calculul fotovoltaic, nu tu — deci testul verifică dacă **trimiți parametrii
corect**, nu dacă fizica e bună. Numerele trebuie să fie practic identice, nu
doar apropiate.

Valori reale de referință, panouri sud, 30°:
- București ≈ 1300–1400 kWh/kWp/an
- Bruxelles ≈ 950–1050 kWh/kWp/an

Generatorul sintetic dă acum 1257 și 1105 — corect ca ordin de mărime,
dar **nu-l folosi niciodată pentru cifre arătate cuiva.**

### Ce NU validează comparația cu PVGIS

Doar jumătatea de producție. Profilul de consum sintetizat, logica de
descărcare a bateriei și cifrele de autoconsum rămân nevalidate — pentru ele
nu există oracol extern, sunt estimări făcute din arhetipuri.

Se validează altfel: le arăți unui instalator care vede sute de curbe reale de
consum, sau le compari cu un set de date de contor inteligent dacă poți obține
unul. Până atunci, tratează procentul de autoconsum ca estimare, nu ca adevăr —
și scrie asta în PDF.

## Capcane documentate în cod

1. **Azimut.** PVGIS folosește 0 = sud, +90 = vest, −90 = est. Nu e convenția
   busolei. Conversia e în `compassToPvgisAspect()`.

2. **Fus orar.** PVGIS livrează UTC. Profilul de consum e în oră locală. Fără
   `shiftToLocal()`, vârful PV și vârful de consum de seară sunt nealiniate și
   autoconsumul iese fals — greșit în tăcere, fără nicio eroare.

3. **Economia la off-grid.** Energia neacoperită nu e energie economisită.
   Fără corecția din `simulate.js`, un sistem subdimensionat care lasă clientul
   pe întuneric jumătate din an raportează economie maximă. Bug găsit la primul
   test — verifică dacă reapare după orice refactorizare.

## Ce arată testele

Scenariul 4 e cel care contează comercial: **16 kWp + 40 kWh baterie** — de trei
ori panourile și de patru ori stocarea față de un sistem normal — tot lasă
**1300 de ore de pană pe an**, aproape toate în noiembrie–februarie.

Raportul producție decembrie/iunie iese ~20%. Ăsta e motivul pentru care
dimensionarea se face pe luna cea mai proastă, nu pe media anuală, și e cel mai
bun argument de vânzare pe care îl ai: instrumentul îl împiedică pe instalator
să livreze un sistem care cedează în ianuarie.

## Săptămâna 2

- Rezolvitorul de dimensionare: căutare pe grilă (kWp × kWh) până la obiectiv
- Regula lunii celei mai proaste, cu prag explicit de probabilitate de deficit
- Maparea pe catalogul de produse al clientului → listă de materiale
