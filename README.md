# Diagweb

Diagnostic web des variables et signaux internes d'un contrôleur industriel
embarqué (Linux embarqué) : valeurs numériques en direct et courbes
multi-échelles, depuis un smartphone comme sur un écran 24–32″.

**Statut : prototype front-end** — les données proviennent d'une simulation
locale (10 Hz) ; le back-end embarqué viendra en phase 2.

## Essayer

- **En ligne (GitHub Pages)** : https://david85fr.github.io/Diagweb/
  (branche `gh-pages`, copie de `dist/index.html` — dépôt public, donc page
  publique).
- Ou ouvrir `dist/index.html` dans un navigateur (fichier autonome, aucun
  serveur ni dépendance requis).
- Saisir une adresse dans la barre de recherche : `I1.2.3.4`, `Q14.15`,
  `M1.14`, `S0.4`, `MB414` ou un signal modèle `Regulation.mesure.vitesse`,
  puis choisir la cible (tableau ou graphique).

## Développement

```
web/                sources (ouvrir web/index.html pour développer)
tools/build.py      assemble dist/index.html (autonome) + dist/artifact.html
tools/serve.py      serveur d'aperçu local (port 8080, sans cache)
tools/setup-tests.sh installe Playwright + Chromium (facultatif)
tests/ui.mjs        tests d'interface (mobile + desktop)
docs/               PROJET.md (description) · SPECS.md (spécifications)
.devcontainer/      configuration GitHub Codespaces
CLAUDE.md           instructions pour l'IA (conventions, contraintes)
```

Build : `python3 tools/build.py` — vérification : `node --check web/js/*.js`.
Vanilla HTML/CSS/JS, sans dépendance externe (contrainte de déploiement
embarqué et de publication sous CSP stricte) ; Playwright n'est utilisé que
par les tests, jamais par l'application.

### Dans GitHub Codespaces

Sur GitHub : bouton **Code → Codespaces → Create codespace on
`<branche>`**. Le conteneur installe Python et Node, vérifie la syntaxe des
sources et démarre l'aperçu sur le **port 8080**.

- Adresse de l'aperçu : `python3 tools/serve.py --url` (elle est aussi
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
- Tests : `bash tools/setup-tests.sh` (une fois) puis `node tests/ui.mjs`,
  ou `node tests/ui.mjs http://localhost:8080/web/index.html` pour tester
  les sources sans build.
