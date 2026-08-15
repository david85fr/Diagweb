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
    // Barre d'état : la nature des données. Assemblée par fragments dans
    // app.js, parce qu'une phrase portant un nombre ne peut pas être une clé.
    'Source': 'Source',
    'défaut': 'default',
    'Serveur de diagnostic': 'Diagnostic server',
    'Simulation locale': 'Local simulation',
    'variables internes du controller simulées':
      'controller internal variables simulated',
    'liens réseau réels': 'real network links',
    'liens réseau simulés': 'simulated network links',
    "D'où viennent les données et de quelle nature elles sont : les variables internes du controller peuvent être simulées pendant que les liens réseau acquièrent réellement. État détaillé de chaque lien : ☰ → Liens réseau.":
      'Where the data comes from and what kind it is: the controller internal variables may be simulated while the network links acquire for real. Per-link state: ☰ → Network links.',
  };
})();
