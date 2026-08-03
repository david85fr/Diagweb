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

Deux processus distincts cohabitent sur le contrôleur :

1. **Processus cœur** (C++) — le cœur du produit : exécution temps réel,
   modèles Simulink générés en C (exposés via la C API), gestion du bus de
   terrain et du mapping PLC (`I/Q/M/S`, registres `MB`).
2. **Processus serveur de diagnostic** — sert les pages web de Diagweb
   **et** relaie le flux temps réel des variables : c'est par lui que
   transitent toutes les valeurs à diagnostiquer.

Chemin des données : `cœur PLC embarqué → serveur de diag → navigateur`.
Le navigateur ne parle jamais directement au processus cœur ; le serveur de
diag s'abonne aux variables demandées auprès du cœur (IPC local) et pousse
les échantillons au navigateur (WebSocket).

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

- Aucune connexion au contrôleur : une **simulation locale** (10 Hz) génère
  des signaux plausibles pour toutes les adresses saisies.
- Toutes les fonctions d'interface sont opérationnelles : recherche/ajout,
  tableau numérique, graphiques multi-échelles, dispositions
  (navigateur + export/import fichier ; l'enregistrement « contrôleur » est
  un stub qui échouera proprement tant que le back-end n'existe pas).

## Feuille de route

1. **Prototype front-end** (ce dépôt, en cours) — itérations sur l'UX.
2. **Back-end embarqué** : service sur le contrôleur exposant
   - un WebSocket de streaming des valeurs (abonnement par adresse, période
     par variable),
   - la résolution des adresses (mapping PLC, registres, C API Simulink),
   - le stockage des configurations (`/api/layouts`),
   - la journalisation côté contrôleur (`/api/datalog`).
3. **Branchement** : remplacer la simulation par ce back-end via le contrat
   `DataSource` (voir `docs/SPECS.md` §7) — le reste de l'UI ne change pas.
4. Ensuite : enregistrement/relecture de séquences, export CSV, alarmes/seuils.
