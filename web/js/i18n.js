/* Diagweb — interface bilingue (français / anglais).
 *
 * La clé de traduction est **le texte français lui-même**, pas un identifiant
 * inventé. Trois raisons, dans un logiciel déjà écrit et déjà volumineux :
 *
 *   1. une traduction manquante retombe sur le français — jamais une clé
 *      brute ni un libellé vide à l'écran ;
 *   2. le code source reste lisible tel quel : on lit la phrase, pas
 *      `menu.table.duplicate` ;
 *   3. la reprise ne demande pas de toucher aux 900 appels existants.
 *
 * La traduction s'applique au DOM, pas aux appels : un `MutationObserver`
 * traduit ce qui apparaît — fenêtres, menus, messages éphémères, pages
 * réseau — sans que le reste du code ait à savoir qu'il existe une seconde
 * langue. Seuls les textes dessinés au canevas passent par `DW.t()`, faute
 * de nœud à observer.
 *
 * Changer de langue **recharge la page**. La session (onglets, mosaïque,
 * journalisation) est déjà restaurée au chargement : on évite ainsi tout état
 * à moitié traduit, et il n'y a aucun inventaire de nœuds à tenir.
 */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  const CLE = 'diagweb.lang';
  const LANGUES = { fr: 'Français', en: 'English' };

  let lang = 'fr';
  try {
    const v = localStorage.getItem(CLE);
    if (v && LANGUES[v]) lang = v;
  } catch (e) { /* stockage indisponible : français */ }

  const DICT = (lang !== 'fr' && DW.DICTS && DW.DICTS[lang]) || null;

  /** Traduit une chaîne ; rend le français si la traduction manque. */
  function t(fr) {
    if (!DICT || typeof fr !== 'string') return fr;
    const s = DICT[fr];
    return s === undefined ? fr : s;
  }

  /**
   * Traduit une chaîne dont les bords portent des espaces ou de la
   * ponctuation d'assemblage : le DOM contient souvent « Fermer » entouré de
   * blancs d'indentation, qui ne doivent pas empêcher la correspondance.
   */
  function tNoeud(txt) {
    const brut = txt.trim();
    if (!brut) return null;
    // Espaces internes ramenés à un seul : un texte du HTML porte les retours
    // à la ligne et l'indentation de la source, qui ne doivent pas faire
    // manquer la correspondance.
    const cle = brut.replace(/\s+/g, ' ');
    const trad = t(cle);
    if (trad === cle) return null;
    return txt.replace(brut, trad);
  }

  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const IGNORE = { SCRIPT: 1, STYLE: 1, CANVAS: 1, CODE: 1 };
  const VIVANT = 'button, input, select, textarea, a, canvas, [id]';

  /** L'élément est-il un bloc de texte enrichi, traduisible d'une pièce ? */
  function bloc(el) {
    if (!el.children.length) return false;
    return !el.querySelector(VIVANT);
  }

  function traduireBloc(el) {
    if (!bloc(el)) return false;
    const cle = el.innerHTML.trim().replace(/\s+/g, ' ');
    const trad = t(cle);
    if (trad === cle) return false;
    el.innerHTML = trad;
    return true;
  }

  function traduireElement(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (!v) continue;
      const trad = t(v.trim());
      if (trad !== v.trim()) el.setAttribute(a, trad);
    }
  }

  /** Traduit un nœud et toute sa descendance (textes + attributs). */
  function traduire(racine) {
    if (!DICT || !racine) return;
    if (racine.nodeType === 3) {
      const s = tNoeud(racine.nodeValue);
      if (s !== null) racine.nodeValue = s;
      return;
    }
    if (racine.nodeType !== 1) return;
    if (IGNORE[racine.tagName]) return;
    traduireElement(racine);
    // Un paragraphe d'aide contient des <b> : ses textes seraient sinon
    // découpés en morceaux de phrase, intraduisibles proprement. Quand tout
    // l'intérieur d'un élément est du texte enrichi — aucun élément
    // interactif, donc aucun écouteur à perdre — il est traduit d'un bloc.
    if (traduireBloc(racine)) return;
    // Les textes sont parcourus à part : innerHTML serait réécrit à chaque
    // passage, ce qui casserait les écouteurs déjà posés sur les enfants.
    const it = document.createTreeWalker(racine, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return IGNORE[n.parentNode && n.parentNode.tagName]
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const textes = [];
    for (let n = it.nextNode(); n; n = it.nextNode()) textes.push(n);
    for (const n of textes) {
      const s = tNoeud(n.nodeValue);
      if (s !== null) n.nodeValue = s;
    }
    for (const el of racine.querySelectorAll('[title], [placeholder], [aria-label], [alt]')) {
      traduireElement(el);
    }
  }

  /** Change la langue : mémorisée, partagée, puis la page est rechargée. */
  function setLang(l) {
    if (!LANGUES[l] || l === lang) return;
    try { localStorage.setItem(CLE, l); } catch (e) { /* ignoré */ }
    if (DW.dnd && DW.dnd.shareLang) DW.dnd.shareLang(l);
    location.reload();
  }

  if (DICT) {
    const demarrer = () => {
      traduire(document.body);
      traduireElement(document.documentElement);
      const titre = document.querySelector('title');
      if (titre) traduire(titre);
      // Tout ce qui naît ensuite — menus, fenêtres, messages, pages réseau —
      // est traduit à son apparition : le reste du code ignore la traduction.
      new MutationObserver((lots) => {
        for (const lot of lots) {
          if (lot.type === 'attributes') {
            traduireElement(lot.target);
          } else {
            for (const n of lot.addedNodes) traduire(n);
          }
        }
      }).observe(document.body, {
        childList: true, subtree: true, characterData: false,
        attributes: true, attributeFilter: ATTRS,
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', demarrer);
    } else {
      demarrer();
    }
    try { document.documentElement.setAttribute('lang', lang); } catch (e) { /* ignoré */ }
  }

  DW.i18n = {
    get lang() { return lang; },
    langues: LANGUES,
    autre: () => (lang === 'fr' ? 'en' : 'fr'),
    t, traduire, setLang,
  };
  /** Raccourci pour les textes sans nœud DOM (dessin au canevas). */
  DW.t = t;
})();
