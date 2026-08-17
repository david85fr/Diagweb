/* Diagweb — équipements simulés, partagés par les tests et le banc d'essai.
 *
 * Extrait de tests/protocols.mjs, qui les montait pour lui seul : le banc
 * (tools/bench.mjs) a besoin des mêmes, mais sur des ports FIXES et pour
 * longtemps. D'où le paramètre `port` : 0 (défaut) laisse le système choisir,
 * ce que veulent les tests ; une valeur explicite sert au banc.
 *
 * Deux équipements ne sont pas simulés, parce qu'ils ne peuvent pas l'être
 * honnêtement — l'agent SNMP v3 (USM : découverte du moteur, fenêtre
 * temporelle, clés dérivées, chiffrement) et le serveur OPC UA. Ils sont
 * lancés pour de vrai : snmpd de Net-SNMP, et le binaire compilé avec
 * open62541. Leur absence n'est jamais passée sous silence.
 */
import net from 'node:net';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Adresse d'écoute des équipements simulés.
 *
 * 127.0.0.1 par défaut : un banc d'essai n'a rien à faire sur le réseau, et
 * les tests ne demandent que la boucle locale. `DIAGWEB_BENCH_BIND=0.0.0.0`
 * (tools/bench.mjs --ouvert) l'ouvre délibérément, pour brancher un client
 * Modbus ou OPC UA depuis une autre machine.
 *
 * Une FONCTION, et non une constante : les modules importés sont évalués avant
 * le corps de celui qui les importe, si bien qu'une constante aurait figé la
 * valeur avant que le banc n'ait pu poser la variable d'environnement.
 */
export const bindAddr = () => process.env.DIAGWEB_BENCH_BIND || '127.0.0.1';


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------- équipements simulés
/**
 * Esclave Modbus TCP minimal : répond aux fonctions 3 et 4 avec des registres
 * connus, et à la fonction 1 avec des bobines alternées.
 * Registre n → valeur 1000 + n ; le registre 10 porte un flottant 32 bits.
 */
export function startModbusSlave(port = 0) {
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
  return new Promise((res, rej) => {
    // Sans écouteur 'error', un port déjà pris relance l'événement : la promesse
    // ne se règle jamais et l'appelant meurt sur une trace brute. Les tests ne
    // le voyaient pas (port 0, jamais occupé) ; le banc utilise des ports fixes.
    server.once('error', rej);
    server.listen(port, bindAddr(), () => res({ server, port: server.address().port }));
  });
}

/**
 * Station IEC 60870-5-104 minimale : répond à STARTDT, à l'interrogation
 * générale, puis émet périodiquement une mesure flottante (M_ME_NC_1, IOA 100),
 * un état simple (M_SP_NA_1, IOA 200) et une mesure HORODATÉE (M_ME_TF_1,
 * IOA 300) datée volontairement DECALAGE_S secondes dans le passé — de quoi
 * vérifier que l'horodatage à la source est bien celui retenu.
 */
export const DECALAGE_S = 2;

/** Encode un CP56Time2a (7 octets) pour un instant donné. */
function cp56(date) {
  const b = Buffer.alloc(7);
  b.writeUInt16LE(date.getUTCSeconds() * 1000 + date.getUTCMilliseconds(), 0);
  b[2] = date.getUTCMinutes();
  b[3] = date.getUTCHours();
  b[4] = date.getUTCDate();
  b[5] = date.getUTCMonth() + 1;
  b[6] = date.getUTCFullYear() - 2000;
  return b;
}

export function startIec104Station(port = 0) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let tx = 0;
    // Le minuteur appartient à CETTE connexion, et non à la station.
    // Partagé, il produisait un défaut redoutable pour un banc de longue durée :
    // le bouton « Tester » de l'interface ouvre une seconde connexion puis la
    // referme, et sa fermeture arrêtait l'émission spontanée de la PREMIÈRE.
    // Le lien restait « up » — TESTFR répondait toujours — mais plus aucune
    // valeur ne remontait. Un outil de diagnostic affichant des courbes figées
    // sans le dire est pire qu'un outil en panne.
    let timer = null;
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

                // M_ME_TF_1 : flottant + QDS + CP56Time2a, daté dans le passé.
                const c = Buffer.alloc(21);
                c[0] = 36; c[1] = 1; c[2] = 3; c[3] = 0;
                c.writeUInt16LE(1, 4);
                c[6] = 44; c[7] = 1; c[8] = 0;       // IOA 300
                c.writeFloatLE(77.5, 9);
                c[13] = 0;                           // qualité : valide
                cp56(new Date(Date.now() - DECALAGE_S * 1000)).copy(c, 14);
                sendI(c);
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
  return new Promise((res, rej) => {
    // Sans écouteur 'error', un port déjà pris relance l'événement : la promesse
    // ne se règle jamais et l'appelant meurt sur une trace brute. Les tests ne
    // le voyaient pas (port 0, jamais occupé) ; le banc utilise des ports fixes.
    server.once('error', rej);
    server.listen(port, bindAddr(), () => res({ server, port: server.address().port }));
  });
}

// --- BER minimal, partagé par l'agent simulé et la sonde d'un agent réel ---
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
 *   1.3.6.1.4.1.9999.4.0     Integer     77          (mesure datée par l'agent)
 *   1.3.6.1.4.1.9999.5.0     DateAndTime             (sa date, dans le passé)
 *   1.3.6.1.4.1.9999.9.0     noSuchObject
 */
export function startSnmpAgent(port = 0) {
  /** DateAndTime (RFC 2579, forme longue) d'un instant donné, en UTC. */
  const dateAndTime = (date) => {
    const y = date.getUTCFullYear();
    return Buffer.from([y >> 8, y & 0xff, date.getUTCMonth() + 1, date.getUTCDate(),
                        date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
                        Math.floor(date.getUTCMilliseconds() / 100), 0x2b, 0, 0]);
  };

  const VALUES = {
    '1.3.6.1.2.1.1.3.0': () => uint(0x43, 123456),
    '1.3.6.1.2.1.2.2.1.10.2': () => uint(0x41, 4000000000),
    '1.3.6.1.4.1.9999.1.0': () => int(-42),
    '1.3.6.1.4.1.9999.2.0': () => tlv(0x04, Buffer.from('23.5')),
    '1.3.6.1.4.1.9999.3.0': () => tlv(0x04, Buffer.from('hors zone')),
    '1.3.6.1.4.1.9999.9.0': () => Buffer.from([0x80, 0x00]),   // noSuchObject
    // Mesure datée par l'agent : la valeur, puis sa date DECALAGE_S secondes
    // dans le passé — comme un relevé transmis après coup.
    '1.3.6.1.4.1.9999.4.0': () => int(77),
    '1.3.6.1.4.1.9999.5.0': () =>
      tlv(0x04, dateAndTime(new Date(Date.now() - DECALAGE_S * 1000))),
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
  return new Promise((res, rej) => {
    sock.once('error', rej);                      // même raison que ci-dessus
    sock.bind(port, bindAddr(), () => res({ sock, port: sock.address().port }));
  });
}

/**
 * Agent SNMP RÉEL : snmpd de Net-SNMP, avec un utilisateur v3 authPriv.
 *
 * L'agent simulé ci-dessus suffit à éprouver le décodage des types, mais pas
 * v3 : découverte du moteur distant, fenêtre temporelle, clés dérivées des
 * phrases secrètes, chiffrement de la charge utile — cela ne se simule pas en
 * trois cents lignes, et le prétendre serait se mentir. Ces vérifications-là
 * passent donc par un vrai agent.
 */
export const SNMPD = { user: 'diaguser', auth: 'motdepasseauth', priv: 'motdepassepriv',
                ref: 'agent' };

/** Un port UDP libre, obtenu en laissant le système en choisir un. */
function freeUdpPort() {
  return new Promise((res) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

export async function startSnmpd(port = 0) {
  const bin = ['/usr/sbin/snmpd', '/usr/local/sbin/snmpd', '/sbin/snmpd']
    .find((p) => fs.existsSync(p));
  if (!bin) return { proc: null, absent: true, dir: null, port: 0 };

  if (!port) port = await freeUdpPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagweb-snmpd-'));
  fs.writeFileSync(path.join(dir, 'snmpd.conf'),
    'rocommunity public default\n' +
    `createUser ${SNMPD.user} SHA "${SNMPD.auth}" AES "${SNMPD.priv}"\n` +
    `rouser ${SNMPD.user} authPriv\n`);
  // -f : reste au premier plan, pour que la fermeture du test l'emporte avec
  // lui ; -r : ne réclame pas les privilèges du superutilisateur ; le fichier
  // d'état va dans le dossier temporaire, jamais dans /var.
  const proc = spawn(bin, ['-f', '-C', '-c', path.join(dir, 'snmpd.conf'),
                           '-Lf', path.join(dir, 'snmpd.log'), '-r',
                           `udp:${bindAddr()}:${port}`],
                     { stdio: ['ignore', 'ignore', 'ignore'],
                       env: { ...process.env,
                              SNMP_PERSISTENT_FILE: path.join(dir, 'persist.conf') } });
  let mort = false;
  proc.on('error', () => { mort = true; });
  proc.on('exit', () => { mort = true; });
  await sleep(1200);
  return { proc, port, dir, absent: mort, bin };
}

/**
 * Interroge un OID sur un agent v2c et renvoie le type applicatif reçu (ou
 * null). Sert à savoir si l'agent expose bien l'objet qu'une vérification
 * suppose, plutôt que de conclure d'un échec ce qui n'est qu'une absence.
 */
export function snmpProbe(port, oidTexte) {
  return new Promise((res) => {
    const sock = dgram.createSocket('udp4');
    const fini = (v) => { try { sock.close(); } catch {} res(v); };
    const timer = setTimeout(() => fini(null), 1500);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      try {
        const seq = readTlv(msg, 0);
        let i = readTlv(seq.body, 0).next;            // version
        i = readTlv(seq.body, i).next;                // communauté
        const pdu = readTlv(seq.body, i);
        let j = readTlv(pdu.body, 0).next;            // request-id
        j = readTlv(pdu.body, j).next;                // error-status
        j = readTlv(pdu.body, j).next;                // error-index
        const binds = readTlv(pdu.body, j);
        const vb = readTlv(binds.body, 0);
        const val = readTlv(vb.body, readTlv(vb.body, 0).next);
        fini({ tag: val.tag, body: val.body });
      } catch { fini(null); }
    });
    sock.on('error', () => fini(null));
    const req = tlv(0x30, Buffer.concat([
      int(1), tlv(0x04, Buffer.from('public')),
      tlv(0xa0, Buffer.concat([int(1), int(0), int(0),
        tlv(0x30, tlv(0x30, Buffer.concat([oidEnc(oidTexte), Buffer.from([0x05, 0x00])])))])),
    ]));
    sock.send(req, port, '127.0.0.1');
  });
}

/**
 * IED IEC 61850 simulé : tests/mms_ied.mjs dans son propre processus (pile
 * ISO, association MMS, service Read, rapports). Le port 102 de la norme est
 * privilégié : le banc en utilise un haut, ce que le lien sait viser.
 */
export function startMmsIed(port) {
  const script = new URL('./mms_ied.mjs', import.meta.url).pathname;
  const proc = spawn(process.execPath, [script, String(port)],
                     { stdio: ['ignore', 'ignore', 'ignore'] });
  proc.on('error', () => {});
  return new Promise((res) => setTimeout(() => res({ proc, port }), 600));
}

/**
 * Serveur OPC UA de test : binaire compilé par Meson avec open62541
 * (cible diagweb-opcua-test-server). Son absence n'est pas passée sous
 * silence — l'appelant reçoit `absent: true` et le dit.
 */
export function startOpcUaServer(port) {
  const candidats = [process.env.DIAGWEB_OPCUA_TEST_SERVER,
                     new URL('../build/diagweb-opcua-test-server', import.meta.url).pathname]
    .filter(Boolean);
  const bin = candidats.find((c) => fs.existsSync(c));
  if (!bin) return Promise.resolve({ proc: null, port, bin: candidats.join(' ou '), absent: true });
  const proc = spawn(bin, [String(port)], { stdio: ['ignore', 'ignore', 'ignore'] });
  proc.on('error', () => {});
  return new Promise((res) => setTimeout(() => res({ proc, port, bin, absent: false }), 1200));
}
