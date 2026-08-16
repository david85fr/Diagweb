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

    // Retour à la configuration d'origine (☰ → Tout remettre par défaut).
    // Les intitulés d'option sont traduits d'un bloc : l'interface prend pour
    // clé le contenu entier de l'élément quand il porte une mise en forme.
    '⟲ Tout remettre par défaut…': '⟲ Reset everything to defaults…',
    'Revenir à la configuration d’origine : effacer les onglets, les configurations enregistrées, la langue et l’apparence — et, sur la page servie par le contrôleur, ce qu’il détient (liens réseau, réglages de capture)':
      'Return to the factory configuration: clear tabs, saved configurations, language and appearance — and, on the page served by the controller, what it holds (network links, capture settings)',
    'Tout remettre par défaut': 'Reset everything to defaults',
    'Fermer sans rien effacer': 'Close without erasing anything',
    'Diagweb repart de son état d’origine : aucun onglet, aucune variable, aucun réglage mémorisé. <b>Rien ne se récupère ensuite</b> — si vous tenez à une disposition, téléchargez-la d’abord (☰ → Configurations → Télécharger).':
      'Diagweb returns to its original state: no tab, no variable, no stored setting. <b>Nothing can be recovered afterwards</b> — if a layout matters to you, download it first (☰ → Configurations → Download).',
    'Ce navigateur': 'This browser',
    'Le contrôleur — partagé par tous les postes': 'The controller — shared by every workstation',
    '<b>Onglets, configurations, langue et apparence</b><i>Tout ce que Diagweb a mémorisé dans ce navigateur. Les autres fenêtres ouvertes gardent leurs onglets jusqu’à leur prochain chargement.</i>':
      '<b>Tabs, configurations, language and appearance</b><i>Everything Diagweb has stored in this browser. Other open windows keep their tabs until they next load.</i>',
    '<b>Apparence — logo et couleurs</b><i>Le logo de l’exploitant et les couleurs reviennent à ceux du produit, pour tous les postes qui consultent ce contrôleur.</i>':
      '<b>Appearance — logo and colours</b><i>The operator logo and colours return to the product defaults, for every workstation looking at this controller.</i>',
    '<b>Liens réseau déclarés</b><i>Les équipements déclarés et leurs points (@lien.point) disparaissent : les variables qui les utilisent ne seront plus lisibles.</i>':
      '<b>Declared network links</b><i>Declared devices and their points (@link.point) disappear: variables using them can no longer be read.</i>',
    '<b>Configurations enregistrées sur le contrôleur</b><i>Les dispositions rangées dans le contrôleur, celles que retrouve n’importe quel poste, sont supprimées.</i>':
      '<b>Configurations stored on the controller</b><i>The layouts kept in the controller, the ones any workstation finds, are deleted.</i>',
    '<b>Réglages de capture réseau</b><i>Quota de disque et déclencheur reviennent à leurs valeurs d’origine. Les fichiers déjà capturés sont conservés.</i>':
      '<b>Network capture settings</b><i>Disk quota and trigger return to their default values. Files already captured are kept.</i>',
    'Ne sont touchés ni les forçages en cours, ni les fichiers déjà capturés, ni les journaux déjà enregistrés.':
      'Neither the forces in effect, nor the files already captured, nor the logs already recorded are touched.',
    'Effacer ce qui est coché ci-dessus, puis recharger la page':
      'Erase what is ticked above, then reload the page',
    'Annuler': 'Cancel',
    'Confirmer — c’est irréversible': 'Confirm — this cannot be undone',
    'Second appui : l’effacement a lieu et la page se recharge':
      'Second press: the erasure happens and the page reloads',
    'Second appui pour effacer. Tout autre bouton annule.':
      'Press again to erase. Any other button cancels.',
    'Rien n’est coché : il n’y a rien à effacer.': 'Nothing is ticked: there is nothing to erase.',

    // Aide (☰ → Aide), section « Tout remettre par défaut »
    'Tout remettre par défaut (☰)': 'Reset everything to defaults (☰)',
    'Le contrôleur': 'The controller',
    'Ce qui survit': 'What survives',
    'Prudence': 'Care',
    'Efface <b>tout</b> ce que Diagweb y a mémorisé : onglets et dispositions, configurations enregistrées, chargement automatique, langue, apparence locale, réglages simulés. La page se recharge sur l’état d’origine — l’onglet de démonstration, comme à la première ouverture. Les autres fenêtres ouvertes gardent leurs onglets jusqu’à leur prochain chargement.':
      'Erases <b>everything</b> Diagweb has stored there: tabs and layouts, saved configurations, auto-load, language, local appearance, simulated settings. The page reloads on the original state — the demonstration tab, as on first opening. Other open windows keep their tabs until they next load.',
    'Sur la page servie, quatre cases <b>séparées et décochées d’avance</b> : apparence partagée, liens réseau déclarés, configurations rangées dans le contrôleur, réglages de capture. Elles portent au-delà de ce poste — ce que voient tous les autres change aussi.':
      'On the served page, four <b>separate boxes, unticked by default</b>: shared appearance, declared network links, configurations kept in the controller, capture settings. They reach beyond this workstation — what everyone else sees changes too.',
    'Les forçages en cours, les fichiers déjà capturés et les journaux déjà enregistrés. Un forçage se relâche depuis la ligne de la variable, une capture se supprime depuis sa page.':
      'Forces in effect, files already captured and logs already recorded. A force is released from the variable row, a capture is deleted from its own page.',
    'Confirmation en deux temps, et <b>rien ne se récupère</b> ensuite : téléchargez d’abord ce que vous voulez garder (☰ → Configurations → Télécharger). Si le contrôleur refuse une des demandes, rien n’est effacé dans le navigateur et la fenêtre le dit.':
      'Two-step confirmation, and <b>nothing can be recovered</b> afterwards: download first whatever you want to keep (☰ → Configurations → Download). If the controller refuses one of the requests, nothing is erased in the browser and the window says so.',
  };
})();
