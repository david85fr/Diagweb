# Instructions pour l'IA (Claude)

## Contexte

Diagweb est un outil web de diagnostic des variables et signaux internes d'un
**contrôleur industriel embarqué** (Linux embarqué moderne, basé systemd).
Lire `docs/PROJET.md` (description) et `docs/SPECS.md` (spécifications
fonctionnelles + état d'avancement) avant toute modification.

## Contraintes absolues

0. **Terminologie** : « le contrôleur » = l'équipement embarqué ; « le
   `controller` » = son processus cœur (temps réel, modèles, bus) ; « le
   serveur de diagnostic » = le processus qui sert les pages et relaie les
   variables.
1. **Confidentialité des noms** : ne jamais écrire de marque, nom commercial,
   nom de produit ou référence interne du fabricant du contrôleur ou de son
   groupe — ni dans le code, ni dans l'UI, ni dans les docs, ni dans les
   messages de commit. Toujours dire « le contrôleur ». En cas de doute,
   rester générique. (Liste précise communiquée par le propriétaire en
   conversation ; elle ne doit pas être recopiée ici.)
2. **Interface web : aucune dépendance externe.** Pas de CDN, pas de webfont,
   pas de framework téléchargé. Vanilla HTML/CSS/JS uniquement — la page
   publiée (Artifact) est servie sous CSP stricte et le contrôleur embarqué
   doit pouvoir servir les fichiers hors ligne. Cette règle ne bouge pas.
2 bis. **Serveur : bibliothèque autorisée si sa licence est gratuite en
   produit commercial fermé.** Acceptées : MIT, BSD, Apache-2.0, MPL-2.0,
   ISC, zlib. Refusées : GPL et AGPL, double licence dont l'arme gratuite est
   GPL (le commercial se paie), et toute licence exigeant l'ouverture du
   produit. LGPL : à éviter — l'édition de liens statique, usuelle en
   embarqué, en fait une contrainte de relivraison. **Vérifier le fichier
   `LICENSE` du dépôt**, jamais le badge : celui de S2OPC annonce
   « Educational Community License » là où le fichier dit Apache-2.0. Toute
   dépendance retenue est inscrite dans `docs/PROTOCOLES.md`
   § « Bibliothèques externes et licences », avec sa licence vérifiée.
3. **UI et documentation en français.**
4. **Tout objet d'interface porte une infobulle** (`title`) expliquant ce
   qu'il fait — un test de couverture le vérifie. Le menu ☰ → Aide doit
   rester à jour, car les infobulles n'existent pas sur écran tactile.
5. **Modèle et effort figés** : ne jamais changer de modèle ni de niveau
   d'effort de sa propre initiative, et ne jamais lancer d'orchestration
   multi-agents (workflows, sous-agents en éventail) sans demande explicite
   du propriétaire. Les valeurs font foi dans `.claude/settings.json`
   (ci-dessous) ; seul le propriétaire les modifie.

## Réglages de session

`.claude/settings.json` est **versionné** : il est donc rechargé à l'identique
à chaque nouvelle session, y compris après un résumé de contexte (c'est là que
le modèle repartait sinon sur celui par défaut de l'environnement).

| Clé           | Valeur            | Effet |
|---------------|-------------------|-------|
| `model`       | `claude-opus-5`   | modèle épinglé, plus de retour au défaut de l'environnement |
| `effortLevel` | `xhigh`           | effort de raisonnement constant (`low`/`medium`/`high`/`xhigh`) |
| `ultracode`   | `false`           | désactive le mode qui force `xhigh` **et** impose l'orchestration multi-agents |

Pour changer de modèle ou d'effort : éditer ce fichier (une ligne), c'est le
seul endroit. Un `/model` en cours de session ne vaut que pour la session et
sera perdu au prochain résumé de contexte.

Reste hors de contrôle du dépôt : le repli automatique quand le modèle épinglé
est indisponible (`fallbackModel`, non renseigné ici) et le mode rapide.

## Organisation du dépôt

```
web/            sources de l'application (page de dev : web/index.html)
  css/app.css   styles (tokens de thème clair/sombre en tête de fichier)
  js/config.js  constantes + catalogue des variables simulées + palette courbes
  js/parser.js  grammaire des adresses (I/Q/M/S, MB, chemins C API, @lien.point)
  js/protocols.js  **source de vérité** des protocoles réseau (champs, aides)
  js/protocols-ui.js fenêtre « Liens réseau » (☰) : liens, points, test
  js/sim.js     source de données simulée — implémente le contrat DataSource
  js/chart.js   moteur de graphiques canvas (multi-échelles, gestes, échelles)
  js/source-ws.js source WebSocket (même contrat que sim.js)
  js/source.js  choix de la source au démarrage (DW.sourceReady)
  js/dnd.js     déplacement de widgets entre onglets et fenêtres
  js/appearance.js logo de l'exploitant + couleurs (partagés par tous les postes)
  js/store.js   configurations : localStorage, export/import JSON+CSV, stub
  js/app.js     onglets, recherche, tableau, journal, boucle de rendu
server/         serveur de diagnostic C++20 (HTTP + WebSocket ; open62541 pour
                OPC UA, Net-SNMP pour SNMP v3 — les deux facultatives)
  src/source.hpp     contrat IVariableSource — à implémenter pour le controller
  src/sim_source.hpp source simulée (bouchon) + générateurs + forçage
  src/recorder.hpp   journalisation autonome (navigateur fermé)
  src/protocol.hpp   modèle des liens réseau + contrat IProtocolDriver
  src/protocol_source.hpp  liens réseau (@lien.point) + aiguillage composite
  src/drivers/<proto>/  UN DOSSIER PAR PROTOCOLE : modbus, iec104, can, j1939,
                     canopen, snmp, iec61850, opcua — plus common/ (net,
                     can_socket, l2_socket, ber, declared) ; contrôlé par
                     tools/check-drivers.mjs
  src/jvalue.hpp     analyseur JSON complet (configuration imbriquée)
  src/main.cpp       HTTP/WS, REST, boucle d'émission
tools/build.py  assemble dist/ à partir de web/
tools/check.sh  toutes les vérifications de la CI, en local (serveur|interface)
tools/check-dist.py  dist/ à jour + page autonome (aucune ressource externe)
tools/gen-catalog.mjs  régénère server/src/catalog.generated.hpp depuis config.js
tools/gen-protocols.mjs régénère server/src/protocols.generated.hpp depuis protocols.js
tools/check-drivers.mjs  un dossier de pilote par protocole (rejoué par la CI)
tools/serve.py  serveur d'aperçu (port 8080, en-têtes anti-cache)
tests/ui.mjs    tests d'interface Playwright (24 vérifications)
tests/dnd.mjs   tests de déplacement de widgets (7 vérifications, http requis)
tests/protocols.mjs  liens réseau bout en bout (équipements simulés + agent snmpd
                réel pour SNMPv3 ; serveur requis, secrets dans son environnement)
tests/decode.cpp     décodage des protocoles (cible diagweb-decode-test)
tests/opcua_server.c serveur OPC UA de test (cible diagweb-opcua-test-server)
tests/mms_ied.mjs    IED IEC 61850 simulé (pile ISO, MMS, rapports)
tests/server.mjs     forçage + journalisation autonome (serveur requis)
dist/           livrables générés (commités) : index.html autonome + artifact.html
docs/           PROJET.md, SPECS.md, PROTOCOLES.md
.devcontainer/  configuration GitHub Codespaces (Python + Node + aperçu 8080)
.github/workflows/ci.yml  intégration continue (push sur main, PR, claude/**)
```

Espace de noms JS global : `window.DW`. Scripts en IIFE, pas de modules ES
(simplicité d'inclusion et d'inlining).

## Cycle de travail

1. Modifier les sources sous `web/`.
2. `node --check web/js/*.js` puis `python3 tools/build.py`, et tester
   `node tests/ui.mjs` (mobile 390×844 + desktop 1600×900, captures dans
   `.test-shots/`). Après modification du serveur ou des protocoles :
   `meson compile -C build`, `meson test -C build --suite serveur`, puis
   `node tests/protocols.mjs` (serveur lancé). Environnement de développement possible : GitHub
   Codespaces (`.devcontainer/`), aperçu sur le port 8080 via
   `tools/serve.py` — port à passer en « Public » pour tester au téléphone.
3. **Commit des sources** (sans `dist/`), puis relancer
   `python3 tools/build.py` : il injecte dans la page la version
   `hash court · #n` du commit de sources fraîchement créé.
4. **Commit de `dist/`** (« build : <hash> ») — ne pas amender le commit de
   sources, sinon le hash affiché ne correspondrait plus.
5. Republier l'Artifact **au même URL** (redéployer `dist/artifact.html`,
   favicon stable 📈).
6. Mettre à jour GitHub Pages : recopier `dist/index.html` en racine de la
   branche `gh-pages` (avec `.nojekyll`) et pousser — la page publique est
   https://david85fr.github.io/Diagweb/.
7. Push sur la branche de travail indiquée par la session.

**Avant de pousser** : `bash tools/check.sh` rejoue exactement les
vérifications de l'intégration continue (`.github/workflows/ci.yml`), qui
s'exécute sur `main`, sur les pull requests et sur les branches `claude/**` :
compilation C++ avec `-Werror`, tests de décodage, liens réseau de bout en
bout, forçage + journalisation autonome, syntaxe JS, en-têtes générés à jour,
un dossier de pilote par protocole, `dist/` à jour et sans ressource externe,
tests d'interface et de déplacement de widgets. Toute vérification ajoutée ici
doit l'être aux deux endroits.

## Points d'architecture à respecter

- **Deux sources** implémentent le contrat : `web/js/sim.js` (simulation) et
  `web/js/source-ws.js` (serveur de diagnostic) ; `web/js/source.js` choisit
  au démarrage. Toute modification du contrat doit être répercutée des deux
  côtés **et** dans `server/src/source.hpp`.
- Le catalogue C++ est **généré** : après modification de `DW.CATALOG` dans
  `web/js/config.js`, relancer `node tools/gen-catalog.mjs`.
- La description des protocoles réseau est **générée** de la même façon :
  après modification de `DW.PROTOCOLS` dans `web/js/protocols.js`, relancer
  `node tools/gen-protocols.mjs`. Ne jamais éditer les fichiers `*.generated.hpp`.
- **Liens réseau** (voir `docs/PROTOCOLES.md`) : un *lien* porte des *points*,
  adressés `@lien.point` (famille NET). Un nouveau protocole s'ajoute par une
  description dans `protocols.js` + un pilote `IProtocolDriver` **dans son
  propre dossier** `server/src/drivers/<protocole>/`, enregistré dans
  `make_driver()` et dans la table `DOSSIERS` de `tools/check-drivers.mjs` ;
  l'interface construit ses formulaires toute seule. **Lecture seule de bout en bout** :
  aucune écriture vers un équipement, hors requête SDO CANopen désactivée par
  défaut. Un pilote non implémenté ne publie **aucune** valeur (jamais de
  valeur inventée) et le lien affiche « non branché ».
- `DW.source` est le **contrat DataSource** (`subscribe(addr, {periodMs})`,
  unsubscribe/latest/past/data/meta/now — période par variable, défaut
  10 ms — plus `write(addr, value)`/`forced(addr)` pour le forçage, refusé
  pour les points réseau). Le futur back-end (WebSocket via le processus
  serveur de diag du contrôleur, voir docs/PROJET.md « Architecture cible »)
  devra le remplacer sans toucher au reste — ne pas créer de dépendances
  directes au simulateur ailleurs que via ce contrat.
- **Forçage** : seules les variables internes (I/Q/M/S, MB, C API) sont
  forçables (`write`), jamais les points réseau `@lien.point` (lecture seule,
  sûreté). Côté serveur `IVariableSource::write` défaut = refus ; SimSource
  tient la valeur ; ProtocolSource refuse les `@`.
- **Nom d'affichage** : `name` sur chaque entrée de tableau et chaque courbe
  (sérialisé) ; l'adresse ne change jamais. Lire l'affichage via ce nom, sinon
  le libellé du catalogue.
- **Robustesse serveur** : toute conversion `std::sto*` sur une entrée réseau
  est bornée ou protégée (une exception dans un thread tuerait le processus) ;
  `handle_connection` est sous `try/catch`. Ne jamais réintroduire de `sto*`
  non gardé sur des données venues du réseau.
- Multi-échelles : regroupement automatique par unité + « échelle dédiée »
  par courbe ; max 4 règles d'axe visibles (voir `docs/SPECS.md` §5).
- Couleurs de courbes : palette catégorielle fixe de `config.js`, attribution
  automatique par plus petit index libre — ne jamais générer de teintes.
  L'utilisateur peut choisir un emplacement de palette (`colorIdx`, suit le
  thème) ou une teinte libre (`color`) ; lire la couleur via `colorOf(s)`.
- Les dispositions sérialisées (`{version, table, charts}`) sont un format
  d'échange : rester rétro-compatible ou incrémenter `version` avec migration.
- Session dans `sessionStorage` (par fenêtre, multi-écran), configurations
  nommées dans `localStorage` (partagées) — ne pas confondre.
