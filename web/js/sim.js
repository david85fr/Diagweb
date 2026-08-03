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
  // addr -> { meta, gen, ts:[], vs:[], refs, periodS, nextT }
  const regs = new Map();
  const t0 = performance.now() / 1000;
  const now = () => performance.now() / 1000 - t0;

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
  function subscribe(addr, opts) {
    const periodS = clampPeriodMs(opts && opts.periodMs) / 1000;
    let rec = regs.get(addr);
    if (rec) {
      rec.refs++;
      if (periodS < rec.periodS) rec.periodS = periodS;
      return rec;
    }
    const meta = DW.resolveMeta(addr);
    if (!meta) return null;
    rec = { meta, gen: makeGen(meta, addr), ts: [], vs: [], refs: 1, periodS, nextT: 0 };
    // Pré-remplissage de tout l'horizon (les t négatifs sont autorisés)
    // pour que les courbes soient pleines dès l'ajout d'une variable.
    const tNow = now();
    for (let t = tNow - CFG.horizonS; t <= tNow; t += periodS) {
      rec.ts.push(t); rec.vs.push(rec.gen(t));
    }
    rec.nextT = tNow + periodS;
    regs.set(addr, rec);
    return rec;
  }

  function unsubscribe(addr) {
    const rec = regs.get(addr);
    if (!rec) return;
    rec.refs--;
    if (rec.refs <= 0) regs.delete(addr);
  }

  function tick() {
    const t = now();
    const minT = t - CFG.horizonS;
    for (const rec of regs.values()) {
      // Rattrapage borné : si l'onglet a été suspendu, on saute en avant.
      if (t - rec.nextT > 2) rec.nextT = t;
      while (rec.nextT <= t) {
        rec.ts.push(rec.nextT);
        rec.vs.push(rec.gen(rec.nextT));
        rec.nextT += rec.periodS;
      }
      // Purge de l'historique au-delà de l'horizon
      let cut = 0;
      while (cut < rec.ts.length && rec.ts[cut] < minT) cut++;
      if (cut > 400) { rec.ts.splice(0, cut); rec.vs.splice(0, cut); }
    }
  }
  setInterval(tick, CFG.defaultPeriodMs);

  DW.source = {
    name: 'Simulation locale',
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
      return rec ? { ts: rec.ts, vs: rec.vs } : { ts: [], vs: [] };
    },
    meta(addr) {
      const rec = regs.get(addr);
      return rec ? rec.meta : DW.resolveMeta(addr);
    },
  };
})();
