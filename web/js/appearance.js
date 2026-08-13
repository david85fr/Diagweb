/* Diagweb — apparence : logo de l'exploitant et couleurs de l'interface.
 *
 * Deux réglages, un même principe : ils appartiennent à l'INSTALLATION, pas au
 * poste qui les saisit. Servis par le contrôleur, ils sont donc enregistrés
 * côté serveur (`<data-dir>/appearance.json`) et tous les postes connectés les
 * voient. Page ouverte hors serveur (copie hors ligne, Artifact), ils restent
 * dans le navigateur : jamais de réglage perdu, jamais d'appel réseau inutile.
 *
 * AUCUNE RESSOURCE EXTERNE. Le logo n'est pas une URL mais une image
 * INCORPORÉE (data:), pour deux raisons : la page doit se servir hors ligne
 * depuis le contrôleur, et la page publiée l'est sous une CSP stricte qui
 * refuse tout hôte tiers. Une image matricielle est réduite à la volée avant
 * d'être stockée — un logo de 4 Mo dans une configuration partagée n'a aucun
 * sens.
 *
 * Le logo est rendu dans une balise <img>, jamais injecté comme balisage. Un
 * SVG y est traité en image : ses scripts éventuels ne s'exécutent pas. C'est
 * la seule façon d'accepter un fichier fourni par l'exploitant sans lui donner
 * les clés de la page.
 */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  const CLE = 'diagweb.appearance';
  const MAX_LOGO = 384 * 1024;      // octets du data: final
  const LOGO_H = 128;               // hauteur de réduction (affiché ~28 px)
  const LOGO_W = 512;

  /**
   * Jetons de couleur proposés. Volontairement peu nombreux : tout le reste
   * s'en déduit (voir `derives`). Six réglages tiennent dans une fenêtre et
   * donnent une palette cohérente ; vingt donneraient surtout l'occasion de
   * fabriquer une interface illisible.
   */
  const TOKENS = [
    { key: 'accent', css: '--accent', label: 'Accent',
      help: 'Couleur des boutons actifs, des sélections et des repères. Les nuances associées en sont déduites.' },
    { key: 'bg', css: '--bg', label: 'Fond de page',
      help: 'Fond général, derrière les cartes.' },
    { key: 'panel', css: '--panel', label: 'Cartes',
      help: 'Fond des cartes : tableau, graphiques, fenêtres.' },
    { key: 'panel2', css: '--panel-2', label: 'Fond secondaire',
      help: 'Fond des champs, des lignes paires du tableau et des zones en retrait.' },
    { key: 'ink', css: '--ink', label: 'Texte',
      help: 'Couleur du texte principal. Les gris atténués en sont déduits.' },
    { key: 'line', css: '--line', label: 'Traits',
      help: 'Bordures des cartes, séparateurs et grille des graphiques.' },
  ];

  const vide = () => ({ version: 1, logo: '', colors: { dark: {}, light: {} } });
  let etat = vide();
  let svgOrigine = null;            // logo par défaut, capturé au démarrage

  const theme = () => (DW.isDarkTheme && DW.isDarkTheme() ? 'dark' : 'light');
  const couleurs = () => etat.colors[theme()] || {};

  /** Le serveur de diagnostic sert-il cette page ? */
  const surServeur = () => DW.sourceMode === 'ws';

  // ------------------------------------------------------------ application
  /**
   * Nuances déduites des jetons réglés, pour que la palette reste cohérente
   * sans multiplier les réglages :
   *   --accent-dim  l'autre extrémité des dégradés d'accent ;
   *   --muted/faint le texte atténué, obtenu en fondant le texte dans le fond.
   */
  function derives(root, c) {
    if (c.accent) {
      root.style.setProperty('--accent-dim', theme() === 'dark'
        ? 'color-mix(in srgb, ' + c.accent + ' 62%, #000)'
        : 'color-mix(in srgb, ' + c.accent + ' 82%, #fff)');
    } else {
      root.style.removeProperty('--accent-dim');
    }
    if (c.ink) {
      root.style.setProperty('--muted', 'color-mix(in srgb, ' + c.ink + ' 62%, var(--bg))');
      root.style.setProperty('--faint', 'color-mix(in srgb, ' + c.ink + ' 42%, var(--bg))');
    } else {
      root.style.removeProperty('--muted');
      root.style.removeProperty('--faint');
    }
  }

  /** Applique les couleurs du thème courant, ou les retire si aucune. */
  function appliquerCouleurs() {
    const root = document.documentElement;
    const c = couleurs();
    for (const t of TOKENS) {
      if (c[t.key]) root.style.setProperty(t.css, c[t.key]);
      else root.style.removeProperty(t.css);
    }
    derives(root, c);
    // Les graphiques lisent l'encre du thème dans les variables CSS : sans
    // cette invalidation, ils garderaient l'ancienne palette jusqu'au prochain
    // changement de thème.
    if (DW.invalidateChartTheme) DW.invalidateChartTheme();
    document.dispatchEvent(new CustomEvent('dw:appearance'));
  }

  function appliquerLogo() {
    const box = document.querySelector('.logo');
    if (!box) return;
    if (svgOrigine === null) svgOrigine = box.innerHTML;
    box.innerHTML = '';
    if (!etat.logo) {
      box.innerHTML = svgOrigine;
    } else {
      const img = document.createElement('img');
      img.src = etat.logo;                 // data: — jamais une URL distante
      img.alt = 'Logo de l’installation';
      box.appendChild(img);
    }
    // L'icône d'onglet suit le logo : c'est le même repère visuel, et
    // l'opérateur qui ouvre trois postes s'y retrouve.
    let lien = document.querySelector('link[rel="icon"]');
    if (etat.logo) {
      if (!lien) {
        lien = document.createElement('link');
        lien.rel = 'icon';
        document.head.appendChild(lien);
      }
      lien.href = etat.logo;
    } else if (lien && lien.dataset.dw === '1') {
      lien.remove();
    }
    if (lien) lien.dataset.dw = '1';
  }

  function appliquer() { appliquerCouleurs(); appliquerLogo(); }

  // ------------------------------------------------------------ persistance
  function lireLocal() {
    try {
      const brut = window.localStorage.getItem(CLE);
      if (brut) return normaliser(JSON.parse(brut));
    } catch (e) { /* stockage indisponible ou contenu illisible */ }
    return null;
  }

  /** N'accepte que ce qu'on sait rendre : une image incorporée et des couleurs. */
  function normaliser(o) {
    const out = vide();
    if (!o || typeof o !== 'object') return out;
    if (typeof o.logo === 'string' && /^data:image\//.test(o.logo)) out.logo = o.logo;
    for (const t of ['dark', 'light']) {
      const src = (o.colors && o.colors[t]) || {};
      for (const tok of TOKENS) {
        const v = src[tok.key];
        if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) out.colors[t][tok.key] = v;
      }
    }
    return out;
  }

  async function charger() {
    // Le stockage local d'abord : l'apparence s'applique sans attendre le
    // réseau, ce qui évite de voir la page changer de couleur sous les yeux.
    const local = lireLocal();
    if (local) { etat = local; appliquer(); }
    if (!surServeur()) return etat;
    try {
      const r = await fetch('/api/appearance', { cache: 'no-store' });
      if (r.ok) {
        etat = normaliser(await r.json());
        appliquer();
        try { window.localStorage.setItem(CLE, JSON.stringify(etat)); } catch (e) { /* ignoré */ }
      }
    } catch (e) { /* serveur muet : les réglages locaux font foi */ }
    return etat;
  }

  async function enregistrer() {
    appliquer();
    try { window.localStorage.setItem(CLE, JSON.stringify(etat)); } catch (e) { /* ignoré */ }
    if (DW.dnd && DW.dnd.shareAppearance) DW.dnd.shareAppearance(etat);
    if (!surServeur()) return { ok: true, portee: 'navigateur' };
    try {
      const r = await fetch('/api/appearance', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(etat),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        return { ok: false, error: j.error || ('refus du serveur (HTTP ' + r.status + ')') };
      }
      return { ok: true, portee: 'contrôleur' };
    } catch (e) {
      return { ok: false, error: 'serveur injoignable' };
    }
  }

  // ------------------------------------------------------------------ logo
  /**
   * Fichier choisi par l'opérateur → image incorporée, réduite.
   *
   * SVG : conservé tel quel (il se redimensionne sans perte), simplement
   * encodé. Matriciel : redessiné dans un canvas à la hauteur d'affichage,
   * ce qui ramène une photo de plusieurs méga-octets à quelques kilo-octets.
   */
  function lireLogo(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('aucun fichier'));
      if (!/^image\//.test(file.type || '')) {
        return reject(new Error('ce fichier n’est pas une image'));
      }
      if (file.size > 4 * 1024 * 1024) {
        return reject(new Error('image trop lourde (4 Mo maximum en entrée)'));
      }
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('lecture impossible'));
      if (/svg/.test(file.type)) {
        fr.onload = () => {
          const uri = 'data:image/svg+xml;base64,' + btoa(
            String.fromCharCode(...new Uint8Array(fr.result)));
          if (uri.length > MAX_LOGO) return reject(new Error('SVG trop volumineux'));
          resolve(uri);
        };
        fr.readAsArrayBuffer(file);
        return;
      }
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('image illisible'));
        img.onload = () => {
          const k = Math.min(1, LOGO_H / (img.naturalHeight || LOGO_H),
                             LOGO_W / (img.naturalWidth || LOGO_W));
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(img.naturalWidth * k));
          cv.height = Math.max(1, Math.round(img.naturalHeight * k));
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          let uri = cv.toDataURL('image/png');
          if (uri.length > MAX_LOGO) uri = cv.toDataURL('image/jpeg', 0.85);
          if (uri.length > MAX_LOGO) return reject(new Error('image trop lourde après réduction'));
          resolve(uri);
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  DW.appearance = {
    TOKENS,
    charger,
    enregistrer,
    appliquer,
    lireLogo,
    etat: () => etat,
    /** Valeur affichée d'un jeton : celle réglée, sinon celle du thème. */
    valeur(key) {
      const c = couleurs();
      if (c[key]) return c[key];
      const tok = TOKENS.find((t) => t.key === key);
      const v = getComputedStyle(document.documentElement).getPropertyValue(tok.css).trim();
      return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : '#888888';
    },
    setCouleur(key, valeur) {
      etat.colors[theme()][key] = valeur;
      appliquerCouleurs();
    },
    setLogo(uri) { etat.logo = uri || ''; appliquerLogo(); },
    /** Remet les couleurs du thème courant à celles du produit. */
    reinitialiserCouleurs() {
      etat.colors[theme()] = {};
      appliquerCouleurs();
    },
    /** Reçu d'une autre fenêtre : appliqué sans réémettre ni réenregistrer. */
    recevoir(o) {
      etat = normaliser(o);
      appliquer();
      try { window.localStorage.setItem(CLE, JSON.stringify(etat)); } catch (e) { /* ignoré */ }
    },
    surServeur,
  };

  // Le thème bascule : les couleurs propres à l'autre thème prennent le relais.
  document.addEventListener('dw:theme', appliquerCouleurs);
})();
