/* Diagweb — liens réseau : description des protocoles, configuration, points.
 *
 * Le serveur de diagnostic sait lire des variables sur des équipements tiers
 * (Modbus, IEC 61850, IEC 60870-5-104, CAN brut, J1939, CANopen, OPC UA). Ce
 * fichier est la SOURCE DE VÉRITÉ de la description de ces protocoles : les
 * champs de configuration, leurs libellés et leurs aides. Chaque protocole a
 * son pilote dans son propre dossier, sous `server/src/drivers/<protocole>/`,
 * et `tools/gen-protocols.mjs` dérive `server/src/protocols.generated.hpp` —
 * ne jamais éditer le .hpp.
 *
 * Vocabulaire (voir docs/PROTOCOLES.md) :
 *   lien  = une connexion vers un équipement ou un réseau (id, protocole,
 *           paramètres) ;
 *   point = une variable lue sur ce lien (id, libellé, unité, période, et les
 *           paramètres d'adressage propres au protocole).
 * Un point est désigné dans Diagweb par « @lien.point » (famille NET).
 */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  // ------------------------------------------------------------------
  // Description des protocoles
  // ------------------------------------------------------------------
  // type : text | int | float | bool | enum | hex
  // when : n'affiche le champ que si les autres champs ont ces valeurs
  const F = (key, label, type, def, required, help, extra) =>
    Object.assign({ key, label, type, def, required, help }, extra || {});

  // Champs communs à tout décodage de valeur brute → grandeur physique
  const SCALE = [
    F('gain', 'Gain', 'float', 1, false,
      'Facteur appliqué à la valeur brute : valeur = brut × gain + décalage.'),
    F('offset', 'Décalage', 'float', 0, false,
      'Constante ajoutée après le gain (unité physique).'),
  ];
  // Champs communs à l'extraction d'un signal dans une trame (CAN, J1939…)
  const BITFIELD = [
    F('startBit', 'Bit de départ', 'int', 0, true,
      'Position du premier bit du signal dans la trame (0 = bit de poids faible du premier octet).'),
    F('bitLen', 'Longueur (bits)', 'int', 16, true,
      'Nombre de bits occupés par le signal (1 à 64).'),
    F('order', 'Ordre des octets', 'enum', 'intel', false,
      'Intel = petit-boutiste (poids faible d’abord), Motorola = gros-boutiste — comme dans une base de signaux CAN.',
      { choices: [['intel', 'Intel (petit-boutiste)'], ['motorola', 'Motorola (gros-boutiste)']] }),
    F('signed', 'Signé', 'bool', false, false,
      'Interpréter la valeur brute en complément à deux (valeurs négatives possibles).'),
  ];

  const MODBUS_POINT = [
    F('fn', 'Fonction de lecture', 'enum', '3', true,
      'Fonction Modbus utilisée : bobines (01), entrées TOR (02), registres de maintien (03), registres d’entrée (04).',
      { choices: [['1', '01 — Bobines (bits)'], ['2', '02 — Entrées TOR (bits)'],
                  ['3', '03 — Registres de maintien'], ['4', '04 — Registres d’entrée']] }),
    F('reg', 'Adresse', 'int', 0, true,
      'Adresse protocole du registre ou du bit, à partir de 0 (le registre « 40001 » d’une documentation correspond en général à l’adresse 0 de la fonction 03).'),
    F('type', 'Type de donnée', 'enum', 'uint16', true,
      'Décodage de la donnée. Les types 32 bits occupent deux registres consécutifs.',
      { choices: [['bool', 'Booléen (bit)'], ['int16', 'Entier 16 bits signé'],
                  ['uint16', 'Entier 16 bits non signé'], ['int32', 'Entier 32 bits signé'],
                  ['uint32', 'Entier 32 bits non signé'], ['float32', 'Flottant 32 bits'],
                  ['float64', 'Flottant 64 bits']] }),
    F('wordOrder', 'Ordre des mots', 'enum', 'big', false,
      'Pour les types sur plusieurs registres : mot de poids fort d’abord (usuel) ou de poids faible d’abord.',
      { choices: [['big', 'Poids fort d’abord'], ['little', 'Poids faible d’abord']],
        when: { type: ['int32', 'uint32', 'float32', 'float64'] } }),
    F('bit', 'Bit extrait', 'int', -1, false,
      'Rang du bit à extraire du registre (0 à 15) ; −1 pour utiliser la valeur entière.',
      { when: { type: ['int16', 'uint16'] } }),
  ].concat(SCALE);

  DW.PROTOCOLS = [
    {
      id: 'modbus-tcp',
      label: 'Modbus TCP',
      transport: 'TCP/IP',
      state: 'live',
      help: 'Lecture cyclique de registres et de bits sur un équipement Modbus TCP. ' +
            'Les registres consécutifs sont regroupés en une seule requête.',
      linkFields: [
        F('host', 'Hôte', 'text', '', true, 'Adresse IP ou nom réseau de l’équipement.'),
        F('port', 'Port', 'int', 502, false, 'Port TCP du serveur Modbus (502 par défaut).'),
        F('unitId', 'Identifiant d’unité', 'int', 1, false,
          'Identifiant d’esclave (unit id) placé dans l’en-tête MBAP — 1 par défaut, 255 si l’équipement l’ignore.'),
        F('timeoutMs', 'Délai d’attente (ms)', 'int', 1000, false,
          'Temps maximal d’attente d’une réponse avant de signaler le lien en défaut.'),
        F('groupMax', 'Regroupement (registres)', 'int', 32, false,
          'Nombre maximal de registres lus en une requête ; 1 pour interroger chaque point séparément.'),
      ],
      pointFields: MODBUS_POINT,
    },
    {
      id: 'modbus-rtu',
      label: 'Modbus RTU (série)',
      transport: 'Liaison série',
      state: 'live',
      help: 'Même adressage que Modbus TCP, sur une liaison série RS-485/RS-232 ' +
            '(trame RTU avec contrôle CRC-16).',
      linkFields: [
        F('device', 'Port série', 'text', '/dev/ttyS0', true,
          'Fichier de périphérique de la liaison série du contrôleur.'),
        F('baud', 'Débit', 'enum', 19200, false, 'Débit en bauds, identique à celui de l’équipement.',
          { choices: [[1200, '1200'], [2400, '2400'], [4800, '4800'], [9600, '9600'],
                      [19200, '19200'], [38400, '38400'], [57600, '57600'], [115200, '115200']] }),
        F('parity', 'Parité', 'enum', 'even', false, 'Parité de la liaison — « paire » est l’usage courant en Modbus RTU.',
          { choices: [['none', 'Aucune'], ['even', 'Paire'], ['odd', 'Impaire']] }),
        F('stopBits', 'Bits de stop', 'enum', 0, false,
          'Automatique applique la règle de la spécification série : 1 bit avec parité, ' +
          '2 bits sans parité. Ne forcer que si l’équipement l’exige.',
          { choices: [[0, 'Automatique'], [1, '1'], [2, '2']] }),
        F('unitId', 'Adresse esclave', 'int', 1, true, 'Adresse de l’esclave sur le bus (1 à 247).'),
        F('timeoutMs', 'Délai d’attente (ms)', 'int', 1000, false, 'Temps maximal d’attente d’une réponse.'),
        F('groupMax', 'Regroupement (registres)', 'int', 32, false, 'Nombre maximal de registres lus en une requête.'),
      ],
      pointFields: MODBUS_POINT,
    },
    {
      id: 'iec104',
      label: 'IEC 60870-5-104',
      transport: 'TCP/IP',
      state: 'live',
      help: 'Client (maître) télécontrôle : le serveur de diagnostic se connecte, ' +
            'lance une interrogation générale puis reçoit les données spontanées.',
      linkFields: [
        F('host', 'Hôte', 'text', '', true, 'Adresse IP ou nom réseau de la station contrôlée.'),
        F('port', 'Port', 'int', 2404, false, 'Port TCP (2404 par défaut).'),
        F('asdu', 'Adresse commune d’ASDU', 'int', 1, true,
          'Adresse commune de l’équipement (souvent 1) — les objets reçus avec une autre adresse sont ignorés.'),
        F('originator', 'Adresse d’origine', 'int', 0, false,
          'Adresse de l’émetteur placée dans la cause de transmission (0 si inutilisée).'),
        F('gi', 'Interrogation générale', 'bool', true, false,
          'Demander l’état complet à la connexion (C_IC_NA_1), pour partir de valeurs connues.'),
        F('giPeriodS', 'Interrogation périodique (s)', 'int', 0, false,
          'Répéter l’interrogation générale à cet intervalle ; 0 = seulement à la connexion.'),
        F('k', 'Fenêtre k', 'int', 12, false, 'Nombre maximal de trames I non acquittées (paramètre k de la norme).'),
        F('w', 'Fenêtre w', 'int', 8, false, 'Acquitter après w trames reçues (paramètre w de la norme).'),
        F('t1', 'Délai t1 (s)', 'int', 15, false, 'Délai d’attente d’un acquittement avant coupure.'),
        F('t2', 'Délai t2 (s)', 'int', 10, false, 'Délai avant envoi d’un acquittement de supervision.'),
        F('t3', 'Délai t3 (s)', 'int', 20, false, 'Délai d’inactivité avant envoi d’un test de liaison.'),
      ],
      pointFields: [
        F('ioa', 'Adresse d’objet (IOA)', 'int', 0, true,
          'Adresse d’objet d’information sur 3 octets (1 à 16777215).'),
        F('type', 'Type attendu', 'enum', 'auto', false,
          'Type d’ASDU attendu. « Automatique » accepte tout type reçu pour cette adresse.',
          { choices: [['auto', 'Automatique'], ['single', 'Simple (M_SP)'], ['double', 'Double (M_DP)'],
                      ['normalized', 'Mesure normalisée (M_ME_A/D)'], ['scaled', 'Mesure échelonnée (M_ME_B/E)'],
                      ['float', 'Mesure flottante (M_ME_C/F)'], ['counter', 'Compteur (M_IT)'],
                      ['step', 'Position de régleur (M_ST)']] }),
      ].concat(SCALE),
    },
    {
      id: 'iec61850',
      label: 'IEC 61850 (MMS)',
      transport: 'TCP/IP (ISO sur TCP, port 102)',
      state: 'declared',
      help: 'Client MMS d’un IED. La configuration et les points se saisissent dès ' +
            'maintenant ; la lecture effective demande la pile ISO/MMS, prévue en ' +
            'phase ultérieure (voir docs/PROTOCOLES.md).',
      linkFields: [
        F('host', 'Hôte', 'text', '', true, 'Adresse IP ou nom réseau de l’IED.'),
        F('port', 'Port', 'int', 102, false, 'Port TCP de la pile ISO (102 par défaut).'),
        F('iedName', 'Nom d’IED', 'text', '', false,
          'Nom logique de l’IED, utilisé en tête des références d’objet.'),
        F('mode', 'Mode de lecture', 'enum', 'poll', false,
          'Interrogation cyclique (MMS Read) ou abonnement aux rapports de l’IED.',
          { choices: [['poll', 'Interrogation cyclique'], ['report', 'Rapports (BRCB/URCB)']] }),
        F('dataset', 'Jeu de données', 'text', '', false,
          'Référence du jeu de données à rapporter (mode rapports).', { when: { mode: ['report'] } }),
      ],
      pointFields: [
        F('ref', 'Référence d’objet', 'text', '', true,
          'Référence complète de l’attribut, par exemple LD0/MMXU1.A.phsA.cVal.mag.f.'),
        F('fc', 'Contrainte fonctionnelle', 'enum', 'MX', false,
          'Contrainte fonctionnelle de l’attribut : mesures (MX), état (ST), consigne (SP), réglage (SE), configuration (CF).',
          { choices: [['MX', 'MX — mesures'], ['ST', 'ST — état'], ['SP', 'SP — consignes'],
                      ['SE', 'SE — réglages'], ['CF', 'CF — configuration']] }),
      ].concat(SCALE),
    },
    {
      id: 'can-raw',
      label: 'Bus CAN (trames brutes)',
      transport: 'SocketCAN (Linux)',
      state: 'live',
      help: 'Écoute strictement passive d’une interface CAN du contrôleur : un point ' +
            'est un champ de bits extrait d’un identifiant de trame donné. Le serveur ' +
            'n’émet jamais sur le bus dans ce mode.',
      linkFields: [
        F('iface', 'Interface', 'text', 'can0', true,
          'Nom de l’interface CAN du système (can0, can1, vcan0…). Elle doit être déjà configurée et active : ' +
          'le débit du bus relève de l’administration du contrôleur, pas de Diagweb.'),
        F('fd', 'CAN FD', 'bool', false, false, 'Accepter les trames CAN FD (jusqu’à 64 octets de données).'),
      ],
      pointFields: [
        F('canId', 'Identifiant', 'hex', '0x100', true,
          'Identifiant CAN de la trame portant le signal, en hexadécimal (ex. 0x18FEF100).'),
        F('ext', 'Identifiant 29 bits', 'bool', false, false,
          'Trame à identifiant étendu (29 bits) plutôt que standard (11 bits).'),
      ].concat(BITFIELD).concat(SCALE),
    },
    {
      id: 'j1939',
      label: 'J1939 (CAN, PGN mono-trame)',
      transport: 'SocketCAN (Linux)',
      state: 'live',
      help: 'Décodage J1939 au-dessus de CAN : l’identifiant 29 bits est découpé en ' +
            'priorité, PGN et adresse source ; un point est un SPN extrait du PGN. ' +
            'Limite importante : seuls les PGN tenant dans une trame (8 octets) sont ' +
            'lus — le transport multi-trames (BAM, RTS/CTS) n’est pas implémenté, ' +
            'donc un PGN long comme DM1 ne remontera jamais de valeur.',
      linkFields: [
        F('iface', 'Interface', 'text', 'can0', true, 'Nom de l’interface CAN du système.'),
        F('sa', 'Adresse source filtrée', 'int', -1, false,
          'N’accepter que les trames émises par cette adresse source (0 à 253) ; −1 pour toutes.'),
      ],
      pointFields: [
        F('pgn', 'PGN', 'int', 61444, true,
          'Numéro de groupe de paramètres, en décimal (ex. 61444 = régime moteur, EEC1). ' +
          'Doit tenir dans une seule trame : les PGN multi-trames ne sont pas décodés.'),
        F('sa', 'Adresse source', 'int', -1, false,
          'Adresse source attendue pour ce point ; −1 pour accepter n’importe laquelle.'),
      ].concat(BITFIELD).concat(SCALE),
    },
    {
      id: 'canopen',
      label: 'CANopen',
      transport: 'SocketCAN (Linux)',
      state: 'live',
      help: 'Deux modes : écoute des TPDO déjà émis par le nœud (sans rien demander), ' +
            'ou lecture à la demande d’une entrée du dictionnaire d’objets par SDO — ' +
            'ce second mode est le seul où le serveur émet sur le bus. À savoir : un ' +
            'nœud qui n’est pas en état opérationnel n’émet aucun TPDO ; le lien ' +
            'paraîtra alors établi sans qu’aucune valeur ne remonte.',
      linkFields: [
        F('iface', 'Interface', 'text', 'can0', true, 'Nom de l’interface CAN du système.'),
        F('nodeId', 'Identifiant de nœud', 'int', 1, true,
          'Node-id du nœud CANopen (1 à 127) — il fixe les COB-ID des SDO et des PDO.'),
        F('listenOnly', 'Écoute seule', 'bool', true, false,
          'N’émettre aucune requête SDO : seuls les TPDO déjà émis par le nœud sont lus. ' +
          'Recommandé — interroger un nœud absent fait réémettre le contrôleur CAN jusqu’au ' +
          'bus-off, ce qui dégrade l’interface elle-même. Décocher active la lecture SDO.'),
      ],
      pointFields: [
        F('mode', 'Mode', 'enum', 'tpdo', true,
          'TPDO = écoute passive d’une trame déjà émise. SDO = interrogation d’une entrée du dictionnaire d’objets.',
          { choices: [['tpdo', 'Écoute d’un TPDO'], ['sdo', 'Lecture SDO']] }),
        F('cobId', 'COB-ID du TPDO', 'hex', '0x181', false,
          'Identifiant de la trame TPDO à écouter (0x180 + node-id pour le TPDO1, etc.).',
          { when: { mode: ['tpdo'] } }),
        F('index', 'Index', 'hex', '0x6041', false,
          'Index de l’objet dans le dictionnaire (ex. 0x6041 = mot d’état).', { when: { mode: ['sdo'] } }),
        F('subIndex', 'Sous-index', 'int', 0, false,
          'Sous-index de l’objet (0 quand l’objet n’est pas structuré).', { when: { mode: ['sdo'] } }),
        F('type', 'Type de donnée', 'enum', 'u16', false,
          'Type de l’objet lu par SDO.',
          { choices: [['u8', 'Entier 8 bits non signé'], ['i8', 'Entier 8 bits signé'],
                      ['u16', 'Entier 16 bits non signé'], ['i16', 'Entier 16 bits signé'],
                      ['u32', 'Entier 32 bits non signé'], ['i32', 'Entier 32 bits signé'],
                      ['f32', 'Flottant 32 bits']],
            when: { mode: ['sdo'] } }),
      ].concat(BITFIELD.map((f) => Object.assign({}, f, { when: { mode: ['tpdo'] } }))).concat(SCALE),
    },
    {
      id: 'opcua',
      label: 'OPC UA (IEC 62541)',
      transport: 'UA-TCP binaire (opc.tcp, port 4840)',
      state: 'declared',
      help: 'Client OPC UA d’un serveur de supervision ou d’un équipement : lecture ' +
            'de nœuds désignés par leur NodeId, par interrogation cyclique (Read) ou ' +
            'par abonnement (MonitoredItems). La configuration et les points se ' +
            'saisissent dès maintenant ; la lecture effective demande la pile UA ' +
            '(UA-TCP, SecureConversation, encodage binaire), prévue en phase ' +
            'ultérieure (voir docs/PROTOCOLES.md). Lecture seule définitive : ni ' +
            'Write ni Call ne seront implémentés.',
      linkFields: [
        F('endpoint', 'Point de terminaison', 'text', 'opc.tcp://192.168.0.10:4840', true,
          'URL du serveur OPC UA, forme opc.tcp://hôte:port/chemin. Le chemin est facultatif ' +
          'et dépend du serveur.'),
        F('securityPolicy', 'Politique de sécurité', 'enum', 'None', false,
          'Politique annoncée par le serveur pour le canal sécurisé. « Aucune » ne convient ' +
          'qu’à un réseau de confiance ; les autres exigent un certificat client.',
          { choices: [['None', 'Aucune'], ['Basic256Sha256', 'Basic256Sha256'],
                      ['Aes128Sha256RsaOaep', 'Aes128-Sha256-RsaOaep'],
                      ['Aes256Sha256RsaPss', 'Aes256-Sha256-RsaPss']] }),
        F('securityMode', 'Mode de sécurité', 'enum', 'None', false,
          'Aucun (en clair), signature seule, ou signature et chiffrement du canal.',
          { choices: [['None', 'Aucun'], ['Sign', 'Signature'],
                      ['SignAndEncrypt', 'Signature et chiffrement']] }),
        F('auth', 'Authentification', 'enum', 'anonymous', false,
          'Jeton d’identité présenté à l’ouverture de session.',
          { choices: [['anonymous', 'Anonyme'], ['username', 'Nom d’utilisateur'],
                      ['certificate', 'Certificat client']] }),
        F('username', 'Nom d’utilisateur', 'text', '', false,
          'Identifiant de session. Le mot de passe n’est JAMAIS enregistré ici : la ' +
          'configuration des liens est lisible par tout poste connecté et s’exporte en ' +
          'clair. Le secret est repris du magasin de secrets du contrôleur.',
          { when: { auth: ['username'] } }),
        F('secretRef', 'Référence du secret', 'text', '', false,
          'Nom sous lequel le mot de passe ou la clé privée du certificat est rangé dans le ' +
          'magasin de secrets du contrôleur — une désignation, jamais le secret lui-même.',
          { when: { auth: ['username', 'certificate'] } }),
        F('mode', 'Mode de lecture', 'enum', 'subscribe', false,
          'Abonnement = le serveur OPC UA notifie les changements (économe, recommandé). ' +
          'Interrogation cyclique = service Read répété, utile face à un serveur qui ' +
          'refuse les abonnements.',
          { choices: [['subscribe', 'Abonnement (MonitoredItems)'],
                      ['poll', 'Interrogation cyclique (Read)']] }),
        F('publishMs', 'Intervalle de publication (ms)', 'int', 500, false,
          'Cadence à laquelle le serveur OPC UA regroupe et renvoie les changements.',
          { when: { mode: ['subscribe'] } }),
        F('sessionTimeoutS', 'Expiration de session (s)', 'int', 60, false,
          'Durée au-delà de laquelle le serveur ferme une session restée sans échange.'),
      ],
      pointFields: [
        F('nodeId', 'NodeId', 'text', 'ns=2;s=', true,
          'Identifiant du nœud à lire, forme ns=<espace>;<type>=<valeur> — par exemple ' +
          'ns=2;s=Machine/Pression pour une chaîne, ns=2;i=1234 pour un entier.'),
        F('attr', 'Attribut', 'enum', 'Value', false,
          'Attribut du nœud à lire. « Valeur » convient à toutes les variables ; les autres ' +
          'servent au diagnostic du serveur lui-même.',
          { choices: [['Value', 'Valeur'], ['StatusCode', 'Code d’état'],
                      ['SourceTimestamp', 'Horodatage source']] }),
        F('samplingMs', 'Échantillonnage (ms)', 'int', 200, false,
          'Cadence à laquelle le serveur OPC UA échantillonne le nœud, quand le lien est en ' +
          'mode abonnement ; 0 laisse le serveur choisir. Ne peut pas être plus rapide que ' +
          'la source de la donnée.'),
        F('deadband', 'Bande morte (%)', 'float', 0, false,
          'Variation minimale, en pourcentage de l’étendue, avant notification d’un ' +
          'changement (mode abonnement) ; 0 pour tout notifier.'),
      ].concat(SCALE),
    },
  ];

  DW.PROTO_INDEX = new Map(DW.PROTOCOLS.map((p) => [p.id, p]));

  // ------------------------------------------------------------------
  // Modèle de configuration
  // ------------------------------------------------------------------
  const STORE_KEY = 'diagweb.protocols.v1';
  const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

  /** Valeur par défaut d'un champ. */
  function fieldDefault(f) { return f.def; }

  /** Un champ est-il pertinent compte tenu des autres valeurs saisies ? */
  function fieldApplies(f, params) {
    if (!f.when) return true;
    for (const k in f.when) {
      const cur = params[k] == null ? '' : String(params[k]);
      if (!f.when[k].map(String).includes(cur)) return false;
    }
    return true;
  }

  function defaults(fields) {
    const o = {};
    for (const f of fields) o[f.key] = fieldDefault(f);
    return o;
  }

  /** Type de variable Diagweb déduit des paramètres d'un point. */
  function kindOf(proto, point) {
    const p = point.params || {};
    if (proto.id === 'modbus-tcp' || proto.id === 'modbus-rtu') {
      if (String(p.fn) === '1' || String(p.fn) === '2' || p.type === 'bool') return 'bit';
      if (Number(p.bit) >= 0) return 'bit';
      const scaled = Number(p.gain) !== 1 || Number(p.offset) !== 0;
      if (!scaled && (p.type === 'int16' || p.type === 'uint16')) return 'word';
      return 'float';
    }
    if (proto.id === 'iec104') {
      if (p.type === 'single' || p.type === 'double') return 'bit';
      return 'float';
    }
    if (Number(p.bitLen) === 1) return 'bit';
    return 'float';
  }

  /** Résumé lisible de l'adressage protocole d'un point (listes et infobulles). */
  function pointSummary(link, point) {
    const proto = DW.PROTO_INDEX.get(link.protocol);
    const p = point.params || {};
    if (!proto) return '';
    switch (proto.id) {
      case 'modbus-tcp':
      case 'modbus-rtu':
        return 'fonction ' + String(p.fn).padStart(2, '0') + ' · adresse ' + p.reg +
               ' · ' + p.type + (Number(p.bit) >= 0 ? ' · bit ' + p.bit : '');
      case 'iec104':
        return 'IOA ' + p.ioa + ' · ' + (p.type === 'auto' ? 'type automatique' : p.type);
      case 'iec61850':
        return (p.ref || '—') + ' [' + p.fc + ']';
      case 'can-raw':
        return 'ID ' + p.canId + (p.ext ? ' (29 bits)' : '') + ' · bits ' + p.startBit + '+' + p.bitLen;
      case 'j1939':
        return 'PGN ' + p.pgn + (Number(p.sa) >= 0 ? ' · SA ' + p.sa : '') +
               ' · bits ' + p.startBit + '+' + p.bitLen;
      case 'canopen':
        return p.mode === 'sdo'
          ? 'SDO ' + p.index + '/' + p.subIndex + ' · ' + p.type
          : 'TPDO ' + p.cobId + ' · bits ' + p.startBit + '+' + p.bitLen;
      default:
        return '';
    }
  }

  function addrOf(link, point) { return '@' + link.id + '.' + point.id; }

  // ------------------------------------------------------------------
  // Stockage : serveur de diagnostic si présent, sinon navigateur
  // ------------------------------------------------------------------
  const api = {
    /** 'server' = configuration détenue par le contrôleur ; 'local' = navigateur (valeurs simulées). */
    mode: 'local',
    config: { version: 1, links: [] },
    status: {},          // idLien → {state:'up'|'down'|'off'|'sim', detail, points:{id:quality}}
    ready: null,
    onChange: null,      // renseigné par app.js (rafraîchir les suggestions)

    descriptor(id) { return DW.PROTO_INDEX.get(id) || null; },
    links() { return this.config.links || []; },
    link(id) { return this.links().find((l) => l.id === id) || null; },

    /** Tous les points configurés, au format des suggestions du catalogue. */
    catalog() {
      const out = [];
      for (const link of this.links()) {
        const proto = DW.PROTO_INDEX.get(link.protocol);
        if (!proto) continue;
        for (const pt of link.points || []) {
          out.push({
            addr: addrOf(link, pt),
            family: 'NET',
            label: pt.label || (link.label || link.id) + ' — ' + pt.id,
            unit: pt.unit || '',
            kind: pt.kind || kindOf(proto, pt),
            protocol: proto.id,
            protocolLabel: proto.label,
            summary: pointSummary(link, pt),
            periodMs: pt.periodMs,
            enabled: link.enabled !== false,
          });
        }
      }
      return out;
    },

    /** Métadonnées d'un point réseau, ou null si l'adresse n'est pas configurée. */
    meta(addr) {
      const e = this.catalog().find((x) => x.addr === addr);
      if (!e) return null;
      return {
        addr: e.addr, family: 'NET', kind: e.kind, unit: e.unit, label: e.label,
        known: true, protocol: e.protocol, summary: e.summary, sim: null,
      };
    },

    /** Période propre au point (sinon la valeur par défaut du réglage d'ajout). */
    periodOf(addr) {
      const e = this.catalog().find((x) => x.addr === addr);
      return e && e.periodMs ? e.periodMs : null;
    },

    // ---- Persistance ------------------------------------------------
    async load() {
      try {
        // Page ouverte en fichier local (Artifact, copie hors ligne) ou hors
        // navigateur (générateur d'en-tête C++) : aucun appel réseau à tenter —
        // la configuration vit alors dans le navigateur.
        const httpish = typeof location !== 'undefined' &&
          (location.protocol === 'http:' || location.protocol === 'https:');
        if (!httpish) throw new Error('page hors serveur');
        const r = await fetch('/api/protocols', { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          this.config = normalize(j.config || j);
          this.status = indexStatus(j.status);
          this.mode = 'server';
          return this.config;
        }
      } catch (e) { /* pas de serveur : configuration locale */ }
      this.mode = 'local';
      try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORE_KEY);
        if (raw) this.config = normalize(JSON.parse(raw));
      } catch (e) { /* stockage indisponible */ }
      return this.config;
    },

    async save() {
      // On envoie une copie remise en forme, sans remplacer les objets vivants :
      // la fenêtre de configuration garde ses références (un remplacement ferait
      // écrire les modifications suivantes dans des objets orphelins).
      const payload = normalize(this.config);
      if (this.mode === 'server') {
        const r = await fetch('/api/protocols', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error('le serveur de diagnostic a refusé la configuration');
        const j = await r.json().catch(() => ({}));
        this.status = indexStatus(j.status);
      } else {
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(payload));
        } catch (e) {
          throw new Error('stockage local indisponible');
        }
      }
      if (typeof this.onChange === 'function') this.onChange();
    },

    async refreshStatus() {
      if (this.mode !== 'server') return this.status;
      try {
        const r = await fetch('/api/protocols/status', { cache: 'no-store' });
        if (r.ok) this.status = indexStatus(await r.json());
      } catch (e) { /* lien serveur perdu : on garde le dernier état connu */ }
      return this.status;
    },

    /** Teste un lien côté serveur ; en mode local, réponse explicite. */
    async test(linkId) {
      if (this.mode !== 'server') {
        return { ok: false, detail: 'Aucun serveur de diagnostic : la configuration est ' +
                 'mémorisée dans le navigateur et les valeurs sont simulées.' };
      }
      const r = await fetch('/api/protocols/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: linkId }),
      });
      const j = await r.json().catch(() => ({}));
      return { ok: !!j.ok, detail: j.detail || (j.ok ? 'connexion établie' : 'échec') };
    },

    linkState(id) {
      const st = this.status[id];
      if (this.mode !== 'server') return { key: 'sim', label: 'simulé', detail: 'Valeurs simulées (pas de serveur de diagnostic).' };
      if (!st) return { key: 'off', label: 'inconnu', detail: 'État non communiqué par le serveur.' };
      return st;
    },

    addrOf, pointSummary, kindOf, defaults, fieldApplies,
  };

  function indexStatus(list) {
    const o = {};
    for (const s of list || []) o[s.id] = s;
    return o;
  }

  /** Remet une configuration lue (fichier, serveur, stockage) en forme sûre. */
  function normalize(cfg) {
    const out = { version: 1, links: [] };
    if (!cfg || typeof cfg !== 'object') return out;
    for (const l of cfg.links || []) {
      const proto = DW.PROTO_INDEX.get(l.protocol);
      if (!proto || !ID_RE.test(String(l.id || ''))) continue;
      const link = {
        id: String(l.id),
        label: String(l.label || l.id).slice(0, 60),
        protocol: proto.id,
        enabled: l.enabled !== false,
        params: Object.assign(defaults(proto.linkFields), l.params || {}),
        points: [],
      };
      for (const p of l.points || []) {
        if (!ID_RE.test(String(p.id || ''))) continue;
        if (link.points.some((q) => q.id === p.id)) continue;
        const point = {
          id: String(p.id),
          label: String(p.label || p.id).slice(0, 60),
          unit: String(p.unit || '').slice(0, 12),
          periodMs: Math.max(10, Math.min(60000, parseInt(p.periodMs, 10) || 200)),
          params: Object.assign(defaults(proto.pointFields), p.params || {}),
        };
        point.kind = ['bit', 'word', 'float'].includes(p.kind) ? p.kind : kindOf(proto, point);
        link.points.push(point);
      }
      if (!out.links.some((x) => x.id === link.id)) out.links.push(link);
    }
    return out;
  }
  api.normalize = normalize;

  DW.protocols = api;
  DW.protocolsReady = api.load();
})();
