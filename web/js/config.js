/* Diagweb — configuration globale & catalogue de variables simulées */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  DW.CONFIG = {
    defaultPeriodMs: 10,     // période de rafraîchissement par défaut d'une variable
    periodChoices: [10, 20, 50, 100, 200, 500, 1000],
    horizonS: 330,           // profondeur d'historique conservée (s)
    windows: [15, 30, 60, 120, 300],
    defaultWindowS: 60,
    maxCharts: 8,
    maxSeriesPerChart: 8,    // ordre de palette fixe, jamais recyclé
    chartFps: 20,
    liveRefreshMs: 200,      // rafraîchissement tableau + légendes
  };

  // Palette catégorielle validée (ordre fixe — la position code l'identité).
  DW.SERIES_COLORS = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    dark:  ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  };

  DW.isDarkTheme = function () {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  DW.seriesColor = function (idx) {
    const pal = DW.isDarkTheme() ? DW.SERIES_COLORS.dark : DW.SERIES_COLORS.light;
    return pal[idx % pal.length];
  };

  // ------------------------------------------------------------------
  // Catalogue des variables connues du contrôleur (simulation).
  // kind : 'bit' | 'word' | 'float'
  // sim  : paramètres du générateur (voir sim.js)
  // ------------------------------------------------------------------
  DW.CATALOG = [
    // --- Entrées TOR : I<bus>.<module>.<voie>… -----------------------
    { addr: 'I0.1',      label: "Arrêt d'urgence (pupitre)",              kind: 'bit',  unit: '', sim: { type: 'bit', t0: 120, t1: 4 } },
    { addr: 'I0.2',      label: 'Sélecteur mode auto',                    kind: 'bit',  unit: '', sim: { type: 'bit', t0: 25, t1: 40 } },
    { addr: 'I1.2.3.4',  label: 'Entrée TOR — bus 1, module 2, voie 3.4', kind: 'bit',  unit: '', sim: { type: 'bit', t0: 6, t1: 9 } },
    { addr: 'I1.2.3.5',  label: 'Entrée TOR — bus 1, module 2, voie 3.5', kind: 'bit',  unit: '', sim: { type: 'bit', t0: 11, t1: 5 } },
    { addr: 'I2.0.1',    label: 'Capteur position A',                     kind: 'bit',  unit: '', sim: { type: 'bit', t0: 8, t1: 8 } },

    // --- Sorties TOR : Q… -------------------------------------------
    { addr: 'Q0.3',      label: 'Commande contacteur principal',          kind: 'bit',  unit: '', sim: { type: 'bit', t0: 30, t1: 90 } },
    { addr: 'Q2.1',      label: 'Électrovanne EV1',                       kind: 'bit',  unit: '', sim: { type: 'bit', t0: 14, t1: 7 } },
    { addr: 'Q14.15',    label: 'Sortie relais K15',                      kind: 'bit',  unit: '', sim: { type: 'bit', t0: 9, t1: 13 } },

    // --- Bits mémoire : M… ------------------------------------------
    { addr: 'M1.14',     label: 'Marche demandée',                        kind: 'bit',  unit: '', sim: { type: 'bit', t0: 20, t1: 60 } },
    { addr: 'M1.15',     label: 'Défaut mémorisé',                        kind: 'bit',  unit: '', sim: { type: 'bit', t0: 180, t1: 12 } },
    { addr: 'M20.0',     label: 'Cycle en cours',                         kind: 'bit',  unit: '', sim: { type: 'bit', t0: 15, t1: 45 } },

    // --- Variables système : S… -------------------------------------
    { addr: 'S0.4',      label: 'Système prêt',                           kind: 'bit',  unit: '', sim: { type: 'bit', t0: 8, t1: 300 } },
    { addr: 'S0.5',      label: 'Défaut présent',                         kind: 'bit',  unit: '', sim: { type: 'bit', t0: 240, t1: 15 } },
    { addr: 'S1.0',      label: 'Heartbeat 1 s',                          kind: 'bit',  unit: '', sim: { type: 'square', period: 2, duty: 0.5 } },
    { addr: 'S2.1',      label: 'Liaison bus terrain OK',                 kind: 'bit',  unit: '', sim: { type: 'bit', t0: 600, t1: 6 } },

    // --- Mots de bus : MB<registre> ---------------------------------
    { addr: 'MB400',     label: 'Registre process 400',                   kind: 'word', unit: '', sim: { type: 'sine', base: 12000, amp: 900, period: 47, noise: 60 } },
    { addr: 'MB414',     label: 'Mesure brute capteur (registre 414)',    kind: 'word', unit: '', sim: { type: 'sine', base: 20870, amp: 350, period: 13, noise: 90 } },
    { addr: 'MB520',     label: 'Consigne opérateur (registre 520)',      kind: 'word', unit: '', sim: { type: 'steps', values: [800, 1000, 1200, 1500], period: 35 } },
    { addr: 'MB1000',    label: 'Compteur trames bus',                    kind: 'word', unit: '', sim: { type: 'counter', rate: 87 } },

    // --- Signaux modèles Simulink (C API) ---------------------------
    { addr: 'Regulation.consigne.vitesse',   label: 'Consigne de vitesse',        kind: 'float', unit: 'tr/min', sim: { type: 'steps', values: [1480, 1500, 1500, 1520, 1550], period: 40 } },
    { addr: 'Regulation.mesure.vitesse',     label: 'Vitesse mesurée',            kind: 'float', unit: 'tr/min', sim: { type: 'sine', base: 1500, amp: 22, period: 17, noise: 4 } },
    { addr: 'Regulation.sortie.commande',    label: 'Commande actionneur',        kind: 'float', unit: '%',      sim: { type: 'sine', base: 54, amp: 18, period: 23, noise: 1.5 } },
    { addr: 'Regulation.erreur',             label: 'Erreur de régulation',       kind: 'float', unit: 'tr/min', sim: { type: 'sine', base: 0, amp: 14, period: 11, noise: 3 } },
    { addr: 'Thermique.temperature_eau',     label: "Température d'eau",          kind: 'float', unit: '°C',     sim: { type: 'sine', base: 82, amp: 2.2, period: 140, noise: 0.15 } },
    { addr: 'Thermique.temperature_huile',   label: "Température d'huile",        kind: 'float', unit: '°C',     sim: { type: 'sine', base: 96, amp: 3.1, period: 190, noise: 0.2 } },
    { addr: 'Thermique.temperature_ambiante',label: 'Température ambiante',       kind: 'float', unit: '°C',     sim: { type: 'walk', base: 24, step: 0.05, min: 15, max: 38 } },
    { addr: 'Hydraulique.pression_huile',    label: "Pression d'huile",           kind: 'float', unit: 'bar',    sim: { type: 'sine', base: 4.2, amp: 0.25, period: 29, noise: 0.05 } },
    { addr: 'Hydraulique.pression_circuit',  label: 'Pression circuit',           kind: 'float', unit: 'bar',    sim: { type: 'sine', base: 12.1, amp: 0.8, period: 61, noise: 0.1 } },
    { addr: 'Elec.tension_bus',              label: 'Tension bus DC',             kind: 'float', unit: 'V',      sim: { type: 'sine', base: 27.4, amp: 0.35, period: 37, noise: 0.06 } },
    { addr: 'Elec.courant_charge',           label: 'Courant de charge',          kind: 'float', unit: 'A',      sim: { type: 'steps', values: [8, 14, 18, 26, 31], period: 28, noise: 0.5 } },
    { addr: 'Elec.frequence',                label: 'Fréquence réseau',           kind: 'float', unit: 'Hz',     sim: { type: 'sine', base: 50, amp: 0.06, period: 19, noise: 0.01 } },
    { addr: 'Elec.puissance_active',         label: 'Puissance active',           kind: 'float', unit: 'kW',     sim: { type: 'steps', values: [42, 60, 75, 96, 118], period: 45, noise: 1.2 } },
    { addr: 'Capteurs.niveau_reservoir',     label: 'Niveau réservoir',           kind: 'float', unit: '%',      sim: { type: 'walk', base: 78, step: 0.03, min: 5, max: 100, drift: -0.006 } },
    { addr: 'Capteurs.debit_pompe',          label: 'Débit pompe',                kind: 'float', unit: 'L/min',  sim: { type: 'sine', base: 65, amp: 4, period: 33, noise: 0.6 } },
    { addr: 'Supervision.temps_cycle',       label: "Temps de cycle de l'appli",  kind: 'float', unit: 'µs',     sim: { type: 'jitter', base: 850, noise: 28, spikeP: 0.015, spikeAmp: 400 } },
    { addr: 'Supervision.charge_cpu',        label: 'Charge CPU',                 kind: 'float', unit: '%',      sim: { type: 'walk', base: 32, step: 0.8, min: 4, max: 97 } },
    { addr: 'Supervision.memoire_libre',     label: 'Mémoire libre',              kind: 'float', unit: 'Mo',     sim: { type: 'walk', base: 412, step: 0.6, min: 120, max: 480 } },
  ];

  // Index par adresse (les adresses PLC sont normalisées en majuscules).
  DW.CATALOG_INDEX = new Map();
  for (const e of DW.CATALOG) DW.CATALOG_INDEX.set(e.addr.toUpperCase(), e);
})();
