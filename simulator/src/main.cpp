// Diagweb — device simulator process (simulated third-party equipment).
//
// A third process alongside the controller and the diagnostic server: it plays
// the part of the third-party equipment the diagnostic server reads from. The
// point is to have a bench that behaves like real hardware — animated values,
// exceptions on a bad address, several units on one port — so that a link, a
// point, a curve or a log campaign can be prepared, demonstrated and tested
// without a single cable.
//
//   diagweb-simulator [--port 502] [--bind 0.0.0.0] [--config devices.json]
//                     [--latency-ms 0] [--list] [--print-config] [--quiet]
//
// Step one serves Modbus TCP. The bench (bench.hpp) is protocol-agnostic on
// purpose: SNMP, OPC UA and IEC 61850 will be further front-ends over the very
// same signals, not further simulators.
//
// Careful with --port 502: a port below 1024 needs a privilege. Either
//   sudo setcap cap_net_bind_service=+ep build/diagweb-simulator
// once, or pick a free port with --port 5020.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <cstring>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "bench.hpp"
#include "drivers/common/net.hpp"
#include "modbus_tcp.hpp"

using namespace diagweb;
using namespace diagweb::sim;

namespace {

std::atomic<bool> g_stop{false};

struct Options {
  int port = 502;
  std::string bind_addr = "0.0.0.0";
  std::string config;
  int latency_ms = 0;
  bool quiet = false;
};

/** Bench and its counters, both guarded by the same lock. */
struct Shared {
  std::mutex mu;
  Bench bench;
  modbus::Stats stats;
};

bool send_all(int fd, const std::string& data) {
  return net::write_all(fd, reinterpret_cast<const uint8_t*>(data.data()), data.size());
}

/**
 * One connected master. Several may be connected at once — the diagnostic
 * server and a hand-held tool, typically — and each gets its own thread.
 */
void serve_client(int fd, Shared& shared, const Options& opt, const std::string& who) {
  int one = 1;
  ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);

  // Same safety net as the diagnostic server: this body runs in a thread, and
  // an exception escaping it would call std::terminate and take the whole
  // process down. One misbehaving client must never cost more than its socket.
  try {
    std::string in, out;
    char buf[1024];
    while (!g_stop) {
      pollfd p{fd, POLLIN, 0};
      const int r = ::poll(&p, 1, 200);
      if (r < 0) {
        if (errno == EINTR) continue;
        break;
      }
      if (r == 0) continue;
      const ssize_t k = ::read(fd, buf, sizeof buf);
      if (k < 0 && (errno == EAGAIN || errno == EINTR)) continue;
      if (k <= 0) break;                       // peer closed, or link lost
      in.append(buf, static_cast<size_t>(k));
      if (in.size() > 65536) break;            // never a Modbus stream: give up

      bool usable = true;
      {
        std::lock_guard<std::mutex> lock(shared.mu);
        usable = modbus::pump(shared.bench, in, out, shared.stats);
      }
      // Injected latency: the point is to reach the master's timeout on
      // purpose, so the lock is released first — a slow client must not slow
      // down the bench for everyone else.
      if (opt.latency_ms > 0 && !out.empty()) net::sleep_ms(opt.latency_ms);
      if (!out.empty() && !send_all(fd, out)) break;
      out.clear();
      if (!usable) break;
    }
  } catch (const std::exception& e) {
    std::cerr << "  connexion abandonnée : " << e.what() << std::endl;
  } catch (...) {
    std::cerr << "  connexion abandonnée (exception inconnue)" << std::endl;
  }
  ::close(fd);
  if (!opt.quiet) std::cout << "  ↤ " << who << " déconnecté" << std::endl;
}

bool read_file(const std::string& path, std::string& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  std::ostringstream ss;
  ss << f.rdbuf();
  out = ss.str();
  return true;
}

void usage() {
  std::cout <<
      "diagweb-simulator — équipements simulés (Modbus TCP)\n"
      "\n"
      "  --port <n>         port d'écoute (502 par défaut ; 0 = port libre)\n"
      "  --bind <ip>        adresse d'écoute (0.0.0.0 par défaut)\n"
      "  --config <fichier> configuration JSON des équipements\n"
      "  --latency-ms <n>   retard ajouté à chaque réponse (essai des délais)\n"
      "  --list             affiche la table des registres puis quitte\n"
      "  --print-config     écrit la configuration par défaut puis quitte\n"
      "  --quiet            n'affiche pas les connexions\n"
      "\n"
      "Un port sous 1024 demande un privilège :\n"
      "  sudo setcap cap_net_bind_service=+ep <binaire>   (une seule fois)\n"
      "ou choisir un port libre : --port 5020\n";
}

}  // namespace

int main(int argc, char** argv) {
  Options opt;
  bool want_list = false;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto next = [&]() { return i + 1 < argc ? std::string(argv[++i]) : std::string(); };
    if (a == "--port") opt.port = std::atoi(next().c_str());
    else if (a == "--bind") opt.bind_addr = next();
    else if (a == "--config") opt.config = next();
    else if (a == "--latency-ms") opt.latency_ms = std::atoi(next().c_str());
    else if (a == "--list") want_list = true;
    else if (a == "--quiet") opt.quiet = true;
    else if (a == "--print-config") { std::cout << default_config(); return 0; }
    else if (a == "--help" || a == "-h") { usage(); return 0; }
    else {
      std::cerr << "option inconnue : " << a << "\n\n";
      usage();
      return 2;
    }
  }
  if (opt.port < 0 || opt.port > 65535) {
    std::cerr << "port hors plage : " << opt.port << "\n";
    return 2;
  }

  // ------------------------------------------------------------ configuration
  std::string text = default_config();
  if (!opt.config.empty() && !read_file(opt.config, text)) {
    std::cerr << opt.config << " : " << std::strerror(errno) << "\n";
    return 1;
  }
  bool parsed = false;
  const JValue root = jparse(text, &parsed);
  if (!parsed || !root.is_obj()) {
    std::cerr << (opt.config.empty() ? "configuration interne" : opt.config)
              << " : JSON illisible\n";
    return 1;
  }

  std::vector<std::string> warnings;
  Shared shared;
  shared.bench = Bench::from_json(root, warnings);
  for (const std::string& w : warnings) std::cerr << "  ⚠ " << w << std::endl;
  if (shared.bench.devices.empty()) {
    std::cerr << "aucun équipement utilisable : rien à simuler.\n";
    return 1;
  }

  size_t exposed = 0;
  for (const Device& d : shared.bench.devices) {
    for (const Signal& s : d.signals) {
      if (s.modbus.exposed) ++exposed;
    }
  }

  if (want_list) {
    shared.bench.tick(0);
    std::cout << "Diagweb — simulateur d'équipements\n" << shared.bench.map_text();
    return 0;
  }

  ::signal(SIGPIPE, SIG_IGN);
  ::signal(SIGINT, [](int) { g_stop = true; });
  ::signal(SIGTERM, [](int) { g_stop = true; });

  // ------------------------------------------------------------------ écoute
  const int srv = ::socket(AF_INET, SOCK_STREAM, 0);
  if (srv < 0) {
    std::cerr << "socket : " << std::strerror(errno) << "\n";
    return 1;
  }
  int one = 1;
  ::setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(opt.port));
  if (::inet_pton(AF_INET, opt.bind_addr.c_str(), &addr.sin_addr) != 1) {
    std::cerr << "adresse d'écoute invalide : " << opt.bind_addr << "\n";
    ::close(srv);
    return 2;
  }
  if (::bind(srv, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0) {
    const int e = errno;
    std::cerr << "bind " << opt.bind_addr << ':' << opt.port << " : " << std::strerror(e) << "\n";
    if (e == EACCES && opt.port < 1024) {
      std::cerr << "  Un port sous 1024 demande un privilège :\n"
                   "    sudo setcap cap_net_bind_service=+ep " << argv[0] << "\n"
                   "  ou choisir un port libre : --port 5020\n";
    }
    ::close(srv);
    return 1;
  }
  ::listen(srv, 16);

  // Le port réel : avec --port 0 c'est le système qui l'attribue.
  sockaddr_in bound{};
  socklen_t blen = sizeof bound;
  if (::getsockname(srv, reinterpret_cast<sockaddr*>(&bound), &blen) == 0) {
    opt.port = ntohs(bound.sin_port);
  }

  std::cout << "Diagweb — simulateur d'équipements\n"
            << "  équipements : " << shared.bench.devices.size() << " · "
            << shared.bench.signal_count() << " signaux, " << exposed << " exposés en Modbus\n"
            << "  adresse     : " << opt.bind_addr << '\n'
            << "  port        : " << opt.port << "  (Modbus TCP)\n"
            << "  source      : " << (opt.config.empty() ? "configuration interne (--print-config)"
                                                         : opt.config) << '\n';
  if (opt.latency_ms > 0) std::cout << "  retard      : " << opt.latency_ms << " ms par réponse\n";
  std::cout << "  lecture seule côté Diagweb : le serveur de diagnostic n'écrit jamais ici.\n"
            << std::endl;

  const double t0 = net::mono_s();
  std::thread ticker([&shared, t0] {
    while (!g_stop) {
      {
        std::lock_guard<std::mutex> lock(shared.mu);
        shared.bench.tick(net::mono_s() - t0);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
  });

  std::vector<std::thread> workers;
  while (!g_stop) {
    pollfd p{srv, POLLIN, 0};
    if (::poll(&p, 1, 200) <= 0) continue;
    sockaddr_in peer{};
    socklen_t plen = sizeof peer;
    const int fd = ::accept(srv, reinterpret_cast<sockaddr*>(&peer), &plen);
    if (fd < 0) continue;
    char ip[INET_ADDRSTRLEN] = "?";
    ::inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof ip);
    const std::string who = std::string(ip) + ':' + std::to_string(ntohs(peer.sin_port));
    if (!opt.quiet) std::cout << "  ↦ " << who << " connecté" << std::endl;
    workers.emplace_back([fd, &shared, &opt, who] { serve_client(fd, shared, opt, who); });
    if (workers.size() > 32) {
      for (auto& t : workers) {
        if (t.joinable()) t.detach();
      }
      workers.clear();
    }
  }

  ::close(srv);
  g_stop = true;
  ticker.join();
  for (auto& t : workers) {
    if (t.joinable()) t.detach();
  }
  std::lock_guard<std::mutex> lock(shared.mu);
  std::cout << "\nArrêt — " << shared.stats.requests << " requête(s), "
            << shared.stats.exceptions << " exception(s), " << shared.stats.dropped
            << " trame(s) écartée(s)." << std::endl;
  return 0;
}
