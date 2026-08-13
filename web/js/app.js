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

  /** Intitulé complet d'une famille d'adresses, pour les infobulles. */
  /** Infobulle d'une étiquette de famille : ce qu'elle désigne, et son sigle. */
  function famTitle(family, meta) {
    const f = DW.FAMILIES[family];
    const sigle = meta ? DW.famBadge(meta) : family;
    return f ? f.label + ' (' + sigle + ')' : sigle;
  }

  const FILTER_TITLES = {
    all: 'Toutes les familles de variables',
    PLC: 'Variables PLC : entrées I, sorties Q, bits mémoire M, variables système S',
    MB: 'Registres de bus (MB) — mots de 16 bits',
    CAPI: 'Signaux des modèles, via la C API (Modele.sous_systeme.signal)',
    NET: 'Points lus sur les liens réseau du serveur de diagnostic (@lien.point) — ' +
         'Modbus, IEC 61850, IEC 60870-5-104, CAN, J1939, CANopen, SNMP, OPC UA',
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
      let hote = null;
      for (const tab of state.tabs) {
        const i = tab.charts.indexOf(chart);
        if (i >= 0) { tab.charts.splice(i, 1); hote = tab; break; }
      }
      chart.destroy();
      if (hote) DW.mosaic.agencer(hote.chartsGridEl, tilesOf(hote));
      refreshTargets();
      onChange();
    },
    refreshTargets,
    renameVariable,
    /** Onglets autres que l'actif (menus « Déplacer vers »). */
    otherTabs: () => state.tabs.filter((t) => t !== state.active),
    moveChartToTab,
    duplicateChart,
    relayout,
    /** Toutes les tuiles de l'onglet auquel appartient cette carte. */
    tilesOfCard(el) {
      const tab = state.tabs.find((t) => t.chartsGridEl === el.parentElement) || state.active;
      return tilesOf(tab);
    },
  };

  // ---------- Mosaïque : les tuiles d'un onglet ------------------------
  /**
   * Tableaux et graphiques sont la MÊME chose pour la mise en page : des
   * tuiles rectangulaires. C'est ce qui permet de les mélanger librement —
   * un graphique à gauche, un tableau à droite, un autre graphique dessous.
   */
  function tilesOf(tab) {
    return tab ? [...tab.tables, ...tab.charts] : [];
  }

  /**
   * Réagence la mosaïque de l'onglet actif (ou de celui qui contient `el`).
   * `tenue` est la tuile que l'utilisateur manipule : elle ne bouge pas.
   */
  function relayout(el, tenue) {
    const tab = (el && state.tabs.find((t) => t.chartsGridEl === el.parentElement)) || state.active;
    if (!tab) return;
    DW.mosaic.agencer(tab.chartsGridEl, tilesOf(tab), tenue || null);
  }

  /**
   * Pose une tuile neuve. Sans emplacement demandé, elle va à la première
   * place libre ; avec un emplacement (copie posée sous son original, tuile
   * lâchée à un endroit précis), elle le GARDE et ce sont les voisines qui
   * s'écartent — sinon la copie irait se ranger en fin de mosaïque, loin de
   * l'endroit où on la cherche du regard.
   */
  function placerNouvelle(tab, tuile) {
    const voulu = tuile.x != null && tuile.y != null;
    if (!voulu) {
      const autres = tilesOf(tab).filter((t) => t !== tuile);
      const p = DW.mosaic.placeLibre(autres, tuile.w, tuile.h);
      tuile.x = p.x; tuile.y = p.y;
    }
    DW.mosaic.agencer(tab.chartsGridEl, tilesOf(tab), voulu ? tuile : null);
  }

  // ---------- Onglets --------------------------------------------------
  function createTab(name, data, logOpts) {
    state.tabSeq++;
    const pane = document.createElement('div');
    pane.className = 'tabpane';
    // Les tableaux vivent DANS la grille des graphiques : c'est ce qui permet
    // d'en poser plusieurs, de leur donner moins que toute la largeur, et
    // d'alterner tableau / graphique / tableau / graphique.
    pane.innerHTML = '<div class="charts-grid"></div>';
    $('panes').appendChild(pane);

    const tab = {
      id: 't' + state.tabSeq,
      name: name || 'Onglet ' + state.tabSeq,
      tables: [], charts: [], chartSeq: 0, tableSeq: 0,
      paneEl: pane,
      chartsGridEl: pane.querySelector('.charts-grid'),
      log: {
        // dest 'browser' : accumulation en mémoire de la page ;
        // dest 'server'  : journalisation autonome côté serveur (page fermée OK).
        enabled: false, dest: 'browser',
        rows: [], lastT: {}, enableT: 0, truncated: false,
      },
    };
    state.tabs.push(tab);
    switchTab(tab);
    if (data) applyConfigToActive(data);
    if (logOpts) {
      // 'controller' est l'ancien nom de la journalisation côté serveur.
      tab.log.dest = (logOpts.dest === 'server' || logOpts.dest === 'controller') ? 'server' : 'browser';
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
    for (const tbl of [...tab.tables]) removeTable(tbl);
    tab.tables = [];
    tab.chartSeq = 0;
    tab.tableSeq = 0;
  }

  function rebuildTabbar() {
    const bar = $('tabs');
    bar.innerHTML = '';
    for (const tab of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab === state.active ? ' on' : '');
      el.setAttribute('role', 'tab');
      el.title = tab === state.active
        ? 'Onglet actif « ' + tab.name + ' » — appuyez pour le renommer. ' +
          'Vous pouvez y déposer un graphique ou des variables.'
        : 'Aller à l’onglet « ' + tab.name + ' ». ' +
          'Vous pouvez y déposer un graphique ou des variables sans le quitter.';
      el._tab = tab;   // cible de dépôt (voir dnd.js)
      el.innerHTML =
        '<span class="tab-name"></span>' +
        (tab.log.enabled ? '<i class="recdot" title="Journal de données en cours d’enregistrement dans cet onglet"></i>' : '') +
        '<span class="tab-close" title="Fermer cet onglet et libérer ses variables">✕</span>';
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

  // ---------- Tableaux numériques -------------------------------------
  // Un onglet porte AUTANT DE TABLEAUX qu'on veut, chacun étant une carte de
  // la grille au même titre qu'un graphique : on peut donc alterner tableau,
  // graphique, tableau, graphique, et donner à chacun sa largeur et sa
  // hauteur. Un tableau regroupe ce qui se lit ensemble ; deux tableaux
  // séparent deux sujets, ce qu'une seule liste ne sait pas faire.

  /** Crée un tableau dans l'onglet et l'ajoute à la grille. */
  function createTable(tab, opts) {
    opts = opts || {};
    tab.tableSeq++;
    const card = document.createElement('section');
    card.className = 'card table-card';
    card.innerHTML =
      '<h3>' +
        '<span class="drag-handle" draggable="true" ' +
          'title="Déplacer ce tableau : le glisser où l’on veut dans la page (il se pose ' +
          'à l’emplacement montré et écarte ce qui gêne), sur un onglet, ou dans une autre ' +
          'fenêtre du navigateur">⠿</span>' +
        '<input class="table-title" maxlength="32" aria-label="Nom du tableau" ' +
          'title="Nom du tableau — cliquez pour le modifier ; il sert aussi de ' +
          'destination d’ajout dans la barre du haut">' +
        '<span class="tcount" title="Nombre de variables dans ce tableau"></span>' +
        '<button class="iconbtn card-add" type="button" ' +
          'title="Ajouter des variables à ce tableau : ouvre le catalogue complet, ' +
          'avec filtres et sélection multiple">+</button>' +
        '<button class="iconbtn table-more" type="button" ' +
          'title="Options du tableau : vider, taille automatique, dupliquer, déplacer ' +
          'vers un autre onglet ou une nouvelle fenêtre, fermer">⋮</button>' +
      '</h3>' +
      '<div class="trows"></div>' +
      '<span class="resize-grip" role="separator" ' +
        'aria-label="Redimensionner le tableau" ' +
        'title="Glisser pour redimensionner librement le tableau : ↔ largeur et ↕ hauteur, ' +
        'par cellules de la mosaïque ; les tuiles voisines s’écartent. Double-clic pour ' +
        'revenir à la taille de départ."></span>';

    const tbl = {
      id: 'tb' + tab.tableSeq,
      tab,
      name: opts.name || (tab.tables.length ? 'Tableau ' + (tab.tables.length + 1)
                                            : 'Valeurs numériques'),
      entries: [],
      // Tuile de la mosaïque (cf. mosaic.js) : colonne, rangée, largeur, hauteur.
      x: opts.x, y: opts.y,
      w: opts.w || DW.mosaic.defaut('table').w,
      h: opts.h || DW.mosaic.defaut('table').h,
      cardEl: card,
      rowsEl: card.querySelector('.trows'),
      countEl: card.querySelector('.tcount'),
      titleEl: card.querySelector('.table-title'),
    };
    tbl.titleEl.value = tbl.name;
    tbl.titleEl.addEventListener('change', () => {
      tbl.name = tbl.titleEl.value.trim() || 'Tableau';
      tbl.titleEl.value = tbl.name;
      refreshTargets();
      onChange();
    });
    card.querySelector('.drag-handle').addEventListener('dragstart', (e) => {
      if (!DW.dnd || !tbl.entries.length) { e.preventDefault(); return; }
      DW.dnd.startDrag(e, { kind: 'table', tabId: tab.id, tableId: tbl.id,
                            title: tbl.name, table: serializeTable(tbl),
                            w: tbl.w, h: tbl.h }, () => {
        for (const entry of [...tbl.entries]) removeFromTable(tbl, entry.addr);
      });
    });
    card.querySelector('.card-add').addEventListener('click', () => {
      openVarPicker({ kind: 'table', table: tbl });
    });
    card.querySelector('.table-more').addEventListener('click', (e) =>
      openTableMenu(tbl, e.currentTarget));
    tab.chartsGridEl.appendChild(card);
    tab.tables.push(tbl);
    bindCible(card, tbl);
    bindTableResize(tbl);
    bindTableReorder(tbl);
    placerNouvelle(tab, tbl);
    renderTable(tbl);
    refreshTargets();
    return tbl;
  }

  /** Menu ⋮ d'un tableau (le pendant de celui d'un graphique). */
  function openTableMenu(tbl, anchor) {
    DW.popup(anchor, (mk) => {
      mk('Ajouter des variables…', () => openVarPicker({ kind: 'table', table: tbl }), null,
        'Ouvrir le catalogue complet, filtres et sélection multiple');
      mk('Vider le tableau', () => {
        for (const e of [...tbl.entries]) removeFromTable(tbl, e.addr);
      }, null, 'Retirer toutes les variables sans supprimer le tableau');
      mk('Taille de départ', () => {
        const d = DW.mosaic.defaut('table');
        tbl.w = d.w; tbl.h = d.h;
        relayout(tbl.cardEl);
        onChange();
      }, null, 'Annuler le dimensionnement fait à la poignée ◢ et reprendre toute la largeur');
      mk('Dupliquer ce tableau', () => duplicateTable(tbl), null,
        'Créer une copie avec les mêmes variables, juste après celui-ci');
      // Déplacements : indispensables au tact, où le glisser-déposer HTML5
      // n'existe pas.
      for (const t of state.tabs.filter((x) => x !== tbl.tab)) {
        mk('Déplacer vers l’onglet « ' + DW.escapeHtml(t.name) + ' »', () => {
          moveTableToTab(tbl, t);
        }, null, 'Transférer ce tableau et ses variables dans « ' + t.name + ' »');
      }
      mk('Ouvrir dans une nouvelle fenêtre', () => {
        DW.dnd.openInNewWindow({ kind: 'table', title: tbl.name, table: serializeTable(tbl) },
          () => removeTable(tbl));
      }, null, 'Sortir ce tableau dans une fenêtre séparée, à poser sur un autre écran');
      mk('Fermer le tableau', () => removeTable(tbl), 'danger',
        'Supprimer ce tableau et libérer ses variables');
    });
  }

  /** Retire un tableau de son onglet (et libère ses abonnements). */
  function removeTable(tbl) {
    const tab = tbl.tab;
    for (const e of tbl.entries) appApi.release(e.addr);
    tbl.entries = [];
    tbl.cardEl.remove();
    const i = tab.tables.indexOf(tbl);
    if (i >= 0) tab.tables.splice(i, 1);
    // La place libérée est reprise : la gravité de la mosaïque remonte ce qui
    // était dessous, plutôt que de laisser un trou.
    DW.mosaic.agencer(tab.chartsGridEl, tilesOf(tab));
    refreshTargets();
    updateEmptyState();
    onChange();
  }

  /** Déplace un tableau entier vers un autre onglet (menu ⋮, chemin tactile). */
  function moveTableToTab(tbl, cible) {
    const copie = serializeTable(tbl);
    const nom = tbl.name;
    removeTable(tbl);
    const neuf = createTable(cible, { name: nom });
    for (const e of copie) {
      const p = DW.parseAddr(e.addr);
      if (p.ok) addToTable(neuf, p.addr, e.periodMs, e.name);
    }
    toast('Tableau « ' + nom + ' » déplacé vers « ' + cible.name + ' ».');
    onChange();
  }

  /** Duplique un tableau (mêmes variables, même taille), posé juste dessous. */
  function duplicateTable(tbl) {
    const copie = serializeTable(tbl);
    const neuf = createTable(tbl.tab, { name: tbl.name + ' (copie)', w: tbl.w, h: tbl.h,
                                        x: tbl.x, y: tbl.y + tbl.h });
    for (const e of copie) {
      const p = DW.parseAddr(e.addr);
      if (p.ok) addToTable(neuf, p.addr, e.periodMs, e.name);
    }
    relayout();
    setCible(neuf);
    onChange();
    toast('« ' + neuf.name + ' » créé.');
    return neuf;
  }

  /** Premier tableau de l'onglet, créé au besoin (destination par défaut). */
  function defaultTable(tab) {
    return tab.tables[0] || createTable(tab, {});
  }

  function inTable(tbl, addr) { return tbl.entries.some((e) => e.addr === addr); }
  function inAnyTable(tab, addr) { return tab.tables.some((t) => inTable(t, addr)); }

  function addToTable(tbl, addr, periodMs, name) {
    if (inTable(tbl, addr)) {
      return { ok: false, error: addr + ' est déjà dans « ' + tbl.name + ' ».' };
    }
    const meta = appApi.acquire(addr, periodMs);
    if (!meta) return { ok: false, error: 'Adresse invalide : ' + addr };
    tbl.entries.push({ addr, meta, periodMs: periodMs || undefined, name: name || undefined });
    renderTable(tbl);
    return { ok: true };
  }

  /** Libellé affiché d'une variable : nom d'affichage choisi, sinon libellé du catalogue. */
  function displayLabel(e) { return e.name || e.meta.label; }

  /**
   * Un nom d'affichage appartient à la VARIABLE, pas à l'endroit où on la
   * regarde : renommer « MB414 » en « Pression collecteur » dans un tableau
   * doit la nommer ainsi partout dans la page — autres tableaux, courbes,
   * légendes, tous onglets confondus. Deux noms pour une même adresse, c'est
   * la porte ouverte à lire une courbe pour une autre.
   *
   * L'adresse, elle, ne change jamais : c'est toujours elle qui identifie.
   */
  function renameVariable(addr, name, distant) {
    const nom = (name || '').trim() || undefined;
    for (const tab of state.tabs) {
      for (const tbl of tab.tables) {
        let touche = false;
        for (const e of tbl.entries) {
          if (e.addr === addr && e.name !== nom) { e.name = nom; touche = true; }
        }
        if (touche) renderTable(tbl);
      }
      for (const chart of tab.charts) {
        let legende = false;
        for (const s of chart.series) {
          if (s.addr === addr && s.name !== nom) { s.name = nom; legende = true; }
        }
        if (legende) chart.rebuildLegend();
      }
    }
    refreshTargets();
    onChange();
    // Les autres fenêtres ouvertes sur le même contrôleur suivent (multi-écran).
    if (!distant && DW.dnd && DW.dnd.shareRename) DW.dnd.shareRename(addr, nom);
  }

  /** Renommage en place du nom d'affichage d'une variable du tableau. */
  function renameTableEntry(tbl, e, labelEl) {
    if (labelEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'v-rename';
    input.value = e.name || '';
    input.maxLength = 48;
    input.placeholder = e.meta.label;
    input.title = 'Nom d’affichage — laissez vide pour revenir au libellé du catalogue';
    labelEl.textContent = '';
    labelEl.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      renameVariable(e.addr, input.value);
      renderTable(tbl);        // la ligne éditée retrouve son affichage normal
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { input.value = e.name || ''; input.blur(); }
    });
    // Empêche le glisser-déposer de la ligne pendant l'édition
    input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  }

  function removeFromTable(tbl, addr) {
    const i = tbl.entries.findIndex((e) => e.addr === addr);
    if (i < 0) return;
    appApi.release(addr);
    tbl.entries.splice(i, 1);
    renderTable(tbl);
    onChange();
  }

  // ---------- Rangement des lignes du tableau -------------------------
  // Ligne en cours de glissement, quand elle vient de CE navigateur : de quoi
  // distinguer « ranger dans le tableau » de « déposer une variable venue
  // d'ailleurs », qui reste l'affaire de dnd.js.
  let rangement = null;

  /** Déplace une variable devant ou derrière une autre, dans le même tableau. */
  function moveTableEntry(tbl, addr, refAddr, after) {
    if (addr === refAddr) return;
    const from = tbl.entries.findIndex((x) => x.addr === addr);
    if (from < 0) return;
    const [entry] = tbl.entries.splice(from, 1);
    const ref = tbl.entries.findIndex((x) => x.addr === refAddr);
    if (ref < 0) { tbl.entries.splice(from, 0, entry); return; }   // repère envolé
    tbl.entries.splice(after ? ref + 1 : ref, 0, entry);
    renderTable(tbl);
    onChange();
  }

  /**
   * Glisser une ligne au-dessus d'une autre la range dans le tableau.
   *
   * L'événement est arrêté ici (`stopPropagation`) quand il s'agit bien d'un
   * rangement interne : sans cela, le gestionnaire global de dnd.js
   * interpréterait le dépôt comme l'arrivée d'une variable dans l'onglet. Une
   * variable venue d'un AUTRE onglet ou d'une autre fenêtre, elle, n'est pas
   * arrêtée : elle suit son chemin habituel.
   */
  function bindTableReorder(tbl) {
    const rows = tbl.rowsEl;
    const efface = () => rows.querySelectorAll('.vrow.drop-before, .vrow.drop-after')
      .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    // Rangement interne = la ligne vient de CE tableau. Venue d'un autre
    // tableau, d'un autre onglet ou d'une autre fenêtre, elle suit le chemin
    // habituel de dnd.js — ce qui permet justement de déplacer une variable
    // d'un tableau à l'autre.
    const interne = () => !!rangement && rangement.tbl === tbl &&
      tbl.entries.some((x) => x.addr === rangement.addr);
    const viser = (ev) => {
      const row = ev.target.closest && ev.target.closest('.vrow');
      if (!row || !rows.contains(row)) return null;
      const r = row.getBoundingClientRect();
      return { row, after: (ev.clientY - r.top) > r.height / 2 };
    };

    rows.addEventListener('dragover', (ev) => {
      if (!interne()) return;
      const c = viser(ev);
      if (!c) return;
      ev.preventDefault();
      ev.stopPropagation();
      try { ev.dataTransfer.dropEffect = 'move'; } catch (err) { /* facultatif */ }
      efface();
      if (c.row.dataset.addr !== rangement.addr) {
        c.row.classList.add(c.after ? 'drop-after' : 'drop-before');
      }
    });
    rows.addEventListener('dragleave', (ev) => {
      if (!rows.contains(ev.relatedTarget)) efface();
    });
    rows.addEventListener('drop', (ev) => {
      if (!interne()) return;
      const c = viser(ev);
      if (!c) return;
      ev.preventDefault();
      ev.stopPropagation();
      efface();
      moveTableEntry(tbl, rangement.addr, c.row.dataset.addr, c.after);
      rangement = null;
    });
  }

  function renderTable(tbl) {
    const tab = tbl.tab;
    const rows = tbl.rowsEl;
    rows.innerHTML = '';
    for (const e of tbl.entries) {
      const row = document.createElement('div');
      row.className = 'vrow';
      row.dataset.addr = e.addr;
      // Chaque variable peut être glissée seule : vers un autre onglet ou une
      // autre fenêtre, ou simplement plus haut ou plus bas dans ce tableau.
      row.draggable = true;
      row.addEventListener('dragstart', (ev) => {
        if (!DW.dnd) { ev.preventDefault(); return; }
        rangement = { tbl, addr: e.addr };
        DW.dnd.startDrag(ev, { kind: 'vars', tabId: tab.id, tableId: tbl.id,
                               table: [{ addr: e.addr, periodMs: e.periodMs }] },
          () => removeFromTable(tbl, e.addr));
      });
      row.addEventListener('dragend', () => { rangement = null; });
      row.innerHTML =
        '<span class="badge fam-' + e.meta.family + '">' +
          DW.escapeHtml(DW.famBadge(e.meta)) + '</span>' +
        '<div class="v-id"><span class="v-addr"></span><span class="v-label"></span></div>' +
        '<div class="v-val"><button class="v-forced hide" type="button" ' +
          'title="Valeur forcée — cliquer pour relâcher">⏻</button>' +
          '<b class="val">—</b><span class="v-unit"></span><span class="v-trend"></span></div>' +
        '<button class="v-edit" type="button" title="Renommer l’affichage de cette variable">✎</button>' +
        '<button class="v-del" type="button" title="Retirer du tableau">✕</button>';
      row.querySelector('.v-addr').textContent = e.addr;
      const labelEl = row.querySelector('.v-label');
      labelEl.textContent = displayLabel(e) +
        (e.periodMs && e.periodMs !== CFG.defaultPeriodMs ? ' · rafr. ' + e.periodMs + ' ms' : '');
      labelEl.classList.toggle('renamed', !!e.name);
      row.querySelector('.v-unit').textContent = e.meta.unit || '';
      row.title = e.addr + ' — ' + displayLabel(e) +
        (e.name ? ' (' + e.meta.label + ')' : '') +
        (e.meta.unit ? ' (' + e.meta.unit + ')' : '') +
        ' · rafraîchissement ' + (e.periodMs || CFG.defaultPeriodMs) + ' ms' +
        ' · glissez cette ligne pour la ranger dans le tableau, ' +
        'ou vers un onglet ou une autre fenêtre';
      const badge = row.querySelector('.badge');
      badge.title = famTitle(e.meta.family, e.meta);
      row.querySelector('.v-val').title = 'Valeur instantanée' +
        (e.meta.kind === 'bit' ? ' (0 ou 1)' : '') +
        (e.meta.family === 'MB' ? ' — décimal et hexadécimal' : '') +
        '. La ligne clignote quand la variable change après 2 s d’immobilité.';
      row.querySelector('.v-trend').title =
        'Tendance sur les 2,5 dernières secondes (↗ hausse, ↘ baisse, → stable)';
      const edit = row.querySelector('.v-edit');
      edit.title = 'Nom d’affichage de ' + e.addr + ' (vide = libellé du catalogue)';
      edit.addEventListener('click', () => renameTableEntry(tbl, e, labelEl));
      row.querySelector('.v-forced').addEventListener('click', () => releaseVariable(e.addr));
      const del = row.querySelector('.v-del');
      del.title = 'Retirer ' + e.addr + ' du tableau';
      del.addEventListener('click', () => removeFromTable(tbl, e.addr));
      rows.appendChild(row);
    }
    const n = tbl.entries.length;
    tbl.countEl.textContent = n ? n + ' variable' + (n > 1 ? 's' : '') : 'vide';
    // Un tableau vide RESTE affiché : c'est une carte qu'on vient de créer et
    // dans laquelle on va déposer quelque chose. Le masquer donnerait
    // l'impression que le bouton n'a rien fait.
    updateEmptyState();
  }

  /** Poignée ◢ d'un tableau : exactement la même que celle d'un graphique. */
  function bindTableResize(tbl) {
    DW.mosaic.poigneeTaille(tbl, {
      grid: () => tbl.tab.chartsGridEl,
      tiles: () => tilesOf(tbl.tab),
      onChange,
    });
  }

  function updateTableValues() {
    const tab = state.active;
    if (!tab) return;
    const nowT = DW.source.now();
    const canForce = typeof DW.source.forced === 'function';
    for (const tbl of tab.tables) majValeurs(tbl, nowT, canForce);
  }

  /** Valeurs vivantes d'un tableau (~5 Hz). */
  function majValeurs(tbl, nowT, canForce) {
    const rows = tbl.rowsEl.children;
    for (let i = 0; i < tbl.entries.length && i < rows.length; i++) {
      const e = tbl.entries[i];
      // Marquage « forcé » : valeur imposée côté serveur (diagnostic)
      if (canForce) {
        const f = DW.source.forced(e.addr);
        rows[i].classList.toggle('forced', f != null);
        rows[i].querySelector('.v-forced').classList.toggle('hide', f == null);
      }
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
      heightMode: opts.heightMode,          // dispositions v2 : converti en rangées
      x: opts.x, y: opts.y, w: opts.w, h: opts.h,
    });
    tab.charts.push(chart);
    tab.chartsGridEl.appendChild(chart.root);
    bindCible(chart.root, chart);
    placerNouvelle(tab, chart);
    if (tab === state.active) refreshTargets();
    onChange();
    return chart;
  }

  // ---------- Cible d'ajout -------------------------------------------
  /**
   * Carte VISÉE par la barre du haut : un clic sur un tableau ou un graphique
   * en fait la destination d'ajout, et elle se signale par un liseré. Sans ce
   * repère, avec plusieurs cartes à l'écran, « Ajouter » devient un pari.
   */
  function setCible(carte) {
    const sel = $('targetSel');
    if (!carte) { majCible(); return; }
    sel.value = carte.entries ? 'table:' + carte.id : 'chart:' + carte.id;
    majCible();
  }

  /** Applique le liseré à la carte désignée par le sélecteur de destination. */
  function majCible() {
    const v = $('targetSel').value;
    const tab = state.active;
    if (!tab) return;
    for (const t of tab.tables) t.cardEl.classList.toggle('cible', v === 'table:' + t.id);
    for (const c of tab.charts) c.root.classList.toggle('cible', v === 'chart:' + c.id);
  }

  /**
   * Rend une carte cliquable pour la désigner. Le clic est ignoré sur les
   * commandes de la carte (boutons, champs, poignées) : on ne veut pas qu'un
   * changement d'échelle ou un renommage change aussi la destination.
   */
  function bindCible(el, carte) {
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, textarea, .resize-grip, .drag-handle')) return;
      setCible(carte);
    });
  }

  function refreshTargets() {
    const sel = $('targetSel');
    const prev = sel.value;
    sel.innerHTML = '';
    const opt = (v, label) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      sel.appendChild(o);
    };
    // Un choix par tableau et par graphique : avec plusieurs tableaux, « le »
    // tableau ne veut plus rien dire.
    if (state.active) {
      for (const t of state.active.tables) opt('table:' + t.id, '→ ' + t.name);
      for (const c of state.active.charts) opt('chart:' + c.id, '→ ' + c.title);
    }
    opt('newtable', '→ Nouveau tableau');
    opt('new', '→ Nouveau graphique');
    // « Nouveau tableau » et « Nouveau graphique » sont des ACTIONS, pas des
    // destinations : les laisser collants ferait créer une carte de plus à
    // chaque ajout — au démarrage, la liste est reconstruite avant que les
    // cartes n'existent, et le choix serait resté sur « Nouveau ».
    const action = prev === 'new' || prev === 'newtable' || !prev;
    const premier = state.active && state.active.tables[0];
    const defaut = premier ? 'table:' + premier.id
                 : (state.active && state.active.charts[0]
                    ? 'chart:' + state.active.charts[0].id : 'newtable');
    sel.value = (!action && [...sel.options].some((o) => o.value === prev)) ? prev : defaut;
    majCible();
  }

  // ---------- Ajout d'une variable ------------------------------------
  function addVariable(rawAddr, forcePeriodMs) {
    const raw = rawAddr != null ? rawAddr : $('searchInput').value;
    // Suffixe d'écriture « adresse = valeur » : forçage de la variable côté serveur.
    const w = DW.splitWrite(raw);
    if (w) {
      if (w.bad !== undefined) {
        toast('Valeur à forcer illisible : « ' + w.bad + ' ». Exemple : Q0.3 = 1', 'err');
        return false;
      }
      return forceVariable(w.base, w.value);
    }
    const p = DW.parseAddr(raw);
    if (!p.ok) { toast(p.error, 'err'); return false; }
    const target = $('targetSel').value;
    // Un point réseau porte sa propre période de lecture (configuration du lien).
    const netPeriod = p.family === 'NET' && DW.protocols ? DW.protocols.periodOf(p.addr) : null;
    const periodMs = forcePeriodMs || netPeriod ||
      parseInt($('periodSel').value, 10) || CFG.defaultPeriodMs;
    let destLabel = '';
    if (target === 'newtable' || target.startsWith('table:')) {
      const tbl = target === 'newtable'
        ? createTable(state.active, {})
        : (state.active.tables.find((t) => 'table:' + t.id === target) ||
           defaultTable(state.active));
      const r = addToTable(tbl, p.addr, periodMs);
      if (!r.ok) { toast(r.error, 'err'); return false; }
      if (target === 'newtable') setCible(tbl);
      destLabel = tbl.name;
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
      if (target === 'new') setCible(chart);
      destLabel = chart.title;
    }
    $('searchInput').value = '';
    hideSuggest();
    onChange();
    toast(p.addr + ' → ' + destLabel);
    return true;
  }

  // ---------- Forçage de variables (diagnostic) -----------------------
  /** Force une variable à une valeur ; l'ajoute au tableau pour la rendre visible. */
  function forceVariable(base, value) {
    const p = DW.parseAddr(base);
    if (!p.ok) { toast(p.error, 'err'); return false; }
    if (p.family === 'NET') {
      toast('Point réseau en lecture seule — forçage impossible (' + p.addr + ').', 'err');
      return false;
    }
    if (typeof DW.source.write !== 'function') {
      toast('Le forçage n’est pas disponible avec cette source de données.', 'err');
      return false;
    }
    // Rendre la variable visible pour que l'effet du forçage se voie.
    if (!inAnyTable(state.active, p.addr) && !chartsHave(state.active, p.addr)) {
      addToTable(defaultTable(state.active), p.addr, undefined);
    }
    const shown = p.kind === 'bit' ? (value >= 0.5 ? '1' : '0') : DW.fmtVal(value, { kind: p.kind });
    Promise.resolve(DW.source.write(p.addr, value)).then((res) => {
      if (res && res.ok) {
        $('searchInput').value = '';
        hideSuggest();
        toast(p.addr + ' forcé à ' + shown + '.');
      } else {
        toast('Forçage refusé : ' + ((res && res.error) || 'raison inconnue'), 'err');
      }
    });
    return true;
  }

  /** Relâche une variable forcée (retour à son évolution normale). */
  function releaseVariable(addr) {
    if (typeof DW.source.write !== 'function') return;
    Promise.resolve(DW.source.write(addr, null)).then((res) => {
      if (res && res.ok) toast(addr + ' relâché (valeur non forcée).');
      else toast('Impossible de relâcher : ' + ((res && res.error) || 'raison inconnue'), 'err');
    });
  }

  function chartsHave(tab, addr) {
    return tab.charts.some((c) => c.series.some((s) => s.addr === addr));
  }

  // ---------- Autocomplétion ------------------------------------------
  let sugIndex = -1;
  let famFilter = 'all';   // 'all' | 'PLC' (I/Q/M/S) | 'MB' | 'CAPI' | 'NET'
  const FAM_FILTERS = [
    ['all', 'Toutes'],
    ['PLC', 'PLC'],
    ['MB', 'Modbus'],
    ['CAPI', 'Matlab'],
    ['NET', 'Réseau'],
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
      '<span class="badge fam-' + entry.family + '">' +
        DW.escapeHtml(DW.famBadge(entry)) + '</span>' +
      '<span class="sug-addr"></span><span class="sug-label"></span><span class="sug-unit"></span>';
    b.querySelector('.sug-addr').textContent = entry.addr;
    b.querySelector('.sug-label').textContent = entry.label || '';
    b.querySelector('.sug-unit').textContent = entry.unit || '';
    b.querySelector('.badge').title = famTitle(entry.family, entry);
    b.title = entry.addr + ' — ' + (entry.label || '') +
      (entry.unit ? ' (' + entry.unit + ')' : '') + ' · appuyez pour ajouter';
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

  /** Catalogue proposé : variables du contrôleur + points des liens réseau. */
  function suggestPool() {
    const net = DW.protocols ? DW.protocols.catalog() : [];
    return CATALOG_F.concat(net);
  }

  function updateSuggest() {
    const box = $('suggestBox');
    const q = $('searchInput').value.trim().toLowerCase();
    box.innerHTML = '';

    // Filtres par type de variable (PLC / Modbus / Matlab)
    const bar = document.createElement('div');
    bar.className = 'sug-filters';
    for (const [key, label] of FAM_FILTERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fbtn' + (famFilter === key ? ' on' : '');
      b.textContent = label;
      b.title = FILTER_TITLES[key];
      // pointerdown pour ne pas faire perdre le focus à l'input
      b.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        famFilter = key;
        updateSuggest();
      });
      bar.appendChild(b);
    }
    box.appendChild(bar);

    const pool = suggestPool().filter((e) => matchFilter(e.family));
    let list;
    if (!q) {
      const help = document.createElement('div');
      help.className = 'sug-help';
      help.innerHTML = 'Formats : <code>I1.2.3.4</code> <code>Q14.15</code> <code>M1.14</code> ' +
        '<code>S0.4</code> <code>MB414</code> <code>Modele.signal</code> <code>@lien.point</code>';
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
  function serializeTable(tbl) {
    return tbl.entries.map((e) => ({ addr: e.addr, periodMs: e.periodMs, name: e.name }));
  }

  /**
   * Format v3 : chaque tuile porte sa place et sa taille dans la mosaïque
   * (`x`, `y`, `w`, `h`), en colonnes et en rangées — indépendantes de la
   * largeur de l'écran, donc transposables d'un poste à l'autre. Les formats
   * v1 et v2 (rang « pos » dans la grille, hauteur en pixels, largeur en
   * colonnes « naturelles ») restent lus et convertis — voir applyConfigToActive.
   */
  function serializeConfig(tab) {
    const tuile = (t) => ({ x: t.x, y: t.y, w: t.w, h: t.h });
    return {
      version: 3,
      tables: tab.tables.map((t) => Object.assign({ name: t.name },
        tuile(t), { entries: serializeTable(t) })),
      charts: tab.charts.map((c) => c.serialize()),
    };
  }

  // ---------- Déplacement de widgets (onglets, fenêtres) ---------------
  /**
   * Crée un graphique depuis une configuration sérialisée, dans `tab`.
   * `place` ({cell:{x,y}}) permet de le poser à un endroit précis de la
   * mosaïque — celui que l'utilisateur a visé en lâchant la tuile.
   */
  function addChartFromConfig(cfg, tab, place) {
    const target = tab || state.active;
    if (target.charts.length >= CFG.maxCharts) {
      toast('Limite de ' + CFG.maxCharts + ' graphiques par onglet atteinte.', 'err');
      return null;
    }
    // On ne bascule pas d'onglet : en multi-écran, l'utilisateur range des
    // widgets sans quitter ce qu'il regarde (un message indique la cible).
    const cell = place && place.cell;
    const chart = createChart({
      title: cfg.title, windowS: cfg.windowS, heightMode: cfg.heightMode,
      w: cfg.w, h: cfg.h,
      // Sans point de chute désigné, la tuile va à la première place libre :
      // c'est placerNouvelle qui décide (x/y laissés vides).
      x: cell ? cell.x : undefined, y: cell ? cell.y : undefined,
    }, target);
    if (chart) {
      for (const s of cfg.series || []) {
        const p = DW.parseAddr(s.addr);
        if (p.ok) {
          chart.addSeries(p.addr, {
            axisMode: s.axisMode, visible: s.visible !== false,
            periodMs: s.periodMs, offsetY: s.offsetY,
            colorIdx: s.colorIdx, color: s.color, name: s.name,
          });
        }
      }
    }
    return chart;
  }

  /**
   * Pose une tuile à la cellule visée. La tuile tenue ne bouge pas : ce sont
   * les voisines qui s'écartent puis se tassent. C'est ce qui fait le
   * placement libre — poser un graphique à gauche d'un tableau, par exemple.
   */
  function placeTile(tuile, tab, place) {
    if (!place || !place.cell) return;
    tuile.x = place.cell.x;
    tuile.y = place.cell.y;
    DW.mosaic.agencer(tab.chartsGridEl, tilesOf(tab), tuile);
    onChange();
  }

  /** Duplique un graphique (courbes, échelles, couleurs) juste après lui. */
  function duplicateChart(chart) {
    const tab = state.tabs.find((t) => t.charts.includes(chart)) || state.active;
    const cfg = chart.serialize();
    cfg.title = cfg.title + ' (copie)';
    // La copie se pose juste sous l'original, à la même largeur : c'est là
    // qu'on la cherche du regard.
    const copy = addChartFromConfig(cfg, tab, { cell: { x: chart.x, y: chart.y + chart.h } });
    if (copy) toast('« ' + cfg.title +' » créé.');
    return copy;
  }

  function moveChartToTab(chart, tab) {
    const cfg = chart.serialize();
    // Créer d'abord dans la cible : si elle est pleine (limite de graphiques),
    // l'original n'est pas détruit — jamais de perte.
    const created = addChartFromConfig(cfg, tab);
    if (!created) return;   // addChartFromConfig a déjà signalé la limite
    appApi.removeChart(chart);
    toast('« ' + cfg.title + ' » déplacé vers « ' + tab.name + ' ».');
    onChange();
  }

  /**
   * Réception d'un widget déposé (glisser-déposer ou nouvelle fenêtre).
   * @returns 'reordered' si le widget était déjà là et n'a été que rangé,
   *          true s'il a été créé, false sinon.
   */
  function receiveWidget(o, tab, place, sameWindow) {
    const target = tab || state.active;
    // Tableau de CET onglet lâché sur une carte : simple rangement dans la
    // grille (un graphique passe alors à sa gauche ou à sa droite), surtout
    // pas un déplacement de ses variables.
    if (o.kind === 'table' && sameWindow && place && o.tabId === target.id) {
      const tbl = target.tables.find((t) => t.id === o.tableId);
      if (tbl) { placeTile(tbl, target, place); return 'reordered'; }
    }
    if (o.kind === 'chart' && o.chart) {
      // Graphique déjà présent dans cet onglet : simple réorganisation
      if (sameWindow && o.chartId) {
        const existing = target.charts.find((c) => c.id === o.chartId);
        if (existing) {
          if (place) placeTile(existing, target, place);
          return 'reordered';
        }
      }
      if (!addChartFromConfig(o.chart, target, place)) return false;
    } else if (o.kind === 'table' && o.table) {
      // Un tableau déposé ailleurs arrive comme un NOUVEAU tableau : c'est le
      // regroupement qui fait sens, pas la fusion avec un tableau existant.
      const cell = place && place.cell;
      const tbl = createTable(target, { name: o.title, w: o.w, h: o.h,
                                        x: cell ? cell.x : undefined,
                                        y: cell ? cell.y : undefined });
      let n = 0;
      for (const e of o.table) {
        const p = DW.parseAddr(e.addr);
        if (p.ok && addToTable(tbl, p.addr, e.periodMs, e.name).ok) n++;
      }
      if (!n) { removeTable(tbl); toast('Ces variables sont déjà présentes.', 'err'); return false; }
    } else if (o.kind === 'vars' && o.table) {
      // Variable seule : elle va dans le tableau visé s'il y en a un sous le
      // curseur, sinon dans le premier de l'onglet.
      const vise = place && place.overEl &&
        target.tables.find((t) => t.cardEl === place.overEl);
      const tbl = vise || defaultTable(target);
      let n = 0;
      for (const e of o.table) {
        const p = DW.parseAddr(e.addr);
        if (p.ok && addToTable(tbl, p.addr, e.periodMs, e.name).ok) n++;
      }
      if (!n) { toast('Ces variables sont déjà présentes dans « ' + tbl.name + ' ».', 'err'); return false; }
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
    data = data || {};

    // Formats v1 et v2 : les cartes n'avaient qu'un RANG dans la grille
    // (« pos »), une hauteur en pixels et une largeur en « colonnes
    // naturelles » dont le nombre dépendait de l'écran. Ils sont convertis en
    // tuiles de la mosaïque plutôt que traités à part : une seule route dans
    // le code, et les dispositions enregistrées avant s'ouvrent telles quelles.
    let tables;
    if (Array.isArray(data.tables)) {
      tables = data.tables;
    } else {
      // v1 : un seul tableau. Sans variable, on n'en crée aucun — une carte
      // vide surgie d'une ancienne disposition n'aurait aucun sens.
      const anciennes = data.table || [];
      tables = anciennes.length ? [{
        name: 'Valeurs numériques',
        h: data.tableH, cols: data.tableCols, pos: data.tableAfter || 0,
        entries: anciennes,
      }] : [];
    }
    const ancien = !(data.version >= 3);

    const cartes = [];        // {pos, tuile} — pour convertir l'ancien rang
    for (const t of tables) {
      if (!t) continue;
      const g = ancien ? migrerTuile(t, 'table') : t;
      const tbl = createTable(tab, { name: t.name, x: g.x, y: g.y, w: g.w, h: g.h });
      for (const entry of t.entries || []) {
        // Rétro-compatibilité : entrée sous forme de chaîne (format initial)
        const addr = typeof entry === 'string' ? entry : entry.addr;
        const periodMs = typeof entry === 'string' ? undefined : entry.periodMs;
        const name = typeof entry === 'string' ? undefined : entry.name;
        const p = DW.parseAddr(addr);
        if (p.ok) addToTable(tbl, p.addr, periodMs, name);
      }
      cartes.push({ pos: isFinite(t.pos) ? t.pos : cartes.length, tuile: tbl });
    }

    for (const c of data.charts || []) {
      const g = ancien ? migrerTuile(c, 'chart') : c;
      const chart = createChart({
        title: c.title, windowS: c.windowS, heightMode: c.heightMode,
        x: g.x, y: g.y, w: g.w, h: g.h,
      });
      if (!chart) break;
      for (const s of c.series || []) {
        const p = DW.parseAddr(s.addr);
        if (p.ok) {
          chart.addSeries(p.addr, {
            axisMode: s.axisMode, visible: s.visible !== false,
            periodMs: s.periodMs, offsetY: s.offsetY,
            colorIdx: s.colorIdx, color: s.color, name: s.name,
          });
        }
      }
      cartes.push({ pos: isFinite(c.pos) ? c.pos : cartes.length, tuile: chart });
    }

    // Anciennes dispositions : le rang « pos » était un ordre de flux, la
    // grille plaçant les cartes de gauche à droite puis à la ligne. On rejoue
    // exactement ce flux — chaque tuile à la première place libre, dans
    // l'ordre — plutôt que de tout empiler : deux demi-largeurs qui étaient
    // côte à côte le restent.
    if (ancien) {
      cartes.sort((a, b) => a.pos - b.pos);
      const posees = [];
      for (const c of cartes) {
        const p = DW.mosaic.placeLibre(posees, c.tuile.w, c.tuile.h);
        c.tuile.x = p.x; c.tuile.y = p.y;
        posees.push(c.tuile);
      }
    }
    DW.mosaic.agencer(tab.chartsGridEl, tilesOf(tab));

    refreshTargets();
    updateEmptyState();
    onChange();
  }

  /**
   * Traduit une carte d'une disposition v1/v2 en tuile de la mosaïque.
   * L'ancienne largeur était un nombre de colonnes « naturelles » (~4 sur un
   * écran de bureau) : elle vaut trois colonnes de douze. L'ancienne hauteur
   * était en pixels sur le CONTENU ; on lui rajoute l'en-tête et la légende
   * avant de la convertir en rangées.
   */
  function migrerTuile(c, kind) {
    const d = DW.mosaic.defaut(kind);
    const cols = Number(c.cols || c.colSpan);
    const px = Number(kind === 'table' ? c.h : c.customH);
    const chrome = kind === 'table' ? 44 : 104;
    const g = { x: 0, y: 0, w: d.w, h: d.h };
    if (isFinite(cols) && cols > 0) g.w = Math.max(2, Math.min(12, Math.round(cols * 3)));
    if (isFinite(px) && px > 0) {
      g.h = Math.max(DW.mosaic.MIN_H,
                     Math.round((px + chrome + DW.mosaic.GAP) / (DW.mosaic.ROW_H + DW.mosaic.GAP)));
    } else if (kind === 'chart' && c.heightMode) {
      g.h = { M: 9, L: 12, XL: 15 }[c.heightMode] || d.h;
    }
    return g;
  }

  // ---------- Journalisation des données ------------------------------
  function tabAddrs(tab) {
    const set = new Set();
    for (const tbl of tab.tables) for (const e of tbl.entries) set.add(e.addr);
    for (const c of tab.charts) for (const s of c.series) set.add(s.addr);
    return set;
  }

  /** Journalisation navigateur ou serveur, selon la destination de l'onglet. */
  function startLogging(tab) {
    if (tab.log.dest === 'server') return startServerLog(tab);
    tab.log.enabled = true;
    tab.log.enableT = DW.source.now();
    tab.log.lastT = {};
    rebuildTabbar();
    updateLogUi();
    onChange();
  }
  function stopLogging(tab) {
    if (tab.log.dest === 'server') return stopServerLog(tab);
    tab.log.enabled = false;
    rebuildTabbar();
    updateLogUi();
    onChange();
  }

  /** La journalisation serveur n'est possible que si la page est servie par lui. */
  function serverLogAvailable() { return DW.sourceMode === 'ws'; }

  function startServerLog(tab) {
    if (!serverLogAvailable()) {
      toast('Journalisation serveur indisponible : cette page n’est pas servie par le serveur de diagnostic.', 'err');
      return;
    }
    const addrs = [...tabAddrs(tab)].map((addr) => {
      let src = null;
      for (const tbl of tab.tables) src = src || tbl.entries.find((e) => e.addr === addr);
      let periodMs = src && src.periodMs;
      for (const c of tab.charts) for (const s of c.series) if (s.addr === addr && s.periodMs) {
        periodMs = periodMs ? Math.min(periodMs, s.periodMs) : s.periodMs;
      }
      return { addr, periodMs: periodMs || CFG.defaultPeriodMs };
    });
    if (!addrs.length) { toast('Aucune variable à journaliser dans cet onglet.', 'err'); return; }
    fetch('/api/datalog/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tab.name, addrs }),
    }).then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(() => {
        tab.log.enabled = true;
        rebuildTabbar();
        updateLogUi();
        onChange();
        toast('Journalisation serveur démarrée — elle continue même page fermée.');
      })
      .catch(() => toast('Le serveur a refusé de démarrer la journalisation.', 'err'));
  }

  function stopServerLog(tab) {
    fetch('/api/datalog/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tab.name }),
    }).catch(() => {}).finally(() => {
      tab.log.enabled = false;
      rebuildTabbar();
      updateLogUi();
      onChange();
    });
  }

  /** État des campagnes de journalisation côté serveur (ou [] si indisponible). */
  function fetchServerLogStatus() {
    if (!serverLogAvailable()) return Promise.resolve([]);
    return fetch('/api/datalog', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : [])
      .catch(() => []);
  }

  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; }
    return lo;
  }

  function logTick() {
    for (const tab of state.tabs) {
      const lg = tab.log;
      // Seule la journalisation « navigateur » accumule en mémoire de la page.
      // La journalisation « serveur » est autonome (elle continue page fermée).
      if (!lg.enabled || lg.dest === 'server') continue;
      for (const addr of tabAddrs(tab)) {
        const d = DW.source.data(addr);
        if (!d.ts.length) continue;
        const from = (addr in lg.lastT) ? lg.lastT[addr] : lg.enableT;
        const i0 = lowerBound(d.ts, from);
        for (let i = i0; i < d.ts.length; i++) {
          lg.rows.push([d.ts[i], addr, d.vs[i]]);
        }
        if (i0 < d.ts.length) lg.lastT[addr] = d.ts[d.ts.length - 1];
      }
      if (lg.rows.length > LOG_MAX_ROWS) {
        lg.rows.splice(0, lg.rows.length - LOG_MAX_ROWS);
        lg.truncated = true;
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
    const available = serverLogAvailable();
    back.innerHTML =
      '<div class="modal" role="dialog" aria-label="Journalisation">' +
        '<header class="m-head"><h3>Journal de données — <span id="logTabName"></span></h3>' +
        '<button class="iconbtn m-close" type="button" title="Fermer cette fenêtre">✕</button></header>' +
        '<div class="log-opts">' +
          '<label title="Le journal reste en mémoire de cette page : à télécharger avant de la fermer">' +
          '<input type="radio" name="logdest" value="browser" title="Journaliser en mémoire du navigateur"> Navigateur (mémoire de la page)</label>' +
          '<label title="Le serveur de diagnostic enregistre sur disque, même la page fermée">' +
          '<input type="radio" name="logdest" value="server"' + (available ? '' : ' disabled') +
          ' title="Journaliser côté serveur (autonome)"> Serveur (autonome, sur disque)' +
          '<span class="opt-note" id="logServerNote"></span></label>' +
        '</div>' +
        '<div class="log-status" id="logStatus" ' +
          'title="État du journal : échantillons, variables suivies, taille">—</div>' +
        '<div class="m-actions" id="logActions"></div>' +
        '<p class="m-note" id="logNote"></p>' +
      '</div>';
    root.appendChild(back);
    back.querySelector('#logTabName').textContent = tab.name;
    if (!available) {
      back.querySelector('#logServerNote').textContent =
        ' — indisponible : page non servie par le serveur de diagnostic';
      if (lg.dest === 'server') lg.dest = 'browser';
    }

    let statusTimer = 0;
    const close = () => { clearInterval(statusTimer); root.innerHTML = ''; };
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    back.querySelector('.m-close').addEventListener('click', close);

    const statusEl = back.querySelector('#logStatus');
    const noteEl = back.querySelector('#logNote');
    const actionsEl = back.querySelector('#logActions');

    for (const r of back.querySelectorAll('input[name="logdest"]')) {
      r.checked = r.value === lg.dest;
      r.addEventListener('change', () => {
        if (r.disabled) return;
        lg.dest = r.value;
        onChange();
        renderActions();
        refresh();
      });
    }

    // --- Rendu des actions selon la destination ----------------------
    function actBtn(id, label, cls, title) {
      const b = document.createElement('button');
      b.id = id; b.type = 'button'; b.className = 'btn' + (cls ? ' ' + cls : '');
      b.textContent = label; b.title = title;
      actionsEl.appendChild(b);
      return b;
    }
    function renderActions() {
      actionsEl.innerHTML = '';
      const toggle = actBtn('logToggle', '', 'primary',
        'Démarrer ou arrêter l’enregistrement des variables de cet onglet');
      toggle.textContent = lg.enabled ? '⏹ Arrêter la journalisation' : '⏺ Démarrer la journalisation';
      toggle.addEventListener('click', () => {
        lg.enabled ? stopLogging(tab) : startLogging(tab);
        setTimeout(refresh, 150);
      });
      if (lg.dest === 'server') {
        actBtn('logDl', 'Télécharger CSV', '', 'Télécharger le journal enregistré par le serveur')
          .addEventListener('click', () => {
            window.open('/api/datalog/file?name=' + encodeURIComponent(tab.name), '_blank');
          });
        noteEl.textContent = 'La journalisation serveur écrit sur le disque du contrôleur et ' +
          'continue même si vous fermez ou rechargez cette page. Le CSV se télécharge à tout moment.';
      } else {
        actBtn('logDlCsv', 'Télécharger CSV', '', 'Télécharger le journal en CSV (horodatage, adresse, valeur)')
          .addEventListener('click', () => {
            if (!lg.rows.length) { toast('Journal vide.', 'err'); return; }
            DW.store.download('journal_' + tab.name, DW.store.logCsv(lg.rows), 'csv', 'text/csv');
          });
        actBtn('logDlJson', 'Télécharger JSON', '', 'Télécharger le journal en JSON')
          .addEventListener('click', () => {
            if (!lg.rows.length) { toast('Journal vide.', 'err'); return; }
            const payload = JSON.stringify({ app: 'diagweb-journal', version: 1, tab: tab.name, rows: lg.rows });
            DW.store.download('journal_' + tab.name, payload, 'json', 'application/json');
          });
        actBtn('logClear', 'Vider', '', 'Effacer les échantillons déjà enregistrés en mémoire')
          .addEventListener('click', () => {
            lg.rows = []; lg.truncated = false; lg.lastT = {}; lg.enableT = DW.source.now();
            refresh();
            toast('Journal vidé.');
          });
        noteEl.textContent = 'Le journal reste en mémoire de cette page (100 000 lignes au plus) : ' +
          'téléchargez-le avant de fermer ou recharger. Pour un enregistrement durable, choisissez ' +
          '« Serveur ».';
      }
    }

    // --- Rafraîchissement de l'état ----------------------------------
    function refresh() {
      const nVars = tabAddrs(tab).size;
      if (lg.dest === 'server') {
        fetchServerLogStatus().then((list) => {
          const c = list.find((x) => x.name === serverCampaignName(tab.name));
          const on = !!c;
          if (on !== lg.enabled) { lg.enabled = on; rebuildTabbar(); updateLogUi(); }
          const n = c ? c.samples : 0;
          const size = c ? c.sizeBytes : 0;
          statusEl.innerHTML = (on ? '⏺ En cours (serveur)' : '⏸ À l’arrêt') + ' · ' +
            n.toLocaleString('fr-FR') + ' échantillon' + (n > 1 ? 's' : '') + ' · ' +
            (c ? c.vars : nVars) + ' variable' + ((c ? c.vars : nVars) > 1 ? 's' : '') + ' · ' +
            (size / 1048576).toFixed(2) + ' Mo sur disque';
          const t = back.querySelector('#logToggle');
          if (t) t.textContent = on ? '⏹ Arrêter la journalisation' : '⏺ Démarrer la journalisation';
        });
        return;
      }
      const n = lg.rows.length;
      const durS = n ? (lg.rows[n - 1][0] - lg.rows[0][0]) : 0;
      const sizeMo = (n * 34 / 1048576);
      statusEl.innerHTML =
        (lg.enabled ? '⏺ En cours' : '⏸ À l’arrêt') + ' · ' +
        n.toLocaleString('fr-FR') + ' échantillon' + (n > 1 ? 's' : '') + ' · ' +
        nVars + ' variable' + (nVars > 1 ? 's' : '') + ' · ' +
        durS.toFixed(0) + ' s couvertes · ~' + sizeMo.toFixed(1) + ' Mo CSV' +
        (lg.truncated ? '<br>⚠ plafond atteint : les lignes les plus anciennes ont été éliminées' : '');
    }

    renderActions();
    refresh();
    statusTimer = setInterval(refresh, 1000);
  }

  /** Nom de campagne serveur : mêmes règles d'assainissement que le serveur. */
  function serverCampaignName(name) {
    let clean = String(name || '').replace(/[/\\.:\0]/g, '_').slice(0, 80);
    if (!clean) clean = 'sans-nom';
    return clean;
  }

  function updateLogUi() {
    const on = state.active && state.active.log.enabled;
    $('logInd').classList.toggle('hide', !on);
  }

  // ---------- Disposition de démonstration ----------------------------
  // Elle est en format v3 : le tableau à gauche, les deux graphiques empilés à
  // sa droite. C'est la disposition qu'on ne pouvait pas obtenir avant, et
  // c'est celle qu'on veut montrer d'entrée.
  const DEMO = {
    version: 3,
    tables: [{
      name: 'Valeurs numériques', x: 0, y: 0, w: 5, h: 18,
      entries: ['I1.2.3.4', 'Q14.15', 'S0.4', 'MB414', 'Elec.tension_bus',
                'Supervision.temps_cycle'],
    }],
    charts: [
      {
        title: 'Régulation vitesse', windowS: 60, x: 5, y: 0, w: 7, h: 9,
        series: [
          { addr: 'Regulation.mesure.vitesse' },
          { addr: 'Regulation.consigne.vitesse' },
          { addr: 'Elec.puissance_active' },
        ],
      },
      {
        title: 'Thermique & pression', windowS: 120, x: 5, y: 9, w: 7, h: 9,
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
    const empty = !tab || (tab.tables.every((t) => !t.entries.length) && tab.charts.length === 0);
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
        '<header class="m-head"><h3>Configurations</h3><button class="iconbtn m-close" type="button" title="Fermer cette fenêtre">✕</button></header>' +
        '<label class="m-label" for="layName">Nom de la configuration (onglet actif)</label>' +
        '<input id="layName" class="m-input" maxlength="60" ' +
          'title="Nom sous lequel enregistrer, télécharger ou copier cette configuration">' +
        '<div class="m-actions acc-row">' +
          '<button class="btn acc-btn" data-acc="save" type="button" ' +
            'title="Mémoriser cette configuration dans le navigateur ou dans le contrôleur">Enregistrer ▾</button>' +
          '<button class="btn acc-btn" data-acc="download" type="button" ' +
            'title="Obtenir un fichier : JSON réimportable, ou CSV de consultation">Télécharger ▾</button>' +
          '<button class="btn acc-btn" data-acc="load" type="button" ' +
            'title="Ouvrir une configuration enregistrée ou un fichier, dans un nouvel onglet">Charger ▾</button>' +
          '<button class="btn acc-btn" data-acc="copy" type="button" ' +
            'title="Copier la configuration dans le presse-papiers, pour l’envoyer à quelqu’un">Copier ▾</button>' +
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
            '<button class="btn primary" id="laySaveLocal" type="button" ' +
              'title="Enregistrer dans ce navigateur (partagé entre toutes ses fenêtres)">Navigateur</button>' +
            '<button class="btn" id="laySaveCtl" type="button" ' +
              'title="Enregistrer dans le contrôleur (nécessite le serveur de diagnostic)">Contrôleur</button>' +
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
            '<button class="btn primary" id="layDlJson" type="button" ' +
              'title="Fichier .diagweb.json — réimportable dans Diagweb">JSON</button>' +
            '<button class="btn" id="layDlCsv" type="button" ' +
              'title="Fichier .csv — pour tableur, en lecture seule">CSV</button>' +
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
            '<button class="btn primary" id="layCpJson" type="button" ' +
              'title="Copier la configuration au format JSON">JSON</button>' +
            '<button class="btn" id="layCpCsv" type="button" ' +
              'title="Copier la liste des variables au format CSV">CSV</button>' +
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
          '<label class="btn m-import" title="Ouvrir un fichier .diagweb.json reçu ou exporté précédemment">' +
          'Importer un fichier<input type="file" id="layImport" accept=".json,application/json" hidden></label></div>' +
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
            '<button class="btn sm" data-a="load" type="button" ' +
              'title="Ouvrir cette configuration dans un nouvel onglet">Charger</button>' +
            '<button class="iconbtn" data-a="dl" type="button" title="Télécharger cette configuration en JSON">⬇</button>' +
            '<button class="iconbtn star' + (auto === it.name ? ' on' : '') + '" data-a="auto" type="button" title="Charger automatiquement à l’ouverture">★</button>' +
            '<button class="iconbtn" data-a="del" type="button" title="Supprimer cette configuration enregistrée">🗑</button>' +
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

  // ---------- Apparence : logo et couleurs -----------------------------
  /**
   * Fenêtre « Apparence ». Le logo et les couleurs appartiennent à
   * l'installation : servis par le contrôleur, ils valent pour tous les postes
   * connectés ; page ouverte hors serveur, ils restent dans ce navigateur.
   * L'aperçu est immédiat — on juge une couleur sur l'interface, pas sur une
   * pastille.
   */
  function openAppearance() {
    const A = DW.appearance;
    if (!A) return;
    const root = $('modalRoot');
    root.innerHTML = '';
    const sombre = DW.isDarkTheme();
    const portee = A.surServeur()
      ? 'Enregistré sur le contrôleur : tous les postes connectés voient la même identité.'
      : 'Page ouverte hors serveur : ces réglages restent dans ce navigateur.';
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal skin" role="dialog" aria-label="Apparence">' +
        '<header class="m-head"><h3>Apparence</h3>' +
          '<button class="iconbtn m-close" type="button" title="Fermer">✕</button></header>' +
        '<p class="m-note">' + DW.escapeHtml(portee) + '</p>' +
        '<div class="m-section">' +
          '<span class="m-label">Logo de l’installation</span>' +
          '<div class="skin-logo">' +
            '<span class="skin-prev" title="Aperçu du logo, à la taille où il s’affiche"></span>' +
            '<div class="skin-logo-act">' +
              '<button class="btn skin-pick" type="button" ' +
                'title="Choisir une image : PNG, JPEG, SVG ou WebP. Elle est réduite et ' +
                'incorporée à la configuration — aucune ressource extérieure n’est appelée">' +
                'Choisir une image…</button>' +
              '<button class="btn skin-clear" type="button" ' +
                'title="Revenir au logo de Diagweb">Retirer</button>' +
              '<input class="skin-file hide" type="file" accept="image/*" ' +
                'aria-label="Fichier image du logo">' +
            '</div>' +
          '</div>' +
          '<p class="m-note">Réduite à 128 px de haut et incorporée à la page ' +
            '(384 ko au plus). Elle sert aussi d’icône d’onglet.</p>' +
        '</div>' +
        '<div class="m-section">' +
          '<span class="m-label">Couleurs — thème ' + (sombre ? 'sombre' : 'clair') + '</span>' +
          '<div class="skin-colors"></div>' +
          '<p class="m-note">Chaque thème garde ses propres couleurs : basculez le thème ' +
            '(☰) pour régler l’autre. Les gris et les nuances d’accent en sont déduits.</p>' +
        '</div>' +
        '<footer class="m-actions">' +
          '<button class="btn skin-reset" type="button" ' +
            'title="Remettre les couleurs de ce thème à celles du produit">Couleurs d’origine</button>' +
          '<span class="skin-msg"></span>' +
          '<button class="btn primary skin-ok" type="button" ' +
            'title="Enregistrer l’apparence">Enregistrer</button>' +
        '</footer>' +
      '</div>';

    const prev = back.querySelector('.skin-prev');
    const majPrev = () => {
      prev.innerHTML = '';
      const uri = A.etat().logo;
      if (uri) {
        const img = document.createElement('img');
        img.src = uri;
        img.alt = 'Logo choisi';
        prev.appendChild(img);
      } else {
        prev.textContent = 'logo Diagweb';
        prev.classList.add('vide');
      }
      prev.classList.toggle('vide', !uri);
    };
    majPrev();

    const colors = back.querySelector('.skin-colors');
    const champs = [];
    for (const t of A.TOKENS) {
      const l = document.createElement('label');
      l.className = 'skin-color';
      l.title = t.help;
      l.innerHTML = '<input type="color" aria-label="' + DW.escapeHtml(t.label) + '">' +
                    '<span></span>';
      l.querySelector('span').textContent = t.label;
      const inp = l.querySelector('input');
      inp.value = A.valeur(t.key);
      inp.title = t.help;
      // Aperçu à la volée : on juge une couleur sur l'interface entière.
      inp.addEventListener('input', () => A.setCouleur(t.key, inp.value));
      champs.push({ t, inp });
      colors.appendChild(l);
    }

    const file = back.querySelector('.skin-file');
    const msg = back.querySelector('.skin-msg');
    back.querySelector('.skin-pick').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      A.lireLogo(f).then((uri) => {
        A.setLogo(uri);
        majPrev();
        const ko = uri.length / 1024;
        msg.textContent = 'Image chargée (' +
          (ko < 1 ? 'moins de 1' : Math.round(ko)) + ' ko).';
      }).catch((e) => {
        msg.textContent = 'Refusé : ' + e.message;
        toast('Logo refusé : ' + e.message, 'err');
      });
      file.value = '';
    });
    back.querySelector('.skin-clear').addEventListener('click', () => {
      A.setLogo('');
      majPrev();
      msg.textContent = 'Logo retiré.';
    });
    back.querySelector('.skin-reset').addEventListener('click', () => {
      A.reinitialiserCouleurs();
      for (const c of champs) c.inp.value = A.valeur(c.t.key);
      msg.textContent = 'Couleurs d’origine rétablies.';
    });
    back.querySelector('.skin-ok').addEventListener('click', () => {
      A.enregistrer().then((r) => {
        if (r.ok) {
          root.innerHTML = '';
          toast('Apparence enregistrée (' + r.portee + ').');
        } else {
          msg.textContent = r.error;
          toast('Enregistrement refusé : ' + r.error, 'err');
        }
      });
    });
    const fermer = () => { root.innerHTML = ''; A.charger(); };   // annule l'aperçu
    back.querySelector('.m-close').addEventListener('click', fermer);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) fermer(); });
    root.appendChild(back);
  }

  // ---------- Sélecteur de variables (bouton « + ») --------------------
  /**
   * Grande fenêtre d'ajout, ouverte par le « + » d'un tableau ou d'un
   * graphique. La barre de recherche du haut reste le chemin rapide, au
   * clavier ; celle-ci est le chemin confortable : on voit le catalogue, on
   * filtre, et on ajoute PLUSIEURS variables d'un coup — la destination étant
   * déjà connue, puisqu'on est parti de son bouton.
   *
   * @param dest {kind:'table', tab} ou {kind:'chart', chart}
   */
  function openVarPicker(dest) {
    const root = $('modalRoot');
    root.innerHTML = '';
    const nom = dest.kind === 'table' ? dest.table.name : dest.chart.title;
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal wide vpick" role="dialog" aria-label="Ajouter des variables">' +
        '<header class="m-head"><h3></h3>' +
          '<button class="iconbtn m-close" type="button" title="Fermer sans ajouter">✕</button>' +
        '</header>' +
        '<div class="vp-bar">' +
          '<input class="vp-q" type="search" placeholder="Filtrer par adresse ou libellé…" ' +
            'title="Filtrer le catalogue ; une adresse hors catalogue peut aussi être saisie ici">' +
          '<select class="vp-period" title="Période de rafraîchissement des variables ajoutées"></select>' +
        '</div>' +
        '<div class="vp-filters" role="group" aria-label="Familles"></div>' +
        '<div class="vp-list" role="listbox" aria-multiselectable="true"></div>' +
        '<footer class="m-actions">' +
          '<span class="vp-count" title="Nombre de variables cochées"></span>' +
          '<button class="btn vp-cancel" type="button" title="Fermer sans rien ajouter">Annuler</button>' +
          '<button class="btn primary vp-ok" type="button" ' +
            'title="Ajouter les variables cochées à cette destination">Ajouter</button>' +
        '</footer>' +
      '</div>';
    back.querySelector('h3').textContent = 'Ajouter des variables → ' + nom;

    const q = back.querySelector('.vp-q');
    const list = back.querySelector('.vp-list');
    const countEl = back.querySelector('.vp-count');
    const perSel = back.querySelector('.vp-period');
    for (const o of $('periodSel').options) {
      const c = document.createElement('option');
      c.value = o.value; c.textContent = o.textContent;
      perSel.appendChild(c);
    }
    perSel.value = $('periodSel').value;

    const choix = new Set();
    let filtre = 'all';

    const dejaLa = (addr) => (dest.kind === 'table'
      ? inTable(dest.table, addr)
      : dest.chart.series.some((s) => s.addr === addr));

    const majCompte = () => {
      countEl.textContent = choix.size
        ? choix.size + ' variable' + (choix.size > 1 ? 's' : '') + ' cochée' + (choix.size > 1 ? 's' : '')
        : 'Aucune variable cochée';
      back.querySelector('.vp-ok').disabled = choix.size === 0;
    };

    const dessiner = () => {
      const filtres = back.querySelector('.vp-filters');
      filtres.innerHTML = '';
      for (const [key, label] of FAM_FILTERS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fbtn' + (filtre === key ? ' on' : '');
        b.textContent = label;
        b.title = FILTER_TITLES[key];
        b.addEventListener('click', () => { filtre = key; dessiner(); });
        filtres.appendChild(b);
      }

      const texte = q.value.trim().toLowerCase();
      const garde = (e) => {
        if (filtre !== 'all' && !(filtre === 'PLC'
          ? ['I', 'Q', 'M', 'S'].includes(e.family) : e.family === filtre)) return false;
        if (!texte) return true;
        return e.addr.toLowerCase().includes(texte) ||
               (e.label || '').toLowerCase().includes(texte);
      };
      const pool = suggestPool().filter(garde);

      list.innerHTML = '';
      // Adresse valide absente du catalogue : proposée telle quelle, comme
      // dans la barre de recherche — le catalogue n'est pas exhaustif.
      if (texte) {
        const p = DW.parseAddr(q.value.trim());
        if (p.ok && !pool.some((e) => e.addr.toUpperCase() === p.addr.toUpperCase())) {
          pool.unshift({ addr: p.addr, family: p.family,
                         label: DW.FAMILIES[p.family].label + ' — hors catalogue', unit: '' });
        }
      }
      if (!pool.length) {
        const vide = document.createElement('p');
        vide.className = 'm-note';
        vide.textContent = 'Aucune variable ne correspond.';
        list.appendChild(vide);
      }
      for (const e of pool.slice(0, 400)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'vp-row' + (choix.has(e.addr) ? ' on' : '') + (dejaLa(e.addr) ? ' dup' : '');
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', choix.has(e.addr) ? 'true' : 'false');
        b.innerHTML =
          '<span class="vp-check" aria-hidden="true"></span>' +
          '<span class="badge fam-' + e.family + '">' +
            DW.escapeHtml(DW.famBadge(e)) + '</span>' +
          '<span class="vp-addr"></span><span class="vp-label"></span>' +
          '<span class="vp-unit"></span>';
        b.querySelector('.vp-addr').textContent = e.addr;
        b.querySelector('.vp-label').textContent =
          (e.label || '') + (dejaLa(e.addr) ? ' · déjà présente' : '');
        b.querySelector('.vp-unit').textContent = e.unit || '';
        b.querySelector('.badge').title = famTitle(e.family, e);
        b.title = e.addr + ' — ' + (e.label || '') + (e.unit ? ' (' + e.unit + ')' : '') +
          ' · cocher pour l’ajouter à « ' + nom + ' »';
        b.addEventListener('click', () => {
          if (choix.has(e.addr)) choix.delete(e.addr); else choix.add(e.addr);
          b.classList.toggle('on', choix.has(e.addr));
          b.setAttribute('aria-selected', choix.has(e.addr) ? 'true' : 'false');
          majCompte();
        });
        list.appendChild(b);
      }
      majCompte();
    };

    const ajouter = () => {
      const periodMs = parseInt(perSel.value, 10) || CFG.defaultPeriodMs;
      let ok = 0;
      const refus = [];
      for (const addr of choix) {
        const net = DW.protocols ? DW.protocols.periodOf(addr) : null;
        const r = dest.kind === 'table'
          ? addToTable(dest.table, addr, net || periodMs)
          : dest.chart.addSeries(addr, { periodMs: net || periodMs });
        if (r && r.ok) ok++; else refus.push(addr + ' : ' + ((r && r.error) || 'refusée'));
      }
      root.innerHTML = '';
      onChange();
      refreshTargets();
      if (ok) toast(ok + ' variable' + (ok > 1 ? 's' : '') + ' → ' + nom);
      // Un refus n'est jamais silencieux : une variable qu'on croit ajoutée et
      // qui manque se cherche longtemps.
      if (refus.length) toast(refus.join(' · '), 'err');
    };

    q.addEventListener('input', dessiner);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') ajouter(); });
    back.querySelector('.vp-ok').addEventListener('click', ajouter);
    back.querySelector('.vp-cancel').addEventListener('click', () => { root.innerHTML = ''; });
    back.querySelector('.m-close').addEventListener('click', () => { root.innerHTML = ''; });
    back.addEventListener('pointerdown', (e) => { if (e.target === back) root.innerHTML = ''; });
    root.appendChild(back);
    dessiner();
    q.focus();
  }
  DW.openVarPicker = openVarPicker;

  function showTextModal(title, text) {
    const root = $('modalRoot');
    root.innerHTML = '';
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal"><header class="m-head"><h3></h3>' +
      '<button class="iconbtn m-close" type="button" title="Fermer cette fenêtre">✕</button></header>' +
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
    // Créer une tuile se fait DANS la liste des destinations : « → Nouveau
    // tableau » et « → Nouveau graphique » la créent aussitôt et la visent.
    // Deux boutons de plus dans une barre pour la même chose n'apportaient
    // rien, et éloignaient l'action de l'endroit où l'on choisit sa cible.
    $('targetSel').addEventListener('change', () => {
      const v = $('targetSel').value;
      if (v === 'newtable') {
        const tbl = createTable(state.active, {});
        setCible(tbl);
        onChange();
        toast('Tableau « ' + tbl.name + ' » créé — il est la destination d’ajout.');
        return;
      }
      if (v === 'new') {
        const c = createChart();
        if (c) { setCible(c); toast('« ' + c.title + ' » créé — c’est la destination d’ajout.'); }
        return;
      }
      majCible();
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

    $('helpBtn').addEventListener('click', () => {
      const root = $('modalRoot');
      root.innerHTML = '';
      const back = document.createElement('div');
      back.className = 'modal-back';
      const S = (t) => '<h4 class="help-h">' + t + '</h4>';
      const L = (rows) => '<dl class="help-list">' +
        rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('') + '</dl>';
      back.innerHTML =
        '<div class="modal" role="dialog" aria-label="Aide">' +
          '<header class="m-head"><h3>Commandes et gestes</h3>' +
          '<button class="iconbtn m-close" type="button" title="Fermer cette fenêtre">✕</button></header>' +
          '<p class="m-note">Chaque élément de l’interface porte aussi une infobulle ' +
          '(survol à la souris).</p>' +
          S('Ajouter des variables') +
          L([
            ['Bouton ＋', 'Sur chaque tuile : ouvre le catalogue complet dans une grande fenêtre — filtres par famille, recherche, et <b>sélection multiple</b>. La destination est celle du bouton, il n’y a rien à choisir.'],
            ['Barre de recherche', 'Le chemin rapide, au clavier. Adresse : <b>I1.2.3.4</b>, <b>Q14.15</b>, <b>M1.14</b>, <b>S0.4</b> (bits), <b>MB414</b> (mot de bus), <b>Modele.signal</b> (C API). Les suggestions se filtrent à la frappe ; les boutons Toutes / PLC / Modbus / Matlab / Réseau restreignent la liste.'],
            ['Étiquettes', 'Elles disent d’où vient la valeur : <b>PLC</b> (entrées, sorties, bits mémoire, système), <b>MB</b> (registre de bus par le canal interne), <b>Matlab</b> (signal de modèle, C API), <b>ext.…</b> (point lu à l’extérieur par le serveur de diagnostic : ext.MB, ext.61850, ext.OPCUA, ext.SNMP…). MB et ext.MB, ce n’est pas le même chemin ni la même latence.'],
            ['Destination', 'La liste des destinations porte chaque tableau et chaque graphique de l’onglet, plus <b>→ Nouveau tableau</b> et <b>→ Nouveau graphique</b> : les choisir crée la tuile aussitôt et la vise. <b>Un clic sur une tuile</b> (hors ses boutons) la désigne aussi : elle prend un liseré et devient la destination, sans dérouler la liste.'],
            ['Période', 'Rafraîchissement propre à la variable, 10 ms par défaut.'],
            ['Forcer une valeur', 'Suffixe <b>= valeur</b> dans la barre : <b>Q0.3 = 1</b>, <b>MB400 = 12500</b> impose la valeur côté serveur (diagnostic). La ligne du tableau est surlignée ; ⏻ relâche. Les points réseau (@lien.point) restent en lecture seule.'],
          ]) +
          S('Graphiques — gestes sur le tracé') +
          L([
            ['Glisser ↔', 'Remonter dans l’historique (330 s). Bouton <b>▶ Direct</b> pour revenir au temps réel.'],
            ['Glisser ↕', 'Déplacer l’échelle principale (elle passe en manuel 🔒).'],
            ['Pincer / molette', 'Zoom temporel, de 2 s à 5 min.'],
            ['Appui bref', 'Poser un curseur de mesure ; nouvel appui dessus pour l’enlever.'],
            ['Double-appui', 'Retour au temps réel.'],
          ]) +
          S('Graphiques — sur une règle d’axe') +
          L([
            ['Glisser', 'Déplacer cette échelle (manuel 🔒).'],
            ['Molette', 'Zoomer cette échelle.'],
            ['Double-appui', 'Remettre cette échelle en automatique.'],
          ]) +
          S('Organiser') +
          L([
            ['Poignée ⠿ — déplacer', 'Glisser une tuile <b>où l’on veut dans la page</b> : un rectangle montre l’emplacement où elle se posera, et les tuiles gênées s’écartent vers le bas. La même poignée l’emmène sur un <b>onglet</b> ou dans une <b>autre fenêtre</b> du navigateur.'],
            ['Ligne du tableau', 'Se glisse <b>dans le tableau</b> pour changer son rang (un repère montre où elle se posera), ou vers un autre onglet ou une autre fenêtre.'],
            ['Mosaïque', 'L’espace de travail est une mosaïque de <b>douze colonnes</b> : chaque tuile — tableau ou graphique — occupe le rectangle qu’on lui donne, à l’endroit qu’on lui donne. Un graphique à gauche, un tableau à droite, un autre graphique dessous : tout est permis. Les tuiles <b>remontent</b> d’elles-mêmes quand la place se libère au-dessus, donc pas de trou involontaire. La disposition est en colonnes et en rangées, pas en pixels : elle se retrouve identique sur un autre écran.'],
            ['Plusieurs tableaux', '<b>→ Nouveau tableau</b> dans la liste des destinations en crée un de plus. Un tableau est une tuile comme un graphique : même placement, même poignée. Chacun a son nom (cliquez-le), son bouton ＋ et son menu ⋮.'],
            ['Poignée ◢ — redimensionner', 'Coin bas-droit : ↔ largeur et ↕ hauteur, librement, par cellules de la mosaïque. Le contenu suit la tuile (le tableau défile à l’intérieur, le graphique s’étire). Réduire une tuile en largeur laisse la place à une autre <b>à côté</b>. Double-clic : retour à la taille de départ.'],
            ['Renommer', 'Bouton ✎ sur une ligne du tableau, ou « Renommer la courbe… » dans le menu d’une pastille : un nom d’affichage remplace le libellé du catalogue (vide = valeur d’origine). Le nom appartient à la <b>variable</b> : il s’applique partout où elle figure — tous les tableaux, toutes les courbes, tous les onglets, et les autres fenêtres ouvertes.'],
            ['Menu ⋮ d’un graphique', 'Dupliquer, échelles automatiques, taille de départ, plein écran, déplacer vers un onglet, ouvrir dans une nouvelle fenêtre.'],
            ['Menu ⋮ d’un tableau', 'Les mêmes gestes : ajouter des variables, vider, taille de départ, <b>dupliquer ce tableau</b>, <b>déplacer vers un onglet</b>, <b>ouvrir dans une nouvelle fenêtre</b>, fermer.'],
            ['Onglets', '＋ crée un espace de travail ; un appui sur l’onglet actif le renomme. Chaque fenêtre du navigateur a ses propres onglets.'],
            ['Barre du haut', 'Elle ne porte que ce qui sert à chaque instant : les onglets, la saisie d’une variable avec sa destination, et <b>⏸ Figer</b>, qui arrête d’un coup tous les graphiques de l’onglet actif. Elle <b>s’escamote quand on descend</b> dans la page et revient dès qu’on remonte : la place gagnée va aux courbes. <b>Journal de données</b> et <b>Configurations</b> sont dans le menu ☰, avec les autres fonctions qui ne dépendent pas de ce qui est affiché.'],
          ]) +
          S('Pages réseau (☰)') +
          L([
            ['Audit des communications', 'Tout ce que le processus échange avec l’extérieur : les sockets <b>réellement ouvertes</b> (lues dans le noyau), les liens déclarés, les interfaces. Le rapport se copie en texte pour un compte rendu d’audit.'],
            ['Capture d’interfaces', 'tcpdump sur le contrôleur, format pcap relisible dans Wireshark, interfaces Ethernet et CAN. Quota de disque (100 Mo par défaut), durée maximale, et <b>déclenchement par une variable</b> de diagnostic pour attraper un incident rare. Le quota et le déclencheur sont <b>persistants</b> : ils survivent au redémarrage du contrôleur — c’est parfois la coupure elle-même qu’on cherche à comprendre.'],
            ['Voisinage LLDP', 'Ce qu’annoncent les équipements voisins sur chaque interface : produit, port, adresse d’administration, VLAN. Écoute passive — Diagweb n’émet rien. Un voisin muet disparaît après le délai d’oubli (dix minutes par défaut).'],
            ['Sans serveur', 'Les trois pages fonctionnent aussi hors contrôleur, sur un <b>contrôleur fictif</b> : l’interface se découvre et se règle sans matériel. Un bandeau le dit sur chaque page, et une capture simulée n’offre aucun fichier — il n’y a pas de trames derrière.'],
          ]) +
          S('Apparence (☰ → Apparence)') +
          L([
            ['Logo', 'Une image de l’installation remplace le logo Diagweb dans la barre du haut, et sert d’icône d’onglet. PNG, JPEG, SVG ou WebP : elle est réduite et <b>incorporée</b> à la configuration — aucune ressource extérieure n’est appelée, la page reste servable hors ligne.'],
            ['Couleurs', 'Six réglages : accent, fond, cartes, fond secondaire, texte, traits. L’aperçu est immédiat. Les gris et les nuances d’accent en sont déduits. <b>Chaque thème garde les siennes</b> : basculez le thème pour régler l’autre.'],
            ['Portée', 'Page servie par le contrôleur : l’apparence est enregistrée sur lui et <b>tous les postes</b> la voient. Page ouverte hors serveur : elle reste dans ce navigateur.'],
          ]) +
          S('Liens réseau (☰ → Liens réseau)') +
          L([
            ['Lien', 'Une connexion vers un équipement ou un réseau : Modbus TCP/RTU, IEC 60870-5-104, IEC 61850, CAN, J1939, CANopen, SNMP, OPC UA. Le serveur de diagnostic ouvre le lien et lit les points.'],
            ['Point', 'Une variable lue sur un lien (registre, IOA, SPN, objet…), avec son unité et sa période. Elle s’adresse ensuite <b>@lien.point</b> comme n’importe quelle variable.'],
            ['Horodatage', 'Réglable <b>point par point</b> : la date attachée par l’équipement quand le protocole en transporte une (IEC-104 horodaté, IEC 61850, OPC UA en abonnement, SNMP par un OID d’horodatage de la MIB), ou celle du serveur, forcée, quand l’horloge de l’équipement n’est pas de confiance.'],
            ['Sans serveur', 'La configuration reste dans le navigateur et les valeurs des points sont simulées — l’interface est démontrable sans matériel.'],
          ]) +
          S('Courbes') +
          L([
            ['Pastille de légende', 'Couleur (palette ou teinte libre), masquer, échelle dédiée, décalage vertical, retrait.'],
            ['Badge Én', 'Numéro de l’échelle utilisée ; 🔒 signale un réglage manuel.'],
            ['Échelles verticales', 'Toutes les règles sont <b>à gauche</b>, empilées dans l’ordre des badges Én : on lit une valeur sans chercher de quel bord vient son échelle. Clic sur une <b>règle d’axe</b> (les graduations, curseur ↕) : saisir le minimum et le maximum exacts, pour cette échelle seule ou pour <b>toutes</b> celles du graphique. Glisser ou molette sur la règle : réglage à la volée ; double-clic : retour à l’automatique. Même réglage depuis le menu d’une pastille (« Bornes de l’échelle… »).'],
          ]) +
        '</div>';
      back.querySelector('.m-close').addEventListener('click', () => { root.innerHTML = ''; });
      back.addEventListener('pointerdown', (e) => { if (e.target === back) root.innerHTML = ''; });
      root.appendChild(back);
    });

    $('netBtn').addEventListener('click', () => DW.protocolsUI.open());

    $('aboutBtn').addEventListener('click', () => {
      const root = $('modalRoot');
      root.innerHTML = '';
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML =
        '<div class="modal" role="dialog" aria-label="À propos">' +
          '<header class="m-head"><h3>À propos de Diagweb</h3>' +
          '<button class="iconbtn m-close" type="button" title="Fermer cette fenêtre">✕</button></header>' +
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

    // Barre du haut escamotable au défilement : sur un écran de supervision,
    // la place gagnée va aux courbes. Elle revient dès qu'on remonte — le
    // geste qu'on fait déjà pour chercher un réglage — et dès que la page est
    // en haut, pour ne jamais rester introuvable. Un seuil de 8 px évite
    // qu'un tremblement de molette la fasse clignoter.
    let dernierY = 0;
    let barreArmee = false;
    const SEUIL = 8;
    const suivreDefilement = () => {
      barreArmee = false;
      const y = Math.max(0, window.scrollY || window.pageYOffset || 0);
      const haut = $('panes').getBoundingClientRect().height > window.innerHeight;
      if (!haut) { document.body.classList.remove('topbar-off'); dernierY = y; return; }
      const d = y - dernierY;
      if (Math.abs(d) < SEUIL) return;
      // Un menu ou une fenêtre ouverte garde la barre : la masquer sous le
      // doigt de l'utilisateur serait une disparition inexpliquée.
      const occupe = !$('menuPanel').classList.contains('hide') ||
                     $('modalRoot').children.length > 0;
      document.body.classList.toggle('topbar-off', d > 0 && y > 60 && !occupe);
      dernierY = y;
    };
    window.addEventListener('scroll', () => {
      if (barreArmee) return;
      barreArmee = true;
      requestAnimationFrame(suivreDefilement);
    }, { passive: true });

    $('themeBtn').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark'
        : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', next);
      // Les couleurs personnalisées sont propres à chaque thème : l'apparence
      // se réapplique avant que les graphiques ne relisent l'encre.
      document.dispatchEvent(new CustomEvent('dw:theme'));
      DW.invalidateChartTheme();
      for (const tab of state.tabs) for (const c of tab.charts) c.rebuildLegend();
    });

    // (le menu ☰ se referme déjà sur le clic de n'importe lequel de ses boutons)
    $('skinBtn').addEventListener('click', openAppearance);
    // Pages réseau (audit, capture, voisinage) : elles interrogent le serveur
    // de diagnostic et vivent dans web/js/network.js.
    $('auditBtn').addEventListener('click', () => DW.network.pageAudit());
    $('captureBtn').addEventListener('click', () => DW.network.pageCapture());
    $('lldpBtn').addEventListener('click', () => DW.network.pageLldp());
    // Couleurs changées (ici ou dans une autre fenêtre) : les légendes et les
    // tracés relisent la palette.
    document.addEventListener('dw:appearance', () => {
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
  // API minimale offerte aux modules d'interface (fenêtre des liens réseau).
  DW.app = {
    addVariable: (addr, periodMs) => addVariable(addr, periodMs),
    toast,
    refreshTargets,
    showText: showTextModal,
  };

  function boot() {
    bindUi();

    // Déplacement de widgets entre onglets et entre fenêtres
    DW.dnd.attach({
      receive: receiveWidget,
      activeTab: () => state.active,
      tabFromElement: (el) => el._tab || state.active,
      isSameTarget: (tab, payload) => tab === state.active && payload.kind !== 'chart',
      applyRename: (addr, name) => renameVariable(addr, name, true),
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
    reconcileServerLogging();
    requestAnimationFrame(loop);
  }

  /**
   * Aligne l'état des onglets « journal serveur » sur la réalité du serveur :
   * une campagne lancée avant la fermeture de la page tourne encore, la pastille
   * d'enregistrement doit donc être exacte au rechargement.
   */
  function reconcileServerLogging() {
    if (!serverLogAvailable()) {
      for (const tab of state.tabs) if (tab.log.dest === 'server') tab.log.enabled = false;
      rebuildTabbar();
      updateLogUi();
      return;
    }
    fetchServerLogStatus().then((list) => {
      const active = new Set(list.map((x) => x.name));
      let changed = false;
      for (const tab of state.tabs) {
        if (tab.log.dest !== 'server') continue;
        const on = active.has(serverCampaignName(tab.name));
        if (on !== tab.log.enabled) { tab.log.enabled = on; changed = true; }
      }
      if (changed) { rebuildTabbar(); updateLogUi(); }
    });
  }

  // La source (simulation ou serveur de diagnostic) doit être choisie avant
  // de construire l'espace de travail : les premiers abonnements en dépendent.
  function start() {
    // La source (simulation ou serveur) et la configuration des liens réseau
    // doivent être connues avant les premiers abonnements.
    // L'apparence s'applique tout de suite depuis le stockage local, puis se
    // met à jour depuis le contrôleur : la page ne change pas de couleur sous
    // les yeux de l'opérateur au bout d'une seconde.
    if (DW.appearance) DW.appearance.charger();
    const ready = Promise.all([
      (DW.sourceReady || Promise.resolve()).catch(() => {}),
      (DW.protocolsReady || Promise.resolve()).catch(() => {}),
    ]);
    ready.then(boot);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
