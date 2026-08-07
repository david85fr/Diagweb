// Généré par tools/gen-catalog.mjs — ne pas modifier à la main.
// Source : web/js/config.js (catalogue des variables simulées).
#pragma once

#include "sim_source.hpp"

namespace diagweb {

// Horizon d'historique et période par défaut, alignés sur le front-end.
inline constexpr double kHorizonS = 330;
inline constexpr int kDefaultPeriodMs = 10;

inline const std::vector<CatalogEntry>& catalog() {
  static const std::vector<CatalogEntry> entries = {
  { "I0.1", "Arrêt d'urgence (pupitre)", "", Kind::Bit, bitchain(120, 4) },
  { "I0.2", "Sélecteur mode auto", "", Kind::Bit, bitchain(25, 40) },
  { "I1.2.3.4", "Entrée TOR — bus 1, module 2, voie 3.4", "", Kind::Bit, bitchain(6, 9) },
  { "I1.2.3.5", "Entrée TOR — bus 1, module 2, voie 3.5", "", Kind::Bit, bitchain(11, 5) },
  { "I2.0.1", "Capteur position A", "", Kind::Bit, bitchain(8, 8) },
  { "Q0.3", "Commande contacteur principal", "", Kind::Bit, bitchain(30, 90) },
  { "Q2.1", "Électrovanne EV1", "", Kind::Bit, bitchain(14, 7) },
  { "Q14.15", "Sortie relais K15", "", Kind::Bit, bitchain(9, 13) },
  { "M1.14", "Marche demandée", "", Kind::Bit, bitchain(20, 60) },
  { "M1.15", "Défaut mémorisé", "", Kind::Bit, bitchain(180, 12) },
  { "M20.0", "Cycle en cours", "", Kind::Bit, bitchain(15, 45) },
  { "S0.4", "Système prêt", "", Kind::Bit, bitchain(8, 300) },
  { "S0.5", "Défaut présent", "", Kind::Bit, bitchain(240, 15) },
  { "S1.0", "Heartbeat 1 s", "", Kind::Bit, square(2, 0.5) },
  { "S2.1", "Liaison bus terrain OK", "", Kind::Bit, bitchain(600, 6) },
  { "MB400", "Registre process 400", "", Kind::Word, sine(12000, 900, 47, 60) },
  { "MB414", "Mesure brute capteur (registre 414)", "", Kind::Word, sine(20870, 350, 13, 90) },
  { "MB520", "Consigne opérateur (registre 520)", "", Kind::Word, steps({800, 1000, 1200, 1500}, 35, 0) },
  { "MB1000", "Compteur trames bus", "", Kind::Word, counter(87) },
  { "Regulation.consigne.vitesse", "Consigne de vitesse", "tr/min", Kind::Float, steps({1480, 1500, 1500, 1520, 1550}, 40, 0) },
  { "Regulation.mesure.vitesse", "Vitesse mesurée", "tr/min", Kind::Float, sine(1500, 22, 17, 4) },
  { "Regulation.sortie.commande", "Commande actionneur", "%", Kind::Float, sine(54, 18, 23, 1.5) },
  { "Regulation.erreur", "Erreur de régulation", "tr/min", Kind::Float, sine(0, 14, 11, 3) },
  { "Thermique.temperature_eau", "Température d'eau", "°C", Kind::Float, sine(82, 2.2, 140, 0.15) },
  { "Thermique.temperature_huile", "Température d'huile", "°C", Kind::Float, sine(96, 3.1, 190, 0.2) },
  { "Thermique.temperature_ambiante", "Température ambiante", "°C", Kind::Float, walk(24, 0.05, 15, 38, 0) },
  { "Hydraulique.pression_huile", "Pression d'huile", "bar", Kind::Float, sine(4.2, 0.25, 29, 0.05) },
  { "Hydraulique.pression_circuit", "Pression circuit", "bar", Kind::Float, sine(12.1, 0.8, 61, 0.1) },
  { "Elec.tension_bus", "Tension bus DC", "V", Kind::Float, sine(27.4, 0.35, 37, 0.06) },
  { "Elec.courant_charge", "Courant de charge", "A", Kind::Float, steps({8, 14, 18, 26, 31}, 28, 0.5) },
  { "Elec.frequence", "Fréquence réseau", "Hz", Kind::Float, sine(50, 0.06, 19, 0.01) },
  { "Elec.puissance_active", "Puissance active", "kW", Kind::Float, steps({42, 60, 75, 96, 118}, 45, 1.2) },
  { "Capteurs.niveau_reservoir", "Niveau réservoir", "%", Kind::Float, walk(78, 0.03, 5, 100, -0.006) },
  { "Capteurs.debit_pompe", "Débit pompe", "L/min", Kind::Float, sine(65, 4, 33, 0.6) },
  { "Supervision.temps_cycle", "Temps de cycle de l'appli", "µs", Kind::Float, jitter(850, 28, 0.015, 400) },
  { "Supervision.charge_cpu", "Charge CPU", "%", Kind::Float, walk(32, 0.8, 4, 97, 0) },
  { "Supervision.memoire_libre", "Mémoire libre", "Mo", Kind::Float, walk(412, 0.6, 120, 480, 0) },
  };
  return entries;
}

}  // namespace diagweb
