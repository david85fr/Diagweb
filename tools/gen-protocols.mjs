/* Diagweb — génère server/src/protocols.generated.hpp depuis web/js/protocols.js.
 *
 * La description des protocoles réseau (champs de configuration, libellés,
 * aides, valeurs par défaut) est écrite une seule fois, côté web. Le serveur
 * de diagnostic en dérive sa copie C++ : il l'expose telle quelle sur
 * /api/protocols, ce qui garantit qu'une page servie par le contrôleur
 * propose exactement les champs que le serveur sait lire.
 *
 *   node tools/gen-protocols.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// protocols.js est une IIFE qui peuple window.DW ; elle déclenche aussi un
// chargement de configuration (fetch / localStorage) qu'on neutralise ici.
globalThis.window = {};
globalThis.fetch = () => Promise.reject(new Error('hors navigateur'));
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const src = fs.readFileSync(path.join(ROOT, 'web/js/protocols.js'), 'utf8');
new Function(src)();
const { PROTOCOLS } = globalThis.window.DW;

const cstr = (s) => '"' + String(s)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n') + '"';

/** Un champ : clé, libellé, type, défaut, obligatoire, aide, choix. */
function field(f) {
  const choices = (f.choices || []).map(([v]) => String(v)).join('|');
  const def = f.def == null ? '' : String(f.def);
  return `    { ${cstr(f.key)}, ${cstr(f.label)}, ${cstr(f.type)}, ${cstr(def)}, ` +
         `${f.required ? 'true' : 'false'}, ${cstr(f.help)}, ${cstr(choices)} },`;
}

const blocks = PROTOCOLS.map((p) => `  { ${cstr(p.id)}, ${cstr(p.label)}, ${cstr(p.transport)},
    ${cstr(p.state)}, ${cstr(p.help)},
    {
${p.linkFields.map(field).join('\n')}
    },
    {
${p.pointFields.map(field).join('\n')}
    } },`).join('\n');

const out = `// Généré par tools/gen-protocols.mjs — ne pas modifier à la main.
// Source : web/js/protocols.js (description des protocoles réseau).
#pragma once

#include <string>
#include <vector>

#include "json.hpp"

namespace diagweb {

struct FieldDesc {
  const char* key;
  const char* label;
  const char* type;       // text | int | float | bool | enum | hex
  const char* def;
  bool required;
  const char* help;
  const char* choices;    // valeurs possibles d'un champ « enum », séparées par |
};

struct ProtocolDesc {
  const char* id;
  const char* label;
  const char* transport;
  const char* state;      // live = pilote implémenté, declared = configurable seulement
  const char* help;
  std::vector<FieldDesc> link_fields;
  std::vector<FieldDesc> point_fields;
};

inline const std::vector<ProtocolDesc>& protocols_desc() {
  static const std::vector<ProtocolDesc> all = {
${blocks}
  };
  return all;
}

/** Le protocole est-il connu du serveur (et son pilote implémenté) ? */
inline const ProtocolDesc* find_protocol(const std::string& id) {
  for (const auto& p : protocols_desc()) {
    if (id == p.id) return &p;
  }
  return nullptr;
}

/** Description des protocoles au format JSON, pour l'interface web. */
inline std::string protocols_descriptors_json() {
  std::string o = "[";
  bool first_p = true;
  for (const auto& p : protocols_desc()) {
    if (!first_p) o += ',';
    first_p = false;
    o += "{\\"id\\":\\"" + jesc(p.id) + "\\",\\"label\\":\\"" + jesc(p.label) +
         "\\",\\"transport\\":\\"" + jesc(p.transport) + "\\",\\"state\\":\\"" + jesc(p.state) +
         "\\",\\"help\\":\\"" + jesc(p.help) + "\\"}";
  }
  return o + "]";
}

}  // namespace diagweb
`;

const dest = path.join(ROOT, 'server/src/protocols.generated.hpp');
fs.writeFileSync(dest, out);
console.log(`${dest} : ${PROTOCOLS.length} protocoles, ` +
  `${PROTOCOLS.reduce((n, p) => n + p.linkFields.length + p.pointFields.length, 0)} champs`);
