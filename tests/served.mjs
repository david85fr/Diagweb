/* Diagweb — la page RÉELLE, celle que sert le serveur de diagnostic.
 *
 *   node tests/served.mjs [http://localhost:8080]
 *
 * Les autres tests d'interface (tests/ui.mjs) ouvrent le livrable `dist/` en
 * simulation navigateur : ils ne voient jamais la source WebSocket, donc ni le
 * recalage d'horloge, ni ce que le serveur annonce à l'ouverture. C'est
 * pourtant la page que regarde un exploitant. On la charge ici pour de vrai,
 * serveur en fonctionnement, et on vérifie qu'elle est saine.
 *
 * Le serveur de diagnostic doit tourner (tools/run-server-tests.sh s'en charge).
 * Sans Playwright ni Chromium, le test se déclare ignoré plutôt qu'échoué :
 * le poste qui n'a pas joué tools/setup-tests.sh n'a rien à se reprocher.
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8080';
const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch {
  try { ({ chromium } = await import('playwright')); }
  catch {
    console.log('tests/served.mjs ignoré : Playwright absent (bash tools/setup-tests.sh)');
    process.exit(0);
  }
}

/** Chromium préinstallé (poste, conteneur) sinon celui de Playwright. */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (d.startsWith('chromium-') && fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

console.log('Cible : ' + BASE + '/web/index.html\n');

const exec = findChromium();
let browser;
try {
  browser = await chromium.launch({
    ...(exec ? { executablePath: exec } : {}),
    args: ['--no-sandbox'],
  });
} catch (e) {
  console.log('tests/served.mjs ignoré : Chromium introuvable (' + e.message.split('\n')[0] + ')');
  process.exit(0);
}

const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const erreurs = [], reseau = [];
page.on('console', (m) => { if (m.type() === 'error') erreurs.push(m.text()); });
page.on('pageerror', (e) => erreurs.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() >= 400) reseau.push(r.status() + ' ' + r.url()); });
page.on('requestfailed', (r) =>
  reseau.push('échec ' + r.url() + ' — ' + ((r.failure() || {}).errorText || '')));

const etat = () => page.evaluate(() => ({
  nom: DW.source && DW.source.name,
  live: !!(DW.source && DW.source.isLive && DW.source.isLive()),
  now: DW.source ? DW.source.now() : null,
  capture: DW.source && DW.source.captureStart ? DW.source.captureStart() : null,
  abonnees: DW.source ? DW.source.count() : 0,
}));

await page.goto(BASE + '/web/index.html', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.DW && DW.source && DW.source.now, null, { timeout: 15000 });

// L'origine de capture ne se distingue du démarrage du serveur que si celui-ci
// tourne depuis un moment : on l'attend, puis on recharge la page.
const MINI = 20;
let e = await etat();
if (e.now < MINI) {
  await sleep((MINI - e.now) * 1000 + 500);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.DW && DW.source && DW.source.now, null, { timeout: 15000 });
}
await sleep(2500);
e = await etat();

check('page servie : chargée sans erreur ni ressource manquante',
  erreurs.length === 0 && reseau.length === 0,
  erreurs.concat(reseau).join(' · ') || 'aucune erreur console, aucune 404');

// Le flux : on s'abonne explicitement plutôt que de compter sur la disposition
// restaurée, qui dépend du stockage local du navigateur.
const flux = await page.evaluate(async () => {
  DW.source.subscribe('MB414', { periodMs: 20 });
  await new Promise((r) => setTimeout(r, 1500));
  const d = DW.source.data('MB414');
  return { points: d.ts.length, dernier: d.ts.length ? d.ts[d.ts.length - 1] : null,
           now: DW.source.now() };
});
check('flux temps réel : le serveur alimente la page',
  e.nom === 'Serveur de diagnostic' && e.live && flux.points > 10 &&
  flux.now - flux.dernier < 2,
  e.nom + ' · ' + flux.points + ' points en 1,5 s');

// Le défaut corrigé : l'origine était datée sur l'horloge locale (≈ 0 au
// chargement) puis relue sur celle du serveur, si bien qu'une page à peine
// ouverte annonçait une capture aussi vieille que le serveur.
const age = e.capture == null ? null : e.now - e.capture;
check('origine de capture : l’ouverture de la page, pas le démarrage du serveur',
  age != null && age >= 0 && age < 10 && e.now > MINI,
  age == null ? 'captureStart absent'
    : 'capture ' + age.toFixed(1) + ' s alors que le serveur tourne depuis ' +
      e.now.toFixed(0) + ' s');

await browser.close();

console.log('');
console.log(`${results.length - failed}/${results.length} vérifications réussies`);
process.exit(failed ? 1 : 0);
