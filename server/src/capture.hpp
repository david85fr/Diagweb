// Diagweb — capture des interfaces réseau (tcpdump).
//
// Ce que cela apporte : quand un échange se passe mal — un équipement qui ne
// répond plus, une trame refusée, un temps de réponse aberrant — la seule
// preuve qui vaille est la trame elle-même. La capture se fait donc SUR LE
// CONTRÔLEUR, au plus près du câble, et le fichier .pcap se relit dans
// Wireshark.
//
// Interfaces Ethernet ET SocketCAN : tcpdump sait capturer les deux, chacune
// avec son type de lien. Une capture par interface (jamais « -i any » qui
// mélange des types de liens dans un même fichier et rend le résultat
// difficile à relire).
//
// TROIS GARDE-FOUS, parce qu'une capture oubliée remplit un disque embarqué :
//   1. QUOTA GLOBAL (100 Mo par défaut) sur le dossier de captures. Atteint,
//      les captures en cours sont arrêtées — jamais de disque plein.
//   2. DURÉE maximale par capture, arrêtée par le service lui-même.
//   3. DÉCLENCHEMENT PAR VARIABLE, facultatif : une variable de diagnostic
//      arme et désarme la capture. C'est ce qui permet d'attraper l'incident
//      rare sans laisser tourner tcpdump pendant deux jours.
#pragma once

#include <fcntl.h>
#include <pwd.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include "json.hpp"
#include "jvalue.hpp"
#include "netif.hpp"
#include "source.hpp"

extern char** environ;

namespace diagweb {

namespace fs = std::filesystem;

/** Une capture, en cours ou terminée. */
struct CaptureRun {
  std::string id;             // nom de fichier (sans .pcap)
  std::string iface;
  std::string filtre;         // expression pcap, facultative
  double start_t = 0;         // horloge du serveur
  double duration_s = 0;      // durée demandée (0 = jusqu'à l'arrêt)
  double end_t = 0;           // 0 tant qu'elle tourne
  std::string state;          // en cours, terminée, arrêtée, échec
  std::string detail;
  pid_t pid = 0;
  uintmax_t bytes = 0;
};

/** Déclenchement par une variable de diagnostic. */
struct CaptureTrigger {
  bool enabled = false;
  std::string addr;           // variable observée
  std::string mode = "nonzero";  // nonzero | above | below
  double threshold = 0;
  std::string iface;          // interface à capturer quand elle se déclenche
  double duration_s = 60;     // durée maximale d'une capture déclenchée
  bool armed = false;         // état précédent (détection de front)
};

/**
 * Gestionnaire de captures. Un seul objet, partagé par les requêtes HTTP et
 * par la boucle de service qui applique la durée, le quota et le déclencheur.
 */
class CaptureManager {
 public:
  CaptureManager(fs::path dossier, IVariableSource& source)
      : dir_(std::move(dossier)), source_(source) {
    std::error_code ec;
    fs::create_directories(dir_, ec);
    charger();
  }
  ~CaptureManager() { tout_arreter("arrêt du serveur"); }

  /** tcpdump est-il installé ? Sinon la page le dit, plutôt qu'un échec sec. */
  static std::string outil() {
    for (const char* c : {"/usr/bin/tcpdump", "/usr/sbin/tcpdump", "/sbin/tcpdump",
                          "/usr/local/bin/tcpdump"}) {
      std::error_code ec;
      if (fs::exists(c, ec)) return c;
    }
    return {};
  }

  void set_quota(uintmax_t octets) {
    quota_ = std::clamp<uintmax_t>(octets, 1u << 20, 4096ull << 20);
    enregistrer();
  }
  uintmax_t quota() const { return quota_; }

  /** Octets occupés par les fichiers de capture (le fichier de réglages ne
   *  compte pas : le quota porte sur les données capturées). */
  uintmax_t occupe() const {
    uintmax_t total = 0;
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(dir_, ec)) {
      if (e.is_regular_file(ec) && e.path().extension() == ".pcap") {
        total += e.file_size(ec);
      }
    }
    return total;
  }

  /**
   * Démarre une capture. Retourne un motif d'échec, ou une chaîne vide.
   * `iface` doit être une interface existante ; le filtre est passé tel quel
   * à tcpdump, qui le rejette lui-même s'il est incorrect.
   */
  std::string demarrer(const std::string& iface, double duree_s,
                       const std::string& filtre, double maintenant) {
    const std::string bin = outil();
    if (bin.empty()) {
      return "tcpdump n'est pas installé sur le contrôleur : capture impossible";
    }
    if (iface.empty() || iface.find('/') != std::string::npos) {
      return "interface invalide";
    }
    // Interface vérifiée AVANT de lancer tcpdump : sinon l'échec n'arrive
    // qu'après coup, dans un journal, alors que la faute de frappe est
    // évidente et se dit tout de suite.
    {
      const auto ifs = netif::list();
      const bool connue = std::any_of(ifs.begin(), ifs.end(),
          [&](const netif::Interface& i) { return i.name == iface; });
      if (!connue) return "interface « " + iface + " » inconnue du contrôleur";
    }
    std::lock_guard<std::mutex> g(mx_);
    for (const CaptureRun& r : runs_) {
      if (r.state == "en cours" && r.iface == iface) {
        return "une capture est déjà en cours sur « " + iface + " »";
      }
    }
    if (occupe() >= quota_) {
      return "quota de disque atteint : libérez des fichiers avant de relancer";
    }

    CaptureRun r;
    r.iface = iface;
    r.filtre = filtre;
    r.start_t = maintenant;
    r.duration_s = std::clamp(duree_s, 0.0, 24 * 3600.0);
    r.id = iface + '-' + horodate(maintenant);
    const std::string chemin = (dir_ / (r.id + ".pcap")).string();

    // Le fichier est plafonné par tcpdump lui-même (-C, en mégaoctets) : même
    // si le service tombait, la capture ne pourrait pas remplir le disque.
    const uintmax_t reste = quota_ > occupe() ? quota_ - occupe() : 0;
    const std::string mo = std::to_string(std::max<uintmax_t>(1, reste / (1u << 20)));

    // -Z : tcpdump abandonne ses privilèges après avoir ouvert l'interface.
    // Sans lui il devient l'utilisateur « tcpdump » et ne peut plus écrire
    // dans notre dossier de données — le fichier reste vide, sans raison
    // apparente. On lui demande de garder NOTRE identité.
    const passwd* moi = ::getpwuid(::geteuid());
    const std::string utilisateur = moi && moi->pw_name ? moi->pw_name : "root";

    std::vector<std::string> args = {bin, "-i", iface, "-w", chemin, "-U",
                                     "-s", "0", "-C", mo, "-W", "1", "-n",
                                     "-Z", utilisateur};
    if (!filtre.empty()) args.push_back(filtre);

    std::vector<char*> argv;
    for (std::string& a : args) argv.push_back(a.data());
    argv.push_back(nullptr);

    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    const std::string journal = (dir_ / (r.id + ".log")).string();
    posix_spawn_file_actions_addopen(&fa, 1, journal.c_str(),
                                     O_WRONLY | O_CREAT | O_TRUNC, 0644);
    posix_spawn_file_actions_adddup2(&fa, 1, 2);
    pid_t pid = 0;
    const int rc = ::posix_spawn(&pid, bin.c_str(), &fa, nullptr, argv.data(), environ);
    posix_spawn_file_actions_destroy(&fa);
    if (rc != 0) return std::string("lancement de tcpdump impossible : ") + std::strerror(rc);

    r.pid = pid;
    r.state = "en cours";
    r.detail = "capture en cours sur « " + iface + " »";
    runs_.push_back(std::move(r));
    return {};
  }

  /** Arrête une capture par identifiant (ou toutes si vide). */
  std::string arreter(const std::string& id, const std::string& motif) {
    std::lock_guard<std::mutex> g(mx_);
    bool trouve = false;
    for (CaptureRun& r : runs_) {
      if (r.state != "en cours") continue;
      if (!id.empty() && r.id != id) continue;
      terminer(r, "arrêtée", motif);
      trouve = true;
    }
    return trouve ? std::string() : "aucune capture en cours pour cet identifiant";
  }

  void tout_arreter(const std::string& motif) { arreter({}, motif); }

  /** Supprime un fichier de capture (et son journal). */
  std::string supprimer(const std::string& id) {
    std::lock_guard<std::mutex> g(mx_);
    for (const CaptureRun& r : runs_) {
      if (r.id == id && r.state == "en cours") return "capture en cours : arrêtez-la d'abord";
    }
    if (id.empty() || id.find('/') != std::string::npos || id.find("..") != std::string::npos) {
      return "identifiant invalide";
    }
    std::error_code ec;
    const bool ok = fs::remove(dir_ / (id + ".pcap"), ec);
    fs::remove(dir_ / (id + ".log"), ec);
    runs_.erase(std::remove_if(runs_.begin(), runs_.end(),
                               [&](const CaptureRun& r) { return r.id == id; }),
                runs_.end());
    return ok ? std::string() : "fichier introuvable";
  }

  /**
   * Règle le déclencheur. L'abonnement à la variable observée est pris ici :
   * sans lui, aucune valeur ne circulerait et le déclencheur resterait aveugle.
   */
  void set_trigger(const CaptureTrigger& t) {
    std::lock_guard<std::mutex> g(mx_);
    const std::string avant = abonne_;
    const bool arme = trigger_.armed;
    trigger_ = t;
    trigger_.armed = arme;
    const std::string apres = (t.enabled && !t.addr.empty()) ? t.addr : std::string();
    if (avant == apres) return;
    if (!avant.empty()) source_.unsubscribe(avant);
    abonne_.clear();
    if (!apres.empty() && source_.subscribe(apres, 200)) {
      abonne_ = apres;
      lu_t_ = 0;
      trigger_.armed = false;
    }
    enregistrer();
  }
  CaptureTrigger trigger() const {
    std::lock_guard<std::mutex> g(mx_);
    return trigger_;
  }

  /**
   * Boucle de service : durée écoulée, processus terminés, quota dépassé,
   * déclencheur. Appelée quelques fois par seconde par le serveur.
   */
  void service(double maintenant) {
    std::string a_lancer_iface;
    double a_lancer_duree = 0;
    {
    std::lock_guard<std::mutex> g(mx_);
    for (CaptureRun& r : runs_) {
      if (r.state != "en cours") continue;
      r.bytes = taille(r);
      int etat = 0;
      const pid_t fini = ::waitpid(r.pid, &etat, WNOHANG);
      if (fini == r.pid) {
        // tcpdump s'est arrêté seul : plafond de taille atteint, ou refus.
        const bool ok = WIFEXITED(etat) && WEXITSTATUS(etat) == 0;
        terminer_sans_signal(r, ok ? "terminée" : "échec",
                             ok ? "tcpdump a terminé" : motif_journal(r));
        continue;
      }
      if (r.duration_s > 0 && maintenant - r.start_t >= r.duration_s) {
        terminer(r, "terminée", "durée atteinte");
        continue;
      }
    }
    if (occupe() >= quota_) {
      for (CaptureRun& r : runs_) {
        if (r.state == "en cours") terminer(r, "arrêtée", "quota de disque atteint");
      }
    }
    appliquer_trigger(maintenant, a_lancer_iface, a_lancer_duree);
    }
    // Le démarrage se fait hors du verrou : demarrer() le prend lui-même.
    if (!a_lancer_iface.empty()) {
      const std::string err = demarrer(a_lancer_iface, a_lancer_duree, {}, maintenant);
      std::lock_guard<std::mutex> g(mx_);
      declencheur_msg_ = err.empty()
          ? "capture déclenchée par « " + trigger_.addr + " »"
          : "déclenchement refusé : " + err;
    }
  }

  std::vector<CaptureRun> etat() const {
    std::lock_guard<std::mutex> g(mx_);
    std::vector<CaptureRun> out = runs_;
    for (CaptureRun& r : out) r.bytes = taille(r);
    return out;
  }

  fs::path fichier(const std::string& id) const {
    if (id.empty() || id.find('/') != std::string::npos || id.find("..") != std::string::npos) {
      return {};
    }
    return dir_ / (id + ".pcap");
  }

 private:
  /** Fichier de réglages : quota et déclencheur, à côté des captures. */
  fs::path reglages() const { return dir_ / "reglages.json"; }

  /**
   * Le déclencheur et le quota survivent au redémarrage : un déclencheur armé
   * pour attraper un incident rare qui s'oublierait à la première coupure de
   * courant ne servirait à rien — et c'est précisément la coupure qu'on
   * cherche parfois à comprendre.
   */
  void enregistrer() const {
    std::ofstream f(reglages(), std::ios::binary | std::ios::trunc);
    if (!f) return;
    f << "{\"quotaBytes\":" << quota_
      << ",\"trigger\":{\"enabled\":" << (trigger_.enabled ? "true" : "false")
      << ",\"addr\":\"" << jesc(trigger_.addr) << "\",\"mode\":\"" << jesc(trigger_.mode)
      << "\",\"threshold\":" << jnum(trigger_.threshold, 6)
      << ",\"iface\":\"" << jesc(trigger_.iface)
      << "\",\"durationS\":" << jnum(trigger_.duration_s, 1) << "}}";
  }

  void charger() {
    std::ifstream f(reglages(), std::ios::binary);
    if (!f) return;
    std::ostringstream corps;
    corps << f.rdbuf();
    bool ok = false;
    const JValue j = jparse(corps.str(), &ok);
    if (!ok) return;
    quota_ = std::clamp<uintmax_t>(static_cast<uintmax_t>(j.num("quotaBytes", 100ull << 20)),
                                   1u << 20, 4096ull << 20);
    const JValue* t = j.find("trigger");
    if (!t) return;
    CaptureTrigger cfg;
    cfg.enabled = t->flag("enabled", false);
    cfg.addr = t->str("addr");
    cfg.mode = t->str("mode", "nonzero");
    cfg.threshold = t->num("threshold", 0);
    cfg.iface = t->str("iface");
    cfg.duration_s = t->num("durationS", 60);
    // set_trigger prend le verrou et réenregistre : ici l'objet est en cours
    // de construction, on applique donc directement.
    trigger_ = cfg;
    if (cfg.enabled && !cfg.addr.empty() && source_.subscribe(cfg.addr, 200)) {
      abonne_ = cfg.addr;
    }
  }

  static std::string horodate(double t) {
    char buf[32];
    const auto s = static_cast<long long>(t);
    std::snprintf(buf, sizeof buf, "%lld", s);
    return buf;
  }

  uintmax_t taille(const CaptureRun& r) const {
    std::error_code ec;
    const auto n = fs::file_size(dir_ / (r.id + ".pcap"), ec);
    return ec ? r.bytes : n;
  }

  /** Dernière ligne du journal de tcpdump : le motif d'un refus. */
  std::string motif_journal(const CaptureRun& r) const {
    std::ifstream f(dir_ / (r.id + ".log"));
    std::string ligne, derniere;
    while (std::getline(f, ligne)) {
      if (!ligne.empty()) derniere = ligne;
    }
    if (derniere.empty()) return "tcpdump s'est arrêté sans message";
    return derniere;
  }

  void terminer(CaptureRun& r, const char* etat, const std::string& motif) {
    if (r.pid > 0) {
      // SIGINT : tcpdump ferme proprement son fichier pcap. SIGKILL le
      // laisserait tronqué, donc illisible par Wireshark.
      ::kill(r.pid, SIGINT);
      int st = 0;
      for (int i = 0; i < 40 && ::waitpid(r.pid, &st, WNOHANG) == 0; ++i) {
        ::usleep(25000);
      }
      ::kill(r.pid, SIGKILL);
      ::waitpid(r.pid, &st, WNOHANG);
    }
    terminer_sans_signal(r, etat, motif);
  }

  void terminer_sans_signal(CaptureRun& r, const char* etat, const std::string& motif) {
    r.state = etat;
    r.detail = motif;
    r.pid = 0;
    r.bytes = taille(r);
  }

  /**
   * Front montant de la variable → démarrage ; front descendant → arrêt.
   * Le démarrage n'est pas fait ici mais rendu à l'appelant, qui l'exécute
   * hors du verrou.
   */
  void appliquer_trigger(double maintenant, std::string& a_lancer, double& duree) {
    (void)maintenant;
    if (!trigger_.enabled || abonne_.empty()) return;
    std::vector<Sample> ech;
    source_.read(abonne_, lu_t_, ech, 8);
    if (!ech.empty()) {
      lu_t_ = ech.back().t;
      valeur_ = ech.back().v;
      vue_ = true;
    }
    if (!vue_) return;                      // aucune valeur reçue : on attend

    bool actif = false;
    if (trigger_.mode == "above") actif = valeur_ > trigger_.threshold;
    else if (trigger_.mode == "below") actif = valeur_ < trigger_.threshold;
    else actif = valeur_ != 0;

    if (actif == trigger_.armed) return;
    trigger_.armed = actif;
    if (actif) {
      a_lancer = trigger_.iface;
      duree = trigger_.duration_s;
    } else {
      for (CaptureRun& r : runs_) {
        if (r.state == "en cours" && r.iface == trigger_.iface) {
          terminer(r, "terminée", "déclencheur retombé");
        }
      }
      declencheur_msg_ = "capture arrêtée par « " + trigger_.addr + " »";
    }
  }

 public:
  std::string message_declencheur() const {
    std::lock_guard<std::mutex> g(mx_);
    return declencheur_msg_;
  }

 private:
  fs::path dir_;
  IVariableSource& source_;
  mutable std::mutex mx_;
  std::vector<CaptureRun> runs_;
  CaptureTrigger trigger_;
  std::string declencheur_msg_;
  std::string abonne_;          // variable réellement abonnée (déclencheur)
  double lu_t_ = 0;             // horodatage du dernier échantillon lu
  double valeur_ = 0;           // dernière valeur connue
  bool vue_ = false;            // a-t-on déjà reçu une valeur ?
  uintmax_t quota_ = 100ull << 20;      // cent mégaoctets
};

inline std::string capture_json(const CaptureManager& m, double maintenant) {
  std::ostringstream o;
  const auto runs = m.etat();
  const CaptureTrigger t = m.trigger();
  o << "{\"tool\":\"" << jesc(CaptureManager::outil())
    << "\",\"quotaBytes\":" << m.quota() << ",\"usedBytes\":" << m.occupe()
    << ",\"trigger\":{\"enabled\":" << (t.enabled ? "true" : "false")
    << ",\"addr\":\"" << jesc(t.addr) << "\",\"mode\":\"" << jesc(t.mode)
    << "\",\"threshold\":" << jnum(t.threshold, 6)
    << ",\"iface\":\"" << jesc(t.iface) << "\",\"durationS\":" << jnum(t.duration_s, 1)
    << ",\"armed\":" << (t.armed ? "true" : "false") << '}'
    << ",\"message\":\"" << jesc(m.message_declencheur()) << "\",\"runs\":[";
  bool first = true;
  for (const CaptureRun& r : runs) {
    if (!first) o << ',';
    first = false;
    o << "{\"id\":\"" << jesc(r.id) << "\",\"iface\":\"" << jesc(r.iface)
      << "\",\"filter\":\"" << jesc(r.filtre) << "\",\"state\":\"" << jesc(r.state)
      << "\",\"detail\":\"" << jesc(r.detail) << "\",\"bytes\":" << r.bytes
      << ",\"durationS\":" << jnum(r.duration_s, 1)
      << ",\"ageS\":" << jnum(maintenant - r.start_t, 1) << '}';
  }
  o << "]}";
  return o.str();
}

}  // namespace diagweb
