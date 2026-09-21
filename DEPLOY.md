# Deployment pe Railway

Ghid pas cu pas. Fă-l în ordinea de aici — Postgres și SMTP întâi, ca să
le testezi separat, apoi deploy-ul propriu-zis.

## 0. Pregătire locală (o dată)

```bash
git init
git add .
git commit -m "solar-engine v1"
```

Dacă `.env` există deja la tine local cu valori reale, verifică să NU fie
inclus în commit — `.gitignore` îl exclude, dar verifică oricum cu
`git status` înainte de primul commit.

## 1. Cont și proiect nou

1. [railway.app](https://railway.app) → autentificare cu GitHub.
2. „New Project" → „Deploy from GitHub repo" (mai simplu decât CLI) —
   pune codul pe un repo GitHub nou dacă nu e deja acolo, apoi îl alegi.
3. Railway detectează automat Node.js din `package.json` și rulează
   `npm install && npm start`.

## 2. Baza de date

1. În același proiect Railway: „New" → „Database" → „Add PostgreSQL".
2. Railway creează serviciul și injectează automat `DATABASE_URL` — dar
   **doar în serviciul de bază de date**, nu automat în serviciul tău de
   aplicație. Trebuie legate:
   - Deschide serviciul aplicației → tab „Variables" → „New Variable" →
     „Add Reference" → alege `DATABASE_URL` din serviciul Postgres.
3. Tabelele (`pvgis_cache`, `leaduri`) se creează singure la prima
   folosire — nu trebuie rulat niciun script de migrare.

## 3. SMTP — testează ÎNAINTE de a pune pe Railway

Cel mai simplu: un cont Gmail dedicat, cu parolă de aplicație (nu parola
normală de cont — Google o generează separat, la
myaccount.google.com → Securitate → Parole aplicații, necesită 2FA activ).

Local, cu variabilele în `.env` (copiat din `.env.example`):

```bash
node --env-file=.env scripts/test-smtp.js adresa-ta@exemplu.ro
```

Dacă scrie `OK Email trimis`, verifică și dacă a ajuns (uneori în spam
la prima trimitere). Abia după ce funcționează local, pui aceleași
variabile pe Railway.

## 4. Variabilele pe Railway

Serviciul aplicației → „Variables" → adaugi, una câte una (vezi
`.env.example` pentru explicații):

```
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=...
NODE_ENV=production
```

`PORT` nu se setează manual — Railway îl injectează automat, iar
`server.js` îl citește din `process.env.PORT`.

**Nu seta `USE_MOCK` sau flagul `--mock` pe Railway.** Acolo trebuie să
ruleze cu date PVGIS reale.

## 5. Domeniu

Railway dă gratuit un subdomeniu de forma `nume-proiect.up.railway.app`,
cu HTTPS inclus automat — suficient pentru linkul de trimis la prospecți.

Dacă vrei domeniu propriu mai târziu: serviciul aplicației → „Settings"
→ „Domains" → „Custom Domain", apoi adaugi un rând CNAME la
registratorul tău de domeniu, către ținta pe care ți-o dă Railway.

## 6. Verificare după deploy

```bash
curl https://numele-tau.up.railway.app/api/health
```

Trebuie să răspundă `{"ok":true,"mock":false}`. Dacă `mock` iese
`true`, flagul `--mock` a ajuns cumva în comanda de pornire — verifică
„Settings" → „Deploy" → „Start Command" (trebuie să fie gol sau
`npm start`, niciodată `npm run dev`).

Apoi deschide widgetul propriu-zis:

```
https://numele-tau.up.railway.app/?t=demo
```

Parcurge tot fluxul o dată, cu date reale de-ale tale — e primul test
cu PVGIS adevărat servit printr-un URL public.

## 7. Testul care contează cel mai mult

Trimite un lead de test prin formular, cu propriul tău email ca
destinatar de contact. Verifică:
- a ajuns emailul la adresa `lead` a tenantului (nu la a ta — vezi
  `tenants.js`, câmpul `lead.email`)
- subiectul și corpul arată cum trebuie
- dacă ai pus și `DATABASE_URL`, rândul a apărut în tabela `leaduri`

Dacă asta funcționează, restul e deja verificat prin cele 68 de teste
automate.

## Ce NU e nevoie să faci

- Nu trebuie Dockerfile — Railway construiește direct din Node.js.
- Nu trebuie migrare de bază de date — tabelele se creează la prima
  cerere.
- Nu trebuie configurare CORS — widgetul și API-ul sunt pe același
  domeniu.
