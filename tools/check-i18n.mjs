/* Diagweb — couverture de la traduction de l'interface.
 *
 *   node tools/check-i18n.mjs [dist/index.html]      état de la couverture
 *   node tools/check-i18n.mjs --manquantes           liste ce qui reste
 *
 * Parcourt TOUTES les vues de l'application dans un navigateur — page,
 * menus, fenêtres, catalogue, pages réseau, formulaires de chaque protocole —
 * et relève les textes affichés. Chacun doit avoir sa traduction anglaise
 * dans `web/js/i18n-en.js`.
 *
 * Le relevé se fait sur l'application RENDUE, pas sur les littéraux du code :
 * une phrase construite par concaténation n'existe nulle part dans les
 * sources, seulement à l'écran — c'est elle que le dictionnaire doit porter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { ({ chromium } = await import('playwright')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CIBLE = process.argv.find((a) => a.endsWith('.html')) ||
  path.join(ROOT, 'dist', 'index.html');
const LISTER = process.argv.includes('--manquantes');

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

/** Relevé des textes affichés, dans la langue de la page. */
const RELEVE = () => {
  const out = new Set();
  // Français probable : accent, ou mot-outil français. Les adresses, les
  // valeurs et les unités passent ainsi à travers, ce qui est voulu.
  const FR = /[éèêëàâçùûüôöîïœÉÈÊÀÇ]|(?:^|\s)(?:le|la|les|des|une|un|du|dans|pour|avec|sur|par|est|sont|qui|que|aux|ses|son|sa|ne|pas|plus|tout|toute|cette|ce|cet|au|et|ou|en|il|elle|on|se|si|sans|vers|leur|même|donc)(?:\s|$)/i;
  const garde = (s) => {
    s = String(s || '').trim().replace(/\s+/g, ' ');
    if (s.length < 2 || s.length > 600) return;
    if (!FR.test(s)) return;
    out.add(s);
  };
  const ENLIGNE = { B: 1, I: 1, EM: 1, STRONG: 1, BR: 1, CODE: 1, SMALL: 1, U: 1 };
  const blocs = new Set();
  for (const el of document.querySelectorAll('*')) {
    if (!el.children.length) continue;
    let ok = true;
    for (const c of el.children) if (!ENLIGNE[c.tagName]) { ok = false; break; }
    if (!ok) continue;
    blocs.add(el);
    garde(el.innerHTML);
  }
  const dansBloc = (n) => {
    for (let e = n.parentNode; e; e = e.parentNode) if (blocs.has(e)) return true;
    return false;
  };
  const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    const tag = n.parentNode && n.parentNode.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') continue;
    if (dansBloc(n)) continue;
    garde(n.nodeValue);
  }
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label],[alt]')) {
    for (const a of ['title', 'placeholder', 'aria-label', 'alt']) garde(el.getAttribute(a));
  }
  garde(document.title);
  return [...out];
};

const browser = await chromium.launch({
  ...(findChromium() ? { executablePath: findChromium() } : {}),
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(CIBLE.startsWith('http') ? CIBLE : 'file://' + CIBLE);
await page.waitForSelector('.tabpane.on .chart-card', { timeout: 20000 });
await page.waitForTimeout(1500);

const vues = new Set();
const relever = async () => (await page.evaluate(RELEVE)).forEach((s) => vues.add(s));
const menu = async (id) => {
  if (await page.locator('#menuPanel.hide').count()) await page.click('#menuBtn');
  await page.waitForTimeout(120);
  await page.click(id);
  await page.waitForTimeout(450);
};
const fermer = async () => {
  await page.click('.m-close').catch(() => {});
  await page.waitForTimeout(180);
};

await relever();
await page.click('#searchInput'); await page.fill('#searchInput', 'e');
await page.waitForTimeout(400); await relever();
await page.keyboard.press('Escape'); await page.fill('#searchInput', '');
await page.click('#menuBtn'); await page.waitForTimeout(200); await relever();
for (const id of ['#helpBtn', '#aboutBtn', '#layoutsBtn', '#logBtn', '#skinBtn',
                  '#resetBtn', '#blankBtn']) {
  await menu(id); await relever();
  if (id === '#layoutsBtn') {
    for (const a of ['save', 'dl', 'load', 'copy']) {
      await page.click('.acc-btn[data-acc="' + a + '"]').catch(() => {});
      await page.waitForTimeout(180); await relever();
    }
  }
  await fermer();
}
for (const [id, sel] of [['#auditBtn', '.net-sec'], ['#captureBtn', '.cap-if'],
                         ['#lldpBtn', '.lldp-timeout']]) {
  await menu(id);
  await page.waitForSelector(sel, { timeout: 6000 }).catch(() => {});
  await relever();
  await fermer();
}
await menu('#netBtn'); await relever();
await page.locator('button', { hasText: '+ Nouveau lien' }).click();
await page.waitForTimeout(400);
const choix = page.locator('.modal select').first();
for (const v of await choix.evaluate((e) => [...e.options].map((o) => o.value))) {
  await choix.selectOption(v).catch(() => {});
  await page.waitForTimeout(250);
  await relever();
}
await fermer();
await page.locator('.tabpane.on .card-add').first().click();
await page.waitForTimeout(450); await relever(); await fermer();
for (const sel of ['.chart-more', '.table-more', '.chip']) {
  await page.locator('.tabpane.on ' + sel).first().click();
  await page.waitForTimeout(220); await relever();
  await page.mouse.click(5, 5); await page.waitForTimeout(120);
}
await browser.close();

// ---------------------------------------------------------------- bilan
const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'i18n-en.js'), 'utf8');
const dict = {};
new Function('window', src)({ DW: { DICTS: dict } });
const EN = (dict.en) || {};
const manquantes = [...vues].filter((s) => EN[s] === undefined).sort((a, b) => a.localeCompare(b, 'fr'));
const total = vues.size;
const faites = total - manquantes.length;
const pc = total ? Math.round((100 * faites) / total) : 100;
console.log(`Traduction de l'interface : ${faites}/${total} textes (${pc} %)`);
if (LISTER) for (const s of manquantes) console.log('  ' + s);
else if (manquantes.length) {
  console.log(`  ${manquantes.length} sans traduction — « node tools/check-i18n.mjs --manquantes » pour la liste.`);
  console.log('  (une traduction manquante s’affiche en français, elle ne casse rien)');
}
process.exit(0);
