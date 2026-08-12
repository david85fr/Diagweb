// Diagweb — tests unitaires du décodage des protocoles réseau.
//
// Vérifie ce qui ne peut pas l'être par le test bout en bout (tests/protocols.mjs) :
// extraction de champs de bits CAN, décomposition d'un identifiant J1939,
// grammaire des adresses « @lien.point », lecture de la configuration JSON.
//
//   g++ -std=c++20 -I server/src -o /tmp/decode tests/decode.cpp && /tmp/decode
#include <cmath>
#include <cstdio>
#include <string>

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
  std::snprintf(buf, sizeof buf, "obtenu %.6g, attendu %.6g", got, want);
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
