/* Diagweb — le serveur de diagnostic face au simulateur d'équipements.
 *
 *   node tests/simulator.mjs [http://localhost:8080]
 *
 * Ce que ce test ajoute à tests/protocols.mjs : là-bas, l'esclave Modbus est
 * celui de tests/devices.mjs, en Node ; ici, c'est le processus
 * `diagweb-simulator` (simulator/), un équipement décrit en JSON — plusieurs
 * unités, table trouée, exceptions. Deux esclaves indépendants valent mieux
 * qu'un : s'ils divergent, l'un des deux a tort, et il vaut mieux l'apprendre
 * ici que sur site.
 *
 * Le serveur de diagnostic doit tourner ; le simulateur est lancé par ce test
 * sur un port libre (--port 0), configuré en lecture par l'API REST, et arrêté
 * en fin de parcours. La configuration des liens est remise à vide.
 *
 * Codes de sortie : 0 succès · 1 échec · 2 le serveur de diagnostic ne répond pas.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8080';
const BIN = process.env.DIAGWEB_SIMULATOR_BIN || 'build/diagweb-simulator';

const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options) {
  const r = await fetch(BASE + path, options);
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, text }; }
}

/** Abonne des adresses au flux temps réel et collecte ce qui arrive. */
function collect(addrs, ms) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    const got = new Map(addrs.map((a) => [a, []]));
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(got); }, ms);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket indisponible')); };
    ws.onopen = () => { for (const a of addrs) ws.send(JSON.stringify({ c: 'sub', addr: a })); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.e === 'd') {
        for (const a of addrs) for (const [, v] of m.s[a] || []) got.get(a).push(v);
      }
    };
  });
}

/**
 * Lance le simulateur sur un port libre et lit le port qu'il annonce.
 * Son absence n'est pas passée sous silence : les vérifications échouent en
 * disant ce qui manque, plutôt que d'être discrètement sautées.
 */
async function startSimulator() {
  if (!fs.existsSync(BIN)) {
    return { absent: true, why: 'binaire introuvable : ' + BIN + ' (meson compile -C build)' };
  }
  const proc = spawn(BIN, ['--port', '0', '--bind', '127.0.0.1', '--quiet'],
                     { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let erreur = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { erreur += d; });
  proc.on('error', (e) => { erreur += e.message; });

  const port = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(0), 5000);
    proc.on('exit', () => { clearTimeout(timer); resolve(0); });
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/port\s*:\s*(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
  });
  if (!port) {
    try { proc.kill('SIGKILL'); } catch {}
    return { absent: true, why: 'le simulateur n’a pas démarré : ' + (erreur || out).trim() };
  }
  return { proc, port };
}

const POINT = (id, label, unit, kind, params) =>
  ({ id, label, unit, kind, periodMs: 100, params: { gain: 1, offset: 0, bit: -1, ...params } });

// --------------------------------------------------------------------- test
console.log('Cible : ' + BASE + '\n');

const health = await api('/api/health');
if (health.status !== 200 || !health.json || health.json.role !== 'diag-server') {
  console.error('Le serveur de diagnostic ne répond pas sur ' + BASE +
    ' — lancer build/diagweb-server.');
  process.exit(2);
}

const sim = await startSimulator();
check('simulateur d’équipements démarré', !sim.absent,
  sim.absent ? sim.why : 'port ' + sim.port + ', ' + BIN);
if (sim.absent) {
  console.log(`\n${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(1);
}

const lien = (id, label, unitId, points) => ({
  id, label, protocol: 'modbus-tcp', enabled: true,
  params: { host: '127.0.0.1', port: sim.port, unitId, timeoutMs: 800, groupMax: 32 },
  points,
});

const put = await api('/api/protocols', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    version: 1,
    links: [
      lien('banc', 'Groupe hydraulique simulé', 1, [
        // Tous les registres du simulateur balaient 0 → 10 en dent de scie,
        // décalés d'une seconde l'un de l'autre ; les vérifications portent
        // donc sur ces bornes, quels que soient le type et la fonction — un
        // décodage faux en sortirait aussitôt.
        POINT('pression', 'Pression circuit A', 'bar', 'float',
              { fn: 3, reg: 40, type: 'uint16' }),
        POINT('debit', 'Débit refoulement', 'm3/h', 'float',
              { fn: 3, reg: 10, type: 'float32', wordOrder: 'big' }),
        POINT('energie', 'Énergie consommée', 'kWh', 'float',
              { fn: 3, reg: 20, type: 'uint32', wordOrder: 'big' }),
        POINT('consigne', 'Consigne de pression', 'bar', 'float',
              { fn: 3, reg: 50, type: 'uint16' }),
        POINT('vitesse', 'Vitesse pompe', 'tr/min', 'word',
              { fn: 4, reg: 0, type: 'uint16' }),
        POINT('pompe', 'Pompe en marche', '', 'bit', { fn: 1, reg: 0, type: 'bool' }),
        POINT('presence', 'Présence secteur', '', 'bit', { fn: 2, reg: 1, type: 'bool' }),
        // Hors de la table : le simulateur répond une exception 02, qui ne doit
        // pas abattre le lien — les autres points continuent d'être lus.
        POINT('absent', 'Registre inexistant', '', 'word',
              { fn: 3, reg: 9000, type: 'uint16' }),
      ]),
      lien('compteur', 'Compteur simulé', 2, [
        POINT('tension', 'Tension composée', 'V', 'float',
              { fn: 4, reg: 0, type: 'float32', wordOrder: 'big' }),
        POINT('index', 'Index d’énergie', 'Wh', 'float',
              { fn: 4, reg: 4, type: 'uint32', wordOrder: 'big' }),
      ]),
      // Unité qu'aucun équipement ne porte : le simulateur répond « équipement
      // muet » (exception 0B) comme le ferait une passerelle.
      lien('fantome', 'Unité absente', 9, [
        POINT('rien', 'Registre quelconque', '', 'word', { fn: 3, reg: 0, type: 'uint16' }),
      ]),
    ],
  }),
});
check('configuration des liens acceptée', put.status === 200 && put.json && put.json.ok === true);

await sleep(1200);

const st = await api('/api/protocols/status');
const stMap = Object.fromEntries((st.json || []).map((s) => [s.id, s]));
const dit = (id) => (stMap[id] ? stMap[id].state + ' · ' + stMap[id].detail : 'absent');

check('lien établi sur l’unité 1', stMap.banc && stMap.banc.state === 'up', dit('banc'));
check('second équipement servi sur le même port (unité 2)',
  stMap.compteur && stMap.compteur.state === 'up', dit('compteur'));
check('unité inconnue : « équipement muet » plutôt qu’une valeur inventée',
  stMap.fantome && /muet|passerelle/i.test(stMap.fantome.warn || ''),
  dit('fantome') + ' | ⚠ ' + (stMap.fantome ? stMap.fantome.warn : ''));

const test = await api('/api/protocols/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'banc' }),
});
check('test de connexion du lien', test.status === 200 && test.json.ok === true,
  test.json && test.json.detail);

const got = await collect(
  ['@banc.pression', '@banc.debit', '@banc.energie', '@banc.consigne', '@banc.vitesse',
   '@banc.pompe', '@banc.presence', '@banc.absent', '@compteur.tension', '@compteur.index'],
  1500);
const last = (a) => (got.get(a).length ? got.get(a)[got.get(a).length - 1] : null);
const dans = (a, lo, hi) => last(a) !== null && last(a) >= lo && last(a) <= hi;

check('registre de maintien lu (fn 03)', dans('@banc.pression', 0, 10),
  'valeur ' + last('@banc.pression') + ' bar');
check('flottant 32 bits sur deux registres', dans('@banc.debit', 0, 10),
  'valeur ' + last('@banc.debit') + ' m3/h');
check('entier 32 bits non signé sur deux registres', dans('@banc.energie', 0, 10),
  'valeur ' + last('@banc.energie') + ' kWh');
check('second registre de maintien lu', dans('@banc.consigne', 0, 10),
  'valeur ' + last('@banc.consigne') + ' bar');
check('registre d’entrée lu (fn 04)', dans('@banc.vitesse', 0, 10),
  'valeur ' + last('@banc.vitesse') + ' tr/min');
check('bobine lue (fn 01)', last('@banc.pompe') === 0 || last('@banc.pompe') === 1,
  'valeur ' + last('@banc.pompe'));
check('entrée TOR lue (fn 02)', last('@banc.presence') === 1,
  'valeur ' + last('@banc.presence'));
check('flottant du second équipement', dans('@compteur.tension', 0, 10),
  'valeur ' + last('@compteur.tension') + ' V');
check('index 32 bits du second équipement', dans('@compteur.index', 0, 10),
  'valeur ' + last('@compteur.index') + ' Wh');

// La dent de scie a une pente connue : sur une seconde et demie, un point lu
// toutes les 100 ms doit BOUGER. Une valeur juste mais figée passerait toutes
// les vérifications ci-dessus sans rien prouver du flux.
const etendue = (a) => { const v = got.get(a); return v.length ? Math.max(...v) - Math.min(...v) : 0; };
check('la dent de scie progresse (flottant)',
  got.get('@banc.debit').length >= 5 && etendue('@banc.debit') > 0.2,
  got.get('@banc.debit').length + ' échantillon(s), amplitude ' +
  etendue('@banc.debit').toFixed(2));

// Chaque registre porte une seconde d'avance sur le précédent : « consigne »
// (4 s d'avance) doit donc lire quatre unités de plus que « pression » (aucune),
// modulo la période. Deux points superposés signeraient une lecture qui ne
// distingue pas les adresses.
const ecart = (a, b) => (((last(b) - last(a)) % 10) + 10) % 10;
check('les registres sont décalés d’une seconde',
  last('@banc.pression') !== null && last('@banc.consigne') !== null &&
  Math.abs(ecart('@banc.pression', '@banc.consigne') - 4) < 1.5,
  'écart ' + ecart('@banc.pression', '@banc.consigne').toFixed(2) + ' pour 4 attendu');

// Adresse hors table : rien ne doit être publié — une valeur inventée serait
// pire que l'absence — et le lien doit rester ouvert pour les autres points.
check('adresse hors table : aucun échantillon publié',
  got.get('@banc.absent').length === 0,
  got.get('@banc.absent').length + ' échantillon(s)');
const apres = await api('/api/protocols/status');
const apresMap = Object.fromEntries((apres.json || []).map((s) => [s.id, s]));

// --- ce que l'état publie pour le DIAGNOSTIC ---------------------------
// « up » ne dit pas que tout va bien : un lien peut être établi et un point
// rester muet. Ces compteurs sont ce que la fenêtre « Liens réseau » affiche
// en clair, et c'est par eux qu'on distingue un défaut de liaison d'un défaut
// d'adressage.
const banc = apresMap.banc || {};
const pt = (id) => (banc.points || []).find((p) => p.id === id) || null;
check('état : compteurs par point publiés',
  Array.isArray(banc.points) && banc.points.length === 8,
  (banc.points || []).length + ' point(s) décrits');
check('point qui remonte : échantillons comptés et datés',
  pt('pression') && pt('pression').samples > 0 && pt('pression').lastS >= 0,
  pt('pression') ? pt('pression').samples + ' valeur(s), dernière il y a ' +
                   pt('pression').lastS + ' s' : 'absent');
// Le point hors table est le cas trompeur : le lien est debout, lui est muet.
check('point muet : zéro échantillon et « jamais reçu »',
  pt('absent') && pt('absent').samples === 0 && pt('absent').lastS < 0,
  pt('absent') ? pt('absent').samples + ' valeur(s), lastS ' + pt('absent').lastS : 'absent');
check('état : ancienneté et tentatives publiées',
  banc.sinceS >= 0 && banc.attempts >= 1 && banc.lastS >= 0,
  'dans cet état depuis ' + banc.sinceS + ' s · ' + banc.attempts + ' tentative(s)');

// Port fermé : le motif doit nommer la CIBLE et la cause, en français. Sans
// l'adresse, on ne sait pas si c'est la configuration ou l'équipement.
const ferme = await api('/api/protocols', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ version: 1, links: [lien('mort', 'Port fermé', 1, [
    POINT('x', 'Registre', '', 'word', { fn: 3, reg: 0, type: 'uint16' })]) ] }),
});
if (ferme.status === 200) {
  // Le lien vise volontairement un port sur lequel personne n'écoute.
  await api('/api/protocols', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, links: [{
      id: 'mort', label: 'Port fermé', protocol: 'modbus-tcp', enabled: true,
      params: { host: '127.0.0.1', port: 1, unitId: 1, timeoutMs: 500, groupMax: 32 },
      points: [POINT('x', 'Registre', '', 'word', { fn: 3, reg: 0, type: 'uint16' })],
    }] }),
  });
  await sleep(1500);
  const st2 = await api('/api/protocols/status');
  const mort = ((st2.json || []).find((s) => s.id === 'mort')) || {};
  check('port fermé : motif en français, avec l’adresse visée',
    mort.state === 'down' && /127\.0\.0\.1:1/.test(mort.detail || '') &&
    /refus|injoignable|délai/i.test(mort.detail || ''),
    mort.detail || 'aucun motif');
}
check('exception Modbus : le lien survit, l’avertissement est daté et lisible',
  apresMap.banc && apresMap.banc.state === 'up' &&
  apresMap.banc.detail === 'lien établi' &&
  /adresse|plage/i.test(apresMap.banc.warn || '') &&
  /exception 2/.test(apresMap.banc.warn || '') && apresMap.banc.warnS >= 0,
  apresMap.banc ? apresMap.banc.state + ' · ⚠ ' + apresMap.banc.warn +
                  ' (il y a ' + apresMap.banc.warnS + ' s)' : 'absent');

await api('/api/protocols', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ version: 1, links: [] }),
});

// Arrêt propre : un simulateur qui ignore SIGTERM laisserait un port occupé
// derrière lui à chaque exécution de la suite.
const arret = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 3000);
  sim.proc.on('exit', () => { clearTimeout(timer); resolve(true); });
  sim.proc.kill('SIGTERM');
});
check('le simulateur s’arrête sur SIGTERM', arret);
if (!arret) { try { sim.proc.kill('SIGKILL'); } catch {} }

console.log('');
console.log(`${results.length - failed}/${results.length} vérifications réussies`);
process.exit(failed ? 1 : 0);
