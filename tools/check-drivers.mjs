/* Diagweb — vérifie qu'un protocole = un dossier de pilote.
 *
 * Règle d'organisation du dépôt : chaque protocole réseau décrit dans
 * web/js/protocols.js a son pilote dans son propre dossier sous
 * server/src/drivers/, et rien d'autre ne traîne à la racine des pilotes.
 * Sans contrôle automatique, la règle se perd au premier protocole ajouté
 * dans la précipitation ; ce script la tient.
 *
 * Contrôles :
 *   1. tout protocole déclaré a une entrée dans la table DOSSIERS ci-dessous
 *      (un protocole ajouté sans y penser fait échouer la CI, ce qui est le
 *      but : le choix du dossier doit être conscient) ;
 *   2. ce dossier existe et contient au moins un en-tête ;
 *   3. make_driver() dans protocol_source.hpp connaît l'identifiant ;
 *   4. aucun en-tête directement sous drivers/ — tout est dans un dossier ;
 *   5. aucun dossier orphelin : chaque dossier sert au moins un protocole,
 *      « common » (briques partagées) faisant seul exception.
 *
 *   node tools/check-drivers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIVERS = path.join(ROOT, 'server/src/drivers');

/**
 * Dossier du pilote de chaque protocole. Deux protocoles partagent un dossier
 * quand ils partagent leur couche applicative et ne diffèrent que par le
 * transport : Modbus TCP et Modbus RTU ont la même PDU et le même décodage.
 * À l'inverse, les trois protocoles CAN ont chacun le leur, car seul le
 * transport leur est commun (il vit dans common/can_socket.hpp).
 */
const DOSSIERS = {
  'modbus-tcp': 'modbus',
  'modbus-rtu': 'modbus',
  'iec104': 'iec104',
  'iec61850': 'iec61850',
  'can-raw': 'can',
  'j1939': 'j1939',
  'canopen': 'canopen',
  'opcua': 'opcua',
};

/** Dossiers qui ne servent aucun protocole en propre. */
const PARTAGES = new Set(['common']);

// protocols.js est une IIFE qui peuple window.DW ; elle déclenche aussi un
// chargement de configuration (fetch / localStorage) qu'on neutralise ici.
globalThis.window = {};
globalThis.fetch = () => Promise.reject(new Error('hors navigateur'));
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
new Function(fs.readFileSync(path.join(ROOT, 'web/js/protocols.js'), 'utf8'))();
const { PROTOCOLS } = globalThis.window.DW;

const source = fs.readFileSync(path.join(ROOT, 'server/src/protocol_source.hpp'), 'utf8');
const fabrique = source.slice(source.indexOf('make_driver'));

const fautes = [];
const utilises = new Set(PARTAGES);

for (const p of PROTOCOLS) {
  const dossier = DOSSIERS[p.id];
  if (!dossier) {
    fautes.push(`protocole « ${p.id} » absent de la table DOSSIERS de ce script — ` +
                `lui donner un dossier sous server/src/drivers/ et l'y déclarer`);
    continue;
  }
  utilises.add(dossier);

  const chemin = path.join(DRIVERS, dossier);
  if (!fs.existsSync(chemin) || !fs.statSync(chemin).isDirectory()) {
    fautes.push(`protocole « ${p.id} » : dossier server/src/drivers/${dossier}/ absent`);
  } else if (!fs.readdirSync(chemin).some((f) => f.endsWith('.hpp'))) {
    fautes.push(`server/src/drivers/${dossier}/ ne contient aucun en-tête`);
  }

  if (!fabrique.includes(`"${p.id}"`)) {
    fautes.push(`protocole « ${p.id} » inconnu de make_driver() dans protocol_source.hpp`);
  }
}

for (const e of fs.readdirSync(DRIVERS, { withFileTypes: true })) {
  if (e.isFile() && e.name.endsWith('.hpp')) {
    fautes.push(`server/src/drivers/${e.name} est à la racine : le déplacer dans ` +
                `le dossier de son protocole (ou dans common/ s'il est partagé)`);
  }
  if (e.isDirectory() && !utilises.has(e.name)) {
    fautes.push(`server/src/drivers/${e.name}/ ne sert aucun protocole déclaré`);
  }
}

if (fautes.length) {
  for (const f of fautes) console.error('  ✗ ' + f);
  console.error(`\n${fautes.length} anomalie(s) d'organisation des pilotes.`);
  process.exit(1);
}

const dossiers = [...utilises].filter((d) => !PARTAGES.has(d)).sort();
console.log(`Organisation des pilotes : ${PROTOCOLS.length} protocole(s), ` +
            `${dossiers.length} dossier(s) — ${dossiers.join(', ')}`);
