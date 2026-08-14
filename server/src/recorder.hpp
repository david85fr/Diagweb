// Diagweb — enregistreur de données côté serveur (journalisation autonome).
//
// Le serveur de diagnostic est aussi serveur d'acquisition : il peut journaliser
// des variables sur disque **indépendamment de tout navigateur**. Une fois une
// campagne démarrée (POST /api/datalog/start), elle continue même si la page est
// fermée ; le fichier CSV se télécharge plus tard (GET /api/datalog/file).
//
// L'enregistreur garde ses propres abonnements sur la source : les échantillons
// sont donc produits même sans client WebSocket connecté.
#pragma once

#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
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

class Recorder {
 public:
  Recorder(IVariableSource& src, std::string data_dir)
      : src_(src), dir_(std::move(data_dir)) {
    // Correspondance temps serveur → horloge murale, figée au démarrage.
    wall0_ms_ = epoch_ms() - static_cast<long long>(src_.now() * 1000.0);
  }
  ~Recorder() { stop_all(); }

  /** Dossier des journaux (<data-dir>/datalog). */
  std::filesystem::path dir() const { return std::filesystem::path(dir_) / "datalog"; }

  /**
   * Démarre (ou remplace) une campagne nommée sur un jeu d'adresses.
   * @returns message d'erreur, vide si succès.
   */
  std::string start(const std::string& name,
                    const std::vector<std::pair<std::string, int>>& addrs) {
    const std::string safe = safe_name(name);
    std::lock_guard<std::mutex> lock(mu_);
    stop_locked(safe);
    if (addrs.empty()) return "aucune variable a journaliser";

    auto rec = std::make_unique<Rec>();
    rec->name = safe;
    rec->since = src_.now();
    for (const auto& [addr, period] : addrs) {
      const Meta* m = src_.subscribe(addr, period > 0 ? period : 200);
      if (!m) continue;                       // adresse invalide : ignorée
      rec->subs.push_back({m->addr, src_.now()});
    }
    if (rec->subs.empty()) return "aucune adresse valide";

    std::error_code ec;
    std::filesystem::create_directories(dir(), ec);
    rec->path = (dir() / (safe + ".csv")).string();
    const bool fresh = !std::filesystem::exists(rec->path, ec) ||
                       std::filesystem::file_size(rec->path, ec) == 0;
    rec->file.open(rec->path, std::ios::binary | std::ios::app);
    if (!rec->file) {
      for (const auto& s : rec->subs) src_.unsubscribe(s.addr);
      return "ecriture du journal impossible";
    }
    if (fresh) rec->file << "horodatage_iso;t_s;adresse;valeur\r\n";
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
          write_row(*rec, smp.t, s.addr, smp.v);
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

 private:
  struct Sub { std::string addr; double cursor; };
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

  void write_row(Rec& rec, double t, const std::string& addr, double v) {
    const long long ms = wall0_ms_ + static_cast<long long>(t * 1000.0);
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
    char val[48];
    std::snprintf(val, sizeof val, "%.6g", v);
    rec.file << iso << ';';
    char tbuf[24];
    std::snprintf(tbuf, sizeof tbuf, "%.3f", t);
    rec.file << tbuf << ';' << csv_field(addr) << ';' << val << "\r\n";
  }

  static std::string csv_field(const std::string& s) {
    if (s.find_first_of(";\"\n") == std::string::npos) return s;
    std::string o = "\"";
    for (char c : s) { if (c == '"') o += '"'; o += c; }
    return o + "\"";
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
