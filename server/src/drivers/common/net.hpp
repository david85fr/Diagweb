// Diagweb — briques réseau communes aux pilotes de protocoles (sans dépendance).
//
// Partagé par les pilotes sur IP et sur liaison série (modbus/, iec104/…) ;
// les pilotes CAN passent par common/can_socket.hpp.
//
// Connexion TCP avec délai maîtrisé (une résolution de nom ou un équipement
// absent ne doit jamais figer le fil d'un lien), lecture/écriture bornées dans
// le temps, et ouverture d'une liaison série en mode « brut ».
#pragma once

#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <termios.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace diagweb {
namespace net {

inline double mono_s() {
  return static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch()).count()) / 1e6;
}

/** Connexion TCP non bloquante bornée à `timeout_ms`. -1 et `err` en cas d'échec. */
inline int tcp_connect(const std::string& host, int port, int timeout_ms, std::string& err) {
  if (host.empty()) { err = "hôte non renseigné"; return -1; }
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  const std::string service = std::to_string(port);
  const int rc = ::getaddrinfo(host.c_str(), service.c_str(), &hints, &res);
  if (rc != 0 || !res) {
    err = "hôte introuvable (" + std::string(::gai_strerror(rc)) + ")";
    return -1;
  }

  int fd = -1;
  for (addrinfo* a = res; a; a = a->ai_next) {
    fd = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
    if (fd < 0) continue;
    ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    int r = ::connect(fd, a->ai_addr, a->ai_addrlen);
    if (r < 0 && errno == EINPROGRESS) {
      pollfd p{fd, POLLOUT, 0};
      r = ::poll(&p, 1, timeout_ms);
      if (r > 0) {
        int soerr = 0;
        socklen_t len = sizeof soerr;
        ::getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &len);
        r = soerr == 0 ? 0 : -1;
        if (soerr) err = std::strerror(soerr);
      } else {
        err = r == 0 ? "délai de connexion dépassé" : std::strerror(errno);
        r = -1;
      }
    } else if (r < 0) {
      err = std::strerror(errno);
    }
    if (r == 0) {
      int one = 1;
      ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
      ::setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof one);
      ::freeaddrinfo(res);
      return fd;
    }
    ::close(fd);
    fd = -1;
  }
  ::freeaddrinfo(res);
  if (err.empty()) err = "connexion impossible";
  return -1;
}

/** Écrit tout le tampon ; false si la liaison est perdue. */
inline bool write_all(int fd, const uint8_t* data, size_t n) {
  size_t sent = 0;
  while (sent < n) {
    const ssize_t k = ::write(fd, data + sent, n - sent);
    if (k > 0) { sent += static_cast<size_t>(k); continue; }
    if (k < 0 && (errno == EAGAIN || errno == EINTR)) {
      pollfd p{fd, POLLOUT, 0};
      if (::poll(&p, 1, 200) <= 0) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Lit exactement `n` octets avant l'expiration de `timeout_ms`.
 * Renvoie false sur délai dépassé ou liaison fermée.
 */
inline bool read_exact(int fd, uint8_t* out, size_t n, int timeout_ms) {
  const double end = mono_s() + timeout_ms / 1000.0;
  size_t got = 0;
  while (got < n) {
    const int left = static_cast<int>((end - mono_s()) * 1000);
    if (left <= 0) return false;
    pollfd p{fd, POLLIN, 0};
    const int r = ::poll(&p, 1, left);
    if (r <= 0) return false;
    if (p.revents & (POLLHUP | POLLERR)) return false;
    const ssize_t k = ::read(fd, out + got, n - got);
    if (k > 0) { got += static_cast<size_t>(k); continue; }
    if (k == 0) return false;
    if (errno == EAGAIN || errno == EINTR) continue;
    return false;
  }
  return true;
}

/**
 * Socket UDP « connectée » vers hôte:port (SNMP). La connexion UDP n'échange
 * rien sur le réseau : elle fixe le destinataire et, surtout, filtre les
 * datagrammes venus d'ailleurs — sans quoi n'importe quelle machine pourrait
 * injecter une réponse dans le flux d'un lien.
 */
inline int udp_connect(const std::string& host, int port, std::string& err) {
  if (host.empty()) { err = "hôte non renseigné"; return -1; }
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_DGRAM;
  addrinfo* res = nullptr;
  const std::string service = std::to_string(port);
  const int rc = ::getaddrinfo(host.c_str(), service.c_str(), &hints, &res);
  if (rc != 0 || !res) {
    err = "hôte introuvable (" + std::string(::gai_strerror(rc)) + ")";
    return -1;
  }
  int fd = -1;
  for (addrinfo* a = res; a; a = a->ai_next) {
    fd = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
    if (fd < 0) continue;
    if (::connect(fd, a->ai_addr, a->ai_addrlen) == 0) {
      ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
      ::freeaddrinfo(res);
      return fd;
    }
    err = std::strerror(errno);
    ::close(fd);
    fd = -1;
  }
  ::freeaddrinfo(res);
  if (err.empty()) err = "socket UDP impossible";
  return -1;
}

/** Attend un datagramme et le lit ; -1 si le délai expire. */
inline ssize_t recv_datagram(int fd, uint8_t* out, size_t max, int timeout_ms) {
  const double end = mono_s() + timeout_ms / 1000.0;
  for (;;) {
    const int left = static_cast<int>((end - mono_s()) * 1000);
    if (left <= 0) return -1;
    pollfd p{fd, POLLIN, 0};
    const int r = ::poll(&p, 1, left);
    if (r <= 0) return -1;
    const ssize_t k = ::recv(fd, out, max, 0);
    if (k >= 0) return k;
    if (errno == EAGAIN || errno == EINTR) continue;
    return -1;
  }
}

/** Vide ce qui traîne en réception (resynchronisation d'une liaison série). */
inline void drain(int fd) {
  uint8_t junk[256];
  for (;;) {
    pollfd p{fd, POLLIN, 0};
    if (::poll(&p, 1, 0) <= 0) return;
    if (::read(fd, junk, sizeof junk) <= 0) return;
  }
}

/** Ouvre une liaison série en mode brut (8 bits de données, RTU). */
inline int serial_open(const std::string& device, int baud, const std::string& parity,
                       int stop_bits, std::string& err) {
  const int fd = ::open(device.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (fd < 0) { err = device + " : " + std::strerror(errno); return -1; }

  termios tio{};
  if (::tcgetattr(fd, &tio) != 0) {
    err = "port série illisible : " + std::string(std::strerror(errno));
    ::close(fd);
    return -1;
  }
  ::cfmakeraw(&tio);
  speed_t sp = B19200;
  switch (baud) {
    case 1200: sp = B1200; break;
    case 2400: sp = B2400; break;
    case 4800: sp = B4800; break;
    case 9600: sp = B9600; break;
    case 19200: sp = B19200; break;
    case 38400: sp = B38400; break;
    case 57600: sp = B57600; break;
    case 115200: sp = B115200; break;
    default: err = "débit série non pris en charge"; ::close(fd); return -1;
  }
  ::cfsetispeed(&tio, sp);
  ::cfsetospeed(&tio, sp);
  tio.c_cflag |= (CLOCAL | CREAD);
  tio.c_cflag &= ~static_cast<tcflag_t>(CSIZE);
  tio.c_cflag |= CS8;                      // RTU : toujours 8 bits de données
  if (parity == "none") {
    tio.c_cflag &= ~static_cast<tcflag_t>(PARENB);
  } else {
    tio.c_cflag |= PARENB;
    if (parity == "odd") tio.c_cflag |= PARODD;
    else tio.c_cflag &= ~static_cast<tcflag_t>(PARODD);
  }
  // Règle de la spécification série : 2 bits d'arrêt en l'absence de parité.
  const bool two_stop = stop_bits == 2 || (stop_bits <= 0 && parity == "none");
  if (two_stop) tio.c_cflag |= CSTOPB; else tio.c_cflag &= ~static_cast<tcflag_t>(CSTOPB);
  tio.c_cc[VMIN] = 0;                      // temporisation assurée par poll()
  tio.c_cc[VTIME] = 0;
  if (::tcsetattr(fd, TCSANOW, &tio) != 0) {
    err = "réglage du port série impossible : " + std::string(std::strerror(errno));
    ::close(fd);
    return -1;
  }
  ::tcflush(fd, TCIOFLUSH);
  return fd;
}

}  // namespace net
}  // namespace diagweb
