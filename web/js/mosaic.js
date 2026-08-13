/* Diagweb — mosaïque : placement et dimensionnement LIBRES des tuiles.
 *
 * Une « tuile » est une carte de l'espace de travail : un tableau numérique ou
 * un graphique. Elle occupe un rectangle de la grille, décrit par quatre
 * entiers — `x` (colonne), `y` (rangée), `w` (largeur en colonnes), `h`
 * (hauteur en rangées) — sur **12 colonnes** et des rangées de hauteur fixe.
 *
 * Pourquoi une grille explicite : la version précédente laissait la grille CSS
 * placer les cartes toute seule (`auto-fit`), avec une largeur exprimée en
 * « colonnes naturelles » dont le nombre changeait avec la fenêtre. On ne
 * pouvait donc que **ranger** les cartes les unes après les autres, jamais en
 * poser une à un endroit choisi, et la même carte n'avait pas la même largeur
 * d'un écran à l'autre. Ici, `x/y/w/h` disent exactement où va la tuile, et
 * douze colonnes fractionnaires font que la disposition se transpose telle
 * quelle d'un écran à l'autre.
 *
 * Deux règles de comportement, celles qu'on attend d'un tableau de bord :
 *   1. **poussée** — une tuile posée sur une autre la repousse vers le bas,
 *      jamais sur le côté (le côté ferait valser toute la ligne) ;
 *   2. **gravité** — les tuiles remontent tant qu'il y a de la place au-dessus,
 *      donc pas de trou involontaire après un déplacement ou une suppression.
 *
 * Sous 700 px (téléphone), la mosaïque s'efface : la grille repasse à une
 * colonne et les tuiles s'empilent dans l'ordre (y, x). Le modèle, lui, est
 * conservé — la disposition d'un poste de travail se retrouve intacte au
 * retour sur grand écran.
 */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  const COLS = 12;          // largeur de la mosaïque, en colonnes
  const ROW_H = 30;         // hauteur d'une rangée (px) — doit suivre le CSS
  const GAP = 12;           // gouttière (px) — idem
  const MIN_W = 2, MIN_H = 3, MAX_H = 60;

  /** Taille de départ d'une tuile neuve, par nature. */
  const DEFAUTS = {
    chart: { w: 6, h: 9 },   // deux graphiques par rangée sur un grand écran
    table: { w: 12, h: 7 },  // un tableau prend toute la largeur par défaut
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const kindOf = (t) => (t && t.entries ? 'table' : 'chart');

  /** La mosaïque est-elle active ? (désactivée sur téléphone) */
  function actif() {
    try { return window.matchMedia('(min-width: 700px)').matches; }
    catch (e) { return true; }
  }

  /** Deux rectangles se chevauchent-ils ? */
  function hit(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w &&
           a.y < b.y + b.h && b.y < a.y + a.h;
  }

  /** Ramène une tuile dans les bornes de la mosaïque. */
  function borner(t) {
    const d = DEFAUTS[kindOf(t)];
    t.w = clamp(Math.round(Number(t.w) || d.w), MIN_W, COLS);
    t.h = clamp(Math.round(Number(t.h) || d.h), MIN_H, MAX_H);
    t.x = clamp(Math.round(Number(t.x) || 0), 0, COLS - t.w);
    t.y = Math.max(0, Math.round(Number(t.y) || 0));
    return t;
  }

  /**
   * Écarte les chevauchements en poussant vers le BAS. `tenue` est la tuile
   * que l'utilisateur a sous la main : elle ne bouge jamais, ce sont les
   * autres qui lui font place — sans quoi la tuile fuirait le curseur.
   */
  function ecarter(tuiles, tenue) {
    for (let passe = 0; passe < 200; passe++) {
      const ordre = [...tuiles].sort((a, b) => a.y - b.y || a.x - b.x);
      let bouge = false;
      for (let i = 0; i < ordre.length; i++) {
        for (let j = i + 1; j < ordre.length; j++) {
          const a = ordre[i], b = ordre[j];
          if (!hit(a, b)) continue;
          const victime = (b === tenue) ? a : b;
          const autre = (victime === b) ? a : b;
          victime.y = autre.y + autre.h;
          bouge = true;
        }
      }
      if (!bouge) return;
    }
  }

  /** Gravité : chaque tuile remonte tant que la place est libre au-dessus. */
  function tasser(tuiles) {
    const ordre = [...tuiles].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const t of ordre) {
      while (t.y > 0) {
        const essai = { x: t.x, y: t.y - 1, w: t.w, h: t.h };
        if (ordre.some((o) => o !== t && hit(o, essai))) break;
        t.y--;
      }
    }
  }

  /** Bornes + poussée + gravité : l'état d'équilibre de la mosaïque. */
  function normaliser(tuiles, tenue) {
    for (const t of tuiles) borner(t);
    ecarter(tuiles, tenue || null);
    tasser(tuiles);
    return tuiles;
  }

  /** Première place libre pour une tuile de w×h (balayage haut → bas). */
  function placeLibre(tuiles, w, h) {
    for (let y = 0; y < 400; y++) {
      for (let x = 0; x <= COLS - w; x++) {
        const essai = { x, y, w, h };
        if (!tuiles.some((o) => hit(o, essai))) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  }

  /** Géométrie de la grille à l'écran : largeur de colonne, hauteur de rangée. */
  function metrique(grid) {
    const rect = grid.getBoundingClientRect();
    const cs = getComputedStyle(grid);
    const gap = parseFloat(cs.columnGap) || GAP;
    const gapY = parseFloat(cs.rowGap) || GAP;
    const rowH = parseFloat(cs.gridAutoRows) || ROW_H;
    return { rect, gap, gapY, rowH, colW: (rect.width - gap * (COLS - 1)) / COLS };
  }

  /**
   * Cellule visée par un point de l'écran. `arrondi` vaut 'proche' pendant un
   * déplacement (la tuile se cale sur la cellule la plus proche) et 'bas'
   * pendant un redimensionnement (on ne veut pas que le bord recule d'une
   * cellule dès qu'on repasse le milieu).
   */
  function cellule(grid, cx, cy, arrondi) {
    const m = metrique(grid);
    const f = arrondi === 'bas' ? Math.floor : Math.round;
    return {
      x: clamp(f((cx - m.rect.left) / (m.colW + m.gap)), 0, COLS - 1),
      y: Math.max(0, f((cy - m.rect.top) / (m.rowH + m.gapY))),
    };
  }

  /** Applique la géométrie d'une tuile à sa carte (variables CSS). */
  function poser(t) {
    const el = t.cardEl;
    if (!el) return;
    el.style.setProperty('--tx', String(t.x + 1));
    el.style.setProperty('--ty', String(t.y + 1));
    el.style.setProperty('--tw', String(t.w));
    el.style.setProperty('--th', String(t.h));
  }

  /**
   * Ordre du DOM aligné sur (y, x) : c'est lui qui donne l'empilement sur
   * téléphone et l'ordre de tabulation. **Seuls les nœuds mal placés bougent** :
   * réinsérer une carte déjà bien placée annulerait la capture du pointeur en
   * cours (le redimensionnement décrochait à la première cellule franchie) et
   * ferait clignoter les canevas.
   */
  function rangerDom(grid, tuiles) {
    const ordre = [...tuiles].sort((a, b) => a.y - b.y || a.x - b.x)
      .map((t) => t.cardEl).filter((el) => el && el.parentElement === grid);
    let apres = null;
    for (let i = ordre.length - 1; i >= 0; i--) {
      const el = ordre[i];
      if (el.nextElementSibling !== apres) grid.insertBefore(el, apres);
      apres = el;
    }
  }

  /**
   * Range la mosaïque et l'applique à l'écran.
   * `opts.dom === false` pendant un geste : seules les variables CSS changent,
   * l'ordre du DOM est resynchronisé à la fin.
   */
  function agencer(grid, tuiles, tenue, opts) {
    if (!grid) return tuiles;
    normaliser(tuiles, tenue);
    for (const t of tuiles) poser(t);
    if (!opts || opts.dom !== false) rangerDom(grid, tuiles);
    return tuiles;
  }

  // ------------------------------------------------------------- fantôme
  /**
   * Rectangle d'atterrissage montré pendant un déplacement. Il vit DANS la
   * grille, placé comme une tuile : ce qu'on voit est exactement la place que
   * la tuile prendra — pas une approximation dessinée par-dessus.
   */
  let ghostEl = null;
  function fantome(grid, t) {
    if (!grid) return;
    if (!ghostEl) {
      ghostEl = document.createElement('div');
      ghostEl.className = 'tile-ghost';
      ghostEl.setAttribute('aria-hidden', 'true');
    }
    ghostEl.style.setProperty('--tx', String(t.x + 1));
    ghostEl.style.setProperty('--ty', String(t.y + 1));
    ghostEl.style.setProperty('--tw', String(t.w));
    ghostEl.style.setProperty('--th', String(t.h));
    if (ghostEl.parentElement !== grid) grid.appendChild(ghostEl);
  }
  function fantomeOff() {
    if (ghostEl && ghostEl.parentElement) ghostEl.remove();
  }

  // -------------------------------------------------- poignée ◢ (taille)
  /**
   * Poignée bas-droite : largeur ET hauteur, par cellules entières. Le
   * réagencement est appliqué à chaque cellule franchie — on voit la place
   * que les voisines cèdent pendant qu'on tire, pas seulement à la fin.
   *
   * @param tuile   objet portant x/y/w/h et cardEl
   * @param ctx     {grid(), tiles(), onChange(), onLive()}
   */
  function poigneeTaille(tuile, ctx) {
    const grip = tuile.cardEl && tuile.cardEl.querySelector('.resize-grip');
    if (!grip) return;
    let g = null;

    grip.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || !actif()) return;
      const grid = ctx.grid();
      if (!grid) return;
      g = { id: e.pointerId, x: e.clientX, y: e.clientY,
            w: tuile.w, h: tuile.h, m: metrique(grid) };
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* facultatif */ }
      tuile.cardEl.classList.add('resizing');
      e.preventDefault();
      e.stopPropagation();
    });

    grip.addEventListener('pointermove', (e) => {
      if (!g || e.pointerId !== g.id) return;
      const dw = Math.round((e.clientX - g.x) / (g.m.colW + g.m.gap));
      const dh = Math.round((e.clientY - g.y) / (g.m.rowH + g.m.gapY));
      const w = clamp(g.w + dw, MIN_W, COLS - tuile.x);
      const h = clamp(g.h + dh, MIN_H, MAX_H);
      if (w === tuile.w && h === tuile.h) return;
      tuile.w = w; tuile.h = h;
      // dom:false — l'ordre du DOM est figé le temps du geste, sinon la carte
      // serait réinsérée sous la main et la capture du pointeur perdue.
      agencer(ctx.grid(), ctx.tiles(), tuile, { dom: false });
      if (ctx.onLive) ctx.onLive();
      e.preventDefault();
    });

    const fin = (e) => {
      if (!g || (e && e.pointerId !== g.id)) return;
      g = null;
      tuile.cardEl.classList.remove('resizing');
      agencer(ctx.grid(), ctx.tiles(), tuile);   // remise en ordre du DOM
      if (ctx.onChange) ctx.onChange();
    };
    grip.addEventListener('pointerup', fin);
    grip.addEventListener('pointercancel', fin);

    // Double-clic : retour à la taille de départ de cette nature de tuile.
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const d = DEFAUTS[kindOf(tuile)];
      tuile.w = d.w; tuile.h = d.h;
      agencer(ctx.grid(), ctx.tiles(), tuile);
      if (ctx.onLive) ctx.onLive();
      if (ctx.onChange) ctx.onChange();
    });
  }

  DW.mosaic = {
    COLS, ROW_H, GAP, MIN_W, MIN_H, MAX_H, DEFAUTS,
    actif, hit, borner, normaliser, tasser, placeLibre,
    metrique, cellule, poser, agencer, rangerDom, fantome, fantomeOff, poigneeTaille,
    defaut(kind) { return Object.assign({}, DEFAUTS[kind] || DEFAUTS.chart); },
  };
})();
