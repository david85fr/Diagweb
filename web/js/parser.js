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
    NET:  { label: 'Point réseau (lien)',   kind: 'float' },
  };
  DW.FAMILIES = FAMILIES;

  // Identifiant d'un lien ou d'un point réseau (voir web/js/protocols.js)
  const NET_ID = '[A-Za-z][A-Za-z0-9_-]{0,23}';

  const HELP = "Formats acceptés : I1.2.3.4, Q14.15, M1.14, S0.4 (bits), " +
               "MB414 (mot de bus), Modele.sous_systeme.signal (C API Simulink, " +
               "premier champ = nom du modèle), @lien.point (point lu sur un " +
               "lien réseau).";

  /**
   * Analyse une saisie utilisateur.
   * Les familles PLC (I/Q/M/S/MB) sont prioritaires sur les chemins C API ;
   * l'ancien séparateur « / » est toléré et normalisé en « . ».
   * @returns {ok:true, addr, family, kind} | {ok:false, error}
   */
  DW.parseAddr = function (raw) {
    const input = String(raw == null ? '' : raw).trim().replace(/\//g, '.');
    if (!input) return { ok: false, error: 'Saisissez une adresse de variable. ' + HELP };

    // Point réseau : @lien.point — le « @ » lève toute ambiguïté avec les
    // autres familles, dont les chemins C API séparés par des points.
    if (input[0] === '@') {
      const m = new RegExp('^@(' + NET_ID + ')\\.(' + NET_ID + ')$').exec(input);
      if (m) {
        const addr = '@' + m[1] + '.' + m[2];
        const meta = DW.protocols ? DW.protocols.meta(addr) : null;
        return { ok: true, addr, family: 'NET', kind: meta ? meta.kind : 'float' };
      }
      return { ok: false, error: 'Point réseau attendu sous la forme @lien.point ' +
        '(identifiants : une lettre puis lettres, chiffres, « - » ou « _ »). ' +
        'Les liens se déclarent dans ☰ → Liens réseau.' };
    }

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

    // Signal C API : Modele.sous_systeme.signal — segments identifiants
    // séparés par des points, au moins deux (modèle + signal).
    m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.exec(input);
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
    // Points réseau : le catalogue est la configuration des liens.
    if (p.family === 'NET') {
      const meta = DW.protocols ? DW.protocols.meta(p.addr) : null;
      if (meta) return meta;
      return {
        addr: p.addr, family: 'NET', kind: 'float', unit: '',
        label: 'Point réseau non configuré', known: false, sim: null,
      };
    }
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
