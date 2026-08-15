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

    // Capture d'interfaces : privilège manquant. Le motif lui-même vient du
    // serveur et reste dans sa langue ; l'étiquette qui le porte, elle, se
    // traduit — c'est elle qui dit d'un coup d'œil que rien ne sera capturé.
    'Capture impossible en l’état :': 'Capture cannot run as things stand:',
    'Ouvrir une interface en capture demande la capacité CAP_NET_RAW. Elle manque ici ; le message dit à qui la donner et comment.':
      'Opening an interface for capture requires the CAP_NET_RAW capability. It is missing here; the message says who needs it and how to grant it.',

    // Journal de données : tri du fichier téléchargé et colonnes.
    'Tri du fichier :': 'File sort order:',
    'Par horodatage': 'By timestamp',
    'Par variable': 'By variable',
    'Tri du fichier téléchargé': 'Downloaded file sort order',
    'Ordre des lignes du CSV téléchargé — chaque variable y porte son adresse et son nom':
      'Row order of the downloaded CSV — every variable carries its address and its name',
    'Une ligne par instant, une colonne par variable : les variables de même période partagent leurs lignes':
      'One row per instant, one column per variable: variables sharing a period share their rows',
    'Trier le fichier par horodatage': 'Sort the file by timestamp',
    'Une ligne par échantillon : les échantillons de chaque variable se suivent, en ordre chronologique':
      'One row per sample: each variable’s samples follow one another in chronological order',
    'Trier le fichier par variable': 'Sort the file by variable',
    'Télécharger le journal enregistré par le serveur, dans l’ordre choisi':
      'Download the log recorded by the server, in the chosen order',
    'Télécharger le journal en CSV (horodatages, adresse, nom, valeur), dans l’ordre choisi':
      'Download the log as CSV (timestamps, address, name, value), in the chosen order',
    'Télécharger le journal en JSON (horodatages, adresses, noms, valeurs)':
      'Download the log as JSON (timestamps, addresses, names, values)',

    // Aide : section « Journal de données ».
    'Journal de données (☰)': 'Data log (☰)',
    'Destination': 'Destination',
    'Tri du fichier': 'File sort order',
    'Colonnes': 'Columns',
    'Secondes entières': 'Whole seconds',
    '<b>Navigateur</b> : le journal s’accumule en mémoire de la page (100 000 lignes au plus) — à télécharger avant de la fermer. <b>Serveur</b> : le serveur de diagnostic enregistre sur son disque et continue page fermée ; le CSV se télécharge à tout moment.':
      '<b>Browser</b>: the log accumulates in the page’s memory (100,000 rows at most) — download it before closing. <b>Server</b>: the diagnostic server records to its own disk and keeps going with the page closed; the CSV can be downloaded at any time.',
    '<b>Par horodatage</b> (défaut) : une ligne par instant, une colonne par variable — les variables de même période, échantillonnées aux mêmes instants, partagent leurs lignes. <b>Par variable</b> : une ligne par échantillon, les échantillons de chaque variable à la suite, en ordre chronologique.':
      '<b>By timestamp</b> (default): one row per instant, one column per variable — variables sharing a period, sampled at the same instants, share their rows. <b>By variable</b>: one row per sample, each variable’s samples one after another, in chronological order.',
    'Chaque variable est identifiée par son <b>adresse et son nom</b> (le nom d’affichage, sinon le libellé du catalogue). Quand un point porte un horodatage de l’équipement, le fichier montre <b>les deux dates</b> : celle retenue pour la chronologie et celle que l’équipement affirme.':
      'Every variable is identified by its <b>address and its name</b> (the display name, else the catalogue label). When a point carries an equipment timestamp, the file shows <b>both dates</b>: the one kept for the timeline and the one the equipment claims.',
    'Les variables sans horodatage à la source sont échantillonnées sur la <b>grille de leur période</b> — des secondes entières quand la période divise la seconde. Deux variables de même période tombent ainsi sur la <b>même ligne</b> du fichier trié par horodatage, au lieu de s’écrire en quinconce.':
      'Variables with no source timestamp are sampled on the <b>grid of their period</b> — whole seconds whenever the period divides the second. Two variables sharing a period thus land on the <b>same row</b> of the timestamp-sorted file, instead of interleaving.',
  };
})();
