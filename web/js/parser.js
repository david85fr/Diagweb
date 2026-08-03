/* Diagweb — analyse et validation des adresses de variables */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  const FAMILIES = {
    I:    { label: 'Entrée TOR',            kind: 'bit' },
    Q:    { label: 'Sortie TOR',            kind: 'bit' },
    M:    { label: 'Bit mémoire',           kind: 'bit' },
    S:    { label: 'Variable système',      kind: 'bit' },
    MB:   { label: 'Mot de bus (registre)', kind: 'word' },
    CAPI: { label: 'Signal modèle (C API)', kind: 'float' },
  };
  DW.FAMILIES = FAMILIES;

  const HELP = "Formats acceptés : I1.2.3.4, Q14.15, M1.14, S0.4 (bits), " +
               "MB414 (mot de bus), Modele/sous_systeme/signal (C API Simulink).";

  /**
   * Analyse une saisie utilisateur.
   * @returns {ok:true, addr, family, kind} | {ok:false, error}
   */
  DW.parseAddr = function (raw) {
    const input = String(raw == null ? '' : raw).trim();
    if (!input) return { ok: false, error: 'Saisissez une adresse de variable. ' + HELP };

    // Mot de bus : MB<registre>
    let m = /^mb\s*(\d{1,5})$/i.exec(input);
    if (m) {
      const reg = parseInt(m[1], 10);
      if (reg > 65535) return { ok: false, error: 'Registre hors plage : MB0 à MB65535.' };
      return { ok: true, addr: 'MB' + reg, family: 'MB', kind: 'word' };
    }

    // Bits PLC : I / Q / M / S suivi de 1 à 4 niveaux numériques
    m = /^([iqms])\s*(\d{1,4}(?:\.\d{1,4}){0,3})$/i.exec(input);
    if (m) {
      const family = m[1].toUpperCase();
      return { ok: true, addr: family + m[2], family, kind: 'bit' };
    }

    // Signal C API : chemin Modele/…/signal (au moins un « / »)
    m = /^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)+$/.exec(input);
    if (m) return { ok: true, addr: input, family: 'CAPI', kind: 'float' };

    // Diagnostics ciblés pour les erreurs fréquentes
    if (/^[iqms]/i.test(input)) {
      return { ok: false, error: 'Adresse ' + input[0].toUpperCase() + '… incomplète ou mal formée. Exemple : ' +
        (input[0].toUpperCase() === 'I' ? 'I1.2.3.4' : input[0].toUpperCase() + '1.4') + '.' };
    }
    return { ok: false, error: 'Format non reconnu pour « ' + input + ' ». ' + HELP };
  };

  /** Métadonnées d'une variable : catalogue si connue, sinon générées. */
  DW.resolveMeta = function (addr, parsed) {
    const p = parsed || DW.parseAddr(addr);
    if (!p.ok) return null;
    const known = DW.CATALOG_INDEX.get(p.addr.toUpperCase());
    if (known) return Object.assign({ family: p.family, known: true }, known);
    return {
      addr: p.addr,
      family: p.family,
      kind: p.kind,
      unit: '',
      label: FAMILIES[p.family].label + ' (hors catalogue)',
      known: false,
      sim: null,
    };
  };
})();
