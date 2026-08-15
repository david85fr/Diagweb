/* Diagweb — source de données simulée.
 *
 * Implémente le contrat DataSource (voir docs/SPECS.md §7) : le back-end
 * réel (WebSocket vers le contrôleur) devra exposer la même interface.
 */
(function () {
  "use strict";
  const DW = window.DW;
  const CFG = DW.CONFIG;

  // --- PRNG déterministe par adresse (comportement stable entre rechargements)
  function hash32(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // --- Générateurs -----------------------------------------------------
  function makeGen(meta, addr) {
    const rnd = mulberry32(hash32(addr));
    const phase = rnd() * 1000;
    let sim = meta.sim;
    if (!sim) sim = defaultSim(meta.kind, rnd);

    switch (sim.type) {
      case 'sine': {
        const round = meta.kind === 'word';
        return (t) => {
          let v = sim.base + sim.amp * Math.sin((t + phase) * 2 * Math.PI / sim.period) +
                  (sim.noise || 0) * (rnd() - 0.5) * 2;
          if (round) v = Math.max(0, Math.min(65535, Math.round(v)));
          return v;
        };
      }
      case 'walk': {
        let v = sim.base;
        return () => {
          v += (rnd() - 0.5) * 2 * sim.step + (sim.drift || 0);
          if (v < sim.min) v = sim.min + (sim.min - v);
          if (v > sim.max) v = sim.max - (v - sim.max);
          v = Math.max(sim.min, Math.min(sim.max, v));
          return v;
        };
      }
      case 'steps': {
        let cur = sim.values[Math.floor(rnd() * sim.values.length)];
        let nextAt = null;   // initialisé au premier appel (le pré-remplissage part de t négatif)
        const round = meta.kind === 'word';
        return (t) => {
          if (nextAt === null) nextAt = t + sim.period * (0.5 + rnd());
          if (t >= nextAt) {
            cur = sim.values[Math.floor(rnd() * sim.values.length)];
            nextAt = t + sim.period * (0.5 + rnd());
          }
          let v = cur + (sim.noise || 0) * (rnd() - 0.5) * 2;
          return round ? Math.round(v) : v;
        };
      }
      case 'square':
        return (t) => (((t + phase) % sim.period) < sim.period * sim.duty ? 1 : 0);
      case 'bit': {
        // Chaîne de Markov : temps de séjour moyens t0 (état 0) et t1 (état 1)
        let v = rnd() < sim.t1 / (sim.t0 + sim.t1) ? 1 : 0;
        let flipAt = null;   // initialisé au premier appel (t peut être négatif)
        return (t) => {
          if (flipAt === null) flipAt = t + (v ? sim.t1 : sim.t0) * (0.3 + rnd() * 1.4);
          if (t >= flipAt) {
            v = v ? 0 : 1;
            flipAt = t + (v ? sim.t1 : sim.t0) * (0.3 + rnd() * 1.4);
          }
          return v;
        };
      }
      case 'counter': {
        return (t) => ((Math.round(sim.rate * t) % 65536) + 65536) % 65536;
      }
      case 'jitter': {
        return () => {
          let v = sim.base + (rnd() - 0.5) * 2 * sim.noise;
          if (rnd() < sim.spikeP) v += sim.spikeAmp * rnd();
          return v;
        };
      }
      default:
        return () => 0;
    }
  }

  function defaultSim(kind, rnd) {
    if (kind === 'bit') return { type: 'bit', t0: 4 + rnd() * 30, t1: 4 + rnd() * 30 };
    if (kind === 'word') {
      const base = Math.round(500 + rnd() * 40000);
      return { type: 'sine', base, amp: base * 0.06 + 20, period: 8 + rnd() * 60, noise: 25 };
    }
    const base = Math.round((rnd() * 200 - 40) * 10) / 10;
    return { type: 'sine', base, amp: 2 + rnd() * 25, period: 8 + rnd() * 50, noise: 0.4 };
  }

  // --- Registre des abonnements ---------------------------------------
  // addr -> { meta, gen, ts:[], vs:[], tss, refs, periodS, nextK }
  // Les instants d'échantillonnage sont les multiples ENTIERS de la période
  // (t = k·période) : toutes les variables de même période tombent aux mêmes
  // instants — sur des secondes entières quand la période divise la seconde.
  // Sans ce calage, deux variables de même période écrivaient leurs lignes en
  // quinconce dans le journal téléchargé trié par horodatage.
  const regs = new Map();
  // Valeurs forcées (diagnostic) : tant qu'une adresse y figure, la simulation
  // sert cette valeur au lieu du générateur (voir DW.source.write).
  const forced = new Map();
  const t0 = performance.now() / 1000;
  const brut = () => performance.now() / 1000 - t0;

  /**
   * Acquisition : marche ou arrêt, et origine de la capture courante.
   *
   * À l'arrêt, l'HORLOGE de la source se fige elle aussi. Sans cela le temps
   * continuerait d'avancer sans qu'aucun échantillon n'arrive : les vues en
   * direct défileraient dans le vide, et les retards afficheraient un
   * vieillissement que rien ne justifie.
   */
  let enMarche = true;
  let arreteA = 0;          // instant du dernier arrêt (horloge figée)
  // La simulation pré-remplit l'historique sur un horizon complet à
  // l'abonnement : l'origine de la première capture est donc le début de ces
  // données, pas l'instant du chargement de la page — sinon le curseur
  // afficherait des temps négatifs, ramenés à zéro, sur les trois quarts du
  // tracé.
  let captureT0 = -CFG.horizonS;
  const now = () => (enMarche ? brut() : arreteA);

  function clampPeriodMs(p) {
    p = parseInt(p, 10);
    if (!isFinite(p) || p <= 0) p = CFG.defaultPeriodMs;
    return Math.min(10000, Math.max(CFG.defaultPeriodMs, p));
  }

  /**
   * @param opts {periodMs?} — période de rafraîchissement (défaut 10 ms).
   * Une souscription supplémentaire avec une période plus courte resserre
   * le flux existant (un seul flux par variable).
   */
  /**
   * Le point réseau simulé suit-il l'horloge de « l'équipement » ?
   * Miroir du réglage « Horodatage » du point (défaut : source). La
   * simulation fabrique alors un horodatage source — l'équipement simulé a
   * une horloge parfaitement à l'heure — pour que le journal téléchargé
   * montre ses deux colonnes de dates comme avec un vrai lien.
   */
  function netSourceTs(addr) {
    const P = DW.protocols;
    if (!P || !P.config || addr[0] !== '@') return false;
    const dot = addr.indexOf('.');
    const l = (P.config.links || []).find((x) => x.id === addr.slice(1, dot));
    const p = l && (l.points || []).find((x) => x.id === addr.slice(dot + 1));
    return !!p && (p.params && p.params.timestamp) !== 'server';
  }
  // Horloge murale de t = 0, figée au chargement (horodatages source simulés).
  const wall0 = Date.now() / 1000 - brut();

  function subscribe(addr, opts) {
    const periodS = clampPeriodMs(opts && opts.periodMs) / 1000;
    let rec = regs.get(addr);
    if (rec) {
      rec.refs++;
      if (periodS < rec.periodS) {
        // Période resserrée : repartir sur la grille de la nouvelle période.
        rec.periodS = periodS;
        rec.nextK = Math.floor(now() / periodS) + 1;
      }
      return rec;
    }
    const meta = DW.resolveMeta(addr);
    if (!meta) return null;
    rec = { meta, gen: makeGen(meta, addr), ts: [], vs: [],
            tss: netSourceTs(addr) ? [] : null, refs: 1, periodS, nextK: 0 };
    // Pré-remplissage de tout l'horizon (les t négatifs sont autorisés)
    // pour que les courbes soient pleines dès l'ajout d'une variable.
    const tNow = now();
    let k = Math.ceil((tNow - CFG.horizonS) / periodS - 1e-9);
    const kEnd = Math.floor(tNow / periodS + 1e-9);
    for (; k <= kEnd; k++) {
      const t = k * periodS;
      rec.ts.push(t); rec.vs.push(rec.gen(t));
      if (rec.tss) rec.tss.push(wall0 + t);
    }
    rec.nextK = kEnd + 1;
    regs.set(addr, rec);
    return rec;
  }

  function unsubscribe(addr) {
    const rec = regs.get(addr);
    if (!rec) return;
    rec.refs--;
    if (rec.refs <= 0) regs.delete(addr);
  }

  /** Instant en deçà duquel l'historique ne doit pas être purgé (vue figée). */
  let holdT = null;

  function tick() {
    if (!enMarche) return;
    const t = now();
    let minT = t - CFG.horizonS;
    if (holdT != null) minT = Math.min(minT, Math.max(holdT, t - CFG.holdMaxS));
    for (const [addr, rec] of regs) {
      // Rattrapage borné : si l'onglet a été suspendu, on saute en avant —
      // en restant sur la grille de la période.
      if (t - rec.nextK * rec.periodS > 2) rec.nextK = Math.ceil(t / rec.periodS);
      const held = forced.has(addr) ? forced.get(addr) : null;
      while (rec.nextK * rec.periodS <= t) {
        const tk = rec.nextK * rec.periodS;
        rec.ts.push(tk);
        rec.vs.push(held != null ? held : rec.gen(tk));
        if (rec.tss) rec.tss.push(wall0 + tk);
        rec.nextK++;
      }
      // Purge de l'historique au-delà de l'horizon
      let cut = 0;
      while (cut < rec.ts.length && rec.ts[cut] < minT) cut++;
      if (cut > 400) {
        rec.ts.splice(0, cut); rec.vs.splice(0, cut);
        if (rec.tss) rec.tss.splice(0, cut);
      }
    }
  }
  setInterval(tick, CFG.defaultPeriodMs);

  DW.sources = DW.sources || {};
  DW.sources.sim = {
    name: 'Simulation locale',
    // Même contrat que source-ws.js : ici tout est simulé, et le nom le dit
    // déjà — la barre d'état n'a donc rien à ajouter (voir app.js).
    controllerSimulated: true,
    links: null,
    /**
     * Retient l'historique jusqu'à cet instant, au-delà de l'horizon ordinaire.
     * Appelé par l'application quand une tuile est figée : ce qu'on regarde ne
     * doit pas être jeté sous nos yeux. `null` rend la purge à l'horizon.
     */
    setHold(t) { holdT = (typeof t === 'number' && isFinite(t)) ? t : null; },

    // ---- Capture (marche / arrêt de l'acquisition) -------------------
    running: () => enMarche,
    captureStart: () => captureT0,

    /** Arrête l'acquisition : l'historique et la vue restent en l'état. */
    stop() {
      if (!enMarche) return;
      arreteA = brut();
      enMarche = false;
    },

    /**
     * Démarre une NOUVELLE capture : l'origine des temps repart de zéro et
     * l'historique précédent est effacé. Sans cet effacement, « temps depuis
     * le début de la capture » n'aurait pas de sens pour les échantillons
     * d'avant.
     */
    start() {
      enMarche = true;
      captureT0 = brut();
      for (const rec of regs.values()) {
        rec.ts.length = 0; rec.vs.length = 0;
        if (rec.tss) rec.tss.length = 0;
        rec.nextK = Math.ceil(captureT0 / rec.periodS - 1e-9);
      }
    },
    defaultPeriodMs: CFG.defaultPeriodMs,
    now,
    subscribe,
    unsubscribe,
    count: () => regs.size,
    latest(addr) {
      const rec = regs.get(addr);
      if (!rec || !rec.ts.length) return null;
      const i = rec.ts.length - 1;
      return { t: rec.ts[i], v: rec.vs[i] };
    },
    /** Valeur ~delta secondes en arrière (pour la tendance). */
    past(addr, delta) {
      const rec = regs.get(addr);
      if (!rec || !rec.ts.length) return null;
      const target = rec.ts[rec.ts.length - 1] - delta;
      for (let i = rec.ts.length - 1; i >= 0; i--) {
        if (rec.ts[i] <= target) return rec.vs[i];
      }
      return rec.vs[0];
    },
    data(addr) {
      const rec = regs.get(addr);
      // tss : horodatages source (secondes UTC), seulement pour les points
      // réseau qui en portent — même contrat que source-ws.js.
      return rec ? { ts: rec.ts, vs: rec.vs, tss: rec.tss || null }
                 : { ts: [], vs: [], tss: null };
    },
    meta(addr) {
      const rec = regs.get(addr);
      return rec ? rec.meta : DW.resolveMeta(addr);
    },

    /**
     * Force (ou relâche, si value == null) la valeur d'une variable.
     * Les points réseau (@lien.point) sont en lecture seule : refusés.
     * @returns {Promise<{ok, error?}>}
     */
    write(addr, value) {
      const p = DW.parseAddr(addr);
      if (!p.ok) return Promise.resolve({ ok: false, error: 'Adresse invalide : ' + addr });
      if (p.family === 'NET') {
        return Promise.resolve({ ok: false, error: 'Point réseau en lecture seule — forçage impossible.' });
      }
      if (value == null) forced.delete(p.addr);
      else forced.set(p.addr, p.kind === 'bit' ? (value >= 0.5 ? 1 : 0) : value);
      // Effet immédiat sur le dernier échantillon (retour visuel instantané)
      const rec = regs.get(p.addr);
      if (rec && value != null && rec.ts.length) rec.vs[rec.vs.length - 1] = forced.get(p.addr);
      return Promise.resolve({ ok: true });
    },
    /** Valeur forcée d'une variable, ou null si elle suit son générateur. */
    forced(addr) {
      const p = DW.parseAddr(addr);
      const key = p.ok ? p.addr : addr;
      return forced.has(key) ? forced.get(key) : null;
    },
  };

  // Source par défaut ; source.js peut lui substituer le flux du serveur
  // de diagnostic avant le démarrage de l'application.
  DW.source = DW.sources.sim;
})();
