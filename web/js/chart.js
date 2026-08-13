/* Diagweb — moteur de graphiques temps réel (canvas).
 *
 * Multi-échelles : courbes regroupées par unité (ou isolées via « échelle
 * dédiée ») ; chaque groupe possède son axe Y, tracé en alternance
 * gauche/droite, coloré comme sa courbe quand il n'en porte qu'une.
 *
 * Échelles : automatiques et stabilisées (extension immédiate, rétraction
 * différée de 2 s, transitions lissées) ou manuelles (🔒) après un geste
 * sur la règle de l'axe. Retour auto : double-appui sur la règle ou menu ⋮.
 *
 * Gestes — par zone, prévisibles :
 *   tracé   : glisser ↔ = historique · glisser ↕ = déplacer l'échelle
 *             principale · pincement / molette = zoom temporel · appui
 *             bref = curseur épinglé · double-appui = retour Direct ;
 *   règle   : glisser = déplacer cette échelle · molette = zoomer cette
 *             échelle · double-appui = re-automatique ;
 *   légende : menu par courbe (masquer, échelle dédiée, décaler, retirer).
 * Décalage d'une courbe : mode explicite (bandeau) via le menu de sa
 * pastille — glisser verticalement, terminer par OK.
 */
(function () {
  "use strict";
  const DW = window.DW;
  const CFG = DW.CONFIG;

  const MIN_WINDOW_S = 2;
  const MAX_WINDOW_S = 300;
  const SHRINK_DELAY_S = 2;      // hystérésis de rétraction des échelles
  const SHRINK_OCCUPANCY = 0.55; // rétraction si les données occupent < 55 %
  const HEIGHT_MODES = ['M', 'L', 'XL'];
  // Dimensionnement libre à la poignée (bureau uniquement — voir app.css :
  // sous le point de rupture mobile la grille reste en une colonne).
  const MIN_CUSTOM_H = 150;
  const MAX_CUSTOM_H = 2000;
  const MAX_COL_SPAN = 6;

  function sanitizeH(h) {
    h = parseInt(h, 10);
    if (!isFinite(h) || h <= 0) return null;
    return clamp(h, MIN_CUSTOM_H, MAX_CUSTOM_H);
  }
  function sanitizeSpan(n) {
    n = parseInt(n, 10);
    if (!isFinite(n) || n <= 1) return null;
    return clamp(n, 2, MAX_COL_SPAN);
  }

  // ---------- Formatage ------------------------------------------------
  DW.fmtVal = function (v, meta) {
    if (v == null || !isFinite(v)) return '—';
    if (meta && meta.kind === 'bit') return v >= 0.5 ? '1' : '0';
    if (meta && meta.kind === 'word') return String(Math.round(v));
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    if (a === 0) return '0';
    return v.toFixed(3);
  };
  DW.fmtTick = function (v) {
    const a = Math.abs(v);
    if (a >= 100000) return Math.round(v / 1000) + 'k';
    if (a >= 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (a >= 100) return String(Math.round(v));
    if (a >= 10) return String(Math.round(v * 10) / 10);
    if (a >= 1) return String(Math.round(v * 100) / 100);
    if (a === 0) return '0';
    return String(Math.round(v * 1000) / 1000);
  };
  function fmtAxisTick(v, step) {
    if (Math.abs(v) >= 10000) {
      const kStep = step / 1000;
      const dec = Math.max(0, -Math.floor(Math.log10(Math.max(kStep, 1e-12))));
      return (v / 1000).toFixed(Math.min(dec, 4)) + 'k';
    }
    const dec = step >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(Math.max(step, 1e-12))));
    return v.toFixed(Math.min(dec, 6));
  }
  function fmtTimeTick(negS, windowS) {
    if (Math.abs(negS) < 1e-9) return '0';
    const a = Math.abs(negS);
    if (windowS <= 90) return '-' + (a < 10 && a % 1 ? a.toFixed(1) : Math.round(a)) + ' s';
    const m = Math.floor(a / 60), s = Math.round(a % 60);
    return '-' + m + ':' + String(s).padStart(2, '0');
  }
  function fmtWindow(w) {
    if (w < 60) return (w < 10 && w % 1 ? w.toFixed(1) : Math.round(w)) + ' s';
    const m = Math.floor(w / 60), s = Math.round(w % 60);
    return s ? m + ':' + String(s).padStart(2, '0') : m + ' min';
  }
  function niceStep(rough) {
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const f = rough / pow;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
  }
  const TIME_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  function niceTimeStep(rough) {
    for (const s of TIME_STEPS) if (s >= rough) return s;
    return 300;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** Couleur d'une courbe : teinte personnalisée si l'utilisateur en a choisi
   *  une, sinon l'emplacement de palette (qui, lui, suit le thème). */
  function colorOf(s) { return s.color || DW.seriesColor(s.colorIdx); }
  DW.seriesColorOf = colorOf;

  /** Garantit une plage exploitable : span plancher relatif (anti-gel au
   *  zoom extrême et données quasi constantes en arithmétique flottante). */
  function sanitizeRange(min, max) {
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    const scale = Math.max(Math.abs(min), Math.abs(max), 1e-12);
    const minSpan = Math.max(1e-9, scale * 1e-6);
    if (!(max - min >= minSpan)) {
      const c = (min + max) / 2;
      min = c - minSpan / 2;
      max = c + minSpan / 2;
    }
    return { min, max };
  }

  // ---------- Encre du thème (lue depuis les variables CSS) -----------
  let inkCache = null;
  DW.invalidateChartTheme = function () { inkCache = null; };
  function ink() {
    if (inkCache) return inkCache;
    const cs = getComputedStyle(document.documentElement);
    const get = (n, fb) => (cs.getPropertyValue(n) || fb).trim();
    inkCache = {
      ink: get('--ink', '#e6edf5'),
      muted: get('--muted', '#8494a8'),
      faint: get('--faint', '#5b6a7e'),
      line: get('--line', '#26303f'),
      panel: get('--panel', '#141a24'),
      accent: get('--accent', '#2dd4bf'),
    };
    return inkCache;
  }

  const MAX_AXES = 4;

  // ---------- Popover partagé (légende & menu ⋮) ----------------------
  let popEl = null, popOwner = null, popAnchor = null;
  // Bascule : un appui sur l'ancre du menu ouvert le ferme sans le rouvrir.
  // N'est armé QUE par cet appui — fermer en choisissant une entrée ne doit
  // pas empêcher de rouvrir le menu juste après.
  let suppressOwner = null, suppressAt = 0;
  let popClosedPointer = -1;   // pointeur ayant fermé un popover (à consommer)
  function closePopover() {
    if (popEl) {
      popEl.remove();
      popEl = null;
      popOwner = null;
      popAnchor = null;
    }
  }
  document.addEventListener('pointerdown', (e) => {
    if (popEl && !popEl.contains(e.target)) {
      const onAnchor = popAnchor && popAnchor.contains(e.target);
      const owner = popOwner;
      closePopover();
      if (onAnchor) { suppressOwner = owner; suppressAt = performance.now(); }
      // Le tap qui ferme un menu ne doit pas démarrer un geste sur le canvas
      else popClosedPointer = e.pointerId;
    }
  }, true);
  // Le marqueur ne vaut que pour l'interaction en cours : la souris réutilise
  // toujours le même pointerId, il ne doit pas contaminer le geste suivant.
  const clearPopClose = () => { popClosedPointer = -1; };
  document.addEventListener('pointerup', clearPopClose, true);
  document.addEventListener('pointercancel', clearPopClose, true);
  /** À appeler au pointerdown du canvas : vrai si ce pointeur vient de fermer un menu. */
  function consumePopClose(pointerId) {
    if (popClosedPointer === pointerId) { popClosedPointer = -1; return true; }
    return false;
  }
  function openPopover(owner, anchorEl, build) {
    // Re-cliquer l'ancre du menu qui vient d'être fermé = bascule (rester fermé)
    if (suppressOwner === owner && performance.now() - suppressAt < 500) {
      suppressOwner = null;
      return;
    }
    suppressOwner = null;
    closePopover();
    popOwner = owner;
    popAnchor = anchorEl;
    popEl = document.createElement('div');
    popEl.className = 'popmenu';
    build((label, fn, cls, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = label;
      if (cls) b.classList.add(cls);
      if (title) b.title = title;
      b.addEventListener('click', () => { closePopover(); fn(); });
      popEl.appendChild(b);
      return b;
    }, (node) => { popEl.appendChild(node); return node; });
    document.body.appendChild(popEl);
    const r = anchorEl.getBoundingClientRect();
    const pw = popEl.offsetWidth;
    const mh = popEl.offsetHeight;
    popEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + 'px';
    // Sous l'ancre si la place le permet, sinon au-dessus (jamais hors écran)
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    popEl.style.top = (top + window.scrollY) + 'px';
  }

  // ---------- Classe Chart --------------------------------------------
  let uid = 0;

  class Chart {
    /**
     * @param app  { acquire(addr, periodMs), release(addr), onChange(),
     *               toast(msg), removeChart(chart), refreshTargets() }
     */
    constructor(app, opts) {
      opts = opts || {};
      this.app = app;
      this.id = 'c' + (++uid);
      this.windowS = clamp(opts.windowS || CFG.defaultWindowS, MIN_WINDOW_S, MAX_WINDOW_S);
      this.viewEnd = null;         // null = direct ; sinon temps absolu figé
      this.pinT = null;            // curseur épinglé (temps absolu)
      this.cursor = null;          // curseur transitoire {x} (survol souris)
      this.series = [];            // {addr, meta, colorIdx, axisMode, visible, periodMs, offsetY}
      this.heightMode = HEIGHT_MODES.includes(opts.heightMode) ? opts.heightMode : 'M';
      this.customH = sanitizeH(opts.customH);      // hauteur libre (px), null = préréglage
      this.colSpan = sanitizeSpan(opts.colSpan);   // largeur en colonnes de grille, null = auto
      this.fullscreen = false;
      this.moveSeries = null;      // adresse en cours de décalage (mode explicite)
      this.axisState = new Map();  // clé de groupe -> état d'échelle
      this._cw = 0; this._ch = 0; this._dpr = 0;
      this._ptrs = new Map();
      this._gesture = null;
      this._plot = null;
      this._bands = [];            // zones des règles d'axes (hit-test)
      this._yFns = {};
      this._lastTap = 0; this._lastTapX = 0; this._lastTapBand = null;

      this.root = document.createElement('section');
      this.root.className = 'card chart-card';
      this.root.innerHTML =
        '<header class="chart-head">' +
          '<span class="drag-handle" draggable="true" ' +
            'title="Glisser ce graphique (avec sa configuration) vers un onglet, une autre fenêtre, ' +
            'ou sur un autre graphique pour le ranger">⠿</span>' +
          '<input class="chart-title" maxlength="48" aria-label="Titre du graphique" ' +
            'title="Nom du graphique — cliquez pour le modifier ; il sert aussi de destination d’ajout">' +
          '<div class="chart-tools">' +
            '<select class="chart-window" aria-label="Fenêtre de temps" ' +
              'title="Durée affichée — modifiable aussi par pincement ou molette sur le tracé"></select>' +
            '<button class="iconbtn chart-pause" type="button" ' +
              'title="Figer ce graphique sur l’instant courant, ou revenir au temps réel">⏸</button>' +
            '<button class="iconbtn chart-more" type="button" ' +
              'title="Options : dupliquer, échelles automatiques, taille, plein écran, déplacer, fermer">⋮</button>' +
          '</div>' +
        '</header>' +
        '<div class="chart-body">' +
          '<canvas aria-label="Courbes du graphique" ' +
            'title="Glisser ↔ : remonter le temps · glisser ↕ : déplacer l’échelle · ' +
            'pincer ou molette : zoom · appui bref : curseur de mesure · double-appui : retour au direct. ' +
            'Sur une règle d’axe (curseur ↕ sur les bords) : clic pour saisir les bornes exactes ' +
            '— une échelle ou toutes — glisser ou molette pour la régler à la volée, ' +
            'double-clic pour revenir à l’automatique."></canvas>' +
          '<div class="chart-tip hide"></div>' +
          '<button class="chart-live hide" type="button" ' +
            'title="Revenir au temps réel (la vue est figée dans l’historique)">▶ Direct</button>' +
          '<div class="chart-move hide"><span class="mv-txt"></span>' +
            '<button class="btn sm" type="button" title="Terminer le décalage de cette courbe">OK</button></div>' +
          '<div class="chart-hint">Ajoutez une variable via la barre de recherche, cible « ' +
            '<b class="hint-name"></b> ».</div>' +
        '</div>' +
        '<div class="chart-legend" role="list"></div>' +
        '<span class="resize-grip" role="separator" aria-label="Redimensionner le graphique" ' +
          'title="Glisser pour redimensionner ce graphique : ↕ hauteur libre, ↔ largeur en nombre ' +
          'de colonnes de la grille — double-clic pour revenir à la taille automatique"></span>';

      this.titleEl = this.root.querySelector('.chart-title');
      this.titleEl.value = opts.title || 'Graphique';
      this.canvas = this.root.querySelector('canvas');
      this.ctx = this.canvas.getContext('2d');
      this.tipEl = this.root.querySelector('.chart-tip');
      this.hintEl = this.root.querySelector('.chart-hint');
      this.legendEl = this.root.querySelector('.chart-legend');
      this.winSel = this.root.querySelector('.chart-window');
      this.pauseBtn = this.root.querySelector('.chart-pause');
      this.liveBtn = this.root.querySelector('.chart-live');
      this.moveEl = this.root.querySelector('.chart-move');
      this._customOpt = null;

      for (const w of CFG.windows) {
        const o = document.createElement('option');
        o.value = w;
        o.textContent = w < 60 ? w + ' s' : (w / 60) + ' min';
        this.winSel.appendChild(o);
      }
      this.syncWinSel();
      this.applyHeightMode();

      this.root.querySelector('.hint-name').textContent = this.titleEl.value;

      this.titleEl.addEventListener('change', () => {
        this.root.querySelector('.hint-name').textContent = this.title;
        app.onChange();
        app.refreshTargets();
      });
      this.winSel.addEventListener('change', () => {
        const v = parseFloat(this.winSel.value);
        if (isFinite(v)) { this.windowS = v; this.syncWinSel(); app.onChange(); }
      });
      this.pauseBtn.addEventListener('click', () => this.setPaused(this.viewEnd === null));
      this.liveBtn.addEventListener('click', () => this.goLive());
      this.root.querySelector('.chart-more').addEventListener('click', (e) =>
        this.openChartMenu(e.currentTarget));
      this.moveEl.querySelector('button').addEventListener('click', () => this.endMoveMode());

      // Glisser le graphique (avec sa configuration) vers un autre onglet
      // ou une autre fenêtre du navigateur.
      const handle = this.root.querySelector('.drag-handle');
      handle.addEventListener('dragstart', (e) => {
        if (!DW.dnd) return;
        e.dataTransfer.setDragImage(this.root, 40, 20);
        DW.dnd.startDrag(e, { kind: 'chart', chartId: this.id, chart: this.serialize() },
          () => this.app.removeChart(this));
      });

      this._escHandler = (e) => { if (e.key === 'Escape' && this.fullscreen) this.setFullscreen(false); };
      document.addEventListener('keydown', this._escHandler);
      // La largeur voulue est mémorisée ; l'appliquée suit la place disponible.
      this._resizeHandler = () => { if (this.colSpan != null) this.applyHeightMode(); };
      window.addEventListener('resize', this._resizeHandler);

      this.bindCanvasGestures();
      this.bindResizeGrip();
    }

    get title() { return this.titleEl.value.trim() || 'Graphique'; }
    get paused() { return this.viewEnd !== null; }

    // ---------- Direct / figé ------------------------------------------
    setPaused(p) {
      this.viewEnd = p ? DW.source.now() : null;
      this.syncPauseUi();
    }
    goLive() {
      this.viewEnd = null;
      this.syncPauseUi();
    }
    syncPauseUi() {
      const frozen = this.viewEnd !== null;
      this.pauseBtn.textContent = frozen ? '▶' : '⏸';
      this.pauseBtn.classList.toggle('on', frozen);
      this.liveBtn.classList.toggle('hide', !frozen);
    }

    syncWinSel() {
      const preset = CFG.windows.find((w) => Math.abs(w - this.windowS) < 0.25);
      if (preset) {
        if (this._customOpt) { this._customOpt.remove(); this._customOpt = null; }
        this.winSel.value = String(preset);
      } else {
        if (!this._customOpt) {
          this._customOpt = document.createElement('option');
          this.winSel.appendChild(this._customOpt);
        }
        this._customOpt.value = String(this.windowS);
        this._customOpt.textContent = fmtWindow(this.windowS);
        this.winSel.value = String(this.windowS);
      }
    }

    // ---------- Taille & plein écran ------------------------------------
    applyHeightMode() {
      this.root.classList.toggle('size-L', this.heightMode === 'L');
      this.root.classList.toggle('size-XL', this.heightMode === 'XL');
      // Taille libre : appliquée par variables CSS, neutralisées sous le
      // point de rupture mobile (la grille y reste en une colonne).
      this.root.classList.toggle('has-custom-h', this.customH != null);
      this.root.classList.toggle('has-span', this.colSpan != null);
      if (this.customH != null) this.root.style.setProperty('--custom-h', this.customH + 'px');
      else this.root.style.removeProperty('--custom-h');
      if (this.colSpan != null) {
        // Jamais plus large que la grille : une fenêtre rétrécie ne doit pas
        // forcer des colonnes supplémentaires (la largeur voulue est conservée).
        const m = this.gridMetrics();
        this.root.style.setProperty('--col-span',
          String(m ? Math.min(this.colSpan, m.count) : this.colSpan));
      } else {
        this.root.style.removeProperty('--col-span');
      }
    }
    cycleHeight() {
      const i = HEIGHT_MODES.indexOf(this.heightMode);
      this.heightMode = HEIGHT_MODES[(i + 1) % HEIGHT_MODES.length];
      this.customH = null;   // le préréglage reprend la main sur la taille libre
      this.applyHeightMode();
      this.app.onChange();
    }
    /** Retour à la taille automatique (préréglage M/L/XL). */
    resetSize() {
      if (this.customH == null && this.colSpan == null) return;
      this.customH = null;
      this.colSpan = null;
      this.applyHeightMode();
      this.app.onChange();
      this.app.toast('Taille automatique rétablie.');
    }

    /**
     * Géométrie de la grille : nombre de colonnes « naturelles », largeur de
     * colonne et gouttière. Le compte est recalculé depuis `--col-min` (et non
     * depuis le template résolu) pour rester indépendant des largeurs déjà
     * imposées par les graphiques élargis.
     */
    gridMetrics() {
      const grid = this.root.parentElement;
      if (!grid || !grid.classList.contains('charts-grid')) return null;
      const cs = getComputedStyle(grid);
      const gap = parseFloat(cs.columnGap) || 0;
      const min = parseFloat(cs.getPropertyValue('--col-min')) || 0;
      const w = grid.clientWidth;
      if (!(w > 0)) return null;
      const count = min > 0 ? Math.max(1, Math.floor((w + gap) / (min + gap))) : 1;
      return { count, colW: (w - gap * (count - 1)) / count, gap };
    }

    /** Poignée bas-droite : redimensionnement libre à la souris (ou au doigt). */
    bindResizeGrip() {
      const grip = this.root.querySelector('.resize-grip');
      let g = null;
      grip.addEventListener('pointerdown', (e) => {
        if (this.fullscreen || e.button > 0) return;
        const m = this.gridMetrics();
        g = {
          id: e.pointerId,
          x: e.clientX, y: e.clientY,
          h: this.root.querySelector('.chart-body').clientHeight,
          span: this.colSpan || 1,
          w: this.root.getBoundingClientRect().width,
          m,
        };
        try { grip.setPointerCapture(e.pointerId); } catch (err) { /* capture facultative */ }
        this.root.classList.add('resizing');
        e.preventDefault();
      });
      grip.addEventListener('pointermove', (e) => {
        if (!g || e.pointerId !== g.id) return;
        this.customH = sanitizeH(Math.round(g.h + (e.clientY - g.y)));
        if (g.m && g.m.count > 1) {
          const unit = g.m.colW + g.m.gap;
          const span = Math.round((g.w + (e.clientX - g.x) + g.m.gap) / unit);
          this.colSpan = sanitizeSpan(clamp(span, 1, Math.min(g.m.count, MAX_COL_SPAN)));
        }
        this.applyHeightMode();
        e.preventDefault();
      });
      const end = (e) => {
        if (!g || (e && e.pointerId !== g.id)) return;
        g = null;
        this.root.classList.remove('resizing');
        this.app.onChange();
      };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
      grip.addEventListener('dblclick', (e) => { e.preventDefault(); this.resetSize(); });
    }
    setFullscreen(on) {
      this.fullscreen = on;
      this.root.classList.toggle('fs', on);
      document.body.classList.toggle('has-fs', on);
    }

    openChartMenu(anchor) {
      openPopover(this, anchor, (mk) => {
        mk('Dupliquer ce graphique', () => this.app.duplicateChart(this), null,
          'Créer une copie avec les mêmes courbes, couleurs, échelles et fenêtre de temps, juste après celui-ci');
        mk('Échelles automatiques', () => this.resetAxes(), null,
          'Remettre toutes les échelles de ce graphique en cadrage automatique (annule les réglages manuels 🔒)');
        const next = HEIGHT_MODES[(HEIGHT_MODES.indexOf(this.heightMode) + 1) % HEIGHT_MODES.length];
        mk('Taille : ' + this.heightMode + ' → ' + next +
           (next === 'XL' ? ' (pleine largeur)' : ''), () => this.cycleHeight(), null,
          'Hauteur du graphique : M (normale), L (grande), XL (grande et pleine largeur de la grille)');
        if (this.customH != null || this.colSpan != null) {
          mk('Taille automatique', () => this.resetSize(), null,
            'Annuler le dimensionnement fait à la poignée (coin bas-droit) et revenir au préréglage M/L/XL');
        }
        mk(this.fullscreen ? 'Quitter le plein écran' : 'Plein écran', () =>
          this.setFullscreen(!this.fullscreen), null,
          'Afficher ce graphique seul sur tout l’écran (sortie par Échap)');
        // Déplacements (indispensables au tact : pas de glisser-déposer HTML5)
        for (const t of this.app.otherTabs()) {
          mk('Déplacer vers l’onglet « ' + DW.escapeHtml(t.name) + ' »', () => {
            this.app.moveChartToTab(this, t);
          }, null, 'Transférer ce graphique et sa configuration dans l’onglet « ' + t.name + ' »');
        }
        mk('Ouvrir dans une nouvelle fenêtre', () => {
          if (this.fullscreen) this.setFullscreen(false);
          DW.dnd.openInNewWindow({ kind: 'chart', chart: this.serialize() },
            () => this.app.removeChart(this));
        }, null, 'Sortir ce graphique dans une fenêtre séparée, à poser sur un autre écran');
        mk('Fermer le graphique', () => {
          if (this.fullscreen) this.setFullscreen(false);
          this.app.removeChart(this);
        }, 'danger', 'Supprimer ce graphique et libérer ses variables');
      });
    }

    resetAxes() {
      for (const st of this.axisState.values()) { st.mode = 'auto'; st.snap = true; }
    }

    // ---------- Échelles verticales : réglage explicite -------------------
    /**
     * Ancre pour le menu d'une règle d'axe. Le popover se positionne sur un
     * élément ; une règle n'en est pas un — elle est peinte dans le canvas. On
     * en pose donc une, de taille nulle, à l'endroit visé.
     */
    axisAnchor(band) {
      if (!this._axisAnchorEl) {
        this._axisAnchorEl = document.createElement('span');
        this._axisAnchorEl.className = 'axis-anchor';
        this.canvas.parentNode.appendChild(this._axisAnchorEl);
      }
      const el = this._axisAnchorEl;
      // Le canvas n'est pas collé au bord de son parent (marge intérieure) :
      // sans son décalage, le menu se poserait à côté de la règle visée.
      el.style.left = (this.canvas.offsetLeft + band.x0) + 'px';
      el.style.top = this.canvas.offsetTop + 'px';
      el.style.width = (band.x1 - band.x0) + 'px';
      el.style.height = this.canvas.clientHeight + 'px';
      return el;
    }

    /** Libellé d'une échelle : son unité, ou les courbes qui la partagent. */
    axisTitle(key) {
      const series = this.series.filter((s) => this.axisKey(s) === key);
      if (!series.length) return 'Échelle';
      const unit = series[0].meta.unit;
      if (key.startsWith('solo:')) return (series[0].name || series[0].addr) + (unit ? ' (' + unit + ')' : '');
      return unit ? 'Échelle « ' + unit + ' »' : 'Échelle sans unité';
    }

    /** Applique des bornes à une échelle, ou à toutes (réglage groupé). */
    setAxisRange(key, min, max, toutes) {
      const r = sanitizeRange(min, max);
      const cles = toutes ? [...this.axisState.keys()] : [key];
      for (const k of cles) {
        const st = this.axisState.get(k);
        if (!st) continue;
        st.mode = 'manual';
        st.cur = { min: r.min, max: r.max };
      }
      this.app.onChange();
    }

    /**
     * Menu d'une échelle verticale : bornes exactes, retour à l'automatique,
     * et le même réglage appliqué à toutes les échelles du graphique.
     *
     * Le glisser et la molette sur la règle font déjà le réglage à la volée ;
     * ils ne se voient pas et ne permettent pas de saisir une valeur. Ce menu
     * est le chemin explicite, à la souris comme au doigt.
     */
    openAxisMenu(key, anchorEl) {
      const st = this.axisState.get(key);
      if (!st) return;
      openPopover('axis:' + this.id + ':' + key, anchorEl, (mk, add) => {
        const t = document.createElement('div');
        t.className = 'pop-title';
        t.textContent = this.axisTitle(key);
        add(t);

        const form = document.createElement('div');
        form.className = 'pop-range';
        form.innerHTML =
          '<label>Max<input type="number" step="any" class="ax-max" ' +
            'title="Valeur en haut de l’axe"></label>' +
          '<label>Min<input type="number" step="any" class="ax-min" ' +
            'title="Valeur en bas de l’axe"></label>' +
          '<label class="pop-check"><input type="checkbox" class="ax-all" ' +
            'title="Donner ces mêmes bornes à toutes les échelles de ce graphique">' +
            '<span>Toutes les échelles</span></label>' +
          '<button type="button" class="btn sm ax-ok" ' +
            'title="Appliquer ces bornes (l’axe passe en réglage manuel 🔒)">Appliquer</button>';
        const fMin = form.querySelector('.ax-min');
        const fMax = form.querySelector('.ax-max');
        // Quatre chiffres significatifs : de quoi retoucher sans recopier
        // les décimales d'un cadrage automatique.
        fMin.value = Number(st.cur.min.toPrecision(4));
        fMax.value = Number(st.cur.max.toPrecision(4));
        const appliquer = () => {
          const lo = parseFloat(fMin.value), hi = parseFloat(fMax.value);
          if (!isFinite(lo) || !isFinite(hi)) {
            this.app.toast('Bornes non numériques : réglage ignoré.', 'err');
            return;
          }
          this.setAxisRange(key, Math.min(lo, hi), Math.max(lo, hi),
                            form.querySelector('.ax-all').checked);
          closePopover();
        };
        form.querySelector('.ax-ok').addEventListener('click', appliquer);
        form.addEventListener('keydown', (e) => { if (e.key === 'Enter') appliquer(); });
        // Un appui dans le formulaire ne doit pas être pris pour un geste
        // sur le canvas, ni refermer le menu.
        form.addEventListener('pointerdown', (e) => e.stopPropagation());
        add(form);

        mk('Échelle automatique', () => {
          st.mode = 'auto'; st.snap = true;
          this.app.onChange();
        }, null, 'Recadrer cette échelle sur les valeurs reçues (annule le réglage manuel 🔒)');
        mk('Toutes les échelles en automatique', () => {
          this.resetAxes();
          this.app.onChange();
        }, null, 'Remettre en cadrage automatique toutes les échelles de ce graphique');
      });
    }

    // ---------- Mode décalage d'une courbe ------------------------------
    startMoveMode(s) {
      this.moveSeries = s.addr;
      this.moveEl.querySelector('.mv-txt').textContent = '↕ Glissez pour décaler ' + s.addr;
      this.moveEl.classList.remove('hide');
    }
    endMoveMode() {
      this.moveSeries = null;
      this.moveEl.classList.add('hide');
      this.rebuildLegend();
      this.app.onChange();
    }

    // ---------- Gestes ---------------------------------------------------
    bandAt(x) {
      for (const b of this._bands) if (x >= b.x0 && x <= b.x1) return b;
      return null;
    }

    bindCanvasGestures() {
      const cv = this.canvas;

      cv.addEventListener('pointerdown', (e) => {
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* pointeur synthétique */ }
        this.cursor = null;   // le curseur de survol ne survit pas à un appui
        const suppressed = consumePopClose(e.pointerId);
        this._ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY, x0: e.offsetX, y0: e.offsetY, suppressed });
        if (suppressed) { this._gesture = { mode: 'dead' }; return; }
        if (this._ptrs.size === 2) {
          this._hadMulti = true;
          const [a, b] = [...this._ptrs.values()];
          const dist = Math.max(12, Math.hypot(a.x - b.x, a.y - b.y));
          const midX = (a.x + b.x) / 2;
          this._gesture = {
            mode: 'pinch',
            baseDist: dist,
            baseWindow: this.windowS,
            anchorT: this.viewEnd === null ? null : this.timeAt(midX),
            anchorX: midX,
          };
        } else if (this._ptrs.size === 1) {
          this._hadMulti = false;
          const band = this.bandAt(e.offsetX);
          if (this.moveSeries) {
            const s = this.series.find((x) => x.addr === this.moveSeries);
            this._gesture = s ? {
              mode: 'offset', series: s,
              baseOffset: s.offsetY || 0, baseY: e.offsetY,
              scale: this._axisScale[s.addr] || 0,
            } : null;
          } else if (band) {
            this._gesture = this.makeYGesture(band.key, e.offsetY);
          } else {
            this._gesture = null;   // décidé au premier mouvement
          }
        } else {
          this._gesture = { mode: 'dead' };
        }
      });

      cv.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'mouse' && e.buttons === 0) {
          const surRegle = !!this.bandAt(e.offsetX);
          this.cursor = surRegle ? null : { x: e.offsetX };
          // Le curseur est le seul indice qu'une règle se règle à la souris :
          // trois centimètres de canvas peint ne se distinguent en rien du
          // reste sans cela.
          cv.style.cursor = surRegle ? 'ns-resize' : '';
          return;
        }
        const p = this._ptrs.get(e.pointerId);
        if (!p) return;
        p.x = e.offsetX; p.y = e.offsetY;

        const g = this._gesture;
        if (g && g.mode === 'pinch') {
          if (this._ptrs.size < 2) return;
          const [a, b] = [...this._ptrs.values()];
          const dist = Math.max(12, Math.hypot(a.x - b.x, a.y - b.y));
          const w = clamp(g.baseWindow * g.baseDist / dist, MIN_WINDOW_S, MAX_WINDOW_S);
          this.windowS = w;
          if (g.anchorT !== null && this._plot) {
            const pl = this._plot;
            this.viewEnd = g.anchorT + ((pl.mL + pl.pw - g.anchorX) / pl.pw) * w;
            this.clampView();
          }
          this.syncWinSel();
          return;
        }
        if (g && g.mode === 'dead') return;

        if (!g) {
          const dx = p.x - p.x0, dy = p.y - p.y0;
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          if (Math.abs(dx) >= Math.abs(dy)) {
            this._gesture = {
              mode: 'pan',
              baseEnd: this.viewEnd === null ? DW.source.now() : this.viewEnd,
              baseX: p.x0,
            };
          } else {
            // Glisser vertical sur le tracé : déplace l'échelle principale
            const primary = this._plot && this._plot.primaryKey;
            this._gesture = primary ? this.makeYGesture(primary, p.y0) : { mode: 'dead' };
          }
        }
        const g2 = this._gesture;
        if (g2.mode === 'pan' && this._plot) {
          const dt = (g2.baseX - p.x) * (this.windowS / this._plot.pw);
          this.viewEnd = g2.baseEnd + dt;
          this.clampView();
          if (this.viewEnd !== null && DW.source.now() - this.viewEnd < this.windowS * 0.01) this.goLive();
          else this.syncPauseUi();
        } else if (g2.mode === 'offset' && g2.scale) {
          g2.series.offsetY = g2.baseOffset + (g2.baseY - p.y) * g2.scale;
        } else if (g2.mode === 'yaxis') {
          // Zone morte : un appui qui tremble ne doit pas verrouiller l'axe
          if (!g2.armed) {
            if (Math.abs(p.y - g2.baseY) < 8) return;
            g2.armed = true;
          }
          const st = this.axisState.get(g2.key);
          if (st) {
            const dv = (p.y - g2.baseY) * g2.scale;
            st.mode = 'manual';
            st.cur = sanitizeRange(g2.baseMin + dv, g2.baseMax + dv);
          }
        }
      });

      const end = (e) => {
        const p = this._ptrs.get(e.pointerId);
        this._ptrs.delete(e.pointerId);
        const g = this._gesture;
        if (this._ptrs.size) { this._gesture = { mode: 'dead' }; return; }
        this._gesture = null;
        if (g && g.mode === 'offset') { this.rebuildLegend(); this.app.onChange(); return; }
        // Appui bref sans mouvement — jamais après un geste multi-touch,
        // un pointercancel ou le tap qui a fermé un menu
        if (p && !p.suppressed && !this._hadMulti && e.type !== 'pointercancel' &&
            Math.abs(p.x - p.x0) < 8 && Math.abs(p.y - p.y0) < 8) {
          const band = this.bandAt(p.x0);
          const now = performance.now();
          const isDouble = now - this._lastTap < 320 && Math.abs(p.x - this._lastTapX) < 40;
          if (band) {
            if (isDouble && this._lastTapBand === band.key) {
              const st = this.axisState.get(band.key);
              if (st) { st.mode = 'auto'; st.snap = true; }
            } else {
              // Appui bref sur une règle : le menu de l'échelle, seul chemin
              // où l'on peut saisir des bornes exactes — à la souris comme au
              // doigt, contrairement au glisser et à la molette.
              this.openAxisMenu(band.key, this.axisAnchor(band));
            }
            this._lastTapBand = band.key;
          } else if (isDouble && this._lastTapBand === null) {
            // Double-appui homogène sur le tracé uniquement
            this.pinT = null;
            this.goLive();
          } else {
            if (this.pinT !== null && this._plot && Math.abs(this.xAt(this.pinT) - p.x) < 24) this.pinT = null;
            else this.pinT = this.timeAt(p.x);
            this._lastTapBand = null;
          }
          this._lastTap = now; this._lastTapX = p.x;
        }
        this._hadMulti = false;
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'mouse' && e.buttons === 0) this.cursor = null;
      });

      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = Math.pow(1.25, e.deltaY / 100);
        const band = this.bandAt(e.offsetX);
        if (band) {
          // Zoom de l'échelle de cet axe, ancré sous le curseur
          const st = this.axisState.get(band.key);
          if (!st || !this._plot) return;
          const pl = this._plot;
          const span = st.cur.max - st.cur.min;
          const v0 = st.cur.min + (1 - (e.offsetY - pl.mT) / pl.ph) * span;
          st.mode = 'manual';
          st.cur = sanitizeRange(v0 - (v0 - st.cur.min) * factor, v0 + (st.cur.max - v0) * factor);
          return;
        }
        const anchorT = this.viewEnd === null ? null : this.timeAt(e.offsetX);
        const w = clamp(this.windowS * factor, MIN_WINDOW_S, MAX_WINDOW_S);
        this.windowS = w;
        if (anchorT !== null && this._plot) {
          const pl = this._plot;
          this.viewEnd = anchorT + ((pl.mL + pl.pw - e.offsetX) / pl.pw) * w;
          this.clampView();
        }
        this.syncWinSel();
      }, { passive: false });

      cv.addEventListener('dblclick', (e) => {
        const band = this.bandAt(e.offsetX);
        if (band) {
          const st = this.axisState.get(band.key);
          if (st) { st.mode = 'auto'; st.snap = true; }
        } else {
          this.pinT = null;
          this.goLive();
        }
      });
    }

    makeYGesture(key, y0) {
      const st = this.axisState.get(key);
      if (!st || !this._plot) return { mode: 'dead' };
      return {
        mode: 'yaxis', key,
        baseY: y0,
        baseMin: st.cur.min, baseMax: st.cur.max,
        scale: (st.cur.max - st.cur.min) / this._plot.ph,
      };
    }

    clampView() {
      if (this.viewEnd === null) return;
      const now = DW.source.now();
      const minEnd = now - CFG.horizonS + this.windowS;
      this.viewEnd = Math.min(now, Math.max(this.viewEnd, Math.min(minEnd, now)));
    }

    timeAt(xPx) {
      const pl = this._plot;
      if (!pl) return DW.source.now();
      return pl.tEnd - ((pl.mL + pl.pw - xPx) / pl.pw) * (pl.tEnd - pl.tStart);
    }
    xAt(t) {
      const pl = this._plot;
      if (!pl) return -1;
      return pl.mL + ((t - pl.tStart) / (pl.tEnd - pl.tStart)) * pl.pw;
    }

    // ---------- Courbes --------------------------------------------------
    hasSeries(addr) { return this.series.some((s) => s.addr === addr); }

    addSeries(addr, opts) {
      opts = opts || {};
      if (this.hasSeries(addr)) return { ok: false, error: addr + ' est déjà tracée dans « ' + this.title + ' ».' };
      if (this.series.length >= CFG.maxSeriesPerChart) {
        return { ok: false, error: 'Limite de ' + CFG.maxSeriesPerChart + ' courbes par graphique atteinte — ajoutez un autre graphique.' };
      }
      const meta = this.app.acquire(addr, opts.periodMs);
      if (!meta) return { ok: false, error: 'Adresse invalide : ' + addr };
      const used = new Set(this.series.map((s) => s.colorIdx));
      let colorIdx = 0;
      while (used.has(colorIdx)) colorIdx++;
      // Une couleur explicitement choisie (palette ou teinte libre) est restituée
      if (Number.isInteger(opts.colorIdx) && opts.colorIdx >= 0) colorIdx = opts.colorIdx;
      this.series.push({
        addr, meta, colorIdx,
        color: typeof opts.color === 'string' ? opts.color : undefined,
        name: typeof opts.name === 'string' && opts.name ? opts.name : undefined,
        axisMode: opts.axisMode === 'solo' ? 'solo' : 'auto',
        visible: opts.visible !== false,
        periodMs: opts.periodMs || undefined,
        offsetY: isFinite(opts.offsetY) ? opts.offsetY : 0,
      });
      this.rebuildLegend();
      return { ok: true };
    }

    removeSeries(addr) {
      const i = this.series.findIndex((s) => s.addr === addr);
      if (i < 0) return;
      if (this.moveSeries === addr) this.endMoveMode();
      this.app.release(addr);
      this.series.splice(i, 1);
      this.rebuildLegend();
      this.app.onChange();
    }

    /** Renommage en place du nom d'affichage d'une courbe (dans sa pastille). */
    renameSeries(s) {
      closePopover();
      let chip = null;
      for (const c of this.legendEl.children) if (c.dataset.addr === s.addr) chip = c;
      if (!chip) return;
      const nameEl = chip.querySelector('.chip-addr');
      const input = document.createElement('input');
      input.className = 'chip-rename';
      input.value = s.name || '';
      input.maxLength = 48;
      input.placeholder = s.meta.label || s.addr;
      nameEl.textContent = '';
      nameEl.appendChild(input);
      input.focus();
      input.select();
      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        // Le nom appartient à la variable : l'application le répercute dans
        // tous les tableaux et toutes les courbes de la page.
        this.app.renameVariable(s.addr, input.value);
        this.rebuildLegend();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = s.name || ''; input.blur(); }
      });
      // Sans cela, le clic atteint la pastille et rouvre le menu
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    // ---------- Légende ------------------------------------------------
    rebuildLegend() {
      closePopover();
      this.legendEl.innerHTML = '';
      for (const s of this.series) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (s.visible ? '' : ' off') +
          (this.moveSeries === s.addr ? ' moving' : '');
        chip.setAttribute('role', 'listitem');
        chip.dataset.addr = s.addr;
        chip.innerHTML =
          '<i class="sw"></i>' +
          '<span class="chip-addr"></span>' +
          '<span class="chip-val">—</span>' +
          '<span class="chip-off hide" title="Courbe décalée verticalement">Δ</span>' +
          '<span class="chip-axis"></span>';
        chip.querySelector('.chip-addr').textContent = s.name || s.addr;
        chip.querySelector('.sw').style.background = colorOf(s);
        chip.title = s.addr + ' — ' + (s.name ? s.name + ' (' + s.meta.label + ')' : s.meta.label) +
          (s.meta.unit ? ' (' + s.meta.unit + ')' : '') +
          ' · rafraîchissement ' + (s.periodMs || DW.CONFIG.defaultPeriodMs) + ' ms' +
          (s.offsetY ? ' · décalage ' + DW.fmtVal(s.offsetY, s.meta) : '') +
          ' · appuyez pour le nom, la couleur, l’échelle dédiée, le décalage ou le retrait';
        chip.addEventListener('click', () => this.openSeriesMenu(s, chip));
        this.legendEl.appendChild(chip);
      }
      this.hintEl.classList.toggle('hide', this.series.length > 0);
    }

    openSeriesMenu(s, chip) {
      openPopover(s, chip, (mk, add) => {
        add(this.buildColorPicker(s));
        mk('Renommer la courbe…', () => this.renameSeries(s), null,
          'Nom d’affichage dans la légende (vide = adresse ou libellé du catalogue)');
        mk(s.visible ? 'Masquer la courbe' : 'Afficher la courbe', () => {
          s.visible = !s.visible;
          this.rebuildLegend();
          this.app.onChange();
        }, null, 'Retirer la courbe du tracé sans la supprimer (elle reste abonnée)');
        mk('Bornes de l’échelle…', () => {
          const key = this.axisKey(s);
          this.openAxisMenu(key, chip);
        }, null, 'Saisir le minimum et le maximum de l’axe de cette courbe, ' +
          'ou les donner à toutes les échelles du graphique');
        mk((s.axisMode === 'solo' ? '✓ ' : '') + 'Échelle dédiée', () => {
          s.axisMode = s.axisMode === 'solo' ? 'auto' : 'solo';
          this.app.onChange();
          this.app.toast(s.addr + ' : ' + (s.axisMode === 'solo' ? 'échelle dédiée' : 'échelle partagée par unité') + '.');
        }, null, 'Donner à cette courbe son propre axe, au lieu de partager celui de son unité');
        mk('Décaler verticalement (glisser)', () => this.startMoveMode(s), null,
          'Séparer visuellement cette courbe des autres ; les valeurs affichées restent les valeurs vraies');
        if (s.offsetY) {
          mk('Annuler le décalage (Δ ' + DW.fmtVal(s.offsetY, s.meta) + ')', () => {
            s.offsetY = 0;
            this.rebuildLegend();
            this.app.onChange();
          }, null, 'Replacer la courbe à sa position réelle');
        }
        mk('Retirer du graphique', () => this.removeSeries(s.addr), 'danger',
          'Enlever ' + s.addr + ' de ce graphique');
      });
    }

    /**
     * Nuancier du menu de courbe : les emplacements de la palette (qui
     * suivent le thème clair/sombre) puis une teinte libre.
     */
    buildColorPicker(s) {
      const wrap = document.createElement('div');
      wrap.className = 'pop-swatches';
      const pal = DW.isDarkTheme() ? DW.SERIES_COLORS.dark : DW.SERIES_COLORS.light;

      const apply = () => {
        this.rebuildLegend();
        this.app.onChange();
      };
      pal.forEach((hex, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sw-btn' + (!s.color && s.colorIdx === i ? ' on' : '');
        b.style.background = hex;
        b.title = 'Couleur ' + (i + 1) + ' de la palette';
        b.addEventListener('click', () => {
          s.colorIdx = i;
          delete s.color;      // retour à une couleur qui suit le thème
          closePopover();
          apply();
        });
        wrap.appendChild(b);
      });

      const custom = document.createElement('label');
      custom.className = 'sw-custom' + (s.color ? ' on' : '');
      custom.title = 'Teinte personnalisée (fixe, identique en thème clair et sombre)';
      const input = document.createElement('input');
      input.type = 'color';
      input.value = /^#[0-9a-f]{6}$/i.test(colorOf(s)) ? colorOf(s) : '#2dd4bf';
      input.addEventListener('input', () => { s.color = input.value; });
      input.addEventListener('change', () => {
        s.color = input.value;
        closePopover();
        apply();
      });
      custom.appendChild(input);
      wrap.appendChild(custom);
      return wrap;
    }

    /** Mise à jour des valeurs vivantes de la légende (~5 Hz). */
    updateLive() {
      const chips = this.legendEl.children;
      for (let i = 0; i < this.series.length && i < chips.length; i++) {
        const s = this.series[i];
        const last = DW.source.latest(s.addr);
        const valEl = chips[i].querySelector('.chip-val');
        valEl.textContent = last ? DW.fmtVal(last.v, s.meta) + (s.meta.unit ? ' ' + s.meta.unit : '') : '—';
        chips[i].querySelector('.chip-off').classList.toggle('hide', !s.offsetY);
        const axEl = chips[i].querySelector('.chip-axis');
        const badge = (this._axisBadge && this._axisBadge[s.addr]) || '';
        // Badge visible si plusieurs échelles OU si l'axe est verrouillé 🔒
        axEl.textContent = (this._axisCount > 1 || badge.includes('🔒')) ? badge : '';
        axEl.title = badge
          ? 'Échelle utilisée par cette courbe' +
            (badge.includes('🔒') ? ' — réglée manuellement (double-appui sur sa règle pour revenir en automatique)' : '') +
            (badge.includes('·') ? ' — sans règle visible, faute de place' : '')
          : '';
      }
    }

    // ---------- Échelles ----------------------------------------------
    axisKey(s) {
      if (s.axisMode === 'solo') return 'solo:' + s.addr;
      if (s.meta.kind === 'bit') return 'bool';
      if (s.meta.unit) return 'u:' + s.meta.unit;
      return s.meta.kind === 'word' ? 'mot' : 'sans-unité';
    }

    /** Ajustement « nice » d'une plage de données (avec marge). */
    fitRange(min, max) {
      if (!isFinite(min)) { min = 0; max = 1; }
      if (min === max) {
        const e = Math.max(Math.abs(min) * 0.05, 0.5);
        min -= e; max += e;
      }
      const pad = (max - min) * 0.07;
      return sanitizeRange(min - pad, max + pad);
    }

    computeGroups(tStart, tEnd) {
      const groups = new Map();
      for (const s of this.series) {
        if (!s.visible) continue;
        const key = this.axisKey(s);
        let g = groups.get(key);
        if (!g) {
          g = {
            key,
            label: s.meta.kind === 'bit' && s.axisMode !== 'solo' ? 'TOR'
              : (s.meta.unit || (s.meta.kind === 'word' ? 'mot' : '')),
            series: [], dMin: Infinity, dMax: -Infinity, isBool: s.meta.kind === 'bit',
          };
          groups.set(key, g);
        }
        g.series.push(s);
        if (g.isBool && s.meta.kind !== 'bit') g.isBool = false;
      }
      const list = [...groups.values()];
      const nowMs = performance.now();

      for (const g of list) {
        // Plage des données (décalages inclus)
        if (g.isBool) {
          let lo = 0, hi = 0;
          for (const s of g.series) {
            const off = s.offsetY || 0;
            if (off < lo) lo = off;
            if (off > hi) hi = off;
          }
          g.dMin = -0.07 + lo; g.dMax = 1.07 + hi;
        } else {
          for (const s of g.series) {
            const off = s.offsetY || 0;
            const d = DW.source.data(s.addr);
            const [i0, i1] = rangeIdx(d.ts, tStart, tEnd);
            for (let i = i0; i <= i1; i++) {
              const v = d.vs[i] + off;
              if (v < g.dMin) g.dMin = v;
              if (v > g.dMax) g.dMax = v;
            }
          }
        }

        // État d'échelle stabilisé (auto avec hystérésis) ou manuel
        let st = this.axisState.get(g.key);
        if (!st) {
          st = { mode: 'auto', cur: null, shrinkSince: 0, snap: true };
          this.axisState.set(g.key, st);
        }
        if (g.isBool && st.mode === 'auto') {
          st.cur = { min: g.dMin, max: g.dMax };
          st.shrinking = false;
        } else if (st.mode === 'auto') {
          const fit = this.fitRange(g.dMin, g.dMax);
          if (!st.cur || st.snap) {
            st.cur = fit;
            st.snap = false;
            st.shrinkSince = 0;
            st.shrinking = false;
          } else if (g.dMin < st.cur.min || g.dMax > st.cur.max) {
            // Extension IMMÉDIATE quand les données sortent de la plage
            st.cur = sanitizeRange(
              Math.min(fit.min, st.cur.min),
              Math.max(fit.max, st.cur.max)
            );
            st.shrinkSince = 0;
            st.shrinking = false;
          } else if (st.shrinking) {
            // Rétraction en cours : on la mène jusqu'au fit (cible rafraîchie)
            st.cur = {
              min: st.cur.min + (fit.min - st.cur.min) * 0.18,
              max: st.cur.max + (fit.max - st.cur.max) * 0.18,
            };
            const span = fit.max - fit.min;
            if (Math.abs(st.cur.min - fit.min) < span * 0.005 &&
                Math.abs(st.cur.max - fit.max) < span * 0.005) {
              st.cur = fit;
              st.shrinking = false;
              st.shrinkSince = 0;
            }
          } else {
            // Rétraction différée quand les données n'occupent plus l'échelle
            const span = st.cur.max - st.cur.min;
            const occ = isFinite(g.dMin) ? (g.dMax - g.dMin) / span : 1;
            if (occ < SHRINK_OCCUPANCY) {
              if (!st.shrinkSince) st.shrinkSince = nowMs;
              else if (nowMs - st.shrinkSince > SHRINK_DELAY_S * 1000) st.shrinking = true;
            } else {
              st.shrinkSince = 0;
            }
          }
        }
        if (!st.cur || !isFinite(st.cur.min) || st.cur.max <= st.cur.min) {
          st.cur = this.fitRange(g.dMin, g.dMax);
        }
        st.cur = sanitizeRange(st.cur.min, st.cur.max);
        g.min = st.cur.min;
        g.max = st.cur.max;
        g.manual = st.mode === 'manual';

        if (g.isBool && !g.manual) {
          g.ticks = [0, 1];
          g.tickStep = 1;
        } else {
          // Graduations bornées par indices entiers (jamais de boucle infinie)
          const step = niceStep((g.max - g.min) / 4);
          g.tickStep = step;
          g.ticks = [];
          const k0 = Math.ceil(g.min / step - 1e-9);
          const k1 = Math.floor(g.max / step + 1e-9);
          if (isFinite(k0) && isFinite(k1) && k1 - k0 <= 40) {
            for (let k = k0; k <= k1; k++) {
              const v = k * step;
              g.ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
            }
          }
        }
      }
      // Purge des états d'axes réellement disparus — les clés des séries
      // masquées sont conservées (réglage manuel 🔒 non perdu au masquage)
      const validKeys = new Set(this.series.map((s) => this.axisKey(s)));
      for (const key of [...this.axisState.keys()]) {
        if (!validKeys.has(key)) this.axisState.delete(key);
      }
      for (const g of list) {
        g.color = g.series.length === 1 ? colorOf(g.series[0]) : ink().muted;
      }
      return list;
    }

    // ---------- Rendu ---------------------------------------------------
    render() {
      const cw = this.canvas.clientWidth, chh = this.canvas.clientHeight;
      if (!cw || !chh) return;
      const dpr = window.devicePixelRatio || 1;
      if (cw !== this._cw || chh !== this._ch || dpr !== this._dpr) {
        this._cw = cw; this._ch = chh; this._dpr = dpr;
        this.canvas.width = Math.round(cw * dpr);
        this.canvas.height = Math.round(chh * dpr);
      }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, chh);
      const IK = ink();

      // Adaptation à la largeur : axes compacts sur petit écran
      const compact = cw < 520;
      const axisW = compact ? 38 : cw > 1100 ? 50 : 44;
      const maxShown = compact ? 2 : MAX_AXES;
      const fontPx = compact ? 9 : cw > 1100 ? 11 : 10;

      this.clampView();
      const tEnd = this.viewEnd === null ? DW.source.now() : this.viewEnd;
      const tStart = tEnd - this.windowS;
      const groups = this.computeGroups(tStart, tEnd);

      // Badges d'échelle pour la légende
      this._axisBadge = {};
      this._axisCount = groups.length;
      groups.forEach((g, i) => {
        const tag = i < maxShown ? 'É' + (i + 1) + (g.manual ? '🔒' : '') : 'É·';
        for (const s of g.series) this._axisBadge[s.addr] = tag;
      });

      const shown = groups.slice(0, maxShown);
      const leftAxes = shown.filter((_, i) => i % 2 === 0);
      const rightAxes = shown.filter((_, i) => i % 2 === 1);
      const mL = 8 + (leftAxes.length ? leftAxes.length * axisW : 26);
      const mR = 8 + rightAxes.length * axisW;
      const mT = 18, mB = 22;
      const pw = Math.max(10, cw - mL - mR), ph = Math.max(10, chh - mT - mB);
      this._plot = {
        mL, mT, pw, ph, tStart, tEnd,
        primaryKey: shown[0] ? shown[0].key : null,
      };
      const X = (t) => mL + ((t - tStart) / this.windowS) * pw;
      const yOf = (g) => (v) => mT + ph * (1 - (v - g.min) / (g.max - g.min));

      // Zones des règles (hit-test des gestes d'axe)
      this._bands = shown.map((g, i) => {
        const side = i % 2 === 0 ? 'L' : 'R';
        const slot = Math.floor(i / 2);
        const x0 = side === 'L' ? mL - (slot + 1) * axisW : cw - mR + slot * axisW;
        return { key: g.key, x0: Math.max(0, x0), x1: x0 + axisW, side };
      });

      this._yFns = {};
      this._axisScale = {};
      for (const g of groups) {
        const yG = yOf(g);
        for (const s of g.series) {
          const off = s.offsetY || 0;
          this._yFns[s.addr] = (v) => yG(v + off);
          this._axisScale[s.addr] = (g.max - g.min) / ph;
        }
      }

      ctx.font = fontPx + 'px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

      // Grille temporelle (graduations relatives au bord direct)
      const nowT = DW.source.now();
      const tickS = niceTimeStep(this.windowS / (compact ? 4 : 5));
      ctx.strokeStyle = IK.line;
      ctx.fillStyle = IK.faint;
      ctx.lineWidth = 1;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const firstK = Math.ceil((nowT - tEnd) / tickS - 1e-9);
      for (let k = firstK; ; k++) {
        const t = nowT - k * tickS;
        if (t < tStart - 1e-9) break;
        const x = Math.round(X(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + ph); ctx.stroke();
        ctx.fillText(fmtTimeTick(k * tickS, this.windowS), Math.min(Math.max(x, mL + 14), cw - mR - 16), mT + ph + 6);
      }

      // Grille horizontale : celle du premier groupe uniquement
      if (shown[0]) {
        const g0 = shown[0], y0 = yOf(g0);
        ctx.strokeStyle = IK.line;
        for (const v of g0.ticks) {
          const y = Math.round(y0(v)) + 0.5;
          if (y < mT || y > mT + ph) continue;
          ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + pw, y); ctx.stroke();
        }
      }

      // Règles d'axes
      shown.forEach((g, i) => {
        const side = i % 2 === 0 ? 'L' : 'R';
        const slot = Math.floor(i / 2);
        const xr = side === 'L' ? mL - slot * axisW : cw - mR + slot * axisW;
        const yG = yOf(g);
        ctx.strokeStyle = g.color; ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
        const xl = Math.round(xr) + (side === 'L' ? -0.5 : 0.5);
        ctx.beginPath(); ctx.moveTo(xl, mT); ctx.lineTo(xl, mT + ph); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = g.color;
        ctx.textAlign = side === 'L' ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        const tx = side === 'L' ? xr - 4 : xr + 4;
        for (const v of g.ticks) {
          const y = yG(v);
          if (y < mT - 2 || y > mT + ph + 2) continue;
          ctx.fillText(fmtAxisTick(v, g.tickStep || 1), tx, y);
        }
        ctx.textBaseline = 'bottom';
        const lbl = (g.manual ? '🔒' : '') + (g.label || '');
        if (lbl) ctx.fillText(lbl, tx, mT - 4);
      });

      // Courbes
      ctx.save();
      ctx.beginPath(); ctx.rect(mL, mT - 4, pw, ph + 8); ctx.clip();
      for (const g of groups) {
        for (const s of g.series) {
          const yFn = this._yFns[s.addr];
          const d = DW.source.data(s.addr);
          const [i0, i1] = rangeIdx(d.ts, tStart, tEnd);
          if (i1 < i0) continue;
          const discrete = s.meta.kind === 'bit' || s.meta.kind === 'word';
          ctx.strokeStyle = colorOf(s);
          ctx.lineWidth = this.moveSeries === s.addr ? 3 : 2;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          drawPath(ctx, d.ts, d.vs, i0, i1, X, yFn, discrete, pw);
          if (this.viewEnd === null) {
            const xe = X(d.ts[i1]), ye = yFn(d.vs[i1]);
            ctx.beginPath(); ctx.arc(xe, ye, 3, 0, Math.PI * 2);
            ctx.fillStyle = colorOf(s); ctx.fill();
          }
        }
      }
      ctx.restore();

      // Curseur : transitoire (survol) ou épinglé (appui bref)
      let cursorX = null;
      if (this.cursor) cursorX = this.cursor.x;
      else if (this.pinT !== null) {
        const xp = X(this.pinT);
        if (xp >= mL - 2 && xp <= mL + pw + 2) cursorX = xp;
      }
      if (cursorX !== null && groups.length) {
        this.drawCursor(ctx, groups, tStart, X, mL, mT, pw, ph, cursorX, nowT);
      } else {
        this.tipEl.classList.add('hide');
      }
    }

    drawCursor(ctx, groups, tStart, X, mL, mT, pw, ph, x, nowT) {
      const IK = ink();
      x = Math.min(Math.max(x, mL), mL + pw);
      const tCur = tStart + ((x - mL) / pw) * this.windowS;
      ctx.strokeStyle = this.pinT !== null && !this.cursor ? IK.accent : IK.muted;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, mT); ctx.lineTo(x + 0.5, mT + ph); ctx.stroke();
      ctx.setLineDash([]);

      let rows = '';
      for (const g of groups) {
        for (const s of g.series) {
          const d = DW.source.data(s.addr);
          const i = nearestIdx(d.ts, tCur);
          if (i < 0) continue;
          const v = d.vs[i];
          const y = this._yFns[s.addr](v);
          ctx.beginPath(); ctx.arc(X(d.ts[i]), y, 4, 0, Math.PI * 2);
          ctx.strokeStyle = colorOf(s); ctx.lineWidth = 2; ctx.stroke();
          rows += '<div class="tip-row"><i style="background:' + colorOf(s) + '"></i>' +
            '<span class="tip-addr">' + escapeHtml(s.addr) + '</span>' +
            '<b>' + DW.fmtVal(v, s.meta) + (s.meta.unit ? ' ' + escapeHtml(s.meta.unit) : '') + '</b></div>';
        }
      }
      const dt = nowT - tCur;
      this.tipEl.innerHTML = '<div class="tip-time">t − ' + dt.toFixed(1) + ' s</div>' + rows;
      this.tipEl.classList.remove('hide');
      const bw = this.canvas.clientWidth;
      const tw = this.tipEl.offsetWidth;
      const left = x + 12 + tw > bw ? Math.max(4, x - tw - 12) : x + 12;
      this.tipEl.style.left = left + 'px';
      this.tipEl.style.top = (mT + 4) + 'px';
    }

    serialize() {
      return {
        title: this.title,
        windowS: Math.round(this.windowS * 10) / 10,
        heightMode: this.heightMode !== 'M' ? this.heightMode : undefined,
        customH: this.customH || undefined,
        colSpan: this.colSpan || undefined,
        series: this.series.map((s) => ({
          addr: s.addr,
          name: s.name || undefined,
          axisMode: s.axisMode,
          visible: s.visible,
          periodMs: s.periodMs,
          offsetY: s.offsetY || undefined,
          colorIdx: s.colorIdx,
          color: s.color || undefined,
        })),
      };
    }

    destroy() {
      if (this.fullscreen) this.setFullscreen(false);
      document.removeEventListener('keydown', this._escHandler);
      window.removeEventListener('resize', this._resizeHandler);
      for (const s of this.series) this.app.release(s.addr);
      this.series = [];
      closePopover();
      this.root.remove();
    }
  }

  // ---------- Aides géométriques --------------------------------------
  function rangeIdx(ts, tStart, tEnd) {
    const n = ts.length;
    if (!n) return [0, -1];
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < tStart) lo = m + 1; else hi = m; }
    const i0 = Math.max(0, lo - 1);
    let l2 = i0, h2 = n - 1;
    while (l2 < h2) { const m = (l2 + h2 + 1) >> 1; if (ts[m] <= tEnd) l2 = m; else h2 = m - 1; }
    return [i0, l2];
  }
  function nearestIdx(ts, t) {
    const n = ts.length;
    if (!n) return -1;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; }
    if (lo > 0 && Math.abs(ts[lo - 1] - t) < Math.abs(ts[lo] - t)) return lo - 1;
    return lo;
  }

  /** Tracé avec décimation min/max par seau quand les points dépassent ~2/px. */
  function drawPath(ctx, ts, vs, i0, i1, X, Y, discrete, plotW) {
    const n = i1 - i0 + 1;
    ctx.beginPath();
    if (n <= plotW * 2) {
      let prevY = null;
      for (let i = i0; i <= i1; i++) {
        const x = X(ts[i]), y = Y(vs[i]);
        if (prevY === null) ctx.moveTo(x, y);
        else if (discrete) { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
        else ctx.lineTo(x, y);
        prevY = y;
      }
    } else {
      const step = Math.ceil(n / (plotW * 2));
      let first = true;
      for (let b = i0; b <= i1; b += step) {
        const bEnd = Math.min(b + step - 1, i1);
        let iMin = b, iMax = b;
        for (let i = b + 1; i <= bEnd; i++) {
          if (vs[i] < vs[iMin]) iMin = i;
          if (vs[i] > vs[iMax]) iMax = i;
        }
        const a = Math.min(iMin, iMax), z = Math.max(iMin, iMax);
        if (first) { ctx.moveTo(X(ts[a]), Y(vs[a])); first = false; }
        else ctx.lineTo(X(ts[a]), Y(vs[a]));
        if (z !== a) ctx.lineTo(X(ts[z]), Y(vs[z]));
      }
    }
    ctx.stroke();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  DW.escapeHtml = escapeHtml;

  DW.Chart = Chart;
})();
