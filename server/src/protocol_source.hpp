// Diagweb — source de variables « points réseau » (@lien.point).
//
// Gère les liens configurés depuis l'interface : un fil d'exécution par lien,
// un pilote par protocole, un tampon circulaire par point. Les valeurs sont
// publiées dès que le lien est ouvert (indépendamment des abonnements) pour
// que les courbes soient pleines à l'ajout d'une variable.
//
// Composite : les adresses internes du contrôleur (I/Q/M/S, MB, C API)
// restent servies par la source du controller ; seules les adresses en « @ »
// passent par ici.
#pragma once

#include <algorithm>
#include <atomic>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "drivers/can.hpp"
#include "drivers/iec104.hpp"
#include "drivers/modbus.hpp"
#include "protocol.hpp"
#include "sim_source.hpp"

namespace diagweb {

/** État d'un lien, tel que l'interface l'affiche. */
struct LinkStatus {
  std::string id;
  std::string state = "off";     // up | down | off | todo | sim
  std::string detail;
  double since = 0;
  long long samples = 0;
};

/**
 * Pilote « déclaré » : la configuration est acceptée et conservée, la lecture
 * n'est pas implémentée (IEC 61850 : pile ISO/MMS à venir). Il ne publie
 * jamais de valeur — mieux vaut une absence franche qu'une valeur inventée.
 */
class DeclaredDriver : public IProtocolDriver {
 public:
  explicit DeclaredDriver(std::string why) : why_(std::move(why)) {}
  bool implemented() const override { return false; }
  bool open(std::string& err) override { err = why_; return false; }
  bool service(std::string& err) override { err = why_; return false; }
  void close() override {}

 private:
  std::string why_;
};

/**
 * Pilote de simulation : sert à démontrer la chaîne complète sans matériel
 * (option --sim-protocols). Les valeurs sont explicitement signalées comme
 * simulées dans l'état du lien.
 */
class SimProtocolDriver : public IProtocolDriver {
 public:
  SimProtocolDriver(const LinkConfig& link, IPointSink& sink) : link_(link), sink_(sink) {
    for (const auto& p : link.points) {
      const std::string addr = net_addr(link.id, p.id);
      Kind k = p.kind;
      gens_.push_back(std::make_unique<Generator>(
          k == Kind::Bit ? bitchain(6, 9)
          : k == Kind::Word ? sine(20000, 900, 23, 40)
          : sine(0, 0, 0, 0), k, addr));
      // Les grandeurs flottantes prennent un profil déduit de l'adresse.
      if (k == Kind::Float) {
        Mulberry32 r(hash32(addr) ^ 0x5BF03635u);
        const double base = std::round((r() * 120 - 20) * 10) / 10;
        gens_.back() = std::make_unique<Generator>(
            sine(base, 2 + r() * 18, 9 + r() * 40, 0.3), k, addr);
      }
      due_.push_back(0);
    }
  }

  bool open(std::string& err) override { (void)err; return true; }
  void close() override {}
  bool service(std::string& err) override {
    (void)err;
    const double t = sink_.now();
    for (size_t i = 0; i < gens_.size(); ++i) {
      if (t < due_[i]) continue;
      due_[i] = t + link_.points[i].period_ms / 1000.0;
      sink_.publish(i, (*gens_[i])(t));
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    return true;
  }

 private:
  LinkConfig link_;
  IPointSink& sink_;
  std::vector<std::unique_ptr<Generator>> gens_;
  std::vector<double> due_;
};

// ---------------------------------------------------------------- source
class ProtocolSource : public IVariableSource {
 public:
  /** `clock` : source de référence — l'horodatage doit être commun à tous
   *  les points, faute de quoi les courbes ne seraient pas comparables. */
  ProtocolSource(const IVariableSource& clock, double horizon_s, int default_period_ms, bool simulate)
      : clock_(clock), horizon_s_(horizon_s), default_period_ms_(default_period_ms),
        simulate_(simulate) {}

  ~ProtocolSource() override { stop_all(); }

  const char* name() const override { return "Liens réseau"; }
  double now() const override { return clock_.now(); }

  // ---- configuration ----------------------------------------------
  /** Applique une configuration : arrête les liens, recrée les canaux. */
  void apply(const ProtocolConfig& cfg) {
    std::lock_guard<std::mutex> apply_lock(apply_mu_);
    stop_all();
    {
      std::lock_guard<std::mutex> lock(mu_);
      config_ = cfg;
      chans_.clear();
      status_.clear();
      for (const auto& link : config_.links) {
        for (const auto& p : link.points) {
          Channel ch;
          ch.meta.addr = net_addr(link.id, p.id);
          ch.meta.label = p.label.empty() ? (link.label + " — " + p.id) : p.label;
          ch.meta.unit = p.unit;
          ch.meta.family = "NET";
          ch.meta.kind = p.kind;
          ch.meta.known = true;
          chans_.emplace(ch.meta.addr, std::move(ch));
        }
        LinkStatus st;
        st.id = link.id;
        st.state = link.enabled ? "down" : "off";
        st.detail = link.enabled ? "connexion en cours…" : "lien désactivé";
        status_[link.id] = st;
      }
    }
    start_all();
  }

  ProtocolConfig config() const {
    std::lock_guard<std::mutex> lock(mu_);
    return config_;
  }

  std::vector<LinkStatus> statuses() const {
    std::lock_guard<std::mutex> lock(mu_);
    std::vector<LinkStatus> out;
    out.reserve(status_.size());
    for (const auto& [id, st] : status_) out.push_back(st);
    return out;
  }

  /** Test à la demande d'un lien : ouvre, ferme, et renvoie le diagnostic. */
  std::string test(const std::string& link_id, bool& ok) {
    LinkConfig cfg;
    {
      std::lock_guard<std::mutex> lock(mu_);
      const auto it = std::find_if(config_.links.begin(), config_.links.end(),
                                   [&](const LinkConfig& l) { return l.id == link_id; });
      if (it == config_.links.end()) { ok = false; return "lien inconnu"; }
      cfg = *it;
    }
    NullSink sink(now());
    DriverPtr drv = make_driver(cfg, sink, simulate_);
    if (!drv) { ok = false; return "protocole inconnu"; }
    if (!drv->implemented()) { ok = false; return "pilote déclaré : lecture non implémentée"; }
    std::string err;
    if (!drv->open(err)) { ok = false; return err.empty() ? "connexion impossible" : err; }
    drv->close();
    ok = true;
    return simulate_ ? "valeurs simulées (option --sim-protocols)" : "connexion établie";
  }

  // ---- contrat IVariableSource -------------------------------------
  const Meta* subscribe(const std::string& raw, int period_ms) override {
    (void)period_ms;   // la période d'un point réseau vient de sa configuration
    std::lock_guard<std::mutex> lock(mu_);
    auto it = chans_.find(raw);
    if (it == chans_.end()) return nullptr;
    ++it->second.refs;
    return &it->second.meta;
  }

  void unsubscribe(const std::string& raw) override {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = chans_.find(raw);
    if (it != chans_.end() && it->second.refs > 0) --it->second.refs;
  }

  size_t read(const std::string& addr, double since_t,
              std::vector<Sample>& out, size_t max_out) override {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = chans_.find(addr);
    if (it == chans_.end()) return 0;
    const auto& buf = it->second.buf;
    size_t i = 0;
    if (since_t > -1e17) {
      size_t lo = 0, hi = buf.size();
      while (lo < hi) {
        const size_t m = (lo + hi) / 2;
        if (buf[m].t <= since_t) lo = m + 1; else hi = m;
      }
      i = lo;
    }
    const size_t avail = buf.size() - i;
    if (!avail) return 0;
    const size_t stepn = (max_out && avail > max_out) ? (avail + max_out - 1) / max_out : 1;
    for (size_t k = i; k < buf.size(); k += stepn) out.push_back(buf[k]);
    if (stepn > 1 && !out.empty() && out.back().t != buf.back().t) out.push_back(buf.back());
    return avail;
  }

  bool knows(const std::string& addr) const {
    std::lock_guard<std::mutex> lock(mu_);
    return chans_.count(addr) > 0;
  }

  size_t channel_count() const {
    std::lock_guard<std::mutex> lock(mu_);
    return chans_.size();
  }

 private:
  struct Channel {
    Meta meta;
    std::deque<Sample> buf;
    int refs = 0;
  };

  /** Réceptacle des valeurs d'un lien : traduit un indice de point en canal. */
  class LinkSink : public IPointSink {
   public:
    LinkSink(ProtocolSource& src, const LinkConfig& link) : src_(src) {
      for (const auto& p : link.points) {
        addrs_.push_back(net_addr(link.id, p.id));
        period_.push_back(p.period_ms / 1000.0);
        last_t_.push_back(-1e18);
        last_v_.push_back(0);
      }
      id_ = link.id;
    }
    double now() const override { return src_.now(); }

    /**
     * Décimation : sur un protocole à flux (IEC-104, CAN), un équipement
     * bavard remplirait l'historique en quelques secondes. La période du point
     * borne donc la cadence conservée — mais tout changement de valeur passe,
     * pour ne jamais masquer une transition.
     */
    void warn(const std::string& msg) override { src_.set_status(id_, "up", msg); }

    void publish(size_t idx, double value) override {
      if (idx >= addrs_.size()) return;
      const double t = src_.now();
      if (t - last_t_[idx] < period_[idx] && value == last_v_[idx]) return;
      last_t_[idx] = t;
      last_v_[idx] = value;
      src_.push(addrs_[idx], value);
      ++count_;
      if (count_ % 64 == 1) src_.bump_samples(id_, count_);
    }

   private:
    ProtocolSource& src_;
    std::vector<std::string> addrs_;
    std::vector<double> period_, last_t_, last_v_;
    std::string id_;
    long long count_ = 0;
  };

  /** Réceptacle qui jette tout (test de connexion). */
  class NullSink : public IPointSink {
   public:
    explicit NullSink(double t) : t_(t) {}
    double now() const override { return t_; }
    void publish(size_t, double) override {}

   private:
    double t_;
  };

  struct Runner {
    std::thread th;
    std::unique_ptr<LinkSink> sink;
    std::atomic<bool> stop{false};
  };

  static double mono() {
    return static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch()).count()) / 1e6;
  }

  static DriverPtr make_driver(const LinkConfig& link, IPointSink& sink, bool simulate) {
    if (simulate) return std::make_unique<SimProtocolDriver>(link, sink);
    const std::string& p = link.protocol;
    if (p == "modbus-tcp") return std::make_unique<ModbusDriver>(link, sink, false);
    if (p == "modbus-rtu") return std::make_unique<ModbusDriver>(link, sink, true);
    if (p == "iec104")     return std::make_unique<Iec104Driver>(link, sink);
    if (p == "can-raw")    return std::make_unique<CanDriver>(link, sink, CanMode::Raw);
    if (p == "j1939")      return std::make_unique<CanDriver>(link, sink, CanMode::J1939);
    if (p == "canopen")    return std::make_unique<CanDriver>(link, sink, CanMode::CanOpen);
    if (p == "iec61850")
      return std::make_unique<DeclaredDriver>(
          "pile ISO/MMS non implémentée — configuration conservée (voir docs/PROTOCOLES.md)");
    return nullptr;
  }

  void push(const std::string& addr, double v) {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = chans_.find(addr);
    if (it == chans_.end()) return;
    auto& ch = it->second;
    const double t = now();
    ch.buf.push_back({t, v});
    const double min_t = t - horizon_s_;
    while (!ch.buf.empty() && ch.buf.front().t < min_t) ch.buf.pop_front();
  }

  void bump_samples(const std::string& link_id, long long n) {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = status_.find(link_id);
    if (it != status_.end()) it->second.samples = n;
  }

 public:
  void set_status(const std::string& id, const std::string& state, const std::string& detail) {
    std::lock_guard<std::mutex> lock(mu_);
    auto& st = status_[id];
    st.id = id;
    st.state = state;
    st.detail = detail;
    st.since = now();
  }

 private:
  void start_all() {
    for (const auto& link : config_.links) {
      if (!link.enabled) continue;
      auto runner = std::make_unique<Runner>();
      runner->sink = std::make_unique<LinkSink>(*this, link);
      Runner* raw = runner.get();
      const LinkConfig cfg = link;
      const bool simulate = simulate_;
      runner->th = std::thread([this, cfg, raw, simulate] {
        double backoff = 1.0;
        while (!raw->stop) {
          DriverPtr drv = make_driver(cfg, *raw->sink, simulate);
          if (!drv) { set_status(cfg.id, "down", "protocole inconnu : " + cfg.protocol); return; }
          if (!drv->implemented()) {
            std::string why;
            drv->open(why);
            set_status(cfg.id, "todo", why);
            return;                                  // inutile de réessayer
          }
          std::string err;
          if (!drv->open(err)) {
            set_status(cfg.id, "down", err.empty() ? "connexion impossible" : err);
            sleep_backoff(raw, backoff);
            backoff = std::min(30.0, backoff * 2);
            continue;
          }
          set_status(cfg.id, simulate ? "sim" : "up",
                     simulate ? "valeurs simulées (--sim-protocols)" : "lien établi");
          backoff = 1.0;
          while (!raw->stop) {
            if (!drv->service(err)) {
              set_status(cfg.id, "down", err.empty() ? "lien interrompu" : err);
              break;
            }
          }
          drv->close();
          if (!raw->stop) sleep_backoff(raw, backoff);
        }
      });
      runners_.push_back(std::move(runner));
    }
  }

  static void sleep_backoff(Runner* r, double seconds) {
    const double end = mono() + seconds;
    while (!r->stop && mono() < end) {
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
  }

  void stop_all() {
    for (auto& r : runners_) r->stop = true;
    for (auto& r : runners_) if (r->th.joinable()) r->th.join();
    runners_.clear();
  }

  const IVariableSource& clock_;
  mutable std::mutex mu_;
  std::mutex apply_mu_;          // sérialise les applications de configuration
  ProtocolConfig config_;
  std::map<std::string, Channel> chans_;
  std::map<std::string, LinkStatus> status_;
  std::vector<std::unique_ptr<Runner>> runners_;
  double horizon_s_;
  int default_period_ms_;
  bool simulate_;
};

/** Aiguillage : « @… » vers les liens réseau, le reste vers le controller. */
class CompositeSource : public IVariableSource {
 public:
  CompositeSource(IVariableSource& controller, ProtocolSource& net)
      : controller_(controller), net_(net) {}

  const char* name() const override { return controller_.name(); }
  double now() const override { return controller_.now(); }

  const Meta* subscribe(const std::string& addr, int period_ms) override {
    return pick(addr).subscribe(addr, period_ms);
  }
  void unsubscribe(const std::string& addr) override { pick(addr).unsubscribe(addr); }
  size_t read(const std::string& addr, double since_t,
              std::vector<Sample>& out, size_t max_out) override {
    return pick(addr).read(addr, since_t, out, max_out);
  }
  bool write(const std::string& addr, const double* value, std::string& err) override {
    if (!addr.empty() && addr[0] == '@') {
      err = "point reseau en lecture seule";
      return false;
    }
    return controller_.write(addr, value, err);
  }

 private:
  IVariableSource& pick(const std::string& addr) {
    return (!addr.empty() && addr[0] == '@') ? static_cast<IVariableSource&>(net_) : controller_;
  }
  IVariableSource& controller_;
  ProtocolSource& net_;
};

}  // namespace diagweb
