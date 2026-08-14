/* Diagweb — dictionnaire anglais de l'interface.
 *
 * La clé est le texte français affiché, à l'identique (voir js/i18n.js). Une
 * entrée absente laisse le français : l'interface reste utilisable pendant que
 * la traduction se complète. `node tools/check-i18n.mjs` mesure la couverture
 * en parcourant toutes les vues de l'application.
 */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});
  DW.DICTS = DW.DICTS || {};
  DW.DICTS.en = {
  };
})();
