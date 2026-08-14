/* Diagweb — IED IEC 61850 simulé, côté serveur MMS.
 *
 * Implémente juste ce qu'il faut pour valider le client de Diagweb : la pile
 * ISO (TPKT, COTP, session, présentation, ACSE), l'association MMS, le service
 * Read, l'écriture des attributs d'un bloc de rapport, et l'émission
 * d'InformationReport.
 *
 * Il ne prétend pas être un IED conforme — il sert à prouver que ce que le
 * client ÉMET est analysable, et que ce qu'il DÉCODE a bien la forme d'une
 * réponse réelle. L'interopérabilité avec un IED du commerce demande un
 * équipement réel ; c'est dit dans docs/PROTOCOLES.md.
 *
 *   node tests/mms_ied.mjs [port]        (102 par défaut)
 */
import net from 'node:net';

// ------------------------------------------------------------------- BER
const len = (n) => (n < 0x80 ? [n] : (() => {
  const b = [];
  for (let v = n; v; v >>= 8) b.unshift(v & 0xff);
  return [0x80 | b.length, ...b];
})());
const tlv = (tag, body) => Buffer.from([tag, ...len(body.length), ...body]);
const int = (v) => {
  const b = [];
  let x = BigInt(v);
  do { b.unshift(Number(x & 0xffn)); x >>= 8n; }
  while (!((x === 0n && !(b[0] & 0x80)) || (x === -1n && (b[0] & 0x80))));
  return tlv(0x02, b);
};
const readTlv = (buf, i) => {
  if (i + 2 > buf.length) return null;
  const tag = buf[i];
  let n = buf[i + 1];
  let off = i + 2;
  if (n & 0x80) {
    const k = n & 0x7f;
    n = 0;
    for (let j = 0; j < k; j++) n = (n << 8) | buf[off++];
  }
  if (off + n > buf.length) return null;
  return { tag, body: buf.subarray(off, off + n), next: off + n };
};
/** Recherche en profondeur de la première étiquette donnée. */
function findTag(buf, tag) {
  let i = 0;
  while (i < buf.length) {
    const t = readTlv(buf, i);
    if (!t) return null;
    if (t.tag === tag) return t.body;
    if (t.tag & 0x20) {
      const inner = findTag(t.body, tag);
      if (inner) return inner;
    }
    i = t.next;
  }
  return null;
}

// --------------------------------------------------------------- valeurs
/** Les valeurs exposées, dans l'ordre du jeu de données du rapport. */
const VALEURS = {
  'MMXU1$MX$A$phsA$cVal$mag$f': () => tlv(0x87, [0x08, 0x42, 0x48, 0x00, 0x00]),   // 50,0
  'MMXU1$MX$PhV$phsA$cVal$mag$f': () => tlv(0x87, [0x08, 0x43, 0xE1, 0x00, 0x00]), // 450,0
  'XCBR1$ST$Pos$stVal': () => tlv(0x85, [0x02]),                                   // entier 2
  'GGIO1$ST$Ind1$stVal': () => tlv(0x83, [0x01]),                                  // booléen
  'LLN0$ST$Beh$stVal': () => tlv(0x85, [0x01]),
};

// ---------------------------------------------------------- pile ISO
const tpkt = (corps) => Buffer.concat([
  Buffer.from([0x03, 0x00, (corps.length + 4) >> 8, (corps.length + 4) & 0xff]), corps,
]);
const cotpData = (corps) => tpkt(Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), corps]));

/** Confirmation de connexion COTP. */
const cotpCc = () => {
  const h = Buffer.from([0xd0, 0x00, 0x01, 0x00, 0x01, 0x00, 0xc0, 0x01, 0x0a,
                         0xc1, 0x02, 0x00, 0x01, 0xc2, 0x02, 0x00, 0x01]);
  return tpkt(Buffer.concat([Buffer.from([h.length]), h]));
};

/** Enveloppe de présentation d'un PDU MMS courant. */
const presData = (mms) => tlv(0x61, tlv(0x30, Buffer.concat([int(3), tlv(0xa0, mms)])));
const sessData = (u) => Buffer.concat([Buffer.from([0x01, 0x00, 0x01, 0x00]), u]);

/** ACCEPT de session portant la CPA et l'AARE. */
function sessionAccept(aare) {
  const ctx = (id, oid) => tlv(0x30, Buffer.concat([
    int(id), tlv(0x06, Buffer.from(oid)), tlv(0x30, tlv(0x06, Buffer.from([0x51, 0x01]))),
  ]));
  const liste = tlv(0xa5, Buffer.concat([                       // result-list
    tlv(0x30, Buffer.concat([tlv(0x80, Buffer.from([0x00]))])),
    tlv(0x30, Buffer.concat([tlv(0x80, Buffer.from([0x00]))])),
  ]));
  const normal = tlv(0xa2, Buffer.concat([
    tlv(0x81, Buffer.from([0x00, 0x00, 0x00, 0x01])),
    tlv(0x82, Buffer.from([0x00, 0x00, 0x00, 0x01])),
    liste,
    tlv(0x61, tlv(0x30, Buffer.concat([int(1), tlv(0xa0, aare)]))),
  ]));
  void ctx;
  const cpa = tlv(0x31, Buffer.concat([tlv(0xa0, tlv(0x80, Buffer.from([0x01]))), normal]));

  const p = Buffer.concat([
    Buffer.from([0x05, 0x06, 0x13, 0x01, 0x00, 0x16, 0x01, 0x02]),
    Buffer.from([0x14, 0x02, 0x00, 0x02]),
    Buffer.from([0x33, 0x02, 0x00, 0x01]),
    Buffer.from([0x34, 0x02, 0x00, 0x01]),
    cpa.length < 255 ? Buffer.from([0xc1, cpa.length])
                     : Buffer.from([0xc1, 0xff, 0x01, cpa.length >> 8, cpa.length & 0xff]),
    cpa,
  ]);
  return Buffer.concat([Buffer.from([0x0e, p.length]), p]);
}

/** AARE d'ACSE portant la réponse d'initialisation MMS. */
function acseAare(mmsInit) {
  const ext = tlv(0x28, Buffer.concat([
    tlv(0x06, Buffer.from([0x51, 0x01])), int(3), tlv(0xa0, mmsInit),
  ]));
  return tlv(0x61, Buffer.concat([
    tlv(0xa1, tlv(0x06, Buffer.from([0x28, 0xca, 0x22, 0x02, 0x03]))),
    tlv(0xa2, int(0)),                                   // result : accepté
    tlv(0xa3, tlv(0xa1, int(0))),
    tlv(0xbe, ext),
  ]));
}

const mmsInitResponse = () => tlv(0xa9, Buffer.concat([
  tlv(0x80, Buffer.from([0x00, 0xfd, 0xe8])),
  tlv(0x81, Buffer.from([0x05])),
  tlv(0x82, Buffer.from([0x05])),
  tlv(0x83, Buffer.from([0x0a])),
  tlv(0xa4, Buffer.concat([
    tlv(0x80, Buffer.from([0x01])),
    tlv(0x81, Buffer.from([0x05, 0xf1, 0x00])),
  ])),
]));

// ------------------------------------------------------------- services
/** Noms d'objet demandés dans un Read : liste des itemId, dans l'ordre. */
function nomsDemandes(pdu) {
  const noms = [];
  const parcours = (buf) => {
    let i = 0;
    while (i < buf.length) {
      const t = readTlv(buf, i);
      if (!t) return;
      let pris = false;
      if (t.tag === 0xa1) {                               // domain-specific ?
        const d = readTlv(t.body, 0);
        if (d && d.tag === 0x1a) {
          const e = readTlv(t.body, d.next);
          if (e && e.tag === 0x1a) { noms.push(e.body.toString()); pris = true; }
        }
      }
      // Un A1 qui ne porte pas deux VisibleString est un niveau intermédiaire
      // (variableAccessSpecification) : il faut continuer à descendre.
      if (!pris && (t.tag & 0x20)) parcours(t.body);
      i = t.next;
    }
  };
  parcours(pdu);
  return noms;
}

function readResponse(invoke, noms) {
  const resultats = noms.map((n) => (VALEURS[n] ? VALEURS[n]() : tlv(0x80, Buffer.from([0x0a]))));
  return tlv(0xa1, Buffer.concat([
    int(invoke), tlv(0xa4, tlv(0xa1, Buffer.concat(resultats))),
  ]));
}

const writeResponse = (invoke) => tlv(0xa1, Buffer.concat([
  int(invoke), tlv(0xa5, tlv(0xa0, tlv(0x81, Buffer.from([])))),
]));

/** Écriture : couples (nom d'objet, valeur), dans l'ordre de la requête. */
function ecrituresDemandees(pdu) {
  const parties = [];
  let i = 0;
  while (i < pdu.length) {
    const t = readTlv(pdu, i);
    if (!t) break;
    if (t.tag === 0xa0) parties.push(t.body);
    i = t.next;
  }
  if (parties.length < 2) return [];
  const noms = nomsDemandes(parties[0]);
  const valeurs = [];
  let j = 0;
  while (j < parties[1].length) {
    const t = readTlv(parties[1], j);
    if (!t) break;
    valeurs.push(t);
    j = t.next;
  }
  return noms.map((n, k) => [n, valeurs[k]]);
}

/** Bit `k` d'une chaîne de bits BER (octet de bourrage en tête, bit 0 devant). */
const bitDe = (b, k) => (b.length > 1 + (k >> 3) ? (b[1 + (k >> 3)] >> (7 - (k & 7))) & 1 : 0);

/** Chaîne d'inclusion : les indices du jeu de données réellement rapportés. */
function chaineInclusion(indices, taille) {
  const octets = Math.ceil(taille / 8);
  const b = Buffer.alloc(octets);
  for (const i of indices) b[i >> 3] |= 0x80 >> (i & 7);
  return Buffer.from([octets * 8 - taille, ...b]);
}

const flottant = (v) => {
  const b = Buffer.alloc(5);
  b[0] = 0x08;                                            // largeur d'exposant
  b.writeFloatBE(v, 1);
  return tlv(0x87, b);
};

// Jeu de données du bloc de rapport : indice 0 = Pos.stVal, indice 1 = courant.
const TAILLE_JEU = 2;

/**
 * InformationReport : RptID, OptFlds, SqNum, puis la chaîne d'inclusion et les
 * valeurs — la forme qu'un IED réel produit.
 *
 * `indices` dit QUELS membres du jeu de données sont rapportés : un rapport
 * déclenché par changement ne porte que ceux qui ont changé, et c'est la chaîne
 * d'inclusion — pas le rang de la valeur — qui dit lesquels.
 */
function informationReport(n, indices, valeurs) {
  const liste = tlv(0xa0, Buffer.concat([
    tlv(0x8a, Buffer.from('brcb01')),                     // RptID
    tlv(0x84, Buffer.from([0x06, 0x40, 0x00])),           // OptFlds : numéro de séquence
    tlv(0x85, [n & 0xff]),                                // SqNum
    tlv(0x84, chaineInclusion(indices, TAILLE_JEU)),
    ...valeurs,
  ]));
  return tlv(0xa3, tlv(0xa0, Buffer.concat([
    tlv(0x80, Buffer.from('RPT')),                        // vmd-specific
    liste,
  ])));
}

/** Tout le jeu de données : ce que produit une interrogation générale. */
const rapportComplet = (n) =>
  informationReport(n, [0, 1], [tlv(0x85, [0x02]), flottant(50)]);

/** Seul l'indice 1 a changé : le cas courant d'un déclenchement sur valeur. */
const rapportPartiel = (n) => informationReport(n, [1], [flottant(51.5)]);

// ---------------------------------------------------------------- serveur
const port = Number(process.argv[2] || 102);

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let timer = null;
  // État du bloc de rapport, tenu comme le ferait un IED : les conditions de
  // déclenchement commandent réellement ce qui est émis. Un client qui se
  // trompe de bit dans TrgOps n'obtient donc rien — c'est tout l'intérêt
  // d'écrire ce simulateur d'après la norme, et non d'après le pilote.
  let dchg = false;                                       // TrgOps bit 1
  let gi = false;                                         // TrgOps bit 5
  let seq = 0;

  const envoyer = (pdu) => sock.write(cotpData(sessData(presData(pdu))));

  /** RptEna = vrai : les rapports sur changement partent, si TrgOps le permet. */
  const activer = (actif) => {
    if (timer) { clearInterval(timer); timer = null; }
    if (!actif || !dchg) return;
    timer = setInterval(() => {
      // Un rapport complet de loin en loin, des rapports partiels entre-temps :
      // les deux formes qu'un client doit savoir replacer dans le jeu.
      seq += 1;
      envoyer(seq % 4 === 0 ? rapportComplet(seq) : rapportPartiel(seq));
    }, 100);
  };
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const total = (buf[2] << 8) | buf[3];
      if (buf[0] !== 0x03 || total < 5 || buf.length < total) break;
      const trame = buf.subarray(0, total);
      buf = buf.subarray(total);

      const li = trame[4];
      const code = trame[5];
      if (code === 0xe0) { sock.write(cotpCc()); continue; }     // CR → CC
      if (code !== 0xf0) continue;

      const user = trame.subarray(5 + li);
      if (user.length && user[0] === 0x0d) {                     // CONNECT de session
        sock.write(cotpData(sessionAccept(acseAare(mmsInitResponse()))));
        continue;
      }
      // Message courant : on extrait le PDU MMS de son enveloppe.
      const pdv = findTag(user.subarray(4), 0x61);
      const mms = pdv ? findTag(pdv, 0xa0) : null;
      if (!mms) continue;

      const corps = readTlv(mms, 0);
      if (mms[0] === 0xa0 && corps) {                             // confirmed-Request
        const inv = readTlv(corps.body, 0);
        const invoke = inv ? Number(inv.body.readUIntBE(0, inv.body.length)) : 1;
        const service = readTlv(corps.body, inv ? inv.next : 0);
        if (service && service.tag === 0xa4) {                    // Read
          sock.write(cotpData(sessData(presData(readResponse(invoke, nomsDemandes(service.body))))));
        } else if (service && service.tag === 0xa5) {             // Write (bloc de rapport)
          sock.write(cotpData(sessData(presData(writeResponse(invoke)))));
          for (const [nom, valeur] of ecrituresDemandees(service.body)) {
            const attribut = nom.slice(nom.lastIndexOf('$') + 1);
            const vrai = !!(valeur && valeur.body.length && valeur.body[valeur.body.length - 1]);
            if (attribut === 'TrgOps' && valeur) {
              dchg = !!bitDe(valeur.body, 1);
              gi = !!bitDe(valeur.body, 5);
            } else if (attribut === 'RptEna') {
              activer(vrai);
            } else if (attribut === 'GI' && vrai && gi) {
              // Interrogation générale : tout le jeu de données, tout de suite.
              envoyer(rapportComplet(++seq));
            }
          }
        }
      }
    }
  });
  sock.on('close', () => { if (timer) { clearInterval(timer); timer = null; } });
  sock.on('error', () => {});
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`IED MMS simulé sur 127.0.0.1:${server.address().port}\n`);
});
