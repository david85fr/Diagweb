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
| J1939 | SocketCAN | implémenté (SPN, demande de PGN, transport BAM) | `drivers/j1939/` |
| CANopen | SocketCAN | implémenté (TPDO, SDO expédié) | `drivers/canopen/` |
| SNMP v1 et v2c | UDP/161 | implémenté | `drivers/snmp/` |
| SNMP v3 | UDP/161 | **déclaré** (USM à écrire) | `drivers/snmp/` |
| IEC 61850 (MMS) | ISO sur TCP | **déclaré** | `drivers/iec61850/` |
| OPC UA (IEC 62541) | UA-TCP binaire | implémenté (open62541) | `drivers/opcua/` |

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

### SNMP

Gestionnaire en **lecture seule** : interrogation cyclique d'OID par
GetRequest sur UDP/161. `SetRequest` n'est pas implémenté et ne le sera pas.
Un point est un OID en notation pointée ; un scalaire se termine par `.0`
(`1.3.6.1.2.1.1.3.0`), une entrée de table porte son index
(`1.3.6.1.2.1.2.2.1.10.2` = octets reçus sur l'interface 2).

- **Types décodés** : `Integer32`, `Counter32`, `Gauge32`, `TimeTicks`,
  `Counter64`, plus les chaînes **entièrement numériques** — certains agents
  publient une mesure sous forme de texte. Une chaîne non numérique n'est
  jamais publiée : elle ne serait qu'un zéro déguisé.
- **Absence de valeur** : `noSuchObject`, `noSuchInstance` (v2c) ou type non
  numérique ⇒ **aucun échantillon**, et le motif s'affiche dans l'état du lien.
  L'erreur la plus fréquente est un scalaire écrit sans son `.0` final ; le
  message le dit explicitement.
- **Groupement** : plusieurs OID partent dans une même requête (paramètre
  « Groupement », 16 par défaut). Trop élevé, l'agent répond `tooBig` — le
  motif remonte tel quel.
- **UDP perd des datagrammes sans le dire.** Un délai isolé n'est donc pas une
  erreur : le lien n'est déclaré en défaut qu'après **trois délais
  consécutifs**. Et la socket est *connectée*, ce qui écarte au niveau du
  noyau les réponses venues d'une autre machine ; l'identifiant de requête est
  vérifié en plus, pour qu'un datagramme retardé ne décale pas le flux.
- **La communauté circule en clair** en v1 et v2c. C'est une propriété du
  protocole, pas de Diagweb : ne pas y placer un secret qui compte.

**v3 est déclaré, pas implémenté.** La configuration complète se saisit
(utilisateur, niveau de sécurité, algorithmes d'authentification et de
chiffrement, référence des secrets) et se conserve, mais un lien en v3
s'affiche « non branché » et ne lit rien. Le choix mérite d'être explicite :
il aurait été facile de retomber sur v2c en silence, et ç'aurait été le pire
comportement possible pour une version choisie précisément pour sa sécurité.

Ce qui manque est le modèle de sécurité USM (RFC 3414) : découverte du moteur
distant, fenêtre temporelle, dérivation et localisation des clés depuis les
phrases secrètes, HMAC-MD5/SHA-1/SHA-256, puis DES-CBC ou AES-128-CFB pour le
chiffrement. Deux routes, maintenant que les bibliothèques sous licence libre
en produit commercial sont autorisées : écrire USM — faisable, mais c'est du
code cryptographique — ou s'appuyer sur une pile existante. À décider avant de
commencer.

### J1939 — SPN, PGN, et comment les obtenir

Un point J1939 est un **SPN** : un champ de bits situé dans un **PGN**. Reste
la question de savoir comment ce PGN arrive, et la réponse dépend du PGN, pas
du lien — c'est pourquoi l'option est **sur le point**.

| Le calculateur… | À configurer | Le serveur émet ? |
|---|---|---|
| **émet le PGN de lui-même** (EEC1 toutes les 20 ms…) | rien : on écoute | **non** |
| **n'émet ce PGN que sur demande** | cocher « Demander ce PGN » + sa période | oui |

C'est le cas courant qui est gratuit : par défaut, un lien J1939 est
**strictement en écoute** et ne pose rien sur le bus.

Deux détails qui comptent quand on coche la demande :

- **Plusieurs SPN du même PGN ne déclenchent qu'une seule demande**, à la plus
  courte des périodes réclamées — même règle que pour les abonnements aux
  variables. Déclarer dix SPN d'un même PGN ne décuple pas le trafic.
- **La demande est adressée** au calculateur du point (son adresse source), ou
  diffusée à tout le réseau si aucune adresse n'est précisée.

Le lien porte alors **notre adresse source** (249 par défaut, réservée aux
outils de diagnostic externes). Elle ne doit être portée par aucun calculateur
du réseau, sous peine de conflit d'adresse. Sans point demandé, ce réglage ne
sert pas.

#### Messages multi-trames (BAM)

Un PGN de plus de 8 octets — DM1 en est l'exemple type — est découpé par le
protocole de transport de J1939-21. La source annonce son transfert
(`TP.CM_BAM`), diffuse ses paquets (`TP.DT`), et le pilote les réassemble.
C'est **purement passif et toujours actif** : rien à configurer, rien à
émettre.

Le message réassemblé se décode ensuite exactement comme une trame : un SPN
au-delà du 8ᵉ octet se déclare simplement avec un bit de départ plus grand
(l'octet 9 commence au bit 72).

Deux garde-fous, parce que ces annonces viennent du bus :

- une annonce dont la taille sort des bornes de la norme (9 à 1785 octets) ou
  dont le compte de paquets ne correspond pas à la taille est **rejetée avant
  toute allocation** — un compte de paquets fantaisiste ne dicte pas la taille
  d'un tampon ;
- une session sans paquet depuis 750 ms (délai T1 de la norme) est abandonnée
  avec un motif visible. Sans cette purge, une source coupée en cours de
  transfert immobiliserait sa session et le message suivant serait perdu.

Le dialogue **point à point** (`RTS`/`CTS`) n'est traité que sur un lien qui
demande déjà des PGN : une demande adressée à un calculateur précis peut
recevoir sa réponse en connexion plutôt qu'en diffusion, et sans l'accusé
attendu le transfert n'aboutirait jamais. Un lien qui se contente d'écouter
n'émet donc aucun `CTS`.

### IEC 61850 — pilote déclaré

La configuration (hôte, port 102, nom d'IED, mode, références d'objet et
contraintes fonctionnelles) se saisit et se conserve dès maintenant, mais
**aucune valeur n'est lue** : le lien s'affiche « non branché » et ne publie
rien — jamais de valeur inventée. La lecture demande la pile complète
ISO-on-TCP (RFC 1006) → COTP → session → présentation → ACSE → MMS en ASN.1
BER, soit un volume de code comparable à celui de tout le reste du serveur, et
elle ne peut pas être validée sans IED réel. C'est une phase ultérieure, pas un
oubli.

### OPC UA (IEC 62541)

Client d'un serveur OPC UA — supervision, passerelle, équipement récent — en
**lecture seule** : ni `Write` ni `Call` ne sont appelés, et ne le seront pas.
Un point est un **NodeId** (`ns=1;s=pression`, `ns=2;i=1234`).

C'est le seul protocole qui s'appuie sur une bibliothèque, **open62541**
(MPL-2.0) : écrire la pile à la main — UA-TCP, SecureConversation, encodage
binaire de tous les types, services de session, de lecture et d'abonnement —
représentait plus de code que tout le reste du serveur réuni.

| Mode | Ce qui se passe | Quand l'utiliser |
|---|---|---|
| **Abonnement** (défaut) | le serveur notifie les changements (`MonitoredItems`) | par défaut : économe, réactif |
| Interrogation cyclique | service `Read` répété à la période du point | serveur qui refuse les abonnements |

En abonnement, chaque point porte son **intervalle d'échantillonnage** et sa
**bande morte** ; le lien porte l'**intervalle de publication**.

- **Types acceptés** : `Boolean`, `SByte`/`Byte`, `Int16`/`UInt16`,
  `Int32`/`UInt32`, `Int64`/`UInt64`, `Float`, `Double` — scalaires seulement.
  Tout autre type (chaîne, tableau, structure) n'est **jamais publié** : le
  motif apparaît dans l'état du lien.
- **Qualité** : une valeur dont le `StatusCode` n'est pas bon ne produit aucun
  échantillon, comme le bit IV en IEC-104.
- **NodeId illisible** : le point est ignoré avec un motif, les autres points
  du lien continuent d'être lus.

#### Sécurité et secrets

Deux règles, et elles ne se négocient pas.

**Pas de repli silencieux en clair.** Le chiffrement demande OpenSSL, apporté
par l'option de compilation `DIAGWEB_OPCUA_ENCRYPTION` (désactivée par défaut,
car OpenSSL doit alors exister dans le SDK du contrôleur). Sans elle, un lien
réglé en « Signature » ou « Signature et chiffrement » **refuse de s'ouvrir**
et affiche pourquoi. Se rabattre sur une connexion en clair aurait donné une
fausse impression de sécurité, ce qui est pire que l'absence de connexion.

**Aucun secret dans la configuration.** `protocols.json` est lisible par tout
poste connecté au serveur de diagnostic et s'exporte en clair depuis
l'interface. Le nom d'utilisateur y figure ; le mot de passe, jamais. Le champ
« Référence du secret » ne porte qu'un **nom** : le serveur lit la variable
d'environnement `DIAGWEB_SECRET_<RÉFÉRENCE>` (en majuscules, caractères non
alphanumériques remplacés par `_`), que systemd sait alimenter depuis son
magasin de secrets sans jamais l'écrire sur disque.

#### Compilation

`DIAGWEB_WITH_OPCUA` est actif par défaut ; CMake utilise une copie
d'open62541 déjà installée si `find_package` en trouve une — le cas d'un SDK
de contrôleur — et la récupère sinon par `FetchContent` sur la version épinglée
`DIAGWEB_OPCUA_TAG`. **La compilation croisée d'un produit ne devrait pas
dépendre d'un accès réseau** : fournir la bibliothèque dans le SDK est la voie
recommandée.

```bash
cmake -B build -S server -DDIAGWEB_WITH_OPCUA=OFF        # sans OPC UA, hors ligne
cmake -B build -S server -DDIAGWEB_OPCUA_ENCRYPTION=ON   # avec chiffrement (OpenSSL)
```

À `OFF`, le serveur se construit sans aucune dépendance et le pilote redevient
« déclaré » : la configuration reste saisissable, rien n'est publié, et l'état
du lien le dit.

Deux réglages ont dû être forcés sur la construction d'open62541, et méritent
d'être notés : ses en-têtes sont vus comme **includes système** (nos `-Werror`
portent sur le code de Diagweb, pas sur celui d'une bibliothèque tierce), et
son **optimisation inter-procédurale est désactivée** — à l'édition de liens,
GCC recompilait son code C avec nos options, dont `-Werror`.

## Ce qui est volontairement hors périmètre

- **Toute écriture** : commandes Modbus, commandes de télécontrôle 104,
  émission de trames CAN/J1939, SDO download. Un outil de diagnostic branché
  sur une installation en service ne doit pas pouvoir agir sur un organe réel.
  La seule émission existante est la requête de lecture SDO, désactivée par
  défaut.
- **Transports multi-trames restants** : ISO-TP, et le SDO CANopen segmenté ou
  par blocs. Le transport J1939 (BAM, et RTS/CTS en mode requête) est en
  revanche implémenté.
- **Configuration des interfaces** (débit CAN, mise en service) : cela relève
  de l'administration du contrôleur. Diagweb constate et signale.
- **Revendication d'adresse J1939** (PGN 60928) et **état NMT CANopen** : non
  suivis. Un filtre sur adresse source fixe peut donc devenir muet après une
  re-revendication.
- **GOOSE** (IEC 61850-8-1 couche 2) et **rôle de maître CANopen**.
- **Écriture et appel de méthode OPC UA** (`Write`, `Call`), **découverte**
  automatique de l'arborescence (`Browse`), **historique** (`HistoryRead`) et
  **événements** (`EventNotifier`). Les types non scalaires — tableaux,
  structures — ne sont pas convertis.
- **SNMP** : `SetRequest` (écriture), réception de **trappes** et
  d'`InformRequest` (Diagweb interroge, il n'écoute pas), parcours de MIB
  (`GetNext`, `GetBulk`) et résolution des noms symboliques — un OID se saisit
  en notation pointée, aucune MIB n'est chargée.

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

## Bibliothèques externes et licences

Le serveur de diagnostic peut s'appuyer sur une bibliothèque tierce pour un
protocole, à une condition : **elle doit rester gratuite lorsqu'elle est
intégrée à un produit commercial fermé**. L'interface web, elle, n'a toujours
aucune dépendance — la page publiée est servie sous CSP stricte et le
contrôleur doit pouvoir la servir hors ligne.

| Licence | Verdict | Pourquoi |
|---|---|---|
| MIT, BSD, ISC, zlib, Apache-2.0 | acceptée | aucune obligation sur le produit |
| MPL-2.0 | acceptée | copyleft **par fichier** : seules les modifications de la bibliothèque se publient |
| LGPL | à éviter | l'édition de liens statique, usuelle en embarqué, impose de fournir de quoi relier |
| GPL, AGPL | refusée | contamine le produit |
| double licence « GPL ou commerciale » | refusée | l'usage commercial se paie : la gratuité annoncée ne s'applique pas ici |

**Toujours lire le fichier `LICENSE` du dépôt, jamais le badge.** Celui de
S2OPC annonce « Educational Community License v2.0 » alors que le fichier dit
Apache-2.0 : les détecteurs automatiques confondent des textes voisins.

### État des lieux par protocole

Licences vérifiées dans les dépôts eux-mêmes.

| Bibliothèque | Protocole | Langage | Licence | Décision |
|---|---|---|---|---|
| [open62541](https://github.com/open62541/open62541) | OPC UA | C99 | MPL-2.0 (quelques fichiers CC0) | **retenue et intégrée** (v1.5.6) |
| [S2OPC](https://gitlab.com/systerel/S2OPC) | OPC UA | C | Apache-2.0 | acceptable — solution de repli, orientée sûreté |
| [libiec61850](https://github.com/mz-automation/libiec61850) | IEC 61850 (MMS, GOOSE, SV) | C99 | GPLv3 **ou** licence commerciale payante | **écartée** |
| [lib60870](https://github.com/mz-automation/lib60870) | IEC 60870-5-101/104 | C | GPLv3 **ou** licence commerciale payante | écartée, et sans objet |
| IEC61850bean | IEC 61850 | Java | Apache-2.0 annoncée, non vérifiée | hors périmètre : demande une JVM |

Trois conséquences, dont une désagréable.

**OPC UA — intégrée.** C'était le seul protocole du lot où l'écriture à la
main était disproportionnée : UA-TCP, SecureConversation avec renouvellement de
jetons, encodage binaire de tous les types intégrés, puis les services de
session, de lecture et d'abonnement. open62541 couvre l'ensemble sous MPL-2.0,
qui autorise explicitement la combinaison avec du logiciel propriétaire —
seules les modifications apportées à ses propres fichiers devraient être
publiées, ce qui ne concerne pas le code de Diagweb. Version épinglée v1.5.6,
licence vérifiée dans son fichier `LICENSE`. C'est la **seule** dépendance du
serveur, et elle se débranche par `-DDIAGWEB_WITH_OPCUA=OFF`.

**IEC 61850 — la contrainte de licence ferme la porte.** Toutes les piles C
matures sont en double licence GPLv3 / commerciale : gratuites tant que le
produit est lui-même GPL, payantes sinon. Aucune pile permissive en C n'existe
à ce jour. Il n'y a donc que trois issues, et ce n'est pas une décision
technique : acheter une licence commerciale, écrire la pile ISO/MMS, ou
laisser le pilote déclaré. En attendant, il reste déclaré.

**Modbus, IEC 60870-5-104, CAN — on garde l'existant.** Ces pilotes
fonctionnent, sont couverts de bout en bout par les tests et ne coûtent rien à
la compilation. Remplacer du code testé par une dépendance serait une perte
sèche : plus de compilation croisée à régler, plus de surface, et aucune
fonction gagnée.

### Avant d'introduire une dépendance

1. Vérifier le fichier `LICENSE` et le consigner dans le tableau ci-dessus.
2. S'assurer qu'elle se **compile en croisé** avec la chaîne d'outils du
   contrôleur, et mesurer ce qu'elle ajoute en taille et en mémoire — la cible
   est embarquée.
3. Tenir les obligations d'attribution (fichier `NOTICE` pour Apache-2.0,
   publication des fichiers modifiés pour MPL-2.0).
4. Ajouter à la CI un contrôle de la liste blanche des licences, sur le modèle
   de `tools/check-drivers.mjs` — une dépendance dont la licence change lors
   d'une montée de version ne doit pas passer inaperçue.

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
J1939, codec BER/ASN.1 de SNMP — y compris les longueurs qui débordent du
tampon reçu — grammaire `@lien.point`, lecture de la configuration) **et** les
filtres
noyau des trois pilotes CAN, ainsi que leur appariement de trames — un filtre
trop large ou trop étroit rendrait une variable silencieusement muette.
`tests/protocols.mjs` monte un **esclave Modbus TCP**, une **station
IEC 60870-5-104** et un **agent SNMP v2c** en Node, configure les liens par
REST et vérifie que les
valeurs arrivent jusqu'au flux WebSocket. Un **serveur OPC UA de test**
(`tests/opcua_server.c`, cible `diagweb-opcua-test-server`) est lancé de la
même façon : il couvre l'abonnement, l'interrogation cyclique, la conversion
des types, le refus des chaînes, et le refus d'ouvrir un lien chiffré sur un
serveur compilé sans chiffrement. Le test vérifie aussi que le pilote
**déclaré** restant (IEC 61850) annonce « non branché » sans publier de valeur. Les pilotes CAN ne sont pas couverts de bout en bout faute
d'interface CAN dans l'environnement de test : seuls leur décodage, leurs
filtres et leur appariement le sont.
