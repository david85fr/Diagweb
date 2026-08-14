/* Diagweb — test bout en bout des liens réseau du serveur de diagnostic.
 *
 * Monte de faux équipements (esclave Modbus TCP, station IEC 60870-5-104,
 * agent SNMP v2c, IED IEC 61850, serveur OPC UA), configure les liens par l'API
 * REST du serveur, puis vérifie que les points remontent bien jusqu'au flux
 * WebSocket avec les bonnes valeurs.
 *
 *   node tests/protocols.mjs [http://localhost:8080]
 *
 * Le serveur doit tourner (server/build/diagweb-server), et pour SNMPv3 avec
 * les phrases secrètes dans son environnement (voir tools/check.sh).
 *
 * Deux équipements ne sont pas simulés, parce qu'ils ne peuvent pas l'être
 * honnêtement : le serveur OPC UA de test (compilé avec open62541) et l'agent
 * SNMP réel (snmpd de Net-SNMP, pour éprouver USM). Leur absence n'est pas
 * passée sous silence — les vérifications concernées échouent avec la raison.
 * Le reste ne dépend de rien : net, dgram et WebSocket viennent de Node.
 *
 * Les équipements eux-mêmes vivent dans tests/devices.mjs, pour être montés
 * aussi par le banc d'essai (tools/bench.mjs) — sur ports fixes et pour
 * longtemps, au lieu du temps d'un test.
 */
import fs from 'node:fs';

// Les équipements simulés vivent dans tests/devices.mjs : le banc d'essai
// (tools/bench.mjs) monte exactement les mêmes, sur des ports fixes.
import {
  startModbusSlave, startIec104Station, startSnmpAgent, startSnmpd,
  startMmsIed, startOpcUaServer, snmpProbe, SNMPD, DECALAGE_S,
} from './devices.mjs';

const BASE = process.argv[2] || 'http://localhost:8080';
const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- utilitaires
async function api(path, options) {
  const r = await fetch(BASE + path, options);
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, text }; }
}

/** Abonne des adresses au flux temps réel et collecte les valeurs reçues. */
function collect(addrs, ms) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
    const got = new Map(addrs.map((a) => [a, []]));
    const dates = new Map(addrs.map((a) => [a, []]));
    const metas = new Map();
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ got, dates, metas }); }, ms);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket indisponible')); };
    ws.onopen = () => { for (const a of addrs) ws.send(JSON.stringify({ c: 'sub', addr: a })); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.e === 'meta') metas.set(m.addr, m);
      if (m.e === 'd') {
        for (const a of addrs) {
          for (const [t, v] of m.s[a] || []) { got.get(a).push(v); dates.get(a).push(t); }
        }
      }
    };
  });
}

// --------------------------------------------------------------------- test
console.log('Cible : ' + BASE + '\n');

const health = await api('/api/health');
if (health.status !== 200 || !health.json || health.json.role !== 'diag-server') {
  console.error('Le serveur de diagnostic ne répond pas sur ' + BASE +
    ' — lancer server/build/diagweb-server.');
  process.exit(2);
}

const modbus = await startModbusSlave();
const iec = await startIec104Station();
const snmp = await startSnmpAgent();
const snmpd = await startSnmpd();
const ua = await startOpcUaServer(48401);
const ied = await startMmsIed(10250);

// hrSystemDate n'est pas servi par tous les agents : on le demande avant de
// fonder une vérification dessus, plutôt que de prendre une absence pour un
// défaut du pilote.
const hrDate = snmpd.absent ? null : await snmpProbe(snmpd.port, '1.3.6.1.2.1.25.1.2.0');
const hrDateSert = !!hrDate && hrDate.tag === 0x04 &&
                   (hrDate.body.length === 8 || hrDate.body.length === 11);

const before = await api('/api/protocols');
check('description des protocoles publiée par le serveur',
  before.status === 200 && Array.isArray(before.json.protocols) && before.json.protocols.length >= 6,
  (before.json.protocols || []).map((p) => p.id).join(', '));

const config = {
  version: 1,
  links: [
    {
      id: 'banc', label: 'Banc Modbus', protocol: 'modbus-tcp', enabled: true,
      params: { host: '127.0.0.1', port: modbus.port, unitId: 1, timeoutMs: 800, groupMax: 32 },
      points: [
        { id: 'reg0', label: 'Registre 0', unit: '', kind: 'word', periodMs: 100,
          params: { fn: 3, reg: 0, type: 'uint16', gain: 1, offset: 0, bit: -1 } },
        { id: 'reg5', label: 'Registre 5 mis à l’échelle', unit: 'bar', kind: 'float', periodMs: 100,
          params: { fn: 3, reg: 5, type: 'uint16', gain: 0.1, offset: -50, bit: -1 } },
        { id: 'flot', label: 'Flottant 32 bits', unit: '°C', kind: 'float', periodMs: 100,
          params: { fn: 3, reg: 10, type: 'float32', wordOrder: 'big', gain: 1, offset: 0 } },
        { id: 'bobine', label: 'Bobine paire', unit: '', kind: 'bit', periodMs: 100,
          params: { fn: 1, reg: 4, type: 'bool', gain: 1, offset: 0 } },
        { id: 'absent', label: 'Registre inexistant', unit: '', kind: 'word', periodMs: 100,
          params: { fn: 3, reg: 9000, type: 'uint16', gain: 1, offset: 0, bit: -1 } },
      ],
    },
    {
      id: 'poste', label: 'Poste 104', protocol: 'iec104', enabled: true,
      params: { host: '127.0.0.1', port: iec.port, asdu: 1, originator: 0, gi: true,
                giPeriodS: 0, k: 12, w: 8, t1: 15, t2: 10, t3: 20 },
      points: [
        { id: 'mesure', label: 'Mesure flottante', unit: 'kV', kind: 'float', periodMs: 100,
          params: { ioa: 100, type: 'auto', gain: 1, offset: 0 } },
        { id: 'etat', label: 'État simple', unit: '', kind: 'bit', periodMs: 100,
          params: { ioa: 200, type: 'auto', gain: 1, offset: 0 } },
        { id: 'date_src', label: 'Mesure horodatée (source)', unit: 'V', kind: 'float',
          periodMs: 100,
          params: { ioa: 300, type: 'auto', gain: 1, offset: 0, timestamp: 'source' } },
        { id: 'date_srv', label: 'Mesure horodatée (serveur)', unit: 'V', kind: 'float',
          periodMs: 100,
          params: { ioa: 300, type: 'auto', gain: 1, offset: 0, timestamp: 'server' } },
      ],
    },
    {
      id: 'poste61850', label: 'Poste 61850 (MMS)', protocol: 'iec61850', enabled: true,
      params: { host: '127.0.0.1', port: ied.port, mode: 'mms', iedName: 'IED1',
                timeoutMs: 3000 },
      points: [
        { id: 'courant', label: 'Courant phase A', unit: 'A', kind: 'float', periodMs: 200,
          params: { ref: 'LD0/MMXU1.A.phsA.cVal.mag.f', fc: 'MX', gain: 1, offset: 0 } },
        { id: 'pos', label: 'Position disjoncteur', unit: '', kind: 'word', periodMs: 200,
          params: { ref: 'LD0/XCBR1.Pos.stVal', fc: 'ST', gain: 1, offset: 0 } },
        { id: 'absent', label: 'Objet inconnu', unit: '', kind: 'float', periodMs: 200,
          params: { ref: 'LD0/MMXU9.Zz.stVal', fc: 'ST', gain: 1, offset: 0 } },
      ],
    },
    {
      id: 'rapports', label: 'Rapports BRCB', protocol: 'iec61850', enabled: true,
      params: { host: '127.0.0.1', port: ied.port, mode: 'report', buffered: true,
                rcbRef: 'LD0/LLN0.BR.brcb01', iedName: 'IED1', trgOps: 'dchg',
                intgPd: 0, timeoutMs: 3000 },
      points: [
        { id: 'pos', label: 'Position disjoncteur', unit: '', kind: 'word', periodMs: 200,
          params: { ref: 'LD0/XCBR1.Pos.stVal', fc: 'ST', index: 0, gain: 1, offset: 0 } },
        { id: 'courant', label: 'Courant rapporté', unit: 'A', kind: 'float', periodMs: 200,
          params: { ref: 'LD0/MMXU1.A.phsA.cVal.mag.f', fc: 'MX', index: 1,
                    gain: 1, offset: 0 } },
      ],
    },
    {
      id: 'goose', label: 'GOOSE poste', protocol: 'iec61850', enabled: true,
      params: { mode: 'goose', iface: 'diagweb-absent', appId: 12345, promisc: false },
      points: [
        { id: 'decl', label: 'Déclenchement', unit: '', kind: 'bit', periodMs: 200,
          params: { field: 'data', index: 0, gain: 1, offset: 0 } },
      ],
    },
    {
      id: 'commut', label: 'Commutateur SNMP', protocol: 'snmp', enabled: true,
      params: { host: '127.0.0.1', port: snmp.port, version: 'v2c', community: 'public',
                timeoutMs: 1500, maxVars: 16 },
      points: [
        { id: 'uptime', label: 'Temps depuis démarrage', unit: 's', kind: 'float', periodMs: 200,
          params: { oid: '1.3.6.1.2.1.1.3.0', gain: 0.01, offset: 0 } },
        { id: 'octets', label: 'Octets reçus if2', unit: 'o', kind: 'float', periodMs: 200,
          params: { oid: '1.3.6.1.2.1.2.2.1.10.2', gain: 1, offset: 0 } },
        { id: 'signe', label: 'Entier signé', unit: '', kind: 'float', periodMs: 200,
          params: { oid: '1.3.6.1.4.1.9999.1.0', gain: 1, offset: 0 } },
        { id: 'chaine', label: 'Mesure en chaîne', unit: '°C', kind: 'float', periodMs: 200,
          params: { oid: '1.3.6.1.4.1.9999.2.0', gain: 1, offset: 0 } },
        { id: 'texte', label: 'Texte non numérique', unit: '', kind: 'float', periodMs: 200,
          params: { oid: '1.3.6.1.4.1.9999.3.0', gain: 1, offset: 0 } },
        { id: 'absent', label: 'OID inconnu', unit: '', kind: 'float', periodMs: 200,
          params: { oid: '1.3.6.1.4.1.9999.9.0', gain: 1, offset: 0 } },
        // Deux fois la même mesure : l'une datée par la MIB (OID compagnon),
        // l'autre par le serveur. L'écart entre les deux est la preuve.
        { id: 'date_src', label: 'Mesure datée par la MIB', unit: '', kind: 'float',
          periodMs: 200,
          params: { oid: '1.3.6.1.4.1.9999.4.0', tsOid: '1.3.6.1.4.1.9999.5.0',
                    tsType: 'dateAndTime', gain: 1, offset: 0, timestamp: 'source' } },
        { id: 'date_srv', label: 'Même mesure, datée par le serveur', unit: '', kind: 'float',
          periodMs: 200,
          params: { oid: '1.3.6.1.4.1.9999.4.0', tsOid: '1.3.6.1.4.1.9999.5.0',
                    tsType: 'dateAndTime', gain: 1, offset: 0, timestamp: 'server' } },
      ],
    },
    // --- agent réel (snmpd) : les trois versions, dont USM ------------------
    {
      id: 'reelv1', label: 'Agent réel, v1', protocol: 'snmp', enabled: !snmpd.absent,
      params: { host: '127.0.0.1', port: snmpd.port, version: 'v1', community: 'public',
                timeoutMs: 1500, maxVars: 8 },
      points: [
        { id: 'uptime', label: 'Temps depuis démarrage', unit: 's', kind: 'float', periodMs: 200,
          params: { oid: '1.3.6.1.2.1.1.3.0', gain: 0.01, offset: 0 } },
      ],
    },
    {
      id: 'reelv2', label: 'Agent réel, v2c', protocol: 'snmp', enabled: !snmpd.absent,
      params: { host: '127.0.0.1', port: snmpd.port, version: 'v2c', community: 'public',
                timeoutMs: 1500, maxVars: 8, clockSkewS: 30 },
      points: [
        // Horodatage en TimeTicks : le pilote doit demander sysUpTime dans le
        // MÊME échange pour le ramener en date absolue.
        { id: 'ticks', label: 'Datée en TimeTicks', unit: 's', kind: 'float', periodMs: 200,
          params: { oid: '1.3.6.1.2.1.1.3.0', tsOid: '1.3.6.1.2.1.1.3.0',
                    tsType: 'timeTicks', gain: 0.01, offset: 0 } },
        // Horodatage DateAndTime, celui d'un vrai agent (HOST-RESOURCES-MIB).
        { id: 'hrdate', label: 'Datée par hrSystemDate', unit: 's', kind: 'float', periodMs: 200,
          params: { oid: '1.3.6.1.2.1.1.3.0', tsOid: '1.3.6.1.2.1.25.1.2.0',
                    tsType: 'dateAndTime', gain: 0.01, offset: 0 } },
      ],
    },
    {
      id: 'reelv3', label: 'Agent réel, v3 authPriv', protocol: 'snmp', enabled: !snmpd.absent,
      params: { host: '127.0.0.1', port: snmpd.port, version: 'v3', user: SNMPD.user,
                level: 'authPriv', authProto: 'SHA', privProto: 'AES',
                secretRef: SNMPD.ref, timeoutMs: 2500, maxVars: 8 },
      points: [
        { id: 'uptime', label: 'Temps depuis démarrage', unit: 's', kind: 'float', periodMs: 200,
          params: { oid: '1.3.6.1.2.1.1.3.0', gain: 0.01, offset: 0 } },
      ],
    },
    {
      id: 'v3nu', label: 'v3 sans secret', protocol: 'snmp', enabled: true,
      params: { host: '127.0.0.1', port: snmpd.port || snmp.port, version: 'v3',
                user: SNMPD.user, level: 'authPriv', authProto: 'SHA', privProto: 'AES',
                secretRef: '', timeoutMs: 1000 },
      points: [
        { id: 'uptime', label: 'Temps depuis démarrage', unit: 's', kind: 'float', periodMs: 500,
          params: { oid: '1.3.6.1.2.1.1.3.0', gain: 1, offset: 0 } },
      ],
    },
    {
      id: 'supervision', label: 'Supervision OPC UA', protocol: 'opcua', enabled: true,
      params: { endpoint: 'opc.tcp://127.0.0.1:' + ua.port, securityPolicy: 'None',
                securityMode: 'None', auth: 'anonymous', mode: 'subscribe',
                publishMs: 200, sessionTimeoutS: 60 },
      points: [
        { id: 'pression', label: 'Pression', unit: 'bar', kind: 'float', periodMs: 200,
          params: { nodeId: 'ns=1;s=pression', attr: 'Value', samplingMs: 100,
                    deadband: 0, gain: 10, offset: 0 } },
        { id: 'compteur', label: 'Compteur signé', unit: '', kind: 'float', periodMs: 200,
          params: { nodeId: 'ns=1;s=compteur', attr: 'Value', samplingMs: 100,
                    deadband: 0, gain: 1, offset: 0 } },
        { id: 'marche', label: 'Booléen', unit: '', kind: 'bit', periodMs: 200,
          params: { nodeId: 'ns=1;s=marche', attr: 'Value', samplingMs: 100,
                    deadband: 0, gain: 1, offset: 0 } },
        { id: 'texte', label: 'Chaîne', unit: '', kind: 'float', periodMs: 200,
          params: { nodeId: 'ns=1;s=texte', attr: 'Value', samplingMs: 100,
                    deadband: 0, gain: 1, offset: 0 } },
      ],
    },
    {
      id: 'uapoll', label: 'OPC UA en interrogation', protocol: 'opcua', enabled: true,
      params: { endpoint: 'opc.tcp://127.0.0.1:' + ua.port, securityPolicy: 'None',
                securityMode: 'None', auth: 'anonymous', mode: 'poll', sessionTimeoutS: 60 },
      points: [
        { id: 'regime', label: 'Régime', unit: 'tr/min', kind: 'float', periodMs: 200,
          params: { nodeId: 'ns=1;s=regime', attr: 'Value', gain: 1, offset: 0 } },
      ],
    },
    {
      id: 'uasecu', label: 'OPC UA chiffré', protocol: 'opcua', enabled: true,
      params: { endpoint: 'opc.tcp://127.0.0.1:' + ua.port, securityPolicy: 'Basic256Sha256',
                securityMode: 'SignAndEncrypt', auth: 'anonymous', mode: 'poll',
                sessionTimeoutS: 60 },
      points: [
        { id: 'regime', label: 'Régime', unit: 'tr/min', kind: 'float', periodMs: 500,
          params: { nodeId: 'ns=1;s=regime', attr: 'Value', gain: 1, offset: 0 } },
      ],
    },
  ],
};

const put = await api('/api/protocols', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(config),
});
check('configuration des liens acceptée et appliquée',
  put.status === 200 && put.json && put.json.ok === true);

await sleep(1500);

const st = await api('/api/protocols/status');
const stMap = Object.fromEntries((st.json || []).map((s) => [s.id, s]));
check('lien Modbus établi', stMap.banc && stMap.banc.state === 'up',
  stMap.banc ? stMap.banc.state + ' · ' + stMap.banc.detail : 'absent');
check('lien IEC 60870-5-104 établi', stMap.poste && stMap.poste.state === 'up',
  stMap.poste ? stMap.poste.state + ' · ' + stMap.poste.detail : 'absent');
check('IEC 61850 : association MMS établie (COTP, session, présentation, ACSE)',
  stMap.poste61850 && stMap.poste61850.state === 'up',
  stMap.poste61850 ? stMap.poste61850.state + ' · ' + stMap.poste61850.detail : 'absent');
check('IEC 61850 : bloc de rapport activé et flux reçu',
  stMap.rapports && stMap.rapports.state === 'up',
  stMap.rapports ? stMap.rapports.state + ' · ' + stMap.rapports.detail : 'absent');
// GOOSE est implémenté : sur une interface inexistante il tombe en défaut
// avec le motif, et non en « non branché ».
check('IEC 61850 : GOOSE implémenté, échoue sur l’interface et le dit',
  stMap.goose && stMap.goose.state === 'down' &&
  /interface|CAP_NET_RAW/.test(stMap.goose.detail || ''),
  stMap.goose ? stMap.goose.state + ' · ' + stMap.goose.detail : 'absent');
check('lien OPC UA établi (abonnement)',
  !ua.absent && stMap.supervision && stMap.supervision.state === 'up',
  ua.absent ? 'cible diagweb-opcua-test-server non compilée : ' + ua.bin
            : (stMap.supervision ? stMap.supervision.state + ' · ' + stMap.supervision.detail
                                 : 'absent'));
check('lien OPC UA établi (interrogation cyclique)',
  !ua.absent && stMap.uapoll && stMap.uapoll.state === 'up',
  stMap.uapoll ? stMap.uapoll.state + ' · ' + stMap.uapoll.detail : 'absent');
// Sans chiffrement compilé, un lien réglé « signature et chiffrement » doit
// refuser de s'ouvrir plutôt que de dialoguer en clair.
check('OPC UA : pas de repli en clair sur un lien chiffré',
  stMap.uasecu && stMap.uasecu.state === 'down' &&
  /chiffrement|sécurité/.test(stMap.uasecu.detail || ''),
  stMap.uasecu ? stMap.uasecu.state + ' · ' + stMap.uasecu.detail : 'absent');
check('lien SNMP v2c établi', stMap.commut && stMap.commut.state === 'up',
  stMap.commut ? stMap.commut.state + ' · ' + stMap.commut.detail : 'absent');
const dit = (id) => (stMap[id] ? stMap[id].state + ' · ' + stMap[id].detail : 'absent');
const sansSnmpd = 'snmpd (Net-SNMP) absent de la machine : installer le paquet snmpd';
check('SNMP v1 : lien établi sur un agent réel',
  !snmpd.absent && stMap.reelv1 && stMap.reelv1.state === 'up',
  snmpd.absent ? sansSnmpd : dit('reelv1'));
check('SNMP v2c : lien établi sur un agent réel',
  !snmpd.absent && stMap.reelv2 && stMap.reelv2.state === 'up',
  snmpd.absent ? sansSnmpd : dit('reelv2'));
// USM de bout en bout : découverte du moteur, clés dérivées des phrases
// secrètes lues dans l'environnement, authentification SHA-1 et chiffrement
// AES-128 — c'est ce que valide un lien « up » ici.
check('SNMP v3 : session authentifiée et chiffrée établie (USM, agent réel)',
  !snmpd.absent && stMap.reelv3 && stMap.reelv3.state === 'up',
  snmpd.absent ? sansSnmpd : dit('reelv3'));
check('SNMP v3 : sans secret, le lien refuse de s’ouvrir (jamais de repli en clair)',
  stMap.v3nu && stMap.v3nu.state === 'down' && /secret/i.test(stMap.v3nu.detail || ''),
  dit('v3nu'));

const test = await api('/api/protocols/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'banc' }),
});
check('test de connexion du lien Modbus', test.status === 200 && test.json.ok === true,
  test.json && test.json.detail);

const { got, dates, metas } = await collect(
  ['@banc.reg0', '@banc.reg5', '@banc.flot', '@banc.bobine', '@banc.absent',
   '@poste.mesure', '@poste.etat', '@poste.date_src', '@poste.date_srv',
   '@poste61850.courant', '@poste61850.pos',
   '@poste61850.absent', '@rapports.pos', '@rapports.courant', '@goose.decl',
   '@supervision.pression', '@supervision.compteur', '@supervision.marche',
   '@supervision.texte', '@uapoll.regime', '@uasecu.regime',
   '@commut.uptime', '@commut.octets', '@commut.signe', '@commut.chaine',
   '@commut.texte', '@commut.absent', '@commut.date_src', '@commut.date_srv',
   '@reelv1.uptime', '@reelv2.ticks', '@reelv2.hrdate', '@reelv3.uptime',
   '@v3nu.uptime'], 1400);

const last = (a) => { const v = got.get(a); return v.length ? v[v.length - 1] : null; };

check('registre Modbus lu (fonction 03)', last('@banc.reg0') === 1000,
  'valeur ' + last('@banc.reg0'));
check('mise à l’échelle appliquée (gain et décalage)',
  Math.abs(last('@banc.reg5') - 50.5) < 1e-6,
  '1005 × 0,1 − 50 = ' + last('@banc.reg5'));
check('flottant 32 bits sur deux registres', Math.abs(last('@banc.flot') - 42.5) < 1e-6,
  'valeur ' + last('@banc.flot'));
check('bobine lue (fonction 01)', last('@banc.bobine') === 1,
  'valeur ' + last('@banc.bobine'));
check('mesure IEC-104 reçue en spontané',
  last('@poste.mesure') !== null && last('@poste.mesure') >= 20 && last('@poste.mesure') <= 30,
  'valeur ' + last('@poste.mesure'));
check('état simple IEC-104 décodé (0/1)',
  [0, 1].includes(last('@poste.etat')), 'valeur ' + last('@poste.etat'));
check('IEC 61850 : flottant lu par MMS (référence traduite en LN$FC$DO$DA)',
  Math.abs(last('@poste61850.courant') - 50) < 1e-6,
  'valeur ' + last('@poste61850.courant'));
check('IEC 61850 : entier lu par MMS', last('@poste61850.pos') === 2,
  'valeur ' + last('@poste61850.pos'));
check('IEC 61850 : objet inconnu ne publie rien',
  got.get('@poste61850.absent').length === 0);
check('IEC 61850 : valeur reçue par rapport (indice 0 du jeu de données)',
  last('@rapports.pos') === 2, 'valeur ' + last('@rapports.pos'));
check('IEC 61850 : flottant reçu par rapport (indice 1)',
  Math.abs(last('@rapports.courant') - 50) < 1e-6, 'valeur ' + last('@rapports.courant'));
check('IEC 61850 : rapports reçus en flux (plusieurs notifications)',
  got.get('@rapports.pos').length >= 2,
  got.get('@rapports.pos').length + ' rapport(s) en 1,4 s');
check('IEC 61850 : point GOOSE sans valeur si le lien n’ouvre pas',
  got.get('@goose.decl').length === 0);
check('OPC UA : Double reçu par abonnement et mis à l’échelle',
  last('@supervision.pression') !== null && last('@supervision.pression') >= 25 &&
  last('@supervision.pression') <= 60,
  'valeur ' + last('@supervision.pression'));
check('OPC UA : abonnement notifié à chaque changement',
  got.get('@supervision.pression').length >= 3,
  got.get('@supervision.pression').length + ' notification(s) en 1,4 s');
check('OPC UA : Int32 négatif décodé', last('@supervision.compteur') === -42,
  'valeur ' + last('@supervision.compteur'));
check('OPC UA : booléen décodé en 0/1', last('@supervision.marche') === 1,
  'valeur ' + last('@supervision.marche'));
check('OPC UA : chaîne jamais publiée (type non numérique)',
  got.get('@supervision.texte').length === 0);
check('OPC UA : UInt32 lu en interrogation cyclique', last('@uapoll.regime') === 1500,
  'valeur ' + last('@uapoll.regime'));
check('OPC UA : aucun point sur un lien chiffré non ouvert',
  got.get('@uasecu.regime').length === 0);
check('SNMP : TimeTicks décodé et mis à l’échelle',
  Math.abs(last('@commut.uptime') - 1234.56) < 1e-6, 'valeur ' + last('@commut.uptime'));
check('SNMP : Counter32 au-delà d’un entier 32 bits signé',
  last('@commut.octets') === 4000000000, 'valeur ' + last('@commut.octets'));
check('SNMP : entier négatif décodé', last('@commut.signe') === -42,
  'valeur ' + last('@commut.signe'));
check('SNMP : mesure publiée sous forme de chaîne', last('@commut.chaine') === 23.5,
  'valeur ' + last('@commut.chaine'));
check('SNMP : chaîne non numérique jamais publiée',
  got.get('@commut.texte').length === 0);
check('SNMP : noSuchObject ne publie rien',
  got.get('@commut.absent').length === 0);
check('SNMP : aucun point lu sur un lien v3 sans secret',
  got.get('@v3nu.uptime').length === 0);
check('SNMP v1 : valeur lue sur l’agent réel',
  last('@reelv1.uptime') !== null && last('@reelv1.uptime') > 0,
  snmpd.absent ? sansSnmpd : 'sysUpTime ' + last('@reelv1.uptime') + ' s');
check('SNMP v3 : valeur lue à travers la session chiffrée',
  last('@reelv3.uptime') !== null && last('@reelv3.uptime') > 0,
  snmpd.absent ? sansSnmpd : 'sysUpTime ' + last('@reelv3.uptime') + ' s');
// Horodatage par OID compagnon. La MIB de l'agent simulé date la mesure
// DECALAGE_S secondes dans le passé : l'écart avec le jumeau daté par le
// serveur doit le retrouver, et la valeur être la même des deux côtés.
{
  const src = dates.get('@commut.date_src');
  const srv = dates.get('@commut.date_srv');
  const ecart = (src.length && srv.length)
    ? srv[srv.length - 1] - src[src.length - 1] : NaN;
  check('SNMP : date de la MIB retenue (OID compagnon, DateAndTime)',
    Math.abs(ecart - DECALAGE_S) < 0.5,
    'écart source/serveur ' + (isNaN(ecart) ? 'indisponible' : ecart.toFixed(3) + ' s'));
  check('SNMP : valeur identique quel que soit l’horodatage',
    last('@commut.date_src') === 77 && last('@commut.date_srv') === 77,
    'source ' + last('@commut.date_src') + ' / serveur ' + last('@commut.date_srv'));
}
// Sur l'agent réel, la date compagnonne désigne le même instant que l'horloge
// du serveur : on vérifie qu'elle est exploitée sans dériver, pas qu'elle
// diffère.
{
  const t = dates.get('@reelv2.ticks');
  const ref = dates.get('@reelv1.uptime');
  const ecart = (t.length && ref.length) ? Math.abs(t[t.length - 1] - ref[ref.length - 1]) : NaN;
  check('SNMP : horodatage TimeTicks rapporté au sysUpTime du même échange',
    ecart < 1.0,
    snmpd.absent ? sansSnmpd
                 : (isNaN(ecart) ? 'aucun échantillon' : 'écart ' + ecart.toFixed(3) + ' s'));

  const h = dates.get('@reelv2.hrdate');
  const eh = (h.length && ref.length) ? Math.abs(h[h.length - 1] - ref[ref.length - 1]) : NaN;
  check('SNMP : DateAndTime d’un agent réel (hrSystemDate) décodée et retenue',
    hrDateSert ? eh < 2.0 : true,
    !hrDateSert ? 'hrSystemDate non servi par cet agent : vérification sans objet'
                : (isNaN(eh) ? 'aucun échantillon' : 'écart ' + eh.toFixed(3) + ' s'));
}
// Horodatage : les deux points lisent le MÊME objet, l'un daté par la station
// (2 s dans le passé), l'autre par le serveur. L'écart doit apparaître.
{
  const src = dates.get('@poste.date_src');
  const srv = dates.get('@poste.date_srv');
  const ecart = (src.length && srv.length)
    ? srv[srv.length - 1] - src[src.length - 1] : NaN;
  check('horodatage à la source retenu (IEC-104, CP56Time2a)',
    Math.abs(ecart - DECALAGE_S) < 0.5,
    'écart source/serveur ' + (isNaN(ecart) ? 'indisponible' : ecart.toFixed(3) + ' s'));
  // Le point forcé au serveur doit être daté comme les variables non
  // horodatées du même lien : c'est ce qui prouve que le forçage écarte bien
  // l'horloge de la station.
  const ref = dates.get('@poste.mesure');
  const alignement = (srv.length && ref.length)
    ? Math.abs(srv[srv.length - 1] - ref[ref.length - 1]) : NaN;
  check('horodatage forcé au serveur, aligné sur les autres variables du lien',
    alignement < 0.5,
    isNaN(alignement) ? 'indisponible' : 'écart ' + alignement.toFixed(3) + ' s');
  check('valeur identique quel que soit l’horodatage',
    last('@poste.date_src') === 77.5 && last('@poste.date_srv') === 77.5,
    'source ' + last('@poste.date_src') + ' / serveur ' + last('@poste.date_srv'));
}

check('métadonnées transmises (libellé, unité, famille)',
  metas.get('@banc.flot') && metas.get('@banc.flot').unit === '°C' &&
  metas.get('@banc.flot').family === 'NET',
  metas.get('@banc.flot') ? metas.get('@banc.flot').label : 'absentes');

// Une adresse refusée par l'équipement ne doit pas abattre le lien entier :
// seule sa requête est mise de côté, les autres points continuent.
const st2 = await api('/api/protocols/status');
const banc2 = (st2.json || []).find((x) => x.id === 'banc');
check('une adresse refusée n’abat pas le lien (motif affiché, autres points lus)',
  banc2 && banc2.state === 'up' && /hors plage/.test(banc2.detail || '') &&
  got.get('@banc.absent').length === 0 && got.get('@banc.reg0').length > 5,
  banc2 ? banc2.detail : 'état absent');

const cadence = got.get('@banc.reg0').length;
check('cadence de lecture respectée (~10 lectures/s)', cadence >= 8 && cadence <= 40,
  cadence + ' échantillons en 1,4 s');

// Nettoyage : on remet une configuration vide et on ferme les faux équipements.
await api('/api/protocols', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ version: 1, links: [] }),
});
modbus.server.close();
iec.server.close();
snmp.sock.close();
if (ua.proc) ua.proc.kill();
if (ied.proc) ied.proc.kill();
if (snmpd.proc) snmpd.proc.kill();
if (snmpd.dir) {
  // snmpd écrit son fichier d'état en s'arrêtant : effacer son dossier avant
  // qu'il ait fini échouerait sur un répertoire qui se repeuple.
  await sleep(300);
  try { fs.rmSync(snmpd.dir, { recursive: true, force: true }); } catch { /* sans gravité */ }
}

console.log('');
console.log(`${results.length - failed}/${results.length} vérifications réussies`);
process.exit(failed ? 1 : 0);
