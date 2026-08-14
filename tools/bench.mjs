/* Diagweb — banc d'essai : équipements simulés, maintenus en vie.
 *
 *   node tools/bench.mjs [http://localhost:8080]   monte le banc et reste
 *   node tools/bench.mjs --stop                    retire les liens du banc
 *
 * Ce que ça change par rapport à --sim-protocols
 * ---------------------------------------------
 * `diagweb-server --sim-protocols` ne fait AUCUN réseau : les valeurs sont
 * fabriquées dans le serveur, les pilotes ne travaillent pas. Le banc, lui,
 * monte de vrais serveurs de communication sur de vraies sockets — les
 * pilotes encodent, émettent, décodent, gèrent les délais et les exceptions.
 * C'est la simulation la plus proche du réel sans matériel.
 *
 * Les équipements sont ceux de tests/protocols.mjs (tests/devices.mjs), mais
 * sur des PORTS FIXES et pour longtemps, au lieu de vivre le temps d'un test.
 * Tous écoutent sur 127.0.0.1 : rien n'est exposé au réseau, même si le port
 * du serveur de diagnostic est rendu public.
 *
 * Ports : non standard, et volontairement. Modbus 502, MMS 102 et SNMP 161
 * sont des ports privilégiés (< 1024) : l'utilisateur d'un Codespace n'est pas
 * root. Un lien vise le port qu'on lui donne, la démonstration est identique.
 *
 * Le banc ne possède QUE ses propres liens, préfixés « banc- ». Les liens que
 * tu as créés toi-même sont relus, conservés et remis en place — un banc ne
 * doit jamais effacer une configuration d'exploitation. Note tout de même que
 * PUT /api/protocols réapplique la configuration ENTIÈRE : tes liens sont
 * conservés mais brièvement rouverts, et l'historique des points réseau repart
 * de zéro.
 */
import net from 'node:net';
import fs from 'node:fs';
import {
  startModbusSlave, startIec104Station, startSnmpAgent, startSnmpd,
  startMmsIed, startOpcUaServer, SNMPD,
} from '../tests/devices.mjs';

const args = process.argv.slice(2);
const STOP = args.includes('--stop');
const BASE = args.find((a) => a.startsWith('http')) || 'http://localhost:8080';
const PREFIXE = 'banc-';

// Ports fixes du banc. Décalés des ports normalisés, qui sont privilégiés.
const PORTS = {
  modbus: 15020,   // norme : 502
  iec104: 12404,   // norme : 2404
  snmp:   11161,   // norme : 161  (agent simulé)
  snmpd:  11162,   //              (agent réel Net-SNMP, pour v3/USM)
  mms:    10102,   // norme : 102
  opcua:  14840,   // norme : 4840
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(chemin, options) {
  const r = await fetch(BASE + chemin, options);
  const texte = await r.text();
  try { return { status: r.status, json: JSON.parse(texte) }; }
  catch { return { status: r.status, text: texte }; }
}

/** Quelqu'un accepte-t-il vraiment une connexion sur ce port ? */
function portOuvert(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const fini = (v) => { s.destroy(); res(v); };
    s.setTimeout(1200);
    s.on('connect', () => fini(true));
    s.on('timeout', () => fini(false));
    s.on('error', () => fini(false));
  });
}

/* ------------------------------------------------------- serveur de diag */

const sante = await api('/api/health').catch(() => ({ status: 0 }));
if (sante.status !== 200 || sante.json?.role !== 'diag-server') {
  console.error(`Le serveur de diagnostic ne répond pas sur ${BASE}.`);
  console.error('  Le démarrer :  bash tools/share.sh --server --local');
  process.exit(2);
}

/** Remplace les liens « banc- » sans toucher aux autres. */
async function poserLiens(liensDuBanc) {
  const avant = await api('/api/protocols');
  if (avant.status !== 200 || !avant.json?.config) {
    // Sans lecture fiable de l'existant, écrire écraserait la configuration de
    // l'exploitant. On refuse plutôt que de parier.
    return { ok: false, autres: 0, reponse: avant,
             motif: 'configuration actuelle illisible — rien n’a été écrit' };
  }
  const autres = (avant.json.config.links || [])
    .filter((l) => !String(l.id).startsWith(PREFIXE));
  const r = await api('/api/protocols', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, links: [...autres, ...liensDuBanc] }),
  });
  return { ok: r.status === 200, autres: autres.length, reponse: r };
}

if (STOP) {
  const { ok, autres, motif } = await poserLiens([]);
  console.log(ok
    ? `Liens du banc retirés. ${autres} lien(s) qui ne sont pas à lui : conservés.`
    : `Échec du retrait des liens${motif ? ' — ' + motif : ''}.`);
  process.exit(ok ? 0 : 1);
}

/* ------------------------------------------------------------ équipements */

console.log(`Banc d'essai Diagweb — cible ${BASE}\n`);
console.log('→ Montage des équipements simulés');

// Tout ce qui est monté est enregistré ici AU FUR ET À MESURE : si le montage
// s'interrompt en chemin, l'arrêt d'urgence sait quand même quoi fermer.
const montes = { serveurs: [], sockets: [], procs: [], dossiers: [] };
let modbus, iec, snmp, snmpd, ied, ua;

// Déclaré AVANT le montage, et pas en fin de fichier : le premier appelant de
// nettoyer() est le catch ci-dessous, et un `let` déclaré plus bas serait
// encore dans sa zone morte — l'échec du montage se serait alors soldé par une
// ReferenceError masquant la vraie cause.
let nettoye = false;
function nettoyer() {
  if (nettoye) return;
  nettoye = true;
  for (const s of montes.serveurs) { try { s.close(); } catch { /* déjà fermé */ } }
  for (const s of montes.sockets) { try { s.close(); } catch { /* déjà fermée */ } }
  for (const p of montes.procs) { try { p.kill(); } catch { /* déjà mort */ } }
  // snmpd écrit ses phrases secrètes EN CLAIR dans son fichier de configuration
  // temporaire : le laisser derrière soi à chaque Ctrl-C serait une fuite lente.
  for (const d of montes.dossiers) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* déjà parti */ }
  }
}

try {
  modbus = await startModbusSlave(PORTS.modbus); montes.serveurs.push(modbus.server);
  iec = await startIec104Station(PORTS.iec104);  montes.serveurs.push(iec.server);
  snmp = await startSnmpAgent(PORTS.snmp);       montes.sockets.push(snmp.sock);
  snmpd = await startSnmpd(PORTS.snmpd);
  if (snmpd.proc) montes.procs.push(snmpd.proc);
  if (snmpd.dir) montes.dossiers.push(snmpd.dir);
  ied = await startMmsIed(PORTS.mms);            if (ied.proc) montes.procs.push(ied.proc);
  ua = await startOpcUaServer(PORTS.opcua);      if (ua.proc) montes.procs.push(ua.proc);
} catch (e) {
  // Le cas courant : un port fixe déjà pris parce qu'un banc tourne déjà.
  const occupe = e && e.code === 'EADDRINUSE';
  console.error(occupe
    ? `\n   Port ${e.port ?? ''} déjà occupé — un banc tourne-t-il déjà ?` +
      '\n   L’arrêter, ou libérer les ports 15020, 12404, 11161, 11162, 10102, 14840.'
    : `\n   Échec du montage : ${e && e.message ? e.message : e}`);
  nettoyer();
  process.exit(1);
}

// « Le processus a démarré » ne veut pas dire « l'équipement répond ». Les deux
// équipements lancés en processus fils peuvent mourir aussitôt (bibliothèque
// absente, port pris) : on interroge le port plutôt que de croire le spawn.
const iedVivant = !!ied.proc && await portOuvert(PORTS.mms);
const uaVivant = !ua.absent && await portOuvert(PORTS.opcua);

const equipements = [
  ['Modbus TCP (esclave)', modbus.port, 'TCP', true, ''],
  ['IEC 60870-5-104 (station)', iec.port, 'TCP', true, ''],
  ['SNMP v1/v2c (agent simulé)', snmp.port, 'UDP', true, ''],
  ['SNMP v3 authPriv (snmpd réel)', snmpd.port, 'UDP', !snmpd.absent,
   'snmpd absent : sudo apt-get install -y snmpd'],
  ['IEC 61850 MMS (IED)', ied.port, 'TCP', iedVivant,
   'le processus n’écoute pas — voir tests/mms_ied.mjs'],
  ['OPC UA (open62541)', ua.port, 'TCP', uaVivant,
   ua.absent ? 'cible non compilée : meson compile -C build'
             : 'compilé mais n’écoute pas sur son port'],
];
for (const [nom, port, tr, vivant, raison] of equipements) {
  console.log(vivant
    ? `   ✓ ${nom.padEnd(32)} ${tr} 127.0.0.1:${port}`
    : `   ✗ ${nom.padEnd(32)} lien laissé désactivé — ${raison}`);
}

/* ------------------------------------------------------------------ liens */

const liens = [
  {
    id: PREFIXE + 'modbus', label: 'Banc — Modbus TCP', protocol: 'modbus-tcp', enabled: true,
    params: { host: '127.0.0.1', port: modbus.port, unitId: 1, timeoutMs: 800, groupMax: 32 },
    points: [
      { id: 'reg0', label: 'Registre 0', unit: '', kind: 'word', periodMs: 200,
        params: { fn: 3, reg: 0, type: 'uint16', gain: 1, offset: 0, bit: -1 } },
      { id: 'pression', label: 'Pression (registre 5 mis à l’échelle)', unit: 'bar', kind: 'float',
        periodMs: 200, params: { fn: 3, reg: 5, type: 'uint16', gain: 0.1, offset: -50, bit: -1 } },
      { id: 'temperature', label: 'Température (flottant 32 bits)', unit: '°C', kind: 'float',
        periodMs: 200, params: { fn: 3, reg: 10, type: 'float32', wordOrder: 'big', gain: 1, offset: 0 } },
      { id: 'bobine', label: 'Bobine paire', unit: '', kind: 'bit', periodMs: 200,
        params: { fn: 1, reg: 4, type: 'bool', gain: 1, offset: 0 } },
      // Volontairement hors plage : montre comment un point refusé s'affiche
      // sans abattre le lien — les autres points continuent de remonter.
      { id: 'hors-plage', label: 'Registre inexistant (démonstration)', unit: '', kind: 'word',
        periodMs: 1000, params: { fn: 3, reg: 9000, type: 'uint16', gain: 1, offset: 0, bit: -1 } },
    ],
  },
  {
    id: PREFIXE + 'iec104', label: 'Banc — IEC 60870-5-104', protocol: 'iec104', enabled: true,
    params: { host: '127.0.0.1', port: iec.port, asdu: 1, originator: 0, gi: true,
              giPeriodS: 0, k: 12, w: 8, t1: 15, t2: 10, t3: 20 },
    points: [
      { id: 'tension', label: 'Mesure flottante', unit: 'kV', kind: 'float', periodMs: 200,
        params: { ioa: 100, type: 'auto', gain: 1, offset: 0 } },
      { id: 'etat', label: 'État simple', unit: '', kind: 'bit', periodMs: 200,
        params: { ioa: 200, type: 'auto', gain: 1, offset: 0 } },
      // Le même point daté deux fois : à la source (l'équipement date, ici 2 s
      // dans le passé) et au serveur. Superposés dans un graphique, l'écart se
      // voit à l'œil.
      { id: 'datee-source', label: 'Horodatée à la source', unit: 'V', kind: 'float', periodMs: 200,
        params: { ioa: 300, type: 'auto', gain: 1, offset: 0, timestamp: 'source' } },
      { id: 'datee-serveur', label: 'Horodatée au serveur', unit: 'V', kind: 'float', periodMs: 200,
        params: { ioa: 300, type: 'auto', gain: 1, offset: 0, timestamp: 'server' } },
    ],
  },
  {
    id: PREFIXE + 'snmp', label: 'Banc — SNMP v2c', protocol: 'snmp', enabled: true,
    params: { host: '127.0.0.1', port: snmp.port, version: 'v2c', community: 'public',
              timeoutMs: 1500, maxVars: 16 },
    points: [
      { id: 'uptime', label: 'Temps depuis démarrage', unit: 's', kind: 'float', periodMs: 500,
        params: { oid: '1.3.6.1.2.1.1.3.0', gain: 0.01, offset: 0 } },
      { id: 'octets', label: 'Octets reçus (Counter32)', unit: 'o', kind: 'float', periodMs: 500,
        params: { oid: '1.3.6.1.2.1.2.2.1.10.2', gain: 1, offset: 0 } },
      { id: 'signe', label: 'Entier signé', unit: '', kind: 'float', periodMs: 500,
        params: { oid: '1.3.6.1.4.1.9999.1.0', gain: 1, offset: 0 } },
      { id: 'chaine', label: 'Mesure transmise en chaîne', unit: '°C', kind: 'float', periodMs: 500,
        params: { oid: '1.3.6.1.4.1.9999.2.0', gain: 1, offset: 0 } },
    ],
  },
  {
    id: PREFIXE + 'snmpv3', label: 'Banc — SNMP v3 authPriv (agent réel)', protocol: 'snmp',
    enabled: !snmpd.absent,
    params: { host: '127.0.0.1', port: snmpd.port, version: 'v3', user: SNMPD.user,
              level: 'authPriv', authProto: 'SHA', privProto: 'AES',
              secretRef: SNMPD.ref, timeoutMs: 2500, maxVars: 8 },
    points: [
      { id: 'uptime', label: 'Temps depuis démarrage', unit: 's', kind: 'float', periodMs: 500,
        params: { oid: '1.3.6.1.2.1.1.3.0', gain: 0.01, offset: 0 } },
    ],
  },
  {
    id: PREFIXE + 'iec61850', label: 'Banc — IEC 61850 (MMS)', protocol: 'iec61850',
    enabled: iedVivant,
    params: { host: '127.0.0.1', port: ied.port, mode: 'mms', iedName: 'IED1', timeoutMs: 3000 },
    points: [
      { id: 'courant', label: 'Courant phase A', unit: 'A', kind: 'float', periodMs: 300,
        params: { ref: 'LD0/MMXU1.A.phsA.cVal.mag.f', fc: 'MX', gain: 1, offset: 0 } },
      { id: 'position', label: 'Position disjoncteur', unit: '', kind: 'word', periodMs: 300,
        params: { ref: 'LD0/XCBR1.Pos.stVal', fc: 'ST', gain: 1, offset: 0 } },
    ],
  },
  {
    id: PREFIXE + 'opcua', label: 'Banc — OPC UA', protocol: 'opcua', enabled: uaVivant,
    params: { endpoint: 'opc.tcp://127.0.0.1:' + ua.port, securityPolicy: 'None',
              securityMode: 'None', auth: 'anonymous', mode: 'subscribe',
              publishMs: 200, sessionTimeoutS: 60 },
    points: [
      { id: 'pression', label: 'Pression', unit: 'bar', kind: 'float', periodMs: 300,
        params: { nodeId: 'ns=1;s=pression', attr: 'Value', samplingMs: 100,
                  deadband: 0, gain: 10, offset: 0 } },
      { id: 'compteur', label: 'Compteur signé', unit: '', kind: 'float', periodMs: 300,
        params: { nodeId: 'ns=1;s=compteur', attr: 'Value', samplingMs: 100,
                  deadband: 0, gain: 1, offset: 0 } },
      { id: 'marche', label: 'Booléen', unit: '', kind: 'bit', periodMs: 300,
        params: { nodeId: 'ns=1;s=marche', attr: 'Value', samplingMs: 100,
                  deadband: 0, gain: 1, offset: 0 } },
    ],
  },
];

console.log('\n→ Configuration des liens dans le serveur de diagnostic');
let pose;
try {
  pose = await poserLiens(liens);
} catch (e) {
  console.error('   Serveur injoignable :', e && e.message ? e.message : e);
  nettoyer();
  process.exit(1);
}
if (!pose.ok) {
  console.error('   Échec :', pose.motif ||
    JSON.stringify(pose.reponse.json || pose.reponse.text));
  nettoyer();
  process.exit(1);
}
console.log(`   ${liens.length} lien(s) du banc posés` +
            (pose.autres ? `, ${pose.autres} lien(s) à toi conservés` : ''));

/* ------------------------------------------------------------------- état */

// Laisse aux pilotes le temps d'ouvrir leurs connexions avant de juger.
await sleep(3000);

let parId = new Map();
try {
  const etat = await api('/api/protocols/status');
  parId = new Map((etat.json || []).map((s) => [s.id, s]));
} catch (e) {
  console.log(`\n   (état des liens indisponible : ${e && e.message ? e.message : e})`);
}
console.log('\n→ État des liens');
let v3EnDefaut = false;
for (const l of liens) {
  const s = parId.get(l.id);
  const etat = s ? (s.state || s.status || '?') : (parId.size ? 'inconnu' : '—');
  const dit = !l.enabled ? 'désactivé (équipement absent)'
            : etat + (s && s.detail && etat !== 'up' ? ` — ${s.detail}` : '');
  if (l.id === PREFIXE + 'snmpv3' && l.enabled && etat !== 'up') v3EnDefaut = true;
  console.log(`   ${l.label.padEnd(38)} ${dit}`);
}

// Le banc ne peut PAS lire l'environnement du serveur de diagnostic : c'est un
// autre processus. On ne devine donc rien — on lit l'état réel du lien, et on
// ne parle que s'il est en défaut, seul moment où le rappel sert.
if (v3EnDefaut) {
  console.log('\n   Le lien v3 n’est pas ouvert. Cause la plus fréquente : les phrases');
  console.log('   secrètes doivent être dans l’environnement du SERVEUR, jamais dans la');
  console.log('   configuration. Les poser puis relancer le serveur :');
  console.log(`       export DIAGWEB_SECRET_AGENT_AUTH=${SNMPD.auth}`);
  console.log(`       export DIAGWEB_SECRET_AGENT_PRIV=${SNMPD.priv}`);
  console.log('   Sans elles, v3 refuse de s’ouvrir — jamais de repli en clair.');
}

console.log(`
────────────────────────────────────────────────────────────────
 Banc monté. Ouvrir la page servie par le serveur lui-même —
 ${BASE}/web/index.html — et non l'Artifact ni GitHub Pages,
 qui n'ont aucun serveur derrière eux.

 RECHARGER l'onglet s'il était déjà ouvert : l'interface ne lit la
 configuration des liens qu'au chargement. Sans rechargement le banc
 y est invisible, et un enregistrement depuis ☰ → « Liens réseau »
 réécrirait la configuration sans ses liens.

 Les points sont adressés @<lien>.<point>, par exemple

   @${PREFIXE}modbus.temperature      @${PREFIXE}iec104.tension
   @${PREFIXE}snmp.uptime             @${PREFIXE}opcua.pression

 Ctrl-C arrête les équipements ; les liens restent configurés et
 passeront « en défaut ». « node tools/bench.mjs --stop » les retire.
────────────────────────────────────────────────────────────────`);

/* ------------------------------------------------------------- entretien */

function fermer() {
  if (nettoye) process.exit(0);
  console.log('\n→ Arrêt des équipements');
  nettoyer();
  // Filet : un fils qui ignore SIGTERM garderait son port fixe et empêcherait
  // le banc suivant de démarrer. On lui laisse un instant, puis on n'insiste
  // plus. Ces équipements n'ont aucun état à préserver.
  setTimeout(() => {
    for (const p of montes.procs) { try { p.kill('SIGKILL'); } catch { /* déjà mort */ } }
    console.log('   Liens conservés — « node tools/bench.mjs --stop » pour les retirer.');
    process.exit(0);
  }, 400);
}

// SIGHUP compte autant que les deux autres : fermer l'onglet du terminal ou
// perdre la liaison du Codespace l'envoie, et snmpd, lui, le prend pour une
// relecture de configuration — il survivrait en gardant son port.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, fermer);

// Dernier filet : toute sortie non prévue passe encore par le nettoyage. Sans
// lui, une exception laissait trois processus fils tenir leurs ports fixes,
// et le banc suivant échouait sans que rien ne dise pourquoi.
process.on('exit', nettoyer);
process.on('uncaughtException', (e) => {
  console.error('\nErreur non rattrapée :', e && e.message ? e.message : e);
  nettoyer();
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('\nPromesse rejetée sans traitement :', e && e.message ? e.message : e);
  nettoyer();
  process.exit(1);
});

// Maintient le processus en vie sans consommer : les équipements tournent sur
// leurs propres sockets, il n'y a rien à faire ici qu'attendre.
setInterval(() => {}, 1 << 30);
