/* Diagweb — choix de la source de données.
 *
 * Par défaut (« auto ») : si la page est servie par le serveur de diagnostic
 * du contrôleur, on utilise son flux temps réel ; sinon on retombe sur la
 * simulation locale. Forçage possible par l'URL : ?src=ws ou ?src=sim.
 *
 * DW.sourceReady est attendue par app.js avant de construire l'interface,
 * pour que les premiers abonnements partent sur la bonne source.
 */
(function () {
  "use strict";
  const DW = window.DW;

  function wanted() {
    try {
      const v = new URLSearchParams(location.search).get('src');
      return v === 'ws' || v === 'sim' ? v : 'auto';
    } catch (e) {
      return 'auto';
    }
  }

  /** Le serveur de diagnostic répond-il ? (court, pour ne pas retarder le démarrage) */
  async function probe() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1200);
    try {
      // Chemin absolu : la page peut être servie depuis /web/ en développement
      // comme depuis la racine sur le contrôleur (cf. store.js).
      const r = await fetch('/api/health', { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json();
      return j && j.role === 'diag-server';
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  DW.sourceReady = (async () => {
    const want = wanted();
    const httpish = location.protocol === 'http:' || location.protocol === 'https:';
    DW.sourceMode = 'sim';

    if (want !== 'sim' && httpish && typeof WebSocket !== 'undefined') {
      const available = want === 'ws' ? true : await probe();
      if (available) {
        try {
          await DW.sources.ws.connect();
          DW.source = DW.sources.ws;
          DW.sourceMode = 'ws';
          return DW.source;
        } catch (e) {
          DW.sourceFallbackReason = e && e.message ? e.message : 'connexion impossible';
        }
      }
    }
    DW.source = DW.sources.sim;
    return DW.source;
  })();
})();
