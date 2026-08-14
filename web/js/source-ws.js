/* Diagweb — source de données WebSocket (serveur de diagnostic).
 *
 * Implémente le même contrat que la simulation (voir docs/SPECS.md §7) :
 * subscribe(addr, {periodMs}) / unsubscribe / latest / past / data / meta /
 * now / count. Le reste de l'application ignore laquelle des deux sources
 * est active.
 *
 * Protocole (trames texte JSON, voir server/src/main.cpp) :
 *   → {"c":"sub","addr":"MB414","periodMs":10} · {"c":"unsub","addr":…}
 *   ← {"e":"hello"|"meta"|"err"|"d", …}
 */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});
  const CFG = DW.CONFIG;

  DW.sources = DW.sources || {};

  function createWsSource() {
    const chans = new Map();     // addr -> {meta, ts:[], vs:[], refs, periodMs}
    const forced = new Map();    // adresses forcées (diagnostic) → valeur
    const pendingWrites = new Map();   // adresse → résolveur en attente de confirmation
    let ws = null;
    let skew = 0, haveSkew = false;
    let horizonS = CFG.horizonS;
    let srcName = 'Serveur de diagnostic';
    let retry = 0, retryTimer = null, closed = false;

    const localSec = () => performance.now() / 1000;
    const now = () => localSec() + skew;

    function setStatus(msg, isErr) {
      if (typeof api.onStatus === 'function') api.onStatus(msg, isErr);
    }

    function send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    }

    function trim(ch) {
      let minT = now() - horizonS;
      if (holdT != null) minT = Math.min(minT, Math.max(holdT, now() - CFG.holdMaxS));
      let cut = 0;
      while (cut < ch.ts.length && ch.ts[cut] < minT) cut++;
      if (cut > 400) { ch.ts.splice(0, cut); ch.vs.splice(0, cut); }
    }

    // Instant retenu par une vue figée : l'historique qu'elle montre survit à
    // l'horizon ordinaire (voir sim.js, même contrat).
    let holdT = null;

    let onHello = null;   // renseigné par connect() : la session n'est prête
                          // qu'une fois « hello » reçu (nom, horizon, horloge)

    function onMessage(ev) {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }

      if (m.e === 'hello') {
        horizonS = m.horizonS || horizonS;
        srcName = m.source || srcName;
        api.name = srcName;
        api.defaultPeriodMs = m.defaultPeriodMs || CFG.defaultPeriodMs;
        // Redémarrage du serveur : son horloge (t depuis le démarrage) repart
        // près de zéro. Sans purge, la déduplication (t ≤ dernier t) rejetterait
        // tout échantillon neuf et les courbes gèleraient définitivement. Si
        // l'horloge a reculé, on vide l'historique avant de repartir.
        let maxT = -Infinity;
        for (const ch of chans.values()) if (ch.ts.length) maxT = Math.max(maxT, ch.ts[ch.ts.length - 1]);
        if (isFinite(maxT) && m.now < maxT - 1) {
          for (const ch of chans.values()) { ch.ts.length = 0; ch.vs.length = 0; }
          setStatus('Serveur redémarré — historique réinitialisé.');
        }
        skew = m.now - localSec();
        haveSkew = true;
        if (onHello) { const f = onHello; onHello = null; f(); }
        return;
      }
      if (m.e === 'meta') {
        const ch = chans.get(m.addr);
        if (ch) {
          // Les métadonnées du contrôleur font autorité sur celles déduites
          // localement : on complète l'objet en place (déjà référencé par l'UI).
          if (m.label) ch.meta.label = m.label;
          if (m.unit != null) ch.meta.unit = m.unit;
          if (m.kind) ch.meta.kind = m.kind;
          if (m.family) ch.meta.family = m.family;
          ch.meta.known = !!m.known;
        }
        return;
      }
      if (m.e === 'err') {
        setStatus(m.addr ? m.addr + ' : ' + m.msg : m.msg, true);
        return;
      }
      if (m.e === 'set') {
        // Confirmation de forçage : le serveur fait autorité sur l'état forcé.
        if (m.ok) {
          if (m.value == null) forced.delete(m.addr);
          else forced.set(m.addr, m.value);
        }
        const w = pendingWrites.get(m.addr);
        if (w) { pendingWrites.delete(m.addr); w(m.ok ? { ok: true } : { ok: false, error: m.msg || 'refusé' }); }
        return;
      }
      if (m.e === 'd') {
        // Recalage d'horloge lissé (le réseau introduit de la gigue)
        const target = m.now - localSec();
        skew = haveSkew ? skew + (target - skew) * 0.1 : target;
        haveSkew = true;
        for (const addr in m.s) {
          const ch = chans.get(addr);
          if (!ch) continue;
          for (const [t, v] of m.s[addr]) {
            if (ch.ts.length && t <= ch.ts[ch.ts.length - 1]) continue;
            ch.ts.push(t); ch.vs.push(v);
          }
          trim(ch);
        }
      }
    }

    function connect() {
      return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let settled = false;
        try {
          ws = new WebSocket(proto + '//' + location.host + '/ws');
        } catch (e) { reject(e); return; }

        const timer = setTimeout(() => {
          if (!settled) { settled = true; try { ws.close(); } catch (e) { /* déjà fermé */ } reject(new Error('délai dépassé')); }
        }, 4000);

        onHello = () => {
          clearTimeout(timer);
          if (!settled) { settled = true; resolve(api); }
          else setStatus('Flux temps réel rétabli.');
        };
        ws.addEventListener('open', () => {
          retry = 0;
          // Réabonnement après reconnexion
          for (const [addr, ch] of chans) send({ c: 'sub', addr, periodMs: ch.periodMs });
        });
        ws.addEventListener('message', onMessage);
        ws.addEventListener('error', () => { /* traité par close */ });
        ws.addEventListener('close', () => {
          clearTimeout(timer);
          if (!settled) { settled = true; reject(new Error('connexion refusée')); return; }
          if (closed) return;
          setStatus('Flux temps réel interrompu — reconnexion…', true);
          const delay = Math.min(8000, 500 * Math.pow(2, retry++));
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => { connect().catch(() => {}); }, delay);
        });
      });
    }

    const api = {
      name: srcName,
      defaultPeriodMs: CFG.defaultPeriodMs,
      onStatus: null,
      now,
      connect,
      isLive: () => !!ws && ws.readyState === WebSocket.OPEN,

      subscribe(addr, opts) {
        const p = DW.parseAddr(addr);
        if (!p.ok) return null;
        const periodMs = Math.max(1, parseInt((opts && opts.periodMs) || api.defaultPeriodMs, 10) || api.defaultPeriodMs);
        let ch = chans.get(p.addr);
        if (ch) {
          ch.refs++;
          if (periodMs < ch.periodMs) { ch.periodMs = periodMs; send({ c: 'sub', addr: p.addr, periodMs }); }
          return ch;
        }
        // Métadonnées provisoires issues du catalogue local ; le serveur les
        // confirme (ou les corrige) par un message « meta ».
        const meta = DW.resolveMeta(p.addr, p);
        if (!meta) return null;
        ch = { meta, ts: [], vs: [], refs: 1, periodMs };
        chans.set(p.addr, ch);
        send({ c: 'sub', addr: p.addr, periodMs });
        return ch;
      },

      unsubscribe(addr) {
        const p = DW.parseAddr(addr);
        const key = p.ok ? p.addr : addr;
        const ch = chans.get(key);
        if (!ch) return;
        if (--ch.refs <= 0) {
          chans.delete(key);
          send({ c: 'unsub', addr: key });
        }
      },

      count: () => chans.size,

      /** Voir sim.js : retient l'historique d'une vue figée au-delà de l'horizon. */
      setHold(t) { holdT = (typeof t === 'number' && isFinite(t)) ? t : null; },

      latest(addr) {
        const ch = chans.get(addr);
        if (!ch || !ch.ts.length) return null;
        const i = ch.ts.length - 1;
        return { t: ch.ts[i], v: ch.vs[i] };
      },

      past(addr, delta) {
        const ch = chans.get(addr);
        if (!ch || !ch.ts.length) return null;
        const target = ch.ts[ch.ts.length - 1] - delta;
        for (let i = ch.ts.length - 1; i >= 0; i--) {
          if (ch.ts[i] <= target) return ch.vs[i];
        }
        return ch.vs[0];
      },

      data(addr) {
        const ch = chans.get(addr);
        return ch ? { ts: ch.ts, vs: ch.vs } : { ts: [], vs: [] };
      },

      meta(addr) {
        const ch = chans.get(addr);
        return ch ? ch.meta : DW.resolveMeta(addr);
      },

      /**
       * Demande au serveur de forcer (ou relâcher) une variable.
       * Les points réseau sont refusés côté serveur (lecture seule).
       * @returns {Promise<{ok, error?}>}
       */
      write(addr, value) {
        const p = DW.parseAddr(addr);
        if (!p.ok) return Promise.resolve({ ok: false, error: 'Adresse invalide : ' + addr });
        if (p.family === 'NET') {
          return Promise.resolve({ ok: false, error: 'Point réseau en lecture seule — forçage impossible.' });
        }
        // release en entier (1) : l'analyseur JSON léger du serveur ne lit
        // pas les booléens (voir server/src/json.hpp).
        const msg = value == null ? { c: 'set', addr: p.addr, release: 1 }
                                  : { c: 'set', addr: p.addr, value };
        if (!send(msg)) return Promise.resolve({ ok: false, error: 'Serveur de diagnostic injoignable.' });
        return new Promise((resolve) => {
          const prev = pendingWrites.get(p.addr);
          if (prev) prev({ ok: false, error: 'remplacé par une nouvelle demande' });
          const timer = setTimeout(() => {
            if (pendingWrites.get(p.addr) === wrap) {
              pendingWrites.delete(p.addr);
              resolve({ ok: false, error: 'pas de confirmation du serveur (délai dépassé)' });
            }
          }, 3000);
          const wrap = (res) => { clearTimeout(timer); resolve(res); };
          pendingWrites.set(p.addr, wrap);
        });
      },
      forced(addr) {
        const p = DW.parseAddr(addr);
        const key = p.ok ? p.addr : addr;
        return forced.has(key) ? forced.get(key) : null;
      },

      close() {
        closed = true;
        clearTimeout(retryTimer);
        if (ws) try { ws.close(); } catch (e) { /* déjà fermé */ }
      },
    };

    return api;
  }

  DW.sources.ws = createWsSource();
})();
