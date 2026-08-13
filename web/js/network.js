/* Diagweb — trois pages réseau : audit, capture d'interfaces, voisinage LLDP.
 *
 * Elles s'ouvrent depuis le menu ☰ et s'affichent en pleine page par-dessus
 * l'espace de travail, qui continue de tourner derrière : ce sont des vues de
 * diagnostic du CONTRÔLEUR, pas des onglets de travail.
 *
 * Toutes trois sont servies par le serveur de diagnostic et n'existent donc
 * pas hors de lui : une page ouverte en fichier local (Artifact, copie hors
 * ligne) le dit franchement plutôt que d'afficher un tableau vide, qui se
 * lirait comme « rien à signaler ».
 */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  const $ = (id) => document.getElementById(id);
  const surServeur = () => DW.sourceMode === 'ws';

  /** Enveloppe commune : titre, bouton de fermeture, corps, rafraîchissement. */
  function ouvrirPage(titre, aide, construire, periodeMs) {
    const root = $('modalRoot');
    root.innerHTML = '';
    const back = document.createElement('div');
    back.className = 'modal-back page-back';
    back.innerHTML =
      '<div class="modal page" role="dialog" aria-label="' + DW.escapeHtml(titre) + '">' +
        '<header class="m-head"><h3></h3>' +
          '<button class="iconbtn m-close" type="button" title="Fermer cette page">✕</button>' +
        '</header>' +
        '<p class="m-note"></p>' +
        '<div class="page-body"></div>' +
      '</div>';
    back.querySelector('h3').textContent = titre;
    back.querySelector('.m-note').innerHTML = aide;
    const corps = back.querySelector('.page-body');
    let timer = null;
    const fermer = () => { if (timer) clearInterval(timer); root.innerHTML = ''; };
    back.querySelector('.m-close').addEventListener('click', fermer);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) fermer(); });
    root.appendChild(back);

    if (!surServeur()) {
      corps.innerHTML = '<p class="page-vide">Cette page interroge le serveur de ' +
        'diagnostic du contrôleur. La page est ouverte hors serveur : il n’y a ' +
        'rien à observer ici, et afficher un tableau vide laisserait croire le ' +
        'contraire.</p>';
      return;
    }
    const maj = () => construire(corps).catch((e) => {
      corps.innerHTML = '<p class="page-vide">Serveur injoignable : ' +
        DW.escapeHtml(e.message || String(e)) + '</p>';
    });
    maj();
    // Rafraîchissement tant que la page est ouverte ; l'intervalle meurt avec elle.
    if (periodeMs) timer = setInterval(() => { if (root.contains(back)) maj(); else fermer(); }, periodeMs);
    return { corps, maj, fermer };
  }

  async function api(chemin, options) {
    const r = await fetch(chemin, options);
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { /* réponse non JSON */ }
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  const octets = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' Mo'
                        : n >= 1024 ? (n / 1024).toFixed(1) + ' ko' : n + ' o');
  const duree = (s) => (s >= 3600 ? Math.round(s / 3600) + ' h'
                       : s >= 60 ? Math.round(s / 60) + ' min' : Math.round(s) + ' s');

  const tableau = (entetes, lignes, vide) => {
    if (!lignes.length) return '<p class="page-vide">' + vide + '</p>';
    return '<table class="net-tab"><thead><tr>' +
      entetes.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' +
      lignes.map((l) => '<tr>' + l.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
      '</tbody></table>';
  };

  // ------------------------------------------------------------------ audit
  /**
   * Audit des communications. Deux vues côte à côte : les sockets réellement
   * ouvertes par le processus (état du noyau, lu dans /proc) et les liens
   * déclarés dans la configuration. Un écart entre les deux est une
   * information — un lien en défaut n'a pas de socket ouverte.
   */
  function pageAudit() {
    ouvrirPage('Audit des communications',
      'Ce que le processus échange avec l’extérieur, à l’instant du relevé. ' +
      'La vue <b>observée</b> vient du noyau (sockets réellement ouvertes) ; la vue ' +
      '<b>déclarée</b> vient de la configuration des liens. Destiné à un audit de ' +
      'sécurité ou à un architecte réseau : le rapport se copie en un bouton.',
      async (corps) => {
        const d = await api('/api/audit');
        const entrantes = d.sockets.filter((s) => s.direction === 'entrante');
        const sortantes = d.sockets.filter((s) => s.direction === 'sortante');
        const st = Object.fromEntries((d.status || []).map((s) => [s.id, s]));

        corps.innerHTML =
          '<div class="net-sec"><h4>Entrant — ce que le contrôleur accepte</h4>' +
          tableau(['Protocole', 'Écoute sur', 'Pair', 'État'],
            entrantes.map((s) => [s.proto, DW.escapeHtml(s.local),
                                  DW.escapeHtml(s.remote || '—'), DW.escapeHtml(s.state)]),
            'Aucune socket entrante.') + '</div>' +

          '<div class="net-sec"><h4>Sortant — ce que le contrôleur va chercher</h4>' +
          tableau(['Protocole', 'Depuis', 'Vers', 'État'],
            sortantes.map((s) => [s.proto, DW.escapeHtml(s.local),
                                  DW.escapeHtml(s.remote), DW.escapeHtml(s.state)]),
            'Aucune connexion sortante ouverte à cet instant.') + '</div>' +

          '<div class="net-sec"><h4>Liens déclarés</h4>' +
          tableau(['Lien', 'Protocole', 'Cible', 'Points', 'Secrets', 'État'],
            (d.links || []).map((l) => [
              DW.escapeHtml(l.id), DW.escapeHtml(l.protocol), DW.escapeHtml(l.target || '—'),
              String(l.points),
              l.secretRef ? 'référence « ' + DW.escapeHtml(l.secretRef) + ' »' : '—',
              st[l.id] ? DW.escapeHtml(st[l.id].state + ' · ' + st[l.id].detail) : '—',
            ]),
            'Aucun lien réseau configuré.') + '</div>' +

          '<div class="net-sec"><h4>Interfaces</h4>' +
          tableau(['Interface', 'Type', 'MAC', 'Adresses', 'MTU', 'État'],
            (d.interfaces || []).map((i) => [
              DW.escapeHtml(i.name), i.kind, DW.escapeHtml(i.mac || '—'),
              i.ips.length ? i.ips.map(DW.escapeHtml).join('<br>') : '—',
              String(i.mtu), i.up ? i.oper : 'éteinte',
            ]), 'Aucune interface.') + '</div>' +

          '<div class="net-sec"><h4>Propriétés de conception</h4><ul class="net-list">' +
          '<li><b>Lecture seule de bout en bout</b> : aucune écriture vers un équipement, ' +
          'hors trois exceptions bornées et explicites — activation d’un bloc de rapport ' +
          'IEC 61850, requête de lecture SDO CANopen (désactivée par défaut) et demande de ' +
          'PGN J1939 (par point, décochée par défaut).</li>' +
          '<li><b>Aucun secret dans la configuration</b> : elle ne porte que des ' +
          'références, résolues dans l’environnement du service.</li>' +
          '<li><b>Aucune ressource extérieure</b> dans la page : ni CDN, ni police, ni ' +
          'image distante. Le logo de l’exploitant est incorporé.</li>' +
          '<li><b>Écoute de niveau 2</b> (GOOSE, Sampled Values, LLDP) en réception ' +
          'seulement : Diagweb n’émet aucune trame Ethernet.</li>' +
          '</ul></div>' +
          '<div class="m-actions"><button class="btn net-copy" type="button" ' +
          'title="Copier le rapport en texte, pour un compte rendu d’audit">' +
          'Copier le rapport</button><span class="net-msg"></span></div>';

        corps.querySelector('.net-copy').addEventListener('click', () => {
          const txt = rapportTexte(d);
          const msg = corps.querySelector('.net-msg');
          navigator.clipboard.writeText(txt)
            .then(() => { msg.textContent = 'Rapport copié (' + txt.split('\n').length + ' lignes).'; })
            .catch(() => { DW.app.showText('Rapport d’audit', txt); });
        });
      }, 4000);
  }

  /** Le même rapport, en texte : c'est ce qui se colle dans un compte rendu. */
  function rapportTexte(d) {
    const l = [];
    l.push('Diagweb — audit des communications');
    l.push('Processus ' + d.pid + ', port d’écoute ' + d.listenPort);
    l.push('');
    l.push('ENTRANT');
    for (const s of d.sockets.filter((x) => x.direction === 'entrante')) {
      l.push('  ' + s.proto + '  ' + s.local + (s.remote ? '  <- ' + s.remote : '') + '  [' + s.state + ']');
    }
    l.push('');
    l.push('SORTANT');
    const sortantes = d.sockets.filter((x) => x.direction === 'sortante');
    if (!sortantes.length) l.push('  (aucune connexion ouverte à cet instant)');
    for (const s of sortantes) l.push('  ' + s.proto + '  ' + s.local + '  -> ' + s.remote + '  [' + s.state + ']');
    l.push('');
    l.push('LIENS DÉCLARÉS');
    for (const k of d.links || []) {
      l.push('  ' + k.id + '  ' + k.protocol + '  ' + (k.target || '—') + '  ' +
             k.points + ' point(s)' + (k.secretRef ? '  secrets: ' + k.secretRef : ''));
    }
    l.push('');
    l.push('INTERFACES');
    for (const i of d.interfaces || []) {
      l.push('  ' + i.name + '  ' + i.kind + '  ' + (i.mac || '') + '  ' +
             (i.ips.join(', ') || '—') + '  MTU ' + i.mtu + '  ' + (i.up ? i.oper : 'éteinte'));
    }
    return l.join('\n');
  }

  // ---------------------------------------------------------------- capture
  /**
   * Capture d'interfaces. tcpdump tourne sur le contrôleur, au plus près du
   * câble ; le fichier .pcap se relit dans Wireshark. Trois garde-fous
   * (quota, durée, déclencheur) parce qu'une capture oubliée remplit un
   * disque embarqué.
   */
  function pageCapture() {
    let form = null;
    ouvrirPage('Capture d’interfaces réseau',
      'Capture des trames sur les interfaces du contrôleur — Ethernet et CAN — ' +
      'par tcpdump, au format pcap relisible dans Wireshark. Le <b>quota global</b> ' +
      'protège le disque : atteint, les captures en cours s’arrêtent. Une capture ' +
      'peut aussi être <b>déclenchée par une variable</b> de diagnostic, pour ' +
      'attraper un incident rare sans laisser tourner la capture des heures.',
      async (corps) => {
        const [d, ifs] = await Promise.all([api('/api/capture'), api('/api/interfaces')]);
        if (!form) {
          corps.innerHTML = '<div class="net-sec cap-form"></div>' +
                            '<div class="net-sec cap-trig"></div>' +
                            '<div class="net-sec cap-list"></div>';
          form = true;
          construireFormulaire(corps.querySelector('.cap-form'), d, ifs, corps);
          construireDeclencheur(corps.querySelector('.cap-trig'), d, ifs, corps);
        }
        majListe(corps.querySelector('.cap-list'), d, corps);
      }, 2000);
  }

  function construireFormulaire(el, d, ifs, corps) {
    const options = ifs.map((i) =>
      '<option value="' + DW.escapeHtml(i.name) + '">' + DW.escapeHtml(i.name) +
      ' — ' + i.kind + (i.up ? '' : ' (éteinte)') + '</option>').join('');
    el.innerHTML =
      '<h4>Nouvelle capture</h4>' +
      (d.tool ? '' : '<p class="page-vide">tcpdump n’est pas installé sur le contrôleur : ' +
        'la capture est impossible tant qu’il n’y est pas.</p>') +
      '<div class="cap-row">' +
        '<label>Interface<select class="cap-if" title="Interface à capturer. Les ' +
          'interfaces CAN se capturent comme les autres, avec leur propre type de lien.">' +
          options + '</select></label>' +
        '<label>Durée<select class="cap-dur" title="Durée maximale ; la capture ' +
          's’arrête d’elle-même. « Sans limite » reste soumise au quota.">' +
          '<option value="30">30 s</option><option value="60" selected>1 min</option>' +
          '<option value="300">5 min</option><option value="900">15 min</option>' +
          '<option value="3600">1 h</option><option value="0">sans limite</option>' +
        '</select></label>' +
        '<label class="cap-wide">Filtre<input class="cap-filter" type="text" ' +
          'placeholder="ex. host 10.0.0.5 and port 502" ' +
          'title="Expression de filtrage pcap, facultative. Elle réduit le volume ' +
          'capturé — utile quand le quota est serré."></label>' +
        '<button class="btn primary cap-go" type="button" ' +
          'title="Démarrer la capture sur cette interface">Démarrer</button>' +
      '</div>' +
      '<p class="m-note cap-quota"></p>';
    el.querySelector('.cap-go').addEventListener('click', async () => {
      try {
        await api('/api/capture/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            iface: el.querySelector('.cap-if').value,
            durationS: parseFloat(el.querySelector('.cap-dur').value),
            filter: el.querySelector('.cap-filter').value.trim(),
          }),
        });
        DW.app.toast('Capture démarrée.');
      } catch (e) { DW.app.toast('Capture refusée : ' + e.message, 'err'); }
      majTout(corps);
    });
  }

  function construireDeclencheur(el, d, ifs, corps) {
    const t = d.trigger || {};
    const options = ifs.map((i) =>
      '<option value="' + DW.escapeHtml(i.name) + '"' +
      (t.iface === i.name ? ' selected' : '') + '>' + DW.escapeHtml(i.name) + '</option>').join('');
    el.innerHTML =
      '<h4>Déclenchement par une variable</h4>' +
      '<div class="cap-row">' +
        '<label class="pop-check"><input type="checkbox" class="tr-on"' + (t.enabled ? ' checked' : '') +
          ' title="Armer le déclencheur : la capture suivra la variable"><span>Actif</span></label>' +
        '<label class="cap-wide">Variable<input class="tr-addr" type="text" ' +
          'value="' + DW.escapeHtml(t.addr || '') + '" placeholder="ex. S0.5 ou @banc.defaut" ' +
          'title="Adresse d’une variable de diagnostic. La capture démarre au front ' +
          'montant de la condition et s’arrête au front descendant."></label>' +
        '<label>Condition<select class="tr-mode" title="Condition évaluée sur la variable">' +
          '<option value="nonzero"' + (t.mode === 'nonzero' ? ' selected' : '') + '>non nulle</option>' +
          '<option value="above"' + (t.mode === 'above' ? ' selected' : '') + '>au-dessus de</option>' +
          '<option value="below"' + (t.mode === 'below' ? ' selected' : '') + '>en dessous de</option>' +
        '</select></label>' +
        '<label>Seuil<input class="tr-seuil" type="number" step="any" value="' +
          (t.threshold || 0) + '" title="Seuil comparé à la valeur de la variable"></label>' +
        '<label>Interface<select class="tr-if" title="Interface capturée au déclenchement">' +
          options + '</select></label>' +
        '<label>Durée max<input class="tr-dur" type="number" min="1" value="' +
          (t.durationS || 60) + '" title="Durée maximale d’une capture déclenchée (s)"></label>' +
        '<button class="btn tr-save" type="button" ' +
          'title="Enregistrer le déclencheur et le quota">Appliquer</button>' +
      '</div>' +
      '<div class="cap-row"><label>Quota global (Mo)<input class="cap-quota-in" type="number" ' +
        'min="1" value="' + Math.round((d.quotaBytes || 0) / 1048576) + '" ' +
        'title="Espace maximal occupé par l’ensemble des captures. Atteint, les ' +
        'captures en cours sont arrêtées."></label></div>';
    el.querySelector('.tr-save').addEventListener('click', async () => {
      try {
        await api('/api/capture/config', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quotaMB: parseFloat(el.querySelector('.cap-quota-in').value) || 100,
            trigger: {
              enabled: el.querySelector('.tr-on').checked,
              addr: el.querySelector('.tr-addr').value.trim(),
              mode: el.querySelector('.tr-mode').value,
              threshold: parseFloat(el.querySelector('.tr-seuil').value) || 0,
              iface: el.querySelector('.tr-if').value,
              durationS: parseFloat(el.querySelector('.tr-dur').value) || 60,
            },
          }),
        });
        DW.app.toast('Déclencheur et quota enregistrés.');
      } catch (e) { DW.app.toast('Réglage refusé : ' + e.message, 'err'); }
      majTout(corps);
    });
  }

  function majListe(el, d, corps) {
    const pc = d.quotaBytes ? Math.min(100, Math.round(100 * d.usedBytes / d.quotaBytes)) : 0;
    el.innerHTML =
      '<h4>Captures</h4>' +
      '<p class="m-note">Disque : ' + octets(d.usedBytes) + ' sur ' + octets(d.quotaBytes) +
      ' (' + pc + ' %)' + (d.message ? ' · ' + DW.escapeHtml(d.message) : '') + '</p>' +
      '<div class="cap-jauge"><i style="width:' + pc + '%"></i></div>' +
      tableau(['Fichier', 'Interface', 'État', 'Taille', 'Âge', ''],
        (d.runs || []).slice().reverse().map((r) => [
          DW.escapeHtml(r.id), DW.escapeHtml(r.iface),
          '<span class="cap-etat cap-' + (r.state === 'en cours' ? 'on' :
            r.state === 'échec' ? 'ko' : 'fin') + '">' + DW.escapeHtml(r.state) + '</span> ' +
            '<span class="cap-detail">' + DW.escapeHtml(r.detail || '') + '</span>',
          octets(r.bytes), duree(r.ageS),
          (r.state === 'en cours'
            ? '<button class="btn sm cap-stop" data-id="' + DW.escapeHtml(r.id) + '" ' +
              'title="Arrêter cette capture ; le fichier est refermé proprement">Arrêter</button>'
            : (r.bytes > 24
               ? '<a class="btn sm" href="/api/capture/file?name=' + encodeURIComponent(r.id) +
                 '" title="Télécharger le fichier pcap">pcap</a> '
               : '') +
              '<button class="btn sm cap-del" data-id="' + DW.escapeHtml(r.id) + '" ' +
              'title="Supprimer ce fichier et libérer le quota">Supprimer</button>'),
        ]), 'Aucune capture pour l’instant.');

    for (const b of el.querySelectorAll('.cap-stop')) {
      b.addEventListener('click', async () => {
        try { await api('/api/capture/stop', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.dataset.id }) }); } catch (e) { DW.app.toast(e.message, 'err'); }
        majTout(corps);
      });
    }
    for (const b of el.querySelectorAll('.cap-del')) {
      b.addEventListener('click', async () => {
        try { await api('/api/capture/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.dataset.id }) }); } catch (e) { DW.app.toast(e.message, 'err'); }
        majTout(corps);
      });
    }
  }

  async function majTout(corps) {
    const d = await api('/api/capture');
    majListe(corps.querySelector('.cap-list'), d, corps);
  }

  // ------------------------------------------------------------------- LLDP
  /**
   * Voisinage LLDP : ce qu'il y a EN FACE de chaque interface. Réception
   * seule — Diagweb n'émet aucune trame et ne se déclare donc pas au
   * voisinage.
   */
  function pageLldp() {
    ouvrirPage('Voisinage réseau (LLDP)',
      'Ce que les équipements voisins annoncent sur chaque interface : produit, ' +
      'port, adresse d’administration, VLAN. Écoute <b>passive</b> : Diagweb n’émet ' +
      'aucune trame LLDP et ne se déclare pas au voisinage. Une annonce non ' +
      'renouvelée disparaît au bout du délai réglé ci-dessous.',
      async (corps) => {
        const d = await api('/api/lldp');
        const parIface = new Map();
        for (const n of d.neighbors) {
          if (!parIface.has(n.iface)) parIface.set(n.iface, []);
          parIface.get(n.iface).push(n);
        }
        let html = '';
        if (!d.active) {
          html += '<p class="page-vide">Écoute LLDP inactive : ' +
            DW.escapeHtml(d.error || 'raison inconnue') + '</p>';
        }
        html += '<div class="net-sec"><label class="lldp-to">Oublier un voisin après ' +
          '<select class="lldp-timeout" title="Délai au-delà duquel un voisin qui ' +
          'n’émet plus disparaît du tableau. Une annonce LLDP est répétée toutes les ' +
          '30 s en général ; dix minutes laissent passer plusieurs manques.">' +
          [60, 300, 600, 1800, 3600].map((v) =>
            '<option value="' + v + '"' + (Math.round(d.timeoutS) === v ? ' selected' : '') +
            '>' + duree(v) + '</option>').join('') +
          '</select> sans nouvelle annonce</label></div>';

        for (const i of d.interfaces) {
          if (i.kind === 'boucle') continue;
          const l = parIface.get(i.name) || [];
          html += '<div class="net-sec"><h4>' + DW.escapeHtml(i.name) +
            ' <span class="lldp-if">' + i.kind + ' · ' + (i.up ? i.oper : 'éteinte') +
            (i.mac ? ' · ' + DW.escapeHtml(i.mac) : '') + '</span></h4>';
          if (!l.length) {
            html += '<p class="page-vide">Aucun voisin annoncé sur cette interface.</p>';
          } else {
            html += l.map((n) =>
              '<div class="lldp-card">' +
                '<div class="lldp-name">' + DW.escapeHtml(n.sysName || n.chassis || '(sans nom)') + '</div>' +
                '<div class="lldp-grid">' +
                  ligne('Port distant', (n.port || '—') + (n.portDesc ? ' — ' + n.portDesc : '')) +
                  ligne('Châssis', n.chassis + (n.chassisKind ? ' (' + n.chassisKind + ')' : '')) +
                  ligne('Administration', n.mgmtIp || '—') +
                  ligne('Description', n.sysDesc || '—') +
                  ligne('Capacités', n.caps || '—') +
                  ligne('VLAN natif', n.vlan || '—') +
                  ligne('MAC source', n.srcMac) +
                  ligne('TTL annoncé', n.ttl ? n.ttl + ' s' : '—') +
                  ligne('Vu depuis', duree(n.seenS) + ' · ' + n.frames + ' annonce(s)') +
                  ligne('Dernière annonce', 'il y a ' + duree(n.ageS)) +
                '</div></div>').join('');
          }
          html += '</div>';
        }
        corps.innerHTML = html;
        corps.querySelector('.lldp-timeout').addEventListener('change', async (e) => {
          await api('/api/lldp', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeoutS: parseFloat(e.target.value) }),
          });
          DW.app.toast('Délai d’oubli réglé sur ' + duree(parseFloat(e.target.value)) + '.');
        });
      }, 5000);
  }

  const ligne = (k, v) => '<span class="lldp-k">' + k + '</span><span class="lldp-v">' +
                          DW.escapeHtml(String(v)) + '</span>';

  DW.network = { pageAudit, pageCapture, pageLldp };
})();
