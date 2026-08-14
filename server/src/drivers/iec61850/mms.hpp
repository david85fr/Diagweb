// Diagweb — client MMS d'IEC 61850 : lecture cyclique et rapports.
//
// Deux mécanismes, une seule association :
//
//   lecture   service Read répété à la période du point ;
//   rapports  l'IED notifie de lui-même, par InformationReport, dès qu'une
//             donnée du jeu change (ou périodiquement, selon le bloc).
//
// ADRESSAGE. Une référence IEC 61850 « LD0/MMXU1.A.phsA.cVal.mag.f » avec la
// contrainte fonctionnelle MX devient, côté MMS, un nom en deux parties :
//   domaine = <nom d'IED><LD>      p. ex. IED1LD0
//   élément = LN$FC$DO$DA$…        p. ex. MMXU1$MX$A$phsA$cVal$mag$f
// Le point ne connaît que la référence 61850 ; la traduction est faite ici,
// une fois, à l'ouverture.
//
// UNE ÉCRITURE, ET UNE SEULE. Activer un rapport suppose d'écrire dans son
// bloc de contrôle (RptEna, et éventuellement TrgOps, IntgPd, GI). C'est une
// exception assumée à la règle de lecture seule, du même ordre que la requête
// SDO de CANopen : l'écriture ne touche QUE les attributs du bloc de rapport,
// jamais une donnée de procédé, et elle n'a lieu que si l'utilisateur a choisi
// le mode « rapports ». Aucun service de commande n'est implémenté.
#pragma once

#include <algorithm>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "../../protocol.hpp"
#include "../common/ber.hpp"
#include "../common/net.hpp"
#include "iso_stack.hpp"
#include "time61850.hpp"

namespace diagweb {

/**
 * Valeur MMS `Data` → grandeur. Les étiquettes du CHOICE sont les mêmes que
 * dans GOOSE : les deux transportent le même type ASN.1.
 */
inline bool mms_value(uint8_t tag, const uint8_t* b, size_t n, double& out) {
  int64_t s = 0;
  uint64_t u = 0;
  switch (tag) {
    case 0x83:                                    // booléen
      out = (n && b[n - 1]) ? 1 : 0;
      return true;
    case 0x84: {                                  // chaîne de bits
      if (n < 2) return false;
      uint64_t v = 0;
      for (size_t k = 1; k < n && k <= 8; ++k) v = (v << 8) | b[k];
      out = static_cast<double>(v >> (b[0] & 7));
      return true;
    }
    case 0x85:
      if (!ber::read_int(b, n, s)) return false;
      out = static_cast<double>(s);
      return true;
    case 0x86:
      if (!ber::read_uint(b, n, u)) return false;
      out = static_cast<double>(u);
      return true;
    case 0x87:
      return ber::read_float(b, n, out);
    default:
      return false;                               // type non numérique
  }
}

/**
 * Première valeur numérique d'un `Data`, en descendant dans les structures.
 * Un attribut comme `cVal.mag.f` est renvoyé par certains IED sous forme de
 * structure ; on prend alors la première feuille exploitable.
 */
inline bool mms_first_value(const uint8_t* d, size_t n, double& out) {
  ber::Cursor c(d, n);
  uint8_t tag = 0;
  const uint8_t* b = nullptr;
  size_t l = 0;
  while (ber::read_tlv(c, tag, b, l)) {
    if (tag == 0xA1 || tag == 0xA2) {             // tableau ou structure
      if (mms_first_value(b, l, out)) return true;
    } else if (mms_value(tag, b, l, out)) {
      return true;
    }
    if (c.done()) break;
  }
  return false;
}

/** Bit `k` d'une chaîne de bits BER (octet de bourrage en tête, bit 0 en tête). */
inline bool mms_bit(const uint8_t* b, size_t n, size_t k) {
  const size_t octet = 1 + k / 8;
  if (octet >= n) return false;
  return (b[octet] >> (7 - (k % 8))) & 1;
}

/**
 * Indices du jeu de données inclus dans un rapport, dans l'ordre où leurs
 * valeurs suivent.
 *
 * C'est le point sur lequel il est facile de se tromper : un rapport déclenché
 * par changement ne porte QUE les membres qui ont changé. Le rang d'une valeur
 * dans le rapport n'est donc pas son rang dans le jeu de données, et confondre
 * les deux publie la mesure sur la mauvaise variable — silencieusement, ce qui
 * est pire qu'une absence de valeur. Seul un rapport d'intégrité ou
 * d'interrogation générale, où tout est inclus, fait coïncider les deux.
 */
inline std::vector<size_t> mms_included(const uint8_t* b, size_t n) {
  std::vector<size_t> out;
  if (n < 2) return out;
  const size_t bourrage = b[0] & 7;
  const size_t total = (n - 1) * 8 - bourrage;
  for (size_t k = 0; k < total; ++k) {
    if (mms_bit(b, n, k)) out.push_back(k);
  }
  return out;
}

/**
 * TrgOps, les conditions de déclenchement d'un bloc de rapport :
 * BIT STRING { reserved(0), data-change(1), quality-change(2), data-update(3),
 * integrity(4), general-interrogation(5) } — bit 0 en tête du premier octet,
 * comme OptFlds et la chaîne d'inclusion.
 *
 * Le bit d'interrogation générale est toujours posé : c'est lui qui autorise le
 * cliché initial demandé juste après l'activation. Sans lui, un IED conforme
 * refuse le GI et les points restent vides jusqu'au premier changement.
 */
inline std::vector<uint8_t> mms_trg_ops(const std::string& choix, bool integrite) {
  uint8_t bits = 0x04;                            // bit 5 : interrogation générale
  if (choix == "dchg") bits |= 0x40;              // bit 1 : changement de valeur
  else if (choix == "qchg") bits |= 0x20;         // bit 2 : changement de qualité
  else if (choix == "dupd") bits |= 0x10;         // bit 3 : mise à jour
  else integrite = true;                          // « périodique » : intégrité seule
  if (integrite) bits |= 0x08;                    // bit 4 : période d'intégrité
  return {0x02, bits};                            // 6 bits utiles, 2 de bourrage
}

/**
 * Identifiant d'invocation d'un PDU reçu, pour apparier une réponse à sa
 * requête. Il ouvre le corps du PDU : INTEGER dans une réponse confirmée,
 * `[0] IMPLICIT` dans une erreur confirmée.
 */
inline bool mms_invoke_id(const uint8_t* pdu, size_t n, int64_t& out) {
  ber::Cursor c(pdu, n), corps;
  uint8_t tag = 0;
  if (!ber::read_into(c, tag, corps)) return false;
  if (tag != 0xA1 && tag != 0xA2) return false;
  const uint8_t* b = nullptr;
  size_t l = 0;
  if (!ber::read_tlv(corps, tag, b, l)) return false;
  if (tag != ber::kInteger && tag != 0x80) return false;
  return ber::read_int(b, l, out);
}

/** Un rapport décodé : la date de l'IED, et les valeurs avec leur indice. */
struct MmsReport {
  double t_source = 0;                                // TimeOfEntry, 0 si absent
  std::vector<std::pair<size_t, double>> valeurs;      // indice dans le jeu, valeur
};

/**
 * InformationReport. La liste contient, dans cet ordre : RptID, OptFlds, puis
 * les champs optionnels ANNONCÉS PAR OptFlds, la chaîne d'inclusion,
 * éventuellement les références de données, et enfin les valeurs.
 *
 * Il faut vraiment décoder OptFlds : se repérer sur « la chaîne de bits » ne
 * suffit pas, OptFlds en est une aussi — et prendre la première fait lire le
 * numéro de séquence à la place de la première valeur.
 *
 * Bits d'OptFlds (IEC 61850-8-1) : 1 numéro de séquence, 2 horodatage, 3 motif
 * d'inclusion, 4 nom du jeu, 5 référence de données, 6 débordement de tampon,
 * 7 identifiant d'entrée, 8 révision de configuration, 9 segmentation. Les
 * motifs d'inclusion (bit 3) suivent les valeurs : ils n'entrent pas dans le
 * décalage à franchir.
 */
inline bool mms_parse_report(const uint8_t* pdu, size_t n, MmsReport& out) {
  out.t_source = 0;
  out.valeurs.clear();
  if (n == 0 || pdu[0] != 0xA3) return false;
  const uint8_t* rapport = nullptr;
  size_t rl = 0;
  if (!iso::find_tag(pdu, n, 0xA0, rapport, rl)) return false;

  // listOfAccessResult est le DERNIER élément de même étiquette : le premier
  // est la spécification d'accès.
  const uint8_t* liste = nullptr;
  size_t ll = 0;
  {
    ber::Cursor t(rapport, rl);
    uint8_t tg = 0;
    const uint8_t* bb = nullptr;
    size_t lb = 0;
    while (ber::read_tlv(t, tg, bb, lb)) {
      if (tg == 0xA0) { liste = bb; ll = lb; }
      if (t.done()) break;
    }
  }
  if (!liste) return false;

  ber::Cursor c(liste, ll);
  uint8_t tag = 0;
  const uint8_t* b = nullptr;
  size_t l = 0;

  if (!ber::read_tlv(c, tag, b, l)) return false;                 // RptID
  if (!ber::read_tlv(c, tag, b, l) || tag != 0x84) return false;  // OptFlds
  const uint8_t* opt = b;
  const size_t optn = l;

  // Champs optionnels annoncés, dans l'ordre de la norme. L'horodatage d'entrée
  // est retenu au passage : c'est la date que l'IED donne à l'événement, bien
  // plus fidèle que l'instant de réception.
  if (mms_bit(opt, optn, 1) && !ber::read_tlv(c, tag, b, l)) return false;   // n° de séquence
  if (mms_bit(opt, optn, 2)) {
    if (!ber::read_tlv(c, tag, b, l)) return false;                          // TimeOfEntry
    out.t_source = binary_time_61850(b, l);
  }
  size_t a_sauter = 0;
  if (mms_bit(opt, optn, 4)) ++a_sauter;          // nom du jeu de données
  if (mms_bit(opt, optn, 6)) ++a_sauter;          // débordement de tampon
  if (mms_bit(opt, optn, 7)) ++a_sauter;          // identifiant d'entrée
  if (mms_bit(opt, optn, 8)) ++a_sauter;          // révision de configuration
  if (mms_bit(opt, optn, 9)) a_sauter += 2;       // segmentation
  for (size_t i = 0; i < a_sauter; ++i) {
    if (!ber::read_tlv(c, tag, b, l)) return false;
  }

  if (!ber::read_tlv(c, tag, b, l) || tag != 0x84) return false;   // chaîne d'inclusion
  const std::vector<size_t> inclus = mms_included(b, l);

  // Références de données : une chaîne par membre inclus, avant les valeurs.
  if (mms_bit(opt, optn, 5)) {
    for (size_t i = 0; i < inclus.size(); ++i) {
      if (!ber::read_tlv(c, tag, b, l)) return false;
    }
  }

  for (size_t rang = 0; rang < inclus.size() && ber::read_tlv(c, tag, b, l); ++rang) {
    double v = 0;
    const bool ok = (tag == 0xA2 || tag == 0xA1) ? mms_first_value(b, l, v)
                                                 : mms_value(tag, b, l, v);
    if (ok) out.valeurs.emplace_back(inclus[rang], v);
  }
  return true;
}

class MmsDriver : public IProtocolDriver {
 public:
  MmsDriver(const LinkConfig& link, IPointSink& sink) : link_(link), sink_(sink) {
    rapports_ = link_.str("mode", "mms") == "report";
    for (const auto& p : link_.points) {
      Point pt;
      pt.ref = p.str("ref");
      pt.fc = p.str("fc", "MX");
      pt.index = static_cast<size_t>(std::max<double>(0, p.num("index", 0)));
      pt.period_s = std::max(0.05, p.period_ms / 1000.0);
      pt.gain = p.num("gain", 1);
      pt.offset = p.num("offset", 0);
      points_.push_back(pt);
    }
  }

  ~MmsDriver() override { close(); }

  bool open(std::string& err) override {
    close();
    fd_ = net::tcp_connect(link_.str("host"), static_cast<int>(link_.num("port", 102)),
                           timeout_ms(), err);
    if (fd_ < 0) return false;
    if (!associer(err)) { close(); return false; }
    // En mode rapports, un point est désigné par son INDICE dans le jeu de
    // données : il n'a pas de référence d'objet à traduire, et en réclamer une
    // ferait clignoter le lien sur un défaut qui n'existe pas.
    if (!rapports_ && !traduire(err)) { close(); return false; }
    if (rapports_ && !activer_rapport(err)) { close(); return false; }
    for (Point& p : points_) p.due = 0;
    return true;
  }

  void close() override {
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
    rx_.clear();
  }

  bool service(std::string& err) override {
    if (fd_ < 0) { err = "lien fermé"; return false; }

    if (rapports_) {
      // L'IED parle quand il veut : on écoute, sans rien demander.
      std::vector<uint8_t> pdu;
      if (!recevoir(pdu, 100, err)) return err.empty();   // délai seul : normal
      traiter_rapport(pdu);
      return true;
    }

    const double t = net::mono_s();
    std::vector<size_t> lot;
    for (size_t i = 0; i < points_.size() && lot.size() < 16; ++i) {
      if (!points_[i].valide || t < points_[i].due) continue;
      points_[i].due = t + points_[i].period_s;
      lot.push_back(i);
    }
    if (lot.empty()) { net::sleep_ms(5); return true; }
    return lire(lot, err);
  }

 private:
  struct Point {
    std::string ref, fc;
    std::string domaine, element;       // traduction MMS
    size_t index = 0;                   // rang dans le jeu de données (rapports)
    bool valide = false;
    double period_s = 1, due = 0;
    double gain = 1, offset = 0;
  };

  int timeout_ms() const {
    return static_cast<int>(std::clamp<double>(link_.num("timeoutMs", 5000), 500, 60000));
  }

  // ------------------------------------------------------------ adressage
  /**
   * « LD0/MMXU1.A.phsA.cVal.mag.f » + FC « MX » →
   * domaine « <ied>LD0 », élément « MMXU1$MX$A$phsA$cVal$mag$f ».
   */
  static bool traduire_ref(const std::string& ref, const std::string& fc,
                           const std::string& ied, std::string& domaine, std::string& element) {
    const size_t barre = ref.find('/');
    if (barre == std::string::npos || barre == 0 || barre + 1 >= ref.size()) return false;
    domaine = ied + ref.substr(0, barre);

    std::string reste = ref.substr(barre + 1);
    const size_t point = reste.find('.');
    if (point == std::string::npos || point == 0) return false;
    // LN$FC$DO$DA$… : le séparateur entre la contrainte fonctionnelle et le
    // premier objet de données compte autant que les autres.
    element = reste.substr(0, point) + "$" + fc + "$";
    for (size_t i = point + 1; i < reste.size(); ++i) {
      element += (reste[i] == '.') ? '$' : reste[i];
    }
    return true;
  }

  bool traduire(std::string& err) {
    const std::string ied = link_.str("iedName");
    size_t bons = 0;
    for (Point& p : points_) {
      p.valide = traduire_ref(p.ref, p.fc, ied, p.domaine, p.element);
      if (p.valide) ++bons;
      else sink_.warn("référence illisible : « " + p.ref + " » (attendu LD/LN.DO.DA)");
    }
    if (bons == 0) {
      err = "aucune référence d'objet exploitable dans ce lien";
      return false;
    }
    return true;
  }

  // --------------------------------------------------------- association
  /** Nom MMS : domaine + élément, en deux VisibleString. */
  static std::vector<uint8_t> nom_objet(const std::string& domaine, const std::string& element) {
    return ber::wrap(0xA0,                                    // variableSpecification = name
                     ber::wrap(0xA1,                          // domain-specific
                               ber::cat({ber::put_str(0x1A, domaine),
                                         ber::put_str(0x1A, element)})));
  }

  bool associer(std::string& err) {
    // 1. COTP : demande de connexion, confirmation attendue.
    if (!emettre(iso::cotp_connect(1, 1), err)) return false;
    std::vector<uint8_t> tpdu;
    if (!lire_tpkt(tpdu, err)) return false;
    uint8_t code = 0;
    const uint8_t* corps = nullptr;
    size_t len = 0;
    if (!iso::cotp_payload(tpdu.data(), tpdu.size(), code, corps, len) || code != 0xD0) {
      err = "connexion ISO refusée par l'équipement (COTP)";
      return false;
    }

    // 2. MMS Initiate, emballé dans ACSE, présentation, session.
    const std::vector<uint8_t> init = ber::wrap(
        0xA8, ber::cat({ber::wrap(0x80, {0x00, 0xFD, 0xE8}),      // détail local : 65000
                        ber::wrap(0x81, {0x05}),                  // appels sortants
                        ber::wrap(0x82, {0x05}),                  // appels entrants
                        ber::wrap(0x83, {0x0A}),                  // imbrication
                        ber::wrap(0xA4, ber::cat({ber::wrap(0x80, {0x01}),
                                                  ber::wrap(0x81, {0x05, 0xF1, 0x00}),
                                                  ber::wrap(0x82, {0x03, 0xEE, 0x1C, 0x00, 0x00,
                                                                   0x04, 0x02, 0x00, 0x00, 0x79,
                                                                   0xEF, 0x18})}))}));
    const std::vector<uint8_t> cp = iso::presentation_connect(iso::acse_aarq(init));
    if (!emettre(iso::cotp_data(iso::session_connect(cp)), err)) return false;

    std::vector<uint8_t> reponse;
    if (!lire_tpkt(reponse, err)) return false;
    if (!iso::cotp_payload(reponse.data(), reponse.size(), code, corps, len)) {
      err = "réponse d'association illisible (COTP)";
      return false;
    }
    const uint8_t* user = nullptr;
    size_t ul = 0;
    if (!iso::session_payload(corps, len, user, ul)) {
      err = "association refusée (session)";
      return false;
    }
    const uint8_t* acse = nullptr;
    size_t al = 0;
    if (!iso::extract_apdu(user, ul, acse, al)) {
      err = "association refusée (présentation)";
      return false;
    }
    const uint8_t* mms = nullptr;
    size_t ml = 0;
    if (!iso::extract_acse_user(acse, al, mms, ml) || ml == 0 || mms[0] != 0xA9) {
      err = "association MMS refusée par l'équipement";
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------- lecture
  bool lire(const std::vector<size_t>& lot, std::string& err) {
    std::vector<uint8_t> variables;
    for (size_t i : lot) {
      const std::vector<uint8_t> v =
          ber::wrap(ber::kSequence, nom_objet(points_[i].domaine, points_[i].element));
      variables.insert(variables.end(), v.begin(), v.end());
    }
    const int32_t invoke = ++invoke_;
    const std::vector<uint8_t> req = ber::wrap(
        0xA0, ber::cat({ber::put_int(invoke),
                        ber::wrap(0xA4,                       // service Read
                                  ber::wrap(0xA1,             // variableAccessSpecification
                                            ber::wrap(0xA0, variables)))}));
    if (!emettre(iso::cotp_data(iso::session_data(iso::presentation_data(req))), err)) {
      return false;
    }

    std::vector<uint8_t> pdu;
    if (!attendre_reponse(invoke, pdu, err)) {
      if (err.empty()) err = "équipement muet (délai dépassé)";
      return false;
    }
    if (pdu[0] == 0xA2) {                               // confirmedErrorPDU
      sink_.warn("lecture refusée par l'équipement");
      return true;
    }

    // confirmed-ResponsePDU → read → listOfAccessResult, deux niveaux plus bas.
    const uint8_t* corps = nullptr;
    size_t cl = 0;
    if (!iso::find_tag(pdu.data(), pdu.size(), 0xA1, corps, cl)) return true;
    const uint8_t* res = nullptr;
    size_t rl = 0;
    if (!iso::find_tag(corps, cl, 0xA1, res, rl)) { res = corps; rl = cl; }
    publier_liste(res, rl, lot);
    return true;
  }

  /**
   * Attend la réponse portant CET identifiant d'invocation.
   *
   * Deux raisons de ne pas se contenter du premier PDU qui arrive. D'abord
   * l'appariement : sans lui, une réponse retardée décalerait le flux
   * durablement — chaque lot de valeurs se poserait sur les points du lot
   * suivant, sans qu'aucune erreur ne le signale (même garde-fou qu'en Modbus).
   * Ensuite les rapports : un IED notifie quand il veut, y compris entre une
   * requête et sa réponse. Les prendre pour la réponse ferait échouer
   * l'activation d'un bloc dès le premier rapport un peu pressé ; ils sont donc
   * traités au passage, et l'attente reprend.
   *
   * false avec `err` vide = délai dépassé, à l'appelant de le qualifier.
   */
  bool attendre_reponse(int32_t invoke, std::vector<uint8_t>& out, std::string& err) {
    const double fin = net::mono_s() + timeout_ms() / 1000.0;
    for (;;) {
      const int restant = static_cast<int>((fin - net::mono_s()) * 1000);
      if (restant <= 0) { err.clear(); return false; }

      std::vector<uint8_t> pdu;
      if (!recevoir(pdu, restant, err)) {
        if (!err.empty()) return false;
        continue;                                       // délai partiel : on attend
      }
      if (pdu.empty()) continue;
      if (pdu[0] == 0xA3) { traiter_rapport(pdu); continue; }   // rapport spontané
      int64_t id = 0;
      if (!mms_invoke_id(pdu.data(), pdu.size(), id) || id != invoke) continue;
      out = std::move(pdu);
      return true;
    }
  }

  /** Une valeur par point demandé, dans l'ordre de la requête. */
  void publier_liste(const uint8_t* d, size_t n, const std::vector<size_t>& lot) {
    ber::Cursor c(d, n);
    size_t rang = 0;
    uint8_t tag = 0;
    const uint8_t* b = nullptr;
    size_t l = 0;
    while (ber::read_tlv(c, tag, b, l) && rang < lot.size()) {
      const size_t idx = lot[rang++];
      if (tag == 0x80) {                                  // échec d'accès
        sink_.warn(points_[idx].ref + " : accès refusé par l'équipement");
        continue;
      }
      double v = 0;
      if (tag == 0xA2 || tag == 0xA1) {
        if (!mms_first_value(b, l, v)) continue;
      } else if (!mms_value(tag, b, l, v)) {
        continue;
      }
      sink_.publish(idx, v * points_[idx].gain + points_[idx].offset);
      if (c.done()) break;
    }
  }

  // ------------------------------------------------------------ rapports
  /**
   * Active le bloc de rapport : écriture de RptEna (et des attributs de
   * déclenchement si l'utilisateur les a réglés). C'est la seule écriture du
   * pilote, et elle ne porte que sur le bloc lui-même.
   *
   * Quatre écritures dans cet ordre, et l'ordre compte :
   *   RptEna = faux    un bloc en service refuse qu'on change ses conditions
   *                    de déclenchement — et un BRCB laissé actif par une
   *                    session précédente est le cas courant, pas l'exception ;
   *   TrgOps, IntgPd   le réglage proprement dit ;
   *   RptEna = vrai    mise en service ;
   *   GI = vrai        interrogation générale : un rapport complet tout de
   *                    suite, pour partir d'un état connu au lieu d'attendre
   *                    le premier changement. Même raison qu'en IEC-104.
   */
  bool activer_rapport(std::string& err) {
    const std::string rcb = link_.str("rcbRef");
    if (rcb.empty()) {
      err = "mode rapports : référence du bloc de contrôle non renseignée";
      return false;
    }
    std::string domaine, element;
    if (!traduire_rcb(rcb, domaine, element)) {
      err = "référence de bloc de rapport illisible : « " + rcb + " »";
      return false;
    }
    rcb_domaine_ = domaine;
    rcb_element_ = element;

    const int intg = static_cast<int>(std::clamp<double>(link_.num("intgPd", 0), 0, 3600000));
    ecrire_rcb(element + "$RptEna", ber::wrap(0x83, {0x00}));
    ecrire_rcb(element + "$TrgOps",
               ber::wrap(0x84, mms_trg_ops(link_.str("trgOps", "dchg"), intg > 0)));
    if (intg > 0) ecrire_rcb(element + "$IntgPd", ber::wrap(0x86, ber::put_uint_body(intg)));
    if (!ecrire_rcb(element + "$RptEna", ber::wrap(0x83, {0x01}))) {
      err = "l'équipement a refusé d'activer le bloc de rapport " + rcb;
      return false;
    }
    // Un IED qui ignore l'interrogation générale reste parfaitement utilisable :
    // ses points partent simplement du premier changement. L'échec n'abat donc
    // pas le lien.
    ecrire_rcb(element + "$GI", ber::wrap(0x83, {0x01}));
    return true;
  }

  /** « IED1LD0/LLN0.BR.brcb01 » → domaine « IED1LD0 », élément « LLN0$BR$brcb01 ». */
  bool traduire_rcb(const std::string& ref, std::string& domaine, std::string& element) const {
    const size_t barre = ref.find('/');
    if (barre == std::string::npos || barre + 1 >= ref.size()) return false;
    domaine = link_.str("iedName") + ref.substr(0, barre);
    element.clear();
    for (size_t i = barre + 1; i < ref.size(); ++i) {
      element += (ref[i] == '.') ? '$' : ref[i];
    }
    return !element.empty();
  }

  bool ecrire_rcb(const std::string& element, const std::vector<uint8_t>& valeur) {
    const int32_t invoke = ++invoke_;
    const std::vector<uint8_t> req = ber::wrap(
        0xA0, ber::cat({ber::put_int(invoke),
                        ber::wrap(0xA5,                       // service Write
                                  ber::cat({ber::wrap(0xA0,
                                                      ber::wrap(ber::kSequence,
                                                                nom_objet(rcb_domaine_, element))),
                                            ber::wrap(0xA0, valeur)}))}));
    std::string err;
    if (!emettre(iso::cotp_data(iso::session_data(iso::presentation_data(req))), err)) return false;
    std::vector<uint8_t> pdu;
    if (!attendre_reponse(invoke, pdu, err)) return false;
    return pdu[0] == 0xA1;                        // confirmed-ResponsePDU
  }

  /** Un rapport reçu : décodage, puis publication sur les points visés. */
  void traiter_rapport(const std::vector<uint8_t>& pdu) {
    MmsReport r;
    if (!mms_parse_report(pdu.data(), pdu.size(), r)) return;
    for (const auto& [index, valeur] : r.valeurs) publier_rang(index, valeur, r.t_source);
  }

  /** Publie sur tous les points qui visent cet indice du jeu de données. */
  void publier_rang(size_t index, double v, double t_source) {
    for (size_t i = 0; i < points_.size(); ++i) {
      if (points_[i].index != index) continue;
      sink_.publish(i, v * points_[i].gain + points_[i].offset, t_source);
    }
  }

  // ------------------------------------------------------------ transport
  bool emettre(const std::vector<uint8_t>& trame, std::string& err) {
    if (!net::write_all(fd_, trame.data(), trame.size())) {
      err = "écriture impossible";
      return false;
    }
    return true;
  }

  /** Lit un TPKT complet (en-tête puis corps), borné par son délai. */
  bool lire_tpkt(std::vector<uint8_t>& out, std::string& err) {
    uint8_t tete[4];
    if (!net::read_exact(fd_, tete, 4, timeout_ms())) {
      err = "pas de réponse (délai dépassé)";
      return false;
    }
    const size_t total = static_cast<size_t>((tete[2] << 8) | tete[3]);
    if (tete[0] != 0x03 || total < 7 || total > 65535) {
      err = "en-tête TPKT incohérent";
      return false;
    }
    out.assign(tete, tete + 4);
    out.resize(total);
    if (!net::read_exact(fd_, out.data() + 4, total - 4, timeout_ms())) {
      err = "réponse tronquée";
      return false;
    }
    return true;
  }

  /** Reçoit un PDU MMS complet ; false + err vide = simple délai dépassé. */
  bool recevoir(std::vector<uint8_t>& mms, int delai, std::string& err) {
    err.clear();
    pollfd p{fd_, POLLIN, 0};
    const int r = ::poll(&p, 1, delai);
    if (r < 0) { err = "liaison perdue"; return false; }
    if (r == 0) return false;                            // rien : ce n'est pas une erreur

    std::vector<uint8_t> tpdu;
    if (!lire_tpkt(tpdu, err)) return false;
    uint8_t code = 0;
    const uint8_t* corps = nullptr;
    size_t len = 0;
    if (!iso::cotp_payload(tpdu.data(), tpdu.size(), code, corps, len)) {
      err = "trame COTP illisible";
      return false;
    }
    const uint8_t* user = nullptr;
    size_t ul = 0;
    if (!iso::session_payload(corps, len, user, ul)) { err = "trame de session illisible"; return false; }
    const uint8_t* pdu = nullptr;
    size_t pl = 0;
    if (!iso::extract_apdu(user, ul, pdu, pl)) { err = "PDU de présentation illisible"; return false; }
    mms.assign(pdu, pdu + pl);
    return true;
  }

  LinkConfig link_;
  IPointSink& sink_;
  std::vector<Point> points_;
  std::string rcb_domaine_, rcb_element_;
  std::vector<uint8_t> rx_;
  bool rapports_ = false;
  int fd_ = -1;
  int32_t invoke_ = 0;
};

}  // namespace diagweb
