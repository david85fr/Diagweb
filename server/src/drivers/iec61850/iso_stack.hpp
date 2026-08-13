// Diagweb — pile ISO sous MMS : TPKT, COTP, session, présentation, ACSE.
//
// MMS ne se pose pas directement sur TCP. Entre les deux s'empilent cinq
// couches héritées du modèle OSI, qu'il faut toutes traverser avant d'échanger
// la moindre donnée :
//
//   TPKT (RFC 1006)   4 octets : version, réservé, longueur totale
//   COTP (ISO 8073)   connexion classe 0 : CR → CC, puis TPDU de données
//   Session (8327)    CONNECT → ACCEPT, puis « give tokens + data transfer »
//   Présentation      CP → CPA : contextes ACSE et MMS, sélecteurs
//   ACSE              AARQ → AARE : nom de contexte applicatif MMS
//
// Aucune de ces couches ne transporte d'information utile pour le diagnostic :
// ce sont cinq poignées de main avant la première lecture. C'est précisément
// ce volume qui rendait MMS disproportionné à écrire tant que GOOSE et Sampled
// Values suffisaient — eux n'en ont aucune.
//
// Tout ce qui est décodé ici vient du réseau : chaque longueur est bornée par
// la taille réellement reçue.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "../common/ber.hpp"
#include "../common/net.hpp"

namespace diagweb {
namespace iso {

/** Identifiants d'objet des syntaxes utilisées par la couche présentation. */
inline const std::vector<uint8_t> kOidAcse   = {0x52, 0x01, 0x00, 0x01};        // 2.2.1.0.1
inline const std::vector<uint8_t> kOidMms    = {0x28, 0xCA, 0x22, 0x02, 0x01};  // 1.0.9506.2.1
inline const std::vector<uint8_t> kOidMmsCtx = {0x28, 0xCA, 0x22, 0x02, 0x03};  // 1.0.9506.2.3
inline const std::vector<uint8_t> kOidBer    = {0x51, 0x01};                    // 2.1.1

constexpr uint8_t kCtxAcse = 1;   // identifiant de contexte de présentation
constexpr uint8_t kCtxMms  = 3;

// ------------------------------------------------------------------ TPKT
/** Enveloppe TPKT : version 3, réservé, longueur totale (en-tête compris). */
inline std::vector<uint8_t> tpkt(const std::vector<uint8_t>& corps) {
  const size_t total = corps.size() + 4;
  std::vector<uint8_t> out = {0x03, 0x00,
                              static_cast<uint8_t>(total >> 8),
                              static_cast<uint8_t>(total & 0xFF)};
  out.insert(out.end(), corps.begin(), corps.end());
  return out;
}

// ------------------------------------------------------------------ COTP
/** Demande de connexion COTP classe 0, avec les sélecteurs de TSAP. */
inline std::vector<uint8_t> cotp_connect(uint16_t src_tsap, uint16_t dst_tsap) {
  std::vector<uint8_t> h = {
      0xE0, 0x00, 0x00,                         // CR, référence destination
      0x00, 0x01, 0x00,                         // référence source, classe 0
      0xC0, 0x01, 0x0A,                         // taille de TPDU : 1024 octets
      0xC1, 0x02, static_cast<uint8_t>(src_tsap >> 8), static_cast<uint8_t>(src_tsap & 0xFF),
      0xC2, 0x02, static_cast<uint8_t>(dst_tsap >> 8), static_cast<uint8_t>(dst_tsap & 0xFF),
  };
  std::vector<uint8_t> out = {static_cast<uint8_t>(h.size())};
  out.insert(out.end(), h.begin(), h.end());
  return tpkt(out);
}

/** TPDU de données COTP (« dernier fragment » toujours posé : classe 0). */
inline std::vector<uint8_t> cotp_data(const std::vector<uint8_t>& corps) {
  std::vector<uint8_t> out = {0x02, 0xF0, 0x80};
  out.insert(out.end(), corps.begin(), corps.end());
  return tpkt(out);
}

/** Extrait la charge utile d'un TPDU reçu ; `code` reçoit le type de TPDU. */
inline bool cotp_payload(const uint8_t* d, size_t n, uint8_t& code,
                         const uint8_t*& corps, size_t& len) {
  if (n < 6 || d[0] != 0x03) return false;               // en-tête TPKT
  const size_t total = static_cast<size_t>((d[2] << 8) | d[3]);
  if (total < 5 || total > n) return false;
  const size_t li = d[4];
  if (li + 5 > total) return false;
  code = d[5];
  corps = d + 5 + li;
  len = total - 5 - li;
  return true;
}

// --------------------------------------------------------------- session
/**
 * CONNECT de session (ISO 8327). Les paramètres sont ceux qu'attend tout IED :
 * options nulles, version 2, sélecteurs de session sur deux octets.
 */
inline std::vector<uint8_t> session_connect(const std::vector<uint8_t>& user) {
  std::vector<uint8_t> p = {
      0x05, 0x06,                               // élément Connect/Accept
      0x13, 0x01, 0x00,                         //   options de protocole
      0x16, 0x01, 0x02,                         //   version 2
      0x14, 0x02, 0x00, 0x02,                   // exigences de l'utilisateur
      0x33, 0x02, 0x00, 0x01,                   // sélecteur appelant
      0x34, 0x02, 0x00, 0x01,                   // sélecteur appelé
      0xC1,                                     // données utilisateur
  };
  // Le champ de longueur des données utilisateur passe en forme longue au-delà
  // de 254 octets : la CP de présentation les dépasse régulièrement.
  if (user.size() < 255) {
    p.push_back(static_cast<uint8_t>(user.size()));
  } else {
    p.push_back(0xFF);
    p.push_back(0x01);
    p.push_back(static_cast<uint8_t>(user.size() >> 8));
    p.push_back(static_cast<uint8_t>(user.size() & 0xFF));
  }
  p.insert(p.end(), user.begin(), user.end());

  std::vector<uint8_t> out = {0x0D, static_cast<uint8_t>(p.size())};   // SPDU CONNECT
  out.insert(out.end(), p.begin(), p.end());
  return out;
}

/** Préfixe de transfert : « give tokens » puis « data transfer ». */
inline std::vector<uint8_t> session_data(const std::vector<uint8_t>& user) {
  std::vector<uint8_t> out = {0x01, 0x00, 0x01, 0x00};
  out.insert(out.end(), user.begin(), user.end());
  return out;
}

/**
 * Extrait les données utilisateur d'un SPDU reçu. Accepte l'ACCEPT (14) et le
 * couple give-tokens/data-transfer, seuls SPDU qu'un client rencontre.
 */
inline bool session_payload(const uint8_t* d, size_t n, const uint8_t*& user, size_t& len) {
  if (n < 2) return false;
  if (d[0] == 0x01) {                                    // give tokens (LI = 0)
    if (n < 4 || d[1] != 0x00 || d[2] != 0x01) return false;
    const size_t li = d[3];
    if (4 + li > n) return false;
    user = d + 4 + li;
    len = n - 4 - li;
    return true;
  }
  if (d[0] != 0x0E) return false;                        // ACCEPT attendu
  size_t i = 2;
  const size_t fin = std::min<size_t>(n, static_cast<size_t>(d[1]) + 2);
  while (i + 2 <= fin) {
    const uint8_t pi = d[i];
    size_t l = d[i + 1];
    size_t saut = 2;
    if (pi == 0xC1 && l == 0xFF) {                       // longueur en forme longue
      if (i + 5 > fin) return false;
      l = static_cast<size_t>((d[i + 3] << 8) | d[i + 4]);
      saut = 5;
    }
    if (i + saut + l > n) return false;
    if (pi == 0xC1) { user = d + i + saut; len = l; return true; }
    i += saut + l;
  }
  return false;
}

// ---------------------------------------------------- présentation + ACSE
/** Un contexte de présentation : identifiant, syntaxe abstraite, transfert. */
inline std::vector<uint8_t> contexte(uint8_t id, const std::vector<uint8_t>& oid) {
  return ber::wrap(ber::kSequence,
                   ber::cat({ber::put_int(id),
                             ber::wrap(ber::kOid, oid),
                             ber::wrap(ber::kSequence, ber::wrap(ber::kOid, kOidBer))}));
}

/** Un élément de la liste PDV : contexte de présentation + contenu. */
inline std::vector<uint8_t> pdv(uint8_t ctx, const std::vector<uint8_t>& contenu) {
  return ber::wrap(ber::kSequence,
                   ber::cat({ber::put_int(ctx), ber::wrap(0xA0, contenu)}));
}

/** AARQ d'ACSE, portant le PDU MMS d'initialisation. */
inline std::vector<uint8_t> acse_aarq(const std::vector<uint8_t>& mms_init) {
  const std::vector<uint8_t> ext =
      ber::wrap(0x28, ber::cat({ber::wrap(ber::kOid, kOidBer),
                                ber::put_int(kCtxMms),
                                ber::wrap(0xA0, mms_init)}));
  return ber::wrap(0x60, ber::cat({ber::wrap(0xA1, ber::wrap(ber::kOid, kOidMmsCtx)),
                                   ber::wrap(0xBE, ext)}));
}

/** CP de présentation : contextes ACSE et MMS, puis l'AARQ en données. */
inline std::vector<uint8_t> presentation_connect(const std::vector<uint8_t>& aarq) {
  const std::vector<uint8_t> liste =
      ber::wrap(0xA4, ber::cat({contexte(kCtxAcse, kOidAcse), contexte(kCtxMms, kOidMms)}));
  const std::vector<uint8_t> normal =
      ber::wrap(0xA2, ber::cat({ber::wrap(0x81, {0x00, 0x00, 0x00, 0x01}),
                                ber::wrap(0x82, {0x00, 0x00, 0x00, 0x01}),
                                liste,
                                ber::wrap(0x61, pdv(kCtxAcse, aarq))}));
  return ber::wrap(0x31, ber::cat({ber::wrap(0xA0, ber::wrap(0x80, {0x01})), normal}));
}

/** Enveloppe de présentation d'un message MMS courant (après association). */
inline std::vector<uint8_t> presentation_data(const std::vector<uint8_t>& mms) {
  return ber::wrap(0x61, pdv(kCtxMms, mms));
}

/**
 * Cherche en profondeur la première étiquette `tag` et rend son contenu.
 * Les étiquettes constructeurs (bit 6 posé) sont parcourues récursivement.
 */
inline bool find_tag(const uint8_t* d, size_t n, uint8_t tag,
                     const uint8_t*& out, size_t& len) {
  ber::Cursor c(d, n);
  uint8_t t = 0;
  const uint8_t* b = nullptr;
  size_t l = 0;
  while (ber::read_tlv(c, t, b, l)) {
    if (t == tag) { out = b; len = l; return true; }
    if ((t & 0x20) && l > 0 && find_tag(b, l, tag, out, len)) return true;
    if (c.done()) break;
  }
  return false;
}

/**
 * PDU applicatif contenu dans une réponse de présentation : on descend dans la
 * donnée utilisateur (0x61), puis dans le `single-ASN1-type` de sa liste PDV.
 * Le chemin est explicite plutôt que deviné, l'étiquette 0x61 servant aussi à
 * l'AARE d'ACSE — une recherche naïve rapporterait le mauvais niveau.
 */
inline bool extract_apdu(const uint8_t* d, size_t n, const uint8_t*& out, size_t& len) {
  const uint8_t* ud = nullptr;
  size_t ul = 0;
  if (!find_tag(d, n, 0x61, ud, ul)) return false;
  return find_tag(ud, ul, 0xA0, out, len);
}

/** PDU MMS transporté par l'AARE d'ACSE (réponse d'association). */
inline bool extract_acse_user(const uint8_t* d, size_t n, const uint8_t*& out, size_t& len) {
  const uint8_t* ui = nullptr;
  size_t ul = 0;
  if (!find_tag(d, n, 0xBE, ui, ul)) return false;
  const uint8_t* ext = nullptr;
  size_t el = 0;
  if (!find_tag(ui, ul, 0x28, ext, el)) return false;
  return find_tag(ext, el, 0xA0, out, len);
}

}  // namespace iso
}  // namespace diagweb
