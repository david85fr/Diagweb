/* Diagweb — logique applicative & interface.
 *
 * Espace de travail multi-onglets : chaque onglet porte sa propre
 * configuration (tableau numérique + graphiques) et, en option, une
 * journalisation de données. Les abonnements des onglets inactifs restent
 * vivants : l'historique des courbes n'est pas perdu en changeant d'onglet.
 */
(function () {
  "use strict";
  const DW = window.DW;
  const CFG = DW.CONFIG;
  const $ = (id) => document.getElementById(id);

  const LOG_MAX_ROWS = 100000;   // plafond mémoire du journal par onglet

  // ---------- État ----------------------------------------------------
  // tab : { id, name, table:[{addr,meta,periodMs}], charts:[Chart],
  //         chartSeq, paneEl, tableCardEl, tableRowsEl, tableCountEl,
  //         chartsGridEl, log }
  const state = { tabs: [], active: null, tabSeq: 0 };

  // ---------- Notifications -------------------------------------------
  function toast(msg, type) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'err' ? ' err' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.classList.add('gone'), type === 'err' ? 5200 : 3200);
    setTimeout(() => el.remove(), type === 'err' ? 5600 : 3600);
  }

  // ---------- Sauvegarde de session (debounce) ------------------------
  let saveTimer = null;
  function onChange() {
    updateEmptyState();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DW.store.saveSession(serializeSession()), 500);
  }

  // ---------- API passée aux graphiques -------------------------------
  const appApi = {
    acquire(addr, periodMs) {
      const rec = DW.source.subscribe(addr, { periodMs });
      return rec ? rec.meta : null;
    },
    release(addr) { DW.source.unsubscribe(addr); },
    onChange,
    toast,
    removeChart(chart) {
      for (const tab of state.tabs) {
        const i = tab.charts.indexOf(chart);
        if (i >= 0) { tab.charts.splice(i, 1); break; }
      }
      chart.destroy();
      refreshTargets();
      onChange();
    },
    refreshTargets,
    /** Onglets autres que l'actif (menus « Déplacer vers »). */
    otherTabs: () => state.tabs.filter((t) => t !== state.active),
    moveChartToTab,
    duplicateChart,
  };

  // ---------- Onglets --------------------------------------------------
  function createTab(name, data, logOpts) {
    state.tabSeq++;
    const pane = document.createElement('div');
    pane.className = 'tabpane';
    pane.innerHTML =
      '<section class="card table-card hide">' +
        '<h3><span class="drag-handle" draggable="true" ' +
          'title="Glisser le tableau vers un onglet ou une autre fenêtre">⠿</span>' +
          'Valeurs numériques <span class="tcount"></span></h3>' +
        '<div class="trows"></div>' +
      '</section>' +
      '<div class="charts-grid"></div>';
    $('panes').appendChild(pane);

    const tab = {
      id: 't' + state.tabSeq,
      name: name || 'Onglet ' + state.tabSeq,
      table: [], charts: [], chartSeq: 0,
      paneEl: pane,
      tableCardEl: pane.querySelector('.table-card'),
      tableRowsEl: pane.querySelector('.trows'),
      tableCountEl: pane.querySelector('.tcount'),
      chartsGridEl: pane.querySelector('.charts-grid'),
      log: {
        enabled: false, dest: 'browser',
        rows: [], lastT: {}, enableT: 0,
        truncated: false, ctlWarned: false,
        sentIdx: 0,        // lignes déjà transmises au contrôleur
      },
    };
    // Le tableau numérique entier (avec ses variables) est déplaçable
    pane.querySelector('.table-card .drag-handle').addEventListener('dragstart', (e) => {
      if (!DW.dnd || !tab.table.length) { e.preventDefault(); return; }
      DW.dnd.startDrag(e, { kind: 'table', table: serializeTable(tab) }, () => {
        for (const entry of [...tab.table]) removeFromTable(tab, entry.addr);
      });
    });

    state.tabs.push(tab);
    switchTab(tab);
    if (data) applyConfigToActive(data);
    if (logOpts) {
      tab.log.dest = logOpts.dest === 'controller' ? 'controller' : 'browser';
      if (logOpts.enabled) startLogging(tab);
    }
    rebuildTabbar();
    onChange();
    return tab;
  }

  function switchTab(tab) {
    if (state.active === tab) return;
    if (state.active) state.active.paneEl.classList.remove('on');
    state.active = tab;
    tab.paneEl.classList.add('on');
    hideSuggest();
    rebuildTabbar();
    refreshTargets();
    updatePauseBtn();
    updateLogUi();
    updateEmptyState();
  }

  function closeTab(tab) {
    const i = state.tabs.indexOf(tab);
    if (i < 0) return;
    clearTab(tab);
    tab.paneEl.remove();
    state.tabs.splice(i, 1);
    if (!state.tabs.length) {
      createTab();
    } else if (state.active === tab) {
      state.active = null;
      switchTab(state.tabs[Math.max(0, i - 1)]);
    }
    rebuildTabbar();
    onChange();
  }

  function clearTab(tab) {
    for (const c of [...tab.charts]) c.destroy();
    tab.charts = [];
    for (const e of tab.table) appApi.release(e.addr);
    tab.table = [];
    tab.chartSeq = 0;
    renderTable(tab);
  }

  function rebuildTabbar() {
    const bar = $('tabs');
    bar.innerHTML = '';
    for (const tab of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab === state.active ? ' on' : '');
      el.setAttribute('role', 'tab');
      el._tab = tab;   // cible de dépôt (voir dnd.js)
      el.innerHTML =
        '<span class="tab-name"></span>' +
        (tab.log.enabled ? '<i class="recdot" title="Journalisation en cours"></i>' : '') +
        '<span class="tab-close" title="Fermer l’onglet">✕</span>';
      const nameEl = el.querySelector('.tab-name');
      nameEl.textContent = tab.name;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.tab-close')) { closeTab(tab); return; }
        if (tab === state.active) { startRename(tab, nameEl); return; }
        switchTab(tab);
      });
      bar.appendChild(el);
    }
  }

  /** Renommage en place : le libellé de l'onglet actif devient un champ. */
  function startRename(tab, nameEl) {
    if (nameEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'tab-name-input';
    input.value = tab.name;
    input.maxLength = 40;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      tab.name = input.value.trim() || tab.name;
      // Remplacement sur place : reconstruire la barre ici détacherait
      // l'onglet sous le pointeur et avalerait le clic en cours.
      nameEl.textContent = tab.name;
      refreshTargets();
      onChange();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = tab.name; input.blur(); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // ---------- Tableau numérique (onglet actif) ------------------------
  function inTable(tab, addr) { return tab.table.some((e) => e.addr === addr); }

  function addToTable(addr, periodMs) {
    const tab = state.active;
    if (inTable(tab, addr)) return { ok: false, error: addr + ' est déjà dans le tableau de cet onglet.' };
    const meta = appApi.acquire(addr, periodMs);
    if (!meta) return { ok: false, error: 'Adresse invalide : ' + addr };
    tab.table.push({ addr, meta, periodMs: periodMs || undefined });
    renderTable(tab);
    return { ok: true };
  }

  function removeFromTable(tab, addr) {
    const i = tab.table.findIndex((e) => e.addr === addr);
    if (i < 0) return;
    appApi.release(addr);
    tab.table.splice(i, 1);
    renderTable(tab);
    onChange();
  }

  function renderTable(tab) {
    const rows = tab.tableRowsEl;
    rows.innerHTML = '';
    for (const e of tab.table) {
      const row = document.createElement('div');
      row.className = 'vrow';
      row.dataset.addr = e.addr;
      // Chaque variable peut être glissée seule vers un autre onglet/fenêtre
      row.draggable = true;
      row.addEventListener('dragstart', (ev) => {
        if (!DW.dnd) { ev.preventDefault(); return; }
        DW.dnd.startDrag(ev, { kind: 'vars', table: [{ addr: e.addr, periodMs: e.periodMs }] },
          () => removeFromTable(tab, e.addr));
      });
      row.innerHTML =
        '<span class="badge fam-' + e.meta.family + '">' + e.meta.family + '</span>' +
        '<div class="v-id"><span class="v-addr"></span><span class="v-label"></span></div>' +
        '<div class="v-val"><b class="val">—</b><span class="v-unit"></span><span class="v-trend"></span></div>' +
        '<button class="v-del" type="button" title="Retirer du tableau">✕</button>';
      row.querySelector('.v-addr').textContent = e.addr;
      row.querySelector('.v-label').textContent = e.meta.label +
        (e.periodMs && e.periodMs !== CFG.defaultPeriodMs ? ' · rafr. ' + e.periodMs + ' ms' : '');
      row.querySelector('.v-unit').textContent = e.meta.unit || '';
      row.querySelector('.v-del').addEventListener('click', () => removeFromTable(tab, e.addr));
      rows.appendChild(row);
    }
    tab.tableCountEl.textContent = tab.table.length ? tab.table.length + ' variable' + (tab.table.length > 1 ? 's' : '') : '';
    tab.tableCardEl.classList.toggle('hide', tab.table.length === 0);
    updateEmptyState();
  }

  function updateTableValues() {
    const tab = state.active;
    if (!tab) return;
    const rows = tab.tableRowsEl.children;
    const nowT = DW.source.now();
    for (let i = 0; i < tab.table.length && i < rows.length; i++) {
      const e = tab.table[i];
      const last = DW.source.latest(e.addr);
      const valEl = rows[i].querySelector('.val');
      if (!last) { valEl.textContent = '—'; continue; }
      // Flash : la variable était immobile depuis ≥ 2 s et vient de changer
      if (e._lastV === undefined) {
        e._lastV = last.v; e._lastChangeT = nowT;
      } else if (last.v !== e._lastV) {
        if (nowT - e._lastChangeT >= 2) {
          const row = rows[i];
          row.classList.remove('vflash');
          void row.offsetWidth; // relance l'animation
          row.classList.add('vflash');
        }
        e._lastV = last.v; e._lastChangeT = nowT;
      }
      if (e.meta.kind === 'bit') {
        const on = last.v >= 0.5;
        valEl.innerHTML = '<i class="led' + (on ? ' on' : '') + '"></i>' + (on ? '1' : '0');
      } else if (e.meta.family === 'MB') {
        const n = Math.round(last.v) & 0xFFFF;
        valEl.innerHTML = DW.fmtVal(last.v, e.meta) +
          ' <span class="v-hex">0x' + n.toString(16).toUpperCase().padStart(4, '0') + '</span>';
      } else {
        valEl.textContent = DW.fmtVal(last.v, e.meta);
      }
      // Tendance sur ~2,5 s
      const trendEl = rows[i].querySelector('.v-trend');
      const past = DW.source.past(e.addr, 2.5);
      if (past == null || e.meta.kind === 'bit') { trendEl.textContent = ''; trendEl.className = 'v-trend'; continue; }
      const eps = Math.max(Math.abs(last.v) * 0.004, 1e-6);
      const d = last.v - past;
      trendEl.textContent = d > eps ? '↗' : d < -eps ? '↘' : '→';
      trendEl.className = 'v-trend ' + (d > eps ? 'up' : d < -eps ? 'down' : 'flat');
    }
  }

  // ---------- Graphiques ------------------------------------------------
  /** Crée un graphique dans `dest` (onglet actif par défaut, sans y basculer). */
  function createChart(opts, dest) {
    const tab = dest || state.active;
    if (tab.charts.length >= CFG.maxCharts) {
      toast('Limite de ' + CFG.maxCharts + ' graphiques par onglet atteinte.', 'err');
      return null;
    }
    opts = opts || {};
    tab.chartSeq++;
    const chart = new DW.Chart(appApi, {
      title: opts.title || 'Graphique ' + tab.chartSeq,
      windowS: opts.windowS,
      heightMode: opts.heightMode,
    });
    tab.charts.push(chart);
    tab.chartsGridEl.appendChild(chart.root);
    if (tab === state.active) refreshTargets();
    onChange();
    return chart;
  }

  // ---------- Cible d'ajout -------------------------------------------
  function refreshTargets() {
    const sel = $('targetSel');
    const prev = sel.value;
    sel.innerHTML = '';
    const opt = (v, label) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      sel.appendChild(o);
    };
    opt('table', '→ Tableau numérique');
    if (state.active) for (const c of state.active.charts) opt('chart:' + c.id, '→ ' + c.title);
    opt('new', '→ Nouveau graphique');
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'table';
  }

  // ---------- Ajout d'une variable ------------------------------------
  function addVariable(rawAddr) {
    const p = DW.parseAddr(rawAddr != null ? rawAddr : $('searchInput').value);
    if (!p.ok) { toast(p.error, 'err'); return false; }
    const target = $('targetSel').value;
    const periodMs = parseInt($('periodSel').value, 10) || CFG.defaultPeriodMs;
    let destLabel = '';
    if (target === 'table') {
      const r = addToTable(p.addr, periodMs);
      if (!r.ok) { toast(r.error, 'err'); return false; }
      destLabel = 'Tableau numérique';
    } else {
      let chart = null;
      if (target === 'new') {
        chart = createChart();
        if (!chart) return false;
      } else {
        chart = state.active.charts.find((c) => 'chart:' + c.id === target);
        if (!chart) { refreshTargets(); toast('Ce graphique n’existe plus.', 'err'); return false; }
      }
      const r = chart.addSeries(p.addr, { periodMs });
      if (!r.ok) {
        toast(r.error, 'err');
        if (target === 'new') appApi.removeChart(chart);
        return false;
      }
      if (target === 'new') $('targetSel').value = 'chart:' + chart.id;
      destLabel = chart.title;
    }
    $('searchInput').value = '';
    hideSuggest();
    onChange();
    toast(p.addr + ' → ' + destLabel);
    return true;
  }

  // ---------- Autocomplétion ------------------------------------------
  let sugIndex = -1;
  let famFilter = 'all';   // 'all' | 'PLC' (I/Q/M/S) | 'MB' | 'CAPI'
  const FAM_FILTERS = [
    ['all', 'Toutes'],
    ['PLC', 'PLC'],
    ['MB', 'Modbus'],
    ['CAPI', 'Simulink'],
  ];
  function matchFilter(family) {
    if (famFilter === 'all') return true;
    if (famFilter === 'PLC') return family === 'I' || family === 'Q' || family === 'M' || family === 'S';
    return family === famFilter;
  }
  function hideSuggest() { $('suggestBox').classList.add('hide'); sugIndex = -1; }

  function buildSugRow(entry) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sug';
    b.innerHTML =
      '<span class="badge fam-' + entry.family + '">' + entry.family + '</span>' +
      '<span class="sug-addr"></span><span class="sug-label"></span><span class="sug-unit"></span>';
    b.querySelector('.sug-addr').textContent = entry.addr;
    b.querySelector('.sug-label').textContent = entry.label || '';
    b.querySelector('.sug-unit').textContent = entry.unit || '';
    // pointerdown pour devancer le blur de l'input
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      $('searchInput').value = entry.addr;
      addVariable(entry.addr);
    });
    return b;
  }

  function catalogWithFamily() {
    return DW.CATALOG.map((e) => {
      const p = DW.parseAddr(e.addr);
      return Object.assign({ family: p.ok ? p.family : 'CAPI' }, e);
    });
  }
  const CATALOG_F = catalogWithFamily();

  function updateSuggest() {
    const box = $('suggestBox');
    const q = $('searchInput').value.trim().toLowerCase();
    box.innerHTML = '';

    // Filtres par type de variable (PLC / Modbus / Simulink)
    const bar = document.createElement('div');
    bar.className = 'sug-filters';
    for (const [key, label] of FAM_FILTERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fbtn' + (famFilter === key ? ' on' : '');
      b.textContent = label;
      // pointerdown pour ne pas faire perdre le focus à l'input
      b.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        famFilter = key;
        updateSuggest();
      });
      bar.appendChild(b);
    }
    box.appendChild(bar);

    const pool = CATALOG_F.filter((e) => matchFilter(e.family));
    let list;
    if (!q) {
      const help = document.createElement('div');
      help.className = 'sug-help';
      help.innerHTML = 'Formats : <code>I1.2.3.4</code> <code>Q14.15</code> <code>M1.14</code> ' +
        '<code>S0.4</code> <code>MB414</code> <code>Modele.signal</code>';
      box.appendChild(help);
      list = pool.slice(0, 8);
    } else {
      const starts = [], contains = [];
      for (const e of pool) {
        const a = e.addr.toLowerCase(), l = (e.label || '').toLowerCase();
        if (a.startsWith(q)) starts.push(e);
        else if (a.includes(q) || l.includes(q)) contains.push(e);
      }
      list = starts.concat(contains).slice(0, 9);
    }
    for (const e of list) box.appendChild(buildSugRow(e));
    if (q) {
      const p = DW.parseAddr(q);
      if (p.ok && matchFilter(p.family) && !list.some((e) => e.addr.toUpperCase() === p.addr.toUpperCase())) {
        const e = { addr: p.addr, family: p.family, label: DW.FAMILIES[p.family].label + ' — hors catalogue', unit: '' };
        box.appendChild(buildSugRow(e));
        list.push(e);
      }
    }
    if (!list.length) {
      const none = document.createElement('div');
      none.className = 'sug-none';
      none.textContent = q ? 'Aucune variable ne correspond à ce filtre.' : 'Aucune variable dans ce filtre.';
      box.appendChild(none);
    }
    box.classList.remove('hide');
    sugIndex = -1;
  }

  function moveSug(delta) {
    const box = $('suggestBox');
    const rows = [...box.querySelectorAll('.sug')];
    if (!rows.length) return;
    sugIndex = (sugIndex + delta + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle('sel', i === sugIndex));
    rows[sugIndex].scrollIntoView({ block: 'nearest' });
  }

  // ---------- Sérialisation -------------------------------------------
  function serializeTable(tab) {
    return tab.table.map((e) => ({ addr: e.addr, periodMs: e.periodMs }));
  }

  function serializeConfig(tab) {
    return {
      version: 1,
      table: serializeTable(tab),
      charts: tab.charts.map((c) => c.serialize()),
    };
  }

  // ---------- Déplacement de widgets (onglets, fenêtres) ---------------
  /**
   * Crée un graphique depuis une configuration sérialisée, dans `tab`.
   * `place` ({anchorEl, after}) permet de l'insérer à un rang précis.
   */
  function addChartFromConfig(cfg, tab, place) {
    const target = tab || state.active;
    if (target.charts.length >= CFG.maxCharts) {
      toast('Limite de ' + CFG.maxCharts + ' graphiques par onglet atteinte.', 'err');
      return null;
    }
    // On ne bascule pas d'onglet : en multi-écran, l'utilisateur range des
    // widgets sans quitter ce qu'il regarde (un message indique la cible).
    const chart = createChart({ title: cfg.title, windowS: cfg.windowS, heightMode: cfg.heightMode }, target);
    if (chart) {
      for (const s of cfg.series || []) {
        const p = DW.parseAddr(s.addr);
        if (p.ok) {
          chart.addSeries(p.addr, {
            axisMode: s.axisMode, visible: s.visible !== false,
            periodMs: s.periodMs, offsetY: s.offsetY,
            colorIdx: s.colorIdx, color: s.color,
          });
        }
      }
      if (place && place.anchorEl) placeChart(chart, target, place);
    }
    return chart;
  }

  /** Range un graphique avant / après une carte de la même grille. */
  function placeChart(chart, tab, place) {
    const anchor = place.anchorEl;
    if (!anchor || anchor === chart.root || !tab.chartsGridEl.contains(anchor)) return;
    const i = tab.charts.indexOf(chart);
    if (i >= 0) tab.charts.splice(i, 1);
    const at = tab.charts.findIndex((c) => c.root === anchor);
    const insert = at < 0 ? tab.charts.length : at + (place.after ? 1 : 0);
    tab.charts.splice(insert, 0, chart);
    if (place.after) anchor.after(chart.root);
    else anchor.before(chart.root);
    refreshTargets();
    onChange();
  }

  /** Duplique un graphique (courbes, échelles, couleurs) juste après lui. */
  function duplicateChart(chart) {
    const tab = state.tabs.find((t) => t.charts.includes(chart)) || state.active;
    const cfg = chart.serialize();
    cfg.title = cfg.title + ' (copie)';
    const copy = addChartFromConfig(cfg, tab, { anchorEl: chart.root, after: true });
    if (copy) toast('« ' + cfg.title +' » créé.');
    return copy;
  }

  /** Ajoute des variables au tableau de `tab` ; renvoie le nombre ajouté. */
  function addVarsToTab(list, tab) {
    const target = tab || state.active;
    let n = 0;
    for (const entry of list || []) {
      const addr = typeof entry === 'string' ? entry : entry.addr;
      const periodMs = typeof entry === 'string' ? undefined : entry.periodMs;
      const p = DW.parseAddr(addr);
      if (!p.ok || inTable(target, p.addr)) continue;
      const meta = appApi.acquire(p.addr, periodMs);
      if (!meta) continue;
      target.table.push({ addr: p.addr, meta, periodMs: periodMs || undefined });
      n++;
    }
    if (n) renderTable(target);
    return n;
  }

  function moveChartToTab(chart, tab) {
    const cfg = chart.serialize();
    appApi.removeChart(chart);
    const created = addChartFromConfig(cfg, tab);
    if (created) toast('« ' + cfg.title + ' » déplacé vers « ' + tab.name + ' ».');
    onChange();
  }

  /**
   * Réception d'un widget déposé (glisser-déposer ou nouvelle fenêtre).
   * @returns 'reordered' si le widget était déjà là et n'a été que rangé,
   *          true s'il a été créé, false sinon.
   */
  function receiveWidget(o, tab, place, sameWindow) {
    const target = tab || state.active;
    if (o.kind === 'chart' && o.chart) {
      // Graphique déjà présent dans cet onglet : simple réorganisation
      if (sameWindow && o.chartId) {
        const existing = target.charts.find((c) => c.id === o.chartId);
        if (existing) {
          if (place) placeChart(existing, target, place);
          return 'reordered';
        }
      }
      if (!addChartFromConfig(o.chart, target, place)) return false;
    } else if ((o.kind === 'table' || o.kind === 'vars') && o.table) {
      const n = addVarsToTab(o.table, target);
      if (!n) { toast('Ces variables sont déjà présentes dans « ' + target.name + ' ».', 'err'); return false; }
    } else {
      return false;
    }
    toast(DW.dnd.describe(o) + ' → onglet « ' + target.name + ' ».');
    refreshTargets();
    onChange();
    return true;
  }

  function serializeSession() {
    return {
      version: 2,
      active: Math.max(0, state.tabs.indexOf(state.active)),
      tabs: state.tabs.map((tab) => ({
        name: tab.name,
        log: { enabled: tab.log.enabled, dest: tab.log.dest },
        data: serializeConfig(tab),
      })),
    };
  }

  /** Applique une configuration (format v1) dans l'onglet actif (vidé avant). */
  function applyConfigToActive(data) {
    const tab = state.active;
    clearTab(tab);
    for (const entry of data.table || []) {
      // Rétro-compatibilité : entrée sous forme de chaîne (format initial)
      const addr = typeof entry === 'string' ? entry : entry.addr;
      const periodMs = typeof entry === 'string' ? undefined : entry.periodMs;
      const p = DW.parseAddr(addr);
      if (p.ok) addToTable(p.addr, periodMs);
    }
    for (const c of data.charts || []) {
      const chart = createChart({ title: c.title, windowS: c.windowS, heightMode: c.heightMode });
      if (!chart) break;
      for (const s of c.series || []) {
        const p = DW.parseAddr(s.addr);
        if (p.ok) {
          chart.addSeries(p.addr, {
            axisMode: s.axisMode, visible: s.visible !== false,
            periodMs: s.periodMs, offsetY: s.offsetY,
            colorIdx: s.colorIdx, color: s.color,
          });
        }
      }
    }
    refreshTargets();
    updateEmptyState();
    onChange();
  }

  // ---------- Journalisation des données ------------------------------
  function tabAddrs(tab) {
    const set = new Set();
    for (const e of tab.table) set.add(e.addr);
    for (const c of tab.charts) for (const s of c.series) set.add(s.addr);
    return set;
  }

  function startLogging(tab) {
    tab.log.enabled = true;
    tab.log.enableT = DW.source.now();
    tab.log.lastT = {};
    rebuildTabbar();
    updateLogUi();
    onChange();
  }
  function stopLogging(tab) {
    tab.log.enabled = false;
    rebuildTabbar();
    updateLogUi();
    onChange();
  }

  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; }
    return lo;
  }

  function logTick() {
    for (const tab of state.tabs) {
      const lg = tab.log;
      if (!lg.enabled) continue;
      let appended = 0;
      for (const addr of tabAddrs(tab)) {
        const d = DW.source.data(addr);
        if (!d.ts.length) continue;
        const from = (addr in lg.lastT) ? lg.lastT[addr] : lg.enableT;
        const i0 = lowerBound(d.ts, from);
        for (let i = i0; i < d.ts.length; i++) {
          lg.rows.push([d.ts[i], addr, d.vs[i]]);
        }
        if (i0 < d.ts.length) { lg.lastT[addr] = d.ts[d.ts.length - 1]; appended += d.ts.length - i0; }
      }
      if (lg.rows.length > LOG_MAX_ROWS) {
        const dropped = lg.rows.length - LOG_MAX_ROWS;
        lg.rows.splice(0, dropped);
        lg.sentIdx = Math.max(0, lg.sentIdx - dropped);
        lg.truncated = true;
      }
      // Destination « contrôleur » : envoi des lignes au serveur de diagnostic
      // (POST /api/datalog) ; en cas d'échec, le tampon navigateur fait office
      // de repli et l'utilisateur est averti une fois.
      if (lg.dest === 'controller' && lg.rows.length > lg.sentIdx) {
        const batch = lg.rows.slice(lg.sentIdx);
        lg.sentIdx = lg.rows.length;
        fetch('/api/datalog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tab: tab.name, rows: batch }),
        }).then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          lg.ctlWarned = false;
        }).catch(() => {
          if (lg.ctlWarned) return;
          lg.ctlWarned = true;
          toast('Serveur de diagnostic injoignable — le journal reste en mémoire du navigateur.', 'err');
        });
      }
    }
  }
  setInterval(logTick, 500);

  function openLogModal() {
    const tab = state.active;
    const lg = tab.log;
    const root = $('modalRoot');
    root.innerHTML = '';
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-label="Journalisation">' +
        '<header class="m-head"><h3>Journal de données — <span id="logTabName"></span></h3>' +
        '<button class="iconbtn m-close" type="button" title="Fermer">✕</button></header>' +
        '<div class="log-opts">' +
          '<label><input type="radio" name="logdest" value="browser"> Navigateur (mémoire de la page)</label>' +
          '<label><input type="radio" name="logdest" value="controller"> Contrôleur (back-end à venir)' +
          ' <span class="opt-note">repli navigateur si injoignable</span></label>' +
        '</div>' +
        '<div class="log-status" id="logStatus">—</div>' +
        '<div class="m-actions">' +
          '<button class="btn primary" id="logToggle" type="button"></button>' +
          '<button class="btn" id="logDlCsv" type="button">Télécharger CSV</button>' +
          '<button class="btn" id="logDlJson" type="button">Télécharger JSON</button>' +
          '<button class="btn" id="logClear" type="button">Vider</button>' +
        '</div>' +
        '<p class="m-note">Le journal enregistre chaque échantillon des variables de l’onglet ' +
        '(période propre à chaque variable), dans la limite de 100 000 lignes (les plus anciennes ' +
        'sont éliminées). Il est conservé en mémoire : téléchargez-le avant de fermer ou recharger la page.</p>' +
      '</div>';
    root.appendChild(back);
    back.querySelector('#logTabName').textContent = tab.name;

    const close = () => { clearInterval(statusTimer); root.innerHTML = ''; };
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    back.querySelector('.m-close').addEventListener('click', close);

    for (const r of back.querySelectorAll('input[name="logdest"]')) {
      r.checked = r.value === lg.dest;
      r.addEventListener('change', () => {
        lg.dest = r.value;
        lg.ctlWarned = false;
        onChange();
      });
    }

    const toggleBtn = back.querySelector('#logToggle');
    const refresh = () => {
      toggleBtn.textContent = lg.enabled ? '⏹ Arrêter la journalisation' : '⏺ Démarrer la journalisation';
      const n = lg.rows.length;
      const nVars = tabAddrs(tab).size;
      const durS = n ? (lg.rows[n - 1][0] - lg.rows[0][0]) : 0;
      const sizeMo = (n * 34 / 1048576);
      back.querySelector('#logStatus').innerHTML =
        (lg.enabled ? '⏺ En cours' : '⏸ À l’arrêt') + ' · ' +
        n.toLocaleString('fr-FR') + ' échantillon' + (n > 1 ? 's' : '') + ' · ' +
        nVars + ' variable' + (nVars > 1 ? 's' : '') + ' · ' +
        durS.toFixed(0) + ' s couvertes · ~' + sizeMo.toFixed(1) + ' Mo CSV' +
        (lg.truncated ? '<br>⚠ plafond atteint : les lignes les plus anciennes ont été éliminées' : '');
    };
    refresh();
    const statusTimer = setInterval(refresh, 1000);

    toggleBtn.addEventListener('click', () => {
      lg.enabled ? stopLogging(tab) : startLogging(tab);
      refresh();
    });
    back.querySelector('#logDlCsv').addEventListener('click', () => {
      if (!lg.rows.length) { toast('Journal vide.', 'err'); return; }
      const ok = DW.store.download('journal_' + tab.name, DW.store.logCsv(lg.rows), 'csv', 'text/csv');
      if (!ok) toast('Téléchargement bloqué dans cet environnement.', 'err');
    });
    back.querySelector('#logDlJson').addEventListener('click', () => {
      if (!lg.rows.length) { toast('Journal vide.', 'err'); return; }
      const payload = JSON.stringify({ app: 'diagweb-journal', version: 1, tab: tab.name, rows: lg.rows });
      const ok = DW.store.download('journal_' + tab.name, payload, 'json', 'application/json');
      if (!ok) toast('Téléchargement bloqué dans cet environnement.', 'err');
    });
    back.querySelector('#logClear').addEventListener('click', () => {
      lg.rows = []; lg.truncated = false; lg.lastT = {}; lg.enableT = DW.source.now();
      refresh();
      toast('Journal vidé.');
    });
  }

  function updateLogUi() {
    const on = state.active && state.active.log.enabled;
    $('logInd').classList.toggle('hide', !on);
  }

  // ---------- Disposition de démonstration ----------------------------
  const DEMO = {
    version: 1,
    table: ['I1.2.3.4', 'Q14.15', 'S0.4', 'MB414', 'Elec.tension_bus', 'Supervision.temps_cycle'],
    charts: [
      {
        title: 'Régulation vitesse', windowS: 60,
        series: [
          { addr: 'Regulation.mesure.vitesse' },
          { addr: 'Regulation.consigne.vitesse' },
          { addr: 'Elec.puissance_active' },
        ],
      },
      {
        title: 'Thermique & pression', windowS: 120,
        series: [
          { addr: 'Thermique.temperature_eau' },
          { addr: 'Hydraulique.pression_huile' },
          { addr: 'M20.0' },
        ],
      },
    ],
  };

  // ---------- État vide ------------------------------------------------
  function updateEmptyState() {
    const tab = state.active;
    const empty = !tab || (tab.table.length === 0 && tab.charts.length === 0);
    $('emptyState').classList.toggle('hide', !empty);
  }

  // ---------- Modal Configurations ------------------------------------
  // 4 actions principales — Enregistrer / Télécharger / Charger / Copier —
  // chacune dépliant ses déclinaisons (accordéon, un seul volet ouvert).
  function openLayoutsModal() {
    const root = $('modalRoot');
    root.innerHTML = '';
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-label="Configurations">' +
        '<header class="m-head"><h3>Configurations</h3><button class="iconbtn m-close" type="button" title="Fermer">✕</button></header>' +
        '<label class="m-label" for="layName">Nom de la configuration (onglet actif)</label>' +
        '<input id="layName" class="m-input" maxlength="60">' +
        '<div class="m-actions acc-row">' +
          '<button class="btn acc-btn" data-acc="save" type="button">Enregistrer ▾</button>' +
          '<button class="btn acc-btn" data-acc="download" type="button">Télécharger ▾</button>' +
          '<button class="btn acc-btn" data-acc="load" type="button">Charger ▾</button>' +
          '<button class="btn acc-btn" data-acc="copy" type="button">Copier ▾</button>' +
        '</div>' +
        '<div id="accPanel" class="acc-panel hide"></div>' +
        '<p class="m-note" id="accNote"></p>' +
      '</div>';
    root.appendChild(back);

    const close = () => { root.innerHTML = ''; };
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    back.querySelector('.m-close').addEventListener('click', close);

    back.querySelector('#layName').value = state.active.name;
    const getName = () => back.querySelector('#layName').value.trim() || 'Sans nom';
    const panel = back.querySelector('#accPanel');
    const note = back.querySelector('#accNote');
    let current = null;

    const NOTES = {
      save: 'Navigateur = mémorisée dans ce navigateur. Contrôleur = nécessite le back-end embarqué (à venir).',
      download: 'JSON = ré-importable dans Diagweb. CSV = export de consultation (tableur, séparateur « ; »).',
      load: 'La configuration s’ouvre dans un nouvel onglet. ★ = chargée automatiquement à l’ouverture. Import au format JSON.',
      copy: 'Copie dans le presse-papiers, pour coller dans un message ou un document.',
    };

    function openAcc(key) {
      current = key;
      for (const b of back.querySelectorAll('.acc-btn')) {
        b.classList.toggle('on', b.dataset.acc === key);
      }
      panel.classList.remove('hide');
      note.textContent = NOTES[key];
      panel.innerHTML = '';
      if (key === 'save') {
        panel.innerHTML =
          '<div class="m-actions">' +
            '<button class="btn primary" id="laySaveLocal" type="button">Navigateur</button>' +
            '<button class="btn" id="laySaveCtl" type="button">Contrôleur</button>' +
          '</div>';
        panel.querySelector('#laySaveLocal').addEventListener('click', () => {
          if (!DW.store.available) { toast('Stockage local indisponible dans ce navigateur.', 'err'); return; }
          DW.store.save(getName(), serializeConfig(state.active));
          toast('Configuration « ' + getName() + ' » enregistrée dans le navigateur.');
        });
        panel.querySelector('#laySaveCtl').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            await DW.store.saveToController(getName(), serializeConfig(state.active));
            toast('Configuration enregistrée dans le contrôleur.');
          } catch (e) {
            toast('Contrôleur injoignable — cette action sera disponible avec le back-end embarqué (prototype front-end).', 'err');
          } finally { btn.disabled = false; }
        });
      } else if (key === 'download') {
        panel.innerHTML =
          '<div class="m-actions">' +
            '<button class="btn primary" id="layDlJson" type="button">JSON</button>' +
            '<button class="btn" id="layDlCsv" type="button">CSV</button>' +
          '</div>';
        panel.querySelector('#layDlJson').addEventListener('click', () => {
          const ok = DW.store.download(getName(), DW.store.exportText(getName(), serializeConfig(state.active)));
          toast(ok ? 'Téléchargement JSON lancé.' : 'Téléchargement bloqué ici — utilisez « Copier ».', ok ? '' : 'err');
        });
        panel.querySelector('#layDlCsv').addEventListener('click', () => {
          const ok = DW.store.download(getName(), DW.store.configCsv(serializeConfig(state.active)), 'csv', 'text/csv');
          toast(ok ? 'Téléchargement CSV lancé.' : 'Téléchargement bloqué dans cet environnement.', ok ? '' : 'err');
        });
      } else if (key === 'copy') {
        panel.innerHTML =
          '<div class="m-actions">' +
            '<button class="btn primary" id="layCpJson" type="button">JSON</button>' +
            '<button class="btn" id="layCpCsv" type="button">CSV</button>' +
          '</div>';
        panel.querySelector('#layCpJson').addEventListener('click', async () => {
          const text = DW.store.exportText(getName(), serializeConfig(state.active));
          (await copyText(text)) ? toast('JSON copié dans le presse-papiers.') : showTextModal('Copie manuelle', text);
        });
        panel.querySelector('#layCpCsv').addEventListener('click', async () => {
          const text = DW.store.configCsv(serializeConfig(state.active));
          (await copyText(text)) ? toast('CSV copié dans le presse-papiers.') : showTextModal('Copie manuelle', text);
        });
      } else if (key === 'load') {
        panel.innerHTML =
          '<div class="m-row"><h4>Enregistrées dans ce navigateur</h4>' +
          '<label class="btn m-import">Importer un fichier<input type="file" id="layImport" accept=".json,application/json" hidden></label></div>' +
          '<div class="lay-list" id="layList"></div>';
        panel.querySelector('#layImport').addEventListener('change', (ev) => {
          const f = ev.target.files && ev.target.files[0];
          if (!f) return;
          const rd = new FileReader();
          rd.onload = () => {
            const r = DW.store.parseImport(String(rd.result));
            if (!r.ok) { toast(r.error, 'err'); return; }
            DW.store.save(r.name, r.data);
            createTab(r.name, r.data);
            close();
            toast('Configuration « ' + r.name + ' » importée dans un nouvel onglet.');
          };
          rd.readAsText(f);
        });
        renderLayList();
      }
    }

    back.querySelectorAll('.acc-btn').forEach((b) =>
      b.addEventListener('click', () => openAcc(b.dataset.acc)));

    function renderLayList() {
      const listEl = panel.querySelector('#layList');
      if (!listEl) return;
      const items = DW.store.list();
      const auto = DW.store.getAutoload();
      listEl.innerHTML = items.length ? '' : '<p class="m-empty">Aucune configuration enregistrée pour l’instant.</p>';
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'lay-row';
        const when = new Date(it.savedAt || 0);
        row.innerHTML =
          '<div class="lay-id"><b></b><span class="lay-date">' +
          String(when.getDate()).padStart(2, '0') + '/' + String(when.getMonth() + 1).padStart(2, '0') + ' ' +
          String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0') +
          '</span></div>' +
          '<div class="lay-actions">' +
            '<button class="btn sm" data-a="load" type="button">Charger</button>' +
            '<button class="iconbtn" data-a="dl" type="button" title="Télécharger JSON">⬇</button>' +
            '<button class="iconbtn star' + (auto === it.name ? ' on' : '') + '" data-a="auto" type="button" title="Charger automatiquement à l’ouverture">★</button>' +
            '<button class="iconbtn" data-a="del" type="button" title="Supprimer">🗑</button>' +
          '</div>';
        row.querySelector('.lay-id b').textContent = it.name;
        row.addEventListener('click', (e) => {
          const a = e.target.closest('[data-a]');
          if (!a) return;
          if (a.dataset.a === 'load') {
            createTab(it.name, it.data);
            close();
            toast('Configuration « ' + it.name + ' » ouverte dans un nouvel onglet.');
          }
          if (a.dataset.a === 'dl') {
            const ok = DW.store.download(it.name, DW.store.exportText(it.name, it.data));
            if (!ok) showTextModal('Copie manuelle', DW.store.exportText(it.name, it.data));
          }
          if (a.dataset.a === 'auto') {
            DW.store.setAutoload(auto === it.name ? null : it.name);
            renderLayList();
          }
          if (a.dataset.a === 'del') { DW.store.remove(it.name); renderLayList(); toast('« ' + it.name + ' » supprimée.'); }
        });
        listEl.appendChild(row);
      }
    }

    // Volet le plus utile ouvert d'office : la liste à charger s'il y en a,
    // sinon l'enregistrement.
    openAcc(DW.store.list().length ? 'load' : 'save');
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* on tente le repli */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function showTextModal(title, text) {
    const root = $('modalRoot');
    root.innerHTML = '';
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal"><header class="m-head"><h3></h3>' +
      '<button class="iconbtn m-close" type="button" title="Fermer">✕</button></header>' +
      '<p class="m-note">Sélectionnez tout puis copiez.</p>' +
      '<textarea class="m-text" readonly></textarea></div>';
    back.querySelector('h3').textContent = title;
    const ta = back.querySelector('.m-text');
    ta.value = text;
    back.querySelector('.m-close').addEventListener('click', () => { root.innerHTML = ''; });
    back.addEventListener('pointerdown', (e) => { if (e.target === back) root.innerHTML = ''; });
    root.appendChild(back);
    ta.focus(); ta.select();
  }

  // ---------- Boucle de rendu -----------------------------------------
  let lastChartT = 0, lastLiveT = 0;
  function loop(t) {
    const tab = state.active;
    if (tab && t - lastChartT >= 1000 / CFG.chartFps) {
      lastChartT = t;
      for (const c of tab.charts) c.render();
    }
    if (t - lastLiveT >= CFG.liveRefreshMs) {
      lastLiveT = t;
      if (tab) for (const c of tab.charts) c.updateLive();
      updateTableValues();
      const n = DW.source.count();
      $('statInfo').textContent = n + ' variable' + (n > 1 ? 's' : '') + ' active' + (n > 1 ? 's' : '') +
        ' · ' + state.tabs.length + ' onglet' + (state.tabs.length > 1 ? 's' : '');
    }
    requestAnimationFrame(loop);
  }

  function updatePauseBtn() {
    const tab = state.active;
    const allPaused = tab && tab.charts.length && tab.charts.every((c) => c.paused);
    $('pauseAllBtn').textContent = allPaused ? '▶ Reprendre' : '⏸ Figer';
  }

  // ---------- Événements globaux --------------------------------------
  function bindUi() {
    const input = $('searchInput');
    input.addEventListener('input', updateSuggest);
    input.addEventListener('focus', updateSuggest);
    input.addEventListener('blur', () => setTimeout(hideSuggest, 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSug(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSug(-1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const rows = $('suggestBox').querySelectorAll('.sug');
        if (sugIndex >= 0 && rows[sugIndex]) {
          const addr = rows[sugIndex].querySelector('.sug-addr').textContent;
          input.value = addr;
          addVariable(addr);
        } else addVariable();
      } else if (e.key === 'Escape') hideSuggest();
    });

    $('addBtn').addEventListener('click', () => addVariable());
    $('addChartBtn').addEventListener('click', () => {
      const c = createChart();
      if (c) {
        $('targetSel').value = 'chart:' + c.id;
        toast('« ' + c.title + ' » ajouté — c’est la cible d’ajout actuelle.');
      }
    });
    $('layoutsBtn').addEventListener('click', openLayoutsModal);
    $('logBtn').addEventListener('click', openLogModal);
    $('tabAdd').addEventListener('click', () => { createTab(); });

    $('pauseAllBtn').addEventListener('click', () => {
      const tab = state.active;
      if (!tab) return;
      const anyRunning = tab.charts.some((c) => !c.paused);
      for (const c of tab.charts) c.setPaused(anyRunning);
      updatePauseBtn();
    });

    // Menu burger
    const menuBtn = $('menuBtn'), menuPanel = $('menuPanel');
    const closeMenu = () => menuPanel.classList.add('hide');
    menuBtn.addEventListener('click', () => {
      updatePauseBtn();
      menuPanel.classList.toggle('hide');
    });
    document.addEventListener('pointerdown', (e) => {
      if (!menuPanel.classList.contains('hide') &&
          !menuPanel.contains(e.target) && !menuBtn.contains(e.target)) closeMenu();
    });
    for (const b of menuPanel.querySelectorAll('button')) b.addEventListener('click', closeMenu);

    $('aboutBtn').addEventListener('click', () => {
      const root = $('modalRoot');
      root.innerHTML = '';
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML =
        '<div class="modal" role="dialog" aria-label="À propos">' +
          '<header class="m-head"><h3>À propos de Diagweb</h3>' +
          '<button class="iconbtn m-close" type="button" title="Fermer">✕</button></header>' +
          '<p style="margin:6px 0">Diagnostic web des variables et signaux internes du contrôleur : ' +
          'valeurs numériques en direct et courbes multi-échelles, configurations par onglets, ' +
          'journalisation des données.</p>' +
          '<div class="log-status">Version : ' + DW.escapeHtml($('buildTag').textContent) +
          '<br>Mode : prototype front-end — données simulées (10 ms par défaut)</div>' +
        '</div>';
      back.querySelector('.m-close').addEventListener('click', () => { root.innerHTML = ''; });
      back.addEventListener('pointerdown', (e) => { if (e.target === back) root.innerHTML = ''; });
      root.appendChild(back);
    });

    // Repli de la zone de configuration : recherche + actions d'onglet (mémorisé)
    const CFG_HIDDEN_KEY = 'diagweb.cfghidden.v1';
    function setCfgHidden(hidden) {
      document.body.classList.toggle('cfg-hidden', hidden);
      const b = $('cfgToggle');
      b.textContent = hidden ? '⌄' : '⌃';
      b.title = hidden ? 'Afficher la zone de configuration' : 'Masquer la zone de configuration';
      if (!hidden) return;
      hideSuggest();
    }
    $('cfgToggle').addEventListener('click', () => {
      const hidden = !document.body.classList.contains('cfg-hidden');
      setCfgHidden(hidden);
      try { window.localStorage.setItem(CFG_HIDDEN_KEY, hidden ? '1' : '0'); } catch (e) { /* stockage indisponible */ }
    });
    try { setCfgHidden(window.localStorage.getItem(CFG_HIDDEN_KEY) === '1'); } catch (e) { /* stockage indisponible */ }

    $('themeBtn').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark'
        : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', next);
      DW.invalidateChartTheme();
      for (const tab of state.tabs) for (const c of tab.charts) c.rebuildLegend();
    });

    $('demoBtn').addEventListener('click', () => {
      applyConfigToActive(DEMO);
      toast('Disposition de démonstration chargée dans cet onglet.');
    });

    const perSel = $('periodSel');
    for (const p of CFG.periodChoices) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p >= 1000 ? (p / 1000) + ' s' : p + ' ms';
      if (p === CFG.defaultPeriodMs) o.textContent += ' (défaut)';
      perSel.appendChild(o);
    }
    perSel.value = String(CFG.defaultPeriodMs);

    $('srcInfo').textContent = 'Source : ' + DW.source.name + ' · défaut ' + DW.source.defaultPeriodMs + ' ms';
    if (DW.source.onStatus === null) DW.source.onStatus = (msg, isErr) => toast(msg, isErr ? 'err' : '');
    if (DW.sourceMode === 'ws') toast('Connecté au serveur de diagnostic.');
    else if (DW.sourceFallbackReason) {
      toast('Serveur de diagnostic injoignable (' + DW.sourceFallbackReason + ') — simulation locale.', 'err');
    }
  }

  // ---------- Démarrage ------------------------------------------------
  function boot() {
    bindUi();

    // Déplacement de widgets entre onglets et entre fenêtres
    DW.dnd.attach({
      receive: receiveWidget,
      activeTab: () => state.active,
      tabFromElement: (el) => el._tab || state.active,
      isSameTarget: (tab, payload) => tab === state.active && payload.kind !== 'chart',
      toast,
    });

    // Widget transféré par « Ouvrir dans une nouvelle fenêtre »
    const transferred = DW.dnd.consumeOpenParam();
    if (transferred) {
      createTab(transferred.kind === 'chart'
        ? ((transferred.chart && transferred.chart.title) || 'Graphique')
        : 'Variables');
      receiveWidget(transferred, state.active);
      requestAnimationFrame(loop);
      return;
    }

    const sess = DW.store.loadSession();
    if (sess && sess.version === 2) {
      for (const t of sess.tabs) createTab(t.name, t.data, t.log);
      const idx = Math.min(Math.max(0, sess.active || 0), state.tabs.length - 1);
      switchTab(state.tabs[idx]);
    } else if (sess && ((sess.table && sess.table.length) || (sess.charts && sess.charts.length))) {
      createTab('Onglet 1', sess);
    } else {
      const auto = DW.store.getAutoload();
      const saved = auto ? DW.store.get(auto) : null;
      if (saved) createTab(saved.name, saved.data);
      else createTab('Démo', DEMO);
    }
    refreshTargets();
    updateEmptyState();
    requestAnimationFrame(loop);
  }

  // La source (simulation ou serveur de diagnostic) doit être choisie avant
  // de construire l'espace de travail : les premiers abonnements en dépendent.
  function start() {
    const ready = DW.sourceReady || Promise.resolve();
    ready.catch(() => {}).then(boot);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
