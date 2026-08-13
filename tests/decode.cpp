// Diagweb — tests unitaires du décodage des protocoles réseau.
//
// Vérifie ce qui ne peut pas l'être par le test bout en bout (tests/protocols.mjs) :
// extraction de champs de bits CAN, décomposition d'un identifiant J1939,
// filtres noyau et appariement des trois pilotes CAN, codec BER/ASN.1 partagé
// par SNMP et IEC 61850, décodage des trames GOOSE et Sampled Values, grammaire
// des adresses « @lien.point », lecture de la configuration JSON.
//
//   g++ -std=c++20 -I server/src -o /tmp/decode tests/decode.cpp && /tmp/decode
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "drivers/can/can_raw.hpp"
#include "drivers/canopen/canopen.hpp"
#include "drivers/j1939/j1939.hpp"
#include "drivers/common/ber.hpp"
#include "drivers/iec61850/goose.hpp"
#include "drivers/iec104/iec104.hpp"
#include "drivers/iec61850/sv.hpp"
#include "drivers/iec61850/time61850.hpp"
#include "protocol.hpp"

using namespace diagweb;

namespace {
int failed = 0;
int total = 0;

void check(const char* name, bool ok, const std::string& detail = {}) {
  ++total;
  if (!ok) ++failed;
  std::printf("  %s %s%s%s\n", ok ? "✓" : "✗", name,
              detail.empty() ? "" : " — ", detail.c_str());
}
void near(const char* name, double got, double want) {
  char buf[96];
  // %.9g : sans cela, deux horodatages Unix distincts s'affichent identiques.
  std::snprintf(buf, sizeof buf, "obtenu %.9g, attendu %.9g", got, want);
  check(name, std::fabs(got - want) < 1e-6, buf);
}
}  // namespace

int main() {
  std::printf("Décodage des protocoles réseau\n\n");

  // ---- champs de bits, convention Intel (petit-boutiste) ----------------
  {
    // 0x34 0x12 : le mot 16 bits à partir du bit 0 vaut 0x1234
    const uint8_t d[8] = {0x34, 0x12, 0, 0, 0, 0, 0, 0};
    near("Intel : mot 16 bits", static_cast<double>(bits_intel(d, 8, 0, 16)), 0x1234);
    near("Intel : quartet décalé", static_cast<double>(bits_intel(d, 8, 4, 4)), 0x3);
    near("Intel : bit isolé", static_cast<double>(bits_intel(d, 8, 2, 1)), 1);
    near("Intel : au-delà de la trame", static_cast<double>(bits_intel(d, 2, 16, 8)), 0);
  }

  // ---- champs de bits, convention Motorola (gros-boutiste) --------------
  {
    // 0x12 0x34 : à partir du bit de poids fort de l'octet 0, 16 bits = 0x1234
    const uint8_t d[8] = {0x12, 0x34, 0, 0, 0, 0, 0, 0};
    near("Motorola : mot 16 bits", static_cast<double>(bits_motorola(d, 8, 7, 16)), 0x1234);
    near("Motorola : quartet de tête", static_cast<double>(bits_motorola(d, 8, 7, 4)), 0x1);
    // Cas classique J1939 : régime moteur (SPN 190), octets 3-4 en Intel,
    // facteur 0,125 tr/min — 0x1F40 = 8000 pas → 1000 tr/min.
    const uint8_t eec1[8] = {0xFF, 0xFF, 0xFF, 0x40, 0x1F, 0xFF, 0xFF, 0xFF};
    near("J1939 : régime moteur (SPN 190)",
         extract_signal(eec1, 8, 24, 16, false, false, 0.125, 0), 1000.0);
  }

  // ---- valeurs signées --------------------------------------------------
  {
    const uint8_t d[2] = {0xFF, 0xFF};
    near("complément à deux sur 16 bits",
         extract_signal(d, 2, 0, 16, false, true, 1, 0), -1);
    const uint8_t e[1] = {0x0F};
    near("complément à deux sur 4 bits (négatif)",
         extract_signal(e, 1, 0, 4, false, true, 1, 0), -1);
    near("gain et décalage", extract_signal(e, 1, 0, 4, false, false, 2, 5), 35);
  }

  // ---- identifiants J1939 ----------------------------------------------
  {
    // 0x0CF00400 : priorité 3, PF = 0xF0 (PDU2) → PGN 61444, source 0x00
    check("J1939 PDU2 : PGN 61444", j1939_pgn(0x0CF00400u) == 61444,
          std::to_string(j1939_pgn(0x0CF00400u)));
    check("J1939 : adresse source", j1939_sa(0x0CF00421u) == 0x21,
          std::to_string(j1939_sa(0x0CF00421u)));
    // 0x18EF2A0B : PF = 0xEF (PDU1) → l'octet PS est une destination, PGN 61184
    check("J1939 PDU1 : l'octet PS est exclu du PGN", j1939_pgn(0x18EF2A0Bu) == 61184,
          std::to_string(j1939_pgn(0x18EF2A0Bu)));
    // Page de données 1 : 0x1DF00400 → PGN 126468 (0x1EF04)
    check("J1939 : page de données prise en compte",
          j1939_pgn(0x1DF00400u) == ((1u << 16) | (0xF0u << 8) | 0x04u),
          std::to_string(j1939_pgn(0x1DF00400u)));
  }

  // ---- filtres noyau et appariement des pilotes CAN --------------------
  // Ces deux mécanismes ne sont pas couverts par le test bout en bout (il
  // faudrait une interface vcan) et un filtre trop large ou trop étroit se
  // traduirait par une variable silencieusement muette.
  {
    auto pt = [](const std::string& id, std::initializer_list<std::pair<const char*, JValue>> kv) {
      PointConfig p;
      p.id = id;
      p.params = JValue::object();
      for (const auto& [k, v] : kv) p.params.set(k, v);
      return p;
    };
    auto lien = [](const char* proto, std::initializer_list<std::pair<const char*, JValue>> kv,
                   std::vector<PointConfig> pts) {
      LinkConfig l;
      l.id = "essai";
      l.protocol = proto;
      l.params = JValue::object();
      for (const auto& [k, v] : kv) l.params.set(k, v);
      l.points = std::move(pts);
      return l;
    };

    struct Capteur : IPointSink {
      std::vector<std::pair<size_t, double>> vus;
      void publish(size_t i, double v, double) override { vus.push_back({i, v}); }
      double now() const override { return 0; }
    } sink;

    // `filters()` et `on_frame()` sont protégés : on les expose pour le test.
    struct Brut : CanRawDriver {
      using CanRawDriver::CanRawDriver;
      using CanRawDriver::filters;
    };
    struct J1939 : J1939Driver {
      using J1939Driver::J1939Driver;
      using J1939Driver::filters;
      using J1939Driver::on_frame;
      using J1939Driver::requests;
    };
    struct Open : CanOpenDriver {
      using CanOpenDriver::CanOpenDriver;
      using CanOpenDriver::filters;
    };

    {
      Brut d(lien("can-raw", {}, {pt("std", {{"canId", JValue::string("0x181")}}),
                                  pt("ext", {{"canId", JValue::string("0x18FEF100")},
                                             {"ext", JValue::boolean(true)}})}), sink);
      const auto f = d.filters();
      check("CAN brut : filtre 11 bits",
            f.size() == 2 && f[0].id == 0x181 && f[0].mask == 0x7FF && !f[0].ext);
      check("CAN brut : filtre 29 bits",
            f.size() == 2 && f[1].id == 0x18FEF100 && f[1].mask == 0x1FFFFFFF && f[1].ext);
    }

    {
      // PDU2 (PGN 61444) : l'octet PS appartient au PGN, il entre dans le
      // masque. PDU1 (PGN 61184) : c'est une destination, il en sort.
      J1939 d(lien("j1939", {}, {pt("pdu2", {{"pgn", JValue::number(61444)}}),
                                 pt("pdu1", {{"pgn", JValue::number(61184)}})}), sink);
      // Deux filtres de points, suivis des deux filtres de transport (le mode
      // « écoute des BAM » étant celui par défaut).
      const auto f = d.filters();
      check("J1939 : masque PDU2 inclut l'octet PS",
            f.size() == 4 && f[0].id == (61444u << 8) && f[0].mask == 0x03FFFF00u && f[0].ext,
            std::to_string(f.size()) + " filtre(s)");
      check("J1939 : masque PDU1 exclut l'octet PS",
            f.size() == 4 && f[1].mask == 0x03FF0000u && f[1].ext);
    }

    {
      // Un point sans contrainte d'adresse source, un autre lié à 0x21.
      J1939 d(lien("j1939", {}, {pt("tous", {{"pgn", JValue::number(61444)},
                                             {"startBit", JValue::number(24)},
                                             {"bitLen", JValue::number(16)},
                                             {"gain", JValue::number(0.125)}}),
                                 pt("sa21", {{"pgn", JValue::number(61444)},
                                             {"sa", JValue::number(0x21)},
                                             {"startBit", JValue::number(24)},
                                             {"bitLen", JValue::number(16)},
                                             {"gain", JValue::number(0.125)}})}), sink);
      const uint8_t eec1[8] = {0xFF, 0xFF, 0xFF, 0x40, 0x1F, 0xFF, 0xFF, 0xFF};
      d.on_frame(0x0CF00421u, true, eec1, 8);
      check("J1939 : trame de la bonne source publiée sur les deux points",
            sink.vus.size() == 2, std::to_string(sink.vus.size()) + " publication(s)");
      near("J1939 : régime décodé par le pilote",
           sink.vus.empty() ? 0 : sink.vus[0].second, 1000.0);
      sink.vus.clear();
      d.on_frame(0x0CF00400u, true, eec1, 8);
      check("J1939 : source non concordante écartée pour le point filtré",
            sink.vus.size() == 1 && sink.vus[0].first == 0,
            std::to_string(sink.vus.size()) + " publication(s)");
      sink.vus.clear();
      d.on_frame(0x181u, false, eec1, 8);
      check("J1939 : trame 11 bits ignorée", sink.vus.empty());
    }

    {
      // Protocole de transport J1939 : un PGN de 12 octets arrive en deux
      // paquets après une annonce BAM. Le SPN visé est au-delà du 8ᵉ octet —
      // c'est précisément ce que le mono-trame ne pouvait pas atteindre.
      J1939 d(lien("j1939", {},
                   {pt("long", {{"pgn", JValue::number(65226)},   // DM1
                                {"startBit", JValue::number(72)}, // octet 9
                                {"bitLen", JValue::number(16)}})}), sink);
      // TP.CM_BAM : 12 octets en 2 paquets, PGN 65226 (0x00FECA).
      const uint8_t cm[8] = {0x20, 12, 0, 2, 0xFF, 0xCA, 0xFE, 0x00};
      d.on_frame(0x1CECFF21u, true, cm, 8);
      check("J1939 TP : aucun point publié avant réassemblage complet", sink.vus.empty());

      const uint8_t dt1[8] = {1, 0, 1, 2, 3, 4, 5, 6};
      const uint8_t dt2[8] = {2, 7, 8, 0x34, 0x12, 0xFF, 0xFF, 0xFF};
      d.on_frame(0x1CEBFF21u, true, dt1, 8);
      check("J1939 TP : toujours rien après le premier paquet", sink.vus.empty());
      d.on_frame(0x1CEBFF21u, true, dt2, 8);
      check("J1939 TP : message multi-trames réassemblé et publié",
            sink.vus.size() == 1, std::to_string(sink.vus.size()) + " publication(s)");
      // Octets 9 et 10 du message = 0x34 0x12, en Intel → 0x1234.
      near("J1939 TP : champ au-delà du 8ᵉ octet",
           sink.vus.empty() ? 0 : sink.vus[0].second, 0x1234);
      sink.vus.clear();
    }

    {
      // Une annonce dont le compte de paquets ne correspond pas à la taille
      // est rejetée avant toute allocation : le contenu vient du bus.
      J1939 d(lien("j1939", {}, {pt("long", {{"pgn", JValue::number(65226)},
                                             {"startBit", JValue::number(0)},
                                             {"bitLen", JValue::number(8)}})}), sink);
      const uint8_t faux[8] = {0x20, 12, 0, 9, 0xFF, 0xCA, 0xFE, 0x00};   // 12 o ≠ 9 paquets
      d.on_frame(0x1CECFF21u, true, faux, 8);
      const uint8_t dt[8] = {1, 1, 2, 3, 4, 5, 6, 7};
      d.on_frame(0x1CEBFF21u, true, dt, 8);
      check("J1939 TP : annonce incohérente rejetée", sink.vus.empty());

      // Taille hors bornes de la norme (9 à 1785 octets).
      const uint8_t trop[8] = {0x20, 0xFF, 0xFF, 0xFF, 0xFF, 0xCA, 0xFE, 0x00};
      d.on_frame(0x1CECFF21u, true, trop, 8);
      d.on_frame(0x1CEBFF21u, true, dt, 8);
      check("J1939 TP : taille hors bornes rejetée", sink.vus.empty());

      // Un paquet sans annonce préalable ne doit rien produire.
      const uint8_t orphelin[8] = {3, 1, 2, 3, 4, 5, 6, 7};
      d.on_frame(0x1CEBFF21u, true, orphelin, 8);
      check("J1939 TP : paquet orphelin ignoré", sink.vus.empty());
      sink.vus.clear();
    }

    {
      // Les filtres de transport sont toujours posés : TP.CM et TP.DT, tous
      // deux en PDU1 (l'octet de destination ne doit pas entrer dans le masque).
      J1939 d(lien("j1939", {}, {pt("long", {{"pgn", JValue::number(65226)}})}), sink);
      const auto f = d.filters();
      check("J1939 TP : filtres TP.CM et TP.DT toujours posés",
            f.size() == 3 && f[1].id == (60416u << 8) && f[2].id == (60160u << 8) &&
            f[1].mask == 0x03FF0000u && f[2].mask == 0x03FF0000u,
            std::to_string(f.size()) + " filtre(s)");
    }

    {
      // Demandes : un PGN diffusé spontanément n'en déclenche aucune ; un PGN
      // à réclamer en produit une seule, même partagée par plusieurs SPN, et
      // à la plus courte des périodes demandées.
      J1939 d(lien("j1939", {}, {
        pt("spontane", {{"pgn", JValue::number(61444)}}),
        pt("spn_a", {{"pgn", JValue::number(65262)}, {"request", JValue::boolean(true)},
                     {"requestPeriodS", JValue::number(5)}}),
        pt("spn_b", {{"pgn", JValue::number(65262)}, {"request", JValue::boolean(true)},
                     {"requestPeriodS", JValue::number(2)}}),
        pt("cible", {{"pgn", JValue::number(65226)}, {"request", JValue::boolean(true)},
                     {"sa", JValue::number(0x0B)}, {"requestPeriodS", JValue::number(1)}}),
      }), sink);
      const auto& r = d.requests();
      check("J1939 : un PGN spontané ne déclenche aucune demande",
            r.size() == 2, std::to_string(r.size()) + " demande(s)");
      check("J1939 : SPN du même PGN regroupés à la période la plus courte",
            r.size() == 2 && r[0].pgn == 65262 && r[0].period_s == 2 && r[0].dest == 255,
            r.empty() ? "?" : std::to_string(r[0].period_s) + " s vers " + std::to_string(r[0].dest));
      check("J1939 : demande adressée au calculateur du point",
            r.size() == 2 && r[1].pgn == 65226 && r[1].dest == 0x0B,
            r.size() < 2 ? "?" : std::to_string(r[1].dest));
    }

    {
      // Un lien qui ne demande rien reste muet : un RTS reçu n'ouvre aucune
      // session, donc aucun CTS n'est émis.
      J1939 d(lien("j1939", {}, {pt("long", {{"pgn", JValue::number(65226)},
                                             {"startBit", JValue::number(0)},
                                             {"bitLen", JValue::number(8)}})}), sink);
      check("J1939 : lien en écoute seule, aucune demande planifiée",
            d.requests().empty());
      const uint8_t rts[8] = {0x10, 12, 0, 2, 2, 0xCA, 0xFE, 0x00};
      d.on_frame(0x1CEC0B21u, true, rts, 8);
      const uint8_t dt1[8] = {1, 1, 2, 3, 4, 5, 6, 7};
      const uint8_t dt2[8] = {2, 8, 9, 10, 11, 12, 0xFF, 0xFF};
      d.on_frame(0x1CEB0B21u, true, dt1, 8);
      d.on_frame(0x1CEB0B21u, true, dt2, 8);
      check("J1939 : RTS ignoré en écoute seule (aucun CTS à émettre)",
            sink.vus.empty());
      sink.vus.clear();
    }

    {
      Open d(lien("canopen", {{"nodeId", JValue::number(3)}},
                  {pt("tpdo", {{"mode", JValue::string("tpdo")},
                               {"cobId", JValue::string("0x183")}}),
                   pt("sdo", {{"mode", JValue::string("sdo")},
                              {"index", JValue::string("0x6041")}})}), sink);
      const auto f = d.filters();
      check("CANopen : filtre du TPDO écouté",
            f.size() == 2 && f[0].id == 0x183 && f[0].mask == 0x7FF && !f[0].ext);
      check("CANopen : filtre de la réponse SDO (0x580 + node-id)",
            f.size() == 2 && f[1].id == 0x583, f.size() == 2 ? std::to_string(f[1].id) : "?");
    }
  }

  // ---- BER/ASN.1 (SNMP) -------------------------------------------------
  // Tout ce que ce codec lit vient du réseau : les cas tronqués comptent
  // autant que les cas nominaux.
  {
    // Aller-retour d'un OID : les deux premiers arcs sont combinés (40×a+b),
    // les arcs ≥ 128 s'encodent sur plusieurs octets à bit de continuation.
    for (const char* oid : {"1.3.6.1.2.1.1.3.0", "1.3.6.1.2.1.2.2.1.10.2",
                            "1.3.6.1.4.1.9999.1", "0.0"}) {
      const auto enc = ber::put_oid(oid);
      ber::Cursor c(enc.data(), enc.size());
      uint8_t tag = 0;
      const uint8_t* body = nullptr;
      size_t len = 0;
      std::string back;
      const bool ok = ber::read_tlv(c, tag, body, len) && tag == ber::kOid &&
                      ber::read_oid(body, len, back);
      check("BER : aller-retour d'OID", ok && back == oid, back);
    }
    check("BER : OID fautif refusé", ber::put_oid("1.3.x.1").empty());
    check("BER : OID à un seul arc refusé", ber::put_oid("1").empty());

    // Longueur en forme longue : au-delà de 127 octets de contenu.
    {
      std::vector<uint8_t> big(300, 0x41);
      const auto enc = ber::wrap(ber::kOctetStr, big);
      ber::Cursor c(enc.data(), enc.size());
      uint8_t tag = 0;
      const uint8_t* body = nullptr;
      size_t len = 0;
      check("BER : longueur en forme longue",
            ber::read_tlv(c, tag, body, len) && len == 300, std::to_string(len));
    }

    // Une longueur qui dépasse le tampon doit être refusée, pas crue.
    {
      const uint8_t tronque[4] = {ber::kOctetStr, 0x40, 0x01, 0x02};
      ber::Cursor c(tronque, sizeof tronque);
      uint8_t tag = 0;
      const uint8_t* body = nullptr;
      size_t len = 0;
      check("BER : longueur qui déborde refusée", !ber::read_tlv(c, tag, body, len));
    }

    // Entiers : signe, encodage minimal, et Counter64 préfixé d'un octet nul.
    {
      const int64_t valeurs[] = {0, 1, -1, 127, 128, -128, 32767, -32768,
                                 2147483647LL, -2147483648LL};
      for (int64_t v : valeurs) {
        const auto enc = ber::put_int(v);
        ber::Cursor c(enc.data(), enc.size());
        uint8_t tag = 0;
        const uint8_t* body = nullptr;
        size_t len = 0;
        int64_t back = 0;
        const bool ok = ber::read_tlv(c, tag, body, len) && ber::read_int(body, len, back);
        check("BER : aller-retour d'entier", ok && back == v, std::to_string(back));
      }
      const uint8_t c64[9] = {0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
      uint64_t u = 0;
      int64_t trop_long = 0;
      check("BER : Counter64 préfixé d'un octet nul",
            ber::read_uint(c64, 9, u) && u == 0xFFFFFFFFFFFFFFFFull);
      check("BER : entier trop long refusé", !ber::read_int(c64, 9, trop_long));
    }
  }

  // ---- IEC 61850 : GOOSE et Sampled Values ------------------------------
  // Ces deux flux ne sont pas couverts par le test bout en bout (il faudrait
  // une interface Ethernet et la capacité CAP_NET_RAW), et une erreur de
  // décodage se traduirait par une variable fausse plutôt que par une panne.
  {
    // Étiquette VLAN : un commutateur de poste en ajoute presque toujours une.
    {
      const uint8_t trame[] = {
        0x01, 0x0C, 0xCD, 0x01, 0x00, 0x01,          // destination multicast
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55,          // source
        0x81, 0x00, 0x80, 0x0A,                      // VLAN, priorité 4, id 10
        0x88, 0xB8, 0x00, 0x01,                      // EtherType GOOSE + début
      };
      // L'ordre d'évaluation des arguments n'étant pas garanti, on décode
      // AVANT d'appeler check() : sinon le détail affiché serait périmé.
      L2Frame f;
      const bool lu = L2DriverBase::parse_ethernet(trame, sizeof trame, 0x88B8, f);
      check("L2 : étiquette VLAN franchie", lu && f.vlan_id == 10 && f.len == 2,
            "VLAN " + std::to_string(f.vlan_id) + ", " + std::to_string(f.len) + " octets");
      check("L2 : EtherType non concordant refusé",
            !L2DriverBase::parse_ethernet(trame, sizeof trame, 0x88BA, f));
      check("L2 : trame trop courte refusée",
            !L2DriverBase::parse_ethernet(trame, 10, 0x88B8, f));
    }

    // GOOSE : en-tête (APPID, longueur, réservés) puis goosePdu en BER.
    // Jeu de données : booléen vrai, entier 1234, flottant 50,25.
    {
      const uint8_t donnees[] = {
        0x83, 0x01, 0x01,                             // booléen = vrai
        0x85, 0x02, 0x04, 0xD2,                       // entier = 1234
        0x87, 0x05, 0x08, 0x42, 0x49, 0x00, 0x00,     // flottant = 50,25
      };
      std::vector<uint8_t> pdu;
      auto ajoute = [&pdu](uint8_t tag, std::initializer_list<uint8_t> v) {
        pdu.push_back(tag);
        pdu.push_back(static_cast<uint8_t>(v.size()));
        pdu.insert(pdu.end(), v.begin(), v.end());
      };
      const char* gocb = "IED1LD0/LLN0$GO$gcb01";
      pdu.push_back(0x80);
      pdu.push_back(static_cast<uint8_t>(std::strlen(gocb)));
      pdu.insert(pdu.end(), gocb, gocb + std::strlen(gocb));
      ajoute(0x85, {0x00, 0x2A});                     // stNum = 42
      ajoute(0x86, {0x07});                           // sqNum = 7
      ajoute(0x87, {0x00});                           // simulation = faux
      ajoute(0x8A, {0x03});                           // 3 entrées
      pdu.push_back(0xAB);
      pdu.push_back(sizeof donnees);
      pdu.insert(pdu.end(), donnees, donnees + sizeof donnees);

      std::vector<uint8_t> trame = {0x30, 0x39, 0, 0, 0, 0, 0, 0};   // APPID 0x3039
      trame.push_back(0x61);
      trame.push_back(static_cast<uint8_t>(pdu.size()));
      trame.insert(trame.end(), pdu.begin(), pdu.end());
      trame[2] = static_cast<uint8_t>(trame.size() >> 8);            // longueur
      trame[3] = static_cast<uint8_t>(trame.size() & 0xFF);

      GoosePdu g;
      const bool ok = decode_goose(trame.data(), trame.size(), g);
      check("GOOSE : en-tête décodé", ok && g.st_num == 42 && g.sq_num == 7,
            ok ? "stNum " + std::to_string(g.st_num) + " sqNum " + std::to_string(g.sq_num)
               : "échec");
      check("GOOSE : référence du bloc de contrôle lue", ok && g.gocb_ref == gocb, g.gocb_ref);
      check("GOOSE : nombre d'entrées annoncé", ok && g.entries == 3);

      double v = 0;
      bool lu = goose_entry(g.all_data, g.all_data_len, 0, v);
      check("GOOSE : entrée booléenne", lu && v == 1, std::to_string(v));
      lu = goose_entry(g.all_data, g.all_data_len, 1, v);
      check("GOOSE : entrée entière", lu && v == 1234, std::to_string(v));
      lu = goose_entry(g.all_data, g.all_data_len, 2, v);
      near("GOOSE : entrée flottante", lu ? v : 0, 50.25);
      check("GOOSE : indice au-delà du jeu de données",
            !goose_entry(g.all_data, g.all_data_len, 9, v));

      // Une longueur annoncée plus grande que la trame ne doit pas être crue.
      std::vector<uint8_t> menteuse = trame;
      menteuse[3] = 0xFF;
      GoosePdu g2;
      check("GOOSE : longueur annoncée au-delà de la trame refusée",
            !decode_goose(menteuse.data(), menteuse.size(), g2));
    }

    // Sampled Values 9-2LE : une ASDU, huit voies de 8 octets.
    {
      std::vector<uint8_t> donnees(64, 0);
      // Voie 0 : 1 500 (qualité bonne). Voie 1 : −2 000, qualité invalide.
      const auto ecrire = [&donnees](int voie, int32_t val, uint32_t q) {
        const uint32_t u = static_cast<uint32_t>(val);
        donnees[voie * 8 + 0] = static_cast<uint8_t>(u >> 24);
        donnees[voie * 8 + 1] = static_cast<uint8_t>(u >> 16);
        donnees[voie * 8 + 2] = static_cast<uint8_t>(u >> 8);
        donnees[voie * 8 + 3] = static_cast<uint8_t>(u);
        donnees[voie * 8 + 7] = static_cast<uint8_t>(q);
      };
      ecrire(0, 1500, 0);
      ecrire(1, -2000, 0x01);

      const char* svid = "MU01A";
      std::vector<uint8_t> asdu;
      asdu.push_back(0x80);
      asdu.push_back(static_cast<uint8_t>(std::strlen(svid)));
      asdu.insert(asdu.end(), svid, svid + std::strlen(svid));
      asdu.insert(asdu.end(), {0x82, 0x02, 0x01, 0x00});             // smpCnt = 256
      asdu.push_back(0x87);
      asdu.push_back(static_cast<uint8_t>(donnees.size()));
      asdu.insert(asdu.end(), donnees.begin(), donnees.end());

      std::vector<uint8_t> seq = {0x30};
      seq.push_back(static_cast<uint8_t>(asdu.size()));
      seq.insert(seq.end(), asdu.begin(), asdu.end());

      std::vector<uint8_t> pdu = {0x80, 0x01, 0x01, 0xA2};           // noASDU = 1
      pdu.push_back(static_cast<uint8_t>(seq.size()));
      pdu.insert(pdu.end(), seq.begin(), seq.end());

      std::vector<uint8_t> trame = {0x40, 0x00, 0, 0, 0, 0, 0, 0};
      trame.push_back(0x60);
      trame.push_back(0x81);                                          // longueur forme longue
      trame.push_back(static_cast<uint8_t>(pdu.size()));
      trame.insert(trame.end(), pdu.begin(), pdu.end());
      trame[2] = static_cast<uint8_t>(trame.size() >> 8);
      trame[3] = static_cast<uint8_t>(trame.size() & 0xFF);

      std::vector<SvAsdu> asdus;
      const bool ok = decode_sv(trame.data(), trame.size(), asdus);
      check("SV : ASDU extraite", ok && asdus.size() == 1,
            std::to_string(asdus.size()) + " ASDU");
      check("SV : svID lu", ok && asdus[0].sv_id == svid, ok ? asdus[0].sv_id : "?");
      check("SV : compteur d'échantillons", ok && asdus[0].smp_cnt == 256,
            ok ? std::to_string(asdus[0].smp_cnt) : "?");

      double v = 0;
      bool lu = ok && sv_channel(asdus[0].data, asdus[0].data_len, 0, v);
      check("SV : voie 0 décodée (entier 32 bits gros-boutiste)", lu && v == 1500,
            std::to_string(v));
      lu = ok && sv_channel(asdus[0].data, asdus[0].data_len, 1, v);
      check("SV : voie négative décodée", lu && v == -2000, std::to_string(v));
      uint32_t q = 0;
      lu = ok && sv_quality(asdus[0].data, asdus[0].data_len, 1, q);
      check("SV : qualité invalide repérée sur la voie 1", lu && (q & 3) != 0,
            "qualité 0x" + std::to_string(q));
      lu = ok && sv_channel(asdus[0].data, asdus[0].data_len, 40, v);
      check("SV : voie au-delà du bloc de données", ok && !lu);
    }
  }

  // ---- horodatages à la source ------------------------------------------
  // Une erreur ici ne casse rien de visible : elle décale silencieusement les
  // échantillons, ce qui est bien pire qu'une panne franche.
  {
    // CP56Time2a : 2024-03-15 14:30:45,250 UTC → 1710513045,25.
    const uint8_t objet[12] = {0, 0, 0, 0, 0,          // charge utile (float + QDS)
                               0xC2, 0xB0,             // 45 250 ms = 45 s + 250 ms
                               30,                     // minutes
                               14,                     // heures
                               15,                     // jour du mois
                               3,                      // mois
                               24};                    // année depuis 2000
    near("CP56Time2a décodé en secondes UTC", cp56time2a_utc(objet, 12), 1710513045.25);

    uint8_t invalide[12];
    std::memcpy(invalide, objet, 12);
    invalide[7] |= 0x80;                               // bit IV de l'horodatage
    check("CP56Time2a marqué invalide refusé", cp56time2a_utc(invalide, 12) == 0);
    check("CP56Time2a : objet trop court refusé", cp56time2a_utc(objet, 5) == 0);

    // UtcTime d'IEC 61850 : secondes depuis 1970, puis fraction en 1/2²⁴.
    const uint8_t utc[8] = {0x65, 0xF4, 0x5B, 0x95, 0x40, 0x00, 0x00, 0x0A};
    near("UtcTime 61850 décodé", utc_time_61850(utc, 8), 1710513045.25);
    uint8_t utc_ko[8];
    std::memcpy(utc_ko, utc, 8);
    utc_ko[7] = 0x40;                                  // qualité : valeur invalide
    check("UtcTime 61850 marqué invalide refusé", utc_time_61850(utc_ko, 8) == 0);

    // BinaryTime : millisecondes depuis minuit, jours depuis 1984.
    // Le même instant, dans les trois formats : c'est la meilleure preuve que
    // les trois décodeurs sont d'accord entre eux.
    const uint8_t bt[6] = {0x03, 0x1D, 0x33, 0x02, 0x39, 0x5C};
    near("BinaryTime décodé (jours depuis 1984 + ms depuis minuit)",
         binary_time_61850(bt, 6), 1710513045.25);
    check("BinaryTime tronqué refusé", binary_time_61850(bt, 4) == 0);
  }

  // ---- adresses « @lien.point » ----------------------------------------
  {
    std::string l, p;
    const bool split_ok = split_net_addr("@banc.pression", l, p);
    check("adresse réseau valide", split_ok && l == "banc" && p == "pression", l + " / " + p);
    check("adresse sans point refusée", !split_net_addr("@banc", l, p));
    check("identifiant commençant par un chiffre refusé", !split_net_addr("@1banc.x", l, p));
    check("identifiant trop long refusé",
          !split_net_addr("@abcdefghijklmnopqrstuvwxyz.x", l, p));
    check("reconstruction de l'adresse", net_addr("banc", "pression") == "@banc.pression");

    const ParsedAddr a = parse_addr("@banc.pression");
    check("grammaire du serveur : famille NET", a.ok && a.family == "NET", a.addr);
    const ParsedAddr b = parse_addr("@banc");
    check("grammaire du serveur : forme incorrecte rejetée", !b.ok, b.error);
    const ParsedAddr c = parse_addr("Regulation.mesure.vitesse");
    check("les chemins de modèle restent reconnus", c.ok && c.family == "CAPI", c.addr);
    const ParsedAddr e = parse_addr("MB414");
    check("les registres de bus restent reconnus", e.ok && e.family == "MB", e.addr);
  }

  // ---- lecture de la configuration -------------------------------------
  {
    const std::string txt = R"({"version":1,"links":[
      {"id":"banc","label":"Banc","protocol":"modbus-tcp","enabled":true,
       "params":{"host":"10.0.0.5","port":502},
       "points":[{"id":"p1","label":"Pression","unit":"bar","kind":"float","periodMs":150,
                  "params":{"fn":3,"reg":40,"type":"int16","gain":0.1}},
                 {"id":"p1","label":"doublon ignoré","params":{}},
                 {"id":"9bad","label":"identifiant invalide","params":{}}]},
      {"id":"banc","label":"lien en double","protocol":"modbus-tcp","params":{},"points":[]},
      {"id":"vide","protocol":"","params":{},"points":[]}]})";
    bool ok = false;
    const ProtocolConfig cfg = ProtocolConfig::from_json(jparse(txt, &ok));
    check("configuration analysée", ok);
    check("liens en double ignorés", cfg.links.size() == 1,
          std::to_string(cfg.links.size()) + " lien(s)");
    check("points invalides ou en double ignorés", cfg.links[0].points.size() == 1,
          std::to_string(cfg.links[0].points.size()) + " point(s)");
    check("paramètres du lien lus", cfg.links[0].str("host") == "10.0.0.5" &&
          cfg.links[0].num("port") == 502);
    const PointConfig& p = cfg.links[0].points[0];
    check("paramètres du point lus", p.num("reg") == 40 && p.str("type") == "int16" &&
          std::fabs(p.num("gain") - 0.1) < 1e-9);
    check("période bornée et unité conservées", p.period_ms == 150 && p.unit == "bar");
    check("type de variable lu", p.kind == Kind::Float);

    // Aller-retour : ce que le serveur renvoie doit se relire à l'identique.
    const ProtocolConfig again = ProtocolConfig::from_json(jparse(cfg.to_json().dump(), &ok));
    check("aller-retour JSON sans perte",
          ok && again.links.size() == 1 && again.links[0].points.size() == 1 &&
          again.links[0].str("host") == "10.0.0.5" &&
          again.links[0].points[0].num("reg") == 40);
  }

  std::printf("\n%d/%d vérifications réussies\n", total - failed, total);
  return failed ? 1 : 0;
}
