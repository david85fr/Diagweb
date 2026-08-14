/* Diagweb — génère server/src/catalog.generated.hpp depuis web/js/config.js.
 *
 * Le catalogue de variables simulées est décrit une seule fois (côté web) ;
 * le serveur de diagnostic en dérive sa copie C++ pour que les deux sources
 * de données présentent exactement les mêmes variables.
 *
 *   node tools/gen-catalog.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// config.js est une IIFE qui peuple window.DW : on lui fournit un window.
globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.document = { documentElement: { getAttribute: () => null } };
const src = fs.readFileSync(path.join(ROOT, 'web/js/config.js'), 'utf8');
new Function(src)();
const { CATALOG, CONFIG } = globalThis.window.DW;

const cstr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const num = (v) => (Number.isInteger(v) ? v + '' : String(v));

/** Traduit un descripteur de générateur JS en appel de fabrique C++. */
function spec(sim, kind) {
  if (!sim) {
    // Hors catalogue : le serveur invente un signal, comme le simulateur web
    return kind === 'bit' ? 'bit(12, 12)' : 'sine(0, 10, 20, 0.3)';
  }
  switch (sim.type) {
    case 'sine':
      return `sine(${num(sim.base)}, ${num(sim.amp)}, ${num(sim.period)}, ${num(sim.noise || 0)})`;
    case 'walk':
      return `walk(${num(sim.base)}, ${num(sim.step)}, ${num(sim.min)}, ${num(sim.max)}, ${num(sim.drift || 0)})`;
    case 'steps':
      return `steps({${sim.values.map(num).join(', ')}}, ${num(sim.period)}, ${num(sim.noise || 0)})`;
    case 'square':
      return `square(${num(sim.period)}, ${num(sim.duty)})`;
    case 'bit':
      return `bitchain(${num(sim.t0)}, ${num(sim.t1)})`;
    case 'counter':
      return `counter(${num(sim.rate)})`;
    case 'jitter':
      return `jitter(${num(sim.base)}, ${num(sim.noise)}, ${num(sim.spikeP)}, ${num(sim.spikeAmp)})`;
    default:
      throw new Error('type de générateur inconnu : ' + sim.type);
  }
}

const KIND = { bit: 'Kind::Bit', word: 'Kind::Word', float: 'Kind::Float' };

const rows = CATALOG.map((e) =>
  `  { ${cstr(e.addr)}, ${cstr(e.label)}, ${cstr(e.unit || '')}, ${KIND[e.kind]}, ${spec(e.sim, e.kind)} },`
).join('\n');

const out = `// Généré par tools/gen-catalog.mjs — ne pas modifier à la main.
// Source : web/js/config.js (catalogue des variables simulées).
#pragma once

#include "sim_source.hpp"

namespace diagweb {

// Horizon d'historique et période par défaut, alignés sur le front-end.
inline constexpr double kHorizonS = ${CONFIG.horizonS};
inline constexpr int kDefaultPeriodMs = ${CONFIG.defaultPeriodMs};

inline const std::vector<CatalogEntry>& catalog() {
  static const std::vector<CatalogEntry> entries = {
${rows}
  };
  return entries;
}

}  // namespace diagweb
`;

const dest = path.join(ROOT, 'server/src/catalog.generated.hpp');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log(`${dest} : ${CATALOG.length} variables`);
