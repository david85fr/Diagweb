# Installer Diagweb

Trois façons de s'en servir, dans l'ordre de ce qu'on cherche.

| Ce qu'on veut | Ce qu'il faut |
|---|---|
| **Voir l'interface**, sans matériel ni serveur | ouvrir `dist/index.html`, ou https://david85fr.github.io/Diagweb/ — page autonome, simulation dans le navigateur |
| **Diagnostiquer une machine** (PC Ubuntu, Raspberry Pi) | installer le **paquet .deb** : un service démarre et sert la page sur le réseau |
| **Développer** | `python3 tools/serve.py` et `meson setup build` — voir `README.md` |

La page autonome et la page servie affichent la **même** interface. La première
tourne sur des données simulées, la seconde sur celles du contrôleur.

---

## 1. Paquet .deb prêt à installer

Chaque poussée sur `main` fait construire deux paquets par l'intégration
continue, publiés dans la **release `paquets`** du dépôt :

- `diagweb_<version>_amd64.deb` — **Ubuntu** 24.04 ou plus récent, et Debian 13
  ou plus récent sur PC (le paquet est construit sur Ubuntu 24.04 : ses
  dépendances réclament une glibc et une libstdc++ que Debian 12 n'a pas) ;
- `diagweb_<version>_arm64.deb` — **Raspberry Pi OS 64 bits** (« trixie »,
  Debian 13, le système par défaut des Raspberry Pi), modèles 3/4/5 et Zero 2 W.

```bash
# sur la machine cible
wget https://github.com/david85fr/Diagweb/releases/download/paquets/diagweb_<version>_arm64.deb
sudo apt install ./diagweb_<version>_arm64.deb
```

`apt install ./fichier.deb` — le `./` compte : sans lui, apt cherche un paquet
de ce nom dans les dépôts. Il tire les dépendances manquantes tout seul, ce que
`dpkg -i` ne fait pas.

L'installation crée le compte système `diagweb`, installe le service et le
**démarre**. La page est alors sur `http://<adresse-de-la-machine>:8080/`.

> **Raspberry Pi OS 32 bits** (armhf) : aucun paquet n'est publié — la
> construction sur la machine (§ 2) le fabrique en quelques minutes.

---

## 2. Depuis un clone du dépôt — une seule commande

C'est la voie prévue pour un Raspberry Pi : le paquet est construit **sur la
machine**, donc pour son architecture exacte, avec les bibliothèques qui s'y
trouvent.

```bash
git clone https://github.com/david85fr/Diagweb.git
cd Diagweb
sudo bash tools/install.sh
```

Le script installe les outils de compilation (`build-essential`, `meson`,
`ninja`, `pkg-config`, `python3`, `tcpdump`) et les deux bibliothèques
facultatives si la distribution les propose, construit le `.deb`, l'installe,
démarre le service et affiche l'adresse à ouvrir.

Options :

| Option | Effet |
|---|---|
| `--sans-apt` | n'installe rien avec apt (dépendances déjà en place) |
| `--sans-optionnel` | se passe d'OPC UA et de SNMP v3 — paquet plus léger, ces deux pilotes s'annoncent « non branché » |
| `--paquet-seul` | construit le `.deb` sans l'installer |

**Le paquet seul**, sans rien installer d'autre :

```bash
bash tools/package-deb.sh          # → dist/packages/diagweb_<version>_<arch>.deb
```

Il faut alors `meson`, `ninja-build`, `build-essential`, `python3` et `dpkg-deb`
déjà présents. La compilation demande **GCC 13 ou plus récent** (C++23) : c'est
le cas sur Raspberry Pi OS « trixie » (Debian 13) et Ubuntu 24.04. Debian 12
« bookworm » s'arrête à GCC 12 — le script le dit et s'arrête plutôt que
d'enterrer l'utilisateur sous des erreurs de compilation.

### Mettre à jour

```bash
cd Diagweb && git pull && sudo bash tools/install.sh
```

Le paquet neuf remplace l'ancien et le service redémarre sur le binaire neuf.
Les configurations enregistrées et les journaux sont conservés.

---

## 3. Ce que le paquet installe

| Chemin | Contenu |
|---|---|
| `/usr/bin/diagweb-server` | le serveur de diagnostic |
| `/usr/share/diagweb/web/` | la page servie |
| `/usr/share/diagweb/dist/` | la page autonome (`/dist/index.html`, simulation) |
| `/usr/share/diagweb/BUILD-INFO` | version, date, pilotes optionnels compilés dedans |
| `/usr/lib/systemd/system/diagweb.service` | le service |
| `/etc/default/diagweb` | port et options — **conservé** aux mises à jour |
| `/etc/diagweb/secrets.env` | secrets des liens réseau, 0640 `root:diagweb` |
| `/var/lib/diagweb` | configurations, journaux, captures |
| `/usr/share/doc/diagweb/` | ce fichier, le README, la licence |

### Le service

```bash
sudo systemctl status diagweb        # état
sudo systemctl restart diagweb       # après avoir modifié /etc/default/diagweb
journalctl -u diagweb -f             # journal en direct
```

Il tourne sous le compte système `diagweb`, **jamais en root**. Il conserve une
seule capacité, `CAP_NET_RAW`, sans laquelle deux fonctions annoncées ne
marcheraient pas : le **voisinage LLDP** (écoute passive) et la **capture
d'interfaces**. Le reste est confiné : système de fichiers en lecture seule
hormis `/var/lib/diagweb`, `/tmp` privé, pas d'accès aux réglages du noyau.

### Changer le port

```bash
sudo nano /etc/default/diagweb       # DIAGWEB_PORT=8080
sudo systemctl restart diagweb
```

Le port doit valoir **1024 ou plus** : le service ne tourne pas en root et n'a
pas la capacité d'ouvrir un port privilégié. Une valeur vide ou hors bornes est
refusée et remplacée par 8080, ce que le journal dit sans détour.

`DIAGWEB_ARGS` accepte les options du serveur, dont `--sim-protocols` (liens
réseau simulés, pour montrer l'outil sans équipement).

### Secrets des liens réseau

Les phrases SNMPv3 et les mots de passe OPC UA ne s'écrivent **jamais** dans la
configuration des liens : le serveur les lit dans son environnement, sous le nom
`DIAGWEB_SECRET_<RÉFÉRENCE>` (la référence est celle saisie dans la fenêtre
« Liens réseau »).

```bash
sudo nano /etc/diagweb/secrets.env   # DIAGWEB_SECRET_AGENT_AUTH=…
sudo systemctl restart diagweb
```

Ce fichier est créé à l'installation en **0640 `root:diagweb`** — lisible du
seul compte du service. `/etc/default/diagweb`, lui, est lisible par tous : rien
de confidentiel ne doit y figurer.

### Désinstaller

```bash
sudo apt remove diagweb              # laisse les données de /var/lib/diagweb
sudo apt purge diagweb               # les efface aussi, et retire le compte système
```

---

## 4. Ce qu'il faut savoir avant d'installer

- **Architecture** : `dpkg --print-architecture` sur la machine cible dit lequel
  des paquets prendre (`amd64`, `arm64`, `armhf`).
- **Réseau** : le service écoute sur toutes les interfaces. Sur un réseau où
  cela compte, filtrer le port au pare-feu — Diagweb n'a **aucune
  authentification**, c'est un outil de diagnostic sur réseau maîtrisé.
- **Lecture seule de bout en bout** vers les équipements (voir
  `docs/PROTOCOLES.md`) : rien n'est écrit sur un équipement tiers, hors les
  trois exceptions bornées qui y sont décrites.
- **Capture d'interfaces sous AppArmor** : sur une distribution où le profil
  `usr.bin.tcpdump` est en mode *enforce*, tcpdump peut écrire son `.pcap` dans
  `/var/lib/diagweb/captures/` mais pas son journal d'erreur `.log`. Une erreur
  de filtre pcap se présente alors comme un manque de privilège. Ajouter
  `/var/lib/diagweb/captures/*.log w,` dans
  `/etc/apparmor.d/local/usr.bin.tcpdump` lève l'ambiguïté.
- **Pilotes optionnels** : `cat /usr/share/diagweb/BUILD-INFO` dit si OPC UA et
  SNMP v3 sont dans le binaire installé. Absents, ces liens s'annoncent « non
  branché » et ne publient aucune valeur — jamais de valeur inventée.
