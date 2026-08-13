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
| SNMP v1 et v2c | UDP/161 | implémenté (sans dépendance) | `drivers/snmp/` |
| SNMP v3 (USM) | UDP/161 | implémenté (Net-SNMP) | `drivers/snmp/` |
| IEC 61850 GOOSE (8-1) | Ethernet 0x88B8 | implémenté | `drivers/iec61850/` |
| IEC 61850 Sampled Values (9-2) | Ethernet 0x88BA | implémenté | `drivers/iec61850/` |
| IEC 61850 lecture MMS | ISO sur TCP | implémenté | `drivers/iec61850/` |
| IEC 61850 rapports BRCB/URCB | MMS | implémenté | `drivers/iec61850/` |
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

#### v3 : le modèle de sécurité USM

Les trois versions sont lues. v1 et v2c tiennent dans `drivers/snmp/snmp.hpp`,
sans aucune dépendance. **v3 s'appuie sur Net-SNMP** (`drivers/snmp/netsnmp.hpp`),
et le choix mérite d'être dit : USM (RFC 3414) demande la découverte du moteur
distant, une fenêtre temporelle, la dérivation puis la localisation des clés à
partir des phrases secrètes, HMAC-MD5/SHA-1/SHA-256, et DES-CBC ou AES-128-CFB.
Écrire soi-même du code cryptographique qu'on ne peut pas éprouver contre
l'existant est exactement ce qu'il ne faut pas faire. Net-SNMP est sous licences
BSD (fichier `COPYING` vérifié, aucune clause GPL), donc utilisable dans un
produit commercial fermé.

| Réglage | Valeurs |
|---|---|
| Niveau de sécurité | `noAuthNoPriv`, `authNoPriv`, `authPriv` |
| Authentification | HMAC-MD5, HMAC-SHA-1, HMAC-SHA-256 |
| Chiffrement | DES-CBC, AES-128-CFB |

La clé de chiffrement se dérive avec la **fonction de hachage de
l'authentification** : c'est la règle de la RFC 3414, pas un raccourci
d'implémentation.

**Aucun secret dans la configuration.** `protocols.json` est lisible par tout
poste connecté et s'exporte en clair : il ne porte qu'une **référence**, que le
serveur résout dans son environnement.

```
DIAGWEB_SECRET_<RÉFÉRENCE>_AUTH    phrase d'authentification
DIAGWEB_SECRET_<RÉFÉRENCE>_PRIV    phrase de chiffrement
DIAGWEB_SECRET_<RÉFÉRENCE>         repli servant aux deux
```

Une référence `poste-nord` cherche donc `DIAGWEB_SECRET_POSTE_NORD_AUTH` (tout
caractère non alphanumérique devient `_`). systemd sait alimenter ces variables
depuis son magasin de secrets, sans rien écrire sur disque. Si le secret manque,
le lien **refuse de s'ouvrir** et le dit — jamais de repli silencieux vers une
version non chiffrée.

Un serveur compilé sans Net-SNMP (`-DDIAGWEB_WITH_NETSNMP=OFF`, ou bibliothèque
absente) sert encore v1 et v2c par l'implémentation interne ; un lien en v3 s'y
affiche « non branché ». La bascule est faite par `make_snmp_driver()`, à la
compilation.

#### Horodatage : ce que SNMP ne transporte pas

SNMP ne porte **aucune date** : ni la requête ni la réponse n'en contiennent.
En revanche, une MIB peut en exposer une dans un objet voisin — et beaucoup le
font. Un point peut donc désigner un **OID d'horodatage** compagnon, ajouté à la
**même requête** que la valeur : la date et la mesure viennent alors du même
échange, donc du même instant.

- `DateAndTime` (RFC 2579) : date absolue sur 8 ou 11 octets, la seule vraiment
  fiable. La forme longue porte son décalage par rapport à UTC ; la courte est
  prise pour de l'UTC, faute de mieux. Exemple servi par presque tous les
  agents : `hrSystemDate.0` = `1.3.6.1.2.1.25.1.2.0`.
- `TimeTicks` : centièmes de seconde depuis le démarrage de l'agent. N'a de sens
  que rapporté au `sysUpTime.0` du **même échange** — que le pilote demande
  alors en tête de requête. Sans ce repère, aucune date n'est fabriquée :
  l'horloge du serveur est utilisée.

La date obtenue passe ensuite par le garde-fou commun à tous les protocoles
(« Écart d'horloge admis », voir § Horodatage plus bas).

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

### IEC 61850 — quatre mécanismes

La norme couvre quatre façons très différentes de récupérer une donnée, et
elles ne se valent pas du tout en coût d'implémentation. Le mécanisme se
choisit sur le lien, et l'interface adapte ensuite ses champs toute seule.

| Mécanisme | Transport | Le mécanisme en un mot |
|---|---|---|
| **GOOSE** (8-1) | Ethernet 0x88B8, diffusé | l'IED crie, on écoute |
| **Sampled Values** (9-2) | Ethernet 0x88BA, diffusé | idem, à 4 000 trames/s |
| **Lecture MMS** | ISO sur TCP (port 102) | on demande, l'IED répond |
| **Rapports BRCB / URCB** | MMS | on s'abonne, l'IED notifie |

Les quatre sont implémentés, **sans aucune bibliothèque** : les piles C
matures d'IEC 61850 sont en double licence GPLv3 ou commerciale payante, donc
écartées par la règle du projet (voir § « Bibliothèques externes et
licences »). Aucune pile permissive en C n'existe. Tout est donc écrit ici, le
codec BER de SNMP servant de socle commun.

GOOSE et Sampled Values ont été les moins coûteux : trames diffusées, ni
session ni négociation. MMS a demandé la pile ISO complète — ISO-on-TCP
(RFC 1006), COTP, session, présentation, ACSE — soit cinq poignées de main
avant la première lecture, dont aucune ne transporte de donnée utile.

#### GOOSE

Un point désigne une entrée du jeu de données par son **indice**, celui que
fixe le fichier SCL ; les membres d'une structure comptent chacun pour une
entrée. Types décodés : booléen, chaîne de bits (qualité, position double),
entier signé, entier non signé, flottant IEEE. Tout autre type n'est pas
publié.

Deux repères du flux se lisent comme des variables ordinaires : **stNum**
(incrémenté à chaque événement) et **sqNum** (à chaque réémission). Un `sqNum`
figé trahit un IED muet — c'est souvent le premier symptôme visible d'une
panne de communication.

**Les trames marquées « simulation » sont refusées par défaut.** Elles
proviennent d'un injecteur de test, pas du procédé ; les publier comme des
mesures réelles serait exactement le piège à éviter en salle de conduite. Une
case permet de les accepter pour un essai délibéré. Un GOOSE marqué « needs
commissioning » est signalé dans l'état du lien.

#### Sampled Values

Convention **9-2LE**, la plus répandue : chaque ASDU porte huit voies de huit
octets — quatre courants (IA, IB, IC, IN) puis quatre tensions (UA, UB, UC,
UN) — chaque voie étant un entier signé 32 bits gros-boutiste suivi de sa
qualité sur 32 bits. Un point désigne donc une **ASDU** et une **voie**.

Une voie dont la qualité porte le bit « invalide » ne produit **aucun
échantillon**, comme le bit IV en IEC-104. `smpCnt` et `smpSynch` se lisent
comme des variables, pour surveiller la santé et la synchronisation du flux.

**Cadence** : à 4 000 trames par seconde, publier chaque échantillon
saturerait l'historique en quelques secondes. La décimation par la période du
point s'en charge, et seules les ASDU réellement demandées sont décodées.

#### Lecture MMS

Un point porte une **référence 61850** (`LD0/MMXU1.A.phsA.cVal.mag.f`) et sa
contrainte fonctionnelle. La traduction en nom MMS est faite à l'ouverture du
lien :

| | |
|---|---|
| domaine | `<nom d'IED>` + `<LD>` → `IED1LD0` |
| élément | `LN$FC$DO$DA$…` → `MMXU1$MX$A$phsA$cVal$mag$f` |

Les points échus partent groupés (16 au plus) dans une même requête `Read`.
Une référence illisible ou un objet refusé par l'IED est signalé dans l'état du
lien et ne publie rien, les autres points continuant d'être lus. Les valeurs
rendues sous forme de structure sont parcourues jusqu'à la première feuille
numérique — certains IED emballent `cVal.mag.f` de cette façon.

#### Rapports (BRCB et URCB)

L'IED notifie de lui-même, par `InformationReport`, au lieu d'être interrogé.
Un point désigne alors sa valeur par son **indice dans le jeu de données**.

Décoder un rapport suppose de décoder d'abord **OptFlds**, la chaîne de bits
qui annonce quels champs optionnels précèdent les données : numéro de séquence,
horodatage, nom du jeu, débordement de tampon, identifiant d'entrée, révision
de configuration, segmentation. Se repérer sur « la chaîne de bits » ne suffit
pas — OptFlds en est une aussi, et la confondre avec la chaîne d'inclusion fait
lire le numéro de séquence à la place de la première valeur. Le nombre de
membres inclus se lit dans la chaîne d'inclusion, et les références de données
qui la suivent sont sautées si OptFlds les annonce.

**Un bloc bufférisé (BRCB) conserve les rapports pendant une coupure** et les
rejoue à la reconnexion ; un URCB perd ce qui s'est produit hors ligne. Pour du
diagnostic, le bufférisé est le choix sûr.

##### La seule écriture de tout Diagweb

Activer un rapport suppose d'écrire dans son bloc de contrôle : `TrgOps` et
`IntgPd` d'abord — un bloc déjà actif refuse qu'on change ses conditions de
déclenchement — puis `RptEna`. C'est une **exception assumée** à la règle de
lecture seule, du même ordre que la requête SDO de CANopen :

- elle ne touche **que les attributs du bloc de rapport**, jamais une donnée de
  procédé ;
- elle n'a lieu que si l'utilisateur a choisi le mode « rapports » ;
- aucun service de commande n'est implémenté, et ne le sera pas.

#### Ce que GOOSE et SV exigent du système

Ces deux flux ne passent pas par IP : le serveur ouvre une socket de niveau 2
(`AF_PACKET`), ce qui demande la capacité **`CAP_NET_RAW`**. Sur le contrôleur,
elle se donne à l'unité systemd du serveur de diagnostic plutôt qu'en le
lançant en root :

```ini
[Service]
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
```

Sans elle, le lien tombe en défaut avec le motif — jamais en silence. Un
**filtre d'EtherType** est posé dans le noyau dès l'ouverture : sur un réseau
de poste chargé de Sampled Values, c'est la différence entre un serveur qui
respire et un serveur qui passe son temps en interruptions. L'**étiquette
VLAN** qu'ajoute presque tout commutateur de poste est franchie
automatiquement. Le mode **promiscuité** ne sert que derrière un port miroir.

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

L'option `opcua` vaut « auto » : Meson utilise une copie
d'open62541 déjà installée si `find_package` en trouve une — le cas d'un SDK
de contrôleur — et la récupère sinon par `FetchContent` sur la version épinglée
`DIAGWEB_OPCUA_TAG`. **La compilation croisée d'un produit ne devrait pas
dépendre d'un accès réseau** : fournir la bibliothèque dans le SDK est la voie
recommandée.

```bash
meson setup build -Dopcua=disabled            # sans OPC UA, hors ligne
meson setup build -Dopcua_encryption=true     # avec chiffrement (OpenSSL)
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
- **Rôle de maître CANopen**, et côté IEC 61850 : **émission** de GOOSE ou de
  Sampled Values (Diagweb écoute, il ne publie rien sur le réseau de poste),
  lecture du **fichier SCL** pour déduire les jeux de données — les indices et
  les références se saisissent à la main — **contrôle** (services de commande),
  **parcours** de l'arborescence MMS (GetNameList), **fichiers** (transfert de
  perturbographies) et **segmentation** des rapports volumineux.
- **Écriture et appel de méthode OPC UA** (`Write`, `Call`), **découverte**
  automatique de l'arborescence (`Browse`), **historique** (`HistoryRead`) et
  **événements** (`EventNotifier`). Les types non scalaires — tableaux,
  structures — ne sont pas convertis.
- **SNMP** : `SetRequest` (écriture), réception de **trappes** et
  d'`InformRequest` (Diagweb interroge, il n'écoute pas), parcours de MIB
  (`GetNext`, `GetBulk`) et résolution des noms symboliques — un OID se saisit
  en notation pointée, aucune MIB n'est chargée.

## Période, horodatage, qualité

- **Protocoles à interrogation** (Modbus, SDO, SNMP, lecture MMS, OPC UA en
  interrogation cyclique) : la période du point est la cadence
  d'interrogation. Une période courte sur une liaison lente sature
  l'équipement — le message d'erreur le dira, mais autant l'éviter.
- **Protocoles à flux** (IEC-104, CAN, GOOSE, Sampled Values, rapports,
  abonnement OPC UA) : la période sert de **décimation**. Tout changement de
  valeur passe malgré tout, pour ne jamais masquer une transition.
- **Qualité** : bit IV en IEC-104, qualité invalide d'une voie Sampled Values,
  `StatusCode` mauvais en OPC UA, exception Modbus, `noSuchObject` SNMP, abandon
  SDO, lien coupé ⇒ **aucun échantillon publié** (trou franc dans la courbe), la
  cause restant lisible dans l'état du lien.

### Horodatage : à la source, ou du serveur

Un événement se produit à un instant, et il arrive à un autre. Sur un réseau
chargé, ou derrière une passerelle, l'écart se compte en centaines de
millisecondes — assez pour inverser l'ordre apparent de deux causes. Quand le
protocole transporte la date de l'événement, c'est **elle** qui est retenue.

| Protocole | Horodatage à la source ? |
|---|---|
| IEC 60870-5-104 | oui, types horodatés (`CP56Time2a`) : 30, 31, 32, 34, 35, 36, 37 |
| IEC 61850 GOOSE | oui, champ `t` (dernier changement d'état) |
| IEC 61850 Sampled Values | oui, `refrTm` |
| IEC 61850 rapports | oui, `TimeOfEntry`, si le bloc l'annonce dans `OptFlds` |
| OPC UA | oui en **abonnement** (`SourceTimestamp`) ; non en interrogation cyclique |
| SNMP | pas par le protocole, mais par la **MIB** : OID d'horodatage compagnon (`DateAndTime` ou `TimeTicks`) déclaré sur le point |
| Modbus, CAN, J1939, CANopen, lecture MMS | non : le protocole n'en transporte pas |

**Le choix se fait point par point** — champ « Horodatage » de chaque point :

- **De l'équipement si disponible** (défaut) — la date du protocole, quand il y
  en a une ; l'horloge du serveur sinon.
- **Du serveur (forcé)** — ignorer délibérément la date du protocole. À choisir
  quand l'horloge de l'équipement n'est pas de confiance : c'est fréquent sur
  un matériel ancien ou mal synchronisé, et une date fausse est pire qu'une
  date approximative.

#### Comment la date est ramenée dans la base de temps du serveur

Les échantillons de Diagweb sont datés sur l'horloge du serveur, pour que
toutes les courbes restent comparables — y compris avec les variables internes
du `controller`. Une date d'équipement n'est donc **pas recopiée** : c'est son
**écart** à l'heure courante qui est appliqué. Un événement daté 300 ms dans le
passé se range 300 ms avant l'instant présent, quelle que soit l'origine de
temps de l'équipement.

**Garde-fou.** Au-delà de l'« écart d'horloge admis » du lien (10 s par
défaut), la date de l'équipement est écartée et celle du serveur utilisée, avec
un message dans l'état du lien. Sans ce garde-fou, un équipement dont l'horloge
est fausse de deux heures placerait ses échantillons hors de toute fenêtre
visible — ce qui se lit comme **une variable morte alors qu'elle remonte très
bien**, et fait chercher la panne au mauvais endroit.

**Ordre chronologique.** Les horodatages source peuvent arriver dans le
désordre — rafale IEC-104, rapport groupé. L'historique s'appuyant sur une
recherche dichotomique, un échantillon inséré hors séquence la fausserait :
il est donc rangé à sa place, en ne remontant que d'une fenêtre bornée
(64 échantillons). Au-delà, il est trop vieux pour l'historique et il est
écarté plutôt que de désordonner le tampon.

**Journalisation.** Le journal autonome écrit l'horodatage retenu, source
comprise : c'est le sens de tout ce mécanisme — une campagne enregistrée porte
l'heure des événements, pas celle de leur transmission.

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
| [Net-SNMP](https://github.com/net-snmp/net-snmp) | SNMP v3 (USM) | C | BSD (CMU/UCD et consorts, aucune clause GPL) | **retenue et intégrée** |
| [S2OPC](https://gitlab.com/systerel/S2OPC) | OPC UA | C | Apache-2.0 | acceptable — solution de repli, orientée sûreté |
| [libiec61850](https://github.com/mz-automation/libiec61850) | IEC 61850 (MMS, GOOSE, SV) | C99 | GPLv3 **ou** licence commerciale payante | **écartée** |
| [lib60870](https://github.com/mz-automation/lib60870) | IEC 60870-5-101/104 | C | GPLv3 **ou** licence commerciale payante | écartée, et sans objet |
| IEC61850bean | IEC 61850 | Java | Apache-2.0 annoncée, non vérifiée | hors périmètre : demande une JVM |

Quatre conséquences, dont une désagréable.

**OPC UA — intégrée.** C'était le seul protocole du lot où l'écriture à la
main était disproportionnée : UA-TCP, SecureConversation avec renouvellement de
jetons, encodage binaire de tous les types intégrés, puis les services de
session, de lecture et d'abonnement. open62541 couvre l'ensemble sous MPL-2.0,
qui autorise explicitement la combinaison avec du logiciel propriétaire —
seules les modifications apportées à ses propres fichiers devraient être
publiées, ce qui ne concerne pas le code de Diagweb. Version épinglée v1.5.6,
licence vérifiée dans son fichier `LICENSE`. Elle se débranche par
`-DDIAGWEB_WITH_OPCUA=OFF`.

**SNMP v3 — intégrée.** Même raisonnement, pour une raison plus étroite : USM
est du **code cryptographique**, et l'écrire soi-même sans pouvoir l'éprouver
contre l'existant serait la mauvaise décision, quel que soit le soin apporté.
Net-SNMP est sous licences BSD (fichier `COPYING` vérifié : aucune occurrence de
« General Public License »), et ne sert **que** v3 : v1 et v2c restent servies
par l'implémentation interne, sans dépendance. Elle se débranche par
`-DDIAGWEB_WITH_NETSNMP=OFF`, auquel cas v3 s'annonce « non branché ».

**IEC 61850 — écrit à la main, faute de licence acceptable.** Toutes les piles
C matures sont en double licence GPLv3 / commerciale : gratuites tant que le
produit est lui-même GPL, payantes sinon. Aucune pile permissive en C n'existe.
Les quatre mécanismes ont donc été écrits dans le projet, y compris la pile ISO
sous MMS. Le codec BER de SNMP a servi de socle commun, ce qui a rendu
l'ensemble raisonnable.

**Réserve à connaître** : cette pile est validée contre un IED simulé
(`tests/mms_ied.mjs`), pas contre un équipement du commerce. Elle prouve que ce
que Diagweb émet est analysable et que ce qu'il décode a la forme attendue ;
l'interopérabilité réelle demande un essai sur site, et c'est là que se
révéleront les écarts d'implémentation propres à chaque constructeur.

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
meson test -C build --suite serveur    # décodage, liens réseau, forçage
node tests/protocols.mjs        # serveur de diagnostic en fonctionnement
```

`tests/decode.cpp` couvre le décodage (champs de bits Intel/Motorola, PGN
J1939, codec BER/ASN.1 de SNMP — y compris les longueurs qui débordent du
tampon reçu — grammaire `@lien.point`, lecture de la configuration) **et** les
filtres
noyau des trois pilotes CAN, ainsi que leur appariement de trames — un filtre
trop large ou trop étroit rendrait une variable silencieusement muette. Les
quatre formats de date s'y vérifient **sur le même instant** (`CP56Time2a`,
`UtcTime` et `BinaryTime` d'IEC 61850, `DateAndTime` de SNMP) : chacun sert de
contre-épreuve aux autres.

`tests/protocols.mjs` monte un **esclave Modbus TCP**, une **station
IEC 60870-5-104**, un **agent SNMP v2c** et un **IED IEC 61850** (pile ISO,
association MMS, service Read, activation de bloc de rapport et émission
d'`InformationReport`) en Node, configure les liens par
REST et vérifie que les
valeurs arrivent jusqu'au flux WebSocket.

Deux équipements ne sont pas simulés, parce qu'ils ne peuvent pas l'être
honnêtement :

- un **serveur OPC UA** (`tests/opcua_server.c`, cible
  `diagweb-opcua-test-server`) — abonnement, interrogation cyclique, conversion
  des types, refus des chaînes, et refus d'ouvrir un lien chiffré sur un serveur
  compilé sans chiffrement ;
- un **agent SNMP réel** (`snmpd` de Net-SNMP, lancé par le test sur un port
  libre avec sa propre configuration) — v1, v2c et **v3 authPriv** de bout en
  bout : découverte du moteur, clés dérivées des phrases secrètes lues dans
  l'environnement du serveur, authentification SHA-1 et chiffrement AES-128.
  Le test vérifie aussi qu'un lien v3 **sans secret refuse de s'ouvrir**, et
  que l'horodatage par OID compagnon fonctionne dans les deux formes
  (`DateAndTime` sur l'agent simulé, avec une date volontairement placée dans le
  passé ; `hrSystemDate` et `TimeTicks` sur l'agent réel).

L'absence de l'un ou l'autre n'est pas passée sous silence : les vérifications
concernées échouent en disant ce qui manque. Les pilotes CAN, eux, ne sont pas
couverts de bout en bout faute d'interface CAN dans l'environnement de test :
seuls leur décodage, leurs filtres et leur appariement le sont.
