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

## 2 bis. Onglets (espaces de travail)

- L'espace de travail est composé d'**onglets**, chacun portant sa propre
  **configuration** (tableau numérique + graphiques) et ses réglages de
  journalisation. Barre d'onglets sous la barre supérieure : « ＋ » crée un
  onglet vide, « ✕ » ferme (le dernier onglet fermé est remplacé par un
  onglet vide), un appui sur l'onglet **actif** renomme en place.
- Les abonnements des onglets inactifs **restent vivants** : l'historique
  des courbes et la journalisation continuent en arrière-plan, rien n'est
  perdu en changeant d'onglet. Seul l'onglet actif est rendu à l'écran.
- La recherche, la cible d'ajout, « + Graphique », la pause et le Journal
  agissent sur l'onglet actif.
- La session (v2) mémorise tous les onglets, l'onglet actif et l'état de
  journalisation de chacun.

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
  téléphone, `auto-fit minmax(380px)` au-delà, `minmax(500px)` ≥ 1700 px,
  `minmax(620px)` ≥ 2300 px ; conteneur jusqu'à 2300 px (écrans 32″).
- Par graphique : titre éditable, fenêtre de temps (préréglages 15 s → 5 min
  + valeur continue par zoom), pause locale (+ pause de l'onglet), menu ⋮
  (échelles automatiques, taille, plein écran, fermeture). Max 8 courbes
  par graphique (palette fixe).
- **Tailles** : hauteur adaptée à l'écran (`32vh`, bornée 220–420 px) ;
  cycle **M → L → XL** par graphique via le menu ⋮ (L ≈ 48vh, XL ≈ 56vh et
  pleine largeur de la grille) — mémorisé dans la configuration
  (`heightMode`). **Plein écran** par graphique (menu ⋮, sortie par Échap
  ou le menu).
- Sur canvas étroit (< 520 px) : règles d'axes compactes (38 px), 2 règles
  visibles au maximum (les groupes suivants gardent leur mise à l'échelle,
  badge « É· ») ; ≥ 1100 px : règles de 50 px, police 11 px.
- Légende : pastille couleur, adresse, valeur vivante + unité, badge
  d'échelle « Én ». Un appui ouvre le menu de la courbe : masquer/afficher,
  **échelle dédiée**, retirer.
Gestes **par zone**, prévisibles (canvas en `touch-action: none` — le
défilement de la page se fait en dehors des tracés) :

- **Sur le tracé** :
  - glisser **horizontal** = navigation dans l'historique (vue figée à
    l'instant choisi, borné par l'horizon de 330 s) ; retour au temps réel
    par « ▶ Direct » superposé, le bouton pause, un double-appui/double-clic
    sur le tracé, ou en ramenant la vue au bord droit ;
  - glisser **vertical** = déplacement de l'**échelle principale** (É1),
    qui passe en manuel 🔒 ;
  - **pincement** à deux doigts ou **molette** = zoom temporel continu
    2 s → 5 min (sélecteur affichant la valeur personnalisée) ; ancré au
    bord droit en vue directe, sous le geste en vue figée ;
  - **appui bref** (tactile) ou **clic bref** (souris) = épingle un curseur
    de mesure à l'instant visé (ligne accentuée, valeurs vraies de chaque
    courbe, `t − x s`) ; nouvel appui dessus pour le retirer ; survol
    souris = curseur transitoire.
- **Sur la règle d'un axe** :
  - glisser = déplacement de cette échelle (passe en manuel 🔒) ;
  - molette = zoom de cette échelle, ancré sous le curseur (manuel 🔒) ;
  - double-appui/double-clic = retour de cet axe en automatique.
- **Décalage vertical par courbe** : mode explicite via le menu de sa
  pastille (« Décaler verticalement ») → bandeau en surimpression, la
  courbe s'épaissit, glisser verticalement, « OK » pour terminer. Badge
  « Δ » sur la pastille, « Annuler le décalage » dans son menu. Conservé
  dans les configurations (`offsetY`, colonne `decalage` du CSV). Les
  valeurs affichées restent les valeurs vraies, non décalées.

Échelles automatiques **stabilisées** : extension immédiate quand les
données sortent de la plage ; rétraction seulement si les données occupent
moins de 55 % de l'échelle pendant plus de 2 s ; transitions lissées.
« Échelles automatiques » du menu ⋮ ré-arme tous les axes du graphique.
Historique conservé : 330 s glissantes.

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

## 6. Configurations (liste des variables + agencement)

Configuration (une par onglet) : `{version: 1, table: [{addr, periodMs?}],
charts: [{title, windowS, series: [{addr, axisMode: 'auto'|'solo', visible,
periodMs?, offsetY?}]}]}`. `periodMs` absent = 10 ms ; `offsetY` = décalage
vertical de la courbe (unités de la variable, absent = 0). Le lecteur
accepte aussi les entrées de tableau sous forme de simple chaîne (format
initial).

Session (navigateur) : `{version: 2, active, tabs: [{name, log: {enabled,
dest}, data: <configuration v1>}]}` ; une session v1 (une seule
configuration à la racine) est acceptée et convertie en un onglet.

- **Session** : l'espace de travail courant est sauvegardé en continu
  (localStorage, debounce 500 ms) et restauré au rechargement.
- **Navigateur** : dispositions nommées en localStorage — enregistrer,
  charger, supprimer, télécharger ; « ★ » désigne la disposition chargée
  automatiquement à l'ouverture (à défaut : session, sinon démo).
- Panneau « Configs » : champ nom + **4 actions principales dépliant leurs
  déclinaisons** (accordéon, note contextuelle sous le volet) :
  **Enregistrer** → Navigateur / Contrôleur ; **Télécharger** → JSON / CSV ;
  **Charger** → liste du navigateur (Charger / ⬇ / ★ / 🗑) + Importer un
  fichier ; **Copier** → JSON / CSV. À l'ouverture, le volet « Charger »
  est déplié s'il existe des configurations enregistrées, sinon
  « Enregistrer ».
- Une configuration nommée = **un onglet**. « Charger » et l'import ouvrent
  la configuration dans un **nouvel onglet** (non destructif) ; « ★ » est
  chargée au premier démarrage (sans session).
- **Fichier JSON** : export `*.diagweb.json` (enveloppe `{app:'diagweb',
  version, name, exportedAt, data}`) pour envoi à un tiers ; import par
  sélection de fichier (validation + message d'erreur clair) ; repli
  « Copier le JSON » / collage manuel si le téléchargement est bloqué.
- **Fichier CSV** (export de consultation, non importable) : séparateur
  « ; », en-tête `emplacement;graphique;fenetre_s;adresse;periode_ms;`
  `echelle;visible` — une ligne par variable du tableau et par courbe.
- **Contrôleur** : `PUT /api/layouts/<nom>` et `GET /api/layouts` (timeout
  2,5 s). Tant que le back-end n'existe pas, échec propre avec message
  explicite. À brancher en phase 2.

## 6 bis. Journalisation des données (par onglet, optionnelle)

- Bouton « Journal » (indicateur ⏺ rouge sur le bouton et sur l'onglet
  quand elle est active). Chaque onglet journalise **toutes ses variables**
  (tableau + courbes), chaque échantillon à la période propre de la
  variable, y compris onglet inactif.
- **Destination** au choix :
  - **Navigateur** : tampon en mémoire de la page, plafond
    **100 000 lignes** (les plus anciennes éliminées, signalé dans l'état).
    Perdu au rechargement — à télécharger avant.
  - **Contrôleur** : `POST /api/datalog` (back-end à venir) ; tant qu'il est
    injoignable, avertissement et repli sur le tampon navigateur.
- État affiché : en cours/arrêt, nb d'échantillons, nb de variables, durée
  couverte, taille CSV estimée. Actions : démarrer/arrêter, télécharger
  **CSV** (`horodatage_iso;t_s;adresse;valeur`) ou **JSON**
  (`{app:'diagweb-journal', version, tab, rows:[[t,addr,v]…]}`), vider.
- L'activation et la destination sont mémorisées dans la session (la
  journalisation redémarre au rechargement si elle était active).

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

- Responsive mobile d'abord ; barre supérieure collante, barre d'état fixe
  en bas (source, nb de variables, nb d'onglets). **Pas de ligne de
  titre** : la première ligne porte l'**icône de l'application** puis les
  onglets (＋ inclus), et à droite le tag de version, le bouton de **repli
  de la zone de configuration** (⌃/⌄) et le **menu burger ☰**.
- **Menu burger ☰ = fonctions globales** (indépendantes des onglets) :
  aujourd'hui Basculer le thème et À propos (version, mode) ; réservé aux
  futures fonctions globales (capture d'interfaces réseau, notes de
  version…, affichées « à venir »). Fermé par sélection ou appui à
  l'extérieur.
- **Actions de l'onglet actif**, dans une rangée sous la barre d'onglets
  (elle défile avec le contenu) : + Graphique · Configs · Journal (point ⏺
  si journalisation active) · Figer/Reprendre.
- **Repli de la zone de configuration** via ⌃/⌄ : masque la recherche +
  cible + période + Ajouter **et** la rangée d'actions de l'onglet
  (+ Graphique / Configs / Journal / Figer) ; l'état est mémorisé dans le
  navigateur. Replié, il ne reste que la ligne des onglets (~63 px sur
  téléphone) et le contenu.
- La barre reste **empilée** (onglets / zone de configuration) jusqu'à
  1100 px — y compris téléphone en paysage — et passe sur une seule ligne
  au-delà.
- **Identification de version** tout en haut à droite, en face de la barre
  d'onglets : `hash court · #n`
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
- [x] Onglets multiples (une configuration par onglet, session v2)
- [x] Configurations : session, navigateur, export JSON + CSV, import JSON,
      ★ auto, stub contrôleur
- [x] Journalisation par onglet (navigateur ; contrôleur en stub)
- [x] Période de rafraîchissement par variable (défaut 10 ms)
- [x] Simulation (catalogue ~37 variables + hors catalogue, période honorée)
- [x] Thèmes clair/sombre, responsive téléphone → 32″
- [ ] Back-end embarqué (WebSocket + /api/layouts) — phase 2
- [ ] Enregistrement/relecture, export CSV, seuils/alarmes — phase 3
