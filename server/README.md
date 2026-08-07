# Serveur de diagnostic — prototype

Processus qui **sert les pages web** et **relaie le flux temps réel** des
variables vers le navigateur, conformément à l'architecture cible décrite
dans `docs/PROJET.md` :

```
processus cœur (C++, modèles, bus)  →  serveur de diagnostic  →  navigateur
                                     IPC/local                 WebSocket
```

Le cœur n'existe pas encore côté prototype : il est remplacé par
`SimSource`, qui génère les mêmes signaux que la simulation du navigateur
(catalogue dérivé automatiquement de `web/js/config.js`).

**Aucune dépendance externe** : bibliothèque standard C++20 + POSIX
uniquement — la poignée de main WebSocket (SHA-1, base64), le découpage en
trames et le JSON sont implémentés localement, pour rester déployable sur
le contrôleur embarqué.

## Compiler et lancer

```bash
cmake -B build -S . -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
./build/diagweb-server --port 8080 --root .. --data-dir ../.diag-data
```

Puis ouvrir `http://localhost:8080/web/index.html` (sources) ou
`/dist/index.html` (livrable). Le navigateur détecte le serveur et bascule
automatiquement sur son flux ; `?src=sim` force la simulation locale,
`?src=ws` force le flux serveur.

Compilation croisée pour le contrôleur :

```bash
cmake -B build-arm -S . -DCMAKE_TOOLCHAIN_FILE=<sdk>/toolchain.cmake
```

## Points d'entrée

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/ws` | flux temps réel (WebSocket) |
| GET | `/api/health` | état, nom de la source, horloge, horizon |
| GET | `/api/layouts` | configurations enregistrées |
| GET/PUT | `/api/layouts/<nom>` | lecture / enregistrement d'une configuration |
| POST | `/api/datalog` | journal de données (ajout en JSON Lines) |
| GET | `/…` | fichiers statiques sous `--root` |

## Protocole du flux (trames texte JSON)

Client → serveur :

```json
{"c":"sub","addr":"MB414","periodMs":10}
{"c":"unsub","addr":"MB414"}
```

Serveur → client :

```json
{"e":"hello","now":12.34,"horizonS":330,"defaultPeriodMs":10,"source":"…"}
{"e":"meta","addr":"MB414","label":"…","unit":"","kind":"word","family":"MB","known":true}
{"e":"err","addr":"XX","msg":"adresse invalide"}
{"e":"d","now":12.40,"s":{"MB414":[[12.35,21048],[12.36,21050]]}}
```

- `t` est en **secondes depuis le démarrage du serveur** ; le navigateur
  recale son horloge sur `now` (lissage, la gigue réseau est absorbée).
- À l'abonnement, le serveur envoie l'historique récent (60 s par défaut,
  décimé à 1 500 points par variable) : les courbes sont pleines
  immédiatement.
- Les lots sont émis toutes les 60 ms ; chaque variable est échantillonnée
  à **sa** période (10 ms par défaut).

## Structure

| Fichier | Rôle |
|---|---|
| `src/main.cpp` | serveur HTTP + WebSocket, REST, boucle d'émission |
| `src/source.hpp` | **contrat** `IVariableSource` + grammaire des adresses |
| `src/sim_source.hpp` | source simulée (à remplacer par le binding du cœur) |
| `src/catalog.generated.hpp` | catalogue généré (`node tools/gen-catalog.mjs`) |
| `src/ws.hpp`, `src/sha1.hpp`, `src/json.hpp` | briques sans dépendance |

## Brancher le vrai contrôleur

Implémenter `IVariableSource` (`src/source.hpp`) au-dessus du processus
cœur — résolution d'adresse (mapping PLC, registres, chemins C API des
modèles), abonnement avec période, lecture des échantillons — puis la
passer à la place de `SimSource` dans `main.cpp`. Le reste du serveur et la
totalité du front-end restent inchangés.
