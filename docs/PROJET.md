# Diagweb — Description du projet

## Objet

Diagweb est un site web de **diagnostic en ligne des variables et signaux
internes d'un contrôleur industriel embarqué**. Il permet à un technicien ou
développeur d'observer en temps réel des entrées/sorties TOR, des bits
mémoire, des variables système, des registres de bus et des signaux issus de
modèles Simulink, sous forme de valeurs numériques et de courbes.

## Le contrôleur cible (pour information)

- Linux embarqué moderne (distribution type Buildroot/Yocto), services
  gérés par **systemd** ; bibliothèques récentes disponibles.
- Application de contrôle intégrant plusieurs **modèles Simulink générés en
  C**, chacun exposant l'interface **C API** de Simulink Coder (accès aux
  signaux et paramètres par leurs chemins de blocs).
- Bus de terrain avec mapping type PLC industriel (entrées `I…`, sorties
  `Q…`, mémoires `M…`, variables système `S…`) et registres 16 bits
  accessibles par numéro (`MB…`).

Le développement du contrôleur lui-même est **hors périmètre** de ce dépôt :
Diagweb n'en est que le front-end de diagnostic. Un back-end embarqué
(service HTTP/WebSocket sur le contrôleur) sera développé ensuite pour
alimenter l'interface en données réelles.

## Architecture cible sur le contrôleur

**Terminologie** — à ne pas confondre :

- **le contrôleur** : l'équipement embarqué complet (la cible) ;
- **le `controller`** : le **processus cœur** qui tourne dessus (temps réel,
  modèles, bus) — c'est son nom ;
- **le serveur de diagnostic** : le second processus, qui sert les pages web
  et relaie les variables.

Ces deux processus cohabitent sur le contrôleur ; le navigateur ne parle
qu'au serveur de diagnostic, jamais au `controller`.

```
┌─────────────────────────────────────────────────────────────────┐
│ CONTRÔLEUR (Linux embarqué, systemd)                            │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ controller (C++)               — hors périmètre du dépôt  │  │
│  │ boucle temps réel · modèles Simulink générés en C (C API) │  │
│  │ bus de terrain, mapping PLC : I/Q/M/S · registres MB      │  │
│  └───────────────────────────┬───────────────────────────────┘  │
│                              │ IPC local                        │
│                              │ contrat IVariableSource :        │
│                              │ résolution d'adresse, abonnement │
│                              │ (période), lecture d'échantillons│
│  ┌───────────────────────────▼───────────────────────────────┐  │
│  │ SERVEUR DE DIAGNOSTIC (server/, C++20)                    │  │
│  │ sert les pages · /api/health · /api/layouts · /api/datalog│  │
│  │ /api/protocols : configuration des liens réseau           │  │
│  │ WebSocket /ws : abonnements et émission des échantillons  │  │
│  └────────┬────────────────────────────────────┬─────────────┘  │
└───────────┼────────────────────────────────────┼────────────────┘
            │ Modbus TCP/RTU · IEC 60870-5-104   │ réseau : HTTP
            │ CAN · J1939 · CANopen · 61850 GOOSE│ + WebSocket
            │ 61850 SV/MMS · SNMP v1/v2c/v3 · UA │
            ▼                                    ▼
 ┌────────────────────┐         ┌──────────────────────────────────┐
 │ ÉQUIPEMENTS TIERS  │         │ NAVIGATEUR — Diagweb (web/)      │
 │ points @lien.point │         │ source-ws.js ─┐                  │
 │ (registres, IOA,   │         │               ├─ DataSource      │
 │  SPN, objets…)     │         │ sim.js ───────┘  (repli simulé)  │
 └────────────────────┘         │ app.js · chart.js · protocols.js │
                                └──────────────────────────────────┘
```

En détail :

1. **`controller`** (C++) — le cœur du produit : exécution temps réel,
   modèles Simulink générés en C (exposés via la C API), gestion du bus de
   terrain et du mapping PLC (`I/Q/M/S`, registres `MB`).
2. **Serveur de diagnostic** — sert les pages web de Diagweb **et** relaie le
   flux temps réel des variables : c'est par lui que transitent toutes les
   valeurs à diagnostiquer. Il possède en outre ses **propres liens réseau**
   (Modbus, IEC 61850, IEC 60870-5-104, CAN/J1939/CANopen) pour lire des
   variables sur des équipements tiers, sans passer par le `controller`.

Chemins des données :

- variables internes : `controller → serveur de diag → navigateur` — le
  serveur de diag s'abonne aux variables demandées auprès du `controller`
  (IPC local) et pousse les échantillons au navigateur (WebSocket) ;
- variables réseau : `équipement tiers → serveur de diag → navigateur` — le
  serveur de diag interroge lui-même l'équipement dans son protocole
  (voir `docs/PROTOCOLES.md`).

Le navigateur ne parle jamais directement au `controller` ni aux équipements
tiers : il ne connaît que le serveur de diagnostic.

Chaque abonnement porte une **période de rafraîchissement** propre,
optionnelle à la saisie — **10 ms par défaut**.

## Utilisateurs et usages

- Mise au point : tracer une régulation, comparer consigne/mesure/commande.
- Diagnostic terrain : vérifier des E/S, surveiller des températures ou
  pressions, lire des registres bruts.
- Support : échanger une disposition (fichier JSON) pour que deux personnes
  regardent les mêmes signaux de la même façon.

Supports visés : **smartphone** jusqu'à écran **24–32 pouces** (interface
responsive, tactile en priorité).

## État actuel — prototype front-end

- Deux sources de données interchangeables : une **simulation locale** dans
  le navigateur (par défaut) et le **serveur de diagnostic** de `server/`
  quand la page est servie par lui (flux WebSocket). Dans les deux cas les
  signaux sont simulés — aucun contrôleur n'est encore branché.
- Les **liens réseau** sont opérationnels côté serveur : les pilotes Modbus,
  IEC 60870-5-104 et CAN/J1939/CANopen lisent de vrais équipements, et la
  configuration se saisit depuis l'interface (☰ → Liens réseau).
- Toutes les fonctions d'interface sont opérationnelles : recherche/ajout,
  tableau numérique, graphiques multi-échelles, dispositions
  (navigateur + export/import fichier ; l'enregistrement « contrôleur » est
  un stub qui échouera proprement tant que le back-end n'existe pas).

## Feuille de route

1. **Prototype front-end** (ce dépôt, en cours) — itérations sur l'UX.
2. **Serveur de diagnostic** — squelette opérationnel dans `server/`
   (C++20, sans dépendance externe) : WebSocket de streaming (abonnement par
   adresse, période par variable), service des pages, `/api/layouts`,
   `/api/datalog`. Sa source de variables est encore simulée ; le contrat à
   implémenter pour brancher le `controller` est `IVariableSource`
   (`server/src/source.hpp`) : résolution des adresses (mapping PLC,
   registres de bus, chemins C API des modèles), abonnement avec période,
   lecture des échantillons.
3. **Branchement** : côté navigateur c'est fait — `web/js/source-ws.js`
   implémente le contrat `DataSource` (voir `docs/SPECS.md` §7) et la page
   bascule automatiquement sur le serveur quand il répond. Reste à
   substituer la source simulée du serveur par le lien avec le `controller`.
4. **Liens réseau** — fait : le serveur de diagnostic lit des variables sur des
   équipements tiers (Modbus TCP/RTU, IEC 60870-5-104, CAN, J1939, CANopen),
   configurables depuis l'interface (voir `docs/PROTOCOLES.md`). Reste la pile
   ISO/MMS pour IEC 61850, dont la configuration est déjà en place.
5. Ensuite : enregistrement/relecture de séquences, export CSV, alarmes/seuils.
