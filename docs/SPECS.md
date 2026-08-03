# Diagweb — Spécifications fonctionnelles

Référence de l'existant et des règles de comportement. Mise à jour à chaque
itération ; l'état d'avancement est en §9.

## 1. Adressage des variables

La barre de recherche accepte les formats suivants (insensible à la casse
pour les familles PLC, normalisé en majuscules) :

| Famille | Grammaire | Exemples | Type |
|---|---|---|---|
| `I` | `I n(.n){0,3}` — bus / sous-bus / module / voie, 1 à 4 niveaux | `I1.2.3.4`, `I0.1` | bit |
| `Q` | idem | `Q14.15` | bit |
| `M` | idem | `M1.14` | bit |
| `S` | idem — variables système | `S0.4` | bit |
| `MB` | `MB` + numéro de registre 0–65535 | `MB414` | mot 16 bits |
| C API | `Modele.sous_systeme.signal` — **séparateur hiérarchique : le point**, le **premier champ est le nom du modèle** Simulink ; ≥ 2 segments, identifiants `[A-Za-z_][A-Za-z0-9_]*` | `Regulation.mesure.vitesse` | flottant |

- Une adresse bien formée mais absente du catalogue est acceptée (« hors
  catalogue ») : le simulateur lui invente un signal plausible du bon type.
- Les familles PLC sont **prioritaires** sur les chemins C API (un modèle ne
  peut donc pas s'appeler `I`, `Q`, `M`, `S` ou `MB` suivi de chiffres avec
  un 2ᵉ segment numérique). L'ancien séparateur « / » est toléré à la saisie
  et dans les dispositions importées, normalisé en « . ».
- Erreur de format → toast explicatif avec exemples.

## 2. Recherche et ajout

- **Suggestions à chaque caractère saisi** : la liste se met à jour au fil
  de la frappe, sur le catalogue (adresse **et** libellé), classement :
  préfixe d'adresse d'abord, puis occurrences dans l'adresse ou le libellé.
  Champ vide → rappel des formats + début du catalogue. Navigation clavier
  ↑/↓/Entrée/Échap ; au tact, un appui sur une suggestion ajoute
  immédiatement.
- **Filtres par type** en tête des suggestions : « Toutes », « PLC »
  (familles I/Q/M/S), « Modbus » (registres MB), « Simulink » (signaux
  C API). Sélection exclusive, conservée pendant la saisie ; le filtre
  s'applique aussi à la ligne « hors catalogue ».
- Sélecteur de **cible** : « Tableau numérique », chacun des graphiques
  existants, « Nouveau graphique ». Après création d'un graphique via
  « Nouveau graphique » ou « + Graphique », il devient la cible courante.
- **Période de rafraîchissement** optionnelle par variable, choisie au
  moment de l'ajout (sélecteur à côté de la cible) : **10 ms par défaut**,
  valeurs proposées 10 / 20 / 50 / 100 / 200 / 500 ms / 1 s. La période est
  conservée dans les dispositions. Si la même adresse est demandée avec
  deux périodes différentes, la plus courte l'emporte (un seul flux par
  variable).
- Doublons refusés (même adresse dans le tableau, même courbe dans un même
  graphique) avec message.

## 3. Tableau numérique

- Colonnes : badge famille, adresse (mono), libellé, valeur vivante, unité,
  tendance (↗/↘/→ sur ~2,5 s, sauf bits), bouton retirer.
- Bits : LED + 0/1. Mots `MB` : décimal + hexadécimal `0xNNNN`.
- **Flash de changement** : une variable dont la valeur était immobile
  depuis **≥ 2 s** et qui change à nouveau fait flasher sa ligne (fond
  accentué qui s'estompe en ~1 s). Repère immédiat des variables qui
  bougent, même pour un changement d'un seul cycle. (Les grandeurs
  continues, qui changent en permanence, ne flashent donc pas.)
- Rafraîchissement ~5 Hz. Masqué quand il est vide.

## 4. Graphiques

- Nombre de graphiques au choix (max 8), grille responsive : 1 colonne sur
  téléphone, `auto-fit minmax(380px)` au-delà, `minmax(480px)` ≥ 1700 px.
- Par graphique : titre éditable, fenêtre de temps (15 s / 30 s / 1 min /
  2 min / 5 min), pause locale (+ pause globale dans la barre du haut),
  fermeture. Max 8 courbes par graphique (palette fixe).
- Légende : pastille couleur, adresse, valeur vivante + unité, badge
  d'échelle « Én ». Un appui ouvre le menu de la courbe : masquer/afficher,
  **échelle dédiée**, retirer.
- Curseur d'inspection : appui/glisser sur le tracé → ligne verticale,
  marqueurs et info-bulle avec la valeur de chaque courbe à cet instant
  (`t − x s`). Compatible pause (inspection d'une image figée).
- Historique conservé : 330 s glissantes (10 Hz).

## 5. Multi-échelles (règles)

1. Les courbes d'un graphique sont **regroupées automatiquement par unité**
   (`tr/min`, `°C`, `bar`…). Groupes spéciaux : bits → échelle `TOR` fixe
   0/1 ; mots sans unité → groupe `mot` ; flottants sans unité → groupe
   commun « sans unité ».
2. Chaque groupe = un axe Y indépendant, mis à l'échelle sur le min/max de
   la fenêtre visible (marge 7 %, graduations « nice », décimales dérivées
   du pas).
3. Placement des règles : groupe 1 à gauche, 2 à droite, 3 à gauche
   (extérieur), 4 à droite (extérieur). La règle prend la **couleur de la
   courbe** si le groupe n'en contient qu'une, sinon l'encre neutre ;
   l'unité est rappelée en tête de règle et via le badge « Én » de la
   légende.
4. Au-delà de 4 groupes : les courbes restent mises à l'échelle sur leur
   propre plage mais sans règle visible (badge « É· ») — les valeurs restent
   lisibles via la légende et le curseur.
5. « Échelle dédiée » (menu de courbe) sort une courbe de son groupe d'unité
   pour lui donner son propre axe.
6. La grille horizontale est celle du **premier** groupe uniquement.

## 6. Dispositions (liste des variables + agencement)

Objet sérialisé : `{version: 1, table: [{addr, periodMs?}], charts: [{title,
windowS, series: [{addr, axisMode: 'auto'|'solo', visible, periodMs?}]}]}`.
`periodMs` absent = 10 ms. Le lecteur accepte aussi les entrées de tableau
sous forme de simple chaîne (format initial) pour rester rétro-compatible.

- **Session** : l'espace de travail courant est sauvegardé en continu
  (localStorage, debounce 500 ms) et restauré au rechargement.
- **Navigateur** : dispositions nommées en localStorage — enregistrer,
  charger, supprimer, télécharger ; « ★ » désigne la disposition chargée
  automatiquement à l'ouverture (à défaut : session, sinon démo).
- **Fichier** : export `*.diagweb.json` (enveloppe `{app:'diagweb', version,
  name, exportedAt, data}`) pour envoi à un tiers ; import par sélection de
  fichier (validation + message d'erreur clair) ; repli « Copier le JSON » /
  collage manuel si le téléchargement est bloqué par l'environnement.
- **Contrôleur** : `PUT /api/layouts/<nom>` et `GET /api/layouts` (timeout
  2,5 s). Tant que le back-end n'existe pas, échec propre avec message
  explicite. À brancher en phase 2.

## 7. Contrat DataSource (frontière front/back)

`DW.source` expose : `name`, `defaultPeriodMs`, `now()`,
`subscribe(addr, {periodMs})` (comptage de références ; une seconde
souscription avec une période plus courte resserre le flux existant),
`unsubscribe(addr)`, `latest(addr)`, `past(addr, delta)`, `data(addr)` →
`{ts[], vs[]}` (secondes, croissant), `meta(addr)`, `count()`.
Le back-end WebSocket devra fournir exactement cette interface ; la
simulation actuelle (`web/js/sim.js`) en est l'implémentation de référence
(pré-remplissage de l'horizon compris, pour l'ergonomie à l'ajout).

Côté contrôleur (voir `docs/PROJET.md`, « Architecture cible ») : le
navigateur ne dialogue qu'avec le **processus serveur de diagnostic**, qui
sert les pages et relaie le flux temps réel depuis le **processus cœur**
(C++). La période de rafraîchissement de chaque abonnement (défaut 10 ms)
est transmise au serveur de diag, qui échantillonne le cœur en conséquence.

## 8. Interface générale

- Responsive mobile d'abord ; barre supérieure collante (marque, recherche,
  cible, actions), barre d'état fixe en bas (source, nb de variables).
- **Identification de version** en haut à droite : `hash court · #n`
  (hash git abrégé + numéro de commit dans la branche), injectée par
  `tools/build.py` au moment du build — elle identifie le **commit des
  sources** dont la page est issue (la page de dev `web/index.html`
  affiche « dev »).
- Thèmes sombre (défaut selon l'OS) et clair, bascule manuelle ◐ ;
  `prefers-reduced-motion` respecté ; libellés en français.
- Palette de courbes : 8 teintes catégorielles validées (déclinaisons claire
  et sombre), ordre fixe.

## 9. État d'avancement

- [x] Grammaire d'adresses + autocomplétion + gestion d'erreurs
- [x] Tableau numérique (LED, hexa, tendance)
- [x] Graphiques multi-échelles, curseur, pause, fenêtres de temps
- [x] Dispositions : session, navigateur, export/import, ★ auto, stub contrôleur
- [x] Période de rafraîchissement par variable (défaut 10 ms)
- [x] Simulation (catalogue ~37 variables + hors catalogue, période honorée)
- [x] Thèmes clair/sombre, responsive téléphone → 32″
- [ ] Back-end embarqué (WebSocket + /api/layouts) — phase 2
- [ ] Enregistrement/relecture, export CSV, seuils/alarmes — phase 3
