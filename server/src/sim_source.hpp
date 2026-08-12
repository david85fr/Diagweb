// Diagweb — source de variables simulée (bouchon du controller).
//
// Reproduit les générateurs de web/js/sim.js (mêmes graines, mêmes lois) pour
// que le serveur de diagnostic présente exactement les mêmes signaux que la
// simulation navigateur. À remplacer par le binding du controller.
#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "source.hpp"

namespace diagweb {

// ---------------------------------------------------------------- générateurs
enum class SimType { Sine, Walk, Steps, Square, BitChain, Counter, Jitter };

struct SimSpec {
  SimType type = SimType::Sine;
  double base = 0, amp = 0, period = 1, noise = 0;
  double step = 0, lo = 0, hi = 1, drift = 0;
  double rate = 0, duty = 0.5, t0 = 10, t1 = 10;
  double spike_p = 0, spike_amp = 0;
  std::vector<double> values;
};

inline SimSpec sine(double base, double amp, double period, double noise) {
  SimSpec s; s.type = SimType::Sine; s.base = base; s.amp = amp; s.period = period; s.noise = noise; return s;
}
inline SimSpec walk(double base, double step, double lo, double hi, double drift) {
  SimSpec s; s.type = SimType::Walk; s.base = base; s.step = step; s.lo = lo; s.hi = hi; s.drift = drift; return s;
}
inline SimSpec steps(std::vector<double> values, double period, double noise) {
  SimSpec s; s.type = SimType::Steps; s.values = std::move(values); s.period = period; s.noise = noise; return s;
}
inline SimSpec square(double period, double duty) {
  SimSpec s; s.type = SimType::Square; s.period = period; s.duty = duty; return s;
}
inline SimSpec bitchain(double t0, double t1) {
  SimSpec s; s.type = SimType::BitChain; s.t0 = t0; s.t1 = t1; return s;
}
inline SimSpec counter(double rate) {
  SimSpec s; s.type = SimType::Counter; s.rate = rate; return s;
}
inline SimSpec jitter(double base, double noise, double spike_p, double spike_amp) {
  SimSpec s; s.type = SimType::Jitter; s.base = base; s.noise = noise;
  s.spike_p = spike_p; s.spike_amp = spike_amp; return s;
}

struct CatalogEntry {
  const char* addr;
  const char* label;
  const char* unit;
  Kind kind;
  SimSpec sim;
};

// Générateur pseudo-aléatoire identique à celui du simulateur web
// (FNV-1a 32 bits + mulberry32), pour des signaux reproductibles.
inline uint32_t hash32(const std::string& s) {
  uint32_t h = 2166136261u;
  for (unsigned char c : s) { h ^= c; h *= 16777619u; }
  return h;
}

class Mulberry32 {
 public:
  explicit Mulberry32(uint32_t seed) : a_(seed) {}
  double operator()() {
    a_ += 0x6D2B79F5u;
    uint32_t t = a_;
    t = (t ^ (t >> 15)) * (1u | t);
    t += (t ^ (t >> 7)) * (61u | t);
    t ^= t;
    uint32_t r = (a_ ^ (a_ >> 15)) * (1u | a_);
    r += (r ^ (r >> 7)) * (61u | r);
    return static_cast<double>((r ^ (r >> 14))) / 4294967296.0;
  }

 private:
  uint32_t a_;
};

/** Générateur d'une variable : v = f(t), avec l'état interne nécessaire. */
class Generator {
 public:
  Generator(const SimSpec& spec, Kind kind, const std::string& addr)
      : spec_(spec), kind_(kind), rnd_(hash32(addr)) {
    phase_ = rnd_() * 1000.0;
    switch (spec_.type) {
      case SimType::Walk:
        cur_ = spec_.base;
        break;
      case SimType::Steps:
        cur_ = spec_.values.empty() ? 0 : spec_.values[static_cast<size_t>(rnd_() * spec_.values.size()) % spec_.values.size()];
        break;
      case SimType::BitChain:
        cur_ = rnd_() < spec_.t1 / (spec_.t0 + spec_.t1) ? 1 : 0;
        break;
      default:
        break;
    }
  }

  double operator()(double t) {
    switch (spec_.type) {
      case SimType::Sine: {
        double v = spec_.base + spec_.amp * std::sin((t + phase_) * 2 * M_PI / spec_.period) +
                   spec_.noise * (rnd_() - 0.5) * 2;
        if (kind_ == Kind::Word) v = std::max(0.0, std::min(65535.0, std::round(v)));
        return v;
      }
      case SimType::Walk: {
        cur_ += (rnd_() - 0.5) * 2 * spec_.step + spec_.drift;
        if (cur_ < spec_.lo) cur_ = spec_.lo + (spec_.lo - cur_);
        if (cur_ > spec_.hi) cur_ = spec_.hi - (cur_ - spec_.hi);
        cur_ = std::max(spec_.lo, std::min(spec_.hi, cur_));
        return cur_;
      }
      case SimType::Steps: {
        if (!have_next_) { next_at_ = t + spec_.period * (0.5 + rnd_()); have_next_ = true; }
        if (t >= next_at_ && !spec_.values.empty()) {
          cur_ = spec_.values[static_cast<size_t>(rnd_() * spec_.values.size()) % spec_.values.size()];
          next_at_ = t + spec_.period * (0.5 + rnd_());
        }
        double v = cur_ + spec_.noise * (rnd_() - 0.5) * 2;
        return kind_ == Kind::Word ? std::round(v) : v;
      }
      case SimType::Square: {
        const double m = std::fmod(t + phase_, spec_.period);
        return (m < spec_.period * spec_.duty) ? 1.0 : 0.0;
      }
      case SimType::BitChain: {
        if (!have_next_) {
          next_at_ = t + (cur_ > 0.5 ? spec_.t1 : spec_.t0) * (0.3 + rnd_() * 1.4);
          have_next_ = true;
        }
        if (t >= next_at_) {
          cur_ = cur_ > 0.5 ? 0 : 1;
          next_at_ = t + (cur_ > 0.5 ? spec_.t1 : spec_.t0) * (0.3 + rnd_() * 1.4);
        }
        return cur_;
      }
      case SimType::Counter: {
        const double n = std::round(spec_.rate * t);
        return std::fmod(std::fmod(n, 65536.0) + 65536.0, 65536.0);
      }
      case SimType::Jitter: {
        double v = spec_.base + (rnd_() - 0.5) * 2 * spec_.noise;
        if (rnd_() < spec_.spike_p) v += spec_.spike_amp * rnd_();
        return v;
      }
    }
    return 0;
  }

 private:
  SimSpec spec_;
  Kind kind_;
  Mulberry32 rnd_;
  double phase_ = 0, cur_ = 0, next_at_ = 0;
  bool have_next_ = false;
};

// ------------------------------------------------------------------- source
class SimSource : public IVariableSource {
 public:
  SimSource(const std::vector<CatalogEntry>& catalog, double horizon_s, int default_period_ms)
      : horizon_s_(horizon_s), default_period_ms_(default_period_ms), start_(clock_now()) {
    for (const auto& e : catalog) cat_[e.addr] = &e;
  }

  const char* name() const override { return "Serveur de diagnostic (simulation)"; }
  double now() const override { return clock_now() - start_; }

  const Meta* subscribe(const std::string& raw, int period_ms) override {
    const ParsedAddr p = parse_addr(raw);
    if (!p.ok) return nullptr;
    if (period_ms <= 0) period_ms = default_period_ms_;
    const double period_s = std::max(default_period_ms_ / 1000.0, std::min(10.0, period_ms / 1000.0));

    std::lock_guard<std::mutex> lock(mu_);
    auto it = chans_.find(p.addr);
    if (it != chans_.end()) {
      ++it->second.refs;
      it->second.period_s = std::min(it->second.period_s, period_s);
      return &it->second.meta;
    }

    Channel ch;
    ch.meta.addr = p.addr;
    ch.meta.family = p.family;
    ch.meta.kind = p.kind;
    ch.period_s = period_s;
    ch.refs = 1;

    auto cit = cat_.find(p.addr);
    if (cit != cat_.end()) {
      ch.meta.label = cit->second->label;
      ch.meta.unit = cit->second->unit;
      ch.meta.kind = cit->second->kind;
      ch.meta.known = true;
      ch.gen = std::make_unique<Generator>(cit->second->sim, ch.meta.kind, p.addr);
    } else {
      ch.meta.label = family_label(p.family) + " (hors catalogue)";
      ch.meta.known = false;
      ch.gen = std::make_unique<Generator>(default_spec(p.kind, p.addr), p.kind, p.addr);
    }

    // Pré-remplissage de l'historique : les courbes sont pleines dès l'ajout
    const double t_now = now();
    for (double t = t_now - horizon_s_; t <= t_now; t += ch.period_s) {
      push(ch, t, (*ch.gen)(t));
    }
    ch.next_t = t_now + ch.period_s;

    auto [ins, ok] = chans_.emplace(p.addr, std::move(ch));
    return &ins->second.meta;
  }

  void unsubscribe(const std::string& raw) override {
    const ParsedAddr p = parse_addr(raw);
    if (!p.ok) return;
    std::lock_guard<std::mutex> lock(mu_);
    auto it = chans_.find(p.addr);
    if (it == chans_.end()) return;
    if (--it->second.refs <= 0) chans_.erase(it);
  }

  size_t read(const std::string& addr, double since_t,
              std::vector<Sample>& out, size_t max_out) override {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = chans_.find(addr);
    if (it == chans_.end()) return 0;
    const auto& buf = it->second.buf;

    // Recherche du premier échantillon strictement postérieur à since_t
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
    if (avail == 0) return 0;
    // Décimation régulière si le client demande moins de points qu'il n'y en a
    const size_t stepn = (max_out && avail > max_out) ? (avail + max_out - 1) / max_out : 1;
    for (size_t k = i; k < buf.size(); k += stepn) out.push_back(buf[k]);
    if (stepn > 1 && !out.empty() && out.back().t != buf.back().t) out.push_back(buf.back());
    return avail;
  }

  /** Avance tous les canaux jusqu'à l'instant courant (thread d'acquisition). */
  void tick() {
    std::lock_guard<std::mutex> lock(mu_);
    const double t = now();
    for (auto& [addr, ch] : chans_) {
      if (t - ch.next_t > 2.0) ch.next_t = t;   // rattrapage borné
      while (ch.next_t <= t) {
        push(ch, ch.next_t, (*ch.gen)(ch.next_t));
        ch.next_t += ch.period_s;
      }
    }
  }

  size_t channel_count() {
    std::lock_guard<std::mutex> lock(mu_);
    return chans_.size();
  }

 private:
  struct Channel {
    Meta meta;
    std::unique_ptr<Generator> gen;
    std::deque<Sample> buf;
    double period_s = 0.01;
    double next_t = 0;
    int refs = 0;
  };

  static double clock_now() {
    return static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(
               std::chrono::steady_clock::now().time_since_epoch()).count()) / 1e6;
  }

  static std::string family_label(const std::string& f) {
    if (f == "I") return "Entree TOR";
    if (f == "Q") return "Sortie TOR";
    if (f == "M") return "Bit memoire";
    if (f == "S") return "Variable systeme";
    if (f == "MB") return "Mot de bus";
    return "Signal de modele";
  }

  static SimSpec default_spec(Kind kind, const std::string& addr) {
    Mulberry32 r(hash32(addr) ^ 0x9E3779B9u);
    if (kind == Kind::Bit) return bitchain(4 + r() * 30, 4 + r() * 30);
    if (kind == Kind::Word) {
      const double base = std::round(500 + r() * 40000);
      return sine(base, base * 0.06 + 20, 8 + r() * 60, 25);
    }
    const double base = std::round((r() * 200 - 40) * 10) / 10;
    return sine(base, 2 + r() * 25, 8 + r() * 50, 0.4);
  }

  void push(Channel& ch, double t, double v) {
    ch.buf.push_back({t, v});
    const double min_t = t - horizon_s_;
    while (!ch.buf.empty() && ch.buf.front().t < min_t) ch.buf.pop_front();
  }

  std::map<std::string, const CatalogEntry*> cat_;
  std::map<std::string, Channel> chans_;
  std::mutex mu_;
  double horizon_s_;
  int default_period_ms_;
  double start_;
};

}  // namespace diagweb
