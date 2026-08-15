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
 │  filtres : Toutes · PLC · Modbus · Matlab · Réseau                │
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
   Sur un **poste de développement** (Codespace, machine locale), ces champs
   partent déjà remplis avec les coordonnées des serveurs de test qui tournent
   là — voir « Le formulaire part déjà rempli », plus bas.
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
  « toutes »), puis le champ de bits. Les PGN de plus de 8 octets (DM1,
  configuration moteur) sont **réassemblés** par le protocole de transport de
  J1939-21 : BAM en écoute strictement passive, RTS/CTS seulement pour un lien
  qui réclame déjà des PGN — y répondre impose d'émettre un CTS, donc de
  parler sur le bus (voir « Messages multi-trames » plus bas). Le filtrage
  noyau porte sur le PGN et jamais sur l'adresse source, qui change à chaque
  re-revendication.
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
lire le numéro de séquence à la place de la première valeur. Les références de
données qui suivent la chaîne d'inclusion sont sautées si OptFlds les annonce.

**Un rapport ne porte que ce qui a changé**, et c'est le piège du mécanisme :
la chaîne d'inclusion ne dit pas seulement *combien* de membres sont présents,
elle dit *lesquels*. Le rang d'une valeur dans le rapport n'est donc pas son
indice dans le jeu de données. Sur un jeu de dix membres dont seul le septième
change, le rapport porte une valeur, et la ranger au rang 0 la publierait sur
la première variable du jeu — un courant affiché comme une position de
disjoncteur, sans le moindre message d'erreur. Seuls un rapport d'intégrité et
une interrogation générale, qui incluent tout, font coïncider rang et indice —
ce qui rend l'erreur invisible tant qu'on ne l'éprouve pas sur un rapport
partiel.

**Un bloc bufférisé (BRCB) conserve les rapports pendant une coupure** et les
rejoue à la reconnexion ; un URCB perd ce qui s'est produit hors ligne. Pour du
diagnostic, le bufférisé est le choix sûr.

**Une interrogation générale est lancée juste après l'activation** (`GI`), pour
la même raison qu'en IEC-104 : sans elle, un point resterait vide jusqu'au
premier changement de sa donnée — sur une installation calme, cela peut durer
des heures, et une variable muette se lit comme une variable en panne. Le bit
d'interrogation générale est donc toujours posé dans `TrgOps`, en plus de la
condition choisie ; c'est lui qui autorise la demande. Un IED qui ignore le
`GI` reste utilisable : ses points partent simplement du premier changement.

##### La seule écriture de tout Diagweb

Activer un rapport suppose d'écrire dans son bloc de contrôle, et **l'ordre
compte** : `RptEna` à faux d'abord — un bloc en service refuse qu'on change ses
conditions de déclenchement, et un BRCB laissé actif par une session
précédente est le cas courant, pas l'exception —, puis `TrgOps` et `IntgPd`,
puis `RptEna` à vrai, et enfin `GI`. C'est une **exception assumée** à la règle
de lecture seule, du même ordre que la requête SDO de CANopen :

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

L'option `opcua` vaut « auto » : Meson cherche open62541 **sur le système**,
par `pkg-config`, et rien d'autre — la bibliothèque n'est jamais téléchargée
pendant la construction. **La compilation croisée d'un produit ne devrait pas
dépendre d'un accès réseau** : fournir la bibliothèque dans le SDK du
contrôleur est la voie recommandée. Absente, le pilote redevient « déclaré »
et ne publie rien, sans que la construction échoue.

```bash
meson setup build -Dopcua=disabled            # sans OPC UA, hors ligne
meson setup build -Dopcua=enabled             # échec net si open62541 manque
meson setup build -Dopcua_encryption=true     # exige un open62541 avec OpenSSL
```

Pour une copie installée hors des chemins standard, indiquer son
`pkgconfig` :

```bash
PKG_CONFIG_PATH=$HOME/.local/open62541/lib/pkgconfig meson setup build
```

À `disabled`, le serveur se construit sans aucune dépendance et le pilote redevient
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
l'heure des événements, pas celle de leur transmission. Quand l'équipement a
fourni une date, elle est **aussi** conservée telle quelle (colonne
`horodatage_source_iso`) : le fichier téléchargé montre les deux, celle
retenue pour la chronologie et celle que l'équipement affirme — y compris
quand le garde-fou l'a écartée.

**Grille des périodes.** Les échantillons **sans** date d'équipement — points
réglés « du serveur », protocoles qui n'en transportent pas — sont calés sur
la **grille de la période du point** : les multiples de la période dans
l'horloge du serveur, donc des secondes entières dès que la période divise la
seconde. Les interrogations elles-mêmes sont cadencées sur cette grille
(échéance `next_poll_due`), et l'horodatage publié est l'instant de grille —
jamais antidaté au-delà d'une transition déjà publiée. Deux points de même
période portent ainsi le **même** horodatage, et le journal téléchargé trié
par horodatage les range sur **une seule ligne** au lieu de deux en
quinconce. Les variables internes du contrôleur suivent la même règle. Un
échantillon daté par l'équipement, lui, garde sa date : un événement n'a pas
à tomber juste.

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
- **Lecture MMS** : la réponse est appariée à sa requête par l'**identifiant
  d'invocation**, comme en Modbus et pour la même raison. Une réponse retardée,
  ou un rapport spontané glissé entre la demande et la réponse, décalerait
  sinon le flux durablement : chaque lot de valeurs se poserait sur les points
  du lot suivant, sans qu'aucune erreur ne le signale. Un PDU dont
  l'identifiant ne correspond pas est écarté, et l'attente reprend jusqu'au
  délai du lien.

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

Trois moyens, qui ne prouvent pas la même chose.

| Moyen | Réseau | Protocoles | Ce qu'il apporte |
|---|---|---|---|
| `--sim-protocols` | **aucun** | tous, en trompe-l'œil | l'interface et les courbes ; les pilotes ne travaillent pas |
| `node tools/bench.mjs` | vraies sockets | les six | les pilotes au travail contre les équipements des tests, en une commande |
| `build/diagweb-simulator` | vraies sockets | Modbus TCP (puis les autres) | un **équipement** décrit en JSON : registres, unités, exceptions |

### Sans aucune trame — `--sim-protocols`

```bash
./build/diagweb-server --port 8080 --root . --sim-protocols
```

`--sim-protocols` remplace tous les pilotes par un générateur : les liens
passent à l'état « simulé » et les points produisent des signaux plausibles.
Utile pour préparer une configuration ou faire une démonstration ; l'état du
lien dit clairement que les valeurs ne viennent pas du terrain.

### Banc d'essai — les pilotes travaillent pour de vrai

```bash
node tools/bench.mjs          # monte le banc, reste au premier plan
node tools/bench.mjs --stop   # retire les liens du banc
```

Deux choses très différentes, à ne pas confondre :

| | Réseau | Ce qui est éprouvé |
|---|---|---|
| `--sim-protocols` | **aucun** | rien du pilote : les valeurs naissent dans le serveur |
| `tools/bench.mjs` | **vraies sockets** | encodage, trames, délais, exceptions, horodatage |

Le banc monte les équipements simulés de `tests/devices.mjs` — les mêmes que
les tests de bout en bout, mais sur des ports fixes et pour longtemps :

| Équipement | Transport | Port | Norme |
|---|---|---|---|
| Esclave Modbus TCP | TCP | 15020 | 502 |
| Station IEC 60870-5-104 | TCP | 12404 | 2404 |
| Agent SNMP v1/v2c simulé | UDP | 11161 | 161 |
| Agent SNMP v3 réel (`snmpd`) | UDP | 11162 | 161 |
| IED IEC 61850 (MMS) | TCP | 10102 | 102 |
| Serveur OPC UA (open62541) | TCP | 14840 | 4840 |

Les ports sont décalés **volontairement** : 502, 102 et 161 sont privilégiés
(< 1024) et l'utilisateur d'un Codespace n'est pas root. Un lien vise le port
qu'on lui donne, la démonstration est identique.

Le banc ne possède que ses propres liens, préfixés `banc-` : les liens créés à
la main sont relus, conservés et remis en place. Un banc d'essai n'efface
jamais une configuration d'exploitation.

SNMP v3 demande que le **serveur** porte les phrases secrètes dans son
environnement — jamais dans la configuration :

```bash
export DIAGWEB_SECRET_AGENT_AUTH=motdepasseauth
export DIAGWEB_SECRET_AGENT_PRIV=motdepassepriv
```

Sans elles, le lien v3 refuse de s'ouvrir : jamais de repli en clair. `snmpd`
ou `diagweb-opcua-test-server` absent — ou démarré puis mort aussitôt, ce que
le banc vérifie en interrogeant le port et non le lancement — le lien
correspondant est posé **désactivé** et le banc le dit. Aucune valeur inventée.

Trois choses à savoir avant de s'étonner :

- **Ouvrir la page servie par le serveur lui-même** (`/web/index.html` sur son
  port), et non l'Artifact ni GitHub Pages : ces deux-là n'ont aucun serveur
  derrière eux et afficheront tout en « simulé ».
- **Recharger l'onglet** s'il était déjà ouvert. L'interface ne lit la
  configuration des liens qu'au chargement ; sans rechargement le banc y est
  invisible, et un enregistrement depuis ☰ → « Liens réseau » réécrirait la
  configuration **sans** ses liens.
- `PUT /api/protocols` réapplique la configuration **entière** : les liens de
  l'exploitant sont conservés, mais brièvement rouverts, et l'historique des
  points réseau repart de zéro.

Tous les équipements écoutent sur `127.0.0.1` — y compris le serveur OPC UA,
qui s'annonçait local sans l'être tant que `serverUrls` n'était pas renseigné.
Rien n'est donc exposé au réseau, même si le port du serveur de diagnostic est
rendu public.

### Simulateur d'équipements — un équipement, décrit et configurable

```bash
./build/diagweb-simulator --port 5020 --list   # ce qu'il expose
./build/diagweb-simulator --port 5020          # écoute (502 par défaut)
./build/diagweb-server --port 8080 --root .
```

`diagweb-simulator` est le **second exécutable** du dépôt (`simulator/`,
C++23) : là où le banc monte les équipements des tests pour voir vivre
l'interface, celui-ci simule **un équipement** qu'on décrit — table de
registres, unités Modbus multiples, lois de mouvement, exceptions sur adresse
hors table — et qui sert le port **502** comme un automate. Lecture seule
comme le reste de Diagweb : les fonctions d'écriture reçoivent « fonction non
gérée ». Il est écrit d'après la spécification, sans
rien connaître du pilote : chacun sert donc de contre-épreuve à l'autre.

Il ne sert aujourd'hui que Modbus TCP ; SNMP, OPC UA et IEC 61850 viendront
comme autant de **façades** sur les mêmes signaux. Configuration, table des
registres et détails : `docs/SIMULATEUR.md`.

### Le formulaire part déjà rempli

Un lien **neuf** porte d'emblée les coordonnées du serveur de test local, quand
la page vient d'un poste de développement — `localhost`, un Codespace, ou un
fichier ouvert directement :

| Protocole | Pré-rempli | Servi par |
|---|---|---|
| Modbus TCP | `127.0.0.1:5020`, unité 1 | `diagweb-simulator` |
| IEC 60870-5-104 | `127.0.0.1:12404`, ASDU 1 | `tools/bench.mjs` |
| SNMP | `127.0.0.1:11161`, v2c, communauté `public` | `tools/bench.mjs` |
| IEC 61850 | `127.0.0.1:10102`, lecture MMS, IED `IED1` | `tools/bench.mjs` |
| OPC UA | `opc.tcp://127.0.0.1:14840` | `tools/bench.mjs` |

C'est exactement ce qu'on aurait tapé à la main, et une adresse tapée à la main
se trompe. Une mention sous les champs annonce le pré-remplissage et
**disparaît dès qu'un champ s'écarte** du banc : elle ne peut donc pas finir
par désigner une adresse qui n'est plus la sienne.

**Ailleurs, rien n'est pré-rempli** — contrôleur en exploitation, page publique,
Artifact. Un `127.0.0.1` proposé par défaut sur une installation ferait chercher
la panne au mauvais endroit. Les protocoles sans serveur de test local (Modbus
RTU, CAN, J1939, CANopen) ne proposent rien nulle part.

Les ports vivent dans `web/js/protocols.js` et sont tenus en phase avec ceux que
le banc ouvre réellement par `tools/check-drivers.mjs` : un port qui dérive d'un
côté donnerait un lien pré-rempli qui ne se connecte pas, sans dire pourquoi.

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
`-Dopcua=disabled`.

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
node tests/simulator.mjs        # idem, contre le simulateur d'équipements
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

L'IED simulé est écrit d'après la norme, pas d'après le pilote, et **tient
l'état de son bloc de rapport** : il n'émet sur changement que si `TrgOps`
porte réellement le bit *data-change*, ne répond à l'interrogation générale que
si le bit correspondant y est, et alterne rapports **complets** et **partiels**
— ces derniers ne portant qu'un seul membre du jeu. Un client qui se décale
d'un bit dans `TrgOps` n'obtient donc rien du tout, et un client qui range les
valeurs par leur rang plutôt que par la chaîne d'inclusion publie la mauvaise
variable : les deux erreurs échouent au test au lieu de n'apparaître que sur
site.

`tests/simulator.mjs` fait le même trajet contre le **simulateur d'équipements**
(`docs/SIMULATEUR.md`), et vaut mieux qu'un bouchon : les deux moitiés du
dialogue Modbus sont écrites séparément — le maître dans `drivers/modbus/`,
l'esclave dans `simulator/` — d'après la spécification, et chacune sert de
contre-épreuve à l'autre. Un bouchon qui renvoie ce que le pilote attend ne
prouve pas cela.

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

### Éprouver les liens en conteneur

Codespaces, Docker, intégration continue : le même classement s'applique
partout, et il tient à ce que le noyau accorde au conteneur.

| Ce qui est éprouvé | Ce qu'il faut |
|---|---|
| Décodage des 13 protocoles (`diagweb-decode-test`) | rien |
| Modbus TCP, IEC 60870-5-104, SNMP v1/v2c, IEC 61850 MMS et rapports | rien — équipements simulés sur `127.0.0.1` |
| SNMP v3 (USM) | `libsnmp-dev` et `snmpd` |
| OPC UA | `open62541` (voir « Compilation » plus haut) |
| Modbus RTU | `socat` (paire de pty), parité `none` |
| GOOSE, Sampled Values, LLDP, capture | `CAP_NET_RAW` |
| CAN, J1939, CANopen | interface `vcan` — donc `CAP_NET_ADMIN` |

Les protocoles IP n'exigent **aucun privilège** : rien n'écoute sous le port
1024, et chaque équipement simulé prend un port libre attribué par le système.

Le jeu de capacités par défaut d'un conteneur comprend `CAP_NET_RAW` mais pas
`CAP_NET_ADMIN` ; un devcontainer les demande par `runArgs` (voir
`.devcontainer/devcontainer.json`).

**La capture demande une manipulation de plus, et c'est celle qu'on oublie.**
Le conteneur a beau avoir `CAP_NET_RAW`, le serveur de diagnostic y tourne sous
l'utilisateur du conteneur (`vscode`), qui ne l'a pas — et il ne pourrait pas
la transmettre même s'il l'avait : un `exec` **jette** les capacités du
processus, sauf si elles sont **ambiantes** (`AmbientCapabilities=`, la voie
retenue sur le contrôleur) ou portées par le binaire lancé. Ubuntu ne pose
aucune capacité fichier sur `tcpdump` : chaque capture échoue donc sur
« *You don't have permission…* / *(socket: Operation not permitted)* ». La
capacité se donne **au binaire**, une fois :

```bash
sudo setcap cap_net_raw+ep "$(command -v tcpdump)"   # la capture repart aussitôt
```

`.devcontainer/cap-tcpdump.sh` le fait à la création du Codespace (et le
réaffirme à `postCreate`, un prebuild pouvant ne pas avoir gardé l'attribut
étendu). `cap_net_raw` **seule** : une capacité fichier hors du jeu limite du
conteneur — `cap_net_admin`, typiquement — ferait échouer l'`execve` **avant**
d'ouvrir la moindre socket, y compris sous `sudo`, et sans un mot
d'explication ; `sudo setcap -r /usr/bin/tcpdump` lève alors le blocage.

Ces deux impasses sont diagnostiquées par le serveur lui-même : la page
« Capture d'interfaces réseau » affiche la raison **et** la commande qui
débloque, avant même le premier essai (`privilege` de `/api/capture`).

La capacité ne suffit pas pour `vcan` : le module doit exister dans le noyau
de l'**hôte**, ce qu'aucun privilège ne remplace. La sonde tient en une ligne,
et ses trois réponses se distinguent :

```bash
ip link add dev vcan0 type vcan
#   « Operation not permitted »  → il manque CAP_NET_ADMIN
#   « Unknown device type »      → noyau hôte sans vcan : rien à tenter
#   (silence)                    → ip link set up vcan0, puis can-utils
```

Sans bus, les trois pilotes CAN échouent en le disant — « socket CAN
impossible », « interface introuvable » — et ne publient jamais de valeur
inventée. Le lien GOOSE des tests vise volontairement une interface
inexistante : la suite passe donc en entier **sans** `CAP_NET_RAW`, et la
capacité ne sert qu'à décoder de vraies trames.
