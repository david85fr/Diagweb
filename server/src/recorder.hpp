// Diagweb — enregistreur de données côté serveur (journalisation autonome).
//
// Le serveur de diagnostic est aussi serveur d'acquisition : il peut journaliser
// des variables sur disque **indépendamment de tout navigateur**. Une fois une
// campagne démarrée (POST /api/datalog/start), elle continue même si la page est
// fermée ; le fichier CSV se télécharge plus tard (GET /api/datalog/file).
//
// L'enregistreur garde ses propres abonnements sur la source : les échantillons
// sont donc produits même sans client WebSocket connecté.
//
// Le fichier BRUT sur disque est un journal d'arrivée (une ligne par
// échantillon, deux horodatages, adresse ET nom). Le téléchargement le
// transforme : trié par horodatage (une ligne par instant, une colonne par
// variable) ou par variable (échantillons groupés) — voir render_csv().
#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "source.hpp"

namespace diagweb {

struct RecStatus {
  std::string name;
  double since = 0;        // horloge serveur au démarrage de la campagne
  long long samples = 0;
  size_t vars = 0;
  long long size_bytes = 0;
  bool active = true;
};

/** Une variable à journaliser : adresse, période, nom d'affichage. */
struct RecVar {
  std::string addr;
  int period_ms = 200;
  std::string name;        // nom donné par l'opérateur (vide : sans nom)
};

class Recorder {
 public:
  // En-tête du fichier brut. L'ancien format (4 colonnes) est mis de côté en
  // « .ancien.csv » au démarrage d'une campagne plutôt que d'être mélangé.
  static constexpr const char* kHeader =
      "horodatage_iso;horodatage_source_iso;t_s;adresse;nom;valeur";

  Recorder(IVariableSource& src, std::string data_dir)
      : src_(src), dir_(std::move(data_dir)) {
    // Correspondance temps serveur → horloge murale, figée au démarrage.
    wall0_ms_ = epoch_ms() - static_cast<long long>(src_.now() * 1000.0);
  }
  ~Recorder() { stop_all(); }

  /** Dossier des journaux (<data-dir>/datalog). */
  std::filesystem::path dir() const { return std::filesystem::path(dir_) / "datalog"; }

  /**
   * Démarre (ou remplace) une campagne nommée sur un jeu de variables.
   * @returns message d'erreur, vide si succès.
   */
  std::string start(const std::string& name, const std::vector<RecVar>& vars) {
    const std::string safe = safe_name(name);
    std::lock_guard<std::mutex> lock(mu_);
    stop_locked(safe);
    if (vars.empty()) return "aucune variable a journaliser";

    auto rec = std::make_unique<Rec>();
    rec->name = safe;
    rec->since = src_.now();
    for (const auto& var : vars) {
      const Meta* m = src_.subscribe(var.addr, var.period_ms > 0 ? var.period_ms : 200);
      if (!m) continue;                       // adresse invalide : ignorée
      rec->subs.push_back({m->addr, src_.now(), clean_name(var.name)});
    }
    if (rec->subs.empty()) return "aucune adresse valide";

    std::error_code ec;
    std::filesystem::create_directories(dir(), ec);
    rec->path = (dir() / (safe + ".csv")).string();
    bool fresh = !std::filesystem::exists(rec->path, ec) ||
                 std::filesystem::file_size(rec->path, ec) == 0;
    if (!fresh && !header_matches(rec->path)) {
      // Fichier d'un ancien format : mis de côté, jamais mélangé ni écrasé.
      std::filesystem::rename(rec->path, dir() / (safe + ".ancien.csv"), ec);
      fresh = true;
    }
    rec->file.open(rec->path, std::ios::binary | std::ios::app);
    if (!rec->file) {
      for (const auto& s : rec->subs) src_.unsubscribe(s.addr);
      return "ecriture du journal impossible";
    }
    if (fresh) rec->file << kHeader << "\r\n";
    recs_.emplace(safe, std::move(rec));
    return {};
  }

  bool stop(const std::string& name) {
    std::lock_guard<std::mutex> lock(mu_);
    return stop_locked(safe_name(name));
  }

  /** Écrit les nouveaux échantillons de toutes les campagnes (thread dédié). */
  void flush() {
    std::lock_guard<std::mutex> lock(mu_);
    std::vector<Sample> tmp;
    for (auto& [name, rec] : recs_) {
      for (auto& s : rec->subs) {
        tmp.clear();
        // max_out = 0 : aucun échantillon décimé — le journal est fidèle.
        src_.read(s.addr, s.cursor, tmp, 0);
        for (const auto& smp : tmp) {
          write_row(*rec, smp, s.addr, s.name);
          ++rec->samples;
        }
        if (!tmp.empty()) s.cursor = tmp.back().t;
      }
      rec->file.flush();
    }
  }

  std::vector<RecStatus> status() const {
    std::lock_guard<std::mutex> lock(mu_);
    std::vector<RecStatus> out;
    for (const auto& [name, rec] : recs_) {
      std::error_code ec;
      RecStatus st;
      st.name = name;
      st.since = rec->since;
      st.samples = rec->samples;
      st.vars = rec->subs.size();
      st.size_bytes = static_cast<long long>(std::filesystem::file_size(rec->path, ec));
      out.push_back(st);
    }
    return out;
  }

  /** Nom de fichier sûr (mêmes règles que les configurations). */
  static std::string safe_name(const std::string& raw) {
    std::string clean;
    for (char c : raw) {
      if (c == '/' || c == '\\' || c == '.' || c == '\0' || c == ':') clean += '_';
      else clean += c;
    }
    if (clean.empty()) clean = "sans-nom";
    return clean.substr(0, 80);
  }

  /**
   * Rend le CSV téléchargé à partir du fichier brut d'une campagne.
   *
   * `sort` :
   *   - "var"  : une ligne par échantillon, groupées par variable puis en
   *              ordre chronologique (adresse;nom;horodatages;t_s;valeur) ;
   *   - autre  : trié par horodatage — une ligne par INSTANT, une colonne
   *              par variable « adresse — nom », suivie d'une colonne
   *              « (horodatage source) » pour les points qui en ont un.
   *              C'est le défaut : les variables de même période, calées sur
   *              la même grille, partagent alors leurs lignes.
   *
   * Le fichier est chargé en mémoire le temps de la transformation : les
   * campagnes visées se comptent en Mo (l'état l'affiche), pas en Go.
   * L'ancien format brut (4 colonnes) est encore accepté en lecture.
   */
  static std::string render_csv(const std::string& path, const std::string& sort, bool& ok) {
    ok = false;
    std::ifstream f(path, std::ios::binary);
    if (!f) return {};

    struct Row {
      std::string iso, iso_src, tstr, addr, name, val;
      double t = 0;
    };
    std::vector<Row> rows;
    std::string line;
    bool first = true;
    bool old_format = false;
    while (std::getline(f, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) continue;
      if (first) {
        first = false;
        old_format = line != kHeader;   // « horodatage_iso;t_s;adresse;valeur »
        continue;
      }
      const std::vector<std::string> c = csv_split(line);
      Row r;
      if (old_format) {
        if (c.size() < 4) continue;
        r.iso = c[0]; r.tstr = c[1]; r.addr = c[2]; r.val = c[3];
      } else {
        if (c.size() < 6) continue;
        r.iso = c[0]; r.iso_src = c[1]; r.tstr = c[2];
        r.addr = c[3]; r.name = c[4]; r.val = c[5];
      }
      r.t = parse_t(r.tstr);
      rows.push_back(std::move(r));
    }
    if (first) return {};               // fichier vide : pas même un en-tête
    ok = true;

    std::ostringstream o;
    if (sort == "var") {
      std::stable_sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) {
        return a.addr != b.addr ? a.addr < b.addr : a.t < b.t;
      });
      o << "adresse;nom;horodatage_iso;horodatage_source_iso;t_s;valeur\r\n";
      for (const Row& r : rows) {
        o << csv_field(r.addr) << ';' << csv_field(r.name) << ';' << r.iso << ';'
          << r.iso_src << ';' << r.tstr << ';' << r.val << "\r\n";
      }
      return o.str();
    }

    // Tri par horodatage : pivot « une ligne par instant ». Les colonnes sont
    // ordonnées par adresse ; le nom retenu est le dernier vu (une campagne
    // relancée peut avoir renommé une variable).
    struct Col { std::string name; bool has_src = false; size_t idx = 0; };
    std::map<std::string, Col> cols;
    for (const Row& r : rows) {
      Col& c = cols[r.addr];
      if (!r.name.empty()) c.name = r.name;
      if (!r.iso_src.empty()) c.has_src = true;
    }
    size_t ncell = 0;
    for (auto& [addr, c] : cols) {
      c.idx = ncell;
      ncell += c.has_src ? 2 : 1;
    }
    struct Line { std::string iso, tstr; std::vector<std::string> cells; };
    std::map<double, Line> lines;
    for (const Row& r : rows) {
      Line& ln = lines[r.t];
      if (ln.cells.empty()) { ln.iso = r.iso; ln.tstr = r.tstr; ln.cells.resize(ncell); }
      const Col& c = cols[r.addr];
      ln.cells[c.idx] = r.val;
      if (c.has_src) ln.cells[c.idx + 1] = r.iso_src;
    }
    o << "horodatage_iso;t_s";
    for (const auto& [addr, c] : cols) {
      const std::string head = c.name.empty() ? addr : addr + " — " + c.name;
      o << ';' << csv_field(head);
      if (c.has_src) o << ';' << csv_field(head + " (horodatage source)");
    }
    o << "\r\n";
    for (const auto& [t, ln] : lines) {
      o << ln.iso << ';' << ln.tstr;
      for (const auto& cell : ln.cells) o << ';' << cell;
      o << "\r\n";
    }
    return o.str();
  }

 private:
  struct Sub { std::string addr; double cursor; std::string name; };
  struct Rec {
    std::string name;
    std::vector<Sub> subs;
    std::ofstream file;
    double since = 0;
    long long samples = 0;
    std::string path;
  };

  static long long epoch_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
  }

  /** Date ISO 8601 UTC (milliseconde près) depuis des millisecondes d'époque. */
  static std::string iso_utc(long long ms) {
    const std::time_t secs = static_cast<std::time_t>(ms / 1000);
    std::tm tmv{};
#if defined(_WIN32)
    gmtime_s(&tmv, &secs);
#else
    gmtime_r(&secs, &tmv);
#endif
    char iso[48];
    std::snprintf(iso, sizeof iso, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                  tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                  tmv.tm_hour, tmv.tm_min, tmv.tm_sec, static_cast<int>(ms % 1000));
    return iso;
  }

  void write_row(Rec& rec, const Sample& s, const std::string& addr,
                 const std::string& name) {
    char tbuf[24], val[48];
    std::snprintf(tbuf, sizeof tbuf, "%.3f", s.t);
    std::snprintf(val, sizeof val, "%.6g", s.v);
    rec.file << iso_utc(wall0_ms_ + static_cast<long long>(s.t * 1000.0)) << ';';
    // L'horodatage de l'équipement est déjà absolu (secondes UTC) : il se
    // formate tel quel, sans passer par l'horloge du serveur.
    if (s.t_src > 0) rec.file << iso_utc(static_cast<long long>(s.t_src * 1000.0));
    rec.file << ';' << tbuf << ';' << csv_field(addr) << ';' << csv_field(name)
             << ';' << val << "\r\n";
  }

  /** Le fichier existant commence-t-il par l'en-tête du format courant ? */
  static bool header_matches(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    std::string first;
    if (!f || !std::getline(f, first)) return false;
    if (!first.empty() && first.back() == '\r') first.pop_back();
    return first == kHeader;
  }

  /** Nom d'affichage assaini : une ligne, longueur bornée (UTF-8 respecté). */
  static std::string clean_name(const std::string& raw) {
    std::string out;
    for (char c : raw) {
      // Au-delà de la borne, seuls les octets de continuation passent encore :
      // couper au milieu d'un caractère produirait un octet UTF-8 orphelin.
      if (out.size() >= 120 && (static_cast<unsigned char>(c) & 0xC0) != 0x80) break;
      out += (static_cast<unsigned char>(c) < 0x20) ? ' ' : c;
    }
    return out;
  }

  static std::string csv_field(const std::string& s) {
    if (s.find_first_of(";\"\n") == std::string::npos) return s;
    std::string o = "\"";
    for (char c : s) { if (c == '"') o += '"'; o += c; }
    return o + "\"";
  }

  /** Découpe une ligne CSV « ; » en champs, guillemets respectés. */
  static std::vector<std::string> csv_split(const std::string& line) {
    std::vector<std::string> out;
    std::string cur;
    bool quoted = false;
    for (size_t i = 0; i < line.size(); ++i) {
      const char c = line[i];
      if (quoted) {
        if (c == '"') {
          if (i + 1 < line.size() && line[i + 1] == '"') { cur += '"'; ++i; }
          else quoted = false;
        } else cur += c;
      } else if (c == '"') {
        quoted = true;
      } else if (c == ';') {
        out.push_back(cur);
        cur.clear();
      } else {
        cur += c;
      }
    }
    out.push_back(cur);
    return out;
  }

  /** t_s en secondes ; les lignes du fichier brut sont écrites en « %.3f ». */
  static double parse_t(const std::string& s) {
    // strtod borné : le champ vient d'un fichier écrit par nous, mais un
    // fichier abîmé ne doit pas faire tomber le serveur (jamais de sto* nu).
    char* end = nullptr;
    const double v = std::strtod(s.c_str(), &end);
    return (end && end != s.c_str() && std::isfinite(v)) ? v : 0.0;
  }

  bool stop_locked(const std::string& safe) {
    auto it = recs_.find(safe);
    if (it == recs_.end()) return false;
    for (const auto& s : it->second->subs) src_.unsubscribe(s.addr);
    it->second->file.flush();
    it->second->file.close();
    recs_.erase(it);
    return true;
  }

  void stop_all() {
    std::lock_guard<std::mutex> lock(mu_);
    for (auto& [name, rec] : recs_) {
      for (const auto& s : rec->subs) src_.unsubscribe(s.addr);
      rec->file.flush();
    }
    recs_.clear();
  }

  IVariableSource& src_;
  std::string dir_;
  long long wall0_ms_ = 0;
  mutable std::mutex mu_;
  std::map<std::string, std::unique_ptr<Rec>> recs_;
};

}  // namespace diagweb
