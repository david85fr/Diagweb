# Serveur de diagnostic — prototype

Processus qui **sert les pages web**, **relaie le flux temps réel** des
variables du `controller` et **lit lui-même des équipements réseau**,
conformément à l'architecture cible décrite dans `docs/PROJET.md` :

```
controller (C++, modèles, bus) ─ IPC ─┐
                                      ├─ serveur de diagnostic ─ WebSocket ─ navigateur
équipements tiers (Modbus, 104, CAN) ─┘
```

Le `controller` n'existe pas encore côté prototype : il est remplacé par
`SimSource`, qui génère les mêmes signaux que la simulation du navigateur
(catalogue dérivé automatiquement de `web/js/config.js`). Les **liens
réseau**, eux, sont réels : voir `docs/PROTOCOLES.md`.

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

Options : `--sim-protocols` remplace les pilotes réseau par un générateur
(démonstration sans matériel ; les liens s'affichent « simulé »).

Tests :

```bash
cmake --build build --target diagweb-decode-test && ./build/diagweb-decode-test
node ../tests/protocols.mjs        # serveur en fonctionnement
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
| GET/PUT | `/api/protocols` | configuration des liens réseau (+ état, protocoles) |
| GET | `/api/protocols/status` | état courant des liens réseau |
| POST | `/api/protocols/test` | test de connexion d'un lien |
| GET | `/api/layouts` | configurations enregistrées |
| GET/PUT | `/api/layouts/<nom>` | lecture / enregistrement d'une configuration |
| GET | `/api/datalog` | état des campagnes de journalisation |
| POST | `/api/datalog/start` | démarre une journalisation autonome (navigateur fermé) |
| POST | `/api/datalog/stop` | arrête une campagne |
| GET | `/api/datalog/file?name=` | télécharge le CSV d'une campagne |
| GET | `/…` | fichiers statiques sous `--root` |

Le flux WebSocket accepte aussi `{"c":"set","addr":…,"value":…}` (forçage
d'une variable ; `{…,"release":1}` relâche) — refusé pour les points réseau,
qui restent en lecture seule.

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
| `src/sim_source.hpp` | source simulée (à remplacer par le binding du `controller`) + forçage |
| `src/recorder.hpp` | journalisation autonome sur disque (indépendante des clients) |
| `src/protocol.hpp` | modèle des liens/points + contrat `IProtocolDriver` |
| `src/protocol_source.hpp` | liens réseau (`@lien.point`) + aiguillage composite |
| `src/drivers/modbus.hpp` | Modbus TCP et RTU (lecture seule) |
| `src/drivers/iec104.hpp` | IEC 60870-5-104 (client) |
| `src/drivers/can.hpp` | CAN brut, J1939, CANopen (SocketCAN) |
| `src/drivers/net.hpp` | briques réseau : TCP à délai borné, liaison série |
| `src/catalog.generated.hpp` | catalogue généré (`node tools/gen-catalog.mjs`) |
| `src/protocols.generated.hpp` | protocoles générés (`node tools/gen-protocols.mjs`) |
| `src/ws.hpp`, `src/sha1.hpp`, `src/json.hpp`, `src/jvalue.hpp` | briques sans dépendance |

## Brancher le vrai contrôleur

Implémenter `IVariableSource` (`src/source.hpp`) au-dessus du `controller` —
résolution d'adresse (mapping PLC, registres, chemins C API des modèles),
abonnement avec période, lecture des échantillons — puis la passer à la place
de `SimSource` dans `main.cpp`. Le reste du serveur et la totalité du
front-end restent inchangés.

## Ajouter un protocole réseau

Décrire les champs dans `web/js/protocols.js`, régénérer
(`node tools/gen-protocols.mjs`), écrire un `IProtocolDriver` dans
`src/drivers/`, l'enregistrer dans `make_driver()` de
`src/protocol_source.hpp`. L'interface web construit ses formulaires à partir
de la description : elle n'a pas à être modifiée. Détails et périmètre dans
`docs/PROTOCOLES.md`.
