# Instructions pour l'IA (Claude)

## Contexte

Diagweb est un outil web de diagnostic des variables et signaux internes d'un
**contrôleur industriel embarqué** (Linux embarqué moderne, basé systemd).
Lire `docs/PROJET.md` (description) et `docs/SPECS.md` (spécifications
fonctionnelles + état d'avancement) avant toute modification.

## Contraintes absolues

1. **Confidentialité des noms** : ne jamais écrire de marque, nom commercial,
   nom de produit ou référence interne du fabricant du contrôleur ou de son
   groupe — ni dans le code, ni dans l'UI, ni dans les docs, ni dans les
   messages de commit. Toujours dire « le contrôleur ». En cas de doute,
   rester générique. (Liste précise communiquée par le propriétaire en
   conversation ; elle ne doit pas être recopiée ici.)
2. **Aucune dépendance externe** au runtime : pas de CDN, pas de webfont, pas
   de framework téléchargé. Vanilla HTML/CSS/JS uniquement — la page publiée
   (Artifact) est servie sous CSP stricte et le contrôleur embarqué doit
   pouvoir servir les fichiers hors ligne.
3. **UI et documentation en français.**

## Organisation du dépôt

```
web/            sources de l'application (page de dev : web/index.html)
  css/app.css   styles (tokens de thème clair/sombre en tête de fichier)
  js/config.js  constantes + catalogue des variables simulées + palette courbes
  js/parser.js  grammaire des adresses (I/Q/M/S, MB, chemins C API)
  js/sim.js     source de données simulée — implémente le contrat DataSource
  js/chart.js   moteur de graphiques canvas (multi-échelles, gestes, échelles)
  js/source-ws.js source WebSocket (même contrat que sim.js)
  js/source.js  choix de la source au démarrage (DW.sourceReady)
  js/dnd.js     déplacement de widgets entre onglets et fenêtres
  js/store.js   configurations : localStorage, export/import JSON+CSV, stub
  js/app.js     onglets, recherche, tableau, journal, boucle de rendu
server/         serveur de diagnostic C++20 (HTTP + WebSocket, sans dépendance)
  src/source.hpp     contrat IVariableSource — à implémenter pour le cœur
  src/sim_source.hpp source simulée (bouchon) + générateurs
  src/main.cpp       HTTP/WS, REST, boucle d'émission
tools/build.py  assemble dist/ à partir de web/
tools/gen-catalog.mjs  régénère server/src/catalog.generated.hpp depuis config.js
tools/serve.py  serveur d'aperçu (port 8080, en-têtes anti-cache)
tests/ui.mjs    tests d'interface Playwright (13 vérifications)
tests/dnd.mjs   tests de déplacement de widgets (6 vérifications, http requis)
dist/           livrables générés (commités) : index.html autonome + artifact.html
docs/           PROJET.md, SPECS.md
.devcontainer/  configuration GitHub Codespaces (Python + Node + aperçu 8080)
```

Espace de noms JS global : `window.DW`. Scripts en IIFE, pas de modules ES
(simplicité d'inclusion et d'inlining).

## Cycle de travail

1. Modifier les sources sous `web/`.
2. `node --check web/js/*.js` puis `python3 tools/build.py`, et tester
   `node tests/ui.mjs` (mobile 390×844 + desktop 1600×900, captures dans
   `.test-shots/`). Environnement de développement possible : GitHub
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

## Points d'architecture à respecter

- **Deux sources** implémentent le contrat : `web/js/sim.js` (simulation) et
  `web/js/source-ws.js` (serveur de diagnostic) ; `web/js/source.js` choisit
  au démarrage. Toute modification du contrat doit être répercutée des deux
  côtés **et** dans `server/src/source.hpp`.
- Le catalogue C++ est **généré** : après modification de `DW.CATALOG` dans
  `web/js/config.js`, relancer `node tools/gen-catalog.mjs`.
- `DW.source` est le **contrat DataSource** (`subscribe(addr, {periodMs})`,
  unsubscribe/latest/past/data/meta/now — période par variable, défaut
  10 ms). Le futur back-end (WebSocket via le processus serveur de diag du
  contrôleur, voir docs/PROJET.md « Architecture cible ») devra le remplacer
  sans toucher au reste — ne pas créer de dépendances directes au simulateur
  ailleurs que via ce contrat.
- Multi-échelles : regroupement automatique par unité + « échelle dédiée »
  par courbe ; max 4 règles d'axe visibles (voir `docs/SPECS.md` §5).
- Couleurs de courbes : palette catégorielle fixe de `config.js`, attribution
  par plus petit index libre — ne jamais générer de teintes.
- Les dispositions sérialisées (`{version, table, charts}`) sont un format
  d'échange : rester rétro-compatible ou incrémenter `version` avec migration.
- Session dans `sessionStorage` (par fenêtre, multi-écran), configurations
  nommées dans `localStorage` (partagées) — ne pas confondre.
