// Diagweb — processus serveur de diagnostic (prototype).
//
// Rôle, conforme à docs/PROJET.md « Architecture cible » : servir les pages
// web ET relayer le flux temps réel des variables vers le navigateur. Le
// controller — le cœur du produit (C++, modèles générés) — vit dans un
// processus séparé ; ici il est remplacé par SimSource tant que le binding
// n'existe pas.
//
//   diagweb-server [--port 8080] [--root .] [--data-dir .diag-data]
//
// Points d'entrée :
//   GET  /ws                    flux temps réel (WebSocket, voir PROTOCOLE)
//   GET  /api/health            état du serveur
//   GET  /api/protocols         configuration des liens réseau + état + protocoles
//   PUT  /api/protocols         enregistre et applique la configuration des liens
//   GET  /api/protocols/status  état courant des liens
//   POST /api/protocols/test    test de connexion d'un lien
//   GET  /api/layouts           liste des configurations enregistrées
//   GET  /api/layouts/<nom>     une configuration
//   PUT  /api/layouts/<nom>     enregistre une configuration
//   POST /api/datalog           journal de données (ajout en JSON Lines)
//   GET  /...                   fichiers statiques sous --root
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "catalog.generated.hpp"
#include "json.hpp"
#include "jvalue.hpp"
#include "protocol_source.hpp"
#include "protocols.generated.hpp"
#include "source.hpp"
#include "ws.hpp"

namespace fs = std::filesystem;
using namespace diagweb;

namespace {

std::atomic<bool> g_stop{false};

struct Options {
  int port = 8080;
  std::string root = ".";
  std::string data_dir = ".diag-data";
  double history_s = 60;      // historique envoyé à l'abonnement
  size_t max_points = 1500;   // points max par variable et par envoi
  int flush_ms = 60;          // cadence d'émission des lots
  bool sim_protocols = false; // liens réseau simulés (démonstration sans matériel)
};

/** Liens réseau : instance unique, partagée par les requêtes HTTP. */
ProtocolSource* g_net = nullptr;

fs::path protocols_file(const Options& opt) {
  return fs::path(opt.data_dir) / "protocols.json";
}

void save_protocols(const Options& opt, const ProtocolConfig& cfg) {
  std::error_code ec;
  fs::create_directories(opt.data_dir, ec);
  std::ofstream f(protocols_file(opt), std::ios::binary | std::ios::trunc);
  if (f) f << cfg.to_json().dump();
}

ProtocolConfig load_protocols(const Options& opt) {
  std::ifstream f(protocols_file(opt), std::ios::binary);
  if (!f) return {};
  std::ostringstream body;
  body << f.rdbuf();
  bool ok = false;
  const JValue j = jparse(body.str(), &ok);
  if (!ok) {
    std::cerr << "  configuration des liens reseau illisible, ignoree" << std::endl;
    return {};
  }
  return ProtocolConfig::from_json(j);
}

/** État des liens, au format attendu par l'interface. */
std::string statuses_json() {
  std::ostringstream o;
  o << '[';
  if (g_net) {
    bool first = true;
    for (const auto& st : g_net->statuses()) {
      if (!first) o << ',';
      first = false;
      o << "{\"id\":\"" << jesc(st.id) << "\",\"state\":\"" << jesc(st.state)
        << "\",\"detail\":\"" << jesc(st.detail) << "\",\"samples\":" << st.samples << '}';
    }
  }
  o << ']';
  return o.str();
}

// ------------------------------------------------------------------ réseau
bool send_all(int fd, const std::string& data) {
  size_t sent = 0;
  while (sent < data.size()) {
    const ssize_t n = ::send(fd, data.data() + sent, data.size() - sent, MSG_NOSIGNAL);
    if (n <= 0) return false;
    sent += static_cast<size_t>(n);
  }
  return true;
}

// --------------------------------------------------------------------- HTTP
struct Request {
  std::string method, target, body;
  std::map<std::string, std::string> headers;   // noms en minuscules
};

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

/** Lit une requête complète (en-têtes + corps). false si connexion perdue. */
bool read_request(int fd, std::string& buf, Request& req) {
  size_t head_end;
  while ((head_end = buf.find("\r\n\r\n")) == std::string::npos) {
    char tmp[4096];
    const ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) return false;
    buf.append(tmp, static_cast<size_t>(n));
    if (buf.size() > (8u << 20)) return false;
  }
  std::istringstream head(buf.substr(0, head_end));
  std::string line;
  std::getline(head, line);
  if (!line.empty() && line.back() == '\r') line.pop_back();
  {
    std::istringstream ls(line);
    std::string version;
    ls >> req.method >> req.target >> version;
  }
  while (std::getline(head, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const size_t colon = line.find(':');
    if (colon == std::string::npos) continue;
    std::string value = line.substr(colon + 1);
    while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) value.erase(0, 1);
    req.headers[lower(line.substr(0, colon))] = value;
  }
  buf.erase(0, head_end + 4);

  size_t content_length = 0;
  if (auto it = req.headers.find("content-length"); it != req.headers.end()) {
    content_length = static_cast<size_t>(std::stoul(it->second));
  }
  while (buf.size() < content_length) {
    char tmp[8192];
    const ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) return false;
    buf.append(tmp, static_cast<size_t>(n));
  }
  req.body = buf.substr(0, content_length);
  buf.erase(0, content_length);
  return true;
}

void respond(int fd, int code, const std::string& status, const std::string& type,
             const std::string& body, const std::string& extra = {}) {
  std::ostringstream o;
  o << "HTTP/1.1 " << code << ' ' << status << "\r\n"
    << "Content-Type: " << type << "\r\n"
    << "Content-Length: " << body.size() << "\r\n"
    << "Cache-Control: no-store\r\n"
    << "Connection: keep-alive\r\n"
    << extra << "\r\n";
  send_all(fd, o.str() + body);
}

void respond_json(int fd, const std::string& json, int code = 200) {
  respond(fd, code, code == 200 ? "OK" : "Error", "application/json; charset=utf-8", json);
}

const char* mime_of(const std::string& path) {
  const size_t dot = path.rfind('.');
  const std::string ext = dot == std::string::npos ? "" : lower(path.substr(dot));
  if (ext == ".html") return "text/html; charset=utf-8";
  if (ext == ".js")   return "text/javascript; charset=utf-8";
  if (ext == ".css")  return "text/css; charset=utf-8";
  if (ext == ".json") return "application/json; charset=utf-8";
  if (ext == ".svg")  return "image/svg+xml";
  if (ext == ".png")  return "image/png";
  if (ext == ".ico")  return "image/x-icon";
  return "application/octet-stream";
}

/** Nom de fichier sûr pour une configuration (pas de traversée de chemin). */
std::string safe_name(const std::string& raw) {
  std::string out;
  for (size_t i = 0; i < raw.size(); ++i) {
    if (raw[i] == '%' && i + 2 < raw.size()) {   // décodage pour-cent
      out += static_cast<char>(std::stoi(raw.substr(i + 1, 2), nullptr, 16));
      i += 2;
      continue;
    }
    out += raw[i] == '+' ? ' ' : raw[i];
  }
  std::string clean;
  for (char c : out) {
    if (c == '/' || c == '\\' || c == '.' || c == '\0') clean += '_';
    else clean += c;
  }
  if (clean.empty()) clean = "sans-nom";
  return clean.substr(0, 80);
}

// --------------------------------------------------------------------- REST
bool handle_api(int fd, const Request& req, IVariableSource& src, const Options& opt) {
  const std::string& t = req.target;
  if (t.rfind("/api/", 0) != 0) return false;

  if (t == "/api/health") {
    std::ostringstream o;
    o << "{\"app\":\"diagweb\",\"role\":\"diag-server\",\"protocol\":1"
      << ",\"source\":\"" << jesc(src.name()) << "\""
      << ",\"now\":" << jnum(src.now(), 3)
      << ",\"defaultPeriodMs\":" << kDefaultPeriodMs
      << ",\"horizonS\":" << jnum(kHorizonS, 0) << "}";
    respond_json(fd, o.str());
    return true;
  }

  // ---- liens réseau -------------------------------------------------
  if (t == "/api/protocols" && req.method == "GET") {
    std::ostringstream o;
    o << "{\"config\":" << (g_net ? g_net->config().to_json().dump() : "{\"version\":1,\"links\":[]}")
      << ",\"status\":" << statuses_json()
      << ",\"protocols\":" << protocols_descriptors_json()
      << ",\"simulated\":" << (opt.sim_protocols ? "true" : "false") << '}';
    respond_json(fd, o.str());
    return true;
  }

  if (t == "/api/protocols" && (req.method == "PUT" || req.method == "POST")) {
    bool ok = false;
    const JValue j = jparse(req.body, &ok);
    if (!ok) { respond_json(fd, "{\"error\":\"JSON invalide\"}", 400); return true; }
    const ProtocolConfig cfg = ProtocolConfig::from_json(j);
    if (g_net) g_net->apply(cfg);
    save_protocols(opt, cfg);
    std::cout << "  liens reseau : " << cfg.links.size() << " lien(s) applique(s)" << std::endl;
    std::ostringstream o;
    o << "{\"ok\":true,\"status\":" << statuses_json() << '}';
    respond_json(fd, o.str());
    return true;
  }

  if (t == "/api/protocols/status" && req.method == "GET") {
    respond_json(fd, statuses_json());
    return true;
  }

  if (t == "/api/protocols/test" && (req.method == "POST" || req.method == "PUT")) {
    const std::string id = jstr(req.body, "id");
    bool ok = false;
    const std::string detail = g_net ? g_net->test(id, ok) : "liens reseau indisponibles";
    std::ostringstream o;
    o << "{\"ok\":" << (ok ? "true" : "false") << ",\"detail\":\"" << jesc(detail) << "\"}";
    respond_json(fd, o.str());
    return true;
  }

  const fs::path layouts = fs::path(opt.data_dir) / "layouts";
  if (t == "/api/layouts" && req.method == "GET") {
    std::ostringstream o;
    o << '[';
    bool first = true;
    std::error_code ec;
    if (fs::exists(layouts, ec)) {
      for (const auto& e : fs::directory_iterator(layouts, ec)) {
        if (e.path().extension() != ".json") continue;
        // Horodatage en millisecondes depuis l'époque Unix (comme Date.now())
        const auto tp = fs::last_write_time(e.path(), ec);
        const auto sys = std::chrono::file_clock::to_sys(tp);
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                            sys.time_since_epoch()).count();
        if (!first) o << ',';
        first = false;
        o << "{\"name\":\"" << jesc(e.path().stem().string()) << "\",\"savedAt\":" << ms << '}';
      }
    }
    o << ']';
    respond_json(fd, o.str());
    return true;
  }

  if (t.rfind("/api/layouts/", 0) == 0) {
    const std::string name = safe_name(t.substr(std::strlen("/api/layouts/")));
    const fs::path file = layouts / (name + ".json");
    if (req.method == "PUT" || req.method == "POST") {
      std::error_code ec;
      fs::create_directories(layouts, ec);
      std::ofstream f(file, std::ios::binary | std::ios::trunc);
      if (!f) { respond_json(fd, "{\"error\":\"ecriture impossible\"}", 500); return true; }
      f << req.body;
      std::cout << "  configuration enregistree : " << file.string() << std::endl;
      respond_json(fd, "{\"ok\":true}");
      return true;
    }
    if (req.method == "GET") {
      std::ifstream f(file, std::ios::binary);
      if (!f) { respond_json(fd, "{\"error\":\"inconnue\"}", 404); return true; }
      std::ostringstream body;
      body << f.rdbuf();
      respond_json(fd, body.str());
      return true;
    }
  }

  if (t == "/api/datalog" && (req.method == "POST" || req.method == "PUT")) {
    std::error_code ec;
    const fs::path dir = fs::path(opt.data_dir) / "datalog";
    fs::create_directories(dir, ec);
    std::ofstream f(dir / "journal.jsonl", std::ios::binary | std::ios::app);
    if (!f) { respond_json(fd, "{\"error\":\"ecriture impossible\"}", 500); return true; }
    f << req.body << '\n';
    respond_json(fd, "{\"ok\":true}");
    return true;
  }

  respond_json(fd, "{\"error\":\"point d'entree inconnu\"}", 404);
  return true;
}

// ----------------------------------------------------------- fichiers statiques
void handle_static(int fd, const Request& req, const Options& opt) {
  std::string rel = req.target.substr(0, req.target.find('?'));
  if (rel == "/" || rel.empty()) rel = "/web/index.html";
  if (rel == "/favicon.ico") { respond(fd, 204, "No Content", "image/x-icon", ""); return; }
  if (rel.find("..") != std::string::npos) { respond(fd, 400, "Bad Request", "text/plain", "chemin invalide"); return; }

  std::error_code ec;
  fs::path file = fs::weakly_canonical(fs::path(opt.root) / rel.substr(1), ec);
  const fs::path root = fs::weakly_canonical(fs::path(opt.root), ec);
  if (file.string().rfind(root.string(), 0) != 0) {
    respond(fd, 403, "Forbidden", "text/plain", "hors racine");
    return;
  }
  if (fs::is_directory(file, ec)) file /= "index.html";

  std::ifstream f(file, std::ios::binary);
  if (!f) { respond(fd, 404, "Not Found", "text/plain", "introuvable"); return; }
  std::ostringstream body;
  body << f.rdbuf();
  respond(fd, 200, "OK", mime_of(file.string()), body.str());
}

// ----------------------------------------------------------------- WebSocket
/**
 * Session de flux temps réel. Protocole (trames texte JSON) :
 *   client → {"c":"sub","addr":"MB414","periodMs":10}
 *            {"c":"unsub","addr":"MB414"}
 *   serveur → {"e":"hello","now":..,"horizonS":..,"defaultPeriodMs":..,"source":".."}
 *            {"e":"meta","addr":..,"label":..,"unit":..,"kind":..,"family":..,"known":..}
 *            {"e":"err","addr":..,"msg":..}
 *            {"e":"d","now":..,"s":{"<addr>":[[t,v],..]}}
 */
void ws_session(int fd, const Request& req, IVariableSource& src, const Options& opt) {
  const auto key = req.headers.find("sec-websocket-key");
  if (key == req.headers.end()) { respond(fd, 400, "Bad Request", "text/plain", "cle absente"); return; }

  std::ostringstream hs;
  hs << "HTTP/1.1 101 Switching Protocols\r\n"
     << "Upgrade: websocket\r\nConnection: Upgrade\r\n"
     << "Sec-WebSocket-Accept: " << ws_accept(key->second) << "\r\n\r\n";
  if (!send_all(fd, hs.str())) return;

  std::map<std::string, double> subs;   // adresse → horodatage du dernier envoi
  std::string rx;
  std::vector<Sample> tmp;

  {
    std::ostringstream o;
    o << "{\"e\":\"hello\",\"now\":" << jnum(src.now(), 3)
      << ",\"horizonS\":" << jnum(kHorizonS, 0)
      << ",\"defaultPeriodMs\":" << kDefaultPeriodMs
      << ",\"source\":\"" << jesc(src.name()) << "\"}";
    if (!send_all(fd, ws_encode(Op::Text, o.str()))) return;
  }
  std::cout << "  client connecte" << std::endl;

  auto last_flush = std::chrono::steady_clock::now();
  while (!g_stop) {
    pollfd p{fd, POLLIN, 0};
    const int pr = ::poll(&p, 1, 20);
    if (pr < 0) break;
    if (pr > 0 && (p.revents & (POLLHUP | POLLERR))) break;
    if (pr > 0 && (p.revents & POLLIN)) {
      char buf[8192];
      const ssize_t n = ::recv(fd, buf, sizeof buf, 0);
      if (n <= 0) break;
      rx.append(buf, static_cast<size_t>(n));

      Frame fr;
      while (ws_decode(rx, fr)) {
        if (fr.op == Op::Close) { send_all(fd, ws_encode(Op::Close, {})); goto done; }
        if (fr.op == Op::Ping) { send_all(fd, ws_encode(Op::Pong, fr.payload)); continue; }
        if (fr.op != Op::Text) continue;

        const std::string cmd = jstr(fr.payload, "c");
        const std::string addr = jstr(fr.payload, "addr");
        if (cmd == "sub" && !addr.empty()) {
          const int period = static_cast<int>(jnumber(fr.payload, "periodMs", kDefaultPeriodMs));
          const Meta* m = src.subscribe(addr, period);
          if (!m) {
            std::ostringstream o;
            o << "{\"e\":\"err\",\"addr\":\"" << jesc(addr) << "\",\"msg\":\"adresse invalide\"}";
            send_all(fd, ws_encode(Op::Text, o.str()));
            continue;
          }
          std::ostringstream o;
          o << "{\"e\":\"meta\",\"addr\":\"" << jesc(m->addr) << "\""
            << ",\"label\":\"" << jesc(m->label) << "\""
            << ",\"unit\":\"" << jesc(m->unit) << "\""
            << ",\"kind\":\"" << kind_name(m->kind) << "\""
            << ",\"family\":\"" << jesc(m->family) << "\""
            << ",\"known\":" << (m->known ? "true" : "false") << '}';
          if (!send_all(fd, ws_encode(Op::Text, o.str()))) goto done;
          subs[m->addr] = src.now() - opt.history_s;
        } else if (cmd == "unsub" && !addr.empty()) {
          const ParsedAddr pa = parse_addr(addr);
          if (pa.ok && subs.erase(pa.addr)) src.unsubscribe(pa.addr);
        }
      }
    }

    const auto now_tp = std::chrono::steady_clock::now();
    if (std::chrono::duration_cast<std::chrono::milliseconds>(now_tp - last_flush).count() < opt.flush_ms) {
      continue;
    }
    last_flush = now_tp;
    if (subs.empty()) continue;

    std::ostringstream o;
    o << "{\"e\":\"d\",\"now\":" << jnum(src.now(), 3) << ",\"s\":{";
    bool any = false;
    for (auto& [addr, cursor] : subs) {
      tmp.clear();
      src.read(addr, cursor, tmp, opt.max_points);
      if (tmp.empty()) continue;
      if (any) o << ',';
      any = true;
      o << '"' << jesc(addr) << "\":[";
      for (size_t i = 0; i < tmp.size(); ++i) {
        if (i) o << ',';
        o << '[' << jnum(tmp[i].t, 3) << ',' << jnum(tmp[i].v, 4) << ']';
      }
      o << ']';
      cursor = tmp.back().t;
    }
    o << "}}";
    if (any && !send_all(fd, ws_encode(Op::Text, o.str()))) break;
  }

done:
  for (const auto& [addr, cursor] : subs) src.unsubscribe(addr);
  std::cout << "  client deconnecte" << std::endl;
}

void handle_connection(int fd, IVariableSource& src, const Options& opt) {
  int one = 1;
  ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);

  std::string buf;
  while (!g_stop) {
    Request req;
    if (!read_request(fd, buf, req)) break;

    const auto upgrade = req.headers.find("upgrade");
    if (upgrade != req.headers.end() && lower(upgrade->second).find("websocket") != std::string::npos) {
      ws_session(fd, req, src, opt);
      break;
    }
    if (handle_api(fd, req, src, opt)) continue;
    handle_static(fd, req, opt);
  }
  ::close(fd);
}

}  // namespace

int main(int argc, char** argv) {
  Options opt;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto next = [&]() { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--port") opt.port = std::atoi(next());
    else if (a == "--root") opt.root = next();
    else if (a == "--data-dir") opt.data_dir = next();
    else if (a == "--sim-protocols") opt.sim_protocols = true;
    else if (a == "--help") {
      std::cout << "diagweb-server [--port 8080] [--root .] [--data-dir .diag-data]"
                   " [--sim-protocols]\n"
                   "  --sim-protocols : liens reseau simules (demonstration sans materiel)\n";
      return 0;
    }
  }

  ::signal(SIGPIPE, SIG_IGN);
  ::signal(SIGINT, [](int) { g_stop = true; });
  ::signal(SIGTERM, [](int) { g_stop = true; });

  SimSource controller(catalog(), kHorizonS, kDefaultPeriodMs);

  // Liens réseau : même horloge que le controller, sinon les courbes des
  // points réseau ne seraient pas comparables aux variables internes.
  ProtocolSource net(controller, kHorizonS, kDefaultPeriodMs, opt.sim_protocols);
  g_net = &net;
  net.apply(load_protocols(opt));
  CompositeSource source(controller, net);

  // Thread d'acquisition : rôle du lien avec le controller
  std::thread sampler([&controller] {
    while (!g_stop) {
      controller.tick();
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
  });

  const int srv = ::socket(AF_INET, SOCK_STREAM, 0);
  if (srv < 0) { std::cerr << "socket : " << std::strerror(errno) << "\n"; return 1; }
  int one = 1;
  ::setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = INADDR_ANY;
  addr.sin_port = htons(static_cast<uint16_t>(opt.port));
  if (::bind(srv, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0) {
    std::cerr << "bind " << opt.port << " : " << std::strerror(errno) << "\n";
    g_stop = true; sampler.join(); return 1;
  }
  ::listen(srv, 16);

  std::cout << "Diagweb — serveur de diagnostic\n"
            << "  source  : " << source.name() << '\n'
            << "  liens   : " << net.config().links.size() << " configure(s)"
            << (opt.sim_protocols ? " (simules)" : "") << '\n'
            << "  racine  : " << fs::weakly_canonical(opt.root).string() << '\n'
            << "  donnees : " << opt.data_dir << '\n'
            << "  ecoute  : http://localhost:" << opt.port << "/web/index.html\n"
            << "            (flux temps reel : ws://localhost:" << opt.port << "/ws)\n"
            << std::endl;

  std::vector<std::thread> workers;
  while (!g_stop) {
    pollfd p{srv, POLLIN, 0};
    if (::poll(&p, 1, 200) <= 0) continue;
    const int fd = ::accept(srv, nullptr, nullptr);
    if (fd < 0) continue;
    workers.emplace_back([fd, &source, &opt] { handle_connection(fd, source, opt); });
    // Nettoyage des threads terminés (prototype : quelques clients au plus)
    if (workers.size() > 32) {
      for (auto& t : workers) if (t.joinable()) t.detach();
      workers.clear();
    }
  }

  ::close(srv);
  g_stop = true;
  sampler.join();
  for (auto& t : workers) if (t.joinable()) t.detach();
  std::cout << "Arret." << std::endl;
  return 0;
}
