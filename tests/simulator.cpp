// Diagweb — unit tests of the device simulator (simulator/).
//
// Covers what the end-to-end test (tests/simulator.mjs) cannot pin down: MBAP
// framing corner cases, every exception path, the limits of the specification,
// and the way an engineering value becomes registers and comes back.
//
// Nothing here opens a socket: modbus::pump() takes bytes in and gives bytes
// out, which is exactly what a test wants to look at.
//
//   g++ -std=c++23 -I server/src -I simulator/src -o /tmp/sim tests/simulator.cpp && /tmp/sim
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "bench.hpp"
#include "modbus_tcp.hpp"

using namespace diagweb;
using namespace diagweb::sim;

namespace {
int failed = 0;
int total = 0;

void check(const char* name, bool ok, const std::string& detail = {}) {
  ++total;
  if (!ok) ++failed;
  std::printf("  %s %s%s%s\n", ok ? "✓" : "✗", name, detail.empty() ? "" : " — ",
              detail.c_str());
}
void near(const char* name, double got, double want, double eps = 1e-6) {
  char buf[96];
  std::snprintf(buf, sizeof buf, "obtenu %.9g, attendu %.9g", got, want);
  check(name, std::fabs(got - want) < eps, buf);
}

/** An MBAP frame: transaction identifier, unit, then the PDU. */
std::string frame(uint16_t tid, uint8_t unit, const std::vector<uint8_t>& pdu) {
  std::string s;
  s += static_cast<char>(tid >> 8);
  s += static_cast<char>(tid & 0xFF);
  s += '\0';
  s += '\0';
  const uint16_t len = static_cast<uint16_t>(pdu.size() + 1);
  s += static_cast<char>(len >> 8);
  s += static_cast<char>(len & 0xFF);
  s += static_cast<char>(unit);
  s.append(reinterpret_cast<const char*>(pdu.data()), pdu.size());
  return s;
}

std::vector<uint8_t> read_pdu(int fn, int addr, int count) {
  return {static_cast<uint8_t>(fn), static_cast<uint8_t>(addr >> 8),
          static_cast<uint8_t>(addr & 0xFF), static_cast<uint8_t>(count >> 8),
          static_cast<uint8_t>(count & 0xFF)};
}

/** One exchange: the response PDU of a single request (empty if none). */
std::vector<uint8_t> ask(Bench& b, uint8_t unit, const std::vector<uint8_t>& pdu,
                         uint16_t tid = 7) {
  modbus::Stats st;
  std::string in = frame(tid, unit, pdu), out;
  const bool usable = modbus::pump(b, in, out, st);
  if (!usable || out.size() < 8) return {};
  const uint8_t* p = reinterpret_cast<const uint8_t*>(out.data());
  const bool head_ok = (p[0] << 8 | p[1]) == tid && p[2] == 0 && p[3] == 0 &&
                       (p[4] << 8 | p[5]) == static_cast<int>(out.size() - 6) && p[6] == unit;
  if (!head_ok) return {};
  return std::vector<uint8_t>(p + 7, p + out.size());
}

bool is_exception(const std::vector<uint8_t>& pdu, uint8_t fn, uint8_t code) {
  return pdu.size() == 2 && pdu[0] == (fn | 0x80) && pdu[1] == code;
}

Bench load(const char* json, std::vector<std::string>& warnings) {
  bool ok = false;
  const JValue root = jparse(json, &ok);
  if (!ok) {
    check("configuration analysable", false, json);
    return Bench{};
  }
  return Bench::from_json(root, warnings);
}
}  // namespace

int main() {
  std::printf("Simulateur d'équipements — Modbus TCP\n\n");

  std::vector<std::string> warnings;
  Bench bench = load(default_config(), warnings);

  // ---- configuration interne -------------------------------------------
  {
    check("configuration par défaut sans avertissement", warnings.empty(),
          warnings.empty() ? "" : warnings[0]);
    check("deux équipements sur le même port", bench.devices.size() == 2,
          std::to_string(bench.devices.size()) + " équipement(s)");
    check("unités distinctes", bench.by_unit(1) && bench.by_unit(2) &&
          bench.by_unit(1) != bench.by_unit(2));
    check("unité inconnue non servie", bench.by_unit(9) == nullptr);
    // 0 et 255 sont les valeurs qu'un maître utilise faute de mieux : les
    // rediriger vers le premier équipement évite un « équipement muet » qui
    // n'apprendrait rien à personne.
    check("unités 0 et 255 servies par le premier équipement",
          bench.by_unit(0) == bench.by_unit(1) && bench.by_unit(255) == bench.by_unit(1));
  }

  // ---- image des registres ---------------------------------------------
  {
    bench.tick(0);
    const Device& d = *bench.by_unit(1);
    const Signal* pression = nullptr;
    const Signal* debit = nullptr;
    const Signal* consigne = nullptr;
    for (const Signal& s : d.signals) {
      if (s.id == "pression") pression = &s;
      if (s.id == "debit") debit = &s;
      if (s.id == "consigne") consigne = &s;
    }
    check("signaux de l'exemple présents", pression && debit && consigne);
    // Gain 0,1 : la configuration est en bar, le registre porte la valeur brute
    // — exactement ce que lirait un équipement réel.
    near("pression : brut = valeur / gain", d.reg_at(Area::Holding, 40),
         std::round(pression->value / 0.1), 1.5);
    near("relecture de l'image en unités physiques", d.value_of(pression->modbus),
         std::round(pression->value / 0.1) * 0.1, 0.06);
    near("float32 sur deux registres", d.value_of(debit->modbus), debit->value, 1e-3);
    near("constante lue à sa valeur", d.value_of(consigne->modbus), 3.5, 1e-6);
  }

  // ---- lectures ---------------------------------------------------------
  {
    bench.tick(0);
    const uint16_t attendu = bench.by_unit(1)->reg_at(Area::Holding, 40);
    const std::vector<uint8_t> r = ask(bench, 1, read_pdu(3, 40, 1));
    check("fonction 03 : réponse bien formée",
          r.size() == 4 && r[0] == 3 && r[1] == 2,
          std::to_string(r.size()) + " octet(s)");
    check("fonction 03 : registre lu",
          r.size() == 4 && static_cast<uint16_t>((r[2] << 8) | r[3]) == attendu);

    const std::vector<uint8_t> b = ask(bench, 1, read_pdu(1, 0, 3));
    check("fonction 01 : un octet pour trois bobines", b.size() == 3 && b[1] == 1,
          std::to_string(b.size()) + " octet(s)");
    const Device& d = *bench.by_unit(1);
    const uint8_t voulu = static_cast<uint8_t>(d.bit_at(Area::Coils, 0) |
                                               (d.bit_at(Area::Coils, 1) << 1) |
                                               (d.bit_at(Area::Coils, 2) << 2));
    check("fonction 01 : bits rangés du poids faible au poids fort",
          b.size() == 3 && b[2] == voulu);

    const std::vector<uint8_t> i = ask(bench, 2, read_pdu(4, 4, 2));
    check("second équipement servi sur son unité", i.size() == 6 && i[0] == 4 && i[1] == 4);
  }

  // ---- exceptions -------------------------------------------------------
  {
    check("adresse hors plage : exception 02",
          is_exception(ask(bench, 1, read_pdu(3, 9000, 1)), 3, modbus::kIllegalAddress));
    check("plage à cheval sur la fin : exception 02",
          is_exception(ask(bench, 1, read_pdu(3, 99, 2)), 3, modbus::kIllegalAddress));
    check("quantité nulle : exception 03",
          is_exception(ask(bench, 1, read_pdu(3, 0, 0)), 3, modbus::kIllegalValue));
    check("plus de 125 registres : exception 03",
          is_exception(ask(bench, 1, read_pdu(3, 0, 126)), 3, modbus::kIllegalValue));
    check("plus de 2000 bits : exception 03",
          is_exception(ask(bench, 1, read_pdu(1, 0, 2001)), 1, modbus::kIllegalValue));
    check("fonction non gérée : exception 01",
          is_exception(ask(bench, 1, {0x2B, 0x0E, 1, 0}), 0x2B, modbus::kIllegalFunction));
    check("unité inconnue : exception 0B (équipement muet)",
          is_exception(ask(bench, 9, read_pdu(3, 40, 1)), 3, modbus::kGatewayNoResponse));
    // Une zone vide n'est pas une erreur de configuration : l'équipement n'a
    // simplement pas de registres de maintien, et le dit.
    check("zone absente : exception 02",
          is_exception(ask(bench, 2, read_pdu(3, 0, 1)), 3, modbus::kIllegalAddress));
  }

  // ---- aucune écriture --------------------------------------------------
  // Lecture seule de bout en bout : le serveur de diagnostic n'écrit jamais,
  // et l'équipement simulé ne saurait pas quoi faire d'une écriture. Les
  // quatre fonctions d'écriture reçoivent donc « fonction non gérée », et
  // l'image ne bouge pas — c'est cette dernière vérification qui compte.
  {
    const uint16_t avant = bench.by_unit(1)->reg_at(Area::Holding, 50);
    const bool bobine_avant = bench.by_unit(1)->bit_at(Area::Coils, 2);
    check("fonction 05 (bobine) refusée : exception 01",
          is_exception(ask(bench, 1, {5, 0, 2, 0xFF, 0x00}), 5, modbus::kIllegalFunction));
    check("fonction 06 (registre) refusée : exception 01",
          is_exception(ask(bench, 1, {6, 0, 50, 0x01, 0x2C}), 6, modbus::kIllegalFunction));
    check("fonction 15 (bobines multiples) refusée : exception 01",
          is_exception(ask(bench, 1, {15, 0, 0, 0, 8, 1, 0xFF}), 15, modbus::kIllegalFunction));
    check("fonction 16 (registres multiples) refusée : exception 01",
          is_exception(ask(bench, 1, {16, 0, 50, 0, 1, 2, 0x00, 0x64}), 16,
                       modbus::kIllegalFunction));
    near("l'image reste intacte après les tentatives",
         bench.by_unit(1)->reg_at(Area::Holding, 50), avant);
    check("bobine intacte après tentative",
          bench.by_unit(1)->bit_at(Area::Coils, 2) == bobine_avant);
    // Diagnostic (08), identification (43) : hors périmètre, même réponse.
    check("fonction de diagnostic refusée : exception 01",
          is_exception(ask(bench, 1, {8, 0, 0, 0, 0}), 8, modbus::kIllegalFunction));
  }

  // ---- découpage du flux ------------------------------------------------
  {
    modbus::Stats st;
    std::string in = frame(1, 1, read_pdu(3, 40, 1)) + frame(2, 1, read_pdu(4, 0, 1));
    std::string out;
    const bool deux = modbus::pump(bench, in, out, st);
    check("deux requêtes dans le même segment", deux && st.requests == 2 && in.empty(),
          std::to_string(st.requests) + " requête(s)");
    check("deux réponses appariées", out.size() == 2 * 11 &&
          static_cast<uint8_t>(out[1]) == 1 && static_cast<uint8_t>(out[12]) == 2);

    const std::string whole = frame(3, 1, read_pdu(3, 40, 2));
    std::string part = whole.substr(0, 8);
    out.clear();
    check("trame incomplète : rien n'est répondu",
          modbus::pump(bench, part, out, st) && out.empty() && part.size() == 8);
    part += whole.substr(8);
    check("trame complétée : réponse émise",
          modbus::pump(bench, part, out, st) && out.size() == 13 && part.empty());

    // Un identifiant de protocole non nul n'est pas du Modbus : mieux vaut
    // fermer que tenter une resynchronisation à l'aveugle.
    std::string bad = frame(4, 1, read_pdu(3, 0, 1));
    bad[2] = 1;
    out.clear();
    check("identifiant de protocole étranger : liaison fermée",
          !modbus::pump(bench, bad, out, st) && out.empty());

    std::string big = frame(5, 1, read_pdu(3, 0, 1));
    big[4] = 0x01;                                  // longueur annoncée : 262
    big[5] = 0x06;
    out.clear();
    check("longueur MBAP impossible : liaison fermée",
          !modbus::pump(bench, big, out, st) && out.empty());
  }

  // ---- types et bornes ---------------------------------------------------
  {
    std::vector<std::string> w;
    Bench b = load(R"({"version":1,"devices":[{"id":"t","label":"Types",
      "modbus":{"unitId":1,"holding":32},
      "signals":[
        {"id":"grand","gen":{"kind":"const","value":90000},
         "modbus":{"area":"holding","addr":0,"type":"uint16"}},
        {"id":"negatif","gen":{"kind":"const","value":-40000},
         "modbus":{"area":"holding","addr":1,"type":"int16"}},
        {"id":"gros","gen":{"kind":"const","value":3000000000},
         "modbus":{"area":"holding","addr":2,"type":"uint32"}},
        {"id":"flottant","gen":{"kind":"const","value":42.5},
         "modbus":{"area":"holding","addr":4,"type":"float32"}},
        {"id":"inverse","gen":{"kind":"const","value":42.5},
         "modbus":{"area":"holding","addr":6,"type":"float32","wordOrder":"little"}},
        {"id":"double","gen":{"kind":"const","value":-1234.5678},
         "modbus":{"area":"holding","addr":8,"type":"float64"}},
        {"id":"decale","gen":{"kind":"const","value":25},
         "modbus":{"area":"holding","addr":12,"type":"uint16","gain":0.5,"offset":10}}
      ]}]})",
                   w);
    check("configuration de types lue", w.empty() && b.devices.size() == 1,
          w.empty() ? "" : w[0]);
    b.tick(0);
    const Device& d = b.devices[0];
    near("uint16 saturé, jamais replié", d.reg_at(Area::Holding, 0), 65535);
    near("int16 saturé au minimum", static_cast<int16_t>(d.reg_at(Area::Holding, 1)), -32768);
    near("uint32 : poids fort d'abord", d.reg_at(Area::Holding, 2), 3000000000u >> 16);
    near("float32 relu à l'identique", d.value_of(d.signals[3].modbus), 42.5, 1e-6);
    check("ordre des mots inversé",
          d.reg_at(Area::Holding, 4) == d.reg_at(Area::Holding, 7) &&
          d.reg_at(Area::Holding, 5) == d.reg_at(Area::Holding, 6));
    near("float64 sur quatre registres", d.value_of(d.signals[5].modbus), -1234.5678, 1e-9);
    // valeur = brut × gain + décalage ⇒ brut = (25 − 10) / 0,5 = 30
    near("gain et décalage inversés à l'encodage", d.reg_at(Area::Holding, 12), 30);
    near("aller-retour gain/décalage", d.value_of(d.signals[6].modbus), 25, 1e-9);
  }

  // ---- configuration fautive --------------------------------------------
  {
    std::vector<std::string> w;
    Bench b = load(R"({"version":1,"devices":[
      {"id":"1mauvais","label":"identifiant invalide","signals":[]},
      {"id":"bon","modbus":{"unitId":3,"holding":4},"signals":[
        {"id":"9non","modbus":{"area":"holding","addr":0}},
        {"id":"zone","modbus":{"area":"nawak","addr":0}},
        {"id":"type","modbus":{"area":"holding","addr":0,"type":"complexe"}},
        {"id":"loi","gen":{"kind":"tornade"},"modbus":{"area":"holding","addr":1}},
        {"id":"ok","gen":{"kind":"const","value":7},"modbus":{"area":"holding","addr":2}}]},
      {"id":"double","modbus":{"unitId":3},"signals":[]}]})",
                   w);
    check("un seul équipement retenu", b.devices.size() == 1,
          std::to_string(b.devices.size()) + " équipement(s)");
    // Six rejets, six avertissements : équipement mal nommé, unité en double,
    // identifiant de signal, zone, type, loi de mouvement. Un simulateur qui
    // avale une faute de frappe en silence fait chercher la panne ailleurs.
    check("chaque rejet est signalé", w.size() == 6,
          std::to_string(w.size()) + " avertissement(s)");
    check("signal valide conservé et exposé",
          b.devices.size() == 1 && b.devices[0].signals.size() == 4 &&
          b.devices[0].signals.back().modbus.exposed);
    // Un signal dont l'exposition est refusée n'occupe aucun registre : la
    // valeur ne doit pas apparaître à une adresse choisie par défaut.
    b.tick(0);
    check("signal non exposé absent de l'image",
          b.devices.size() == 1 && b.devices[0].reg_at(Area::Holding, 0) == 0 &&
          b.devices[0].reg_at(Area::Holding, 1) == 0);
    near("signal valide dans l'image", b.devices.empty() ? -1 : b.devices[0].reg_at(Area::Holding, 2), 7);
  }

  // ---- lois de mouvement -------------------------------------------------
  {
    std::vector<std::string> w;
    Bench b = load(R"({"version":1,"devices":[{"id":"m","modbus":{"unitId":1,"holding":8,"coils":4},
      "signals":[
        {"id":"rampe","gen":{"kind":"ramp","base":100,"rate":10},
         "modbus":{"area":"holding","addr":0,"type":"uint32"}},
        {"id":"boucle","gen":{"kind":"ramp","base":0,"rate":1,"modulo":10},
         "modbus":{"area":"holding","addr":2,"type":"uint16"}},
        {"id":"carre","gen":{"kind":"square","periodS":10,"duty":0.5},
         "modbus":{"area":"coils","addr":0}}
      ]}]})",
                   w);
    check("lois lues", w.empty() && b.devices.size() == 1, w.empty() ? "" : w[0]);
    const Device& d = b.devices[0];
    b.tick(0);
    near("rampe à l'origine", d.value_of(d.signals[0].modbus), 100);
    b.tick(30);
    near("rampe après 30 s", d.value_of(d.signals[0].modbus), 400);
    near("rampe bouclée par le modulo", d.value_of(d.signals[1].modbus), 0);
    b.tick(34);
    near("rampe bouclée, quatre secondes plus tard", d.value_of(d.signals[1].modbus), 4);
    // Un créneau doit être vu aux deux états : sinon la bobine ne prouve rien.
    bool vu_haut = false, vu_bas = false;
    for (int i = 0; i < 20; ++i) {
      b.tick(i);
      (d.bit_at(Area::Coils, 0) ? vu_haut : vu_bas) = true;
    }
    check("créneau : les deux états sont atteints", vu_haut && vu_bas);
  }

  std::printf("\n%d/%d vérifications réussies\n", total - failed, total);
  return failed ? 1 : 0;
}
