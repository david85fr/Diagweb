/* Diagweb — back-end simulé des pages réseau (audit, capture, LLDP).
 *
 * Les trois pages réseau interrogent le serveur de diagnostic du contrôleur.
 * Hors serveur — Artifact, page publiée, copie hors ligne — il n'y a personne
 * pour répondre. Plutôt que de fermer la porte, ce module répond à la place du
 * serveur, avec **exactement les mêmes routes et les mêmes formes de JSON**
 * (`server/src/main.cpp`) : l'interface de gestion reste visible et
 * manipulable, on peut démarrer une capture, la voir grossir, l'arrêter, régler
 * un quota, armer un déclencheur.
 *
 * Deux règles, pour que la simulation ne se fasse jamais passer pour la
 * réalité :
 *   1. chaque réponse porte `simule: true`, et les pages affichent un bandeau ;
 *   2. rien n'est inventé qui prétende venir du matériel : les fichiers pcap
 *      simulés ne se téléchargent pas (il n'y a pas de trame derrière).
 *
 * Ce module est au serveur de diagnostic ce que `sim.js` est à la source de
 * données : le bouchon qui permet de travailler l'interface sans contrôleur.
 */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  const CLE = 'diagweb.netsim.v1';   // réglages simulés (quota, déclencheur)
  const t0 = Date.now() / 1000;
  const now = () => Date.now() / 1000;

  // --------------------------------------------------------- état simulé
  // Un contrôleur plausible : deux ports Ethernet, un bus CAN, la boucle.
  const INTERFACES = [
    { name: 'eth0', kind: 'ethernet', mac: '02:1c:42:a7:10:01',
      ips: ['192.168.10.24/24', 'fe80::1c:42ff:fea7:1001/64'], mtu: 1500, up: true, oper: 'up' },
    { name: 'eth1', kind: 'ethernet', mac: '02:1c:42:a7:10:02',
      ips: ['10.20.0.7/24'], mtu: 1500, up: true, oper: 'up' },
    { name: 'eth2', kind: 'ethernet', mac: '02:1c:42:a7:10:03',
      ips: [], mtu: 1500, up: false, oper: 'down' },
    { name: 'can0', kind: 'can', mac: '', ips: [], mtu: 16, up: true, oper: 'unknown' },
    { name: 'lo', kind: 'boucle', mac: '00:00:00:00:00:00', ips: ['127.0.0.1/8'], mtu: 65536, up: true, oper: 'unknown' },
  ];

  const VOISINS = [
    { iface: 'eth0', chassis: '00:1b:1b:44:0a:21', chassisKind: 'adresse MAC',
      port: 'Gi1/0/12', portDesc: 'vers armoire de commande', sysName: 'commutateur-atelier-1',
      sysDesc: 'Commutateur industriel 8 ports, gestion niveau 2', mgmtIp: '192.168.10.1',
      caps: 'pont (actif)', vlan: '10', srcMac: '00:1b:1b:44:0a:21', ttl: 120, frames: 0, _p: 30 },
    { iface: 'eth0', chassis: 'passerelle-io-3', chassisKind: 'nom local',
      port: 'port-1', portDesc: '', sysName: 'passerelle-io-3',
      sysDesc: 'Passerelle d’entrées/sorties déportées', mgmtIp: '192.168.10.42',
      caps: 'station (actif)', vlan: '', srcMac: '00:0e:8c:71:33:5a', ttl: 120, frames: 0, _p: 30 },
    { iface: 'eth1', chassis: '00:60:35:12:c4:07', chassisKind: 'adresse MAC',
      port: 'eth3', portDesc: 'liaison de supervision', sysName: 'routeur-supervision',
      sysDesc: 'Routeur d’usine, filtrage entre ateliers', mgmtIp: '10.20.0.1',
      caps: 'pont (actif), routeur (actif)', vlan: '200', srcMac: '00:60:35:12:c4:07',
      ttl: 120, frames: 0, _p: 60 },
  ];

  const etat = {
    quotaBytes: 100 * 1048576,
    trigger: { enabled: false, addr: '', mode: 'nonzero', threshold: 0, iface: 'eth0', durationS: 60, armed: false },
    lldpTimeoutS: 600,
    runs: [],
    seq: 1,
    message: '',
  };

  try {
    const brut = localStorage.getItem(CLE);
    if (brut) {
      const j = JSON.parse(brut);
      if (j && typeof j.quotaBytes === 'number') etat.quotaBytes = j.quotaBytes;
      if (j && j.trigger) Object.assign(etat.trigger, j.trigger, { armed: false });
      if (j && typeof j.lldpTimeoutS === 'number') etat.lldpTimeoutS = j.lldpTimeoutS;
    }
  } catch (e) { /* stockage indisponible : réglages par défaut */ }

  // Les réglages simulés survivent au rechargement, comme ceux du serveur
  // survivent au redémarrage : c'est la propriété qu'on veut pouvoir montrer.
  function retenir() {
    try {
      localStorage.setItem(CLE, JSON.stringify({
        quotaBytes: etat.quotaBytes, trigger: etat.trigger, lldpTimeoutS: etat.lldpTimeoutS,
      }));
    } catch (e) { /* stockage indisponible : la session en cours suffit */ }
  }

  // --------------------------------------------------------------- capture
  /** Débit simulé, par interface : une capture grossit de façon crédible. */
  const debit = (iface) => (iface === 'can0' ? 3500 : iface === 'eth0' ? 42000 : 9000);

  function tailleDe(r) {
    const fin = r.state === 'en cours' ? now() : r.end_t;
    return Math.round(24 + debit(r.iface) * Math.max(0, fin - r.start_t));
  }

  function occupe() {
    return etat.runs.reduce((s, r) => s + tailleDe(r), 0);
  }

  function demarrer(iface, dureeS, filtre) {
    if (!INTERFACES.some((i) => i.name === iface)) return 'interface inconnue : ' + iface;
    if (etat.runs.some((r) => r.state === 'en cours' && r.iface === iface)) {
      return 'une capture est déjà en cours sur ' + iface;
    }
    if (occupe() >= etat.quotaBytes) return 'quota de disque atteint';
    const n = etat.seq++;
    etat.runs.push({
      id: iface + '-sim' + String(n).padStart(3, '0'),
      iface, filter: filtre || '', state: 'en cours', detail: 'capture simulée',
      start_t: now(), end_t: 0, duration_s: dureeS || 0,
    });
    return '';
  }

  function terminer(r, etatFin, detail) {
    r.state = etatFin;
    r.end_t = now();
    r.detail = detail;
  }

  /** Applique durée, quota et déclencheur — l'équivalent de `service()`. */
  function service() {
    for (const r of etat.runs) {
      if (r.state !== 'en cours') continue;
      if (r.duration_s > 0 && now() - r.start_t >= r.duration_s) terminer(r, 'terminée', 'durée atteinte');
    }
    if (occupe() >= etat.quotaBytes) {
      for (const r of etat.runs) {
        if (r.state === 'en cours') terminer(r, 'arrêtée', 'quota de disque atteint');
      }
    }
    const t = etat.trigger;
    if (!t.enabled || !t.addr) { t.armed = false; return; }
    const v = DW.source && DW.source.latest ? DW.source.latest(t.addr) : null;
    if (!v || typeof v.v !== 'number') return;
    const vrai = t.mode === 'above' ? v.v > t.threshold
               : t.mode === 'below' ? v.v < t.threshold
               : v.v !== 0;
    if (vrai && !t.armed) {
      t.armed = true;
      const err = demarrer(t.iface, t.durationS, '');
      etat.message = err ? 'déclenchement refusé : ' + err
                         : 'capture déclenchée par « ' + t.addr +' »';
    } else if (!vrai && t.armed) {
      t.armed = false;
      for (const r of etat.runs) {
        if (r.state === 'en cours' && r.detail === 'capture simulée') {
          terminer(r, 'terminée', 'fin de la condition de déclenchement');
        }
      }
    }
  }

  function captureJson() {
    service();
    return {
      simule: true,
      tool: '/usr/bin/tcpdump (simulé)',
      // Aucun privilège en jeu hors serveur : la simulation ne prétend pas
      // ouvrir d'interface, elle ne peut donc pas s'en voir refuser une.
      privilege: '',
      quotaBytes: etat.quotaBytes,
      usedBytes: occupe(),
      message: etat.message,
      trigger: Object.assign({}, etat.trigger),
      runs: etat.runs.map((r) => ({
        id: r.id, iface: r.iface, filter: r.filter, state: r.state, detail: r.detail,
        bytes: tailleDe(r), ageS: now() - r.start_t, durationS: r.duration_s, simule: true,
      })),
    };
  }

  // ----------------------------------------------------------------- audit
  const liens = () => (DW.protocols && DW.protocols.links ? DW.protocols.links() : []);

  /** Cible d'un lien, comme le serveur la compose pour l'audit. */
  function cible(k) {
    const p = k.params || {};
    if (p.host) return p.host + ':' + (p.port || 0);
    return p.iface || p.device || p.endpoint || '';
  }

  /** Sockets plausibles : le serveur en écoute, plus un client par lien actif. */
  function sockets() {
    const l = [
      { proto: 'tcp', local: '0.0.0.0:8080', remote: '', state: 'écoute', direction: 'entrante' },
      { proto: 'tcp', local: '192.168.10.24:8080', remote: '192.168.10.60:51422',
        state: 'établie', direction: 'entrante' },
    ];
    let p = 40000;
    for (const k of liens()) {
      if (k.enabled === false) continue;
      const par = k.params || {};
      if (!par.host) continue;                 // liens sur bus : pas de socket IP
      l.push({
        proto: (k.protocol === 'snmp' ? 'udp' : 'tcp'),
        local: '192.168.10.24:' + (p++), remote: par.host + ':' + (par.port || 0),
        state: 'établie', direction: 'sortante',
      });
    }
    return l;
  }

  function auditJson() {
    const st = (DW.protocols && DW.protocols.status) || {};
    return {
      simule: true, listenPort: 8080, pid: 0, source: 'simulation',
      sockets: sockets(),
      interfaces: INTERFACES,
      links: liens().map((k) => ({
        id: k.id, protocol: k.protocol, target: cible(k),
        points: (k.points || []).length, enabled: k.enabled !== false,
        secretRef: (k.params && k.params.secretRef) || '',
      })),
      status: Object.keys(st).map((id) => ({
        id, state: st[id].state || '', detail: st[id].detail || '',
      })),
    };
  }

  // ------------------------------------------------------------------ LLDP
  function lldpJson() {
    const age = (v) => (now() - t0) % v._p;     // annonce répétée toutes les _p s
    return {
      simule: true, active: true, error: '', timeoutS: etat.lldpTimeoutS,
      interfaces: INTERFACES,
      neighbors: VOISINS.map((v) => Object.assign({}, v, {
        ageS: age(v),
        seenS: now() - t0,
        frames: Math.max(1, Math.floor((now() - t0) / v._p) + 1),
      })),
    };
  }

  // ------------------------------------------------- aiguillage des routes
  /**
   * Même contrat que `fetch` côté appelant : le chemin et le corps sont ceux
   * du serveur. Toute route inconnue échoue, comme elle échouerait là-bas.
   */
  function appel(chemin, options) {
    const opt = options || {};
    const corps = opt.body ? JSON.parse(opt.body) : {};
    const route = chemin.split('?')[0];

    if (route === '/api/interfaces') return INTERFACES;
    if (route === '/api/audit') return auditJson();
    if (route === '/api/lldp') {
      if (opt.method === 'PUT') {
        etat.lldpTimeoutS = Math.max(10, Math.min(86400, corps.timeoutS || 600));
        retenir();
      }
      return lldpJson();
    }
    if (route === '/api/capture') return captureJson();
    if (route === '/api/capture/start') {
      const err = demarrer(corps.iface, corps.durationS, corps.filter);
      if (err) throw new Error(err);
      return { ok: true, state: captureJson() };
    }
    if (route === '/api/capture/stop') {
      const r = etat.runs.find((x) => x.id === corps.id);
      if (!r || r.state !== 'en cours') throw new Error('capture inconnue ou déjà arrêtée');
      terminer(r, 'arrêtée', 'arrêt demandé');
      return { ok: true, state: captureJson() };
    }
    if (route === '/api/capture/delete') {
      const i = etat.runs.findIndex((x) => x.id === corps.id);
      if (i < 0) throw new Error('capture inconnue');
      if (etat.runs[i].state === 'en cours') throw new Error('capture en cours : l’arrêter d’abord');
      etat.runs.splice(i, 1);
      return { ok: true, state: captureJson() };
    }
    if (route === '/api/capture/config') {
      // Bornes identiques au serveur. `4096 << 20` déborderait le décalage
      // 32 bits de JavaScript et retournerait 0 : la multiplication s'impose.
      etat.quotaBytes = Math.max(1048576,
          Math.min(4096 * 1048576, Math.round((corps.quotaMB || 100) * 1048576)));
      const t = corps.trigger || {};
      const arme = etat.trigger.armed;
      etat.trigger = {
        enabled: !!t.enabled, addr: t.addr || '', mode: t.mode || 'nonzero',
        threshold: t.threshold || 0, iface: t.iface || 'eth0',
        durationS: t.durationS || 60, armed: arme,
      };
      // Une variable observée doit être abonnée, sinon le déclencheur est
      // aveugle — exactement comme côté serveur.
      if (etat.trigger.enabled && etat.trigger.addr && DW.source && DW.source.subscribe) {
        DW.source.subscribe(etat.trigger.addr, { periodMs: 200 });
      }
      retenir();
      return { ok: true, state: captureJson() };
    }
    throw new Error('point d’entrée inconnu : ' + route);
  }

  DW.netsim = { appel, interfaces: INTERFACES };
})();
