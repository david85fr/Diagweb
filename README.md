# Diagweb

Diagnostic web des variables et signaux internes d'un **contrôleur industriel
embarqué** (Linux embarqué). Il permet à un technicien ou un développeur
d'observer en temps réel des entrées/sorties TOR, des bits mémoire, des
variables système, des registres de bus et des signaux issus de modèles
Simulink — sous forme de **valeurs numériques en direct** et de **courbes
multi-échelles**, aussi bien depuis un smartphone que sur un écran 24–32″.

> **Statut : prototype front-end.** Les données proviennent d'une simulation
> (dans le navigateur ou via le serveur de diagnostic) ; aucun contrôleur
> réel n'est encore branché. Le contenu complet du projet vit sur la branche
> `claude/create-published-webpage-u9dpbb` (cette branche `main` n'en contient
> que la description).

## Aperçu

- **En ligne (GitHub Pages)** : https://david85fr.github.io/Diagweb/
- **Hors-ligne** : ouvrir `dist/index.html`, un fichier autonome, sans serveur
  ni dépendance externe.

Saisir une adresse dans la barre de recherche — `I1.2.3.4`, `Q14.15`, `M1.14`,
`S0.4`, `MB414`, ou un signal modèle `Regulation.mesure.vitesse` — puis
l'envoyer vers un tableau ou un graphique. Les widgets se **glissent** d'un
onglet ou d'une fenêtre à l'autre pour un usage multi-écran.

## Architecture cible

Deux processus cohabitent sur le contrôleur ; le navigateur ne parle qu'au
serveur de diagnostic, jamais au cœur temps réel.

- **`controller`** (C++, hors périmètre de ce dépôt) — boucle temps réel,
  modèles Simulink générés en C (C API), bus de terrain et mapping PLC
  (`I`/`Q`/`M`/`S`, registres `MB`).
- **Serveur de diagnostic** (`server/`, C++20, sans dépendance) — sert les
  pages, relaie le flux temps réel par **WebSocket**, expose une API HTTP
  (`/api/health`, `/api/layouts`, `/api/datalog`, `/api/protocols`) et
  possède ses propres **liens réseau** vers des équipements tiers.
- **Navigateur** (`web/`) — HTML/CSS/JS vanilla, deux sources de données
  interchangeables : simulation locale (`sim.js`) ou flux serveur
  (`source-ws.js`), bascule automatique quand le serveur répond.

## Liens réseau (équipements tiers)

Le serveur de diagnostic lit des variables directement sur des équipements
tiers, configurables depuis l'interface (☰ → Liens réseau) : **Modbus
TCP/RTU**, **IEC 60870-5-104**, **CAN / J1939 / CANopen**, **IEC 61850
(GOOSE / SV / MMS)**, **SNMP v1/v2c/v3** et **OPC UA**.

## Structure du dépôt

```
web/       application (HTML/CSS/JS vanilla, sans dépendance)
server/    serveur de diagnostic C++20 (HTTP + WebSocket + pilotes réseau)
dist/      livrables autonomes (index.html, artifact.html)
tools/     build, aperçu local, génération de code, scripts de tests
tests/     tests d'interface, de décodage et d'interopérabilité
docs/      PROJET.md · SPECS.md · PROTOCOLES.md
```

## Feuille de route

1. Prototype front-end (en cours) — itérations UX.
2. Serveur de diagnostic — squelette opérationnel ; source de variables encore
   simulée, contrat `IVariableSource` à implémenter pour brancher le
   `controller`.
3. Branchement du contrôleur réel.
4. Liens réseau — opérationnels (reste la pile ISO/MMS pour IEC 61850).
5. Ensuite : enregistrement/relecture, export CSV, alarmes/seuils.

## Licence

Aucune licence définie pour l'instant ; tous droits réservés par le
propriétaire du dépôt.
