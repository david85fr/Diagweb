/* Diagweb — déplacement de widgets entre onglets et entre fenêtres.
 *
 * Un « widget » est un graphique, le tableau numérique, ou une variable
 * isolée, transporté **avec sa configuration**. Trois chemins :
 *
 *  1. glisser-déposer HTML5 : vers un onglet de l'application, vers la zone
 *     de contenu, ou vers une **autre fenêtre du navigateur** (multi-écran) ;
 *  2. menu « Déplacer vers » (indispensable au tact, le glisser-déposer
 *     HTML5 n'existant pas sur écran tactile) ;
 *  3. « Ouvrir dans une nouvelle fenêtre » (transfert via le stockage local).
 *
 * Sémantique de déplacement sûre : la source ne retire son widget qu'après
 * l'accusé de réception de la cible (BroadcastChannel, même origine). Sans
 * accusé — autre navigateur, page ouverte en fichier local — le widget est
 * simplement copié : jamais de perte.
 */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  const MIME = 'application/x-diagweb-widget+json';
  const ACK_MS = 2500;
  const winId = 'w' + Math.random().toString(36).slice(2, 10);

  let api = null;                 // fourni par app.js (voir attach)
  const pending = new Map();      // dragId -> {onMoved, timer}
  let dragging = null;            // charge utile en cours d'émission
  let bc = null;
  try { bc = new BroadcastChannel('diagweb.widgets'); } catch (e) { bc = null; }

  if (bc) {
    bc.addEventListener('message', (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.type === 'widget-accepted') completeMove(m.dragId);
      // Un nom d'affichage appartient à la variable : il vaut dans toutes les
      // fenêtres ouvertes sur le même contrôleur, pas seulement celle où il a
      // été saisi (organisation multi-écran).
      else if (m.type === 'variable-renamed' && m.origin !== winId && api && api.applyRename) {
        api.applyRename(m.addr, m.name);
      }
      // L'apparence appartient à l'installation : elle vaut pour toutes les
      // fenêtres ouvertes sur le même contrôleur, sans attendre un rechargement.
      else if (m.type === 'appearance' && m.origin !== winId &&
               DW.appearance && DW.appearance.recevoir) {
        DW.appearance.recevoir(m.value);
      }
    });
  }

  /** Annonce un renommage aux autres fenêtres de la même origine. */
  function shareRename(addr, name) {
    if (bc) bc.postMessage({ type: 'variable-renamed', origin: winId, addr, name });
  }

  /** Annonce un changement d'apparence aux autres fenêtres. */
  function shareAppearance(value) {
    if (bc) bc.postMessage({ type: 'appearance', origin: winId, value });
  }

  function envelope(payload, dragId) {
    return JSON.stringify({
      app: 'diagweb-widget', version: 1,
      dragId, origin: winId,
      kind: payload.kind,
      chartId: payload.chartId,
      tabId: payload.tabId,
      tableId: payload.tableId,
      chart: payload.chart,
      table: payload.table,
      title: payload.title,
      // Taille de la tuile : elle voyage avec elle, pour que le rectangle
      // d'atterrissage montre la vraie place prise, ici comme dans une autre
      // fenêtre.
      w: payload.w, h: payload.h,
    });
  }

  function parseEnvelope(text) {
    try {
      const o = JSON.parse(text);
      if (!o || o.app !== 'diagweb-widget' || !o.kind) return null;
      return o;
    } catch (e) { return null; }
  }

  /** Description courte, pour les messages. */
  function describe(o) {
    if (o.kind === 'chart') return '« ' + ((o.chart && o.chart.title) || 'Graphique') + ' »';
    if (o.kind === 'table') return 'le tableau numérique (' + ((o.table && o.table.length) || 0) + ' variables)';
    const n = (o.table && o.table.length) || 0;
    return n === 1 ? o.table[0].addr : n + ' variables';
  }

  // ------------------------------------------------------------- émission
  /**
   * À appeler depuis un gestionnaire `dragstart`.
   * @param payload {kind:'chart'|'table'|'vars', chart?, table?}
   * @param onMoved fonction appelée si la cible accepte (déplacement)
   */
  function startDrag(e, payload, onMoved) {
    const dragId = 'd' + Math.random().toString(36).slice(2, 10);
    // Où la tuile a-t-elle été saisie ? Sans ce décalage, elle sauterait sous
    // le curseur au lieu de suivre la main.
    const carte = e.target.closest && e.target.closest('.chart-card, .table-card');
    const r = carte && carte.getBoundingClientRect();
    // Un dragstart synthétique (test) n'a pas de coordonnées : sans garde, le
    // décalage vaudrait NaN et le point de chute partirait à l'infini.
    const off = (r && isFinite(e.clientX) && isFinite(e.clientY))
      ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
    const text = envelope(payload, dragId);
    try {
      e.dataTransfer.setData(MIME, text);
      e.dataTransfer.setData('text/plain', text);   // repli inter-fenêtres
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch (err) { return; }
    dragging = { dragId, onMoved, payload, off };
    // L'attente de l'accusé est armée dès maintenant : entre deux fenêtres,
    // la cible traite le dépôt AVANT que « dragend » ne survienne ici.
    const timer = setTimeout(() => pending.delete(dragId), ACK_MS);
    pending.set(dragId, { onMoved, timer });
    document.body.classList.add('dnd-active');
  }

  /** Consomme l'attente d'un déplacement et exécute le retrait. */
  function completeMove(dragId) {
    const p = pending.get(dragId);
    if (!p) return false;
    clearTimeout(p.timer);
    pending.delete(dragId);
    p.onMoved();
    return true;
  }

  function endDrag() {
    document.body.classList.remove('dnd-active');
    clearHighlight();
    dragging = null;
    // Les attentes non honorées expirent d'elles-mêmes : sans accusé de
    // réception, le widget reste en place (copie plutôt que perte).
  }

  // -------------------------------------------------------------- réception
  function clearHighlight() {
    document.querySelectorAll('.tab.dnd-over').forEach((el) => el.classList.remove('dnd-over'));
    if (DW.mosaic) DW.mosaic.fantomeOff();
    document.body.classList.remove('dnd-over-pane');
  }

  /**
   * Point de chute visé : la CELLULE de la mosaïque sous le curseur. C'est ce
   * qui rend le placement libre — la tuile se pose là où on la lâche, elle ne
   * s'insère plus « avant » ou « après » une autre.
   *
   * Le décalage saisi au départ (où l'on a pris la tuile) est retranché : on
   * pose le coin haut-gauche de la tuile, pas le curseur.
   */
  function placeAt(e) {
    const grid = e.target.closest && e.target.closest('.charts-grid');
    if (!grid || !DW.mosaic || !DW.mosaic.actif()) return null;
    const off = (dragging && dragging.off) || { x: 0, y: 0 };
    const cell = DW.mosaic.cellule(grid, e.clientX - off.x, e.clientY - off.y, 'proche');
    const card = e.target.closest('.chart-card, .table-card');
    return { grid, cell, overEl: card || null };
  }

  /**
   * Taille de la tuile en cours de déplacement. Venue d'une AUTRE fenêtre, la
   * charge utile n'est pas lisible pendant le survol (le navigateur ne la
   * livre qu'au dépôt) : on montre alors la taille de départ de cette nature
   * de tuile, ce qui reste honnête sur la place qu'elle prendra.
   */
  function tailleTuile() {
    const p = dragging && dragging.payload;
    const d = DW.mosaic.defaut(p && p.kind === 'table' ? 'table' : 'chart');
    return { w: (p && p.w) || d.w, h: (p && p.h) || d.h };
  }

  function hasWidget(dt) {
    if (!dt || !dt.types) return false;
    for (const t of dt.types) if (t === MIME || t === 'text/plain') return true;
    return false;
  }

  function onDragOver(e) {
    if (!api || !hasWidget(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearHighlight();
    const tabEl = e.target.closest && e.target.closest('.tab');
    if (tabEl) { tabEl.classList.add('dnd-over'); return; }
    const place = placeAt(e);
    if (place) {
      // Rectangle d'atterrissage : la place EXACTE que prendra la tuile.
      const t = tailleTuile();
      DW.mosaic.fantome(place.grid,
        { x: Math.min(place.cell.x, DW.mosaic.COLS - t.w), y: place.cell.y, w: t.w, h: t.h });
    } else {
      document.body.classList.add('dnd-over-pane');
    }
  }

  function onDrop(e) {
    if (!api) return;
    const dt = e.dataTransfer;
    if (!hasWidget(dt)) return;
    e.preventDefault();
    clearHighlight();
    document.body.classList.remove('dnd-active');

    const text = dt.getData(MIME) || dt.getData('text/plain');
    const o = parseEnvelope(text);
    if (!o) return;

    const tabEl = e.target.closest && e.target.closest('.tab');
    const targetTab = tabEl ? api.tabFromElement(tabEl) : api.activeTab();
    if (!targetTab) return;
    const place = tabEl ? null : placeAt(e);

    // Dépôt au point de départ : rien à faire
    if (o.origin === winId && dragging && !place &&
        api.isSameTarget(targetTab, dragging.payload)) {
      dragging = null;
      return;
    }

    // 'reordered' : la cible a simplement rangé le widget déjà présent —
    // la source ne doit surtout pas le retirer.
    const ok = api.receive(o, targetTab, place, o.origin === winId);
    if (ok === 'reordered') {
      const p = pending.get(o.dragId);
      if (p) { clearTimeout(p.timer); pending.delete(o.dragId); }
      dragging = null;
      return;
    }
    if (!ok) return;

    if (o.origin === winId) {
      // Même fenêtre : le déplacement est immédiat
      dragging = null;
      completeMove(o.dragId);
    } else if (bc) {
      bc.postMessage({ type: 'widget-accepted', dragId: o.dragId });
    } else {
      api.toast('Copié depuis une autre fenêtre (déplacement impossible ici).');
    }
  }

  // ---------------------------------------- ouverture dans une autre fenêtre
  function openInNewWindow(payload, onMoved) {
    const id = DW.store && DW.store.putTransfer(payload);
    if (!id) { api && api.toast('Stockage indisponible : transfert impossible.', 'err'); return; }
    const url = location.pathname + '?open=' + encodeURIComponent(id);
    const w = window.open(url, '_blank');
    if (!w) {
      DW.store.takeTransfer(id);
      api && api.toast('Fenêtre bloquée par le navigateur — autorisez les fenêtres surgissantes.', 'err');
      return;
    }
    if (onMoved) onMoved();
  }

  /** Au démarrage : récupère le widget transféré par ?open=<id>. */
  function consumeOpenParam() {
    let id = null;
    try { id = new URLSearchParams(location.search).get('open'); } catch (e) { return null; }
    if (!id) return null;
    const payload = DW.store && DW.store.takeTransfer(id);
    // L'adresse est nettoyée pour qu'un rechargement ne rejoue pas le transfert
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* ignoré */ }
    return payload || null;
  }

  DW.dnd = {
    winId,
    startDrag,
    endDrag,
    shareRename,
    shareAppearance,
    openInNewWindow,
    consumeOpenParam,
    describe,
    /** app.js fournit ici l'accès à l'espace de travail. */
    attach(a) {
      api = a;
      document.addEventListener('dragover', onDragOver);
      document.addEventListener('drop', onDrop);
      document.addEventListener('dragend', endDrag);
      document.addEventListener('dragleave', (e) => {
        if (e.relatedTarget === null) clearHighlight();
      });
    },
  };
})();
