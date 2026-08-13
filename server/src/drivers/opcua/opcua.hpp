// Diagweb — pilote OPC UA (IEC 62541), client en lecture seule.
//
// S'appuie sur open62541 (MPL-2.0), la seule dépendance externe du serveur :
// écrire une pile UA complète — UA-TCP, SecureConversation, encodage binaire,
// services de session, de lecture et d'abonnement — représentait plus de code
// que tout le reste du serveur réuni. La licence autorise explicitement la
// combinaison avec du logiciel propriétaire ; seules des modifications
// apportées à open62541 lui-même devraient être publiées.
//
// Compilé sans -DDIAGWEB_WITH_OPCUA, le pilote redevient « déclaré » : la
// configuration reste saisissable, aucune valeur n'est publiée, et le serveur
// se construit hors ligne sans aucune dépendance.
//
// Deux modes de lecture :
//   abonnement — le serveur OPC UA notifie les changements (économe, défaut) ;
//   interrogation cyclique — service Read répété, pour les serveurs qui
//   refusent les abonnements.
//
// L'horodatage à la source (SourceTimestamp) n'accompagne que les
// notifications d'abonnement : en interrogation cyclique, seule la valeur est
// demandée, et les échantillons portent donc l'horloge du serveur.
//
// LECTURE SEULE DÉFINITIVE : ni Write ni Call ne sont appelés, et le contrat
// CompositeSource refuse de toute façon toute écriture vers un point « @ ».
//
// AUCUN SECRET DANS LA CONFIGURATION : `protocols.json` est lisible par tout
// poste connecté et s'exporte en clair. Le mot de passe n'y figure jamais ; la
// configuration ne porte qu'une « référence de secret », qui nomme une
// variable d'environnement du serveur (DIAGWEB_SECRET_<référence>).
#pragma once

#include "../common/declared.hpp"

#if defined(DIAGWEB_HAS_OPCUA) && DIAGWEB_HAS_OPCUA

#include <open62541/client.h>
#include <open62541/client_config_default.h>
#include <open62541/client_highlevel.h>
#include <open62541/client_subscriptions.h>

#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

#include "../../protocol.hpp"
#include "../common/net.hpp"

namespace diagweb {

class OpcUaDriver : public IProtocolDriver {
 public:
  OpcUaDriver(const LinkConfig& link, IPointSink& sink) : link_(link), sink_(sink) {
    abonnement_ = link_.str("mode", "subscribe") != "poll";
    for (const auto& p : link_.points) {
      Point pt;
      pt.node = p.str("nodeId");
      pt.period_s = std::max(0.01, p.period_ms / 1000.0);
      pt.sampling_ms = p.num("samplingMs", 200);
      pt.deadband = p.num("deadband", 0);
      pt.gain = p.num("gain", 1);
      pt.offset = p.num("offset", 0);
      points_.push_back(pt);
    }
  }

  ~OpcUaDriver() override { close(); }

  bool open(std::string& err) override {
    close();
    const std::string mode_secu = link_.str("securityMode", "None");
    if (mode_secu != "None" && !encryption_compiled_in()) {
      // Ne jamais se rabattre en clair sur un lien réglé pour être signé ou
      // chiffré : le silence donnerait une fausse impression de sécurité.
      err = "mode de sécurité « " + mode_secu +
            " » demandé mais open62541 est compilé sans chiffrement "
            "(voir docs/PROTOCOLES.md § OPC UA)";
      return false;
    }

    const std::string url = link_.str("endpoint");
    if (url.rfind("opc.tcp://", 0) != 0) {
      err = "point de terminaison attendu sous la forme opc.tcp://hôte:port";
      return false;
    }

    client_ = UA_Client_new();
    if (!client_) { err = "allocation du client OPC UA impossible"; return false; }
    UA_ClientConfig* cfg = UA_Client_getConfig(client_);
    UA_ClientConfig_setDefault(cfg);
    cfg->timeout = 5000;
    const double duree = link_.num("sessionTimeoutS", 60);
    cfg->requestedSessionTimeout =
        static_cast<UA_UInt32>(std::clamp(duree, 5.0, 3600.0) * 1000);

    UA_StatusCode st;
    if (link_.str("auth", "anonymous") == "username") {
      std::string secret;
      if (!lire_secret(secret, err)) { close(); return false; }
      st = UA_Client_connectUsername(client_, url.c_str(),
                                     link_.str("username").c_str(), secret.c_str());
    } else {
      st = UA_Client_connect(client_, url.c_str());
    }
    if (st != UA_STATUSCODE_GOOD) {
      err = std::string("connexion refusée : ") + UA_StatusCode_name(st);
      close();
      return false;
    }

    if (!resoudre_noeuds(err)) { close(); return false; }
    if (abonnement_ && !creer_abonnement(err)) { close(); return false; }
    for (Point& p : points_) p.due = 0;
    return true;
  }

  void close() override {
    if (!client_) return;
    UA_Client_disconnect(client_);
    UA_Client_delete(client_);
    client_ = nullptr;
    for (Point& p : points_) {
      UA_NodeId_clear(&p.id);
      p.resolu = false;
    }
    contextes_.clear();
  }

  bool service(std::string& err) override {
    if (!client_) { err = "lien fermé"; return false; }

    // Fait avancer la pile : c'est ici que les notifications d'abonnement
    // arrivent, et que les publications sont réémises.
    const UA_StatusCode st = UA_Client_run_iterate(client_, abonnement_ ? 50 : 5);
    if (st != UA_STATUSCODE_GOOD) {
      err = std::string("session perdue : ") + UA_StatusCode_name(st);
      return false;
    }
    UA_SessionState sess = UA_SESSIONSTATE_CLOSED;
    UA_Client_getState(client_, nullptr, &sess, nullptr);
    if (sess != UA_SESSIONSTATE_ACTIVATED) {
      err = "session non activée par le serveur";
      return false;
    }
    if (abonnement_) return true;

    // Interrogation cyclique : chaque point à sa propre cadence.
    const double t = net::mono_s();
    bool travail = false;
    for (size_t i = 0; i < points_.size(); ++i) {
      Point& p = points_[i];
      if (!p.resolu || t < p.due) continue;
      p.due = t + p.period_s;
      travail = true;
      UA_Variant v;
      UA_Variant_init(&v);
      const UA_StatusCode r = UA_Client_readValueAttribute(client_, p.id, &v);
      if (r == UA_STATUSCODE_GOOD) {
        publier(i, &v);
      } else {
        sink_.warn(p.node + " : lecture refusée (" + UA_StatusCode_name(r) + ")");
      }
      UA_Variant_clear(&v);
    }
    if (!travail) net::sleep_ms(5);        // rien à faire : on ne brûle pas de CPU
    return true;
  }

 private:
  struct Point {
    std::string node;
    UA_NodeId id{};
    bool resolu = false;
    double period_s = 1, due = 0;
    double sampling_ms = 200, deadband = 0;
    double gain = 1, offset = 0;
  };

  /** Contexte passé à open62541 pour retrouver le point d'une notification. */
  struct Contexte {
    OpcUaDriver* self;
    size_t index;
  };

  static bool encryption_compiled_in() {
#ifdef UA_ENABLE_ENCRYPTION
    return true;
#else
    return false;
#endif
  }

  /**
   * Le secret ne vit pas dans la configuration : celle-ci ne porte qu'un nom,
   * et la valeur est lue dans l'environnement du serveur — que systemd sait
   * alimenter depuis son magasin de secrets sans l'écrire sur disque.
   */
  bool lire_secret(std::string& out, std::string& err) const {
    const std::string ref = link_.str("secretRef");
    if (ref.empty()) {
      err = "authentification par nom d'utilisateur : « référence du secret » non renseignée";
      return false;
    }
    std::string var = "DIAGWEB_SECRET_";
    for (char c : ref) {
      var += (std::isalnum(static_cast<unsigned char>(c)) ? static_cast<char>(std::toupper(
                 static_cast<unsigned char>(c))) : '_');
    }
    const char* v = std::getenv(var.c_str());
    if (!v) {
      err = "secret absent : la variable d'environnement " + var + " n'est pas définie";
      return false;
    }
    out = v;
    return true;
  }

  bool resoudre_noeuds(std::string& err) {
    for (Point& p : points_) {
      UA_NodeId id;
      UA_NodeId_init(&id);
      const UA_String s = UA_String_fromChars(p.node.c_str());
      const UA_StatusCode st = UA_NodeId_parse(&id, s);
      UA_String_clear(const_cast<UA_String*>(&s));
      if (st != UA_STATUSCODE_GOOD) {
        sink_.warn("NodeId illisible : « " + p.node + " » (attendu ns=2;s=… ou ns=2;i=…)");
        continue;                                 // les autres points restent lisibles
      }
      p.id = id;
      p.resolu = true;
    }
    if (std::none_of(points_.begin(), points_.end(), [](const Point& p) { return p.resolu; })) {
      err = "aucun NodeId exploitable dans la configuration de ce lien";
      return false;
    }
    return true;
  }

  bool creer_abonnement(std::string& err) {
    UA_CreateSubscriptionRequest req = UA_CreateSubscriptionRequest_default();
    req.requestedPublishingInterval = std::clamp(link_.num("publishMs", 500), 10.0, 60000.0);
    const UA_CreateSubscriptionResponse resp =
        UA_Client_Subscriptions_create(client_, req, nullptr, nullptr, nullptr);
    if (resp.responseHeader.serviceResult != UA_STATUSCODE_GOOD) {
      err = std::string("abonnement refusé par le serveur (") +
            UA_StatusCode_name(resp.responseHeader.serviceResult) +
            ") — essayer le mode « interrogation cyclique »";
      return false;
    }
    abo_id_ = resp.subscriptionId;

    // Les contextes doivent survivre à l'appel : open62541 les conserve.
    contextes_.reserve(points_.size());
    for (size_t i = 0; i < points_.size(); ++i) {
      if (!points_[i].resolu) continue;
      contextes_.push_back({this, i});
      UA_MonitoredItemCreateRequest item = UA_MonitoredItemCreateRequest_default(points_[i].id);
      item.requestedParameters.samplingInterval =
          std::clamp(points_[i].sampling_ms, 0.0, 60000.0);
      if (points_[i].deadband > 0) {
        UA_DataChangeFilter* filtre = UA_DataChangeFilter_new();
        filtre->trigger = UA_DATACHANGETRIGGER_STATUSVALUE;
        filtre->deadbandType = static_cast<UA_UInt32>(UA_DEADBANDTYPE_PERCENT);
        filtre->deadbandValue = points_[i].deadband;
        item.requestedParameters.filter.encoding = UA_EXTENSIONOBJECT_DECODED;
        item.requestedParameters.filter.content.decoded.type = &UA_TYPES[UA_TYPES_DATACHANGEFILTER];
        item.requestedParameters.filter.content.decoded.data = filtre;
      }
      const UA_MonitoredItemCreateResult r = UA_Client_MonitoredItems_createDataChange(
          client_, abo_id_, UA_TIMESTAMPSTORETURN_SOURCE, item,
          &contextes_.back(), &OpcUaDriver::on_change, nullptr);
      if (r.statusCode != UA_STATUSCODE_GOOD) {
        sink_.warn(points_[i].node + " : nœud non surveillé (" +
                   UA_StatusCode_name(r.statusCode) + ")");
      }
    }
    return true;
  }

  /** Notification de changement : appelée depuis UA_Client_run_iterate. */
  static void on_change(UA_Client*, UA_UInt32, void*, UA_UInt32, void* ctx, UA_DataValue* v) {
    auto* c = static_cast<Contexte*>(ctx);
    if (!c || !c->self || !v) return;
    if (!v->hasValue || (v->hasStatus && v->status != UA_STATUSCODE_GOOD)) {
      // Qualité mauvaise : aucun échantillon, comme le bit IV en IEC-104.
      return;
    }
    // SourceTimestamp : l'instant où la DONNÉE a été produite, à distinguer du
    // ServerTimestamp qui n'est que l'instant où le serveur OPC UA l'a vue.
    double t_src = 0;
    if (v->hasSourceTimestamp) {
      t_src = static_cast<double>(v->sourceTimestamp - UA_DATETIME_UNIX_EPOCH) /
              static_cast<double>(UA_DATETIME_SEC);
    }
    c->self->publier(c->index, &v->value, t_src);
  }

  void publier(size_t idx, const UA_Variant* v, double t_source = 0) {
    double val = 0;
    if (!vers_double(v, val)) {
      sink_.warn(points_[idx].node + " : type non numérique, valeur non publiée");
      return;
    }
    sink_.publish(idx, val * points_[idx].gain + points_[idx].offset, t_source);
  }

  /** Types intégrés numériques uniquement : rien n'est inventé pour le reste. */
  static bool vers_double(const UA_Variant* v, double& out) {
    if (!v || !v->data || !v->type || !UA_Variant_isScalar(v)) return false;
    const UA_UInt32 k = v->type->typeKind;
    switch (k) {
      case UA_DATATYPEKIND_BOOLEAN: out = *static_cast<UA_Boolean*>(v->data) ? 1 : 0; return true;
      case UA_DATATYPEKIND_SBYTE:   out = *static_cast<UA_SByte*>(v->data); return true;
      case UA_DATATYPEKIND_BYTE:    out = *static_cast<UA_Byte*>(v->data); return true;
      case UA_DATATYPEKIND_INT16:   out = *static_cast<UA_Int16*>(v->data); return true;
      case UA_DATATYPEKIND_UINT16:  out = *static_cast<UA_UInt16*>(v->data); return true;
      case UA_DATATYPEKIND_INT32:   out = *static_cast<UA_Int32*>(v->data); return true;
      case UA_DATATYPEKIND_UINT32:  out = *static_cast<UA_UInt32*>(v->data); return true;
      case UA_DATATYPEKIND_INT64:
        out = static_cast<double>(*static_cast<UA_Int64*>(v->data)); return true;
      case UA_DATATYPEKIND_UINT64:
        out = static_cast<double>(*static_cast<UA_UInt64*>(v->data)); return true;
      case UA_DATATYPEKIND_FLOAT:   out = *static_cast<UA_Float*>(v->data); return true;
      case UA_DATATYPEKIND_DOUBLE:  out = *static_cast<UA_Double*>(v->data); return true;
      default: return false;
    }
  }

  LinkConfig link_;
  IPointSink& sink_;
  UA_Client* client_ = nullptr;
  UA_UInt32 abo_id_ = 0;
  bool abonnement_ = true;
  std::vector<Point> points_;
  std::vector<Contexte> contextes_;
};

inline DriverPtr make_opcua_driver(const LinkConfig& link, IPointSink& sink) {
  return std::make_unique<OpcUaDriver>(link, sink);
}

}  // namespace diagweb

#else   // ------------------------------------------------ sans open62541

namespace diagweb {

/** Compilé sans -DDIAGWEB_WITH_OPCUA : le pilote reste déclaré. */
inline DriverPtr make_opcua_driver(const LinkConfig&, IPointSink&) {
  return std::make_unique<DeclaredDriver>(
      "serveur compilé sans le pilote OPC UA (option DIAGWEB_WITH_OPCUA) — "
      "configuration conservée");
}

}  // namespace diagweb

#endif
