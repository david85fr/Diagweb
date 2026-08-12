/* Diagweb — test bout en bout des liens réseau du serveur de diagnostic.
 *
 * Monte de faux équipements (esclave Modbus TCP, station IEC 60870-5-104),
 * configure les liens par l'API REST du serveur, puis vérifie que les points
 * remontent bien jusqu'au flux WebSocket avec les bonnes valeurs.
 *
 *   node tests/protocols.mjs [http://localhost:8080]
 *
 * Le serveur doit tourner (server/build/diagweb-server). Aucune dépendance :
 * net et WebSocket sont fournis par Node.
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
      id: 'poste61850', label: 'Poste 61850', protocol: 'iec61850', enabled: true,
      params: { host: '127.0.0.1', port: 102, mode: 'poll' },
      points: [
        { id: 'courant', label: 'Courant phase A', unit: 'A', kind: 'float', periodMs: 1000,
          params: { ref: 'LD0/MMXU1.A.phsA.cVal.mag.f', fc: 'MX', gain: 1, offset: 0 } },
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
check('pilote IEC 61850 annoncé comme non branché (pas de valeur inventée)',
  stMap.poste61850 && stMap.poste61850.state === 'todo',
  stMap.poste61850 ? stMap.poste61850.detail : 'absent');

const test = await api('/api/protocols/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'banc' }),
});
check('test de connexion du lien Modbus', test.status === 200 && test.json.ok === true,
  test.json && test.json.detail);

const { got, metas } = await collect(
  ['@banc.reg0', '@banc.reg5', '@banc.flot', '@banc.bobine', '@banc.absent',
   '@poste.mesure', '@poste.etat', '@poste61850.courant'], 1400);

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
check('point IEC 61850 sans valeur (pilote non branché)',
  got.get('@poste61850.courant').length === 0);
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

console.log('');
console.log(`${results.length - failed}/${results.length} vérifications réussies`);
process.exit(failed ? 1 : 0);
