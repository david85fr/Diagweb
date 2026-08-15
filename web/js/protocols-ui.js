/* Diagweb — fenêtre « Liens réseau » : saisie de la configuration des
 * protocoles (Modbus, IEC 61850, IEC 60870-5-104, CAN, J1939, CANopen, SNMP,
 * OPC UA)
 * et des
 * points à lire, puis ajout de ces points au diagnostic.
 *
 * Fonction globale (indépendante des onglets) : elle vit dans le menu ☰.
 * Les descriptions de protocoles viennent de protocols.js ; cette fenêtre ne
 * connaît que des champs génériques (texte, entier, flottant, booléen, liste,
 * hexadécimal), ce qui permet d'ajouter un protocole sans toucher à l'UI.
 */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});
  const P = DW.protocols;

  const esc = (s) => DW.escapeHtml(String(s == null ? '' : s));
  const STATE_LABEL = {
    up:   ['●', 'connecté', 'Lien établi : les points remontent des valeurs.'],
    down: ['⚠', 'en défaut', 'Équipement injoignable ou protocole en erreur — voir le détail.'],
    off:  ['○', 'désactivé', 'Lien désactivé : aucun échange réseau.'],
    sim:  ['~', 'simulé', 'Aucun serveur de diagnostic : les valeurs affichées sont simulées.'],
    todo: ['⋯', 'non branché', 'Protocole configurable, lecture pas encore implémentée (voir docs/PROTOCOLES.md).'],
  };

  let root = null, view = null, editing = null, noteEl = null;

  // ---------------------------------------------------------------- champs
  function fieldRow(f, params, onInput) {
    const wrap = document.createElement('div');
    wrap.className = 'pf-row';
    const id = 'pf_' + f.key;
    const lab = document.createElement('label');
    lab.className = 'pf-label';
    lab.setAttribute('for', id);
    lab.textContent = f.label + (f.required ? ' *' : '');
    lab.title = f.help;
    wrap.appendChild(lab);

    let input;
    if (f.type === 'enum') {
      input = document.createElement('select');
      for (const [v, txt] of f.choices) {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = txt;
        input.appendChild(o);
      }
      input.value = String(params[f.key] == null ? f.def : params[f.key]);
    } else if (f.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = params[f.key] === true || params[f.key] === 'true';
    } else {
      input = document.createElement('input');
      input.type = (f.type === 'int' || f.type === 'float') ? 'number' : 'text';
      if (f.type === 'float') input.step = 'any';
      if (f.type === 'hex') input.placeholder = '0x…';
      input.value = params[f.key] == null ? String(f.def) : String(params[f.key]);
      input.autocomplete = 'off';
      input.spellcheck = false;
    }
    input.id = id;
    input.className = 'pf-input' + (f.type === 'bool' ? ' pf-check' : '');
    input.title = f.help;
    input.addEventListener('input', () => {
      params[f.key] = f.type === 'bool' ? input.checked
        : (f.type === 'int' || f.type === 'float') ? numVal(input.value, f)
        : input.value;
      if (onInput) onInput();
    });
    if (f.type === 'enum' || f.type === 'bool') {
      input.addEventListener('change', () => {
        params[f.key] = f.type === 'bool' ? input.checked : input.value;
        if (onInput) onInput();
      });
    }
    wrap.appendChild(input);
    return wrap;
  }

  function numVal(raw, f) {
    const v = f.type === 'int' ? parseInt(raw, 10) : parseFloat(raw);
    return isFinite(v) ? v : (raw === '' || raw === '-' ? raw : f.def);
  }

  /**
   * Formulaire d'une liste de champs, redessiné quand une dépendance change.
   * `hors` est le contexte englobant (les paramètres du lien, quand on édite
   * un point) : certains champs d'un point ne valent que pour un mécanisme
   * choisi au niveau du lien.
   */
  function fieldsForm(fields, params, hors) {
    const box = document.createElement('div');
    box.className = 'pf-form';
    const draw = () => {
      box.innerHTML = '';
      for (const f of fields) {
        if (!P.fieldApplies(f, params, hors)) continue;
        box.appendChild(fieldRow(f, params, () => {
          // Un champ « when » a pu changer : on redessine le formulaire.
          if (fields.some((g) => g.when && Object.keys(g.when).includes(f.key))) draw();
        }));
      }
    };
    draw();
    return box;
  }

  // ----------------------------------------------------------------- vues
  function open() {
    close();
    root = document.getElementById('modalRoot');
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      '<div class="modal wide" role="dialog" aria-label="Liens réseau">' +
        '<header class="m-head"><h3 id="pxTitle">Liens réseau</h3>' +
        '<button class="iconbtn m-close" type="button" title="Fermer cette fenêtre">✕</button></header>' +
        '<div id="pxBody"></div>' +
        '<p class="m-note" id="pxNote"></p>' +
      '</div>';
    root.innerHTML = '';
    root.appendChild(back);
    back.querySelector('.m-close').addEventListener('click', close);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    noteEl = back.querySelector('#pxNote');
    view = 'links';
    render();
    if (P.mode === 'server') P.refreshStatus().then(() => { if (view === 'links') render(); });
  }

  function close() {
    const r = document.getElementById('modalRoot');
    if (r) r.innerHTML = '';
    root = null; view = null; editing = null;
  }

  function body() { return document.getElementById('pxBody'); }
  function setTitle(t) { document.getElementById('pxTitle').textContent = t; }
  function note(t) { if (noteEl) noteEl.textContent = t; }

  function render() {
    if (!root) return;
    const b = body();
    b.innerHTML = '';
    if (view === 'links') renderLinks(b);
    else if (view === 'link') renderLink(b);
    else if (view === 'points') renderPoints(b);
    else if (view === 'point') renderPoint(b);
  }

  // ---- liste des liens ---------------------------------------------
  function renderLinks(b) {
    setTitle('Liens réseau');
    note(P.mode === 'server'
      ? 'Configuration détenue par le contrôleur : le serveur de diagnostic ouvre lui-même les liens et lit les points.'
      : 'Aucun serveur de diagnostic joignable : la configuration est mémorisée dans ce navigateur et les valeurs des points sont simulées.');

    const bar = document.createElement('div');
    bar.className = 'm-actions';
    bar.appendChild(btn('+ Nouveau lien', 'primary',
      'Déclarer une connexion vers un équipement ou un réseau (Modbus, IEC 61850, IEC 60870-5-104, CAN, J1939, CANopen, SNMP, OPC UA)',
      () => { editing = newLink(); view = 'link'; render(); }));
    bar.appendChild(btn('Exporter', '',
      'Télécharger toute la configuration des liens réseau au format JSON',
      () => DW.store.download('liens-reseau', JSON.stringify(P.config, null, 2), 'json', 'application/json')));
    bar.appendChild(btn('Importer', '',
      'Charger une configuration de liens réseau depuis un fichier JSON',
      importConfig));
    b.appendChild(bar);

    const list = document.createElement('div');
    list.className = 'px-list';
    const links = P.links();
    if (!links.length) {
      const none = document.createElement('p');
      none.className = 'm-note';
      none.textContent = 'Aucun lien déclaré. « + Nouveau lien » ajoute une connexion ; ' +
        'ses points deviennent ensuite des variables ordinaires du diagnostic (@lien.point).';
      list.appendChild(none);
    }
    for (const link of links) {
      const proto = P.descriptor(link.protocol);
      const st = link.enabled === false ? { key: 'off' } :
                 (proto && proto.state === 'declared' && P.mode === 'server') ? { key: 'todo' } :
                 P.linkState(link.id);
      const [icon, label, help] = STATE_LABEL[st.key] || STATE_LABEL.off;
      const row = document.createElement('div');
      row.className = 'px-row';
      row.innerHTML =
        '<div class="px-head">' +
          '<span class="badge fam-NET" title="Protocole du lien">' + esc(proto ? proto.label : link.protocol) + '</span>' +
          '<b class="px-name"></b>' +
          '<span class="px-state st-' + st.key + '"></span>' +
        '</div>' +
        '<div class="px-sub"></div>';
      row.querySelector('.px-name').textContent = link.label || link.id;
      row.querySelector('.px-name').title = 'Nom du lien — les points s’adressent par @' + link.id + '.<point>';
      const stEl = row.querySelector('.px-state');
      stEl.textContent = icon + ' ' + label;
      stEl.title = (st.detail || help);
      row.querySelector('.px-sub').textContent =
        target(link) + ' · ' + (link.points || []).length + ' point(s)';
      row.querySelector('.px-sub').title = 'Cible du lien et nombre de points configurés';

      const acts = document.createElement('div');
      acts.className = 'm-actions px-acts';
      acts.appendChild(btn('Points', '', 'Voir, ajouter ou modifier les variables lues sur ce lien',
        () => { editing = link; view = 'points'; render(); }));
      acts.appendChild(btn('Modifier', '', 'Modifier le protocole et les paramètres de connexion de ce lien',
        () => { editing = link; view = 'link'; render(); }));
      acts.appendChild(btn('Tester', '', 'Demander au serveur de diagnostic d’ouvrir ce lien et de signaler le résultat',
        async (ev) => {
          const el = ev.currentTarget;
          el.disabled = true;
          try {
            const r = await P.test(link.id);
            DW.app.toast((r.ok ? '✓ ' : '✗ ') + (link.label || link.id) + ' : ' + r.detail, r.ok ? '' : 'err');
            if (P.mode === 'server') { await P.refreshStatus(); render(); }
          } finally { el.disabled = false; }
        }));
      acts.appendChild(btn(link.enabled === false ? 'Activer' : 'Désactiver', '',
        'Suspendre ou reprendre les échanges réseau de ce lien, sans perdre sa configuration',
        async () => { link.enabled = link.enabled === false; await persist(); render(); }));
      acts.appendChild(btn('Supprimer', 'danger', 'Supprimer ce lien et tous ses points',
        async () => {
          if (!window.confirm('Supprimer le lien « ' + (link.label || link.id) + ' » et ses ' +
              (link.points || []).length + ' point(s) ?')) return;
          P.config.links = P.links().filter((l) => l !== link);
          await persist();
          render();
        }));
      row.appendChild(acts);
      list.appendChild(row);
    }
    b.appendChild(list);
  }

  function target(link) {
    const p = link.params || {};
    if (p.host) return p.host + ':' + (p.port || '');
    if (p.device) return p.device + ' · ' + (p.baud || '') + ' bauds';
    if (p.iface) return 'interface ' + p.iface + (p.nodeId ? ' · nœud ' + p.nodeId : '');
    return '—';
  }

  // ---- édition d'un lien -------------------------------------------
  /** Le lien porte-t-il encore, à l'identique, le pré-remplissage du banc ? */
  function presetIntact(link) {
    const pre = P.localPreset(link.protocol);
    if (!pre) return null;
    const params = link.params || {};
    for (const k in pre.params) {
      if (String(params[k]) !== String(pre.params[k])) return null;
    }
    return pre;
  }

  function newLink() {
    const proto = DW.PROTOCOLS[0];
    let n = 1;
    while (P.link('lien' + n)) n++;
    return {
      id: 'lien' + n, label: 'Lien ' + n, protocol: proto.id, enabled: true,
      params: P.linkDefaults(proto), points: [], _new: true,
    };
  }

  function renderLink(b) {
    const link = editing;
    const proto = P.descriptor(link.protocol);
    setTitle(link._new ? 'Nouveau lien réseau' : 'Lien « ' + (link.label || link.id) + ' »');
    note(proto.help + (proto.state === 'declared'
      ? ' — pilote déclaré : la configuration est acceptée et conservée, la lecture viendra avec la pile protocolaire.'
      : ''));

    b.appendChild(textRow('Identifiant', link.id,
      'Identifiant court du lien, utilisé dans les adresses : @' + link.id + '.<point>. ' +
      'Lettres, chiffres, tiret et souligné, 24 caractères maximum.',
      (v) => { link.id = v; }));
    b.appendChild(textRow('Nom', link.label,
      'Nom lisible affiché dans la liste des liens et dans les libellés de points.',
      (v) => { link.label = v; }));

    const protoRow = document.createElement('div');
    protoRow.className = 'pf-row';
    const pl = document.createElement('label');
    pl.className = 'pf-label';
    pl.textContent = 'Protocole';
    pl.setAttribute('for', 'pxProto');
    pl.title = 'Protocole utilisé par le serveur de diagnostic pour lire les points de ce lien';
    const sel = document.createElement('select');
    sel.id = 'pxProto';
    sel.className = 'pf-input';
    sel.title = pl.title;
    for (const p of DW.PROTOCOLS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label + ' — ' + p.transport + (p.state === 'declared' ? ' (non branché)' : '');
      sel.appendChild(o);
    }
    sel.value = link.protocol;
    sel.addEventListener('change', () => {
      link.protocol = sel.value;
      const np = P.descriptor(link.protocol);
      link.params = P.linkDefaults(np);
      for (const pt of link.points || []) pt.params = P.defaults(np.pointFields);
      render();
    });
    protoRow.appendChild(pl);
    protoRow.appendChild(sel);
    b.appendChild(protoRow);

    const form = fieldsForm(proto.linkFields, link.params);
    b.appendChild(form);

    // Pré-remplissage : le dire, et seulement tant que c'est vrai. La mention
    // s'efface dès qu'un champ s'écarte du banc — sans quoi elle finirait par
    // désigner une adresse qui n'est plus la sienne, ce qui est pire que de
    // n'avoir rien dit.
    const preNote = document.createElement('p');
    preNote.className = 'm-note';
    preNote.title = 'Poste de développement (Codespace ou machine locale) : les champs de ' +
                    'connexion d’un lien neuf partent avec les coordonnées des serveurs de ' +
                    'test qui tournent ici. Sur un contrôleur en exploitation, rien n’est ' +
                    'pré-rempli.';
    const majPreNote = () => {
      const pre = presetIntact(link);
      preNote.textContent = pre
        ? 'Pré-rempli pour le ' + pre.via + ' de cette machine — à remplacer par ' +
          'l’adresse de l’équipement réel.'
        : '';
      preNote.hidden = !pre;
    };
    majPreNote();
    form.addEventListener('input', majPreNote);
    form.addEventListener('change', majPreNote);
    b.appendChild(preNote);

    const acts = document.createElement('div');
    acts.className = 'm-actions';
    acts.appendChild(btn('Enregistrer', 'primary', 'Valider ce lien et revenir à la liste', async () => {
      const err = validateLink(link);
      if (err) { DW.app.toast(err, 'err'); return; }
      if (link._new) { delete link._new; P.config.links.push(link); }
      await persist();
      view = 'links'; render();
    }));
    acts.appendChild(btn('Points…', '', 'Configurer les variables lues sur ce lien', () => {
      const err = validateLink(link);
      if (err) { DW.app.toast(err, 'err'); return; }
      if (link._new) { delete link._new; P.config.links.push(link); }
      persist().then(() => { view = 'points'; render(); });
    }));
    acts.appendChild(btn('Annuler', '', 'Revenir à la liste sans conserver les modifications', () => {
      P.load().then(() => { view = 'links'; render(); });
    }));
    b.appendChild(acts);
  }

  function validateLink(link) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(link.id)) {
      return 'Identifiant de lien invalide : une lettre puis lettres, chiffres, « - » ou « _ » (24 max).';
    }
    if (P.links().some((l) => l !== link && l.id === link.id)) {
      return 'Un autre lien porte déjà l’identifiant « ' + link.id +' ».';
    }
    const proto = P.descriptor(link.protocol);
    for (const f of proto.linkFields) {
      if (!f.required || !P.fieldApplies(f, link.params)) continue;
      const v = link.params[f.key];
      if (v === '' || v == null) return 'Champ obligatoire non renseigné : ' + f.label + '.';
    }
    return null;
  }

  // ---- points d'un lien ---------------------------------------------
  function renderPoints(b) {
    const link = editing;
    const proto = P.descriptor(link.protocol);
    setTitle('Points de « ' + (link.label || link.id) + ' »');
    note('Chaque point devient une variable du diagnostic, adressée @' + link.id + '.<point>, ' +
         'utilisable au tableau, en courbe et dans le journal.');

    const bar = document.createElement('div');
    bar.className = 'm-actions';
    bar.appendChild(btn('+ Nouveau point', 'primary', 'Déclarer une variable à lire sur ce lien',
      () => { editing = { link, point: newPoint(link, proto) }; view = 'point'; render(); }));
    bar.appendChild(btn('← Liens', '', 'Revenir à la liste des liens réseau',
      () => { editing = null; view = 'links'; render(); }));
    b.appendChild(bar);

    const list = document.createElement('div');
    list.className = 'px-list';
    if (!(link.points || []).length) {
      const none = document.createElement('p');
      none.className = 'm-note';
      none.textContent = 'Aucun point sur ce lien.';
      list.appendChild(none);
    }
    for (const pt of link.points || []) {
      const row = document.createElement('div');
      row.className = 'px-row';
      row.innerHTML =
        '<div class="px-head"><span class="badge fam-NET" title="Variable réseau">NET</span>' +
        '<b class="px-name mono"></b><span class="px-unit"></span></div>' +
        '<div class="px-sub"></div>';
      row.querySelector('.px-name').textContent = P.addrOf(link, pt);
      row.querySelector('.px-name').title = 'Adresse à saisir dans la barre de recherche';
      row.querySelector('.px-unit').textContent = pt.unit || '';
      row.querySelector('.px-unit').title = 'Unité affichée dans le tableau et sur les axes';
      const sub = row.querySelector('.px-sub');
      sub.textContent = (pt.label || pt.id) + ' · ' + P.pointSummary(link, pt) + ' · ' + pt.periodMs + ' ms';
      sub.title = 'Libellé, adressage protocole et période de lecture';

      const acts = document.createElement('div');
      acts.className = 'm-actions px-acts';
      acts.appendChild(btn('Ajouter au diagnostic', 'primary',
        'Ajouter cette variable à la destination choisie dans la barre du haut (tableau ou graphique)',
        () => {
          if (DW.app.addVariable(P.addrOf(link, pt), pt.periodMs)) close();
        }));
      acts.appendChild(btn('Modifier', '', 'Modifier l’adressage, l’unité ou la période de ce point',
        () => { editing = { link, point: pt }; view = 'point'; render(); }));
      acts.appendChild(btn('Dupliquer', '', 'Créer un point identique, à ajuster (registre suivant, autre bit…)',
        async () => {
          const copy = JSON.parse(JSON.stringify(pt));
          let n = 2;
          while ((link.points || []).some((q) => q.id === pt.id + '_' + n)) n++;
          copy.id = pt.id + '_' + n;
          link.points.push(copy);
          await persist();
          render();
        }));
      acts.appendChild(btn('Supprimer', 'danger', 'Supprimer ce point de la configuration',
        async () => {
          link.points = link.points.filter((q) => q !== pt);
          await persist();
          render();
        }));
      row.appendChild(acts);
      list.appendChild(row);
    }
    b.appendChild(list);
  }

  function newPoint(link, proto) {
    let n = 1;
    while ((link.points || []).some((p) => p.id === 'point' + n)) n++;
    return {
      id: 'point' + n, label: '', unit: '', periodMs: 200, kind: 'float',
      params: P.defaults(proto.pointFields), _new: true,
    };
  }

  function renderPoint(b) {
    const { link, point } = editing;
    const proto = P.descriptor(link.protocol);
    setTitle(point._new ? 'Nouveau point' : 'Point ' + P.addrOf(link, point));
    note('Adresse dans Diagweb : @' + link.id + '.' + point.id +
         ' — protocole ' + proto.label + '.');

    b.appendChild(textRow('Identifiant', point.id,
      'Identifiant court du point : il complète l’adresse @' + link.id + '.<identifiant>.',
      (v) => { point.id = v; }));
    b.appendChild(textRow('Libellé', point.label,
      'Description affichée dans le tableau, les suggestions et les légendes de courbes.',
      (v) => { point.label = v; }));
    b.appendChild(textRow('Unité', point.unit,
      'Unité physique après application du gain et du décalage (bar, °C, tr/min…). ' +
      'Les courbes de même unité partagent une échelle.',
      (v) => { point.unit = v; }));
    b.appendChild(fieldRow(
      { key: 'periodMs', label: 'Période de lecture (ms)', type: 'int', def: 200, required: true,
        help: 'Cadence à laquelle le serveur de diagnostic lit ce point (10 ms à 60 s). ' +
              'Une période courte sur un lien lent peut saturer l’équipement.' },
      point));
    b.appendChild(fieldRow(
      { key: 'kind', label: 'Type de variable', type: 'enum', def: 'float', required: false,
        help: 'Présentation dans le diagnostic : bit (LED 0/1), mot 16 bits (décimal + hexadécimal) ou grandeur flottante.',
        choices: [['bit', 'Bit (0/1)'], ['word', 'Mot 16 bits'], ['float', 'Grandeur flottante']] },
      point));

    const h = document.createElement('h4');
    h.className = 'help-h';
    h.textContent = 'Adressage ' + proto.label;
    h.title = 'Paramètres propres au protocole de ce lien';
    b.appendChild(h);
    b.appendChild(fieldsForm(proto.pointFields, point.params, link.params));

    const acts = document.createElement('div');
    acts.className = 'm-actions';
    acts.appendChild(btn('Enregistrer', 'primary', 'Valider ce point et revenir à la liste', async () => {
      const err = validatePoint(link, point, proto);
      if (err) { DW.app.toast(err, 'err'); return; }
      if (point._new) { delete point._new; link.points.push(point); }
      await persist();
      editing = link; view = 'points'; render();
    }));
    acts.appendChild(btn('Annuler', '', 'Revenir à la liste des points sans conserver les modifications',
      () => { P.load().then(() => { editing = P.link(link.id); view = 'points'; render(); }); }));
    b.appendChild(acts);
  }

  function validatePoint(link, point, proto) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(point.id)) {
      return 'Identifiant de point invalide : une lettre puis lettres, chiffres, « - » ou « _ » (24 max).';
    }
    if ((link.points || []).some((p) => p !== point && p.id === point.id)) {
      return 'Ce lien a déjà un point « ' + point.id + ' ».';
    }
    const per = parseInt(point.periodMs, 10);
    if (!isFinite(per) || per < 10 || per > 60000) {
      return 'Période de lecture attendue entre 10 ms et 60 000 ms.';
    }
    for (const f of proto.pointFields) {
      if (!f.required || !P.fieldApplies(f, point.params, link.params)) continue;
      const v = point.params[f.key];
      if (v === '' || v == null) return 'Champ obligatoire non renseigné : ' + f.label + '.';
    }
    return null;
  }

  // ------------------------------------------------------------- outils
  function textRow(label, value, help, set) {
    const wrap = document.createElement('div');
    wrap.className = 'pf-row';
    const id = 'px_' + label.replace(/[^a-z]/gi, '');
    const l = document.createElement('label');
    l.className = 'pf-label';
    l.textContent = label;
    l.setAttribute('for', id);
    l.title = help;
    const i = document.createElement('input');
    i.id = id;
    i.className = 'pf-input';
    i.type = 'text';
    i.value = value || '';
    i.title = help;
    i.autocomplete = 'off';
    i.spellcheck = false;
    i.addEventListener('input', () => set(i.value.trim()));
    wrap.appendChild(l);
    wrap.appendChild(i);
    return wrap;
  }

  function btn(text, cls, title, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  }

  async function persist() {
    try {
      await P.save();
    } catch (e) {
      DW.app.toast('Configuration non enregistrée : ' + e.message, 'err');
    }
  }

  function importConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const cfg = P.normalize(JSON.parse(await file.text()));
        P.config = cfg;
        await persist();
        render();
        DW.app.toast(cfg.links.length + ' lien(s) importé(s).');
      } catch (e) {
        DW.app.toast('Fichier de liens réseau illisible.', 'err');
      }
    });
    input.click();
  }

  DW.protocolsUI = { open, close };
})();
