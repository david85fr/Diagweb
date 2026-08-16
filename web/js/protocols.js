/* Diagweb — liens réseau : description des protocoles, configuration, points.
 *
 * Le serveur de diagnostic sait lire des variables sur des équipements tiers
 * (Modbus, IEC 61850, IEC 60870-5-104, CAN brut, J1939, CANopen, SNMP, OPC UA).
 * Ce fichier est la SOURCE DE VÉRITÉ de la description de ces protocoles : les
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
  // Choix de l'horodatage, proposé sur CHAQUE point : faire confiance à
  // l'horloge d'un équipement de terrain n'est pas anodin, et cela se décide
  // variable par variable.
  const HORODATAGE = [
    F('timestamp', 'Horodatage', 'enum', 'source', false,
      'Équipement : la date que l’équipement attache lui-même à la donnée — la ' +
      'seule fidèle quand l’événement précède sa transmission. Fournie par ' +
      'IEC 60870-5-104 (types horodatés), IEC 61850 (GOOSE, Sampled Values, ' +
      'rapports) et OPC UA en abonnement ; SNMP la tient d’un OID d’horodatage ' +
      'de la MIB, s’il en existe un (champ « OID d’horodatage » du point) ; ' +
      'ailleurs, l’horloge du serveur est ' +
      'utilisée de toute façon. Serveur : ignorer délibérément l’horodatage du ' +
      'protocole — à choisir quand l’horloge de l’équipement n’est pas de confiance.',
      { choices: [['source', 'De l’équipement si disponible'],
                  ['server', 'Du serveur (forcé)']] }),
  ];

  // Garde-fou associé, sur le LIEN : un horodatage de source ne vaut que si
  // l'horloge qui le produit est réglée. Proposé partout où une date absolue
  // peut venir de l'équipement.
  const SKEW = [
    F('clockSkewS', 'Écart d’horloge admis (s)', 'int', 10, false,
      'Au-delà de cet écart entre l’horloge de l’équipement et celle du serveur, ' +
      'l’horodatage de l’équipement est écarté et celui du serveur utilisé, avec ' +
      'un message. Sans ce garde-fou, un équipement dont l’horloge est fausse de ' +
      'deux heures placerait ses échantillons hors de toute fenêtre visible — ce ' +
      'qui se lit comme une variable morte alors qu’elle remonte très bien.'),
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
  ].concat(SCALE).concat(HORODATAGE);

  DW.PROTOCOLS = [
    {
      id: 'modbus-tcp',
      label: 'Modbus TCP',
      transport: 'TCP/IP',
      state: 'live',
      badge: 'ext.MB',
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
      badge: 'ext.MB',
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
      badge: 'ext.104',
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
      ].concat(SKEW),
      pointFields: [
        F('ioa', 'Adresse d’objet (IOA)', 'int', 0, true,
          'Adresse d’objet d’information sur 3 octets (1 à 16777215).'),
        F('type', 'Type attendu', 'enum', 'auto', false,
          'Type d’ASDU attendu. « Automatique » accepte tout type reçu pour cette adresse.',
          { choices: [['auto', 'Automatique'], ['single', 'Simple (M_SP)'], ['double', 'Double (M_DP)'],
                      ['normalized', 'Mesure normalisée (M_ME_A/D)'], ['scaled', 'Mesure échelonnée (M_ME_B/E)'],
                      ['float', 'Mesure flottante (M_ME_C/F)'], ['counter', 'Compteur (M_IT)'],
                      ['step', 'Position de régleur (M_ST)']] }),
      ].concat(SCALE).concat(HORODATAGE),
    },
    {
      id: 'iec61850',
      label: 'IEC 61850',
      transport: 'Ethernet niveau 2 (GOOSE, SV) · ISO sur TCP (MMS)',
      state: 'live',
      badge: 'ext.61850',
      help: 'Quatre mécanismes cohabitent dans la norme, tous implémentés. GOOSE et ' +
            'Sampled Values sont des trames Ethernet diffusées, écoutées en niveau 2. ' +
            'La lecture MMS et les rapports (BRCB, URCB) passent par la pile ISO sur ' +
            'TCP. Activer un rapport est la SEULE écriture du pilote, et elle ne touche ' +
            'que les attributs du bloc de contrôle. Voir docs/PROTOCOLES.md.',
      linkFields: [
        F('mode', 'Mécanisme', 'enum', 'goose', true,
          'GOOSE : événements diffusés par un IED (protection, position d’organe). ' +
          'Sampled Values : mesures échantillonnées d’un TC/TP numérique, à 4 000 ou ' +
          '4 800 trames par seconde. Lecture MMS : interrogation cyclique d’attributs. ' +
          'Rapports : l’IED notifie, avec ou sans mémoire tampon.',
          { choices: [['goose', 'GOOSE (8-1)'], ['sv', 'Sampled Values (9-2)'],
                      ['mms', 'Lecture MMS'], ['report', 'Rapports BRCB/URCB']] }),

        // --- GOOSE et Sampled Values : Ethernet de niveau 2 ---
        F('iface', 'Interface réseau', 'text', 'eth0', true,
          'Interface du contrôleur raccordée au réseau de poste. GOOSE et Sampled ' +
          'Values ne passent pas par IP : le serveur ouvre une socket de niveau 2, ce ' +
          'qui demande la capacité CAP_NET_RAW à son service systemd.',
          { when: { mode: ['goose', 'sv'] } }),
        F('appId', 'APPID attendu', 'int', -1, false,
          'Identifiant d’application annoncé en tête de trame ; −1 pour accepter tous ' +
          'les flux de l’interface. Le filtrer évite de décoder les trames des autres IED.',
          { when: { mode: ['goose', 'sv'] } }),
        F('promisc', 'Mode promiscuité', 'bool', false, false,
          'Nécessaire si les trames ne sont pas adressées à cette interface — par exemple ' +
          'sur un port miroir de commutateur.', { when: { mode: ['goose', 'sv'] } }),

        // --- GOOSE ---
        F('gocbRef', 'Référence du bloc GOOSE', 'text', '', false,
          'Référence du GoCB annoncée dans la trame (ex. IED1LD0/LLN0$GO$gcb01) ; vide ' +
          'pour ne pas filtrer.', { when: { mode: ['goose'] } }),
        F('acceptSimulated', 'Accepter les trames simulées', 'bool', false, false,
          'Les trames marquées « simulation » viennent d’un injecteur de test, pas du ' +
          'procédé. Les refuser est le comportement sûr ; ne cocher que pour un essai ' +
          'd’injection délibéré.', { when: { mode: ['goose'] } }),

        // --- Sampled Values ---
        F('svId', 'Identifiant svID', 'text', '', false,
          'Identifiant du flux annoncé dans chaque ASDU ; vide pour ne pas filtrer.',
          { when: { mode: ['sv'] } }),

        // --- MMS et rapports : ISO sur TCP ---
        F('host', 'Hôte', 'text', '', true, 'Adresse IP ou nom réseau de l’IED.',
          { when: { mode: ['mms', 'report'] } }),
        F('port', 'Port', 'int', 102, false, 'Port TCP de la pile ISO (102 par défaut).',
          { when: { mode: ['mms', 'report'] } }),
        F('iedName', 'Nom d’IED', 'text', '', false,
          'Nom logique de l’IED, utilisé en tête des références d’objet.',
          { when: { mode: ['mms', 'report'] } }),
        F('rcbRef', 'Référence du bloc de rapport', 'text', '', false,
          'Référence du RCB à activer, par exemple IED1LD0/LLN0.RP.urcb01 pour un bloc ' +
          'non bufférisé, ou LLN0.BR.brcb01 pour un bloc bufférisé.',
          { when: { mode: ['report'] } }),
        F('buffered', 'Bloc bufférisé (BRCB)', 'bool', true, false,
          'Un BRCB conserve les rapports pendant une coupure et les rejoue à la ' +
          'reconnexion ; un URCB perd ce qui s’est produit hors ligne. Le bufférisé est ' +
          'le choix sûr pour du diagnostic.', { when: { mode: ['report'] } }),
        F('dataset', 'Jeu de données', 'text', '', false,
          'Référence du dataset rapporté, si le bloc ne le fixe pas lui-même.',
          { when: { mode: ['report'] } }),
        F('trgOps', 'Conditions de déclenchement', 'enum', 'dchg', false,
          'Ce qui provoque un rapport : changement de valeur, de qualité, mise à jour, ' +
          'ou période d’intégrité.',
          { choices: [['dchg', 'Changement de valeur'], ['qchg', 'Changement de qualité'],
                      ['dupd', 'Mise à jour'], ['integrity', 'Périodique (intégrité)']],
            when: { mode: ['report'] } }),
        F('intgPd', 'Période d’intégrité (ms)', 'int', 1000, false,
          'Intervalle des rapports périodiques ; 0 pour n’envoyer que sur événement.',
          { when: { mode: ['report'] } }),
        F('timeoutMs', 'Délai d’attente (ms)', 'int', 5000, false,
          'Temps maximal d’attente d’une réponse de l’IED avant de signaler le lien en ' +
          'défaut.', { when: { mode: ['mms', 'report'] } }),
      ].concat(SKEW),
      pointFields: [
        // --- GOOSE ---
        F('field', 'Donnée', 'enum', 'data', false,
          'Entrée du jeu de données, ou compteur du flux. stNum change à chaque ' +
          'événement ; sqNum à chaque réémission — un sqNum figé trahit un IED muet.',
          { choices: [['data', 'Entrée du jeu de données'], ['stNum', 'stNum (événements)'],
                      ['sqNum', 'sqNum (réémissions)']], when: { mode: ['goose'] } }),
        F('index', 'Indice dans le jeu de données', 'int', 0, false,
          'Rang de l’entrée dans le dataset, à partir de 0, tel que le fichier SCL le ' +
          'fixe. Les membres d’une structure comptent chacun pour une entrée. Sert aussi ' +
          'à repérer la valeur dans un rapport, qui arrive dans ce même ordre.',
          { when: { mode: ['goose', 'report'] } }),

        // --- Sampled Values ---
        F('asdu', 'ASDU', 'int', 0, false,
          'Rang de l’ASDU dans la trame, à partir de 0. Un flux 9-2LE en porte souvent ' +
          'plusieurs, correspondant à des instants d’échantillonnage successifs.',
          { when: { mode: ['sv'] } }),
        F('channel', 'Voie', 'int', 0, false,
          'Rang de la voie dans le bloc de données, à partir de 0. En 9-2LE : 0 à 3 pour ' +
          'IA, IB, IC, IN ; 4 à 7 pour UA, UB, UC, UN.', { when: { mode: ['sv'] } }),
        F('field', 'Donnée', 'enum', 'channel', false,
          'Valeur d’une voie, ou repère du flux : smpCnt (compteur d’échantillons) et ' +
          'smpSynch (état de synchronisation) servent à vérifier la santé du flux.',
          { choices: [['channel', 'Valeur d’une voie'], ['smpCnt', 'smpCnt'],
                      ['smpSynch', 'smpSynch']], when: { mode: ['sv'] } }),

        // --- MMS et rapports ---
        F('ref', 'Référence d’objet', 'text', '', false,
          'Référence complète de l’attribut, par exemple LD0/MMXU1.A.phsA.cVal.mag.f. ' +
          'Elle est traduite en nom MMS (domaine + LN$FC$DO$DA) à l’ouverture du lien.',
          { when: { mode: ['mms', 'report'] } }),
        F('fc', 'Contrainte fonctionnelle', 'enum', 'MX', false,
          'Contrainte fonctionnelle de l’attribut : mesures (MX), état (ST), consigne (SP), ' +
          'réglage (SE), configuration (CF).',
          { choices: [['MX', 'MX — mesures'], ['ST', 'ST — état'], ['SP', 'SP — consignes'],
                      ['SE', 'SE — réglages'], ['CF', 'CF — configuration']],
            when: { mode: ['mms', 'report'] } }),
      ].concat(SCALE).concat(HORODATAGE),
    },
    {
      id: 'can-raw',
      label: 'Bus CAN (trames brutes)',
      transport: 'SocketCAN (Linux)',
      state: 'live',
      badge: 'ext.CAN',
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
      ].concat(BITFIELD).concat(SCALE).concat(HORODATAGE),
    },
    {
      id: 'j1939',
      label: 'J1939 (CAN, SPN)',
      transport: 'SocketCAN (Linux)',
      state: 'live',
      badge: 'ext.J1939',
      help: 'Décodage J1939 au-dessus de CAN : l’identifiant 29 bits est découpé en ' +
            'priorité, PGN et adresse source ; un point est un SPN extrait d’un PGN. ' +
            'Les PGN de plus de 8 octets (DM1, par exemple) sont réassemblés par le ' +
            'protocole de transport BAM, en écoute passive. Un PGN que le calculateur ' +
            'n’émet pas de lui-même se réclame point par point, avec sa période.',
      linkFields: [
        F('iface', 'Interface', 'text', 'can0', true, 'Nom de l’interface CAN du système.'),
        F('sa', 'Adresse source filtrée', 'int', -1, false,
          'N’accepter que les trames émises par cette adresse source (0 à 253) ; −1 pour toutes.'),
        F('ownSa', 'Notre adresse source', 'int', 249, false,
          'Adresse J1939 sous laquelle le serveur émet, lorsqu’au moins un point demande ' +
          'son PGN. 249 est réservée à un outil de diagnostic externe ; elle ne doit ' +
          'surtout pas être déjà portée par un calculateur du réseau. Sans point demandé, ' +
          'le lien reste strictement en écoute et ce réglage ne sert pas.'),
      ],
      pointFields: [
        F('pgn', 'PGN', 'int', 61444, true,
          'Numéro de groupe de paramètres, en décimal (ex. 61444 = régime moteur, EEC1 ; ' +
          '65226 = DM1, multi-trames). Les PGN de plus de 8 octets sont réassemblés si le ' +
          'lien l’autorise ; le bit de départ se compte alors sur le message entier.'),
        F('sa', 'Adresse source', 'int', -1, false,
          'Adresse source attendue pour ce point ; −1 pour accepter n’importe laquelle. ' +
          'Elle désigne aussi le destinataire de la demande, le cas échéant.'),
        F('request', 'Demander ce PGN', 'bool', false, false,
          'À cocher si le calculateur n’émet PAS ce PGN de lui-même : le serveur le ' +
          'réclame alors périodiquement (PGN 59904). Laisser décoché pour un PGN diffusé ' +
          'spontanément, comme EEC1 — c’est le cas courant, et le lien reste alors ' +
          'strictement en écoute, sans rien émettre sur le bus.'),
        F('requestPeriodS', 'Période de demande (s)', 'float', 1, false,
          'Intervalle entre deux demandes de ce PGN (0,1 s à 1 h). Plusieurs SPN du même ' +
          'PGN ne déclenchent qu’une seule demande, à la plus courte des périodes ' +
          'réclamées. Trop court, on charge le bus et le calculateur pour rien.',
          { when: { request: ['true'] } }),
      ].concat(BITFIELD).concat(SCALE).concat(HORODATAGE),
    },
    {
      id: 'canopen',
      label: 'CANopen',
      transport: 'SocketCAN (Linux)',
      state: 'live',
      badge: 'ext.CANopen',
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
      ].concat(BITFIELD.map((f) => Object.assign({}, f, { when: { mode: ['tpdo'] } }))).concat(SCALE).concat(HORODATAGE),
    },
    {
      id: 'snmp',
      label: 'SNMP',
      transport: 'UDP (port 161)',
      state: 'live',
      badge: 'ext.SNMP',
      help: 'Gestionnaire SNMP en lecture seule : interrogation cyclique d’OID par ' +
            'GetRequest. Les trois versions sont lues — v1, v2c et v3 (USM : ' +
            'authentification MD5, SHA-1 ou SHA-256, chiffrement DES ou AES-128). ' +
            'Les phrases secrètes de v3 ne sont jamais dans la configuration : ' +
            'elle ne porte qu’une référence, résolue dans l’environnement du ' +
            'serveur. Un serveur compilé sans Net-SNMP sert encore v1 et v2c, et ' +
            'annonce v3 « non branché » plutôt que de retomber en clair. Aucune ' +
            'écriture (SetRequest) n’est possible.',
      linkFields: [
        F('host', 'Hôte', 'text', '', true, 'Adresse IP ou nom réseau de l’agent SNMP.'),
        F('port', 'Port', 'int', 161, false, 'Port UDP de l’agent (161 par défaut).'),
        F('version', 'Version', 'enum', 'v2c', true,
          'v1 : la plus ancienne, sans Counter64 ni exception par variable. v2c : le ' +
          'choix courant, mais communauté EN CLAIR sur le réseau. v3 : authentification ' +
          'et chiffrement (modèle USM) — le seul choix raisonnable sur un réseau exposé. ' +
          'v3 demande un serveur compilé avec Net-SNMP ; sans lui, le lien refuse de ' +
          's’ouvrir plutôt que de retomber en clair.',
          { choices: [['v1', 'v1'], ['v2c', 'v2c'], ['v3', 'v3 (sécurisée)']] }),
        F('community', 'Communauté', 'text', 'public', false,
          'Communauté de lecture, transmise EN CLAIR sur le réseau par v1 et v2c : ' +
          'ne pas y mettre un secret qui compte, et préférer v3 sur un réseau exposé.',
          { when: { version: ['v1', 'v2c'] } }),
        F('user', 'Utilisateur (USM)', 'text', '', false,
          'Nom d’utilisateur du modèle de sécurité USM.', { when: { version: ['v3'] } }),
        F('level', 'Niveau de sécurité', 'enum', 'authPriv', false,
          'noAuthNoPriv : ni authentification ni chiffrement. authNoPriv : authentifié. ' +
          'authPriv : authentifié et chiffré.',
          { choices: [['noAuthNoPriv', 'Aucun'], ['authNoPriv', 'Authentification'],
                      ['authPriv', 'Authentification et chiffrement']],
            when: { version: ['v3'] } }),
        F('authProto', 'Algorithme d’authentification', 'enum', 'SHA', false,
          'Fonction de hachage du condensé d’authentification.',
          { choices: [['MD5', 'HMAC-MD5'], ['SHA', 'HMAC-SHA-1'],
                      ['SHA256', 'HMAC-SHA-256']], when: { version: ['v3'] } }),
        F('privProto', 'Algorithme de chiffrement', 'enum', 'AES', false,
          'Chiffrement de la charge utile.',
          { choices: [['DES', 'DES-CBC'], ['AES', 'AES-128-CFB']], when: { version: ['v3'] } }),
        F('secretRef', 'Référence des secrets', 'text', '', false,
          'Nom désignant les phrases secrètes — jamais les phrases elles-mêmes : cette ' +
          'configuration est lisible par tout poste connecté et s’exporte en clair. Le ' +
          'serveur lit DIAGWEB_SECRET_<RÉFÉRENCE>_AUTH et …_PRIV dans son environnement ' +
          '(à défaut DIAGWEB_SECRET_<RÉFÉRENCE> pour les deux), que systemd sait ' +
          'alimenter depuis son magasin de secrets sans rien écrire sur disque.',
          { when: { version: ['v3'] } }),
        F('timeoutMs', 'Délai d’attente (ms)', 'int', 1500, false,
          'Temps maximal d’attente d’une réponse. UDP perd des datagrammes sans le dire : ' +
          'le lien n’est déclaré en défaut qu’après trois délais consécutifs.'),
        F('maxVars', 'Groupement (variables)', 'int', 16, false,
          'Nombre maximal d’OID demandés dans une même requête ; 1 pour les interroger ' +
          'séparément. Trop élevé, l’agent répond « tooBig ».'),
      ].concat(SKEW),
      pointFields: [
        F('oid', 'OID', 'text', '1.3.6.1.2.1.1.3.0', true,
          'Identifiant d’objet en notation pointée. Un scalaire se termine par « .0 » ' +
          '(ex. 1.3.6.1.2.1.1.3.0 = temps depuis le démarrage) ; une entrée de table ' +
          'porte son index (ex. 1.3.6.1.2.1.2.2.1.10.2 = octets reçus sur l’interface 2).'),
        F('tsOid', 'OID d’horodatage', 'text', '', false,
          'SNMP ne transporte AUCUNE date : ni la requête ni la réponse n’en portent. ' +
          'Certaines MIB en exposent une dans un objet voisin — indiquer ici son OID le ' +
          'fait lire dans la même requête, donc au même instant que la valeur. Laisser ' +
          'vide si la MIB n’en propose pas : l’horloge du serveur sera utilisée.'),
        F('tsType', 'Type de l’horodatage', 'enum', 'dateAndTime', false,
          'Sans effet si aucun OID d’horodatage n’est indiqué. DateAndTime (RFC 2579) : ' +
          'date absolue, éventuellement avec son fuseau — la seule vraiment fiable. ' +
          'TimeTicks : centièmes de seconde depuis le démarrage de l’agent, ramenés en ' +
          'absolu par approximation.',
          { choices: [['dateAndTime', 'DateAndTime (absolue)'],
                      ['timeTicks', 'TimeTicks (depuis le démarrage)']] }),
      ].concat(SCALE).concat(HORODATAGE),
    },
    {
      id: 'opcua',
      label: 'OPC UA (IEC 62541)',
      transport: 'UA-TCP binaire (opc.tcp, port 4840)',
      state: 'live',
      badge: 'ext.OPCUA',
      help: 'Client OPC UA d’un serveur de supervision ou d’un équipement : lecture ' +
            'de nœuds désignés par leur NodeId, par abonnement (MonitoredItems) ou ' +
            'par interrogation cyclique (Read). S’appuie sur open62541. Lecture seule ' +
            'définitive : ni Write ni Call ne sont appelés. Le chiffrement demande un ' +
            'serveur compilé avec l’option correspondante ; sans elle, un lien réglé ' +
            'en signature ou chiffrement refuse de s’ouvrir plutôt que de dialoguer ' +
            'en clair.',
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
          'clair. Le secret est repris de l’environnement du serveur de diagnostic.',
          { when: { auth: ['username'] } }),
        F('secretRef', 'Référence du secret', 'text', '', false,
          'Nom désignant le secret — jamais le secret lui-même. Le serveur lit la variable ' +
          'd’environnement DIAGWEB_SECRET_<référence> (en majuscules), que systemd sait ' +
          'alimenter depuis son magasin de secrets sans l’écrire sur disque.',
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
      ].concat(SKEW),
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
      ].concat(SCALE).concat(HORODATAGE),
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

  /**
   * Un champ est-il pertinent compte tenu des autres valeurs saisies ?
   *
   * `hors` porte le contexte englobant : les champs d'un POINT dépendent
   * souvent d'un réglage du LIEN — le mécanisme IEC 61850, par exemple,
   * décide de ce qu'un point doit renseigner. Sans ce second niveau, une
   * condition sur un champ du lien ne serait jamais satisfaite depuis le
   * formulaire d'un point, et le champ resterait invisible.
   */
  function fieldApplies(f, params, hors) {
    if (!f.when) return true;
    for (const k in f.when) {
      let v = params[k];
      if (v == null && hors) v = hors[k];
      const cur = v == null ? '' : String(v);
      if (!f.when[k].map(String).includes(cur)) return false;
    }
    return true;
  }

  function defaults(fields) {
    const o = {};
    for (const f of fields) o[f.key] = fieldDefault(f);
    return o;
  }

  // ------------------------------------------------------------------
  // Serveurs de test locaux
  // ------------------------------------------------------------------
  /**
   * Coordonnées des équipements de test qui tournent sur la MÊME machine que
   * le serveur de diagnostic, en développement (Codespace, poste local) :
   * `tools/bench.mjs` pour les protocoles sur IP, et le simulateur
   * d'équipements pour Modbus (docs/SIMULATEUR.md).
   *
   * Un lien neuf part avec ces valeurs — c'est exactement ce qu'on aurait tapé
   * à la main, et une adresse tapée à la main se trompe. Rien n'est pré-rempli
   * ailleurs : un « 127.0.0.1 » proposé par défaut sur un contrôleur en
   * exploitation ferait chercher la panne au mauvais endroit.
   *
   * Les ports sont décalés des ports normalisés (502, 2404, 161, 102, 4840),
   * qui sont privilégiés et hors de portée d'un utilisateur non root.
   * `tools/check-drivers.mjs` vérifie qu'ils n'ont pas dérivé de ceux que le
   * banc ouvre réellement.
   */
  const BANC = 'node tools/bench.mjs';
  const BANC_LOCAL = {
    'modbus-tcp': { via: 'simulateur d’équipements',
                    cmd: 'bash tools/share.sh --server --local',
                    params: { host: '127.0.0.1', port: 5020, unitId: 1 } },
    'iec104':     { via: 'banc d’essai', cmd: BANC,
                    params: { host: '127.0.0.1', port: 12404, asdu: 1 } },
    'snmp':       { via: 'banc d’essai', cmd: BANC,
                    params: { host: '127.0.0.1', port: 11161, version: 'v2c',
                              community: 'public' } },
    'iec61850':   { via: 'banc d’essai', cmd: BANC,
                    params: { host: '127.0.0.1', port: 10102, mode: 'mms', iedName: 'IED1' } },
    'opcua':      { via: 'banc d’essai', cmd: BANC,
                    params: { endpoint: 'opc.tcp://127.0.0.1:14840' } },
  };

  /**
   * Poste de développement : la page vient de la machine elle-même (localhost,
   * fichier ouvert directement) ou d'un Codespace. Jamais d'un contrôleur en
   * exploitation ni de la page publique — c'est ce qui autorise le
   * pré-remplissage.
   */
  const posteDeDev = (function () {
    if (typeof location === 'undefined') return false;
    const h = String(location.hostname || '');
    return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
           /\.github\.dev$/.test(h) || /\.gitpod\.io$/.test(h);
  })();

  /** Pré-remplissage applicable à ce protocole, ou null. */
  function localPreset(protoId) {
    return posteDeDev ? BANC_LOCAL[protoId] || null : null;
  }

  /**
   * Configuration livrée par défaut sur un poste de développement : un lien
   * par protocole ayant un serveur de test local, DEUX points chacun, prêts à
   * remonter des valeurs.
   *
   * Pourquoi deux et pas un : une seule variable ne dit pas si c'est le lien
   * ou l'adressage qui va de travers. Deux, de types différents, se
   * contredisent utilement — un flottant sur deux registres et un entier ne
   * tombent pas faux ensemble par hasard.
   *
   * Le préfixe « banc- » est celui de tools/bench.mjs, délibérément : le banc
   * remplace ces liens par les siens, plus riches, au lieu de les doubler.
   * Seul le lien Modbus vise le simulateur d'équipements (démarré, lui, avec
   * le serveur de diagnostic) ; les quatre autres attendent le banc, et leur
   * état le dit en clair tant qu'il n'est pas lancé.
   *
   * Les adresses sont celles que ces serveurs exposent réellement — registre
   * 40 du simulateur, IOA 100 de la station 104, sysUpTime de l'agent SNMP…
   * Une adresse inventée ferait un point muet, c'est-à-dire l'inverse du
   * service rendu.
   */
  const LIENS_LOCAUX = [
    { id: 'banc-modbus', label: 'Simulateur — Modbus TCP', protocol: 'modbus-tcp',
      points: [
        { id: 'pression', label: 'Pression circuit A', unit: 'bar', kind: 'float',
          periodMs: 200, params: { fn: 3, reg: 40, type: 'uint16' } },
        { id: 'debit', label: 'Débit refoulement', unit: 'm3/h', kind: 'float',
          periodMs: 200, params: { fn: 3, reg: 10, type: 'float32' } },
      ] },
    { id: 'banc-iec104', label: 'Banc — IEC 60870-5-104', protocol: 'iec104',
      points: [
        { id: 'tension', label: 'Mesure flottante', unit: 'kV', kind: 'float',
          periodMs: 200, params: { ioa: 100, type: 'auto' } },
        { id: 'etat', label: 'État simple', unit: '', kind: 'bit',
          periodMs: 200, params: { ioa: 200, type: 'auto' } },
      ] },
    { id: 'banc-snmp', label: 'Banc — SNMP v2c', protocol: 'snmp',
      points: [
        { id: 'uptime', label: 'Temps depuis démarrage', unit: 's', kind: 'float',
          periodMs: 500, params: { oid: '1.3.6.1.2.1.1.3.0', gain: 0.01 } },
        { id: 'octets', label: 'Octets reçus (Counter32)', unit: 'o', kind: 'float',
          periodMs: 500, params: { oid: '1.3.6.1.2.1.2.2.1.10.2' } },
      ] },
    { id: 'banc-61850', label: 'Banc — IEC 61850 (MMS)', protocol: 'iec61850',
      points: [
        { id: 'courant', label: 'Courant phase A', unit: 'A', kind: 'float',
          periodMs: 300, params: { ref: 'LD0/MMXU1.A.phsA.cVal.mag.f', fc: 'MX' } },
        { id: 'position', label: 'Position disjoncteur', unit: '', kind: 'word',
          periodMs: 300, params: { ref: 'LD0/XCBR1.Pos.stVal', fc: 'ST' } },
      ] },
    { id: 'banc-opcua', label: 'Banc — OPC UA', protocol: 'opcua',
      points: [
        { id: 'pression', label: 'Pression', unit: 'bar', kind: 'float',
          periodMs: 300, params: { nodeId: 'ns=1;s=pression', samplingMs: 100 } },
        { id: 'compteur', label: 'Compteur signé', unit: '', kind: 'float',
          periodMs: 300, params: { nodeId: 'ns=1;s=compteur', samplingMs: 100 } },
      ] },
  ];

  /**
   * Cette configuration, complétée des paramètres de connexion du serveur de
   * test correspondant. Rendue seulement sur un poste de développement : sur
   * un contrôleur en exploitation, livrer cinq liens vers 127.0.0.1 donnerait
   * cinq liens en défaut permanent — exactement ce qu'on cherche à éviter.
   */
  function localLinks(force) {
    if (!force && !posteDeDev) return { version: 1, links: [] };
    return {
      version: 1,
      links: LIENS_LOCAUX.map((l) => {
        const pre = BANC_LOCAL[l.protocol];
        return Object.assign({}, l, {
          enabled: true,
          params: Object.assign({}, pre ? pre.params : {}),
        });
      }),
    };
  }

  /** Paramètres d'un lien NEUF : les défauts, complétés du serveur de test. */
  function linkDefaults(proto) {
    const p = defaults(proto.linkFields);
    const pre = localPreset(proto.id);
    if (pre) Object.assign(p, pre.params);
    return p;
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
      // Rien de configuré, et une machine de développement : on part avec les
      // liens vers les serveurs de test locaux plutôt qu'avec une liste vide.
      // Ce n'est PAS enregistré tant que rien n'est modifié — une valeur par
      // défaut ne doit pas devenir une configuration à laquelle on tient sans
      // l'avoir voulu.
      if (!this.config.links.length) this.config = normalize(localLinks());
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

    /**
     * État d'un lien, TOUJOURS sous la même forme — c'est `key` que
     * l'interface lit. Le serveur, lui, envoie le champ `state` : rendre son
     * objet tel quel laissait `key` indéfini, et tout lien réellement servi
     * s'affichait « ○ désactivé », y compris quand il communiquait. Le motif,
     * lui, était bien là mais caché dans une infobulle.
     */
    linkState(id) {
      if (this.mode !== 'server') {
        return { key: 'sim', state: 'sim', label: 'simulé',
                 detail: 'Valeurs simulées (pas de serveur de diagnostic).' };
      }
      const st = this.status[id];
      if (!st) {
        return { key: 'off', state: 'off', label: 'inconnu',
                 detail: 'État pas encore communiqué par le serveur de diagnostic.' };
      }
      return Object.assign({ key: st.state }, st);
    },

    /**
     * Ce qu'un point a réellement produit : nombre d'échantillons et âge du
     * dernier. `null` quand le serveur ne le dit pas (page hors serveur, ou
     * état pas encore reçu) — on n'invente pas un « 0 » qui se lirait comme
     * « le serveur affirme que ce point est muet ».
     */
    pointState(linkId, pointId) {
      const st = this.mode === 'server' ? this.status[linkId] : null;
      if (!st || !Array.isArray(st.points)) return null;
      return st.points.find((p) => p.id === pointId) || null;
    },

    addrOf, pointSummary, kindOf, defaults, fieldApplies, linkDefaults, localPreset,
    // Exposée pour tools/check-drivers.mjs, qui compare ces ports à ceux que
    // tools/bench.mjs ouvre réellement.
    localBench: BANC_LOCAL,
    localLinks,
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
