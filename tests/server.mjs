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
/* Second passage, joué par tools/run-server-tests.sh après avoir redémarré le
 * serveur sur le MÊME dossier de données : seule la persistance est vérifiée. */
const APRES_REDEMARRAGE = process.argv.includes('--apres-redemarrage');
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

/* Nature des données annoncée séparément, et non déduite du nom de la source.
 * Le nom seul disait « Serveur de diagnostic (simulation) », ce qui se lisait
 * « tout est simulé » alors que les liens réseau peuvent acquérir pour de bon.
 * Deux faits indépendants, donc deux champs. */
check('nature annoncée : variables internes du controller simulées',
  health.json.controllerSimulated === true,
  'nom de la source : ' + health.json.source);
check('nature annoncée : les pilotes réseau ne sont pas simulés (sans --sim-protocols)',
  !!health.json.links && health.json.links.simulated === false,
  JSON.stringify(health.json.links));
check('le nom de la source ne préjuge plus de la nature des liens',
  typeof health.json.source === 'string' && !/simulation/i.test(health.json.source),
  health.json.source);

// ------------------------------------------- persistance après redémarrage
/* Un déclencheur armé pour attraper un incident rare ne vaut que s'il survit
 * à une coupure — c'est parfois la coupure elle-même qu'on cherche à
 * comprendre. Le témoin a été posé par le premier passage, avant l'arrêt du
 * serveur ; il doit être là après. */
if (APRES_REDEMARRAGE) {
  const c = await api('/api/capture');
  const t = (c.json && c.json.trigger) || {};
  check('capture : le quota survit au redémarrage du serveur',
    c.json && c.json.quotaBytes === 50 * 1024 * 1024,
    Math.round((c.json.quotaBytes || 0) / 1048576) + ' Mo');
  check('capture : le déclencheur survit au redémarrage du serveur',
    t.enabled === true && t.addr === 'S0.7' && t.mode === 'below' &&
    t.threshold === 3 && t.iface === 'lo' && t.durationS === 12,
    t.addr + ' ' + t.mode + ' ' + t.threshold + ' · ' + t.iface + ' · ' + t.durationS + ' s');
  console.log('');
  console.log(`${results.length - failed}/${results.length} vérifications réussies`);
  process.exit(failed ? 1 : 0);
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
    addrs: [{ addr: 'MB414', periodMs: 50, name: 'Mot 414' },
            { addr: 'Regulation.mesure.vitesse', periodMs: 100 }],
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

// Tri par horodatage (défaut) : une ligne par instant, une colonne par
// variable « adresse — nom ».
const csv = await api('/api/datalog/file?name=' + encodeURIComponent(NAME));
const lines = (csv.text || '').trim().split(/\r?\n/);
check('CSV trié par horodatage : entête large, adresse et nom en colonne',
  csv.status === 200 && lines[0].startsWith('horodatage_iso;t_s;') &&
  lines[0].includes('MB414 — Mot 414') &&
  lines[0].includes('Regulation.mesure.vitesse') && lines.length > 5,
  lines[0]);
// Les deux périodes (50 et 100 ms) sont calées sur la même grille : aux
// multiples communs, la ligne doit porter LES DEUX valeurs — c'est tout
// l'objet du calage (sinon deux lignes en quinconce).
const fusionnees = lines.slice(1).filter((l) => {
  const c = l.split(';');
  return c.length >= 4 && c[2] !== '' && c[3] !== '';
});
check('variables de même grille fusionnées sur une seule ligne',
  fusionnees.length > 0, fusionnees.length + ' ligne(s) à deux valeurs');

// Tri par variable : une ligne par échantillon, groupées par variable.
const csvVar = await api('/api/datalog/file?name=' + encodeURIComponent(NAME) + '&sort=var');
const linesVar = (csvVar.text || '').trim().split(/\r?\n/);
check('CSV trié par variable : une ligne par échantillon, deux horodatages',
  csvVar.status === 200 &&
  linesVar[0] === 'adresse;nom;horodatage_iso;horodatage_source_iso;t_s;valeur' &&
  linesVar.slice(1).some((l) => l.startsWith('MB414;Mot 414;')) &&
  linesVar.slice(1).some((l) => l.startsWith('Regulation.mesure.vitesse;')),
  linesVar[0]);

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

// ---- interfaces, audit, LLDP, capture -----------------------------------
// Trois pages de diagnostic réseau, servies par le contrôleur. Ce qu'on
// vérifie ici, c'est le CONTRAT : ce que le serveur expose et ce qu'il refuse.
{
  const ifs = await api('/api/interfaces');
  const lo = (ifs.json || []).find((i) => i.name === 'lo');
  check('inventaire des interfaces (type, MAC, MTU, adresses)',
    Array.isArray(ifs.json) && ifs.json.length > 0 && lo && lo.kind === 'boucle' &&
    lo.ips.includes('127.0.0.1'),
    (ifs.json || []).map((i) => i.name + ':' + i.kind).join(' '));

  // Audit : la vue « observée » vient du noyau. Le port d'écoute du serveur
  // doit y figurer, en entrant — sinon le rapport ne vaut rien.
  const a = await api('/api/audit');
  const port = String(new URL(BASE).port || 80);
  const ecoute = (a.json.sockets || []).find(
    (s) => s.direction === 'entrante' && s.local.endsWith(':' + port));
  check('audit : le port d’écoute apparaît en entrant',
    a.status === 200 && !!ecoute, ecoute ? ecoute.local + ' · ' + ecoute.state : 'absent');
  check('audit : les liens déclarés et les interfaces sont joints',
    Array.isArray(a.json.links) && Array.isArray(a.json.interfaces) &&
    a.json.interfaces.length > 0);
  // Une connexion ACCEPTÉE n'est pas une connexion sortante : se tromper de
  // sens dans un audit de sécurité serait pire que de ne rien afficher.
  const fausseSortie = (a.json.sockets || []).some(
    (s) => s.direction === 'sortante' && s.local.endsWith(':' + port));
  check('audit : une connexion acceptée n’est pas comptée sortante', !fausseSortie);

  // LLDP : écoute passive. Sans CAP_NET_RAW la socket ne s'ouvre pas, et le
  // serveur doit le DIRE — un tableau vide se lirait « aucun voisin ».
  const l = await api('/api/lldp');
  check('voisinage LLDP : état annoncé sans ambiguïté',
    l.status === 200 && typeof l.json.active === 'boolean' &&
    (l.json.active || (l.json.error || '').length > 0),
    l.json.active ? 'écoute active' : 'inactive : ' + l.json.error);
  const l2 = await api('/api/lldp', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeoutS: 1800 }),
  });
  check('voisinage LLDP : délai d’oubli réglable (600 s par défaut)',
    l2.json.timeoutS === 1800, 'réglé à ' + l2.json.timeoutS + ' s');
  await api('/api/lldp', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeoutS: 600 }),
  });

  // Capture : tcpdump peut manquer sur la machine de test ; l'absence est
  // dite, elle ne fait pas échouer ce qui n'en dépend pas.
  const c = await api('/api/capture');
  check('capture : quota de disque annoncé (100 Mo par défaut)',
    c.status === 200 && c.json.quotaBytes === 100 * 1024 * 1024,
    Math.round(c.json.quotaBytes / 1048576) + ' Mo · outil ' + (c.json.tool || 'absent'));

  const inconnue = await api('/api/capture/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ iface: 'nexistepas', durationS: 1 }),
  });
  check('capture : interface inconnue refusée tout de suite',
    inconnue.status === 400 && /inconnue/.test(inconnue.json.error || ''),
    inconnue.json && inconnue.json.error);

  // Le privilège est annoncé AVANT le premier essai : un refus de capacité
  // arrive sinon sous la forme « socket: Operation not permitted », qu'on
  // prend pour un défaut de l'interface choisie. Chaîne vide = rien ne s'y
  // oppose ; sinon elle porte la raison ET la commande qui débloque.
  check('capture : privilège annoncé avant toute tentative',
    typeof c.json.privilege === 'string' &&
    (c.json.privilege === '' || /setcap|CAP_NET_RAW|cap-add/.test(c.json.privilege)),
    c.json.privilege || 'rien ne s’y oppose');

  if (c.json.tool && !c.json.privilege) {
    const dep = await api('/api/capture/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iface: 'lo', durationS: 2 }),
    });
    const run = (dep.json.state && dep.json.state.runs || []).slice(-1)[0];
    check('capture : démarrée sur une interface réelle',
      dep.status === 200 && run && run.state === 'en cours',
      run ? run.id + ' · ' + run.state : (dep.json.error || 'aucune'));
    await sleep(2600);
    const fin = await api('/api/capture');
    const term = (fin.json.runs || []).find((r) => r.id === (run && run.id));
    check('capture : arrêtée d’elle-même à la durée demandée',
      term && term.state === 'terminée' && /durée/.test(term.detail || ''),
      term ? term.state + ' · ' + term.detail : 'introuvable');
    const pcap = await fetch(BASE + '/api/capture/file?name=' + encodeURIComponent(run.id));
    const octets = Buffer.from(await pcap.arrayBuffer());
    // 0xa1b2c3d4 : nombre magique d'un fichier pcap. Un fichier tronqué ou
    // vide serait illisible dans Wireshark, ce qui viderait la fonction de
    // son sens.
    check('capture : fichier pcap valide au téléchargement',
      pcap.status === 200 && octets.length >= 24 &&
      [0xa1b2c3d4, 0xd4c3b2a1, 0xa1b23c4d, 0x4d3cb2a1].includes(octets.readUInt32BE(0)),
      octets.length + ' octets');
    const sup = await api('/api/capture/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: run.id }),
    });
    check('capture : fichier supprimé (quota libéré)',
      sup.status === 200 && !(sup.json.state.runs || []).some((r) => r.id === run.id));
  } else if (c.json.tool) {
    // Machine sans la capacité : une vraie capture y échouerait forcément, et
    // faire échouer le test pour cela dirait le contraire de ce qu'il vérifie.
    check('capture : capacité absente de cette machine — vérifications sautées', true,
      c.json.privilege);
  } else {
    check('capture : tcpdump absent de cette machine — vérifications sautées', true,
      'installer tcpdump pour les jouer');
  }
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

// Témoin de persistance : relu par le second passage, après redémarrage.
const temoin = await api('/api/capture/config', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    quotaMB: 50,
    trigger: { enabled: true, addr: 'S0.7', mode: 'below', threshold: 3,
               iface: 'lo', durationS: 12 },
  }),
});
check('capture : quota et déclencheur enregistrés (témoin de persistance)',
  temoin.status === 200 && temoin.json.state.trigger.addr === 'S0.7' &&
  temoin.json.state.quotaBytes === 50 * 1024 * 1024,
  'relu après redémarrage par le second passage');

console.log('');
console.log(`${results.length - failed}/${results.length} vérifications réussies`);
process.exit(failed ? 1 : 0);
