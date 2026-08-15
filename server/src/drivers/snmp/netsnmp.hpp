// Diagweb — pilote SNMP appuyé sur Net-SNMP : v1, v2c et v3 (USM).
//
// Pourquoi une bibliothèque ici, alors que v1 et v2c tiennent en 500 lignes
// écrites à la main : c'est **v3** qui change la donne. Son modèle de sécurité
// USM demande la découverte du moteur distant, une fenêtre temporelle,
// la dérivation puis la localisation des clés depuis des phrases secrètes,
// HMAC-MD5/SHA-1/SHA-256, et DES-CBC ou AES-128-CFB. Écrire soi-même du code
// cryptographique qu'on ne peut pas éprouver contre l'existant est exactement
// ce qu'il ne faut pas faire. Net-SNMP est sous licences BSD (CMU/UCD et
// consorts, aucune clause GPL — fichier COPYING vérifié).
//
// L'implémentation interne (snmp.hpp) reste le repli quand la bibliothèque
// n'est pas là : v1 et v2c continuent de fonctionner sans aucune dépendance,
// et v3 s'annonce « non branché ».
//
// AUCUN SECRET DANS LA CONFIGURATION. Les phrases secrètes d'authentification
// et de chiffrement ne figurent jamais dans protocols.json — lisible par tout
// poste connecté, et exporté en clair. La configuration ne porte qu'une
// référence, résolue dans l'environnement du serveur :
//   DIAGWEB_SECRET_<RÉF>_AUTH   phrase d'authentification
//   DIAGWEB_SECRET_<RÉF>_PRIV   phrase de chiffrement
//   DIAGWEB_SECRET_<RÉF>        repli servant aux deux
//
// HORODATAGE. SNMP ne transporte aucune date : ni GetRequest ni GetResponse
// n'en portent. En revanche une MIB peut en exposer une, et beaucoup le font.
// Un point peut donc désigner un OID D'HORODATAGE compagnon, lu dans la même
// requête — c'est la MIB qui fournit la date, pas le protocole, et la nuance
// mérite d'être dite.
#pragma once

#if defined(DIAGWEB_HAS_NETSNMP) && DIAGWEB_HAS_NETSNMP

#include <net-snmp/net-snmp-config.h>
#include <net-snmp/net-snmp-includes.h>

#include <algorithm>
#include <cstring>
#include <ctime>
#include <mutex>
#include <string>
#include <vector>

#include "../../protocol.hpp"
#include "../common/net.hpp"
#include "dateandtime.hpp"

namespace diagweb {

class NetSnmpDriver : public IProtocolDriver {
 public:
  NetSnmpDriver(const LinkConfig& link, IPointSink& sink) : link_(link), sink_(sink) {
    static std::once_flag une_fois;
    std::call_once(une_fois, [] { init_snmp("diagweb"); });

    version_ = link_.str("version", "v2c");
    for (const auto& p : link_.points) {
      Point pt;
      pt.id_texte = p.str("oid");
      pt.ts_texte = p.str("tsOid");
      pt.ts_type = p.str("tsType", "dateAndTime");
      pt.period_s = std::max(0.05, p.period_ms / 1000.0);
      pt.gain = p.num("gain", 1);
      pt.offset = p.num("offset", 0);
      pt.valide = parse_oid(pt.id_texte, pt.name, pt.name_len);
      pt.ts_valide = !pt.ts_texte.empty() &&
                     parse_oid(pt.ts_texte, pt.ts_name, pt.ts_name_len);
      points_.push_back(pt);
    }
  }

  ~NetSnmpDriver() override { close(); }

  bool open(std::string& err) override {
    close();
    netsnmp_session modele;
    snmp_sess_init(&modele);

    const std::string cible = link_.str("host") + ":" +
                              std::to_string(static_cast<int>(link_.num("port", 161)));
    peer_ = cible;
    modele.peername = const_cast<char*>(peer_.c_str());
    modele.timeout = static_cast<long>(
        std::clamp<double>(link_.num("timeoutMs", 1500), 100, 30000)) * 1000;   // µs
    modele.retries = 1;

    if (version_ == "v3") {
      if (!configurer_v3(modele, err)) return false;
    } else {
      modele.version = (version_ == "v1") ? SNMP_VERSION_1 : SNMP_VERSION_2c;
      communaute_ = link_.str("community");
      if (communaute_.empty()) { err = "communauté non renseignée"; return false; }
      modele.community = reinterpret_cast<u_char*>(const_cast<char*>(communaute_.c_str()));
      modele.community_len = communaute_.size();
    }

    // snmp_open recopie la session : le modèle local peut disparaître ensuite.
    session_ = snmp_open(&modele);
    if (!session_) {
      char* msg = nullptr;
      int lib = 0, sys = 0;
      snmp_error(&modele, &lib, &sys, &msg);
      err = std::string("ouverture SNMP impossible : ") + (msg ? msg : "raison inconnue");
      if (msg) free(msg);
      return false;
    }
    if (std::none_of(points_.begin(), points_.end(), [](const Point& p) { return p.valide; })) {
      err = "aucun OID exploitable dans la configuration de ce lien";
      close();
      return false;
    }
    for (Point& p : points_) p.due = 0;
    return true;
  }

  void close() override {
    if (session_) { snmp_close(session_); session_ = nullptr; }
  }

  bool service(std::string& err) override {
    if (!session_) { err = "lien fermé"; return false; }
    const double t = net::mono_s();

    std::vector<size_t> lot;
    const size_t max_vars = static_cast<size_t>(
        std::clamp<double>(link_.num("maxVars", 16), 1, 32));
    for (size_t i = 0; i < points_.size() && lot.size() < max_vars; ++i) {
      if (!points_[i].valide || t < points_[i].due) continue;
      points_[i].due = next_poll_due(t, sink_.now(), points_[i].period_s);
      lot.push_back(i);
    }
    if (lot.empty()) { net::sleep_ms(5); return true; }
    return interroger(lot, err);
  }

 private:
  /** Rôle d'une variable liée dans la requête groupée. */
  enum class Rang { Valeur, Date, Uptime };

  struct Point {
    // « oid » est un type de Net-SNMP : nommer un champ ainsi le masquerait
    // dans toute la structure, et les tableaux d'OID ne compileraient plus.
    std::string id_texte, ts_texte, ts_type;
    oid name[MAX_OID_LEN]{};
    size_t name_len = 0;
    oid ts_name[MAX_OID_LEN]{};
    size_t ts_name_len = 0;
    bool valide = false, ts_valide = false;
    double period_s = 1, due = 0;
    double gain = 1, offset = 0;
  };

  /**
   * OID en notation pointée → tableau numérique. Analysé ici plutôt que par
   * `read_objid` : cela évite de charger les MIB, qu'il faudrait alors
   * embarquer sur le contrôleur, et un OID purement numérique n'en a pas
   * besoin.
   */
  static bool parse_oid(const std::string& s, oid* out, size_t& len) {
    len = 0;
    uint64_t cur = 0;
    bool chiffre = false;
    for (size_t i = 0; i <= s.size(); ++i) {
      const char c = (i < s.size()) ? s[i] : '.';
      if (c >= '0' && c <= '9') {
        cur = cur * 10 + static_cast<uint64_t>(c - '0');
        if (cur > 0xFFFFFFFFull) return false;
        chiffre = true;
      } else if (c == '.') {
        if (!chiffre) {                       // « .1.3.6… » : point de tête toléré
          if (i == 0) continue;
          return false;
        }
        if (len >= MAX_OID_LEN) return false;
        out[len++] = static_cast<oid>(cur);
        cur = 0;
        chiffre = false;
      } else if (c != ' ') {
        return false;
      }
    }
    return len >= 2;
  }

  /** Paramètres USM : niveau, algorithmes, clés dérivées des phrases secrètes. */
  bool configurer_v3(netsnmp_session& s, std::string& err) {
    s.version = SNMP_VERSION_3;
    utilisateur_ = link_.str("user");
    if (utilisateur_.empty()) { err = "SNMPv3 : nom d'utilisateur non renseigné"; return false; }
    s.securityName = const_cast<char*>(utilisateur_.c_str());
    s.securityNameLen = utilisateur_.size();

    const std::string niveau = link_.str("level", "authPriv");
    if (niveau == "noAuthNoPriv") {
      s.securityLevel = SNMP_SEC_LEVEL_NOAUTH;
      return true;
    }
    s.securityLevel = (niveau == "authNoPriv") ? SNMP_SEC_LEVEL_AUTHNOPRIV
                                               : SNMP_SEC_LEVEL_AUTHPRIV;

    const std::string algo = link_.str("authProto", "SHA");
    if (algo == "MD5") {
      s.securityAuthProto = usmHMACMD5AuthProtocol;
      s.securityAuthProtoLen = USM_AUTH_PROTO_MD5_LEN;
    } else if (algo == "SHA256") {
#ifdef usmHMAC192SHA256AuthProtocol
      s.securityAuthProto = usmHMAC192SHA256AuthProtocol;
      s.securityAuthProtoLen = USM_AUTH_PROTO_SHA256_LEN;
#else
      err = "SHA-256 non pris en charge par cette version de Net-SNMP";
      return false;
#endif
    } else {
      s.securityAuthProto = usmHMACSHA1AuthProtocol;
      s.securityAuthProtoLen = USM_AUTH_PROTO_SHA_LEN;
    }

    std::string phrase;
    if (!lire_secret("AUTH", phrase, err)) return false;
    s.securityAuthKeyLen = USM_AUTH_KU_LEN;
    if (generate_Ku(s.securityAuthProto, s.securityAuthProtoLen,
                    reinterpret_cast<const u_char*>(phrase.c_str()), phrase.size(),
                    s.securityAuthKey, &s.securityAuthKeyLen) != SNMPERR_SUCCESS) {
      err = "dérivation de la clé d'authentification impossible";
      return false;
    }
    if (s.securityLevel != SNMP_SEC_LEVEL_AUTHPRIV) return true;

    if (link_.str("privProto", "AES") == "DES") {
      s.securityPrivProto = usmDESPrivProtocol;
      s.securityPrivProtoLen = USM_PRIV_PROTO_DES_LEN;
    } else {
      s.securityPrivProto = usmAESPrivProtocol;
      s.securityPrivProtoLen = USM_PRIV_PROTO_AES_LEN;
    }
    std::string phrase_priv;
    if (!lire_secret("PRIV", phrase_priv, err)) return false;
    s.securityPrivKeyLen = USM_PRIV_KU_LEN;
    // La clé de chiffrement se dérive avec la fonction de hachage de
    // l'authentification : c'est la règle de la RFC 3414, pas un raccourci.
    if (generate_Ku(s.securityAuthProto, s.securityAuthProtoLen,
                    reinterpret_cast<const u_char*>(phrase_priv.c_str()), phrase_priv.size(),
                    s.securityPrivKey, &s.securityPrivKeyLen) != SNMPERR_SUCCESS) {
      err = "dérivation de la clé de chiffrement impossible";
      return false;
    }
    return true;
  }

  /** Phrase secrète, lue dans l'environnement du serveur — jamais du fichier. */
  bool lire_secret(const char* usage, std::string& out, std::string& err) const {
    const std::string ref = link_.str("secretRef");
    if (ref.empty()) {
      err = "SNMPv3 : « référence des secrets » non renseignée";
      return false;
    }
    std::string base = "DIAGWEB_SECRET_";
    for (char c : ref) {
      base += std::isalnum(static_cast<unsigned char>(c))
                  ? static_cast<char>(std::toupper(static_cast<unsigned char>(c))) : '_';
    }
    const char* v = std::getenv((base + "_" + usage).c_str());
    if (!v) v = std::getenv(base.c_str());          // repli commun aux deux usages
    if (!v) {
      err = std::string("secret absent : ni ") + base + "_" + usage + " ni " + base +
            " ne sont définis dans l'environnement du serveur";
      return false;
    }
    out = v;
    return true;
  }

  /** Une transaction : GetRequest groupé, puis décodage des variables liées. */
  bool interroger(const std::vector<size_t>& lot, std::string& err) {
    netsnmp_pdu* pdu = snmp_pdu_create(SNMP_MSG_GET);
    if (!pdu) { err = "allocation du PDU impossible"; return false; }

    // Un horodatage en TimeTicks ne vaut que rapporté au sysUpTime du même
    // échange : on le demande alors EN TÊTE, pour l'avoir décodé avant les
    // dates qui s'en servent.
    std::vector<std::pair<size_t, Rang>> ordre;
    const bool besoin_uptime = std::any_of(
        lot.begin(), lot.end(), [this](size_t i) {
          return points_[i].ts_valide && points_[i].ts_type == "timeTicks";
        });
    if (besoin_uptime) {
      static const oid sys_up_time[] = {1, 3, 6, 1, 2, 1, 1, 3, 0};
      snmp_add_null_var(pdu, sys_up_time, sizeof sys_up_time / sizeof(oid));
      ordre.push_back({0, Rang::Uptime});
    }

    // Chaque point ajoute son OID, et son OID d'horodatage juste après : la
    // date et la valeur viennent ainsi du MÊME échange, donc du même instant.
    for (size_t i : lot) {
      snmp_add_null_var(pdu, points_[i].name, points_[i].name_len);
      ordre.push_back({i, Rang::Valeur});
      if (points_[i].ts_valide) {
        snmp_add_null_var(pdu, points_[i].ts_name, points_[i].ts_name_len);
        ordre.push_back({i, Rang::Date});
      }
    }

    netsnmp_pdu* reponse = nullptr;
    const int etat = snmp_synch_response(session_, pdu, &reponse);
    if (etat == STAT_TIMEOUT) {
      if (++manques_ >= 3) { err = "agent muet (délai dépassé)"; return false; }
      if (reponse) snmp_free_pdu(reponse);
      return true;                                   // UDP perd : on tolère
    }
    if (etat != STAT_SUCCESS || !reponse) {
      err = "échange SNMP en échec (session perdue)";
      if (reponse) snmp_free_pdu(reponse);
      return false;
    }
    manques_ = 0;

    if (reponse->errstat != SNMP_ERR_NOERROR) {
      sink_.warn(std::string("erreur SNMP : ") + snmp_errstring(
                     static_cast<int>(reponse->errstat)) +
                 " (variable " + std::to_string(reponse->errindex) + ")");
      snmp_free_pdu(reponse);
      return true;
    }

    // Les variables reviennent dans l'ordre demandé : on les apparie par rang,
    // en gardant la date d'un point pour la publier avec sa valeur.
    std::vector<double> valeurs(points_.size(), 0);
    std::vector<bool> a_valeur(points_.size(), false);
    std::vector<double> dates(points_.size(), 0);

    double uptime_ticks = 0;                         // sysUpTime du même échange
    size_t rang = 0;
    for (netsnmp_variable_list* v = reponse->variables; v && rang < ordre.size();
         v = v->next_variable, ++rang) {
      const size_t idx = ordre[rang].first;
      if (ordre[rang].second == Rang::Uptime) {
        double ticks = 0;
        if (valeur(v, ticks)) uptime_ticks = ticks;
        continue;
      }
      if (ordre[rang].second == Rang::Date) {
        dates[idx] = horodatage(v, points_[idx], uptime_ticks);
        continue;
      }
      double val = 0;
      if (!valeur(v, val)) {
        sink_.warn("OID " + points_[idx].id_texte + " : " + motif(v));
        continue;
      }
      valeurs[idx] = val;
      a_valeur[idx] = true;
    }
    for (size_t i : lot) {
      if (a_valeur[i]) {
        sink_.publish(i, valeurs[i] * points_[i].gain + points_[i].offset, dates[i]);
      }
    }
    snmp_free_pdu(reponse);
    return true;
  }

  /** Types applicatifs SNMP → grandeur. false = pas de valeur exploitable. */
  static bool valeur(const netsnmp_variable_list* v, double& out) {
    switch (v->type) {
      case ASN_INTEGER:
        out = static_cast<double>(*v->val.integer);
        return true;
      case ASN_COUNTER:
      case ASN_GAUGE:
      case ASN_TIMETICKS:
      case ASN_UINTEGER:
        out = static_cast<double>(*reinterpret_cast<unsigned long*>(v->val.integer));
        return true;
      case ASN_COUNTER64: {
        const struct counter64* c = v->val.counter64;
        out = static_cast<double>(c->high) * 4294967296.0 + static_cast<double>(c->low);
        return true;
      }
      case ASN_OCTET_STR: {
        // Certains agents publient une mesure en texte ; on l'accepte si elle
        // est entièrement numérique, jamais autrement.
        std::string s(reinterpret_cast<const char*>(v->val.string), v->val_len);
        size_t pos = 0;
        double parsed = 0;
        try { parsed = std::stod(s, &pos); } catch (...) { return false; }
        while (pos < s.size() && (s[pos] == ' ' || s[pos] == '\r' || s[pos] == '\n')) ++pos;
        if (pos != s.size()) return false;
        out = parsed;
        return true;
      }
      default:
        return false;
    }
  }

  /** OID d'horodatage compagnon → secondes UTC ; 0 si inexploitable. */
  static double horodatage(const netsnmp_variable_list* v, const Point& p,
                           double uptime_ticks) {
    if (p.ts_type == "timeTicks") {
      // Relatif au démarrage de l'agent : seul l'écart avec le sysUpTime du
      // même échange le ramène en absolu. Sans ce repère, aucune date — mieux
      // vaut l'horloge du serveur qu'un instant inventé.
      double ticks = 0;
      if (v->type != ASN_TIMETICKS && v->type != ASN_INTEGER) return 0;
      if (!valeur(v, ticks)) return 0;
      return time_ticks_utc(ticks, uptime_ticks, utc_now());
    }
    if (v->type != ASN_OCTET_STR) return 0;
    return date_and_time_utc(v->val.string, v->val_len);
  }

  static const char* motif(const netsnmp_variable_list* v) {
    switch (v->type) {
      case SNMP_NOSUCHOBJECT:   return "OID inconnu de l'agent (noSuchObject)";
      case SNMP_NOSUCHINSTANCE: return "instance absente — un scalaire s'écrit avec « .0 »";
      case SNMP_ENDOFMIBVIEW:   return "fin de la vue MIB";
      case ASN_NULL:            return "valeur vide";
      default:                  return "type non numérique, valeur non publiée";
    }
  }

  LinkConfig link_;
  IPointSink& sink_;
  netsnmp_session* session_ = nullptr;
  std::string version_, peer_, communaute_, utilisateur_;
  std::vector<Point> points_;
  int manques_ = 0;
};

}  // namespace diagweb

#endif  // DIAGWEB_HAS_NETSNMP
