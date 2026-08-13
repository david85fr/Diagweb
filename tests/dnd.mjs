/* Diagweb — déplacement de widgets entre onglets et entre fenêtres.
 *
 *   node tests/dnd.mjs [http://localhost:8080/web/index.html]
 *
 * Nécessite une origine http(s) (BroadcastChannel) : lancer le serveur de
 * diagnostic ou tools/serve.py, pas d'ouverture en fichier local.
 * Prérequis : bash tools/setup-tests.sh
 */
import fs from 'node:fs';
import path from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { ({ chromium } = await import('playwright')); }

const URL = process.argv[2] || process.env.DIAGWEB_URL || 'http://localhost:8080/web/index.html';
const SHOTS = process.env.DIAGWEB_SHOTS || '.test-shots';

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

/**
 * Glisse un widget sur une carte de la grille (rangement).
 *
 * Les sélecteurs acceptent la forme « sél#N » : la N-ième correspondance.
 * Nécessaire depuis que le tableau numérique vit dans la même grille que les
 * graphiques — « :nth-of-type » n'y désigne plus la carte attendue.
 */
const PICK = (s) => {
  const i = s.lastIndexOf('#');
  if (i < 0) return document.querySelector(s);
  return document.querySelectorAll(s.slice(0, i))[parseInt(s.slice(i + 1), 10)];
};

async function dragOntoCard(page, srcSel, dstSel, right) {
  const store = await page.evaluate(({ sel, pick }) => {
    const el = new Function('s', 'return (' + pick + ')(s)')(sel); const s = {};
    const dt = { types: [], setData(t, v) { s[t] = v; this.types.push(t); },
      getData(t) { return s[t] || ''; }, setDragImage() {}, effectAllowed: '', dropEffect: '' };
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
    return s;
  }, { sel: srcSel, pick: PICK.toString() });
  await page.evaluate(({ sel, store, right, pick }) => {
    const el = new Function('s', 'return (' + pick + ')(s)')(sel);
    const r = el.getBoundingClientRect();
    const dt = { types: Object.keys(store), getData(t) { return store[t] || ''; },
      setData() {}, dropEffect: '', effectAllowed: '' };
    for (const type of ['dragover', 'drop']) {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true,
        clientX: r.left + (right ? r.width * 0.8 : r.width * 0.2), clientY: r.top + 20 });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      el.dispatchEvent(ev);
    }
  }, { sel: dstSel, store, right, pick: PICK.toString() });
  await page.evaluate(() => document.dispatchEvent(new Event('dragend', { bubbles: true })));
}

/** Glisse une ligne du tableau sur une autre (rangement dans le tableau). */
async function dragRowWithin(page, srcSel, dstSel, below) {
  const store = await page.evaluate((sel) => {
    const el = document.querySelector(sel); const s = {};
    const dt = { types: [], setData(t, v) { s[t] = v; this.types.push(t); },
      getData(t) { return s[t] || ''; }, setDragImage() {}, effectAllowed: '', dropEffect: '' };
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
    return s;
  }, srcSel);
  const marque = await page.evaluate(({ sel, store, below }) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const dt = { types: Object.keys(store), getData(t) { return store[t] || ''; },
      setData() {}, dropEffect: '', effectAllowed: '' };
    const point = { clientX: r.left + r.width / 2,
                    clientY: r.top + (below ? r.height * 0.8 : r.height * 0.2) };
    const envoyer = (type) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...point });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      el.dispatchEvent(ev);
    };
    envoyer('dragover');
    // Le repère d'insertion doit être visible AVANT le dépôt : c'est lui qui
    // dit à l'utilisateur où la ligne va se poser.
    const vu = !!document.querySelector('.vrow.drop-before, .vrow.drop-after');
    envoyer('drop');
    return vu;
  }, { sel: dstSel, store, below });
  await page.evaluate(() => document.dispatchEvent(new Event('dragend', { bubbles: true })));
  return marque;
}

/** Simule un glisser-déposer HTML5 en transportant réellement le DataTransfer. */
async function dragTo(srcPage, srcSel, dstPage, dstSel) {
  // 1. dragstart sur la source, on capture ce que l'application y dépose
  const payload = await srcPage.evaluate((sel) => {
    const el = document.querySelector(sel);
    const store = {};
    const dt = {
      types: [],
      setData(t, v) { store[t] = v; this.types.push(t); },
      getData(t) { return store[t] || ''; },
      setDragImage() {},
      effectAllowed: '', dropEffect: '',
    };
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
    return store;
  }, srcSel);

  // 2. drop sur la cible, avec la même charge utile
  const okDrop = await dstPage.evaluate(({ sel, store }) => {
    const el = sel ? document.querySelector(sel) : document.body;
    if (!el) return false;
    const dt = {
      types: Object.keys(store),
      getData(t) { return store[t] || ''; },
      setData() {}, dropEffect: '', effectAllowed: '',
    };
    for (const type of ['dragover', 'drop']) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      el.dispatchEvent(ev);
    }
    return true;
  }, { sel: dstSel, store: payload });

  // 3. dragend sur la source (arme l'attente de l'accusé de réception)
  await srcPage.evaluate(() => {
    document.dispatchEvent(new Event('dragend', { bubbles: true }));
  });
  return okDrop;
}

const results = [];
const check = (label, ok, info) => {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${info ? ' — ' + info : ''}`);
};

console.log(`Cible : ${URL}\n`);
(async () => {
  const exec = findChromium();
  fs.mkdirSync(SHOTS, { recursive: true });
  const b = await chromium.launch({
    ...(exec ? { executablePath: exec } : {}),
    args: ['--no-sandbox'],
  });
  const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });
  const watch = (p, tag) => {
    p.on('pageerror', (e) => errs.push(tag + ': ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(tag + ': ' + m.text()); });
  };

  // ---- Fenêtre A
  const A = await ctx.newPage();
  watch(A, 'A');
  await A.goto(URL);
  await A.waitForSelector('.tabpane.on .chart-card', { timeout: 20000 });
  await A.waitForTimeout(1500);

  // 0) Placement libre : une tuile lâchée sur une cellule s'y pose, sans
  // duplication. Le glisser-déposer HTML5 sert aussi au transfert entre
  // onglets et entre fenêtres — c'est le même geste, trois destinations.
  const plan = () => A.$$eval('.tabpane.on .charts-grid > .card', (c) => c.map((x) => ({
    k: x.classList.contains('table-card') ? 'T' : 'G',
    x: +x.style.getPropertyValue('--tx'), y: +x.style.getPropertyValue('--ty'),
  })));
  /** Lâche la carte `sel` sur la cellule (colonne, rangée) de la mosaïque. */
  const poserSur = async (sel, colonne, rangee) => {
    const store = await A.evaluate((s2) => {
      const el = document.querySelector(s2);
      const st = {};
      const dt = { types: [], setData(t, v) { st[t] = v; this.types.push(t); },
        getData(t) { return st[t] || ''; }, setDragImage() {}, effectAllowed: '', dropEffect: '' };
      const ev = new Event('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      el.dispatchEvent(ev);
      return st;
    }, sel + ' .drag-handle');
    await A.evaluate(({ store, colonne, rangee }) => {
      const grid = document.querySelector('.tabpane.on .charts-grid');
      const m = DW.mosaic.metrique(grid);
      const pt = { clientX: m.rect.left + colonne * (m.colW + m.gap) + 6,
                   clientY: m.rect.top + rangee * (m.rowH + m.gapY) + 6 };
      const dt = { types: Object.keys(store), getData(t) { return store[t] || ''; },
        setData() {}, dropEffect: '', effectAllowed: '' };
      for (const type of ['dragover', 'drop']) {
        const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...pt });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        grid.dispatchEvent(ev);
      }
    }, { store, colonne, rangee });
    await A.evaluate(() => document.dispatchEvent(new Event('dragend', { bubbles: true })));
    await A.waitForTimeout(500);
  };

  const cartes0 = (await plan()).length;
  await poserSur('.tabpane.on .chart-card', 0, 0);
  const p1 = await plan();
  const gEnHaut = p1.find((c) => c.k === 'G' && c.x === 1 && c.y === 1);
  check('placement libre : la tuile se pose sur la cellule visée (aucune copie)',
    !!gEnHaut && p1.length === cartes0,
    p1.map((c) => c.k + '(' + c.x + ',' + c.y + ')').join(' '));

  // 0 ter) Un tableau se pose comme un graphique : on peut donc mettre un
  // graphique à sa GAUCHE — la disposition qu'aucun rangement en file ne
  // savait produire.
  await poserSur('.tabpane.on .table-card', 7, 0);
  const p2 = await plan();
  const t = p2.find((c) => c.k === 'T');
  const gGauche = p2.find((c) => c.k === 'G' && c.x < t.x && c.y === t.y);
  const varsIntactes = await A.locator('.tabpane.on .vrow').count();
  check('un graphique peut se tenir à GAUCHE du tableau, variables intactes',
    !!gGauche && varsIntactes > 0,
    p2.map((c) => c.k + '(' + c.x + ',' + c.y + ')').join(' ') +
    ' · ' + varsIntactes + ' variable(s)');

  // 0 bis) Rangement des lignes du tableau numérique
  const lignes = () => A.locator('.tabpane.on .vrow').evaluateAll(
    (e) => e.map((x) => x.dataset.addr));
  const l0 = await lignes();
  const repere = await dragRowWithin(A, '.tabpane.on .vrow:nth-child(1)',
    '.tabpane.on .vrow:nth-child(3)', true);
  await A.waitForTimeout(400);
  const l1 = await lignes();
  check('lignes du tableau rangées par glisser-déposer (repère d’insertion)',
    repere && l1.length === l0.length && l1[2] === l0[0] && l1[0] === l0[1],
    l0.slice(0, 3).join(' · ') + '  →  ' + l1.slice(0, 3).join(' · '));

  // Un second onglet dans A
  await A.click('#tabAdd');
  await A.waitForTimeout(300);
  await A.locator('.tab').first().click();
  await A.waitForTimeout(300);
  const chartsBefore = await A.locator('.tabpane.on .chart-card').count();

  // 1) Glisser un graphique vers le 2e onglet de la même fenêtre
  await dragTo(A, '.tabpane.on .chart-card .drag-handle', A, '.tab:nth-child(2)');
  await A.waitForTimeout(600);
  // L'onglet actif ne doit pas changer (organisation multi-écran)
  const stillOnTab1 = await A.evaluate(() =>
    document.querySelector('.tab.on .tab-name').textContent.trim());
  const chartsAfterSrc = await A.locator('.tabpane.on .chart-card').count();
  await A.locator('.tab').nth(1).click();
  await A.waitForTimeout(500);
  const chartsInTab2 = await A.locator('.tabpane.on .chart-card').count();
  check('onglet actif inchangé après un dépôt sur un autre onglet',
    stillOnTab1 === 'Démo', 'actif = ' + stillOnTab1);
  check('graphique déplacé vers un autre onglet (retiré de la source)',
    chartsAfterSrc === chartsBefore - 1 && chartsInTab2 === 1,
    `source ${chartsBefore}→${chartsAfterSrc}, cible ${chartsInTab2}`);

  // 2) Glisser une variable seule vers l'onglet 2
  await A.locator('.tab').first().click();
  await A.waitForTimeout(400);
  const rowsBefore = await A.locator('.tabpane.on .vrow').count();
  await dragTo(A, '.tabpane.on .vrow:first-child', A, '.tab:nth-child(2)');
  await A.waitForTimeout(600);
  const rowsAfter = await A.locator('.tabpane.on .vrow').count();
  await A.locator('.tab').nth(1).click();
  await A.waitForTimeout(400);
  const rowsTab2 = await A.locator('.tabpane.on .vrow').count();
  check('variable seule déplacée vers un autre onglet',
    rowsAfter === rowsBefore - 1 && rowsTab2 === 1,
    `source ${rowsBefore}→${rowsAfter}, cible ${rowsTab2}`);

  // ---- Fenêtre B (même origine → BroadcastChannel disponible)
  const B = await ctx.newPage();
  watch(B, 'B');
  await B.goto(URL);
  await B.waitForSelector('.tabpane.on .chart-card', { timeout: 20000 });
  await B.waitForTimeout(1500);

  // Session par fenêtre : B ne doit pas hériter des onglets de A
  const tabsA = await A.locator('.tab').count();
  const tabsB = await B.locator('.tab').count();
  check('session propre à chaque fenêtre', tabsA === 2 && tabsB === 1,
    `A ${tabsA} onglet(s), B ${tabsB}`);

  // 2 bis) Un nom d'affichage appartient à la variable, pas à l'endroit où on
  // la regarde : il doit valoir dans tous les tableaux, toutes les courbes,
  // tous les onglets — et dans les autres fenêtres ouvertes sur la même
  // origine (organisation multi-écran).
  await A.locator('.tab').first().click();
  await A.waitForTimeout(300);
  const cible = await A.locator('.tabpane.on .vrow').first().getAttribute('data-addr');
  await A.locator('.tabpane.on .vrow').first().locator('.v-edit').click();
  await A.waitForTimeout(200);
  await A.locator('.v-rename').fill('Nom partagé');
  await A.keyboard.press('Enter');
  await A.waitForTimeout(700);
  const nomA = await A.locator(`.tabpane.on .vrow[data-addr="${cible}"] .v-label`).textContent();
  const nomB = await B.locator(`.tabpane.on .vrow[data-addr="${cible}"] .v-label`).textContent();
  check('renommage d’une variable propagé aux autres fenêtres',
    /Nom partagé/.test(nomA || '') && /Nom partagé/.test(nomB || ''),
    cible + ' : A « ' + (nomA || '') + ' » · B « ' + (nomB || '') + ' »');

  // 3) Glisser un graphique de B vers A (autre fenêtre)
  const chartsB0 = await B.locator('.tabpane.on .chart-card').count();
  await A.locator('.tab').first().click();
  await A.waitForTimeout(300);
  const chartsA0 = await A.locator('.tabpane.on .chart-card').count();
  await dragTo(B, '.tabpane.on .chart-card .drag-handle', A, null);
  await A.waitForTimeout(900);
  await B.waitForTimeout(900);
  const chartsA1 = await A.locator('.tabpane.on .chart-card').count();
  const chartsB1 = await B.locator('.tabpane.on .chart-card').count();
  check('graphique déplacé d’une fenêtre à l’autre (accusé de réception)',
    chartsA1 === chartsA0 + 1 && chartsB1 === chartsB0 - 1,
    `A ${chartsA0}→${chartsA1}, B ${chartsB0}→${chartsB1}`);

  // 4) Ouverture dans une nouvelle fenêtre
  const before = await A.locator('.tabpane.on .chart-card').count();
  const [popup] = await Promise.all([
    ctx.waitForEvent('page'),
    A.evaluate(() => {
      document.querySelector('.tabpane.on .chart-card .chart-more').click();
      const b = [...document.querySelectorAll('.popmenu button')]
        .find((x) => x.textContent.includes('nouvelle fenêtre'));
      b.click();
    }),
  ]);
  await popup.waitForSelector('.tabpane.on .chart-card', { timeout: 20000 });
  await popup.waitForTimeout(1200);
  await A.waitForTimeout(600);
  const popupCharts = await popup.locator('.tabpane.on .chart-card').count();
  const afterA = await A.locator('.tabpane.on .chart-card').count();
  check('« ouvrir dans une nouvelle fenêtre » transfère le graphique',
    popupCharts === 1 && afterA === before - 1,
    `nouvelle fenêtre ${popupCharts}, source ${before}→${afterA}`);

  await A.screenshot({ path: path.join(SHOTS, 'dnd-fenetre-a.png') });
  await popup.screenshot({ path: path.join(SHOTS, 'dnd-nouvelle-fenetre.png') });
  await b.close();

  if (errs.length) { console.log('\nERREURS:'); errs.forEach((e) => console.log('  ' + e)); }
  const bad = results.filter((r) => !r).length;
  console.log(`\n${results.length - bad}/${results.length} vérifications réussies` +
    (errs.length ? `, ${errs.length} erreur(s) console` : ', aucune erreur console'));
  process.exit(bad || errs.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
