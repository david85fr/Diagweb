/* Diagweb — test des fonctions serveur : forçage de variables et
 * journalisation autonome (le serveur enregistre même sans navigateur).
 *
 *   node tests/server.mjs [http://localhost:8080]
 *
 * Le serveur de diagnostic doit tourner. Aucune dépendance : fetch et
 * WebSocket sont fournis par Node.
 */
import net from 'node:net';

const BASE = process.argv[2] || 'http://localhost:8080';
const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options) {
  const r = await fetch(BASE + path, options);
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text), text }; }
  catch { return { status: r.status, text }; }
}

console.log('Cible : ' + BASE + '\n');

const health = await api('/api/health');
if (health.status !== 200 || !health.json || health.json.role !== 'diag-server') {
  console.error('Le serveur de diagnostic ne répond pas sur ' + BASE);
  process.exit(2);
}

// ---------------------------------------------------------- forçage (WS)
const forcing = await new Promise((resolve, reject) => {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
  const acks = [];
  const samples = [];
  ws.onerror = () => reject(new Error('WebSocket indisponible'));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.e === 'set') acks.push(m);
    if (m.e === 'd' && m.s['Q0.3']) for (const [, v] of m.s['Q0.3']) samples.push(v);
  };
  ws.onopen = async () => {
    ws.send(JSON.stringify({ c: 'sub', addr: 'Q0.3', periodMs: 50 }));
    await sleep(300);
    ws.send(JSON.stringify({ c: 'set', addr: 'Q0.3', value: 1 }));
    await sleep(500);
    const forcedVal = samples.slice(-3);
    ws.send(JSON.stringify({ c: 'set', addr: '@banc.x', value: 1 }));   // doit être refusé
    await sleep(200);
    ws.send(JSON.stringify({ c: 'set', addr: 'Q0.3', release: 1 }));
    await sleep(200);
    try { ws.close(); } catch { /* déjà fermé */ }
    resolve({ acks, forcedVal });
  };
});

const setOk = forcing.acks.find((m) => m.addr === 'Q0.3' && m.ok && m.value === 1);
check('forçage d’une variable accepté (Q0.3 = 1)', !!setOk);
check('la variable forcée remonte bien la valeur imposée',
  forcing.forcedVal.length > 0 && forcing.forcedVal.every((v) => v === 1),
  'derniers échantillons : ' + forcing.forcedVal.join(', '));
const netRefused = forcing.acks.find((m) => m.addr === '@banc.x' && m.ok === false);
check('forçage d’un point réseau refusé (lecture seule)',
  !!netRefused, netRefused ? netRefused.msg : 'aucune réponse');
const released = forcing.acks.find((m) => m.addr === 'Q0.3' && m.ok && m.value === null);
check('relâchement d’une variable forcée', !!released);

// ------------------------------------------ journalisation autonome (REST)
const NAME = 'test auto ' + Math.floor(health.json.now);
const start = await api('/api/datalog/start', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: NAME,
    addrs: [{ addr: 'MB414', periodMs: 50 }, { addr: 'Regulation.mesure.vitesse', periodMs: 100 }],
  }),
});
check('démarrage d’une campagne de journalisation serveur',
  start.status === 200 && start.json && start.json.ok === true);

// Aucune connexion WebSocket ouverte ici : le serveur doit journaliser seul.
await sleep(1300);

const status = await api('/api/datalog');
const camp = (status.json || []).find((x) => x.name === NAME);
check('la campagne enregistre sans navigateur connecté',
  camp && camp.samples > 5 && camp.vars === 2,
  camp ? camp.samples + ' échantillons, ' + camp.vars + ' variables' : 'campagne absente');

const csv = await api('/api/datalog/file?name=' + encodeURIComponent(NAME));
const lines = (csv.text || '').trim().split(/\r?\n/);
check('téléchargement du CSV enregistré (entête + lignes)',
  csv.status === 200 && lines[0] === 'horodatage_iso;t_s;adresse;valeur' && lines.length > 5,
  lines.length + ' lignes');
check('les lignes du CSV portent les bonnes variables',
  lines.slice(1).some((l) => l.includes(';MB414;')) &&
  lines.slice(1).some((l) => l.includes(';Regulation.mesure.vitesse;')));

const stop = await api('/api/datalog/stop', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: NAME }),
});
const stillThere = (stop.json && stop.json.status || []).some((x) => x.name === NAME);
check('arrêt de la campagne', stop.status === 200 && stop.json.ok === true && !stillThere);

// ---- apparence : logo et couleurs de l'installation ----------------------
// Réglages d'exploitant partagés par tous les postes : ils sont conservés par
// le serveur, et lui seul décide de ce qu'il accepte.
{
  const depart = await api('/api/appearance');
  check('apparence : point d’entrée disponible (JSON, même sans réglage)',
    depart.status === 200 && depart.json && typeof depart.json === 'object',
    JSON.stringify(depart.json).slice(0, 40));

  const skin = {
    version: 1,
    logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    colors: { dark: { accent: '#ff7a00' }, light: { bg: '#fafafa' } },
  };
  const mis = await api('/api/appearance', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(skin),
  });
  const relu = await api('/api/appearance');
  check('apparence enregistrée et relue à l’identique',
    mis.status === 200 && mis.json.ok === true &&
    relu.json && relu.json.logo === skin.logo &&
    relu.json.colors.dark.accent === '#ff7a00');

  // Un logo est une image INCORPORÉE. Une URL ferait sortir la page vers un
  // hôte tiers — interdit par la règle du projet, et refusé par une CSP
  // stricte : le serveur doit dire non plutôt que d'enregistrer un piège.
  const distant = await api('/api/appearance', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logo: 'https://exemple.tld/logo.png' }),
  });
  check('apparence : logo distant refusé (aucune ressource externe)',
    distant.status === 400 && /data:image/.test(distant.json.error || ''),
    distant.json && distant.json.error);

  const gros = await api('/api/appearance', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: '{"logo":"data:image/png;base64,' + 'A'.repeat(600000) + '"}',
  });
  check('apparence : charge utile démesurée refusée (413)', gros.status === 413,
    gros.json && gros.json.error);

  const casse = await api('/api/appearance', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'pas du json',
  });
  const intact = await api('/api/appearance');
  check('apparence : JSON invalide refusé, réglage précédent intact',
    casse.status === 400 && intact.json.colors.dark.accent === '#ff7a00');

  // Le test ne laisse pas sa marque : l'installation retrouve son apparence
  // d'origine, et une seconde exécution part du même état.
  await api('/api/appearance', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, logo: '', colors: { dark: {}, light: {} } }),
  });
}

// ------------------------------------------ robustesse aux entrées hostiles
// Chacune de ces requêtes provoquait auparavant une exception non capturée
// (std::sto*) qui faisait tomber tout le serveur. Il doit y survivre.
function rawRequest(payload) {
  return new Promise((resolve) => {
    const u = new URL(BASE);
    const sock = net.connect(Number(u.port) || 80, u.hostname, () => sock.write(payload));
    sock.on('data', () => {});
    sock.on('close', () => resolve());
    sock.on('error', () => resolve());
    setTimeout(() => { try { sock.destroy(); } catch { /* déjà fermé */ } resolve(); }, 500);
  });
}
await rawRequest('GET / HTTP/1.1\r\nHost: x\r\nContent-Length: pas-un-nombre\r\n\r\n');
await api('/api/layouts/%zz');                                  // %-encodage invalide
await new Promise((resolve) => {                                // adresse MB démesurée
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
  ws.onopen = async () => {
    ws.send(JSON.stringify({ c: 'sub', addr: 'MB999999999999999999999' }));
    ws.send(JSON.stringify({ c: 'unsub', addr: 'MB999999999999999999999' }));
    await sleep(200); try { ws.close(); } catch { /* rien */ } resolve();
  };
  ws.onerror = () => resolve();
});
await sleep(300);
const after = await api('/api/health');
check('le serveur survit aux entrées malveillantes (pas de crash)',
  after.status === 200 && after.json && after.json.role === 'diag-server');

console.log('');
console.log(`${results.length - failed}/${results.length} vérifications réussies`);
process.exit(failed ? 1 : 0);
