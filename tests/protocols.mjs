/* Diagweb — test bout en bout des liens réseau du serveur de diagnostic.
 *
 * Monte de faux équipements (esclave Modbus TCP, station IEC 60870-5-104,
 * agent SNMP v2c, serveur OPC UA), configure les liens par l'API REST du
 * serveur, puis vérifie que les points remontent bien jusqu'au flux WebSocket
 * avec les bonnes valeurs.
 *
 *   node tests/protocols.mjs [http://localhost:8080]
 *
 * Le serveur doit tourner (server/build/diagweb-server). Aucune dépendance :
 * net, dgram et WebSocket sont fournis par Node.
 */
import net from 'node:net';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8080';
const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------- équipements simulés
/**
 * Esclave Modbus TCP minimal : répond aux fonctions 3 et 4 avec des registres
 * connus, et à la fonction 1 avec des bobines alternées.
 * Registre n → valeur 1000 + n ; le registre 10 porte un flottant 32 bits.
 */
function startModbusSlave() {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 12) {
        const tid = buf.readUInt16BE(0);
        const unit = buf[6];
        const fn = buf[7];
        const addr = buf.readUInt16BE(8);
        const cnt = buf.readUInt16BE(10);
        buf = buf.subarray(12);
        let payload;
        if (addr >= 9000) {                                // table trouée : exception 02
          const ex = Buffer.alloc(9);
          ex.writeUInt16BE(tid, 0);
          ex.writeUInt16BE(0, 2);
          ex.writeUInt16BE(3, 4);
          ex[6] = unit; ex[7] = fn | 0x80; ex[8] = 2;      // adresse hors plage
          sock.write(ex);
          continue;
        }
        if (fn === 3 || fn === 4) {
          payload = Buffer.alloc(cnt * 2);
          for (let i = 0; i < cnt; i++) payload.writeUInt16BE((1000 + addr + i) & 0xffff, i * 2);
          if (addr <= 10 && addr + cnt >= 12) {           // 2 registres = 42.5 en float32
            const f = Buffer.alloc(4);
            f.writeFloatBE(42.5, 0);
            f.copy(payload, (10 - addr) * 2);
          }
        } else if (fn === 1 || fn === 2) {
          const nb = Math.ceil(cnt / 8);
          payload = Buffer.alloc(nb);
          for (let i = 0; i < cnt; i++) {
            if ((addr + i) % 2 === 0) payload[i >> 3] |= 1 << (i & 7);
          }
        } else {
          const ex = Buffer.from([0, 0, 0, 0, 0, 3, unit, fn | 0x80, 1]);
          ex.writeUInt16BE(tid, 0);
          sock.write(ex);
          continue;
        }
        const head = Buffer.alloc(9);
        head.writeUInt16BE(tid, 0);
        head.writeUInt16BE(0, 2);
        head.writeUInt16BE(3 + payload.length, 4);
        head[6] = unit;
        head[7] = fn;
        head[8] = payload.length;
        sock.write(Buffer.concat([head, payload]));
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })));
}

/**
 * Station IEC 60870-5-104 minimale : répond à STARTDT, à l'interrogation
 * générale, puis émet périodiquement une mesure flottante (M_ME_NC_1, IOA 100)
 * et un état simple (M_SP_NA_1, IOA 200).
 */
function startIec104Station() {
  let timer = null;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let tx = 0;
    const sendU = (code) => sock.write(Buffer.from([0x68, 4, code, 0, 0, 0]));
    const sendI = (asdu) => {
      const ctrl = Buffer.alloc(4);
      ctrl.writeUInt16LE((tx << 1) & 0xffff, 0);
      tx = (tx + 1) & 0x7fff;
      sock.write(Buffer.concat([Buffer.from([0x68, 4 + asdu.length]), ctrl, asdu]));
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && buf.length >= buf[1] + 2) {
        const len = buf[1];
        const ctrl = buf.subarray(2, 6);
        const apdu = buf.subarray(0, len + 2);
        buf = buf.subarray(len + 2);
        if ((ctrl[0] & 0x03) === 0x03) {            // format U
          if (ctrl[0] & 0x04) {                     // STARTDT act
            sendU(0x0b);
            if (!timer) {
              let k = 0;
              timer = setInterval(() => {
                k++;
                const a = Buffer.alloc(14);          // + QDS
                a[0] = 13; a[1] = 1; a[2] = 3; a[3] = 0;
                a.writeUInt16LE(1, 4);
                a[6] = 100; a[7] = 0; a[8] = 0;
                a.writeFloatLE(20 + (k % 10), 9);
                a[13] = 0;                           // qualité : valide
                sendI(a);
                const b = Buffer.alloc(10);
                b[0] = 1; b[1] = 1; b[2] = 3; b[3] = 0;
                b.writeUInt16LE(1, 4);
                b[6] = 200; b[7] = 0; b[8] = 0;
                b[9] = k % 2;                        // SIQ : bit d'état
                sendI(b);
              }, 100);
            }
          }
          if (ctrl[0] & 0x40) sendU(0x83);          // TESTFR act → con
        } else if ((ctrl[0] & 0x01) === 0 && apdu.length > 6) {
          const type = apdu[6];
          if (type === 100) {                       // interrogation générale
            const a = Buffer.alloc(14);
            a[0] = 13; a[1] = 1; a[2] = 20; a[3] = 0;   // cause : réponse à GI
            a.writeUInt16LE(1, 4);
            a[6] = 100; a[7] = 0; a[8] = 0;
            a.writeFloatLE(11.25, 9);
            a[13] = 0;
            sendI(a);
          }
        }
      }
    });
    sock.on('close', () => { if (timer) { clearInterval(timer); timer = null; } });
    sock.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })));
}

/**
 * Agent SNMP v2c minimal, sur UDP. Décode le GetRequest, répond avec un type
 * applicatif différent par OID — c'est justement ce que le pilote doit savoir
 * distinguer — et exerce les deux cas d'absence de valeur.
 *
 *   1.3.6.1.2.1.1.3.0        TimeTicks   123456
 *   1.3.6.1.2.1.2.2.1.10.2   Counter32   4000000000  (au-delà d'un int32 signé)
 *   1.3.6.1.4.1.9999.1.0     Integer     -42
 *   1.3.6.1.4.1.9999.2.0     OctetString "23.5"      (mesure en chaîne)
 *   1.3.6.1.4.1.9999.3.0     OctetString "hors zone" (non numérique : ignorée)
 *   1.3.6.1.4.1.9999.9.0     noSuchObject
 */
function startSnmpAgent() {
  // --- BER minimal ---
  const len = (n) => (n < 0x80 ? [n] : (() => {
    const b = []; for (let v = n; v; v >>= 8) b.unshift(v & 0xff);
    return [0x80 | b.length, ...b];
  })());
  const tlv = (tag, body) => Buffer.from([tag, ...len(body.length), ...body]);
  const int = (v) => {
    const b = []; let x = BigInt(v);
    do { b.unshift(Number(x & 0xffn)); x >>= 8n; }
    while (!((x === 0n && !(b[0] & 0x80)) || (x === -1n && (b[0] & 0x80))));
    return tlv(0x02, b);
  };
  const uint = (tag, v) => {
    const b = []; let x = BigInt(v);
    do { b.unshift(Number(x & 0xffn)); x >>= 8n; } while (x);
    if (b[0] & 0x80) b.unshift(0);                 // pas de signe parasite
    return tlv(tag, b);
  };
  const oidEnc = (dotted) => {
    const a = dotted.split('.').map(Number);
    const b = [a[0] * 40 + a[1]];
    for (const arc of a.slice(2)) {
      const t = []; let v = arc;
      do { t.unshift(v & 0x7f); v >>= 7; } while (v);
      for (let i = 0; i < t.length - 1; i++) t[i] |= 0x80;
      b.push(...t);
    }
    return tlv(0x06, b);
  };
  const readTlv = (buf, i) => {
    const tag = buf[i]; let n = buf[i + 1]; let off = i + 2;
    if (n & 0x80) { const k = n & 0x7f; n = 0; for (let j = 0; j < k; j++) n = (n << 8) | buf[off++]; }
    return { tag, body: buf.subarray(off, off + n), next: off + n };
  };
  const oidDec = (b) => {
    let s = Math.floor(b[0] / 40) + '.' + (b[0] % 40); let arc = 0;
    for (let i = 1; i < b.length; i++) {
      arc = (arc << 7) | (b[i] & 0x7f);
      if (!(b[i] & 0x80)) { s += '.' + arc; arc = 0; }
    }
    return s;
  };

  const VALUES = {
    '1.3.6.1.2.1.1.3.0': () => uint(0x43, 123456),
    '1.3.6.1.2.1.2.2.1.10.2': () => uint(0x41, 4000000000),
    '1.3.6.1.4.1.9999.1.0': () => int(-42),
    '1.3.6.1.4.1.9999.2.0': () => tlv(0x04, Buffer.from('23.5')),
    '1.3.6.1.4.1.9999.3.0': () => tlv(0x04, Buffer.from('hors zone')),
    '1.3.6.1.4.1.9999.9.0': () => Buffer.from([0x80, 0x00]),   // noSuchObject
  };

  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    try {
      const seq = readTlv(msg, 0);
      let i = 0;
      const version = readTlv(seq.body, i); i = version.next;
      const community = readTlv(seq.body, i); i = community.next;
      if (community.body.toString() !== 'public') return;       // communauté fausse : muet
      const pdu = readTlv(seq.body, i);
      if (pdu.tag !== 0xa0) return;                             // seul GetRequest est servi
      let j = 0;
      const rid = readTlv(pdu.body, j); j = rid.next;
      j = readTlv(pdu.body, j).next;                            // error-status
      j = readTlv(pdu.body, j).next;                            // error-index
      const binds = readTlv(pdu.body, j);

      const out = [];
      let k = 0;
      while (k < binds.body.length) {
        const vb = readTlv(binds.body, k); k = vb.next;
        const name = readTlv(vb.body, 0);
        const oid = oidDec(name.body);
        const val = VALUES[oid] ? VALUES[oid]() : Buffer.from([0x80, 0x00]);
        out.push(tlv(0x30, Buffer.concat([oidEnc(oid), val])));
      }
      const resp = tlv(0x30, Buffer.concat([
        tlv(0x02, version.body), tlv(0x04, community.body),
        tlv(0xa2, Buffer.concat([tlv(0x02, rid.body), int(0), int(0),
                                 tlv(0x30, Buffer.concat(out))])),
      ]));
      sock.send(resp, rinfo.port, rinfo.address);
    } catch { /* trame incohérente : l'agent reste muet, comme un vrai */ }
  });
  return new Promise((res) => sock.bind(0, '127.0.0.1', () => res({ sock, port: sock.address().port })));
}

/**
 * Serveur OPC UA de test : binaire compilé par CMake avec open62541
 * (cible diagweb-opcua-test-server). Son absence n'est pas passée sous
 * silence — les vérifications OPC UA échouent avec la raison.
 */
function startMmsIed(port) {
  const script = new URL('./mms_ied.mjs', import.meta.url).pathname;
  const proc = spawn(process.execPath, [script, String(port)],
                     { stdio: ['ignore', 'ignore', 'ignore'] });
  proc.on('error', () => {});
  return new Promise((res) => setTimeout(() => res({ proc, port }), 600));
}

function startOpcUaServer(port) {
  const bin = process.env.DIAGWEB_OPCUA_TEST_SERVER ||
              new URL('../server/build/diagweb-opcua-test-server', import.meta.url).pathname;
  if (!fs.existsSync(bin)) return Promise.resolve({ proc: null, port, bin, absent: true });
  const proc = spawn(bin, [String(port)], { stdio: ['ignore', 'ignore', 'ignore'] });
  proc.on('error', () => {});
  return new Promise((res) => setTimeout(() => res({ proc, port, bin, absent: false }), 1200));
}

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
    const metas = new Map();
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ got, metas }); }, ms);
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket indisponible')); };
    ws.onopen = () => { for (const a of addrs) ws.send(JSON.stringify({ c: 'sub', addr: a })); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.e === 'meta') metas.set(m.addr, m);
      if (m.e === 'd') {
        for (const a of addrs) {
          for (const [, v] of m.s[a] || []) got.get(a).push(v);
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
const ua = await startOpcUaServer(48401);
const ied = await startMmsIed(10250);

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
      ],
    },
    {
      id: 'snmpv3', label: 'Agent SNMPv3', protocol: 'snmp', enabled: true,
      params: { host: '127.0.0.1', port: snmp.port, version: 'v3', user: 'diag',
                level: 'authPriv', authProto: 'SHA', privProto: 'AES', timeoutMs: 1500 },
      points: [
        { id: 'uptime', label: 'Temps depuis démarrage', unit: 's', kind: 'float', periodMs: 1000,
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
check('SNMPv3 annoncé non branché (pas de repli silencieux en v2c)',
  stMap.snmpv3 && stMap.snmpv3.state === 'todo',
  stMap.snmpv3 ? stMap.snmpv3.detail : 'absent');

const test = await api('/api/protocols/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'banc' }),
});
check('test de connexion du lien Modbus', test.status === 200 && test.json.ok === true,
  test.json && test.json.detail);

const { got, metas } = await collect(
  ['@banc.reg0', '@banc.reg5', '@banc.flot', '@banc.bobine', '@banc.absent',
   '@poste.mesure', '@poste.etat', '@poste61850.courant', '@poste61850.pos',
   '@poste61850.absent', '@rapports.pos', '@rapports.courant', '@goose.decl',
   '@supervision.pression', '@supervision.compteur', '@supervision.marche',
   '@supervision.texte', '@uapoll.regime', '@uasecu.regime',
   '@commut.uptime', '@commut.octets', '@commut.signe', '@commut.chaine',
   '@commut.texte', '@commut.absent', '@snmpv3.uptime'], 1400);

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
check('SNMP : aucun point lu sur un lien v3',
  got.get('@snmpv3.uptime').length === 0);
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

console.log('');
console.log(`${results.length - failed}/${results.length} vérifications réussies`);
process.exit(failed ? 1 : 0);
