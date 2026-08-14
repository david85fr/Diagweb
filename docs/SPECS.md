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
| NET | `@lien.point` — point lu par le serveur de diagnostic sur un **lien réseau** (voir `docs/PROTOCOLES.md`) ; identifiants `[A-Za-z][A-Za-z0-9_-]{0,23}` | `@banc.pression` | selon le point |

- Une adresse bien formée mais absente du catalogue est acceptée (« hors
  catalogue ») : le simulateur lui invente un signal plausible du bon type.
- Le préfixe **« @ »** est réservé aux points réseau : il est reconnu avant
  toute autre famille, donc sans ambiguïté possible. L'adressage propre au
  protocole (registre, IOA, PGN/SPN, index, référence d'objet) vit dans la
  configuration du point, jamais dans l'adresse — un registre peut être
  corrigé sans casser les dispositions enregistrées.
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
  (familles I/Q/M/S), « Modbus » (registres MB), « Matlab » (signaux
  C API), « Réseau » (points des liens, famille NET). Sélection exclusive,
  conservée pendant la saisie ; le filtre s'applique aussi à la ligne « hors
  catalogue ».
- Le vivier de suggestions est le catalogue du contrôleur **plus** les points
  déclarés dans les liens réseau : un point configuré est proposé à la frappe
  comme n'importe quelle variable.
- Sélecteur de **cible** : chaque tableau et chaque graphique de l'onglet,
  puis « → Nouveau tableau » et « → Nouveau graphique ». Ces deux dernières
  entrées **créent la tuile aussitôt** et la visent : créer une tuile et
  choisir sa cible sont le même geste, au même endroit — il n'y a plus de
  boutons « + Tableau » / « + Graphique » ailleurs dans la page.
- **Étiquettes de famille** : `PLC`, `MB`, `Matlab`, `ext.<protocole>`. Elles
  ont toutes la **largeur d'« ext.MB »** (six caractères), pour que les
  adresses s'alignent d'une ligne à l'autre ; seuls les badges de protocole
  plus longs (`ext.61850`, `ext.CANopen`) la dépassent — les rétrécir les
  rendrait illisibles.
- **Période de rafraîchissement** optionnelle par variable, choisie au
  moment de l'ajout (sélecteur à côté de la cible) : **10 ms par défaut**,
  valeurs proposées 10 / 20 / 50 / 100 / 200 / 500 ms / 1 s. La période est
  conservée dans les dispositions. Si la même adresse est demandée avec
  deux périodes différentes, la plus courte l'emporte (un seul flux par
  variable).
- Un **point réseau** impose sa propre période (celle de sa configuration) :
  le sélecteur de période de la barre de recherche ne s'y applique pas.
- Les deux chemins d'ajout — saisie directe d'une variable interne, ou
  déclaration préalable d'un point réseau — se rejoignent sur cette même
  barre : schéma dans `docs/PROTOCOLES.md` § « Saisir la configuration ».
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
- La recherche, la cible d'ajout (création de tuile comprise), la pause et le
  Journal agissent sur l'onglet actif.
- La session (v2) mémorise tous les onglets, l'onglet actif et l'état de
  journalisation de chacun.

## 2 ter. Déplacement de widgets (multi-écran)

Un **widget** — un graphique, le tableau numérique entier, ou une variable
isolée — se déplace **avec sa configuration** (courbes, échelles dédiées,
décalages, fenêtre de temps, taille, périodes de rafraîchissement).

- **Glisser-déposer** par la poignée « ⠿ » (en-tête du graphique, en-tête
  du tableau) ou en glissant une ligne du tableau : vers un **onglet** de la
  barre, vers la zone de contenu (onglet courant), sur un **autre graphique**
  pour ranger la grille, ou vers une **autre fenêtre du navigateur** (même
  origine). Déposer un graphique sur la grille de son propre onglet le
  **range** (il n'est ni copié ni recréé).
- **Menu ⋮ du graphique** : « Déplacer vers l'onglet … » (une entrée par
  onglet) et « Ouvrir dans une nouvelle fenêtre ». Indispensable sur écran
  tactile, où le glisser-déposer HTML5 n'existe pas.
- L'onglet actif **ne change pas** quand on dépose ailleurs : on range sans
  quitter ce qu'on regarde ; un message indique la destination.
- **Sécurité du déplacement** : la source ne retire son widget qu'après
  l'accusé de réception de la cible (`BroadcastChannel`, même origine).
  Sans accusé — autre navigateur, page ouverte en fichier local — le widget
  est **copié** : jamais de perte. L'attente est armée dès le début du
  glisser (entre fenêtres, la cible traite le dépôt avant le `dragend` de
  la source) et expire au bout de 2,5 s.
- Transfert vers une nouvelle fenêtre : la configuration transite par le
  stockage local sous une clé éphémère (2 min), consommée au démarrage de
  la fenêtre ouverte (`?open=<id>`, l'adresse est aussitôt nettoyée).

**Session par fenêtre** : l'espace de travail (onglets, widgets,
journalisation) est mémorisé dans le stockage **de session**, propre à
chaque onglet/fenêtre du navigateur — deux fenêtres affichent donc deux
espaces différents sans se marcher dessus. Les **configurations nommées**
restent partagées entre toutes les fenêtres (stockage local).

## 3. Tableaux numériques

- Un onglet porte **autant de tableaux qu'on veut** (« → Nouveau tableau »
  dans la liste des destinations), chacun étant une **tuile de la mosaïque**
  au même titre qu'un graphique (§3 bis) : même placement libre, même poignée
  de dimensionnement. Un tableau regroupe ce qui se lit ensemble ; deux
  tableaux séparent deux sujets, ce qu'une seule liste ne sait pas faire.
  Chaque tableau a son **nom** (modifiable, il sert de destination d'ajout),
  son bouton **＋** et son menu **⋮** — le même jeu de gestes que celui d'un
  graphique : ajouter des variables, vider, taille de départ, **dupliquer ce
  tableau**, **déplacer vers un onglet**, **ouvrir dans une nouvelle
  fenêtre**, fermer.
- Colonnes : badge famille, adresse (mono), libellé, valeur vivante, unité,
  tendance (↗/↘/→ sur ~2,5 s, sauf bits), bouton **✎** (renommer), bouton
  retirer.
- Bits : LED + 0/1. Mots `MB` : décimal + hexadécimal `0xNNNN`.
- **Nom d'affichage** (✎ sur la ligne, ou « Renommer la courbe… » pour une
  courbe) : remplace le libellé du catalogue à l'écran, sans changer
  l'adresse. Vide = retour au libellé d'origine. Mémorisé dans la
  configuration (`name` sur l'entrée de tableau et sur la courbe) et suivi
  lors d'une duplication ou d'un déplacement.
- **Flash de changement** : une variable dont la valeur était immobile
  depuis **≥ 2 s** et qui change à nouveau fait flasher sa ligne (fond
  accentué qui s'estompe en ~1 s). Repère immédiat des variables qui
  bougent, même pour un changement d'un seul cycle. (Les grandeurs
  continues, qui changent en permanence, ne flashent donc pas.)
- **Format des dispositions** : `{version: 3, tables: [{name, x, y, w, h,
  entries}], charts: [{…, x, y, w, h}]}` — la place et la taille de chaque
  tuile, en colonnes et en rangées (§3 bis). Les formats v1 et v2 (rang `pos`
  dans une grille en flux, hauteur en pixels, largeur en colonnes
  « naturelles ») restent **lus** et convertis à l'ouverture : chaque carte
  est reposée à la première place libre, dans son ancien ordre — le flux
  d'origine est reproduit.
- **Défilement interne** : réduite en hauteur, la tuile ne rogne pas ses
  lignes, elle **défile à l'intérieur** — les tuiles voisines ne bougent pas.
- **Forçage** (diagnostic) : suffixe `= valeur` dans la barre de recherche
  (`Q0.3 = 1`, `MB400 = 12500`) impose la valeur **côté serveur** ; la ligne
  est surlignée et porte un ⏻ qui relâche. Les bits sont ramenés à 0/1. Les
  points réseau `@lien.point` restent en **lecture seule** (refusés). Voir §7
  (commande `set` du contrat) et §7 bis.
- Rafraîchissement ~5 Hz. Masqué quand il est vide.

## 3 bis. Mosaïque (placement et dimensionnement libres)

Tableaux et graphiques sont la même chose pour la mise en page : des **tuiles**
rectangulaires posées sur une grille de **douze colonnes** fractionnaires et de
rangées de hauteur fixe (30 px, 33 au-delà de 1700 px, 36 au-delà de 2300).
Chaque tuile porte `x`, `y`, `w`, `h` — colonne, rangée, largeur, hauteur.

**Pourquoi une grille explicite.** La version précédente laissait la grille CSS
placer les cartes toute seule (`auto-fit`), la largeur étant exprimée en
« colonnes naturelles » dont le nombre changeait avec la fenêtre. Conséquences :
on ne pouvait que **ranger** les cartes les unes après les autres — jamais en
poser une à un endroit choisi — et la même carte n'avait pas la même largeur
d'un écran à l'autre. Avec `x/y/w/h`, la tuile va où on la met, et la
disposition se transpose telle quelle d'un poste à l'autre.

Deux règles de comportement, celles d'un tableau de bord :

1. **poussée** — une tuile posée sur une autre la repousse vers le **bas**,
   jamais sur le côté (le côté ferait valser toute la ligne). La tuile tenue
   sous la main ne bouge jamais : ce sont les autres qui lui font place ;
2. **gravité** — les tuiles remontent tant qu'il y a de la place au-dessus,
   donc pas de trou involontaire après un déplacement ou une suppression.

**Déplacer** : poignée ⠿, glisser-déposer. Un **rectangle d'atterrissage**
occupe, dans la grille, la place exacte que prendra la tuile — ce n'est pas une
approximation dessinée par-dessus. La même poignée emmène la tuile sur un
**onglet** ou dans une **autre fenêtre** du navigateur : un geste, trois
destinations.

**Redimensionner** : poignée ◢ (coin bas-droit), largeur **et** hauteur, par
cellules entières, avec réagencement à chaque cellule franchie. Le contenu suit
la tuile — le tableau défile à l'intérieur, le graphique s'étire — sans quoi la
hauteur tirée resterait sans effet visible. Double-clic : taille de départ
(tableau 12×7, graphique 6×9). Bornes : 2 colonnes et 3 rangées au minimum.

**Téléphone** (< 700 px) : la mosaïque se replie en **une colonne**, les tuiles
empilées dans l'ordre (y, x) ; la poignée disparaît. Le modèle est conservé —
la disposition d'un poste de travail se retrouve intacte au retour sur grand
écran — et la **hauteur** choisie est traduite en pixels plutôt que perdue.

Le moteur est dans `web/js/mosaic.js` : géométrie pure (poussée, gravité,
première place libre, cellule visée) plus la poignée de dimensionnement,
partagée par les deux natures de tuile.

## 4. Graphiques

- Nombre de graphiques au choix (max 8), grille responsive : 1 colonne sur
  téléphone, `auto-fit minmax(380px)` au-delà, `minmax(500px)` ≥ 1700 px,
  `minmax(620px)` ≥ 2300 px ; conteneur jusqu'à 2300 px (écrans 32″).
- Par graphique : titre éditable, fenêtre de temps (préréglages 15 s → 5 min
  + valeur continue par zoom), pause locale (+ pause de l'onglet), menu ⋮
  (échelles automatiques, taille, plein écran, fermeture). Max 8 courbes
  par graphique (palette fixe).
- **Taille** : le graphique est une tuile de la mosaïque (§3 bis) — largeur et
  hauteur libres à la poignée ◢, taille de départ 6 colonnes × 9 rangées, menu
  ⋮ → « Taille de départ » pour y revenir. Le tracé **remplit** la tuile : la
  hauteur tirée se voit sur le tracé, pas seulement sur la carte. **Plein
  écran** par graphique (menu ⋮, sortie par Échap ou le menu).
- **Toutes les règles d'axes sont à gauche**, empilées dans l'ordre des badges
  `Én`, la première collée au tracé. En alternant gauche et droite, lire une
  valeur demandait de chercher de quel bord venait l'échelle de la courbe
  suivie ; le tracé garde en outre toute la largeur à droite.
- Sur canvas étroit (< 520 px) : règles d'axes compactes (38 px), 2 règles
  visibles au maximum (les groupes suivants gardent leur mise à l'échelle,
  badge « É· ») ; ≥ 1100 px : règles de 50 px, police 11 px.
- **Duplication** : menu ⋮ → « Dupliquer ce graphique ». La copie reprend
  toute la configuration (courbes, couleurs, échelles dédiées, décalages,
  fenêtre, taille), s'intitule « … (copie) » et s'insère juste après
  l'original.
- **Rangement** : glisser un graphique par sa poignée « ⠿ » sur un autre
  graphique de la même grille le range avant ou après lui (un repère
  vertical indique le point d'insertion, selon la moitié survolée). L'ordre
  est conservé dans la configuration.
- Légende : pastille couleur, adresse, valeur vivante + unité, badge
  d'échelle « Én ». Un appui ouvre le menu de la courbe : **choix de la
  couleur**, masquer/afficher, **échelle dédiée**, décaler, retirer.
- **Couleur d'une courbe** (en tête de son menu) : les 8 emplacements de la
  palette, ou une **teinte libre** (sélecteur du navigateur). Un
  emplacement de palette suit le thème clair/sombre (c'est la position qui
  est mémorisée, `colorIdx`) ; une teinte libre est fixe et identique dans
  les deux thèmes (`color`, hex). Les deux sont conservées dans les
  configurations et lors d'une duplication ou d'un déplacement.
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

## 4 bis. Figer (tuile ou onglet)

**⏸** sur une tuile fige cette tuile ; **⏸ Figer** dans la barre du haut fige
tout l'onglet — graphiques **et** tableaux. Figer arrête ce qu'on lit, pas
seulement ce qu'on trace :

- les **valeurs numériques** (tableau et légendes) sont lues à l'instant du
  gel, par recherche dichotomique dans l'historique à un **temps absolu** — et
  non par un recul relatif au dernier échantillon, dont le repère bouge avec
  les échantillons qui continuent d'arriver ;
- la **grille temporelle** est ancrée sur le bord droit de la vue, plus sur
  l'heure courante : elle ne glisse donc plus sous un graphique figé ;
- un badge **⏱ −durée** dans l'en-tête de chaque tuile figée dit de quand
  datent les valeurs affichées. Sans lui, des valeurs figées se lisent comme
  des valeurs actuelles.

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

Configuration (une par onglet) : `{version: 3, tables: [{name, x, y, w, h,
entries: [{addr, periodMs?, name?}]}], charts: [{title, windowS, x, y, w, h,
series: [{addr, axisMode: 'auto'|'solo', visible, periodMs?, offsetY?,
colorIdx?, color?}]}]}`. `periodMs` absent = 10 ms ;
`x`, `y`, `w`, `h` = place et taille de la tuile dans la mosaïque, en colonnes
et en rangées (§3 bis) ;
`offsetY` = décalage vertical (unités de la variable, absent = 0) ;
`colorIdx` = emplacement de palette (suit le thème), `color` = teinte libre
en hexadécimal qui, si présente, l'emporte. L'ordre du tableau `charts`
est l'ordre d'affichage dans la grille. Le lecteur
accepte aussi les entrées de tableau sous forme de simple chaîne (format
initial).

Session (navigateur) : `{version: 2, active, tabs: [{name, log: {enabled,
dest}, data: <configuration v1>}]}` ; une session v1 (une seule
configuration à la racine) est acceptée et convertie en un onglet.

- **Session** : l'espace de travail courant est sauvegardé en continu
  (stockage de session, propre à la fenêtre, debounce 500 ms) et restauré au
  rechargement. Une ancienne session partagée est reprise une seule fois.
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
  `echelle;visible;decalage` — une ligne par variable du tableau et par courbe.
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
  - **Serveur (autonome)** : le serveur de diagnostic — qui est aussi serveur
    d'acquisition — enregistre lui-même sur disque
    (`<data-dir>/datalog/<onglet>.csv`) et **continue même la page fermée ou
    rechargée**. Il garde ses propres abonnements, indépendamment de tout
    client WebSocket. Au rechargement, la pastille d'enregistrement est
    réalignée sur l'état réel du serveur. Le CSV se télécharge à tout moment.
    Indisponible si la page n'est pas servie par le serveur (fichier local,
    Artifact) : l'option est alors désactivée.
- État affiché : en cours/arrêt, nb d'échantillons, nb de variables ; taille
  du fichier (serveur) ou durée couverte et taille CSV estimée (navigateur).
  Actions navigateur : démarrer/arrêter, télécharger **CSV**
  (`horodatage_iso;t_s;adresse;valeur`) ou **JSON**
  (`{app:'diagweb-journal', version, tab, rows:[[t,addr,v]…]}`), vider.
  Actions serveur : démarrer/arrêter, télécharger le CSV.
- REST (serveur) : `GET /api/datalog` (état des campagnes), `POST
  /api/datalog/start` (`{name, addrs:[{addr,periodMs}]}`), `POST
  /api/datalog/stop` (`{name}`), `GET /api/datalog/file?name=` (CSV). Le nom
  de campagne est celui de l'onglet (assaini : `/ \ . :` remplacés).
- L'activation et la destination sont mémorisées dans la session (la
  journalisation navigateur redémarre au rechargement si elle était active ;
  la journalisation serveur, elle, n'a jamais cessé).

## 7. Contrat DataSource (frontière front/back)

```
            web/js/source.js — choix de la source au démarrage
            (?src=sim|ws · sinon sonde GET /api/health)
                                    │
                     ┌──────────────┴───────────────┐
                     ▼                              ▼
        ┌──────────────────────────┐   ┌──────────────────────────┐
        │ sim.js                   │   │ source-ws.js             │
        │ simulation locale        │   │ WebSocket /ws ───────────┼──► serveur de diagnostic
        │ générateurs par adresse, │   │ sub/unsub, reconnexion,  │
        │ horizon 330 s            │   │ recalage d'horloge       │
        └────────────┬─────────────┘   └────────────┬─────────────┘
                     └──────────────┬───────────────┘
                                    ▼
                     DW.source — contrat DataSource
           subscribe(addr, {periodMs}) · unsubscribe · latest
                    past · data · meta · now · count
                                    │
            ┌───────────────────────┴─────────────────────┐
            ▼                       ▼                     ▼
         app.js                 chart.js              store.js
   onglets, recherche,       courbes canvas,      session, configs,
    tableau, journal         multi-échelles        export JSON/CSV
```

`DW.source` expose : `name`, `defaultPeriodMs`, `now()`,
`subscribe(addr, {periodMs})` (comptage de références ; une seconde
souscription avec une période plus courte resserre le flux existant),
`unsubscribe(addr)`, `latest(addr)`, `past(addr, delta)`, `data(addr)` →
`{ts[], vs[]}` (secondes, croissant), `meta(addr)`, `count()`, et, pour le
**forçage** (diagnostic) : `write(addr, value)` → `Promise<{ok, error?}>`
(value `null` relâche) et `forced(addr)` → valeur forcée ou `null`. Les
points réseau sont refusés (lecture seule). Côté WebSocket, `write` envoie
`{c:'set', addr, value}` (ou `{…, release:1}`) et le serveur confirme par
`{e:'set', addr, ok, value}` ; la simulation locale tient la valeur elle-même.

**Robustesse de la source WebSocket** : au message `hello`, si l'horloge du
serveur a **reculé** (redémarrage du serveur en cours de session), les
tampons d'historique sont **vidés** avant de repartir — sans cela la
déduplication (`t ≤ dernier t`) rejetterait tout échantillon neuf et les
courbes gèleraient.

**Deux implémentations** interchangeables, choisies au démarrage par
`web/js/source.js` (`DW.sourceReady` est attendue par `app.js` avant de
construire l'espace de travail) :

| Source | Fichier | Sélection |
|---|---|---|
| Simulation locale | `web/js/sim.js` | par défaut, et repli |
| Serveur de diagnostic | `web/js/source-ws.js` | si `GET /api/health` répond `role: diag-server` |

Forçage par l'URL : `?src=sim` ou `?src=ws`. En cas de coupure, la source
WebSocket se reconnecte (attente exponentielle plafonnée à 8 s), se
réabonne et en informe l'utilisateur.

Côté contrôleur (voir `docs/PROJET.md`, « Architecture cible ») : le
navigateur ne dialogue qu'avec le **processus serveur de diagnostic**, qui
sert les pages et relaie le flux temps réel depuis le **`controller`** (le
processus cœur, C++). La période de rafraîchissement de chaque abonnement
(défaut 10 ms) est transmise au serveur de diag, qui échantillonne le
`controller` en conséquence.

### Protocole du flux (WebSocket `/ws`, trames texte JSON)

- client → `{"c":"sub","addr":…,"periodMs":…}` · `{"c":"unsub","addr":…}` ·
  `{"c":"set","addr":…,"value":…}` (forçage ; `{…,"release":1}` relâche)
- serveur → `{"e":"hello","now":…,"horizonS":…,"defaultPeriodMs":…,"source":…}`,
  puis `{"e":"meta",…}` par variable, `{"e":"err","addr":…,"msg":…}`,
  `{"e":"set","addr":…,"ok":…,"value":…}` (confirmation de forçage) et les
  lots `{"e":"d","now":…,"s":{"<adresse>":[[t,v],…]}}`.
- `t` est en secondes depuis le démarrage du serveur ; le navigateur recale
  son horloge sur `now` (lissage de la gigue réseau).
- À l'abonnement, le serveur envoie l'historique récent (60 s, décimé à
  1 500 points par variable) ; ensuite, lots toutes les 60 ms.
- Les métadonnées du serveur (libellé, unité, type) font autorité et
  complètent celles déduites du catalogue local.

Points d'entrée REST du même serveur : `/api/health`, `/api/layouts`
(liste, lecture, enregistrement) et `/api/datalog` (journal en JSON Lines).

L'implémentation de référence est `server/` (C++20, sans dépendance) : voir
`server/README.md`, et `server/src/source.hpp` pour le contrat côté serveur
(`IVariableSource`) — seul point à réimplémenter pour brancher le
`controller`.

## 7 bis. Liens réseau (protocoles industriels)

Le serveur de diagnostic lit aussi des variables sur des **équipements tiers**.
Spécification détaillée : `docs/PROTOCOLES.md`. En résumé :

- **Modèle** : un *lien* (protocole + paramètres de connexion) porte des
  *points* (variables lues). Adresse Diagweb : **`@lien.point`** (famille NET).
- **Protocoles** : Modbus TCP, Modbus RTU (série), IEC 60870-5-104, CAN brut,
  J1939 (transport multi-trames compris), CANopen, **SNMP v1, v2c et v3 (USM)**,
  **OPC UA (IEC 62541)**, **IEC 61850** dans ses quatre mécanismes (GOOSE,
  Sampled Values, lecture MMS, rapports BRCB/URCB) — tous implémentés. SNMP v3
  s'appuie sur Net-SNMP (authentification MD5/SHA-1/SHA-256, chiffrement
  DES/AES-128) ; un serveur compilé sans cette bibliothèque sert encore v1 et
  v2c et annonce v3 « non branché ». Un lien réglé en v3 ne retombe **jamais**
  en silence sur v2c, ce qui viderait de son sens le choix de v3.
- **Bibliothèques tierces** : autorisées côté serveur si leur licence reste
  **gratuite en produit commercial fermé** (MIT, BSD, Apache-2.0, MPL-2.0…) ;
  refusées si GPL/AGPL ou en double licence dont l'usage commercial se paie.
  L'interface web garde sa règle de **zéro dépendance**. Licences vérifiées et
  décisions consignées dans `docs/PROTOCOLES.md` § « Bibliothèques externes et
  licences ». **Deux dépendances à ce jour**, toutes deux facultatives :
  **open62541** (MPL-2.0) pour OPC UA, débranchable par
  `-DDIAGWEB_WITH_OPCUA=OFF`, et **Net-SNMP** (BSD) pour SNMP v3,
  débranchable par `-DDIAGWEB_WITH_NETSNMP=OFF`. **IEC 61850 n'a aucune pile C
  permissive** — les stacks matures sont GPLv3 ou payantes.
- **Sécurité OPC UA** : le chiffrement demande OpenSSL (option de compilation
  `DIAGWEB_OPCUA_ENCRYPTION`). Sans elle, un lien réglé en signature ou
  chiffrement **refuse de s'ouvrir** — jamais de repli silencieux en clair.
  Le mot de passe ne figure pas dans la configuration : celle-ci ne porte
  qu'une référence, résolue dans l'environnement du serveur
  (`DIAGWEB_SECRET_<RÉFÉRENCE>`).
- **IEC 61850** : le *mécanisme* se choisit sur le lien (GOOSE, Sampled Values,
  lecture MMS, rapports) et les champs du point s'adaptent. GOOSE et SV sont
  des trames Ethernet de niveau 2 : elles demandent la capacité `CAP_NET_RAW`
  au service, refusent par défaut les trames marquées « simulation », et
  n'émettent jamais rien. MMS et les rapports passent par la pile ISO complète,
  écrite dans le projet faute de bibliothèque sous licence acceptable — validée
  contre un IED simulé, l'interopérabilité réelle restant à éprouver sur site.
- **Un dossier par protocole** : chaque pilote vit dans
  `server/src/drivers/<protocole>/`, le partagé dans `drivers/common/`.
  `tools/check-drivers.mjs` (rejoué par la CI) refuse un protocole sans
  dossier, un dossier sans protocole, ou un en-tête resté à la racine.
- **Aucun secret dans la configuration des liens** : `protocols.json` est
  lisible par tout poste connecté et s'exporte en clair. Un nom d'utilisateur
  peut y figurer, jamais un mot de passe ni une clé privée — la configuration
  ne porte qu'une *référence* vers le magasin de secrets du contrôleur.
- **Lecture seule de bout en bout** : aucune écriture n'est possible depuis
  Diagweb (pas de commande Modbus ni de télécommande 104, pas d'émission
  CAN, ni `Write`/`Call` en OPC UA, ni `SetRequest` SNMP). Deux exceptions
  bornées et explicites : l'activation d'un **bloc de rapport IEC 61850**
  (`TrgOps`, `IntgPd`, `RptEna` — les attributs du bloc, jamais une donnée de
  procédé), et la requête de lecture SDO CANopen, **désactivée par défaut** (« Écoute seule »), car interroger un nœud absent peut mener le
  contrôleur CAN au bus-off — et, même logique, la **demande de PGN J1939**,
  option portée par le point et décochée par défaut. Le réassemblage BAM des
  PGN multi-trames reste, lui, entièrement passif.
- **Saisie** : ☰ → « Liens réseau… » — liste des liens avec leur état
  (● connecté · ⚠ en défaut avec la cause · ○ désactivé · ⋯ non branché ·
  ~ simulé), édition, test de connexion, points, export/import JSON.
  Le parcours complet — déclarer un lien, ses points, puis les ajouter au
  diagnostic — est décrit et schématisé dans `docs/PROTOCOLES.md`
  § « Saisir la configuration », avec un exemple Modbus TCP de bout en bout.
- **Description unique** : `web/js/protocols.js` décrit les champs de chaque
  protocole (libellés et aides en français) ; `tools/gen-protocols.mjs` en
  dérive `server/src/protocols.generated.hpp`. L'interface construit ses
  formulaires à partir de cette description : **ajouter un protocole ne
  demande aucune modification de l'interface**.
- **Persistance** : `<data-dir>/protocols.json` côté contrôleur (partagée
  entre postes, rechargée au démarrage). Page ouverte hors serveur : la
  configuration reste dans le navigateur et les valeurs sont **simulées**, ce
  qui permet de préparer une configuration sans matériel.
- **Période** : cadence d'interrogation pour Modbus et SDO ; **décimation**
  pour les protocoles à flux (104, CAN) — un changement de valeur passe
  toujours, une variable bavarde ne sature pas l'historique.
- **Qualité** : valeur invalide (bit IV), exception Modbus, abandon SDO ou
  lien coupé ⇒ **aucun échantillon publié** (trou dans la courbe), la cause
  étant lisible dans l'état du lien.
- **Horodatage** : quand le protocole transporte la date de l'événement, c'est
  elle qui est retenue (IEC-104 types horodatés, GOOSE, Sampled Values,
  rapports, OPC UA en abonnement). SNMP n'en transporte aucune, mais une MIB
  peut en exposer une : le point désigne alors un **OID d'horodatage**
  compagnon (`DateAndTime` ou `TimeTicks`), lu dans la même requête que la
  valeur. Le choix est **par point** : « de
  l'équipement si disponible » (défaut) ou « du serveur (forcé) », pour une
  horloge d'équipement qui n'est pas de confiance. La date reçue n'est pas
  recopiée : son **écart** à l'heure courante est appliqué, afin que toutes les
  courbes restent comparables ; au-delà de l'écart admis par le lien (10 s par
  défaut), elle est écartée avec un message. Détail dans `docs/PROTOCOLES.md`
  § « Horodatage : à la source, ou du serveur ».
- REST : `GET/PUT /api/protocols`, `GET /api/protocols/status`,
  `POST /api/protocols/test`.

## 8. Interface générale

- Responsive mobile d'abord ; barre supérieure collante, barre d'état fixe
  en bas (source, nb de variables, nb d'onglets). **Pas de ligne de
  titre** : la première ligne porte l'**icône de l'application** puis les
  onglets (＋ inclus), et à droite le tag de version, le bouton de **repli
  de la zone de configuration** (⌃/⌄) et le **menu burger ☰**.
- **Menu burger ☰ = fonctions globales** (indépendantes des onglets) :
  Basculer le thème, **Apparence** (logo et couleurs, §8 bis),
  **Configurations** (§6), **Journal de données** (§6 bis — point ⏺ tant
  qu'un enregistrement tourne), Aide
  (commandes et gestes), **Liens réseau** (configuration des protocoles
  industriels, §7 bis), À propos (version, mode) et les trois **pages
  réseau** (§8 ter) ; les notes de version restent affichées « à venir ».
  Fermé par sélection ou appui à l'extérieur.
- **Figer/Reprendre** est dans la **barre du haut**, à côté du tag de version :
  arrêter tous les graphiques est le geste qu'on fait dans l'urgence, il ne
  doit pas dépendre du repli de la zone de configuration.
- **Pas de rangée d'actions** sous les onglets : créer un tableau ou un
  graphique se fait dans la liste des destinations (§2), et les fonctions qui
  ne dépendent pas de ce qui est affiché sont dans le menu ☰. La barre du haut
  ne porte que ce qui sert à chaque instant.
- **Barre escamotable** : elle disparaît dès qu'on descend dans la page et
  revient dès qu'on remonte — la place gagnée va aux courbes, et le geste pour
  la retrouver est celui qu'on fait déjà. Elle réapparaît aussi dès que la page
  est en haut, et ne s'escamote jamais tant qu'un menu ou une fenêtre est
  ouvert. Le bouton de masquage manuel a donc disparu.
- **Carte visée** : un clic sur un tableau ou un graphique (hors ses boutons,
  champs et poignées) en fait la **destination d'ajout** de la barre du haut ;
  elle se signale par un liseré. Avec plusieurs cartes à l'écran, « Ajouter »
  cessait sinon d'être prévisible.
- **Repli de la zone de configuration** via ⌃/⌄ : masque la recherche, la
  cible, la période et Ajouter ; l'état est mémorisé dans le navigateur. Replié, il ne reste que la ligne des onglets (~63 px sur
  téléphone) et le contenu.
- La barre reste **empilée** (onglets / zone de configuration) jusqu'à
  1100 px — y compris téléphone en paysage — et passe sur une seule ligne
  au-delà.
- **Infobulles partout** : chaque objet interactif (onglets, boutons,
  champs, sélecteurs, badges de famille, lignes du tableau, suggestions,
  filtres, pastilles de légende, poignées, entrées de menu, nuancier)
  porte un `title` explicatif — pas seulement son intitulé, mais ce qu'il
  fait et ses conséquences. Vérifié par un test de couverture
  (`tests/ui.mjs`) qui balaie toutes les vues et échoue au moindre objet
  non documenté.
- **Aide** (menu ☰) : récapitulatif des commandes et des gestes — ajout de
  variables (dont forçage `= valeur` et carte visée), gestes sur le tracé,
  gestes sur les règles d'axes, organisation (poignées ⠿ et ◢, renommage,
  menus ⋮ des graphiques et des tableaux, onglets, barre du haut), pages
  réseau, apparence, liens réseau, courbes. Elle remplace les infobulles sur écran tactile, où
  elles n'apparaissent pas.
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

## 8 ter bis. Interface bilingue (français / anglais)

Un sélecteur dans le menu ☰ bascule l'interface entre **français** et
**anglais**. Le choix est mémorisé dans le navigateur et vaut pour toutes les
fenêtres du poste (annoncé par `BroadcastChannel`, comme l'apparence).

**La clé de traduction est le texte français lui-même**, pas un identifiant
inventé. Dans un logiciel déjà écrit et déjà volumineux, c'est ce qui coûte le
moins et rapporte le plus : une traduction manquante laisse le français à
l'écran — jamais une clé brute ni un libellé vide — le code reste lisible tel
quel (on lit la phrase, pas `menu.table.duplicate`), et la reprise n'a pas
demandé de toucher aux centaines d'appels existants.

La traduction s'applique **au DOM**, pas aux appels : un `MutationObserver`
traduit ce qui apparaît — fenêtres, menus, messages éphémères, pages réseau —
sans que le reste du code sache qu'il existe une seconde langue. Un paragraphe
mêlant du texte et des `<b>` est traduit **d'une pièce** (sinon on n'aurait que
des morceaux de phrase) ; tout élément portant autre chose que de la mise en
forme en ligne est traité nœud par nœud, pour ne jamais remplacer du texte mêlé
à des valeurs mesurées. Seuls les textes dessinés au canevas passent par
`DW.t()`, faute de nœud à observer.

Changer de langue **recharge la page** : la session est déjà restaurée au
chargement, on évite ainsi tout état à moitié traduit.

`node tools/check-i18n.mjs` mesure la couverture en parcourant toutes les vues
de l'application **rendue** — une phrase construite par concaténation n'existe
nulle part dans les sources, seulement à l'écran, et c'est elle que le
dictionnaire doit porter.

## 8 bis. Apparence (logo et couleurs de l'installation)

L'outil est déployé chez des exploitants différents : l'interface doit pouvoir
porter **leur** identité, sans recompilation ni fichier à déposer sur le
contrôleur.

- **Logo** : une image fournie par l'opérateur (PNG, JPEG, SVG, WebP) remplace
  le logo Diagweb dans la barre supérieure et sert d'**icône d'onglet**. Elle
  est réduite (128 px de haut) puis **incorporée** en `data:` — jamais une URL :
  la page doit se servir hors ligne depuis le contrôleur, et la page publiée
  l'est sous CSP stricte. Le fichier est rendu dans une balise `<img>`, jamais
  injecté comme balisage : un SVG y est traité en image, ses scripts éventuels
  ne s'exécutent pas.
- **Couleurs** : six jetons réglables — accent, fond de page, cartes, fond
  secondaire, texte, traits. Les gris atténués et les nuances d'accent en sont
  **déduits**, pour qu'une palette cohérente demande six choix et non vingt.
  Aperçu immédiat sur l'interface entière. Réglages **propres à chaque thème**
  (clair et sombre gardent les leurs).
- **Portée** : page servie par le contrôleur ⇒ enregistrée sur lui
  (`<data-dir>/appearance.json`, `GET/PUT /api/appearance`), donc partagée par
  **tous les postes** ; page ouverte hors serveur ⇒ conservée dans le
  navigateur. Les fenêtres ouvertes sur la même origine se mettent à jour sans
  rechargement.
- **Garde-fous serveur** : 512 ko au plus, JSON valide exigé, et un logo qui
  n'est pas une image incorporée est **refusé** — sans quoi la configuration
  deviendrait un moyen de faire appeler un hôte tiers par toutes les pages.

## 8 ter. Pages réseau (audit, capture, voisinage)

Trois vues de diagnostic du **contrôleur**, ouvertes depuis le menu ☰ par-dessus
l'espace de travail — qui continue de tourner derrière. Elles sont servies par
le serveur de diagnostic.

**Hors serveur** (Artifact, page publiée, copie hors ligne), c'est
`web/js/netsim.js` qui répond à sa place, sur **les mêmes routes et les mêmes
formes de JSON** : l'interface de gestion reste visible et manipulable — on
démarre une capture, on la voit grossir, on l'arrête, on règle un quota, on
arme un déclencheur — ce qu'un écran d'excuse ne permettait pas. Deux règles
pour que la simulation ne se fasse jamais passer pour la réalité : un
**bandeau** sur chaque page, et **rien d'inventé qui prétende venir du
matériel** — une capture simulée n'offre aucun fichier à télécharger, puisqu'il
n'y a pas de trames derrière. Les réglages simulés (quota, déclencheur, délai
d'oubli LLDP) tiennent au rechargement, comme ceux du serveur tiennent au
redémarrage.

### Audit des communications

Répond à trois questions sans lire le code ni brancher un analyseur : qu'est-ce
qui entre, qu'est-ce qui sort, qui peut écrire quoi. **Deux vues, et c'est
voulu** :

- **observée** — les sockets que le processus a réellement ouvertes, lues dans
  `/proc/self/fd` (nos descripteurs) recoupées avec
  `/proc/self/net/{tcp,tcp6,udp,udp6,packet}`. Ne dépend d'aucune déclaration :
  c'est l'état du noyau. Une socket ouverte par mégarde y apparaîtrait ;
- **déclarée** — les liens configurés, leur protocole, leur cible, leurs points,
  la référence de leurs secrets et leur état.

Un écart entre les deux est une information, pas un défaut du rapport : un lien
en défaut n'a pas de socket ouverte. Le **sens** est déterminé par le port
local : une connexion acceptée sur un port où nous écoutons est *entrante*, pas
sortante — l'inverse tromperait un pare-feu. Le rapport se copie en texte.

### Capture d'interfaces réseau

`tcpdump` sur le contrôleur, au plus près du câble ; fichier **pcap** relisible
dans Wireshark. Une capture par interface (jamais `-i any`, qui mélangerait des
types de liens dans un même fichier) — **Ethernet et CAN** indifféremment.

Trois garde-fous, parce qu'une capture oubliée remplit un disque embarqué :

1. **quota global**, 100 Mo par défaut : atteint, les captures en cours
   s'arrêtent ; tcpdump lui-même est plafonné (`-C`) pour que même la chute du
   service ne puisse pas remplir le disque ;
2. **durée** maximale par capture ;
3. **déclenchement par une variable** de diagnostic (front montant d'une
   condition : non nulle, au-dessus, en dessous) — de quoi attraper l'incident
   rare sans laisser tourner la capture des heures.

Le quota et le déclencheur sont **persistants** : ils sont écrits à côté des
captures (`<data-dir>/captures/reglages.json`) et relus au démarrage, qui
réabonne la variable observée. Un déclencheur armé pour attraper un incident
rare et qui s'oublierait à la première coupure ne servirait à rien — et c'est
précisément la coupure qu'on cherche parfois à comprendre.

L'arrêt se fait par `SIGINT` : tcpdump ferme proprement son fichier, là où un
`SIGKILL` le laisserait tronqué, donc illisible. L'interface est vérifiée avant
le lancement — une faute de frappe se dit tout de suite, pas dans un journal.

### Voisinage réseau (LLDP)

Ce qu'il y a **en face** de chaque interface : produit, port, description,
adresse d'administration, VLAN natif, capacités, TTL annoncé. C'est la première
question d'un architecte devant une installation qu'il ne connaît pas, et elle
se répond sans plan de câblage à jour ni accès au commutateur.

**Écoute passive** : Diagweb n'émet aucune trame LLDP et ne se déclare donc pas
au voisinage. Une seule socket `AF_PACKET` sur l'EtherType 0x88CC suffit pour
toutes les interfaces. Un voisin qui cesse d'émettre disparaît au bout du
**délai d'oubli**, réglable, **dix minutes par défaut**.

**Capacité requise** : capture et LLDP demandent `CAP_NET_RAW` au service. Sans
elle, la page affiche le motif — jamais un tableau vide qu'on prendrait pour une
absence de voisins.

## 9. État d'avancement

- [x] Grammaire d'adresses + autocomplétion + gestion d'erreurs
- [x] Tableau numérique (LED, hexa, tendance)
- [x] Graphiques multi-échelles, curseur, pause, fenêtres de temps
- [x] Onglets multiples (une configuration par onglet, session v2)
- [x] Déplacement de widgets entre onglets et entre fenêtres (multi-écran)
- [x] Duplication de graphiques, rangement de la grille, couleur des courbes
- [x] **Mosaïque** : placement et dimensionnement libres des tuiles (12
      colonnes, poussée + gravité, rectangle d'atterrissage), repliée en une
      colonne sur téléphone ; format de disposition v3
- [x] Nom d'affichage par variable (tableau et courbes)
- [x] Forçage de variables (diagnostic) par suffixe `= valeur`, refusé pour
      les points réseau (lecture seule)
- [x] Infobulles sur tous les objets + fenêtre d'aide (gestes et commandes)
- [x] Liens réseau : Modbus TCP/RTU, IEC 60870-5-104, CAN, J1939, CANopen
      (pilotes implémentés et testés) ; IEC 61850 déclaré, pile ISO/MMS à venir
- [x] Intégration continue sur `main` : compilation `-Werror`, tests de
      décodage, liens réseau de bout en bout, interface, déplacement de
      widgets, en-têtes générés et livrables à jour (`.github/workflows/ci.yml`,
      rejouables en local par `bash tools/check.sh`)
- [x] Configurations : session, navigateur, export JSON + CSV, import JSON,
      ★ auto, stub contrôleur
- [x] Journalisation par onglet : navigateur (mémoire) ou **serveur autonome**
      (sur disque, continue page fermée ; REST /api/datalog/start|stop|file)
- [x] Période de rafraîchissement par variable (défaut 10 ms)
- [x] Simulation (catalogue ~37 variables + hors catalogue, période honorée)
- [x] Thèmes clair/sombre, responsive téléphone → 32″
- [x] Serveur de diagnostic C++ (squelette) : WebSocket, /api/layouts,
      /api/datalog, service des pages ; source encore simulée
- [x] Source WebSocket côté navigateur + bascule automatique
- [x] Plusieurs tableaux par onglet, mêlés aux graphiques, menu ⋮ complet sur
      les tableaux (dupliquer, déplacer, nouvelle fenêtre), tuile visée par un
      clic, création de tuile depuis la liste des destinations
- [x] Apparence : logo de l'exploitant et couleurs de l'interface, partagés
      par tous les postes quand le contrôleur sert la page
- [x] Pages réseau : audit des communications, capture d'interfaces (quota,
      durée, déclencheur **persistants**), voisinage LLDP — et leur
      back-end **simulé** pour la page publiée
- [ ] Binding du `controller` derrière `IVariableSource` — phase 2
- [ ] Enregistrement/relecture, export CSV, seuils/alarmes — phase 3
