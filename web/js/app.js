/* Diagweb — logique applicative & interface */
(function () {
  "use strict";
  const DW = window.DW;
  const CFG = DW.CONFIG;
  const $ = (id) => document.getElementById(id);

  // ---------- État ----------------------------------------------------
  const state = {
    table: [],        // [{addr, meta}]
    charts: [],       // instances DW.Chart
    chartSeq: 0,
  };

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
    saveTimer = setTimeout(() => DW.store.saveSession(serializeWorkspace()), 500);
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
      const i = state.charts.indexOf(chart);
      if (i >= 0) state.charts.splice(i, 1);
      chart.destroy();
      refreshTargets();
      onChange();
    },
    refreshTargets,
  };

  // ---------- Graphiques ----------------------------------------------
  function createChart(opts) {
    if (state.charts.length >= CFG.maxCharts) {
      toast('Limite de ' + CFG.maxCharts + ' graphiques atteinte.', 'err');
      return null;
    }
    opts = opts || {};
    state.chartSeq++;
    const chart = new DW.Chart(appApi, {
      title: opts.title || 'Graphique ' + state.chartSeq,
      windowS: opts.windowS,
    });
    state.charts.push(chart);
    $('chartsGrid').appendChild(chart.root);
    refreshTargets();
    onChange();
    return chart;
  }

  // ---------- Tableau numérique ---------------------------------------
  function inTable(addr) { return state.table.some((e) => e.addr === addr); }

  function addToTable(addr, periodMs) {
    if (inTable(addr)) return { ok: false, error: addr + ' est déjà dans le tableau.' };
    const meta = appApi.acquire(addr, periodMs);
    if (!meta) return { ok: false, error: 'Adresse invalide : ' + addr };
    state.table.push({ addr, meta, periodMs: periodMs || undefined });
    renderTable();
    return { ok: true };
  }

  function removeFromTable(addr) {
    const i = state.table.findIndex((e) => e.addr === addr);
    if (i < 0) return;
    appApi.release(addr);
    state.table.splice(i, 1);
    renderTable();
    onChange();
  }

  function renderTable() {
    const card = $('tableCard');
    const rows = $('tableRows');
    rows.innerHTML = '';
    for (const e of state.table) {
      const row = document.createElement('div');
      row.className = 'vrow';
      row.dataset.addr = e.addr;
      row.innerHTML =
        '<span class="badge fam-' + e.meta.family + '">' + e.meta.family + '</span>' +
        '<div class="v-id"><span class="v-addr"></span><span class="v-label"></span></div>' +
        '<div class="v-val"><b class="val">—</b><span class="v-unit"></span><span class="v-trend"></span></div>' +
        '<button class="v-del" type="button" title="Retirer du tableau">✕</button>';
      row.querySelector('.v-addr').textContent = e.addr;
      row.querySelector('.v-label').textContent = e.meta.label +
        (e.periodMs && e.periodMs !== CFG.defaultPeriodMs ? ' · rafr. ' + e.periodMs + ' ms' : '');
      row.querySelector('.v-unit').textContent = e.meta.unit || '';
      row.querySelector('.v-del').addEventListener('click', () => removeFromTable(e.addr));
      rows.appendChild(row);
    }
    $('tableCount').textContent = state.table.length ? state.table.length + ' variable' + (state.table.length > 1 ? 's' : '') : '';
    card.classList.toggle('hide', state.table.length === 0);
    updateEmptyState();
  }

  function updateTableValues() {
    const rows = $('tableRows').children;
    const nowT = DW.source.now();
    for (let i = 0; i < state.table.length && i < rows.length; i++) {
      const e = state.table[i];
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
    for (const c of state.charts) opt('chart:' + c.id, '→ ' + c.title);
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
        chart = state.charts.find((c) => 'chart:' + c.id === target);
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
  function serializeWorkspace() {
    return {
      version: 1,
      table: state.table.map((e) => ({ addr: e.addr, periodMs: e.periodMs })),
      charts: state.charts.map((c) => c.serialize()),
    };
  }

  function clearAll() {
    for (const c of [...state.charts]) { c.destroy(); }
    state.charts = [];
    for (const e of state.table) appApi.release(e.addr);
    state.table = [];
    state.chartSeq = 0;
    renderTable();
    refreshTargets();
  }

  function applyWorkspace(data) {
    clearAll();
    for (const entry of data.table || []) {
      // Rétro-compatibilité : entrée sous forme de chaîne (format initial)
      const addr = typeof entry === 'string' ? entry : entry.addr;
      const periodMs = typeof entry === 'string' ? undefined : entry.periodMs;
      const p = DW.parseAddr(addr);
      if (p.ok) addToTable(p.addr, periodMs);
    }
    for (const c of data.charts || []) {
      const chart = createChart({ title: c.title, windowS: c.windowS });
      if (!chart) break;
      for (const s of c.series || []) {
        const p = DW.parseAddr(s.addr);
        if (p.ok) chart.addSeries(p.addr, { axisMode: s.axisMode, visible: s.visible !== false, periodMs: s.periodMs });
      }
    }
    refreshTargets();
    updateEmptyState();
    onChange();
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
    const empty = state.table.length === 0 && state.charts.length === 0;
    $('emptyState').classList.toggle('hide', !empty);
  }

  // ---------- Modal Dispositions ---------------------------------------
  function openLayoutsModal() {
    const root = $('modalRoot');
    root.innerHTML = '';
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-label="Dispositions">' +
        '<header class="m-head"><h3>Dispositions</h3><button class="iconbtn m-close" type="button" title="Fermer">✕</button></header>' +
        '<div class="m-section">' +
          '<label class="m-label" for="layName">Enregistrer la disposition actuelle</label>' +
          '<input id="layName" class="m-input" maxlength="60">' +
          '<div class="m-actions">' +
            '<button class="btn primary" id="laySaveLocal" type="button">Enregistrer (navigateur)</button>' +
            '<button class="btn" id="layDownload" type="button">Télécharger .json</button>' +
            '<button class="btn" id="layCopy" type="button">Copier le JSON</button>' +
            '<button class="btn" id="laySaveCtl" type="button">Enregistrer dans le contrôleur</button>' +
          '</div>' +
        '</div>' +
        '<div class="m-section">' +
          '<div class="m-row"><h4>Enregistrées dans ce navigateur</h4>' +
          '<label class="btn m-import">Importer un fichier<input type="file" id="layImport" accept=".json,application/json" hidden></label></div>' +
          '<div class="lay-list" id="layList"></div>' +
        '</div>' +
        '<p class="m-note">★ = chargée automatiquement à l’ouverture. « Contrôleur » nécessite le back-end embarqué ' +
        '(à venir) : sans contrôleur joignable, le prototype affiche une erreur.</p>' +
      '</div>';
    root.appendChild(back);

    const close = () => { root.innerHTML = ''; };
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    back.querySelector('.m-close').addEventListener('click', close);

    const d = new Date();
    back.querySelector('#layName').value =
      'Disposition ' + String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') +
      ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

    const getName = () => back.querySelector('#layName').value.trim() || 'Sans nom';

    back.querySelector('#laySaveLocal').addEventListener('click', () => {
      if (!DW.store.available) { toast('Stockage local indisponible dans ce navigateur.', 'err'); return; }
      DW.store.save(getName(), serializeWorkspace());
      renderLayList();
      toast('Disposition « ' + getName() + ' » enregistrée dans le navigateur.');
    });
    back.querySelector('#layDownload').addEventListener('click', () => {
      const ok = DW.store.download(getName(), DW.store.exportText(getName(), serializeWorkspace()));
      toast(ok ? 'Téléchargement lancé.' : 'Téléchargement bloqué ici — utilisez « Copier le JSON ».', ok ? '' : 'err');
    });
    back.querySelector('#layCopy').addEventListener('click', async () => {
      const text = DW.store.exportText(getName(), serializeWorkspace());
      const ok = await copyText(text);
      if (ok) toast('JSON copié dans le presse-papiers.');
      else showTextModal('Copie manuelle', text);
    });
    back.querySelector('#laySaveCtl').addEventListener('click', async () => {
      const btn = back.querySelector('#laySaveCtl');
      btn.disabled = true;
      try {
        await DW.store.saveToController(getName(), serializeWorkspace());
        toast('Disposition enregistrée dans le contrôleur.');
      } catch (e) {
        toast('Contrôleur injoignable — cette action sera disponible avec le back-end embarqué (prototype front-end).', 'err');
      } finally { btn.disabled = false; }
    });
    back.querySelector('#layImport').addEventListener('change', (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const r = DW.store.parseImport(String(rd.result));
        if (!r.ok) { toast(r.error, 'err'); return; }
        DW.store.save(r.name, r.data);
        renderLayList();
        applyWorkspace(r.data);
        toast('Disposition « ' + r.name + ' » importée et chargée.');
      };
      rd.readAsText(f);
    });

    function renderLayList() {
      const listEl = back.querySelector('#layList');
      const items = DW.store.list();
      const auto = DW.store.getAutoload();
      listEl.innerHTML = items.length ? '' : '<p class="m-empty">Aucune disposition enregistrée pour l’instant.</p>';
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
            '<button class="iconbtn" data-a="dl" type="button" title="Télécharger">⬇</button>' +
            '<button class="iconbtn star' + (auto === it.name ? ' on' : '') + '" data-a="auto" type="button" title="Charger automatiquement à l’ouverture">★</button>' +
            '<button class="iconbtn" data-a="del" type="button" title="Supprimer">🗑</button>' +
          '</div>';
        row.querySelector('.lay-id b').textContent = it.name;
        row.addEventListener('click', (e) => {
          const a = e.target.closest('[data-a]');
          if (!a) return;
          if (a.dataset.a === 'load') { applyWorkspace(it.data); close(); toast('Disposition « ' + it.name + ' » chargée.'); }
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
    renderLayList();
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
    if (t - lastChartT >= 1000 / CFG.chartFps) {
      lastChartT = t;
      for (const c of state.charts) c.render();
    }
    if (t - lastLiveT >= CFG.liveRefreshMs) {
      lastLiveT = t;
      for (const c of state.charts) c.updateLive();
      updateTableValues();
      $('statInfo').textContent = DW.source.count() + ' variable' + (DW.source.count() > 1 ? 's' : '') + ' active' + (DW.source.count() > 1 ? 's' : '');
    }
    requestAnimationFrame(loop);
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

    $('pauseAllBtn').addEventListener('click', () => {
      const anyRunning = state.charts.some((c) => !c.paused);
      for (const c of state.charts) c.setPaused(anyRunning);
      $('pauseAllBtn').textContent = anyRunning ? '▶' : '⏸';
      $('pauseAllBtn').title = anyRunning ? 'Reprendre tous les graphiques' : 'Figer tous les graphiques';
    });

    $('themeBtn').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark'
        : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', next);
      DW.invalidateChartTheme();
      for (const c of state.charts) c.rebuildLegend();
    });

    $('demoBtn').addEventListener('click', () => { applyWorkspace(DEMO); toast('Disposition de démonstration chargée.'); });

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
  }

  // ---------- Démarrage ------------------------------------------------
  function boot() {
    bindUi();
    refreshTargets();
    const sess = DW.store.loadSession();
    if (sess && ((sess.table && sess.table.length) || (sess.charts && sess.charts.length))) {
      applyWorkspace(sess);
    } else {
      const auto = DW.store.getAutoload();
      const saved = auto ? DW.store.get(auto) : null;
      if (saved) applyWorkspace(saved.data);
      else applyWorkspace(DEMO);
    }
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
