# Simulateur d'équipements

`diagweb-simulator` est le **second exécutable** du dépôt. Le `controller`
produit les variables internes, le serveur de diagnostic les relaie et
interroge le réseau ; le simulateur, lui, joue le rôle des **équipements
tiers** que le serveur de diagnostic lit.

```
┌──────────────────────────── même machine, ou deux ────────────────────────────┐
│                                                                               │
│  diagweb-simulator ──── Modbus TCP ───▶ serveur de diagnostic ──▶ navigateur   │
│  (équipement simulé)     port 502        (pilotes réels)          (courbes)    │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Pourquoi un processus séparé

Le dépôt sait déjà travailler sans matériel de deux façons, et aucune ne répond
à la même question :

| Moyen | Ce qu'il prouve | Sa limite |
|---|---|---|
| `diagweb-server --sim-protocols` | l'interface et les courbes | **aucune trame** n'est émise : les pilotes ne sont pas exercés |
| `node tools/bench.mjs` (équipements de `tests/devices.mjs`) | les pilotes, sur **six** protocoles à la fois | équipements des tests : peu de registres, rien à décrire, tout en Node |
| **`diagweb-simulator`** | les pilotes, sur un **équipement décrit** qui se comporte comme du vrai | un seul protocole pour l'instant ; et ce n'est pas du matériel |

Les deux derniers sont complémentaires, et le choix est simple : pour voir vivre
l'interface sur tous les protocoles en une commande, `tools/bench.mjs` ; pour
travailler **un équipement** — sa table de registres, ses unités, ses exceptions,
son port 502 — le simulateur.

Trois usages en découlent : **démontrer** Diagweb avec des valeurs qui bougent,
**mettre au point** un pilote contre une implémentation écrite d'après la
spécification et non contre l'écho de ses propres requêtes, et **préparer** une
configuration de liens avant d'aller sur l'installation.

## Un modèle de données, plusieurs façades

Un **signal** est une grandeur animée — une pression, une vitesse, un état — et
rien d'autre. La façon dont il apparaît sur le réseau (registre Modbus
aujourd'hui, OID SNMP ou nœud OPC UA demain) est déclarée **à côté** de lui et
ne change jamais la manière dont la valeur est produite.

```
signal « pression » : sinusoïde 3,5 bar ± 0,4
      │
      ├── modbus : registre de maintien 40, uint16, gain 0,1
      ├── snmp   : (à venir)
      └── opcua  : (à venir)
```

C'est ce qui rend l'étape suivante bon marché : un protocole de plus est une
**façade** de plus au-dessus des mêmes signaux, pas un second simulateur.

| Protocole | État | Fichier |
|---|---|---|
| Modbus TCP (esclave) | implémenté | `simulator/src/modbus_tcp.hpp` |
| SNMP (agent v1/v2c) | à venir | — |
| OPC UA (serveur) | à venir — open62541 fournit aussi la pile serveur | — |
| IEC 61850 (IED : MMS, rapports, GOOSE) | à venir — la pile ISO existe déjà côté client | — |

Les lois de mouvement sont celles du simulateur de l'interface
(`web/js/sim.js`) et de la source simulée du serveur (`server/src/sim_source.hpp`) :
une courbe se reconnaît d'où qu'elle vienne.

## Lancer

```bash
meson compile -C build
./build/diagweb-simulator --port 5020        # port libre, aucun privilège
./build/diagweb-simulator                    # port 502 (privilège requis)
```

| Option | Rôle |
|---|---|
| `--port <n>` | port d'écoute — **502** par défaut, `0` pour un port libre attribué par le système |
| `--bind <ip>` | adresse d'écoute (`0.0.0.0` par défaut) |
| `--config <fichier>` | configuration JSON des équipements |
| `--latency-ms <n>` | retard ajouté à chaque réponse — pour éprouver le délai d'attente du maître |
| `--list` | affiche la table des registres, puis quitte |
| `--print-config` | écrit la configuration interne, puis quitte |
| `--quiet` | n'affiche pas les connexions |

**Le port 502 demande un privilège**, comme tout port sous 1024. Deux voies,
et le message d'erreur les rappelle :

```bash
sudo setcap cap_net_bind_service=+ep build/diagweb-simulator   # une seule fois
./build/diagweb-simulator --port 5020                          # ou un port libre
```

En service systemd, la capacité se donne à l'unité plutôt qu'au binaire :

```ini
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

`--list` répond à la seule question qui se pose ensuite — *que saisir dans
Diagweb ?* :

```
Groupe hydraulique — unité 1 (banc)
  fn  adresse  type       gain  unité       valeur  signal
  03  40       uint16      0.1  bar            3.5  pression — Pression circuit A
  03  10       float32       1  m3/h          12.6  debit — Débit refoulement
  01  0        bit           1                   1  pompe — Pompe en marche
```

## Configurer les équipements

Sans `--config`, le simulateur monte deux équipements internes : un **groupe
hydraulique** (unité 1) et un **compteur d'énergie** (unité 2), tous deux sur le
même port — comme derrière une passerelle. Pour partir de là :

```bash
./build/diagweb-simulator --print-config > mon-equipement.json
./build/diagweb-simulator --config mon-equipement.json --list
```

```json
{
  "version": 1,
  "devices": [
    {
      "id": "banc",
      "label": "Groupe hydraulique",
      "modbus": { "unitId": 1, "coils": 16, "discrete": 16, "holding": 100, "input": 32 },
      "signals": [
        { "id": "pression", "label": "Pression circuit A", "unit": "bar",
          "gen": { "kind": "sine", "base": 3.5, "amp": 0.4, "periodS": 30, "noise": 0.02 },
          "modbus": { "area": "holding", "addr": 40, "type": "uint16", "gain": 0.1 } }
      ]
    }
  ]
}
```

### Lois de mouvement (`gen`)

| `kind` | Champs | Ce que ça produit |
|---|---|---|
| `const` | `value` | une valeur figée |
| `ramp` | `base`, `rate`, `modulo` | une pente (index d'énergie, compteur horaire) |
| `sine` | `base`, `amp`, `periodS`, `noise` | une sinusoïde bruitée |
| `walk` | `base`, `step`, `min`, `max`, `drift` | une marche aléatoire bornée (température) |
| `steps` | `values`, `periodS`, `noise` | des paliers tirés d'une liste |
| `square` | `periodS`, `duty` | un créneau |
| `bits` | `onS`, `offS` | un état booléen qui bascule |
| `counter` | `rate` | un compteur 16 bits qui reboucle |
| `jitter` | `base`, `noise`, `spikeP`, `spikeAmp` | du bruit avec des pointes |

Un signal **sans `gen`** n'est pas animé : sa cellule reste **libre**, un maître
peut y écrire, et la valeur y reste (`initial` fixe son point de départ). C'est
ainsi qu'on obtient une consigne ou une commande manipulable depuis un outil
tiers.

### Adressage Modbus (`modbus`)

| Champ | Valeurs | Défaut |
|---|---|---|
| `area` | `coils` (fn 01), `discrete` (fn 02), `holding` (fn 03), `input` (fn 04) | `holding` |
| `addr` | adresse **protocole**, à partir de 0 | — |
| `type` | `bool`, `int16`, `uint16`, `int32`, `uint32`, `float32`, `float64` | `uint16` |
| `wordOrder` | `big` (poids fort d'abord) ou `little` | `big` |
| `gain`, `offset` | ceux que **le maître** appliquera : `valeur = brut × gain + offset` | `1`, `0` |

La configuration est donc écrite en **unités physiques** et le registre porte la
valeur **brute** : `3,5 bar` avec un gain de `0,1` se lit `35` sur le fil, ce que
donnerait un équipement réel. Le simulateur sature aux bornes du type plutôt que
de replier la valeur — un dépassement se voit à l'écran au lieu de fabriquer une
mesure absurde.

**Taille des zones** : celle demandée dans `modbus`, jamais moins que ce que les
signaux occupent. Au-delà, l'équipement répond une exception 02, comme un vrai —
et c'est voulu : une table trouée fait partie de ce qu'il faut savoir gérer.

Une faute de frappe n'est jamais avalée en silence : identifiant invalide, zone
inconnue, type inconnu, loi inconnue, unité en double — chacun sort un
avertissement au démarrage, et le signal fautif n'est **pas** exposé.

## Ce que sert le protocole

Fonctions de lecture **01, 02, 03, 04** et d'écriture **05, 06, 15, 16**.

- **Écritures** : elles n'existent que pour manipuler l'équipement depuis un outil
  tiers. Diagweb, lui, n'écrit jamais sur un lien réseau (voir
  `docs/PROTOCOLES.md`). Une écriture visant une cellule **animée** est refusée
  (exception 02) plutôt qu'acceptée puis défaite 50 ms plus tard par le
  rafraîchissement : un maître qui relit sa propre valeur ne doit pas la voir
  disparaître sans explication.
- **Exceptions** : `01` fonction non gérée · `02` adresse hors table ou cellule
  animée · `03` quantité ou valeur refusée (0 registre, plus de 125, compte
  d'octets incohérent) · `0B` unité inconnue, comme une passerelle dont la cible
  reste muette.
- **Unités** : plusieurs équipements écoutent sur le même port. Les unités `0`
  et `255` — celles qu'un maître emploie faute de mieux — sont servies par le
  premier équipement ; une unité inconnue reçoit `0B` plutôt que les registres
  d'un autre.
- **Découpage TCP** : plusieurs requêtes dans un même segment sont toutes
  servies, une trame incomplète attend la suite. Un identifiant de protocole
  étranger ou une longueur impossible **ferment** la liaison — resynchroniser un
  flux d'octets à l'aveugle est le meilleur moyen de répondre ensuite à côté.
- **Plusieurs maîtres** simultanés : un fil par connexion, une image partagée.

## Brancher Diagweb dessus

```bash
./build/diagweb-simulator --port 5020 &
./build/diagweb-server --port 8080 --root .
```

Puis, dans la page (**☰ → Liens réseau…**) : nouveau lien **Modbus TCP**,
identifiant `banc`, hôte `127.0.0.1`, port `5020`, unité `1` ; **Tester** ; puis
un point `pression` — fonction 03, registre 40, `uint16`, gain 0,1, unité `bar`.
L'adresse Diagweb est alors `@banc.pression`. C'est l'exemple complet de
`docs/PROTOCOLES.md`, jouable sans matériel.

## Tests

| Test | Ce qu'il éprouve |
|---|---|
| `tests/simulator.cpp` (`meson test --suite serveur`) | trames MBAP, exceptions, bornes, encodage des types, lecture de la configuration |
| `tests/simulator.mjs` | le serveur de diagnostic lisant le simulateur, jusqu'au flux WebSocket |

Le second est celui qui compte : les deux moitiés du dialogue sont écrites
séparément — le maître dans `server/src/drivers/modbus/`, l'esclave dans
`simulator/src/` — chacune d'après la spécification, et chacune sert de
contre-épreuve à l'autre.

Il ne remplace pas `tests/protocols.mjs` : l'esclave de `tests/devices.mjs`
couvre d'autres cas (registres connus à la valeur près, table trouée) et cinq
autres protocoles. Deux esclaves indépendants valent mieux qu'un — s'ils
divergent, l'un des deux a tort, et c'est précisément ce qu'on veut apprendre
avant d'être sur site.

**Réserve à connaître**, la même que pour la pile IEC 61850 : un simulateur
valide la cohérence de notre lecture, pas l'interopérabilité avec un équipement
du commerce. Les écarts d'implémentation propres à chaque constructeur ne se
révèlent que sur site.

## Hors périmètre

- **Modbus RTU** (liaison série) : le pilote client existe, le côté esclave
  demanderait une paire de pty ; à faire si le besoin se présente.
- **Diagnostic Modbus** (fonctions 07, 08, 17, 43) : non servi — exception 01.
- Le simulateur **n'est pas installé** par `meson install` : c'est un outil de
  mise au point et de démonstration, pas un composant du produit embarqué.
