# Liens réseau — protocoles industriels

Le serveur de diagnostic ne lit pas seulement les variables internes du
`controller` : il ouvre aussi **ses propres liens** vers des équipements tiers
et publie leurs valeurs comme des variables ordinaires de Diagweb (tableau
numérique, courbes, journal, dispositions).

```
                     ┌──────────── CONTRÔLEUR ────────────┐
  équipements        │                                    │
  tiers du réseau ──▶│  serveur de diagnostic ◀── IPC ──▶ │ controller
  (Modbus, 104,      │        │                           │ (I/Q/M/S, MB,
   CAN, …)           │        └── WebSocket ──▶ navigateur│  modèles C API)
                     └────────────────────────────────────┘
```

Deux notions, et deux seulement :

| Notion | Ce que c'est | Exemple |
|---|---|---|
| **Lien** | une connexion : un protocole et ses paramètres | `banc` = Modbus TCP vers 10.0.0.5:502 |
| **Point** | une variable lue sur ce lien | `pression` = registre 40, `uint16`, gain 0,1 |

Un point est adressé dans Diagweb **`@lien.point`** — par exemple
`@banc.pression`. Le « @ » lève toute ambiguïté avec les familles existantes
(`I/Q/M/S`, `MB…`, chemins de modèle à points) et l'adresse reste courte,
lisible dans une légende de courbe, et **stable** : toute la complexité
protocolaire (registre, IOA, PGN/SPN, index/sous-index, référence d'objet)
vit dans la configuration du point, pas dans l'adresse. Changer un registre ne
casse donc aucune disposition enregistrée.

## Saisir la configuration

Deux chemins mènent une variable à l'écran, et **ils se rejoignent** : une
variable interne du contrôleur est déjà au catalogue et se saisit directement ;
un point d'équipement tiers doit d'abord être *déclaré*, après quoi il se
manipule exactement comme les autres.

```
          CHEMIN A                             CHEMIN B
  variable interne du contrôleur        point d'un équipement tiers
  déjà au catalogue :                   à déclarer d'abord :
  I1.2.3.4 · MB414 · Regul.vitesse      @banc.pression
             │                                   │
             │                         ☰ → Liens réseau…
             │                ┌──────────────────▼───────────────────┐
             │                │ ① + Nouveau lien                     │
             │                │   protocole ▾ puis SES paramètres :  │
             │                │   hôte/port · port série · interface │
             │                │   [Tester] ▸ ● ⚠ ○ ⋯ ~               │
             │                ├──────────────────────────────────────┤
             │                │ ② Points ▸ + Nouveau point           │
             │                │   identifiant · libellé · unité      │
             │                │   période · type (bit/mot/flottant)  │
             │                │   ── puis l'adressage du protocole ──│
             │                │   registre · IOA · PGN + champ de    │
             │                │   bits · index/sous-index · référence│
             │                │   ▸ donne l'adresse  @lien.point     │
             │                ├──────────────────────────────────────┤
             │                │ ③ [Ajouter au diagnostic]            │
             │                └──────────────────┬───────────────────┘
             │  une fois déclaré, le point       │
             │  rejoint les suggestions ◀────────┤
             ▼                                   ▼
 ┌───────────────────────────────────────────────────────────────────┐
 │ BARRE DU HAUT — commune aux deux chemins                          │
 │  [ recherche + suggestions ]  [ cible ▾ ]  [ période ▾ ] [Ajouter]│
 │  filtres : Toutes · PLC · Modbus · Simulink · Réseau              │
 └────────────────────────────────┬──────────────────────────────────┘
                                  ▼
             tableau numérique · graphique · journal
```

### Chemin A — une variable interne

Barre du haut : saisir l'adresse (`I1.2.3.4`, `MB414`,
`Regulation.mesure.vitesse`), choisir la **cible** (tableau numérique,
graphique existant, nouveau graphique) et éventuellement la **période**
(10 ms par défaut), puis **Ajouter** ou `Entrée`. Les suggestions se filtrent
à la frappe, sur l'adresse **et** sur le libellé.

Deux suffixes de saisie, dans le même champ :

- `Q0.3 = 1` **force** la variable côté serveur — réservé aux variables
  internes (`I/Q/M/S`, `MB`, C API) ; un point réseau est refusé ;
- un **nom d'affichage** se donne ensuite par le bouton ✎ d'une ligne du
  tableau, ou « Renommer la courbe… » dans le menu d'une pastille de série
  (vide = retour au libellé du catalogue). L'adresse, elle, ne change jamais.

### Chemin B — un point d'équipement

Menu **☰ → Liens réseau…** (fonction globale, indépendante des onglets) :

1. **+ Nouveau lien** — choisir le protocole ; le formulaire se reconstruit
   avec les champs de ce protocole seulement (Modbus TCP demande hôte, port,
   identifiant d'unité ; CANopen demande interface et nœud). Chaque champ
   porte son infobulle. L'**identifiant** du lien est la première moitié des
   adresses : `banc` ⇒ `@banc.…`.
2. **Tester** — le serveur ouvre le lien et referme, puis renvoie le résultat
   en clair (« connexion établie », « hôte introuvable », « pas de réponse
   (délai dépassé) »…). À faire avant de saisir des points : cela sépare un
   problème de câblage d'une erreur d'adressage.
3. **Points ▸ + Nouveau point** — identifiant, libellé, unité, période de
   lecture (10 ms à 60 s), type de présentation, puis l'adressage propre au
   protocole. **Dupliquer** décline en un clic un registre voisin ou un autre
   bit.
4. **Ajouter au diagnostic** — le point part vers la cible choisie dans la
   barre du haut, comme n'importe quelle variable. On peut aussi fermer la
   fenêtre et taper `@banc.pression` dans la recherche : le point déclaré est
   désormais dans les suggestions (filtre **Réseau**).

Une différence à connaître : un point réseau **impose sa propre période**,
celle de sa configuration. Le sélecteur de période de la barre du haut ne s'y
applique pas.

### Exemple complet — un capteur de pression Modbus TCP

| Étape | Champ | Valeur |
|---|---|---|
| Lien | Identifiant / Nom | `banc` / « Banc d'essai » |
| | Protocole | Modbus TCP |
| | Hôte · Port · Unité | `10.0.0.5` · `502` · `1` |
| Point | Identifiant · Libellé | `pression` · « Pression circuit A » |
| | Unité · Période | `bar` · `200` ms |
| | Fonction · Registre | Registres de maintien (03) · `40` |
| | Type · Gain | `uint16` · `0.1` |

Résultat : `@banc.pression`, en bar, lisible au tableau, traçable, journalisable
et enregistrable dans une disposition. Changer plus tard le registre 40 en 42 ne
casse aucune disposition — l'adresse Diagweb ne bouge pas.

L'état de chaque lien est affiché en permanence : ● connecté · ⚠ en défaut
(avec la cause) · ○ désactivé · ⋯ non branché · ~ simulé.

**Où vit la configuration ?** Sur le contrôleur (`<data-dir>/protocols.json`)
dès que la page est servie par le serveur de diagnostic : elle est donc
partagée par tous les postes qui s'y connectent, et rechargée au redémarrage.
Une page ouverte hors serveur (Artifact, fichier local) garde sa configuration
dans le navigateur et **simule** les valeurs, ce qui permet de préparer et de
démontrer une configuration sans matériel. Le fichier s'exporte et s'importe en
JSON depuis la même fenêtre.

## Protocoles

`web/js/protocols.js` est la **source de vérité** : champs, libellés et aides y
sont décrits une seule fois, et `tools/gen-protocols.mjs` en dérive
`server/src/protocols.generated.hpp`. Une page servie par le contrôleur propose
donc exactement les champs que le serveur sait lire.

| Protocole | Transport | État | Dossier du pilote |
|---|---|---|---|
| Modbus TCP | TCP/IP | implémenté | `drivers/modbus/` |
| Modbus RTU | liaison série | implémenté | `drivers/modbus/` |
| IEC 60870-5-104 | TCP/IP | implémenté | `drivers/iec104/` |
| CAN (trames brutes) | SocketCAN | implémenté | `drivers/can/` |
| J1939 | SocketCAN | implémenté (PGN mono-trame) | `drivers/j1939/` |
| CANopen | SocketCAN | implémenté (TPDO, SDO expédié) | `drivers/canopen/` |
| IEC 61850 (MMS) | ISO sur TCP | **déclaré** | `drivers/iec61850/` |
| OPC UA (IEC 62541) | UA-TCP binaire | **déclaré** | `drivers/opcua/` |

### Un dossier par protocole

`server/src/drivers/` ne contient que des dossiers : chaque protocole a le
sien, et `common/` regroupe ce qui est partagé — `net.hpp` (TCP à délai borné,
liaison série), `can_socket.hpp` (socle SocketCAN : ouverture, filtres noyau,
réception, bus-off) et `declared.hpp` (socle des pilotes déclarés).

Deux protocoles ne partagent un dossier que s'ils partagent leur **couche
applicative** : Modbus TCP et RTU ont la même PDU et le même décodage, seul le
transport diffère. C'est exactement l'inverse pour les trois protocoles CAN —
seul le transport leur est commun — d'où trois dossiers distincts au-dessus
d'un socle unique.

`node tools/check-drivers.mjs`, rejoué par l'intégration continue, refuse un
protocole sans dossier, un dossier sans protocole, un en-tête laissé à la
racine de `drivers/`, ou un protocole que `make_driver()` ignore.

### Modbus TCP et RTU

Maître (client) en **lecture seule** : fonctions 01 bobines, 02 entrées TOR,
03 registres de maintien, 04 registres d'entrée. Aucune écriture n'est possible
depuis Diagweb, par construction.

- Types : `bool`, `int16`, `uint16`, `int32`, `uint32`, `float32`, `float64`,
  avec **ordre des mots** réglable pour les types sur plusieurs registres
  (poids fort d'abord par défaut), extraction d'un **bit** d'un registre, puis
  `valeur = brut × gain + décalage`.
- Les points sont **regroupés** : les adresses contiguës d'une même fonction
  partent en une seule requête (paramètre « Regroupement », 125 registres au
  plus par requête protocole). Moins d'aller-retour, un équipement qui respire.
- L'adresse est celle du **protocole**, à partir de 0 : le « 40001 » d'une
  documentation correspond en général à l'adresse 0 de la fonction 03.
- RTU : trame avec CRC-16 (polynôme réfléchi 0xA001), 8 bits de données,
  parité paire par défaut ; sans parité, 2 bits d'arrêt (règle de la
  spécification série).

### IEC 60870-5-104

Client (maître) de télécontrôle, en lecture seule : **aucune commande n'est
jamais émise vers le procédé**.

Séquence : connexion → `STARTDT act` → confirmation → **interrogation
générale** (C_IC_NA_1, QOI 20) pour partir d'un état connu → régime spontané.
Le pilote répond aux `TESTFR`, acquitte par trame S toutes les *w* trames
reçues **et au plus tard au bout de t2**, émet un test de liaison après t3
d'inactivité, coupe si la station ne répond plus dans t1, et relance une
interrogation générale quand la station annonce son redémarrage (M_EI_NA_1).

Types décodés : simple et double (M_SP, M_DP), position de régleur (M_ST),
mesures normalisée, échelonnée et flottante (M_ME_N*/T*), compteurs (M_IT),
train de bits (M_BO) — avec ou sans horodatage CP56Time2a. Le bit de qualité
**IV** (invalide) écarte la valeur : rien n'est publié plutôt qu'une valeur
fausse. Le bit SQ (objets à adresses consécutives) est traité.

Ce protocole est un **flux** : la période d'un point n'y commande aucune
trame, elle borne la cadence conservée dans l'historique (voir « Période »
plus bas).

### CAN, J1939, CANopen

Sur **SocketCAN** : l'interface (`can0`…) doit être configurée et active — le
débit du bus relève de l'administration du contrôleur, pas de Diagweb.

- **CAN brut** : écoute strictement passive. Un point est un champ de bits
  décrit comme dans une base de signaux : identifiant, bit de départ, longueur,
  ordre **Intel** (petit-boutiste) ou **Motorola** (gros-boutiste), signe,
  gain, décalage. CAN FD accepté en option.
- **J1939** : l'identifiant 29 bits est décomposé en priorité, PGN et adresse
  source — en PDU1 (PF < 240) l'octet PS est une destination et ne fait pas
  partie du PGN. Un point est un SPN : PGN attendu, adresse source (ou
  « toutes »), puis le champ de bits. **Mono-trame uniquement** : le transport
  multi-trames (BAM, RTS/CTS) n'est pas implémenté, donc un PGN long (DM1,
  configuration moteur) ne remontera **jamais** de valeur — c'est dit dans
  l'interface, à côté du champ PGN. Le filtrage noyau porte sur le PGN et
  jamais sur l'adresse source, qui change à chaque re-revendication.
- **CANopen** : deux modes. **Écoute d'un TPDO** (rien n'est émis, c'est le
  mode par défaut) ou **lecture SDO** (upload expédié, `0x600+node-id` →
  `0x580+node-id`). Le mode SDO est le seul cas où le serveur émet sur le bus ;
  la case **Écoute seule**, cochée par défaut, l'interdit — interroger un nœud
  absent fait réémettre le contrôleur CAN jusqu'au **bus-off**, ce qui dégrade
  l'interface elle-même. Le pilote surveille les trames d'erreur du noyau et
  ferme le lien sur bus-off avec un message explicite plutôt que d'insister.
  À savoir : un nœud qui n'est pas en état **opérationnel** n'émet aucun TPDO —
  le lien paraît alors établi sans qu'aucune valeur ne remonte.

### IEC 61850 — pilote déclaré

La configuration (hôte, port 102, nom d'IED, mode, références d'objet et
contraintes fonctionnelles) se saisit et se conserve dès maintenant, mais
**aucune valeur n'est lue** : le lien s'affiche « non branché » et ne publie
rien — jamais de valeur inventée. La lecture demande la pile complète
ISO-on-TCP (RFC 1006) → COTP → session → présentation → ACSE → MMS en ASN.1
BER, soit un volume de code comparable à celui de tout le reste du serveur, et
elle ne peut pas être validée sans IED réel. C'est une phase ultérieure, pas un
oubli.

### OPC UA (IEC 62541) — pilote déclaré

Client d'un serveur OPC UA (supervision, passerelle, équipement récent). La
configuration se saisit et se conserve dès maintenant — point de terminaison
`opc.tcp://hôte:port`, politique et mode de sécurité, mode de lecture, puis un
**NodeId** par point (`ns=2;s=Ligne1/Debit`, `ns=2;i=1234`) — mais **aucune
valeur n'est lue** : le lien s'affiche « non branché » et ne publie rien.

Ce qui manque est une pile UA binaire complète : transport UA-TCP
(Hello/Acknowledge, découpage en morceaux), SecureConversation avec
renouvellement de jetons, encodage binaire des types intégrés et des
structures, puis les services CreateSession / ActivateSession, Read,
CreateSubscription et CreateMonitoredItems / Publish. Comme pour IEC 61850,
c'est une phase ultérieure et non un oubli : le projet s'interdit toute
dépendance externe au runtime, la pile devra donc être écrite.

Deux partis pris sont déjà fixés, pour ne pas avoir à les reprendre :

- **Lecture seule définitive.** Les services `Write` et `Call` ne seront pas
  implémentés, même une fois la pile disponible — un outil de diagnostic
  n'écrit pas dans un serveur de supervision.
- **Aucun secret dans la configuration.** `protocols.json` est lisible par tout
  poste connecté au serveur de diagnostic et s'exporte en clair depuis
  l'interface. Le nom d'utilisateur y figure ; le mot de passe et la clé privée
  du certificat client, jamais. Le champ « Référence du secret » ne porte qu'un
  **nom** désignant l'entrée du magasin de secrets du contrôleur.

Les deux modes de lecture prévus sont l'**abonnement** (MonitoredItems, avec
intervalle de publication, échantillonnage et bande morte) et l'**interrogation
cyclique** (service Read), pour les serveurs qui refusent les abonnements.

## Ce qui est volontairement hors périmètre

- **Toute écriture** : commandes Modbus, commandes de télécontrôle 104,
  émission de trames CAN/J1939, SDO download. Un outil de diagnostic branché
  sur une installation en service ne doit pas pouvoir agir sur un organe réel.
  La seule émission existante est la requête de lecture SDO, désactivée par
  défaut.
- **Transports multi-trames** : ISO-TP, transport J1939 (BAM et RTS/CTS), SDO
  segmenté et par blocs. Un signal ne peut donc pas dépasser la charge utile
  d'une trame.
- **Configuration des interfaces** (débit CAN, mise en service) : cela relève
  de l'administration du contrôleur. Diagweb constate et signale.
- **Revendication d'adresse J1939** (PGN 60928) et **état NMT CANopen** : non
  suivis. Un filtre sur adresse source fixe peut donc devenir muet après une
  re-revendication.
- **GOOSE** (IEC 61850-8-1 couche 2) et **rôle de maître CANopen**.
- **Écriture et appel de méthode OPC UA** (`Write`, `Call`), **découverte**
  automatique de l'arborescence (`Browse`) et **historique** (`HistoryRead`).

## Période, horodatage, qualité

- **Protocoles à interrogation** (Modbus, SDO) : la période du point est la
  cadence d'interrogation. Une période courte sur une liaison lente sature
  l'équipement — à 9600 bauds, une centaine de registres prennent déjà environ
  250 ms.
- **Protocoles à flux** (IEC-104, CAN, TPDO) : la période est une
  **décimation**. Elle borne la cadence conservée dans l'historique, mais
  **tout changement de valeur passe** : une transition n'est jamais masquée.
- **Horodatage** : les échantillons portent l'horloge du **serveur de
  diagnostic**, commune aux variables du `controller` — c'est la condition
  pour que les courbes soient comparables entre elles. Les horodatages
  d'origine (CP56Time2a des types 104 à date) sont **volontairement ignorés** :
  une station dont l'horloge dérive placerait ses points dans le futur ou le
  passé et fausserait toute comparaison. Les exploiter demanderait un recalage
  explicite par lien — évolution possible, pas un oubli.
- **Qualité** : une valeur marquée invalide (bit IV en 104), une exception
  Modbus, un abandon SDO ou un lien coupé ne produisent **aucun échantillon**.
  La courbe montre un trou, et l'état du lien en donne la raison.

## Robustesse

Quelques garde-fous qui expliquent le comportement observé :

- **Modbus** : la réponse est appariée à la requête (identifiant de
  transaction, identifiant de protocole, unité, fonction, taille annoncée).
  Une passerelle qui duplique une réponse décalerait sinon le flux
  durablement — et **toutes** les valeurs suivantes seraient fausses sans
  qu'aucune erreur ne le signale. Une **exception** Modbus (adresse hors plage)
  n'abat pas le lien : seule la requête fautive est mise de côté 10 s, les
  autres points continuent, et la cause s'affiche dans l'état du lien.
- **IEC-104** : les temporisations **t1/t2/t3** de la norme sont appliquées —
  acquittement à t2 même sans avoir reçu *w* trames (sans quoi une station
  calme coupe la liaison à t1), test de liaison à t3, coupure si la station
  ne répond plus. Une faute de trame ou un numéro de séquence inattendu ferme
  la liaison plutôt que de tenter une resynchronisation à l'aveugle.
- **CAN** : les identifiants attendus sont posés en **filtres noyau** et
  analysés une seule fois au démarrage — sans cela, chaque trame du bus
  réveillerait le processus qui partage le processeur avec le temps réel.

## Points d'entrée REST

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/api/protocols` | configuration, état des liens, description des protocoles |
| PUT | `/api/protocols` | enregistre et applique la configuration |
| GET | `/api/protocols/status` | état courant des liens |
| POST | `/api/protocols/test` | teste un lien (`{"id":"banc"}`) |

Format de la configuration (`<data-dir>/protocols.json`) :

```json
{
  "version": 1,
  "links": [
    {
      "id": "banc", "label": "Banc d'essai", "protocol": "modbus-tcp",
      "enabled": true,
      "params": { "host": "10.0.0.5", "port": 502, "unitId": 1 },
      "points": [
        { "id": "pression", "label": "Pression refoulement", "unit": "bar",
          "kind": "float", "periodMs": 200,
          "params": { "fn": 3, "reg": 40, "type": "uint16", "gain": 0.1 } }
      ]
    }
  ]
}
```

Identifiants de lien et de point : une lettre, puis lettres, chiffres, `-` ou
`_`, 24 caractères au plus. Un identifiant invalide, un doublon ou un protocole
inconnu est ignoré à la lecture, sans faire échouer le reste de la
configuration.

## Démonstration sans matériel

```bash
./server/build/diagweb-server --port 8080 --root . --sim-protocols
```

`--sim-protocols` remplace tous les pilotes par un générateur : les liens
passent à l'état « simulé » et les points produisent des signaux plausibles.
Utile pour préparer une configuration ou faire une démonstration ; l'état du
lien dit clairement que les valeurs ne viennent pas du terrain.

## Ajouter un protocole

1. Décrire le protocole dans `web/js/protocols.js` (`DW.PROTOCOLS`) : champs du
   lien, champs d'un point, libellés et aides en français.
2. `node tools/gen-protocols.mjs` pour régénérer l'en-tête C++.
3. Écrire le pilote **dans son propre dossier** `server/src/drivers/<protocole>/`
   en implémentant `IProtocolDriver` (`open` / `service` / `close`), puis
   l'enregistrer dans `make_driver()` de `server/src/protocol_source.hpp`.
   Ce qui est réutilisable va dans `drivers/common/`, jamais dans le dossier
   d'un autre protocole.
4. Ajouter l'entrée correspondante à la table `DOSSIERS` de
   `tools/check-drivers.mjs` — sans quoi la CI refuse le protocole, ce qui est
   voulu : le choix du dossier doit être conscient.
5. Compléter `docs/PROTOCOLES.md` et les tests (`tests/protocols.mjs` pour un
   échange complet contre un équipement simulé, `tests/decode.cpp` pour le
   décodage et les filtres).

L'interface web n'a **pas** à être modifiée : elle construit ses formulaires à
partir de la description.

## Tests

```bash
cmake --build server/build --target diagweb-decode-test && ./server/build/diagweb-decode-test
node tests/protocols.mjs        # serveur de diagnostic en fonctionnement
```

`tests/decode.cpp` couvre le décodage (champs de bits Intel/Motorola, PGN
J1939, grammaire `@lien.point`, lecture de la configuration) **et** les filtres
noyau des trois pilotes CAN, ainsi que leur appariement de trames — un filtre
trop large ou trop étroit rendrait une variable silencieusement muette.
`tests/protocols.mjs` monte un **esclave Modbus TCP** et une **station
IEC 60870-5-104** en Node, configure les liens par REST et vérifie que les
valeurs arrivent jusqu'au flux WebSocket ; il vérifie aussi que les pilotes
**déclarés** (IEC 61850, OPC UA) annoncent « non branché » et ne publient
aucune valeur. Les pilotes CAN ne sont pas couverts de bout en bout faute
d'interface CAN dans l'environnement de test : seuls leur décodage, leurs
filtres et leur appariement le sont.
