# Diagweb

[![Intégration continue](https://github.com/david85fr/Diagweb/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/david85fr/Diagweb/actions/workflows/ci.yml)

Diagnostic web des variables et signaux internes d'un contrôleur industriel
embarqué (Linux embarqué) : valeurs numériques en direct et courbes
multi-échelles, depuis un smartphone comme sur un écran 24–32″.

**Statut : prototype front-end** — les données proviennent d'une simulation
locale (période 10 ms par défaut, soit jusqu'à 100 Hz par variable) ; le
serveur de diagnostic (C++) assure déjà l'acquisition réseau et la
journalisation, le lien avec le `controller` viendra en phase 2.

## Essayer

- **En ligne (GitHub Pages)** : https://david85fr.github.io/Diagweb/
  (branche `gh-pages`, copie de `dist/index.html` — dépôt public, donc page
  publique).
- Ou ouvrir `dist/index.html` dans un navigateur (fichier autonome, aucun
  serveur ni dépendance requis).
- Saisir une adresse dans la barre de recherche : `I1.2.3.4`, `Q14.15`,
  `M1.14`, `S0.4`, `MB414` ou un signal modèle `Regulation.mesure.vitesse`,
  puis choisir la cible (tableau ou graphique).
- **Multi-écran** : glisser un graphique, le tableau ou une variable par sa
  poignée « ⠿ » vers un autre onglet ou une autre fenêtre du navigateur ;
  chaque fenêtre a son propre espace de travail.

## Installer sur une machine (Ubuntu, Raspberry Pi)

Le serveur de diagnostic s'installe en paquet Debian : un service démarre et
sert la page sur le réseau, accessible depuis un téléphone comme depuis un
poste.

- **Paquet prêt à installer** — release
  [`paquets`](https://github.com/david85fr/Diagweb/releases/tag/paquets),
  refaite à chaque poussée sur `main` : `..._amd64.deb` (Ubuntu 24.04+),
  `..._arm64.deb` (Raspberry Pi OS 64 bits).

  ```bash
  sudo apt install ./diagweb_<version>_arm64.deb
  ```

- **Depuis ce dépôt, sur la machine cible** — construit le paquet pour elle,
  puis l'installe :

  ```bash
  git clone https://github.com/david85fr/Diagweb.git && cd Diagweb
  sudo bash tools/install.sh
  ```

Détails, réglages du service et désinstallation : **`docs/INSTALL.md`**.

## Développement

```
web/                sources de l'application (ouvrir web/index.html)
server/             serveur de diagnostic C++23 (HTTP + WebSocket)
simulator/          simulateur d'équipements C++23 (esclave Modbus TCP)
tools/build.py      assemble dist/index.html (autonome) + dist/artifact.html
tools/serve.py      serveur d'aperçu local (port 8080, sans cache)
tools/gen-catalog.mjs régénère le catalogue C++ depuis web/js/config.js
tools/setup-tests.sh installe Playwright + Chromium (facultatif)
tools/package-deb.sh paquet .deb pour la machine courante
tools/install.sh    installation en une commande depuis un clone
packaging/          service systemd, réglages, scripts dpkg
tests/ui.mjs        tests d'interface (mobile + desktop)
docs/               PROJET.md · SPECS.md · PROTOCOLES.md · SIMULATEUR.md · INSTALL.md
.devcontainer/      configuration GitHub Codespaces
CLAUDE.md           instructions pour l'IA (conventions, contraintes)
```

### Serveur de diagnostic (prototype du back-end embarqué)

```bash
meson setup build
meson compile -C build
./build/diagweb-server --port 8080 --root .
```

La page servie par ce serveur bascule automatiquement sur son **flux
WebSocket** (au lieu de la simulation navigateur) ; `?src=sim` force la
simulation. Détails, protocole et point d'accroche pour brancher le vrai
contrôleur : `server/README.md`.

### Simulateur d'équipements

```bash
./build/diagweb-simulator --port 5020 --list    # table des registres
./build/diagweb-simulator --port 5020           # écoute (502 par défaut)
```

Un second processus qui joue les **équipements tiers** que le serveur de
diagnostic interroge : Modbus TCP aujourd'hui, SNMP, OPC UA et IEC 61850
ensuite. Il éprouve les **vrais pilotes**, trames comprises, sans matériel —
là où `--sim-protocols` fabrique des valeurs sans rien émettre. Détails et
configuration : `docs/SIMULATEUR.md`.

Build : `python3 tools/build.py` — vérification : `node --check web/js/*.js`.
Vanilla HTML/CSS/JS, sans dépendance externe (contrainte de déploiement
embarqué et de publication sous CSP stricte) ; Playwright n'est utilisé que
par les tests, jamais par l'application.

### Dans GitHub Codespaces

Sur GitHub : bouton **Code → Codespaces → Create codespace on
`<branche>`**. Le conteneur installe l'outillage (Python, Node, Meson,
Ninja, Net-SNMP, open62541), vérifie la syntaxe des sources, compile le
serveur de diagnostic et démarre l'aperçu sur le **port 8080**.

La préparation est coupée en deux selon la dépendance au dépôt :
`on-create.sh` pose l'outillage système et construit open62541 —
l'étape la plus chère — et `post-create.sh` fait ce qui a besoin du code.
Cette coupure n'existe que pour une raison : un prebuild Codespaces
s'arrête à `onCreateCommand` et ne joue **jamais** `postCreateCommand`.
Activer les prebuilds (**Settings → Codespaces → Set up prebuilds**) évite
donc de repayer ces minutes à chaque création ; sans eux tout fonctionne
pareil, simplement sans le gain.

- **Le serveur de diagnostic démarre tout seul** à l'attachement
  (`post-attach.sh`) : flux WebSocket réel et **pilotes réseau actifs**,
  pas la simulation navigateur. Le port reste privé — publier est une
  décision, pas un effet de bord. Les variables internes, elles, restent
  simulées tant que le binding vers le `controller` n'existe pas (phase 2).
- **Le simulateur d'équipements démarre avec lui**, sur `127.0.0.1:5020` et
  sans jamais être publié : c'est l'adresse que la fenêtre « Liens réseau »
  pré-remplit pour Modbus TCP, elle mène donc à un équipement qui répond
  (registres en dent de scie de 0 à 10, décalés d'une seconde l'un de
  l'autre).
- **Et il se met à jour tout seul** : `post-attach.sh` lance aussi
  `tools/sync.sh --watch`, qui surveille `origin/main`. À chaque commit
  poussé, le Codespace arrête proprement les enregistrements, récupère,
  recompile et relance serveur, simulateur et banc d'essai — ouvrir la page
  suffit alors à voir la dernière version. Rien ne bouge tant qu'aucun commit
  n'arrive. Journal : `/tmp/diagweb-watch.log` ; `DIAGWEB_NO_WATCH=1`
  désactive. **Limite** : un Codespace suspendu n'exécute rien — la mise à
  jour se fait alors à la reprise, pas avant.
- **Pour partager le port** : `bash tools/share.sh --server` — arrête le
  serveur en place, le relance et rend le port public. Sans `--server`,
  c'est l'aperçu statique (simulation navigateur) qui est publié ;
  `--local` démarre sans toucher à la visibilité, `--no-restart` laisse
  tranquille un serveur déjà debout. `--help` détaille tout cela.
- Sinon, adresse seule : `python3 tools/serve.py --url` (elle est aussi
  affichée à la création du Codespace). `/web/index.html` = page de
  développement, `/dist/index.html` = livrable autonome.
- Elle figure également dans l'onglet **PORTS** du panneau du bas. Sur
  téléphone ce panneau est replié : menu **☰ → Terminal → New Terminal**
  l'ouvre (les onglets qui débordent sont derrière le **⋯**).
- **Tester depuis un autre appareil** : l'adresse ci-dessus fonctionne
  telle quelle si vous êtes connecté au même compte GitHub ; sinon rendez
  le port public —
  `gh codespace ports visibility 8080:public -c $CODESPACE_NAME`.
  Le serveur envoie des en-têtes anti-cache : chaque rechargement affiche
  la dernière version.
- **Se remettre à niveau après un commit** : `bash tools/sync.sh` — arrête
  proprement les enregistrements en cours (campagnes et captures, par l'API :
  les fichiers restent exploitables), arrête banc, simulateur et serveur,
  récupère `main`, **recompile systématiquement**, puis relance tout ce qui
  tournait. Il refuse en revanche d'écraser un travail local ou de fusionner
  un historique divergent. `--watch [N]` surveille `main` en boucle,
  `--no-relaunch` s'arrête après la recompilation, `--help` détaille.
- **Tout vérifier d'un coup** : `bash tools/check.sh` — les mêmes contrôles
  que l'intégration continue (compilation du serveur avec les avertissements
  en erreurs, tests de décodage, liens réseau de bout en bout, syntaxe JS,
  en-têtes générés, livrables à jour et autonomes, interface, déplacement de
  widgets). `bash tools/check.sh serveur` ou `interface` pour n'en faire
  qu'une partie.
- Tests : `bash tools/setup-tests.sh` (une fois) puis `node tests/ui.mjs`,
  ou `node tests/ui.mjs http://localhost:8080/web/index.html` pour tester
  les sources sans build.
- **Liens réseau et privilèges** : les protocoles IP (Modbus, IEC 60870-5-104,
  SNMP, IEC 61850 MMS, OPC UA) s'éprouvent sans privilège particulier.
  GOOSE, Sampled Values, LLDP et la capture demandent `CAP_NET_RAW` ; les
  trois protocoles CAN demandent une interface `vcan`, donc `CAP_NET_ADMIN`.
  Voir `docs/PROTOCOLES.md` § « Éprouver les liens en conteneur ».
