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
await p1.selectOption('#targetSel', { index: 0 });
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
await p1.selectOption('#targetSel', { index: 0 });
await p1.click('#addBtn');
await p1.waitForTimeout(300);
const tab2One = await p1.locator(PANE + '.vrow').count() === 1;
await p1.locator('.tab').first().click();
await p1.waitForTimeout(300);
check('onglets isolés (nouvel onglet vide, retour intact)',
  tab2Empty && tab2One && await p1.locator(PANE + '.vrow').count() === 7);

// Rangement de la barre : tout ce qui ne dépend pas du contenu affiché vit
// dans le menu général ☰ (journal, configurations) ; « Figer » est dans la
// barre du haut ; créer une tuile se fait dans la liste des destinations. La
// rangée d'actions sous les onglets n'existe plus.
check('barre rangée : journal et configurations dans le menu ☰',
  await p1.locator('#menuPanel #logBtn').count() === 1 &&
  await p1.locator('#menuPanel #layoutsBtn').count() === 1 &&
  await p1.locator('.tabActions').count() === 0 &&
  await p1.locator('.topIcons #pauseAllBtn').count() === 1 &&
  await p1.locator('#targetSel option[value="newtable"]').count() === 1 &&
  await p1.locator('#targetSel option[value="new"]').count() === 1,
  '« Figer » en haut, création de tuile dans la liste des destinations');
await p1.click('#menuBtn');
await p1.waitForTimeout(150);
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
await p1.click('#menuBtn');
await p1.waitForTimeout(150);
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

// Mosaïque repliée sur téléphone : une seule colonne quoi qu'en dise la
// disposition (ici une tuile large, venue d'un poste de travail), poignée
// masquée — mais la HAUTEUR choisie est conservée, traduite en pixels.
const mobSize = await p1.locator(PANE + '.chart-card').first().evaluate((el) => {
  el.style.setProperty('--tx', '4'); el.style.setProperty('--tw', '6');
  el.style.setProperty('--th', '14');
  const r = {
    h: el.querySelector('.chart-body').getBoundingClientRect().height,
    w: Math.round(el.getBoundingClientRect().width),
    grille: Math.round(el.parentElement.getBoundingClientRect().width),
    grip: getComputedStyle(el.querySelector('.resize-grip')).display,
  };
  el.style.setProperty('--tw', '6'); el.style.setProperty('--th', '9');
  return r;
});
check('mobile : mosaïque repliée en une colonne, hauteur conservée',
  mobSize.grip === 'none' && mobSize.w === mobSize.grille && mobSize.h > 420,
  `carte ${mobSize.w} px sur ${mobSize.grille}, corps ${Math.round(mobSize.h)} px`);
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

// Le contenu remplit sa tuile : sans cela, la hauteur tirée à la poignée
// laisserait du vide sous le tracé et le redimensionnement semblerait sans
// effet — c'est précisément ce qui clochait dans la version précédente.
const remplit = await p2.locator(PANE + '.chart-card').first().evaluate((el) => {
  const c = el.getBoundingClientRect(), b = el.querySelector('.chart-body').getBoundingClientRect();
  const l = el.querySelector('.chart-legend').getBoundingClientRect();
  return { carte: Math.round(c.height), reste: Math.round(c.bottom - l.bottom),
           corps: Math.round(b.height) };
});
check('le contenu remplit la tuile (aucun vide sous le graphique)',
  remplit.reste >= 0 && remplit.reste < 12 && remplit.corps > 100,
  `carte ${remplit.carte} px · corps ${remplit.corps} px · reste ${remplit.reste} px`);

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

// Poignée ◢ d'un graphique : la taille tenue est conservée au rechargement et
// « Taille de départ » (menu ⋮) la remet à sa valeur d'origine.
const geom = () => p2.locator(PANE + '.chart-card').first().evaluate((el) => ({
  w: +el.style.getPropertyValue('--tw'), h: +el.style.getPropertyValue('--th'),
  px: Math.round(el.getBoundingClientRect().width),
}));
const g0 = await geom();
const grip = p2.locator(PANE + '.chart-card').first().locator('.resize-grip');
await grip.scrollIntoViewIfNeeded();
// La barre d'état est fixée en bas : on dégage la poignée de dessous.
await p2.evaluate(() => window.scrollBy(0, 120));
await p2.waitForTimeout(200);
const gb = await grip.boundingBox();
await p2.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await p2.mouse.down();
await p2.mouse.move(gb.x + gb.width / 2 - 260, gb.y + gb.height / 2 + 130, { steps: 12 });
await p2.mouse.up();
await p2.waitForTimeout(900);   // > debounce de sauvegarde de session
const g1 = await geom();
await p2.reload();
await p2.waitForSelector(PANE + '.chart-card', { timeout: 20000 });
await p2.waitForTimeout(1200);
const g2 = await geom();
await p2.locator(PANE + '.chart-card').first().locator('.chart-more').click();
await p2.waitForTimeout(150);
await p2.locator('.popmenu button', { hasText: 'Taille de départ' }).click();
await p2.waitForTimeout(400);
const g3 = await geom();
check('taille d’une tuile : tenue, mémorisée, et remise à la taille de départ',
  g1.w === g0.w - 2 && g1.h === g0.h + 3 && g1.px < g0.px - 150 &&
  g2.w === g1.w && g2.h === g1.h && g3.w === 6 && g3.h === 9,
  `${g0.w}×${g0.h} → ${g1.w}×${g1.h} → recharge ${g2.w}×${g2.h} → départ ${g3.w}×${g3.h}`);

// Liens réseau : déclarer un lien, un point, puis l'ajouter au diagnostic
await p2.click('#menuBtn');
await p2.waitForTimeout(150);
await p2.click('#netBtn');
await p2.waitForSelector('.modal[aria-label="Liens réseau"]', { timeout: 5000 });
await p2.locator('.m-actions .btn', { hasText: '+ Nouveau lien' }).click();
await p2.waitForTimeout(200);
const protos = await p2.locator('#pxProto option').count();
await p2.fill('#px_Identifiant', 'banc');
await p2.fill('#px_Nom', 'Banc d’essai');
await p2.fill('#pf_host', '10.0.0.5');
await p2.locator('.m-actions .btn', { hasText: 'Points…' }).click();
await p2.waitForTimeout(250);
await p2.locator('.m-actions .btn', { hasText: '+ Nouveau point' }).click();
await p2.waitForTimeout(250);
await p2.fill('#px_Identifiant', 'pression');
await p2.fill('#px_Libell', 'Pression refoulement');
await p2.fill('#px_Unit', 'bar');
await p2.fill('#pf_reg', '40');
await p2.locator('.m-actions .btn', { hasText: 'Enregistrer' }).click();
await p2.waitForTimeout(300);
const pointRow = await p2.locator('.px-row .px-name').first().textContent();
await p2.locator('.px-acts .btn', { hasText: 'Ajouter au diagnostic' }).first().click();
await p2.waitForTimeout(700);
const netRow = await p2.locator(PANE + '.vrow').filter({ hasText: '@banc.pression' }).count();
const netVal = await p2.locator(PANE + '.vrow').filter({ hasText: '@banc.pression' })
  .locator('.v-val').first().textContent().catch(() => '');
check('liens réseau : lien et point déclarés, ajoutés au diagnostic',
  protos >= 7 && pointRow === '@banc.pression' && netRow === 1,
  protos + ' protocoles · ' + pointRow + ' · valeur ' + (netVal || '—').trim());

// Suggestions : le point réseau est proposé et filtrable
await p2.fill('#searchInput', '@banc');
await p2.waitForTimeout(300);
const sugNet = await p2.locator('#suggestBox .sug').filter({ hasText: '@banc.pression' }).count();
await p2.locator('#suggestBox .fbtn', { hasText: 'Réseau' }).click();
await p2.waitForTimeout(200);
const netOnly = await p2.locator('#suggestBox .sug .badge').allTextContents();
await p2.keyboard.press('Escape');
await p2.fill('#searchInput', '');
// L'étiquette dit d'où vient la valeur, pas la lettre de l'adresse : un point
// lu à l'extérieur par le client Modbus s'annonce « ext.MB », à distinguer du
// « MB » d'un registre vu par le canal interne du contrôleur.
check('le point réseau apparaît dans les suggestions (filtre « Réseau »)',
  sugNet === 1 && netOnly.length > 0 && netOnly.every((t) => t === 'ext.MB'),
  netOnly.join(', ') || 'aucune suggestion');
const badgesTable = await p2.locator(PANE + '.vrow .badge').allTextContents();
check('étiquettes de famille : PLC, MB, Matlab, ext.<protocole>, largeur commune',
  badgesTable.includes('ext.MB') &&
  badgesTable.every((t) => ['PLC', 'MB', 'Matlab'].includes(t) || t.startsWith('ext.')),
  [...new Set(badgesTable)].join(' · '));

// Nom d'affichage : renommer une variable du tableau, conservé au rechargement
await p2.keyboard.press('Escape');            // fermer toute suggestion ouverte
await p2.fill('#searchInput', 'Capteurs.debit_pompe');
await p2.selectOption('#targetSel', { index: 0 });
await p2.click('#addBtn');
await p2.waitForTimeout(250);
const dpRow = () => p2.locator(PANE + '.vrow').filter({ hasText: 'Capteurs.debit_pompe' }).first();
await dpRow().locator('.v-edit').click();
await p2.waitForTimeout(150);
await p2.locator(PANE + '.vrow .v-rename').fill('Débit ligne A');
await p2.keyboard.press('Enter');
await p2.waitForTimeout(250);
const renamedLabel = await dpRow().locator('.v-label').textContent();
await p2.waitForTimeout(700);                  // > debounce de sauvegarde (500 ms)
await p2.reload();
await p2.waitForSelector(PANE + '.chart-card', { timeout: 20000 });
await p2.waitForTimeout(1000);
const renamedAfter = await p2.locator(PANE + '.vrow').filter({ hasText: 'Capteurs.debit_pompe' })
  .first().locator('.v-label').textContent();
check('nom d’affichage d’une variable, conservé au rechargement',
  /Débit ligne A/.test(renamedLabel) && /Débit ligne A/.test(renamedAfter),
  renamedAfter);

// Forçage : « Q0.3 = 1 » impose la valeur (simulation locale), ⏻ relâche
await p2.fill('#searchInput', 'Q0.3 = 1');
await p2.click('#addBtn');
await p2.waitForTimeout(600);
const qRow = () => p2.locator(PANE + '.vrow').filter({ hasText: 'Q0.3' }).first();
const forcedOn = await qRow().evaluate((el) => el.classList.contains('forced'));
const forcedVal = (await qRow().locator('.val').textContent()).trim();
await qRow().locator('.v-forced').click();
await p2.waitForTimeout(600);
const forcedOff = await qRow().evaluate((el) => el.classList.contains('forced'));
check('forçage d’une variable par suffixe « = » puis relâchement',
  forcedOn && forcedVal.startsWith('1') && !forcedOff,
  'forcé=' + forcedOn + ' valeur=' + forcedVal + ' relâché=' + !forcedOff);

// Point réseau en lecture seule : le forçage est refusé
await p2.fill('#searchInput', '@x.y = 1');
await p2.click('#addBtn');
await p2.waitForTimeout(200);
check('forçage d’un point réseau refusé (lecture seule)',
  await p2.locator('.toast.err').filter({ hasText: 'lecture seule' }).count() >= 1);

// Mosaïque — redimensionnement libre à la poignée ◢, dans les DEUX sens.
// La largeur se règle en colonnes (c'est elle qui laisse la place à une autre
// tuile à côté) et la hauteur en rangées, la carte entière suivant.
const tuile = (sel) => p2.locator(PANE + sel).first().evaluate((el) => ({
  x: +el.style.getPropertyValue('--tx'), y: +el.style.getPropertyValue('--ty'),
  w: +el.style.getPropertyValue('--tw'), h: +el.style.getPropertyValue('--th'),
  px: Math.round(el.getBoundingClientRect().width),
  ph: Math.round(el.getBoundingClientRect().height),
}));
const tAvant = await tuile('.table-card');
const tgrip = p2.locator(PANE + '.table-card .resize-grip').first();
await tgrip.scrollIntoViewIfNeeded();
const tb = await tgrip.boundingBox();
await p2.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
await p2.mouse.down();
await p2.mouse.move(tb.x + tb.width / 2 - 260, tb.y + tb.height / 2 - 130, { steps: 10 });
await p2.mouse.up();
await p2.waitForTimeout(250);
const tApres = await tuile('.table-card');
const defile = await p2.locator(PANE + '.table-card .trows').first()
  .evaluate((el) => getComputedStyle(el).overflowY);
check('poignée ◢ : largeur ET hauteur libres (la carte entière suit)',
  tApres.w === tAvant.w - 2 && tApres.h === tAvant.h - 3 &&
  tApres.px < tAvant.px - 150 && tApres.ph < tAvant.ph - 100 && defile === 'auto',
  `${tAvant.w}×${tAvant.h} → ${tApres.w}×${tApres.h} cellules · ` +
  `${tAvant.px}×${tAvant.ph} → ${tApres.px}×${tApres.ph} px`);

// Placement libre : la tuile se pose à la CELLULE visée, pas « avant » ou
// « après » une autre. C'est ce qui permet de mettre un graphique à gauche
// d'un tableau, ce qu'un simple rangement en file ne savait pas faire.
const poser = (sel, colonne, rangee) => p2.evaluate(({ sel, colonne, rangee }) => {
  const src = document.querySelector('.tabpane.on ' + sel);
  const h = src.querySelector('.drag-handle');
  const r = src.getBoundingClientRect();
  const store = {};
  const dt = { types: [], setData(t, v) { store[t] = v; this.types.push(t); },
    getData(t) { return store[t] || ''; }, setDragImage() {}, effectAllowed: '', dropEffect: '' };
  const ev = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  Object.defineProperty(ev, 'clientX', { value: r.left + 8 });
  Object.defineProperty(ev, 'clientY', { value: r.top + 8 });
  h.dispatchEvent(ev);

  const grid = document.querySelector('.tabpane.on .charts-grid');
  const m = DW.mosaic.metrique(grid);
  const pt = { clientX: m.rect.left + colonne * (m.colW + m.gap) + 8,
               clientY: m.rect.top + rangee * (m.rowH + m.gapY) + 8 };
  const dt2 = { types: Object.keys(store), getData(t) { return store[t] || ''; },
    setData() {}, dropEffect: '', effectAllowed: '' };
  let fantome = null;
  for (const type of ['dragover', 'drop']) {
    const e2 = new MouseEvent(type, { bubbles: true, cancelable: true, ...pt });
    Object.defineProperty(e2, 'dataTransfer', { value: dt2 });
    grid.dispatchEvent(e2);
    if (type === 'dragover') {
      const g = document.querySelector('.tile-ghost');
      fantome = g ? [+g.style.getPropertyValue('--tx'), +g.style.getPropertyValue('--ty')] : null;
    }
  }
  document.dispatchEvent(new Event('dragend', { bubbles: true }));
  return fantome;
}, { sel, colonne, rangee });

// Le premier graphique est envoyé tout en haut à gauche : le tableau, qui y
// était, doit descendre.
const fantome = await poser('.chart-card', 0, 0);
await p2.waitForTimeout(400);
const gApres = await tuile('.chart-card');
const tPousse = await tuile('.table-card');
check('placement libre : la tuile se pose à la cellule visée, les voisines s’écartent',
  fantome && fantome[0] === 1 && fantome[1] === 1 &&
  gApres.x === 1 && gApres.y === 1 && tPousse.y > 1,
  'fantôme en (' + (fantome || []).join(',') + ') · graphique (' + gApres.x + ',' + gApres.y +
  ') · tableau descendu en rangée ' + tPousse.y);

// Plusieurs tableaux dans un onglet, mêlés aux graphiques : c'est ce qui
// permet de séparer deux sujets au lieu d'une seule longue liste.
const tablesAvant = await p2.locator(PANE + '.table-card').count();
await p2.selectOption('#targetSel', 'newtable');
await p2.waitForTimeout(300);
const cible = await p2.locator('#targetSel').inputValue();
await p2.fill('#searchInput', 'Elec.frequence');
await p2.click('#addBtn');
await p2.waitForTimeout(300);
const tablesApres = await p2.locator(PANE + '.table-card').count();
const lignes2 = await p2.locator(PANE + '.table-card').last().locator('.vrow').count();
check('plusieurs tableaux par onglet (le nouveau devient la destination)',
  tablesApres === tablesAvant + 1 && /^table:/.test(cible) && lignes2 === 1,
  tablesAvant + ' → ' + tablesApres + ' tableau(x), cible « ' + cible + ' »');

// La disposition complète — place ET taille de chaque tuile — doit revenir
// telle quelle au rechargement : c'est tout l'intérêt de la ranger.
const plan = () => p2.$$eval(PANE + '.charts-grid > .card', (c) => c.map((x) =>
  (x.classList.contains('table-card') ? 'T' : 'G') + x.style.getPropertyValue('--tx') + ',' +
  x.style.getPropertyValue('--ty') + ',' + x.style.getPropertyValue('--tw') + ',' +
  x.style.getPropertyValue('--th')).join(' '));
const plan0 = await plan();
await p2.waitForTimeout(700);                  // > debounce de sauvegarde
await p2.reload();
await p2.waitForSelector(PANE + '.chart-card', { timeout: 20000 });
await p2.waitForTimeout(1200);
const plan1 = await plan();
check('mosaïque (place et taille de chaque tuile) conservée au rechargement',
  plan0 === plan1 && /T/.test(plan0) && /G/.test(plan0),
  plan0 === plan1 ? plan0 : plan0 + '  ≠  ' + plan1);

// Menu ⋮ d'un tableau : les mêmes gestes que sur un graphique. Sans lui, un
// tableau ne pouvait ni se dupliquer ni partir dans un autre onglet. Un second
// onglet est ouvert pour que « Déplacer vers » ait une destination.
await p2.click('#tabAdd');
await p2.waitForTimeout(300);
await p2.locator('.tab').first().click();
await p2.waitForTimeout(300);
await p2.locator(PANE + '.table-card').first().locator('.table-more').click();
await p2.waitForTimeout(180);
const menuTab = await p2.$$eval('.popmenu button', (b) => b.map((x) => x.textContent.trim()));
const tablesAv = await p2.locator(PANE + '.table-card').count();
await p2.locator('.popmenu button', { hasText: 'Dupliquer ce tableau' }).click();
await p2.waitForTimeout(350);
check('menu ⋮ des tableaux : dupliquer, déplacer, nouvelle fenêtre',
  menuTab.some((t) => /Dupliquer ce tableau/.test(t)) &&
  menuTab.some((t) => /Déplacer vers/.test(t)) &&
  menuTab.some((t) => /nouvelle fenêtre/.test(t)) &&
  await p2.locator(PANE + '.table-card').count() === tablesAv + 1,
  menuTab.join(' · '));
// La copie a fait son office : on la retire pour ne pas fausser la suite.
await p2.locator(PANE + '.table-card').nth(1).locator('.table-more').click();
await p2.waitForTimeout(150);
await p2.locator('.popmenu button', { hasText: 'Fermer le tableau' }).click();
await p2.waitForTimeout(300);

// Sélection d'une carte : la barre du haut ajoute là où l'on a cliqué. Sans
// cela il fallait dérouler la liste des destinations à chaque variable.
// Le clic est porté sur une zone neutre de la légende : les commandes de la
// carte (boutons, champs, poignées) ne changent volontairement pas la cible.
const legende = p2.locator(PANE + '.chart-card').first().locator('.chart-legend');
const legBox = await legende.boundingBox();
await legende.click({ position: { x: legBox.width - 30, y: 12 } });
await p2.waitForTimeout(200);
const cibleClic = await p2.locator('#targetSel').inputValue();
const surbrillance = await p2.locator(PANE + '.chart-card.cible, ' + PANE + '.table-card.cible').count();
const courbesAv = await p2.locator(PANE + '.chart-card').first().locator('.chip').count();
await p2.fill('#searchInput', 'Elec.puissance');
await p2.click('#addBtn');
await p2.waitForTimeout(350);
const courbesAp = await p2.locator(PANE + '.chart-card').first().locator('.chip').count();
check('carte sélectionnée : l’ajout depuis la barre du haut y va',
  /^chart:/.test(cibleClic) && surbrillance === 1 && courbesAp === courbesAv + 1,
  'cible « ' + cibleClic + ' » · ' + courbesAv + ' → ' + courbesAp + ' courbes');

// Figer : les valeurs numériques doivent s'arrêter, pas seulement le tracé —
// des chiffres qui continuent de courir sous une pause enlèvent toute
// confiance à ce qu'on lit. Le retard sur le temps réel s'affiche alors dans
// l'en-tête de chaque tuile figée.
const valeurTable = () => p2.locator(PANE + '.table-card .vrow .val').first().textContent();
const valeurLegende = () => p2.locator(PANE + '.chart-card .chip-val').first().textContent();
await p2.click('#pauseAllBtn');
await p2.waitForTimeout(400);
const vT0 = await valeurTable(), vL0 = await valeurLegende();
const retards0 = await p2.locator(PANE + '.lag:not(.hide)').count();
const tuiles = await p2.locator(PANE + '.charts-grid > .card').count();
await p2.waitForTimeout(2200);
const vT1 = await valeurTable(), vL1 = await valeurLegende();
const retard = (await p2.locator(PANE + '.lag:not(.hide)').first().textContent()).trim();
await p2.click('#pauseAllBtn');
await p2.waitForTimeout(600);
const repris = await p2.locator(PANE + '.lag:not(.hide)').count();
check('« Figer » arrête aussi les valeurs numériques, et dit le retard',
  vT0 === vT1 && vL0 === vL1 && retards0 === tuiles && /⏱ −/.test(retard) && repris === 0,
  'tableau ' + vT0.trim() + '→' + vT1.trim() + ', légende ' + vL0.trim() + '→' + vL1.trim() +
  ' · ' + retard + ' · ' + retards0 + '/' + tuiles + ' tuile(s) · reste ' + repris);

// Échelles verticales : au-delà du regroupement automatique par unité, on doit
// pouvoir associer une courbe à l'échelle d'une autre, et nommer cette échelle.
const pastille = p2.locator(PANE + '.chart-card').first().locator('.chip').first();
await pastille.click();
await p2.waitForTimeout(220);
const entrees = await p2.$$eval('.popmenu button', (b) => b.map((x) => x.textContent.trim()));
await p2.locator('.popmenu button', { hasText: 'Mettre sur l’échelle' }).first().click();
await p2.waitForTimeout(400);
await pastille.click();
await p2.waitForTimeout(220);
await p2.locator('.popmenu button', { hasText: 'Renommer l’échelle' }).click();
await p2.waitForTimeout(300);
await p2.fill('.ax-nom', 'Groupe moteur');
await p2.click('.ax-ok');
await p2.waitForTimeout(800);
await p2.reload();
await p2.waitForSelector(PANE + '.chart-card', { timeout: 20000 });
await p2.waitForTimeout(1200);
await p2.locator(PANE + '.chart-card').first().locator('.chip').first().click();
await p2.waitForTimeout(250);
const apresEchelle = await p2.$$eval('.popmenu button', (b) => b.map((x) => x.textContent.trim()));
await p2.mouse.click(5, 5);
await p2.waitForTimeout(150);
check('échelles : association explicite et nom, conservés au rechargement',
  entrees.some((t) => /Échelle automatique/.test(t)) &&
  entrees.some((t) => /Échelle dédiée/.test(t)) &&
  entrees.some((t) => /Mettre sur l’échelle/.test(t)) &&
  // Ni « automatique » ni « dédiée » cochées : la courbe est sur l'échelle choisie
  !apresEchelle.some((t) => /^✓ Échelle (automatique|dédiée)/.test(t)),
  entrees.filter((t) => /échelle/i.test(t)).join(' · '));

// Une courbe se glisse d'un graphique à l'autre — déplacée, ou COPIÉE quand
// Ctrl est enfoncé. Sa configuration voyage avec elle : sans cela, elle
// arriverait dépouillée de sa couleur, de son échelle et de son décalage.
const nbCourbes = () => p2.$$eval(PANE + '.chart-card',
  (els) => [els[0].querySelectorAll('.chip').length,
            els[els.length - 1].querySelectorAll('.chip').length]);
// Cible : un graphique NEUF, créé pour l'occasion. Viser un voisin
// quelconque exposerait au cas où il porte déjà la même courbe, et le test
// mesurerait alors le refus de duplication plutôt que le déplacement.
await p2.selectOption('#targetSel', 'new');
await p2.waitForTimeout(400);
const glisserCourbe = (indexChip, ctrl) => p2.evaluate(({ indexChip, ctrl }) => {
  const cartes = [...document.querySelectorAll('.tabpane.on .chart-card')];
  const chip = cartes[0].querySelectorAll('.chip')[indexChip];
  const store = {};
  const dt = { types: [], setData(t, v) { store[t] = v; this.types.push(t); },
    getData(t) { return store[t] || ''; }, setDragImage() {}, effectAllowed: '', dropEffect: '' };
  const ev = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  chip.dispatchEvent(ev);
  const cible = cartes[cartes.length - 1], r = cible.getBoundingClientRect();
  const dt2 = { types: Object.keys(store), getData(t) { return store[t] || ''; },
    setData() {}, dropEffect: '', effectAllowed: '' };
  for (const type of ['dragover', 'drop']) {
    const e2 = new MouseEvent(type, { bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, ctrlKey: ctrl });
    Object.defineProperty(e2, 'dataTransfer', { value: dt2 });
    cible.dispatchEvent(e2);
  }
  document.dispatchEvent(new Event('dragend', { bubbles: true }));
}, { indexChip, ctrl });
const nb0 = await nbCourbes();
await glisserCourbe(0, true);
await p2.waitForTimeout(500);
const nb1 = await nbCourbes();
await glisserCourbe(1, false);
await p2.waitForTimeout(500);
const nb2 = await nbCourbes();
await p2.locator(PANE + '.chart-card .chip').first().click();
await p2.waitForTimeout(220);
const menuVar = await p2.$$eval('.popmenu button', (b) => b.map((x) => x.textContent.trim()));
await p2.mouse.click(5, 5);
await p2.waitForTimeout(150);
check('courbe glissée d’un graphique à l’autre : copie (Ctrl) et déplacement',
  nb1[0] === nb0[0] && nb1[1] === nb0[1] + 1 &&      // copie : la source garde la sienne
  nb2[0] === nb1[0] - 1 && nb2[1] === nb1[1] + 1 &&  // déplacement : elle quitte la source
  menuVar.some((t) => /^Copier l’adresse \(/.test(t)) &&
  menuVar.some((t) => /^Copier vers «/.test(t)),
  nb0.join('/') + ' → copie ' + nb1.join('/') + ' → déplacement ' + nb2.join('/'));

// Plein écran depuis l'en-tête de la tuile : un bouton, pas seulement une
// entrée de menu — c'est un geste qu'on fait souvent pour regarder une courbe
// de près. La tuile sort de la mosaïque, donc sa place et sa taille sont
// intactes au retour.
const dim = (sel) => p2.locator(PANE + sel).first().evaluate((e) => {
  const r = e.getBoundingClientRect();
  return Math.round(r.width) + 'x' + Math.round(r.height);
});
const ecran = await p2.evaluate(() => window.innerWidth + 'x' + window.innerHeight);
const tAvantFs = await dim('.table-card');
await p2.locator(PANE + '.table-card .card-fs').first().click();
await p2.waitForTimeout(350);
const tPlein = await dim('.table-card');
const bloque = await p2.evaluate(() => document.body.classList.contains('has-fs'));
await p2.keyboard.press('Escape');
await p2.waitForTimeout(300);
const tRetour = await dim('.table-card');
const gAvantFs = await dim('.chart-card');
await p2.locator(PANE + '.chart-card .card-fs').first().click();
await p2.waitForTimeout(350);
const gPlein = await dim('.chart-card');
await p2.locator(PANE + '.chart-card .card-fs').first().click();
await p2.waitForTimeout(300);
const gRetour = await dim('.chart-card');
check('bouton ⛶ : plein écran par tuile (tableau et graphique), retour intact',
  tPlein === ecran && gPlein === ecran && bloque &&
  tRetour === tAvantFs && gRetour === gAvantFs &&
  !(await p2.evaluate(() => document.body.classList.contains('has-fs'))),
  'tableau ' + tAvantFs + ' → ' + tPlein + ' → ' + tRetour +
  ' · graphique ' + gAvantFs + ' → ' + gPlein + ' → ' + gRetour);

// Adresse ou description : les deux publics — automaticien et exploitant — ne
// lisent pas le même repère. Chaque tuile porte donc sa bascule.
const ligne1 = () => p2.locator(PANE + '.vrow').first().evaluate((e) => ({
  tete: e.querySelector('.v-addr').textContent, sous: e.querySelector('.v-label').textContent }));
const past1 = () => p2.locator(PANE + '.chart-card .chip-addr').first().textContent();
const l0 = await ligne1(), c0 = await past1();
await p2.locator(PANE + '.table-more').first().click();
await p2.waitForTimeout(200);
await p2.locator('.popmenu button', { hasText: 'description en tête' }).click();
await p2.waitForTimeout(350);
await p2.locator(PANE + '.chart-more').first().click();
await p2.waitForTimeout(200);
await p2.locator('.popmenu button', { hasText: 'description plutôt qu’adresse' }).click();
await p2.waitForTimeout(350);
const l1 = await ligne1(), c1 = await past1();
await p2.waitForTimeout(800);
await p2.reload();
await p2.waitForSelector(PANE + '.chart-card', { timeout: 20000 });
await p2.waitForTimeout(1200);
const l2 = await ligne1(), c2 = await past1();
check('bascule adresse ↔ description (tableau et légende), conservée',
  l1.tete === l0.sous && l1.sous === l0.tete && c1 !== c0 &&
  l2.tete === l1.tete && c2 === c1,
  '« ' + l0.tete + ' » ⇄ « ' + l1.tete + ' » · pastille « ' + c0 + ' » → « ' + c1 + ' »');

// Apparence : logo de l'exploitant et couleurs. Page ouverte hors serveur ici,
// donc réglages du navigateur — le tour serveur est couvert par tests/server.mjs.
await p2.click('#menuBtn');
await p2.waitForTimeout(150);
await p2.click('#skinBtn');
await p2.waitForTimeout(300);
const accent0 = await p2.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
await p2.locator('.skin-color input').first().evaluate((el) => {
  el.value = '#ff7a00';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await p2.waitForTimeout(200);
const accent1 = await p2.evaluate(() => ({
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  dim: getComputedStyle(document.documentElement).getPropertyValue('--accent-dim').trim(),
}));
check('couleurs de l’interface personnalisables (aperçu immédiat, nuances déduites)',
  accent0 !== accent1.accent && accent1.accent === '#ff7a00' && /ff7a00/.test(accent1.dim),
  accent0 + ' → ' + accent1.accent);

// Logo : une image fournie par l'exploitant, incorporée (jamais une URL).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVQoU2P8z8Dwn4EIwDiqkL4hBQCcvwf+r0BvnAAAAABJRU5ErkJggg==',
  'base64');
await p2.setInputFiles('.skin-file', { name: 'logo.png', mimeType: 'image/png', buffer: PNG });
await p2.waitForTimeout(500);
const logoPose = await p2.evaluate(() => {
  const img = document.querySelector('.logo img');
  const ico = document.querySelector('link[rel="icon"]');
  return { src: img ? img.src.slice(0, 14) : null, ico: ico ? ico.href.slice(0, 14) : null };
});
await p2.click('.skin-ok');
await p2.waitForTimeout(400);
await p2.reload();
await p2.waitForSelector(PANE + '.chart-card', { timeout: 20000 });
await p2.waitForTimeout(1200);
const apres = await p2.evaluate(() => ({
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  logo: !!document.querySelector('.logo img'),
}));
check('logo de l’exploitant incorporé (data:), icône d’onglet comprise',
  logoPose.src === 'data:image/png' && logoPose.ico === 'data:image/png',
  JSON.stringify(logoPose));
check('apparence conservée au rechargement',
  apres.accent === '#ff7a00' && apres.logo, JSON.stringify(apres));

// Remise en état : les vérifications suivantes (et les captures) partent de
// l'apparence d'origine.
await p2.evaluate(() => {
  DW.appearance.setLogo('');
  DW.appearance.reinitialiserCouleurs();
  return DW.appearance.enregistrer();
});
await p2.waitForTimeout(300);

// Pages réseau hors serveur : elles tournent sur la simulation (netsim.js), de
// sorte que l'interface de gestion des captures se voie et se règle même sans
// contrôleur. Le bandeau doit dire d'où viennent les données, et une capture
// simulée ne doit offrir aucun fichier à télécharger — il n'y a rien derrière.
await p2.click('#menuBtn'); await p2.waitForTimeout(150);
await p2.click('#captureBtn');
await p2.waitForSelector('.cap-if', { timeout: 5000 });
const bandeau = await p2.locator('.net-sim').count();
const nbIfaces = await p2.locator('.cap-if option').count();
await p2.click('.cap-go');
await p2.waitForTimeout(1200);
const enCours = await p2.locator('.cap-etat.cap-on').count();
await p2.click('.cap-stop');
await p2.waitForTimeout(400);
const arretee = await p2.locator('.cap-list tbody tr').first().textContent();
const pcap = await p2.locator('.cap-list a', { hasText: 'pcap' }).count();
check('capture : interface de gestion utilisable sur la simulation',
  bandeau === 1 && nbIfaces >= 3 && enCours === 1 && /arrêtée/.test(arretee) && pcap === 0,
  nbIfaces + ' interfaces · bandeau « données simulées » · aucun fichier proposé');

// Quota et déclencheur simulés : ils se règlent, et ils tiennent au
// rechargement — comme les réglages persistants du serveur.
await p2.fill('.cap-quota-in', '25');
await p2.check('.tr-on');
await p2.fill('.tr-addr', 'S0.4');
await p2.click('.tr-save');
await p2.waitForTimeout(500);
await p2.click('.m-close');
await p2.reload();
await p2.waitForSelector(PANE + '.chart-card', { timeout: 20000 });
await p2.waitForTimeout(1200);
await p2.click('#menuBtn'); await p2.waitForTimeout(150);
await p2.click('#captureBtn');
await p2.waitForSelector('.cap-quota-in', { timeout: 5000 });
const quotaGarde = await p2.locator('.cap-quota-in').inputValue();
const declGarde = await p2.locator('.tr-on').isChecked();
const adrGarde = await p2.locator('.tr-addr').inputValue();
check('capture simulée : quota et déclencheur conservés au rechargement',
  quotaGarde === '25' && declGarde && adrGarde === 'S0.4',
  quotaGarde + ' Mo · déclencheur ' + adrGarde);
await p2.click('.m-close');
await p2.waitForTimeout(200);

// Couverture des infobulles : chaque objet interactif doit être documenté
const AUDIT = () => {
  const sel = 'button, select, input, .tab, .chip, .drag-handle, .vrow, .badge,' +
    ' .sug, .acc-btn, .fbtn, .sw-btn, .sw-custom, .tab-close, .v-del, .v-edit, .v-forced, .recdot, .resize-grip';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.getAttribute('title') || el.getAttribute('aria-label')) continue;
    if (el.closest('[title]')) continue;   // hérite de l'infobulle d'un parent
    out.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
      '.' + String(el.className || '').split(' ')[0]);
  }
  return out;
};
let missing = [];
const sweep = async (open) => {
  if (open) await open();
  missing = missing.concat(await p2.evaluate(AUDIT));
};
await sweep();
await sweep(async () => { await p2.click('#searchInput'); await p2.waitForTimeout(250); });
await p2.keyboard.press('Escape');
await sweep(async () => {
  await p2.locator(PANE + '.chart-card').first().locator('.chip').first().click();
  await p2.waitForTimeout(200);
});
await p2.mouse.click(5, 5); await p2.waitForTimeout(150);
await sweep(async () => {
  await p2.locator(PANE + '.chart-card').first().locator('.chart-more').click();
  await p2.waitForTimeout(200);
});
await p2.mouse.click(5, 5); await p2.waitForTimeout(150);
await p2.click('#menuBtn'); await p2.waitForTimeout(150);
await sweep(async () => { await p2.click('#layoutsBtn'); await p2.waitForTimeout(300); });
await p2.click('.m-close');
await p2.click('#menuBtn'); await p2.waitForTimeout(150);
await sweep(async () => { await p2.click('#logBtn'); await p2.waitForTimeout(300); });
await p2.click('.m-close');
await sweep(async () => { await p2.click('#menuBtn'); await p2.waitForTimeout(180); });
// Les trois pages réseau : hors serveur elles tournent sur la simulation, et
// c'est justement pour cela qu'elles doivent passer l'audit des infobulles.
const ouvrirMenu = async () => {
  if (await p2.locator('#menuPanel.hide').count()) await p2.click('#menuBtn');
  await p2.waitForTimeout(120);
};
for (const [bouton, attente] of [['#auditBtn', '.net-sec'], ['#captureBtn', '.cap-if'],
                                 ['#lldpBtn', '.lldp-timeout']]) {
  await sweep(async () => {
    await ouvrirMenu();
    await p2.click(bouton);
    await p2.waitForSelector(attente, { timeout: 5000 });
    await p2.waitForTimeout(200);
  });
  await p2.click('.m-close');
}
await ouvrirMenu();
await sweep(async () => { await p2.click('#netBtn'); await p2.waitForTimeout(300); });
await sweep(async () => {
  await p2.locator('.px-acts .btn', { hasText: 'Modifier' }).first().click();
  await p2.waitForTimeout(250);
});
await p2.click('.m-close');
await ouvrirMenu();
await sweep(async () => { await p2.click('#helpBtn'); await p2.waitForTimeout(250); });
const helpSections = await p2.locator('.help-h').count();
check('infobulle sur chaque objet de l\'interface',
  missing.length === 0 && helpSections >= 5,
  missing.length ? missing.slice(0, 6).join(', ') : 'toutes les vues + aide (' + helpSections + ' sections)');
await p2.click('.m-close');

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
