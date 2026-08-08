/* Diagweb — persistance des dispositions.
 *
 * Trois destinations :
 *  - navigateur (localStorage) : liste nommée + chargement auto,
 *  - fichier .json : export / import pour partage,
 *  - contrôleur : PUT /api/layouts/<nom> — stub tant que le back-end
 *    n'existe pas (voir docs/SPECS.md §6).
 */
(function () {
  "use strict";
  const DW = window.DW;

  const KEY_LAYOUTS = 'diagweb.layouts.v1';
  const KEY_SESSION = 'diagweb.session.v1';
  const KEY_AUTO = 'diagweb.autoload.v1';

  const KEY_TRANSFER = 'diagweb.transfer.';
  const TRANSFER_TTL_MS = 120000;

  let available = true;
  function lsGet(key) {
    try { return window.localStorage.getItem(key); }
    catch (e) { available = false; return null; }
  }
  function lsSet(key, val) {
    try { window.localStorage.setItem(key, val); return true; }
    catch (e) { available = false; return false; }
  }
  function lsDel(key) {
    try { window.localStorage.removeItem(key); } catch (e) { available = false; }
  }

  // La session est propre à chaque onglet/fenêtre du navigateur : plusieurs
  // fenêtres peuvent afficher des espaces de travail différents (multi-écran)
  // sans se marcher dessus. Les configurations nommées, elles, restent
  // partagées (localStorage).
  function ssGet(key) {
    try { return window.sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function ssSet(key, val) {
    try { window.sessionStorage.setItem(key, val); return true; } catch (e) { return false; }
  }
  function ssDel(key) {
    try { window.sessionStorage.removeItem(key); } catch (e) { /* indisponible */ }
  }

  function readLayouts() {
    const raw = lsGet(KEY_LAYOUTS);
    if (!raw) return {};
    try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : {}; }
    catch (e) { return {}; }
  }
  function writeLayouts(obj) { return lsSet(KEY_LAYOUTS, JSON.stringify(obj)); }

  function validateLayout(data) {
    if (!data || typeof data !== 'object') return 'structure absente';
    if (!Array.isArray(data.charts)) return 'liste de graphiques absente';
    if (!Array.isArray(data.table)) return 'liste du tableau absente';
    for (const c of data.charts) {
      if (!Array.isArray(c.series)) return 'graphique sans liste de courbes';
    }
    return null;
  }

  DW.store = {
    get available() { return available; },

    // ---- Dispositions nommées (navigateur) --------------------------
    list() {
      const all = readLayouts();
      return Object.values(all).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    },
    get(name) { return readLayouts()[name] || null; },
    save(name, data) {
      const all = readLayouts();
      all[name] = { name, savedAt: Date.now(), data };
      return writeLayouts(all);
    },
    remove(name) {
      const all = readLayouts();
      delete all[name];
      writeLayouts(all);
      if (this.getAutoload() === name) this.setAutoload(null);
    },
    getAutoload() { return lsGet(KEY_AUTO) || null; },
    setAutoload(name) { name ? lsSet(KEY_AUTO, name) : lsDel(KEY_AUTO); },

    // ---- Session courante (restaurée au rechargement) ---------------
    // v2 : {version:2, active, tabs:[{name, log, data:<config v1>}]} ;
    // v1 (une seule configuration) accepté en rétro-compatibilité.
    saveSession(data) { ssSet(KEY_SESSION, JSON.stringify(data)); },
    loadSession() {
      let raw = ssGet(KEY_SESSION);
      if (!raw) {
        // Reprise unique de l'ancienne session partagée (avant le passage au
        // stockage par fenêtre) : elle est consommée puis effacée.
        raw = lsGet(KEY_SESSION);
        if (raw) lsDel(KEY_SESSION);
      }
      if (!raw) return null;
      try {
        const d = JSON.parse(raw);
        if (d && d.version === 2 && Array.isArray(d.tabs)) {
          d.tabs = d.tabs.filter((t) => t && !validateLayout(t.data));
          return d.tabs.length ? d : null;
        }
        return validateLayout(d) ? null : d;
      } catch (e) { return null; }
    },
    clearSession() { ssDel(KEY_SESSION); },

    // ---- Transferts entre fenêtres (glisser-déposer, nouvelle fenêtre) ----
    /** Dépose une charge utile et renvoie son identifiant de reprise. */
    putTransfer(payload) {
      const id = 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      this.purgeTransfers();
      return lsSet(KEY_TRANSFER + id, JSON.stringify({ at: Date.now(), payload })) ? id : null;
    },
    /** Récupère et consomme une charge utile. */
    takeTransfer(id) {
      if (!id) return null;
      const raw = lsGet(KEY_TRANSFER + id);
      lsDel(KEY_TRANSFER + id);
      if (!raw) return null;
      try {
        const o = JSON.parse(raw);
        return o && Date.now() - o.at < TRANSFER_TTL_MS ? o.payload : null;
      } catch (e) { return null; }
    },
    /** Nettoie les transferts abandonnés (fenêtre jamais ouverte). */
    purgeTransfers() {
      try {
        const now = Date.now();
        for (let i = window.localStorage.length - 1; i >= 0; i--) {
          const k = window.localStorage.key(i);
          if (!k || k.indexOf(KEY_TRANSFER) !== 0) continue;
          try {
            const o = JSON.parse(window.localStorage.getItem(k));
            if (!o || now - o.at > TRANSFER_TTL_MS) window.localStorage.removeItem(k);
          } catch (e) { window.localStorage.removeItem(k); }
        }
      } catch (e) { /* stockage indisponible */ }
    },

    // ---- Export / import fichier ------------------------------------
    exportText(name, data) {
      return JSON.stringify({ app: 'diagweb', version: 1, name, exportedAt: new Date().toISOString(), data }, null, 2);
    },
    /** Téléchargement générique. ext ex. 'diagweb.json' | 'csv'. */
    download(name, text, ext, mime) {
      try {
        const blob = new Blob([text], { type: mime || 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (name || 'diagweb').replace(/[^\wÀ-ſ -]+/g, '_') + '.' + (ext || 'diagweb.json');
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        return true;
      } catch (e) { return false; }
    },

    // ---- Exports CSV (séparateur « ; », compatible tableurs FR) ------
    csvField(v) {
      const s = String(v == null ? '' : v);
      return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    },
    /** CSV d'une configuration (liste des variables + agencement). */
    configCsv(data) {
      const F = this.csvField;
      const L = ['emplacement;graphique;fenetre_s;adresse;periode_ms;echelle;visible;decalage'];
      for (const e of data.table || []) {
        const addr = typeof e === 'string' ? e : e.addr;
        const p = (typeof e === 'object' && e.periodMs) || 10;
        L.push(['tableau', '', '', F(addr), p, '', '', ''].join(';'));
      }
      for (const c of data.charts || []) {
        for (const s of c.series || []) {
          L.push(['graphique', F(c.title || ''), c.windowS || '', F(s.addr),
            s.periodMs || 10, s.axisMode === 'solo' ? 'dediee' : 'auto',
            s.visible === false ? 0 : 1, s.offsetY || ''].join(';'));
        }
      }
      return L.join('\r\n') + '\r\n';
    },
    /** CSV d'un journal de données [t, addr, v]. */
    logCsv(rows) {
      const F = this.csvField;
      const wall0 = Date.now() - (DW.source ? DW.source.now() * 1000 : 0);
      const L = ['horodatage_iso;t_s;adresse;valeur'];
      for (const r of rows) {
        L.push(new Date(wall0 + r[0] * 1000).toISOString() + ';' +
          r[0].toFixed(3) + ';' + F(r[1]) + ';' + r[2]);
      }
      return L.join('\r\n') + '\r\n';
    },
    parseImport(text) {
      let o;
      try { o = JSON.parse(text); }
      catch (e) { return { ok: false, error: 'Fichier illisible : JSON invalide.' }; }
      const data = o && o.app === 'diagweb' ? o.data : o;
      const err = validateLayout(data);
      if (err) return { ok: false, error: 'Ce fichier ne contient pas une disposition Diagweb (' + err + ').' };
      return { ok: true, name: (o && o.name) || 'Import', data };
    },

    // ---- Contrôleur (back-end à venir) ------------------------------
    async saveToController(name, data) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      try {
        const r = await fetch('/api/layouts/' + encodeURIComponent(name), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, data }),
          signal: ctl.signal,
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return true;
      } finally { clearTimeout(timer); }
    },
    async listFromController() {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      try {
        const r = await fetch('/api/layouts', { signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } finally { clearTimeout(timer); }
    },
  };
})();
