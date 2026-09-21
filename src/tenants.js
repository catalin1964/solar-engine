/**
 * Configuratie per client (tenant).
 *
 * In productie vine din Postgres. Aici, doua exemple: unul demonstrativ
 * cu brand neutru inventat - ala e ce trimiti ca link prospectilor - si
 * unul care arata cum se suprascrie catalogul si culoarea.
 */

import { CATALOG_DEMO } from './catalog.js';

export const TENANTS = {
  demo: {
    id: 'demo',
    nume: 'Solaris Instal',              // brand inventat pentru demo
    culoare: '#0F6E6E',
    logoUrl: null,
    telefon: '07xx xxx xxx',
    email: 'oferte@exemplu.ro',
    domeniiPermise: ['*'],               // demo public
    limba: 'ro',
    tarife: { gridPrice: 1.30, exportPrice: 0.40, moneda: 'RON' },
    // Productia anuala nu depaseste consumul cu mai mult de atat.
    // In Romania racordul de prosumator e limitat de puterea contractata;
    // fara plafon, solverul propune sisteme pe care operatorul nu le aproba.
    maxProductionRatio: 1.2,
    // Nu propunem sisteme care nu se amortizeaza in durata lor de viata.
    maxPaybackYears: 15,
    catalog: CATALOG_DEMO,
    lead: { email: 'lead@exemplu.ro', webhook: null },
  },

  // Energis (Prima Electro Construct SRL) - prospect real, verificat pentru
  // potrivire cu profilul rezidential, nu din reteaua lui Cătălin.
  // Confirmat de pe site-ul lor: firma, atestatele ANRE, telefonul,
  // emailul (decodat din protectia anti-spam a paginii) si acum si
  // culoarea de brand, dintr-o captura trimisa de Cătălin.
  //
  // Acest tenant e pentru DEMO DE VANZARE, nu pentru live. Nu trimite
  // lead-uri reale catre energis pana nu confirma explicit ca vor sa fie
  // clienti - pana atunci, lead.email ramane gol intentionat.
  energis: {
    id: 'energis',
    nume: 'Energis',
    culoare: '#7AB648',                  // verde real din logo-ul lor (confirmat din captura)
    logoUrl: 'https://www.energis.ro/wp-content/uploads/2022/04/energis-v3-01.png',
    telefon: '021.555.78.73',
    email: 'vanzari@energis.ro',
    domeniiPermise: ['energis.ro', 'www.energis.ro'],
    limba: 'ro',
    tarife: { gridPrice: 1.30, exportPrice: 0.40, moneda: 'RON' },
    maxProductionRatio: 1.2,
    maxPaybackYears: 15,
    catalog: CATALOG_DEMO,               // catalogul lor real, cand il au
    lead: { email: '', webhook: null },  // intentionat gol - vezi nota de mai sus
  },
  // Pro Green Construct - demo cu brand real, dar NEUTRU in raport cu
  // instalatorii carora li se arata (nu e ei insisi instalator de
  // fotovoltaice, dupa cate stim). Gandit pentru prezentari la mai multi
  // prospecti deodata - spre deosebire de tenantul `energis`, care e
  // pregatit specific pentru Energis si NU trebuie aratat altor instalatori
  // (ar parea ca le arati produsul unui concurent de-al lor).
  //
  // Logo-ul e servit local (public/assets/progreen-logo.jpg), nu de pe alt
  // domeniu - nu depinde de accesul lor la retea sa se incarce, spre
  // deosebire de logo-ul Energis.
  //
  // Culoarea #187A2F e extrasa din gradientul logo-ului, ales pe punctul
  // care trece pragul de contrast pentru text alb pe buton (5.4:1) -
  // verdele cel mai deschis din logo (~#32BE32) pica sub minimul de
  // lizibilitate (2.5:1).
  progreen: {
    id: 'progreen',
    nume: 'Pro Green Construct',
    culoare: '#187A2F',
    logoUrl: '/assets/progreen-logo.jpg',
    telefon: '',                         // TODO: completeaza cand ai nevoie de rutare reala
    email: '',
    domeniiPermise: ['*'],
    limba: 'ro',
    tarife: { gridPrice: 1.30, exportPrice: 0.40, moneda: 'RON' },
    maxProductionRatio: 1.2,
    maxPaybackYears: 15,
    catalog: CATALOG_DEMO,
    lead: { email: '', webhook: null },  // gol intentionat - vezi nota din server.js despre modul demo
  },
};

export function getTenant(id) {
  return TENANTS[id] ?? TENANTS.demo;
}

/** Doar ce are voie sa vada browserul. Preturile din catalog raman pe server. */
export function tenantPublic(t) {
  return {
    id: t.id, nume: t.nume, culoare: t.culoare, logoUrl: t.logoUrl,
    telefon: t.telefon, email: t.email, limba: t.limba,
    moneda: t.tarife.moneda,
    gridPrice: t.tarife.gridPrice,
    // Widget-ul foloseste asta ca sa decida daca are voie sa scrie numele
    // companiei in text de consimtamant ("X va primi datele tale...").
    // Fara adresa de lead, nimeni nu primeste cu adevarat datele - deci
    // nu e corect sa numim o firma reala ca destinatar cand nu e.
    areLeadReal: Boolean(t.lead?.email),
  };
}
