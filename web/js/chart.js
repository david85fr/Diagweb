/* Diagweb — moteur de graphiques temps réel (canvas).
 *
 * Multi-échelles : les courbes sont regroupées par unité (ou isolées via
 * « échelle dédiée ») ; chaque groupe possède son propre axe Y, tracé en
 * alternance à gauche / à droite et coloré comme sa courbe quand il n'en
 * porte qu'une. Au-delà de 4 axes, les groupes restants sont mis à
 * l'échelle indépendamment mais sans règle graduée visible.
 */
(function () {
  "use strict";
  const DW = window.DW;
  const CFG = DW.CONFIG;

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
  /** Graduation d'axe : décimales dérivées du pas pour éviter les doublons. */
  function fmtAxisTick(v, step) {
    if (Math.abs(v) >= 10000) {
      const kStep = step / 1000;
      const dec = Math.max(0, -Math.floor(Math.log10(kStep)));
      return (v / 1000).toFixed(Math.min(dec, 2)) + 'k';
    }
    const dec = step >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(step)));
    return v.toFixed(Math.min(dec, 3));
  }
  function fmtTimeTick(negS, windowS) {
    if (negS === 0) return '0';
    if (windowS <= 90) return '-' + negS + ' s';
    const m = Math.floor(negS / 60), s = Math.round(negS % 60);
    return '-' + m + ':' + String(s).padStart(2, '0');
  }
  function niceStep(rough) {
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const f = rough / pow;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
  }
  const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  function niceTimeStep(rough) {
    for (const s of TIME_STEPS) if (s >= rough) return s;
    return 300;
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
    };
    return inkCache;
  }

  const AXIS_W = 44;               // largeur d'une règle d'axe (px)
  const MAX_AXES = 4;

  // ---------- Popover de légende (partagé) ----------------------------
  let popEl = null, popOwner = null;
  function closePopover() {
    if (popEl) { popEl.remove(); popEl = null; popOwner = null; }
  }
  document.addEventListener('pointerdown', (e) => {
    if (popEl && !popEl.contains(e.target)) closePopover();
  }, true);

  // ---------- Classe Chart --------------------------------------------
  let uid = 0;

  class Chart {
    /**
     * @param app  { acquire(addr), release(addr), onChange(), toast(msg), removeChart(chart) }
     */
    constructor(app, opts) {
      opts = opts || {};
      this.app = app;
      this.id = 'c' + (++uid);
      this.windowS = opts.windowS || CFG.defaultWindowS;
      this.paused = false;
      this.pausedAt = 0;
      this.series = [];            // {addr, meta, colorIdx, axisMode, visible}
      this.cursor = null;          // {x} px CSS pendant l'inspection
      this._cw = 0; this._ch = 0; this._dpr = 0;

      this.root = document.createElement('section');
      this.root.className = 'card chart-card';
      this.root.innerHTML =
        '<header class="chart-head">' +
          '<input class="chart-title" maxlength="48" aria-label="Titre du graphique">' +
          '<div class="chart-tools">' +
            '<select class="chart-window" title="Fenêtre de temps" aria-label="Fenêtre de temps"></select>' +
            '<button class="iconbtn chart-pause" type="button" title="Figer / reprendre">⏸</button>' +
            '<button class="iconbtn chart-close" type="button" title="Fermer le graphique">✕</button>' +
          '</div>' +
        '</header>' +
        '<div class="chart-body">' +
          '<canvas aria-label="Courbes du graphique"></canvas>' +
          '<div class="chart-tip hide"></div>' +
          '<div class="chart-hint">Ajoutez une variable via la barre de recherche, cible « ' +
            '<b class="hint-name"></b> ».</div>' +
        '</div>' +
        '<div class="chart-legend" role="list"></div>';

      this.titleEl = this.root.querySelector('.chart-title');
      this.titleEl.value = opts.title || 'Graphique';
      this.canvas = this.root.querySelector('canvas');
      this.ctx = this.canvas.getContext('2d');
      this.tipEl = this.root.querySelector('.chart-tip');
      this.hintEl = this.root.querySelector('.chart-hint');
      this.legendEl = this.root.querySelector('.chart-legend');
      this.winSel = this.root.querySelector('.chart-window');
      this.pauseBtn = this.root.querySelector('.chart-pause');

      for (const w of CFG.windows) {
        const o = document.createElement('option');
        o.value = w;
        o.textContent = w < 60 ? w + ' s' : (w / 60) + ' min';
        this.winSel.appendChild(o);
      }
      this.winSel.value = String(this.windowS);

      this.root.querySelector('.hint-name').textContent = this.titleEl.value;

      // Événements
      this.titleEl.addEventListener('change', () => {
        this.root.querySelector('.hint-name').textContent = this.title;
        app.onChange();
        app.refreshTargets();
      });
      this.winSel.addEventListener('change', () => {
        this.windowS = parseInt(this.winSel.value, 10) || CFG.defaultWindowS;
        app.onChange();
      });
      this.pauseBtn.addEventListener('click', () => this.setPaused(!this.paused));
      this.root.querySelector('.chart-close').addEventListener('click', () => app.removeChart(this));

      const cv = this.canvas;
      cv.addEventListener('pointerdown', (e) => {
        cv.setPointerCapture(e.pointerId);
        this.cursor = { x: e.offsetX };
      });
      cv.addEventListener('pointermove', (e) => {
        if (this.cursor) this.cursor.x = e.offsetX;
      });
      const end = () => { this.cursor = null; this.tipEl.classList.add('hide'); };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
    }

    get title() { return this.titleEl.value.trim() || 'Graphique'; }

    setPaused(p) {
      this.paused = p;
      if (p) this.pausedAt = DW.source.now();
      this.pauseBtn.textContent = p ? '▶' : '⏸';
      this.pauseBtn.classList.toggle('on', p);
    }

    hasSeries(addr) { return this.series.some((s) => s.addr === addr); }

    addSeries(addr, opts) {
      opts = opts || {};
      if (this.hasSeries(addr)) return { ok: false, error: addr + ' est déjà tracée dans « ' + this.title + ' ».' };
      if (this.series.length >= CFG.maxSeriesPerChart) {
        return { ok: false, error: 'Limite de ' + CFG.maxSeriesPerChart + ' courbes par graphique atteinte — ajoutez un autre graphique.' };
      }
      const meta = this.app.acquire(addr, opts.periodMs);
      if (!meta) return { ok: false, error: 'Adresse invalide : ' + addr };
      // Attribution de couleur : plus petit index libre (ordre fixe)
      const used = new Set(this.series.map((s) => s.colorIdx));
      let colorIdx = 0;
      while (used.has(colorIdx)) colorIdx++;
      this.series.push({
        addr, meta, colorIdx,
        axisMode: opts.axisMode === 'solo' ? 'solo' : 'auto',
        visible: opts.visible !== false,
        periodMs: opts.periodMs || undefined,
      });
      this.rebuildLegend();
      return { ok: true };
    }

    removeSeries(addr) {
      const i = this.series.findIndex((s) => s.addr === addr);
      if (i < 0) return;
      this.app.release(addr);
      this.series.splice(i, 1);
      this.rebuildLegend();
      this.app.onChange();
    }

    // ---------- Légende ------------------------------------------------
    rebuildLegend() {
      closePopover();
      this.legendEl.innerHTML = '';
      for (const s of this.series) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (s.visible ? '' : ' off');
        chip.setAttribute('role', 'listitem');
        chip.dataset.addr = s.addr;
        chip.innerHTML =
          '<i class="sw"></i>' +
          '<span class="chip-addr"></span>' +
          '<span class="chip-val">—</span>' +
          '<span class="chip-axis"></span>';
        chip.querySelector('.chip-addr').textContent = s.addr;
        chip.querySelector('.sw').style.background = DW.seriesColor(s.colorIdx);
        chip.title = s.meta.label + (s.meta.unit ? ' (' + s.meta.unit + ')' : '') +
          ' · rafr. ' + (s.periodMs || DW.CONFIG.defaultPeriodMs) + ' ms';
        chip.addEventListener('click', (e) => this.openMenu(s, chip, e));
        this.legendEl.appendChild(chip);
      }
      this.hintEl.classList.toggle('hide', this.series.length > 0);
    }

    openMenu(s, chip) {
      if (popOwner === s) { closePopover(); return; }
      closePopover();
      popOwner = s;
      popEl = document.createElement('div');
      popEl.className = 'popmenu';
      const mk = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = label;
        b.addEventListener('click', () => { closePopover(); fn(); });
        popEl.appendChild(b);
        return b;
      };
      mk(s.visible ? 'Masquer la courbe' : 'Afficher la courbe', () => {
        s.visible = !s.visible;
        this.rebuildLegend();
        this.app.onChange();
      });
      mk((s.axisMode === 'solo' ? '✓ ' : '') + 'Échelle dédiée', () => {
        s.axisMode = s.axisMode === 'solo' ? 'auto' : 'solo';
        this.app.onChange();
        this.app.toast(s.addr + ' : ' + (s.axisMode === 'solo' ? 'échelle dédiée' : 'échelle partagée par unité') + '.');
      });
      const del = mk('Retirer du graphique', () => this.removeSeries(s.addr));
      del.classList.add('danger');
      document.body.appendChild(popEl);
      const r = chip.getBoundingClientRect();
      const pw = popEl.offsetWidth;
      let x = Math.min(r.left, window.innerWidth - pw - 8);
      popEl.style.left = Math.max(8, x) + 'px';
      popEl.style.top = (r.bottom + 6 + window.scrollY) + 'px';
    }

    /** Mise à jour des valeurs vivantes de la légende (~5 Hz). */
    updateLive() {
      const chips = this.legendEl.children;
      for (let i = 0; i < this.series.length && i < chips.length; i++) {
        const s = this.series[i];
        const last = DW.source.latest(s.addr);
        const valEl = chips[i].querySelector('.chip-val');
        valEl.textContent = last ? DW.fmtVal(last.v, s.meta) + (s.meta.unit ? ' ' + s.meta.unit : '') : '—';
        const axEl = chips[i].querySelector('.chip-axis');
        axEl.textContent = (this._axisCount > 1 && this._axisBadge && this._axisBadge[s.addr]) || '';
      }
    }

    // ---------- Échelles ----------------------------------------------
    axisKey(s) {
      if (s.axisMode === 'solo') return 'solo:' + s.addr;
      if (s.meta.kind === 'bit') return 'bool';
      if (s.meta.unit) return 'u:' + s.meta.unit;
      return s.meta.kind === 'word' ? 'mot' : 'sans-unité';
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
            series: [], min: Infinity, max: -Infinity, isBool: s.meta.kind === 'bit',
          };
          groups.set(key, g);
        }
        g.series.push(s);
        if (g.isBool && s.meta.kind !== 'bit') g.isBool = false;
      }
      const list = [...groups.values()];
      for (const g of list) {
        if (g.isBool) { g.min = -0.07; g.max = 1.07; g.ticks = [0, 1]; continue; }
        for (const s of g.series) {
          const d = DW.source.data(s.addr);
          const [i0, i1] = rangeIdx(d.ts, tStart, tEnd);
          for (let i = i0; i <= i1; i++) {
            const v = d.vs[i];
            if (v < g.min) g.min = v;
            if (v > g.max) g.max = v;
          }
        }
        if (!isFinite(g.min)) { g.min = 0; g.max = 1; }
        if (g.min === g.max) {
          const e = Math.max(Math.abs(g.min) * 0.05, 0.5);
          g.min -= e; g.max += e;
        }
        const pad = (g.max - g.min) * 0.07;
        g.min -= pad; g.max += pad;
        const step = niceStep((g.max - g.min) / 4);
        g.tickStep = step;
        g.ticks = [];
        for (let v = Math.ceil(g.min / step) * step; v <= g.max + 1e-9; v += step) {
          g.ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
        }
      }
      // Chaque groupe garde la couleur de sa courbe s'il n'en porte qu'une
      for (const g of list) {
        g.color = g.series.length === 1 ? DW.seriesColor(g.series[0].colorIdx) : ink().muted;
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

      const tEnd = this.paused ? this.pausedAt : DW.source.now();
      const tStart = tEnd - this.windowS;
      const groups = this.computeGroups(tStart, tEnd);

      // Badges d'échelle pour la légende (É1…É4, É· = sans règle visible)
      this._axisBadge = {};
      this._axisCount = groups.length;
      groups.forEach((g, i) => {
        const tag = i < MAX_AXES ? 'É' + (i + 1) : 'É·';
        for (const s of g.series) this._axisBadge[s.addr] = tag;
      });

      // Répartition des axes : g0→gauche, g1→droite, g2→gauche ext., g3→droite ext.
      const shown = groups.slice(0, MAX_AXES);
      const leftAxes = shown.filter((_, i) => i % 2 === 0);
      const rightAxes = shown.filter((_, i) => i % 2 === 1);
      const mL = 8 + (leftAxes.length ? leftAxes.length * AXIS_W : 26);
      const mR = 8 + rightAxes.length * AXIS_W;
      const mT = 18, mB = 22;
      const pw = Math.max(10, cw - mL - mR), ph = Math.max(10, chh - mT - mB);
      const X = (t) => mL + ((t - tStart) / this.windowS) * pw;
      const yOf = (g) => (v) => mT + ph * (1 - (v - g.min) / (g.max - g.min));

      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

      // Grille temporelle
      const tickS = niceTimeStep(this.windowS / 5);
      ctx.strokeStyle = IK.line;
      ctx.fillStyle = IK.faint;
      ctx.lineWidth = 1;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let k = 0; k * tickS <= this.windowS; k++) {
        const t = tEnd - k * tickS;
        const x = Math.round(X(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + ph); ctx.stroke();
        ctx.fillText(fmtTimeTick(k * tickS, this.windowS), Math.min(Math.max(x, mL + 12), cw - mR - 14), mT + ph + 6);
      }

      // Grille horizontale : celle du premier groupe uniquement
      if (shown[0]) {
        const g0 = shown[0], y0 = yOf(g0);
        ctx.strokeStyle = IK.line;
        for (const v of g0.ticks) {
          const y = Math.round(y0(v)) + 0.5;
          ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + pw, y); ctx.stroke();
        }
      }

      // Règles d'axes
      shown.forEach((g, i) => {
        const side = i % 2 === 0 ? 'L' : 'R';
        const slot = Math.floor(i / 2);
        const xr = side === 'L' ? mL - slot * AXIS_W : cw - mR + slot * AXIS_W;
        const yG = yOf(g);
        ctx.strokeStyle = g.color; ctx.globalAlpha = 0.55; ctx.lineWidth = 1;
        const xl = Math.round(xr) + (side === 'L' ? -0.5 : 0.5);
        ctx.beginPath(); ctx.moveTo(xl, mT); ctx.lineTo(xl, mT + ph); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = g.color;
        ctx.textAlign = side === 'L' ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        const tx = side === 'L' ? xr - 4 : xr + 4;
        for (const v of g.ticks) ctx.fillText(fmtAxisTick(v, g.tickStep || 1), tx, yG(v));
        if (g.label) {
          ctx.textBaseline = 'bottom';
          ctx.fillText(g.label, tx, mT - 4);
        }
      });

      // Groupes sans règle (au-delà de MAX_AXES) : mis à l'échelle quand même
      // Courbes
      ctx.save();
      ctx.beginPath(); ctx.rect(mL, mT - 4, pw, ph + 8); ctx.clip();
      for (const g of groups) {
        const yG = yOf(g);
        for (const s of g.series) {
          const d = DW.source.data(s.addr);
          const [i0, i1] = rangeIdx(d.ts, tStart, tEnd);
          if (i1 < i0) continue;
          const discrete = s.meta.kind === 'bit' || s.meta.kind === 'word';
          ctx.strokeStyle = DW.seriesColor(s.colorIdx);
          ctx.lineWidth = 2;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          drawPath(ctx, d.ts, d.vs, i0, i1, X, yG, discrete, pw);
          // Point d'extrémité accentué
          const xe = X(d.ts[i1]), ye = yG(d.vs[i1]);
          ctx.beginPath(); ctx.arc(xe, ye, 3, 0, Math.PI * 2);
          ctx.fillStyle = DW.seriesColor(s.colorIdx); ctx.fill();
        }
      }
      ctx.restore();

      // Curseur d'inspection
      if (this.cursor && groups.length) {
        this.drawCursor(ctx, groups, tStart, tEnd, X, yOf, mL, mT, pw, ph);
      } else {
        this.tipEl.classList.add('hide');
      }
    }

    drawCursor(ctx, groups, tStart, tEnd, X, yOf, mL, mT, pw, ph) {
      const IK = ink();
      const x = Math.min(Math.max(this.cursor.x, mL), mL + pw);
      const tCur = tStart + ((x - mL) / pw) * this.windowS;
      ctx.strokeStyle = IK.muted;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, mT); ctx.lineTo(x + 0.5, mT + ph); ctx.stroke();
      ctx.setLineDash([]);

      let rows = '';
      for (const g of groups) {
        const yG = yOf(g);
        for (const s of g.series) {
          const d = DW.source.data(s.addr);
          const i = nearestIdx(d.ts, tCur);
          if (i < 0) continue;
          const v = d.vs[i];
          const y = yG(v);
          ctx.beginPath(); ctx.arc(X(d.ts[i]), y, 4, 0, Math.PI * 2);
          ctx.strokeStyle = DW.seriesColor(s.colorIdx); ctx.lineWidth = 2; ctx.stroke();
          rows += '<div class="tip-row"><i style="background:' + DW.seriesColor(s.colorIdx) + '"></i>' +
            '<span class="tip-addr">' + escapeHtml(s.addr) + '</span>' +
            '<b>' + DW.fmtVal(v, s.meta) + (s.meta.unit ? ' ' + escapeHtml(s.meta.unit) : '') + '</b></div>';
        }
      }
      const dt = tEnd - tCur;
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
        windowS: this.windowS,
        series: this.series.map((s) => ({ addr: s.addr, axisMode: s.axisMode, visible: s.visible, periodMs: s.periodMs })),
      };
    }

    destroy() {
      for (const s of this.series) this.app.release(s.addr);
      this.series = [];
      closePopover();
      this.root.remove();
    }
  }

  // ---------- Aides géométriques --------------------------------------
  /** Indices [i0, i1] couvrant [tStart, tEnd] (i0 recule d'un cran pour la continuité). */
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
    if (n <= plotW * 2 || discrete) {
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
