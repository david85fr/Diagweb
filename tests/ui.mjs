/* Diagweb — tests d'interface (Playwright, sans cadre de test).
 *
 *   node tests/ui.mjs                                  → dist/index.html
 *   node tests/ui.mjs http://localhost:8080/web/index.html
 *
 * Prérequis : bash tools/setup-tests.sh (installe Playwright + Chromium).
 * Sortie : liste des vérifications, code de retour non nul si échec.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.argv[2] || process.env.DIAGWEB_URL ||
  'file://' + path.join(ROOT, 'dist', 'index.html');
const SHOTS = process.env.DIAGWEB_SHOTS || path.join(ROOT, '.test-shots');

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { ({ chromium } = await import('playwright')); }

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

const results = [];
function check(label, ok, info) {
  results.push({ label, ok: !!ok, info });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${info ? ' — ' + info : ''}`);
}

const PANE = '.tabpane.on ';
const errors = [];

const exec = findChromium();
const browser = await chromium.launch({
  ...(exec ? { executablePath: exec } : {}),
  args: ['--no-sandbox'],
});
console.log(`Cible : ${TARGET}\n`);
fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- mobile
console.log('Mobile 390×844 (thème sombre)');
const mob = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark',
});
const p1 = await mob.newPage();
p1.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
p1.on('console', (m) => { if (m.type() === 'error') errors.push('mobile console: ' + m.text()); });
await p1.goto(TARGET);
// L'application démarre après le choix de la source (simulation ou serveur) :
// on attend le premier graphique plutôt qu'un délai fixe.
await p1.waitForSelector(PANE + '.chart-card', { timeout: 20000 });
await p1.waitForTimeout(1200);

check('disposition de démonstration chargée',
  await p1.locator(PANE + '.chart-card').count() === 2 &&
  await p1.locator(PANE + '.vrow').count() === 6);

await p1.fill('#searchInput', 'MB520');
await p1.selectOption('#targetSel', 'table');
await p1.click('#addBtn');
await p1.waitForTimeout(300);
check('ajout au tableau numérique', await p1.locator(PANE + '.vrow').count() === 7);

await p1.fill('#searchInput', 'Elec.frequence');
await p1.selectOption('#targetSel', 'new');
await p1.click('#addBtn');
await p1.waitForTimeout(400);
check('ajout dans un nouveau graphique', await p1.locator(PANE + '.chart-card').count() === 3);

await p1.fill('#searchInput', 'Z99!!');
await p1.click('#addBtn');
await p1.waitForTimeout(200);
check('adresse invalide refusée', await p1.locator('.toast.err').count() >= 1);

// Onglets : isolement des configurations
await p1.click('#tabAdd');
await p1.waitForTimeout(300);
const tab2Empty = await p1.locator(PANE + '.vrow').count() === 0;
await p1.fill('#searchInput', 'S1.0');
await p1.selectOption('#targetSel', 'table');
await p1.click('#addBtn');
await p1.waitForTimeout(300);
const tab2One = await p1.locator(PANE + '.vrow').count() === 1;
await p1.locator('.tab').first().click();
await p1.waitForTimeout(300);
check('onglets isolés (nouvel onglet vide, retour intact)',
  tab2Empty && tab2One && await p1.locator(PANE + '.vrow').count() === 7);

// Journal de données
await p1.click('#logBtn');
await p1.waitForTimeout(250);
await p1.click('#logToggle');
await p1.waitForTimeout(2200);
const logTxt = await p1.locator('#logStatus').textContent();
check('journal en cours d\'enregistrement', /En cours/.test(logTxt), logTxt.slice(0, 48));
await p1.click('.m-close');

// Menu d'une pastille de légende + bascule ouvrir/fermer
const chip = p1.locator(PANE + '.chart-card').first().locator('.chip').first();
await chip.click();
await p1.waitForTimeout(150);
const menu1 = await p1.locator('.popmenu').count();
await chip.click();
await p1.waitForTimeout(250);
check('menu de courbe : ouverture puis fermeture par la pastille',
  menu1 === 1 && await p1.locator('.popmenu').count() === 0);

// Configurations : enregistrement puis relecture
await p1.click('#layoutsBtn');
await p1.waitForTimeout(250);
await p1.fill('#layName', 'Test auto');
await p1.click('.acc-btn[data-acc="save"]');
await p1.click('#laySaveLocal');
await p1.click('.acc-btn[data-acc="load"]');
await p1.waitForTimeout(200);
check('configuration enregistrée dans le navigateur',
  await p1.locator('.lay-row').count() >= 1);
await p1.click('.m-close');
await p1.waitForTimeout(800);
await p1.screenshot({ path: path.join(SHOTS, 'mobile.png') });

await p1.reload();
await p1.waitForTimeout(1500);
check('session restaurée au rechargement (onglets + journal)',
  await p1.locator('.tab').count() === 2 &&
  await p1.locator(PANE + '.vrow').count() === 7 &&
  await p1.locator('.tab .recdot').count() === 1);
await mob.close();

// --------------------------------------------------------------- desktop
console.log('\nDesktop 1600×900 (thème clair)');
const desk = await browser.newContext({ viewport: { width: 1600, height: 900 }, colorScheme: 'light' });
const p2 = await desk.newPage();
p2.on('pageerror', (e) => errors.push('desktop pageerror: ' + e.message));
p2.on('console', (m) => { if (m.type() === 'error') errors.push('desktop console: ' + m.text()); });
await p2.goto(TARGET);
await p2.waitForSelector(PANE + '.chart-card', { timeout: 20000 });
await p2.waitForTimeout(1200);

const bodyH = await p2.locator('.chart-body').first().evaluate((el) => el.getBoundingClientRect().height);
check('hauteur des graphiques adaptée à l\'écran (32vh)',
  Math.abs(bodyH - 288) < 12, Math.round(bodyH) + ' px');

const card = p2.locator('.chart-card').first();
const more = card.locator('.chart-more');
await more.click(); await p2.waitForTimeout(120);
await p2.locator('.popmenu button', { hasText: 'Plein écran' }).click();
await p2.waitForTimeout(200);
const fsOn = await p2.locator('.chart-card.fs').count() === 1;
await more.click(); await p2.waitForTimeout(150);
const menuHit = await p2.evaluate(() => {
  const m = document.querySelector('.popmenu');
  if (!m) return false;
  const r = m.getBoundingClientRect();
  return m.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 10));
});
await p2.keyboard.press('Escape');
await p2.waitForTimeout(200);
check('plein écran : menu accessible, sortie par Échap',
  fsOn && menuHit && await p2.locator('.chart-card.fs').count() === 0);

// Le menu ⋮ est resté ouvert : on le congédie hors du graphique (le
// re-cliquer refermerait le menu au lieu de l'ouvrir — bascule voulue).
await p2.mouse.click(5, 5);
await p2.waitForTimeout(150);

// Duplication d'un graphique (courbes et couleurs comprises)
const nBefore = await p2.locator(PANE + '.chart-card').count();
await more.click(); await p2.waitForTimeout(120);
await p2.locator('.popmenu button', { hasText: 'Dupliquer' }).click();
await p2.waitForTimeout(500);
const titles = await p2.locator(PANE + '.chart-title').evaluateAll((els) => els.map((e) => e.value));
check('duplication d\'un graphique (inséré juste après, mêmes courbes)',
  await p2.locator(PANE + '.chart-card').count() === nBefore + 1 &&
  /\(copie\)$/.test(titles[1]) &&
  await p2.locator(PANE + '.chart-card').nth(0).locator('.chip').count() ===
  await p2.locator(PANE + '.chart-card').nth(1).locator('.chip').count(),
  titles.join(' · '));

// Couleur d'une courbe : emplacement de palette, conservé au rechargement
const swatch = () => p2.locator(PANE + '.chart-card').first().locator('.chip').first().locator('.sw');
const colBefore = await swatch().evaluate((el) => getComputedStyle(el).backgroundColor);
await p2.locator(PANE + '.chart-card').first().locator('.chip').first().click();
await p2.waitForTimeout(180);
const nSwatches = await p2.locator('.pop-swatches .sw-btn').count();
await p2.locator('.pop-swatches .sw-btn').nth(5).click();
await p2.waitForTimeout(700);
const colAfter = await swatch().evaluate((el) => getComputedStyle(el).backgroundColor);
await p2.reload();
await p2.waitForSelector(PANE + '.chart-card', { timeout: 20000 });
await p2.waitForTimeout(1200);
const colReload = await swatch().evaluate((el) => getComputedStyle(el).backgroundColor);
check('couleur de courbe choisie et conservée au rechargement',
  nSwatches === 8 && colAfter !== colBefore && colReload === colAfter,
  `${colBefore} → ${colAfter}`);

// Zoom extrême sur une règle d'axe : la page doit rester réactive
const cv = p2.locator('.chart-card').first().locator('canvas');
const box = await cv.boundingBox();
await p2.mouse.move(box.x + 20, box.y + box.height / 2);
for (let i = 0; i < 220; i++) await p2.mouse.wheel(0, -100);
await p2.waitForTimeout(400);
let alive = false;
try { alive = await p2.evaluate(() => 1 + 1, { timeout: 3000 }) === 2; } catch { alive = false; }
check('zoom extrême sur une règle : page toujours réactive', alive);

// Curseur de mesure épinglé à la souris
await p2.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await p2.mouse.move(box.x - 40, box.y - 40);
await p2.waitForTimeout(300);
check('clic bref : curseur de mesure épinglé',
  await card.locator('.chart-tip:visible').count() === 1);

await p2.screenshot({ path: path.join(SHOTS, 'desktop.png') });
await desk.close();
await browser.close();

// ----------------------------------------------------------------- bilan
console.log('');
if (errors.length) {
  console.log('Erreurs console/page :');
  for (const e of errors) console.log('  ' + e);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} vérifications réussies` +
  (errors.length ? `, ${errors.length} erreur(s) console` : ', aucune erreur console'));
console.log(`Captures : ${SHOTS}`);
process.exit(failed || errors.length ? 1 : 0);
