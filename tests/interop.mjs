/* Diagweb — interopérabilité : notre client OPC UA contre un serveur PUBLIC.
 *
 *   node tests/interop.mjs [http://localhost:8080] [opc.tcp://…]
 *
 * Pourquoi ce test existe, à part des équipements simulés de tests/protocols.mjs :
 * un bouchon prouve que le pilote décode ce que NOUS encodons. C'est nécessaire,
 * ce n'est pas suffisant. Une pile écrite par d'autres — jeu de politiques de
 * sécurité, découpage des messages, gestion de session, types du modèle
 * d'information — est le seul juge honnête de l'interopérabilité.
 *
 * Pourquoi il n'est PAS dans l'intégration continue de chaque poussée : il
 * dépend d'un serveur tiers, gratuit et sans engagement de disponibilité. Un
 * rouge doit vouloir dire « notre code a un défaut » ; sinon plus personne ne
 * le regarde. Il se lance donc à la main (workflow « Interopérabilité »).
 *
 * Les nœuds interrogés sont ceux que la norme impose à TOUT serveur (partie 5,
 * identifiants réservés de l'espace de noms 0) — aucun objet propre à une
 * marque, aucune supposition sur l'adressage du serveur d'en face :
 *
 *   i=2259  Server.ServerStatus.State        énumération (0 = Running)
 *   i=2258  Server.ServerStatus.CurrentTime  DateTime — volontairement non
 *                                            numérique : rien ne doit être publié
 *
 * Codes de sortie : 0 succès · 1 échec réel · 2 notre serveur ne répond pas ·
 * 3 le serveur public est injoignable (rien à conclure sur notre code).
 */
const BASE = process.argv[2] || 'http://localhost:8080';
const ENDPOINT = process.argv[3] || process.env.DIAGWEB_INTEROP_ENDPOINT ||
                 'opc.tcp://uademo.prosysopc.com:53530/OPCUA/SimulationServer';

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

const POINT = (id, label, node) => ({
  id, label, unit: '', kind: 'float', periodMs: 500,
  params: { nodeId: node, attr: 'Value', samplingMs: 250, deadband: 0, gain: 1, offset: 0 },
});

console.log('Serveur de diagnostic : ' + BASE);
console.log('Serveur OPC UA public : ' + ENDPOINT + '\n');
console.log('⚠ La configuration des liens réseau du serveur va être remplacée,');
console.log('  puis vidée en fin de test.\n');

const health = await api('/api/health');
if (health.status !== 200 || !health.json || health.json.role !== 'diag-server') {
  console.error('Le serveur de diagnostic ne répond pas sur ' + BASE +
    ' — lancer server/build/diagweb-server.');
  process.exit(2);
}

const commun = { endpoint: ENDPOINT, securityPolicy: 'None', securityMode: 'None',
                 auth: 'anonymous', sessionTimeoutS: 60 };
const put = await api('/api/protocols', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    version: 1,
    links: [
      { id: 'pubpoll', label: 'Serveur public (interrogation)', protocol: 'opcua', enabled: true,
        params: { ...commun, mode: 'poll' },
        points: [POINT('etat', 'État du serveur', 'i=2259'),
                 POINT('heure', 'Heure courante (DateTime)', 'i=2258')] },
      { id: 'pubsub', label: 'Serveur public (abonnement)', protocol: 'opcua', enabled: true,
        params: { ...commun, mode: 'subscribe', publishMs: 500 },
        points: [POINT('etat', 'État du serveur', 'i=2259')] },
    ],
  }),
});
check('configuration acceptée', put.status === 200 && put.json && put.json.ok === true);

// Une liaison au-delà de l'internet public demande plus qu'un aller-retour
// local : poignée de main UA-TCP, canal sécurisé, session, activation.
await sleep(6000);

const st = await api('/api/protocols/status');
const stMap = Object.fromEntries((st.json || []).map((s) => [s.id, s]));
const dit = (id) => (stMap[id] ? stMap[id].state + ' · ' + stMap[id].detail : 'absent');

// Serveur d'en face muet ou injoignable : ce n'est pas un défaut de notre code,
// et le dire est plus utile que d'afficher un rouge trompeur.
const injoignable = ['pubpoll', 'pubsub'].every((id) => {
  const s = stMap[id];
  return s && s.state === 'down' &&
         /connexion|injoignable|délai|timeout|résolution|refus/i.test(s.detail || '');
});
if (injoignable) {
  console.log('\n⚠ Serveur public injoignable : ' + dit('pubpoll'));
  console.log('  Rien à conclure sur le client Diagweb — réessayer plus tard,');
  console.log('  ou viser un autre point de terminaison (3e argument).');
  await api('/api/protocols', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, links: [] }),
  });
  process.exit(3);
}

check('session établie en interrogation cyclique',
  stMap.pubpoll && stMap.pubpoll.state === 'up', dit('pubpoll'));
check('session établie en abonnement', stMap.pubsub && stMap.pubsub.state === 'up',
  dit('pubsub'));

const test = await api('/api/protocols/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'pubpoll' }),
});
check('test de connexion du lien', test.status === 200 && test.json.ok === true,
  test.json && test.json.detail);

const got = await collect(['@pubpoll.etat', '@pubpoll.heure', '@pubsub.etat'], 3000);
const last = (a) => (got.get(a).length ? got.get(a)[got.get(a).length - 1] : null);

// ServerStatus.State est imposé par la norme à tout serveur : 0 = Running.
check('état du serveur lu (i=2259, imposé par la norme)',
  last('@pubpoll.etat') === 0, 'valeur ' + last('@pubpoll.etat') +
  (last('@pubpoll.etat') === 0 ? ' (Running)' : ''));
check('abonnement notifié (valeur initiale reçue)', got.get('@pubsub.etat').length >= 1,
  got.get('@pubsub.etat').length + ' notification(s)');
// Un DateTime n'est pas une grandeur : le convertir en nombre serait inventer
// une mesure. Rien ne doit sortir.
check('type non numérique (DateTime) jamais publié',
  got.get('@pubpoll.heure').length === 0,
  got.get('@pubpoll.heure').length + ' échantillon(s)');

await api('/api/protocols', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ version: 1, links: [] }),
});

console.log('');
console.log(`${results.length - failed}/${results.length} vérifications réussies`);
process.exit(failed ? 1 : 0);
