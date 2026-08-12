// Généré par tools/gen-protocols.mjs — ne pas modifier à la main.
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
  { "modbus-tcp", "Modbus TCP", "TCP/IP",
    "live", "Lecture cyclique de registres et de bits sur un équipement Modbus TCP. Les registres consécutifs sont regroupés en une seule requête.",
    {
    { "host", "Hôte", "text", "", true, "Adresse IP ou nom réseau de l’équipement.", "" },
    { "port", "Port", "int", "502", false, "Port TCP du serveur Modbus (502 par défaut).", "" },
    { "unitId", "Identifiant d’unité", "int", "1", false, "Identifiant d’esclave (unit id) placé dans l’en-tête MBAP — 1 par défaut, 255 si l’équipement l’ignore.", "" },
    { "timeoutMs", "Délai d’attente (ms)", "int", "1000", false, "Temps maximal d’attente d’une réponse avant de signaler le lien en défaut.", "" },
    { "groupMax", "Regroupement (registres)", "int", "32", false, "Nombre maximal de registres lus en une requête ; 1 pour interroger chaque point séparément.", "" },
    },
    {
    { "fn", "Fonction de lecture", "enum", "3", true, "Fonction Modbus utilisée : bobines (01), entrées TOR (02), registres de maintien (03), registres d’entrée (04).", "1|2|3|4" },
    { "reg", "Adresse", "int", "0", true, "Adresse protocole du registre ou du bit, à partir de 0 (le registre « 40001 » d’une documentation correspond en général à l’adresse 0 de la fonction 03).", "" },
    { "type", "Type de donnée", "enum", "uint16", true, "Décodage de la donnée. Les types 32 bits occupent deux registres consécutifs.", "bool|int16|uint16|int32|uint32|float32|float64" },
    { "wordOrder", "Ordre des mots", "enum", "big", false, "Pour les types sur plusieurs registres : mot de poids fort d’abord (usuel) ou de poids faible d’abord.", "big|little" },
    { "bit", "Bit extrait", "int", "-1", false, "Rang du bit à extraire du registre (0 à 15) ; −1 pour utiliser la valeur entière.", "" },
    { "gain", "Gain", "float", "1", false, "Facteur appliqué à la valeur brute : valeur = brut × gain + décalage.", "" },
    { "offset", "Décalage", "float", "0", false, "Constante ajoutée après le gain (unité physique).", "" },
    } },
  { "modbus-rtu", "Modbus RTU (série)", "Liaison série",
    "live", "Même adressage que Modbus TCP, sur une liaison série RS-485/RS-232 (trame RTU avec contrôle CRC-16).",
    {
    { "device", "Port série", "text", "/dev/ttyS0", true, "Fichier de périphérique de la liaison série du contrôleur.", "" },
    { "baud", "Débit", "enum", "19200", false, "Débit en bauds, identique à celui de l’équipement.", "1200|2400|4800|9600|19200|38400|57600|115200" },
    { "parity", "Parité", "enum", "even", false, "Parité de la liaison — « paire » est l’usage courant en Modbus RTU.", "none|even|odd" },
    { "stopBits", "Bits de stop", "enum", "0", false, "Automatique applique la règle de la spécification série : 1 bit avec parité, 2 bits sans parité. Ne forcer que si l’équipement l’exige.", "0|1|2" },
    { "unitId", "Adresse esclave", "int", "1", true, "Adresse de l’esclave sur le bus (1 à 247).", "" },
    { "timeoutMs", "Délai d’attente (ms)", "int", "1000", false, "Temps maximal d’attente d’une réponse.", "" },
    { "groupMax", "Regroupement (registres)", "int", "32", false, "Nombre maximal de registres lus en une requête.", "" },
    },
    {
    { "fn", "Fonction de lecture", "enum", "3", true, "Fonction Modbus utilisée : bobines (01), entrées TOR (02), registres de maintien (03), registres d’entrée (04).", "1|2|3|4" },
    { "reg", "Adresse", "int", "0", true, "Adresse protocole du registre ou du bit, à partir de 0 (le registre « 40001 » d’une documentation correspond en général à l’adresse 0 de la fonction 03).", "" },
    { "type", "Type de donnée", "enum", "uint16", true, "Décodage de la donnée. Les types 32 bits occupent deux registres consécutifs.", "bool|int16|uint16|int32|uint32|float32|float64" },
    { "wordOrder", "Ordre des mots", "enum", "big", false, "Pour les types sur plusieurs registres : mot de poids fort d’abord (usuel) ou de poids faible d’abord.", "big|little" },
    { "bit", "Bit extrait", "int", "-1", false, "Rang du bit à extraire du registre (0 à 15) ; −1 pour utiliser la valeur entière.", "" },
    { "gain", "Gain", "float", "1", false, "Facteur appliqué à la valeur brute : valeur = brut × gain + décalage.", "" },
    { "offset", "Décalage", "float", "0", false, "Constante ajoutée après le gain (unité physique).", "" },
    } },
  { "iec104", "IEC 60870-5-104", "TCP/IP",
    "live", "Client (maître) télécontrôle : le serveur de diagnostic se connecte, lance une interrogation générale puis reçoit les données spontanées.",
    {
    { "host", "Hôte", "text", "", true, "Adresse IP ou nom réseau de la station contrôlée.", "" },
    { "port", "Port", "int", "2404", false, "Port TCP (2404 par défaut).", "" },
    { "asdu", "Adresse commune d’ASDU", "int", "1", true, "Adresse commune de l’équipement (souvent 1) — les objets reçus avec une autre adresse sont ignorés.", "" },
    { "originator", "Adresse d’origine", "int", "0", false, "Adresse de l’émetteur placée dans la cause de transmission (0 si inutilisée).", "" },
    { "gi", "Interrogation générale", "bool", "true", false, "Demander l’état complet à la connexion (C_IC_NA_1), pour partir de valeurs connues.", "" },
    { "giPeriodS", "Interrogation périodique (s)", "int", "0", false, "Répéter l’interrogation générale à cet intervalle ; 0 = seulement à la connexion.", "" },
    { "k", "Fenêtre k", "int", "12", false, "Nombre maximal de trames I non acquittées (paramètre k de la norme).", "" },
    { "w", "Fenêtre w", "int", "8", false, "Acquitter après w trames reçues (paramètre w de la norme).", "" },
    { "t1", "Délai t1 (s)", "int", "15", false, "Délai d’attente d’un acquittement avant coupure.", "" },
    { "t2", "Délai t2 (s)", "int", "10", false, "Délai avant envoi d’un acquittement de supervision.", "" },
    { "t3", "Délai t3 (s)", "int", "20", false, "Délai d’inactivité avant envoi d’un test de liaison.", "" },
    },
    {
    { "ioa", "Adresse d’objet (IOA)", "int", "0", true, "Adresse d’objet d’information sur 3 octets (1 à 16777215).", "" },
    { "type", "Type attendu", "enum", "auto", false, "Type d’ASDU attendu. « Automatique » accepte tout type reçu pour cette adresse.", "auto|single|double|normalized|scaled|float|counter|step" },
    { "gain", "Gain", "float", "1", false, "Facteur appliqué à la valeur brute : valeur = brut × gain + décalage.", "" },
    { "offset", "Décalage", "float", "0", false, "Constante ajoutée après le gain (unité physique).", "" },
    } },
  { "iec61850", "IEC 61850 (MMS)", "TCP/IP (ISO sur TCP, port 102)",
    "declared", "Client MMS d’un IED. La configuration et les points se saisissent dès maintenant ; la lecture effective demande la pile ISO/MMS, prévue en phase ultérieure (voir docs/PROTOCOLES.md).",
    {
    { "host", "Hôte", "text", "", true, "Adresse IP ou nom réseau de l’IED.", "" },
    { "port", "Port", "int", "102", false, "Port TCP de la pile ISO (102 par défaut).", "" },
    { "iedName", "Nom d’IED", "text", "", false, "Nom logique de l’IED, utilisé en tête des références d’objet.", "" },
    { "mode", "Mode de lecture", "enum", "poll", false, "Interrogation cyclique (MMS Read) ou abonnement aux rapports de l’IED.", "poll|report" },
    { "dataset", "Jeu de données", "text", "", false, "Référence du jeu de données à rapporter (mode rapports).", "" },
    },
    {
    { "ref", "Référence d’objet", "text", "", true, "Référence complète de l’attribut, par exemple LD0/MMXU1.A.phsA.cVal.mag.f.", "" },
    { "fc", "Contrainte fonctionnelle", "enum", "MX", false, "Contrainte fonctionnelle de l’attribut : mesures (MX), état (ST), consigne (SP), réglage (SE), configuration (CF).", "MX|ST|SP|SE|CF" },
    { "gain", "Gain", "float", "1", false, "Facteur appliqué à la valeur brute : valeur = brut × gain + décalage.", "" },
    { "offset", "Décalage", "float", "0", false, "Constante ajoutée après le gain (unité physique).", "" },
    } },
  { "can-raw", "Bus CAN (trames brutes)", "SocketCAN (Linux)",
    "live", "Écoute strictement passive d’une interface CAN du contrôleur : un point est un champ de bits extrait d’un identifiant de trame donné. Le serveur n’émet jamais sur le bus dans ce mode.",
    {
    { "iface", "Interface", "text", "can0", true, "Nom de l’interface CAN du système (can0, can1, vcan0…). Elle doit être déjà configurée et active : le débit du bus relève de l’administration du contrôleur, pas de Diagweb.", "" },
    { "fd", "CAN FD", "bool", "false", false, "Accepter les trames CAN FD (jusqu’à 64 octets de données).", "" },
    },
    {
    { "canId", "Identifiant", "hex", "0x100", true, "Identifiant CAN de la trame portant le signal, en hexadécimal (ex. 0x18FEF100).", "" },
    { "ext", "Identifiant 29 bits", "bool", "false", false, "Trame à identifiant étendu (29 bits) plutôt que standard (11 bits).", "" },
    { "startBit", "Bit de départ", "int", "0", true, "Position du premier bit du signal dans la trame (0 = bit de poids faible du premier octet).", "" },
    { "bitLen", "Longueur (bits)", "int", "16", true, "Nombre de bits occupés par le signal (1 à 64).", "" },
    { "order", "Ordre des octets", "enum", "intel", false, "Intel = petit-boutiste (poids faible d’abord), Motorola = gros-boutiste — comme dans une base de signaux CAN.", "intel|motorola" },
    { "signed", "Signé", "bool", "false", false, "Interpréter la valeur brute en complément à deux (valeurs négatives possibles).", "" },
    { "gain", "Gain", "float", "1", false, "Facteur appliqué à la valeur brute : valeur = brut × gain + décalage.", "" },
    { "offset", "Décalage", "float", "0", false, "Constante ajoutée après le gain (unité physique).", "" },
    } },
  { "j1939", "J1939 (CAN, PGN mono-trame)", "SocketCAN (Linux)",
    "live", "Décodage J1939 au-dessus de CAN : l’identifiant 29 bits est découpé en priorité, PGN et adresse source ; un point est un SPN extrait du PGN. Limite importante : seuls les PGN tenant dans une trame (8 octets) sont lus — le transport multi-trames (BAM, RTS/CTS) n’est pas implémenté, donc un PGN long comme DM1 ne remontera jamais de valeur.",
    {
    { "iface", "Interface", "text", "can0", true, "Nom de l’interface CAN du système.", "" },
    { "sa", "Adresse source filtrée", "int", "-1", false, "N’accepter que les trames émises par cette adresse source (0 à 253) ; −1 pour toutes.", "" },
    },
    {
    { "pgn", "PGN", "int", "61444", true, "Numéro de groupe de paramètres, en décimal (ex. 61444 = régime moteur, EEC1). Doit tenir dans une seule trame : les PGN multi-trames ne sont pas décodés.", "" },
    { "sa", "Adresse source", "int", "-1", false, "Adresse source attendue pour ce point ; −1 pour accepter n’importe laquelle.", "" },
    { "startBit", "Bit de départ", "int", "0", true, "Position du premier bit du signal dans la trame (0 = bit de poids faible du premier octet).", "" },
    { "bitLen", "Longueur (bits)", "int", "16", true, "Nombre de bits occupés par le signal (1 à 64).", "" },
    { "order", "Ordre des octets", "enum", "intel", false, "Intel = petit-boutiste (poids faible d’abord), Motorola = gros-boutiste — comme dans une base de signaux CAN.", "intel|motorola" },
    { "signed", "Signé", "bool", "false", false, "Interpréter la valeur brute en complément à deux (valeurs négatives possibles).", "" },
    { "gain", "Gain", "float", "1", false, "Facteur appliqué à la valeur brute : valeur = brut × gain + décalage.", "" },
    { "offset", "Décalage", "float", "0", false, "Constante ajoutée après le gain (unité physique).", "" },
    } },
  { "canopen", "CANopen", "SocketCAN (Linux)",
    "live", "Deux modes : écoute des TPDO déjà émis par le nœud (sans rien demander), ou lecture à la demande d’une entrée du dictionnaire d’objets par SDO — ce second mode est le seul où le serveur émet sur le bus. À savoir : un nœud qui n’est pas en état opérationnel n’émet aucun TPDO ; le lien paraîtra alors établi sans qu’aucune valeur ne remonte.",
    {
    { "iface", "Interface", "text", "can0", true, "Nom de l’interface CAN du système.", "" },
    { "nodeId", "Identifiant de nœud", "int", "1", true, "Node-id du nœud CANopen (1 à 127) — il fixe les COB-ID des SDO et des PDO.", "" },
    { "listenOnly", "Écoute seule", "bool", "true", false, "N’émettre aucune requête SDO : seuls les TPDO déjà émis par le nœud sont lus. Recommandé — interroger un nœud absent fait réémettre le contrôleur CAN jusqu’au bus-off, ce qui dégrade l’interface elle-même. Décocher active la lecture SDO.", "" },
    },
    {
    { "mode", "Mode", "enum", "tpdo", true, "TPDO = écoute passive d’une trame déjà émise. SDO = interrogation d’une entrée du dictionnaire d’objets.", "tpdo|sdo" },
    { "cobId", "COB-ID du TPDO", "hex", "0x181", false, "Identifiant de la trame TPDO à écouter (0x180 + node-id pour le TPDO1, etc.).", "" },
    { "index", "Index", "hex", "0x6041", false, "Index de l’objet dans le dictionnaire (ex. 0x6041 = mot d’état).", "" },
    { "subIndex", "Sous-index", "int", "0", false, "Sous-index de l’objet (0 quand l’objet n’est pas structuré).", "" },
    { "type", "Type de donnée", "enum", "u16", false, "Type de l’objet lu par SDO.", "u8|i8|u16|i16|u32|i32|f32" },
    { "startBit", "Bit de départ", "int", "0", true, "Position du premier bit du signal dans la trame (0 = bit de poids faible du premier octet).", "" },
    { "bitLen", "Longueur (bits)", "int", "16", true, "Nombre de bits occupés par le signal (1 à 64).", "" },
    { "order", "Ordre des octets", "enum", "intel", false, "Intel = petit-boutiste (poids faible d’abord), Motorola = gros-boutiste — comme dans une base de signaux CAN.", "intel|motorola" },
    { "signed", "Signé", "bool", "false", false, "Interpréter la valeur brute en complément à deux (valeurs négatives possibles).", "" },
    { "gain", "Gain", "float", "1", false, "Facteur appliqué à la valeur brute : valeur = brut × gain + décalage.", "" },
    { "offset", "Décalage", "float", "0", false, "Constante ajoutée après le gain (unité physique).", "" },
    } },
  { "snmp", "SNMP", "UDP (port 161)",
    "live", "Gestionnaire SNMP en lecture seule : interrogation cyclique d’OID par GetRequest. v1 et v2c sont implémentées ; v3 (USM) se configure mais n’est pas encore lue — un lien en v3 s’annonce « non branché » plutôt que de retomber en silence sur une version non chiffrée. Aucune écriture (SetRequest) n’est possible.",
    {
    { "host", "Hôte", "text", "", true, "Adresse IP ou nom réseau de l’agent SNMP.", "" },
    { "port", "Port", "int", "161", false, "Port UDP de l’agent (161 par défaut).", "" },
    { "version", "Version", "enum", "v2c", true, "v1 : la plus ancienne, sans Counter64 ni exception par variable. v2c : le choix courant, communauté en clair. v3 : sécurisée (authentification et chiffrement) — configurable, lecture pas encore implémentée.", "v1|v2c|v3" },
    { "community", "Communauté", "text", "public", false, "Communauté de lecture, transmise EN CLAIR sur le réseau par v1 et v2c : ne pas y mettre un secret qui compte, et préférer v3 sur un réseau exposé.", "" },
    { "user", "Utilisateur (USM)", "text", "", false, "Nom d’utilisateur du modèle de sécurité USM.", "" },
    { "level", "Niveau de sécurité", "enum", "authPriv", false, "noAuthNoPriv : ni authentification ni chiffrement. authNoPriv : authentifié. authPriv : authentifié et chiffré.", "noAuthNoPriv|authNoPriv|authPriv" },
    { "authProto", "Algorithme d’authentification", "enum", "SHA", false, "Fonction de hachage du condensé d’authentification.", "MD5|SHA|SHA256" },
    { "privProto", "Algorithme de chiffrement", "enum", "AES", false, "Chiffrement de la charge utile.", "DES|AES" },
    { "secretRef", "Référence des secrets", "text", "", false, "Nom sous lequel les phrases secrètes d’authentification et de chiffrement sont rangées dans le magasin de secrets du contrôleur — une désignation, jamais le secret lui-même : cette configuration s’exporte en clair.", "" },
    { "timeoutMs", "Délai d’attente (ms)", "int", "1500", false, "Temps maximal d’attente d’une réponse. UDP perd des datagrammes sans le dire : le lien n’est déclaré en défaut qu’après trois délais consécutifs.", "" },
    { "maxVars", "Groupement (variables)", "int", "16", false, "Nombre maximal d’OID demandés dans une même requête ; 1 pour les interroger séparément. Trop élevé, l’agent répond « tooBig ».", "" },
    },
    {
    { "oid", "OID", "text", "1.3.6.1.2.1.1.3.0", true, "Identifiant d’objet en notation pointée. Un scalaire se termine par « .0 » (ex. 1.3.6.1.2.1.1.3.0 = temps depuis le démarrage) ; une entrée de table porte son index (ex. 1.3.6.1.2.1.2.2.1.10.2 = octets reçus sur l’interface 2).", "" },
    { "gain", "Gain", "float", "1", false, "Facteur appliqué à la valeur brute : valeur = brut × gain + décalage.", "" },
    { "offset", "Décalage", "float", "0", false, "Constante ajoutée après le gain (unité physique).", "" },
    } },
  { "opcua", "OPC UA (IEC 62541)", "UA-TCP binaire (opc.tcp, port 4840)",
    "declared", "Client OPC UA d’un serveur de supervision ou d’un équipement : lecture de nœuds désignés par leur NodeId, par interrogation cyclique (Read) ou par abonnement (MonitoredItems). La configuration et les points se saisissent dès maintenant ; la lecture effective demande la pile UA (UA-TCP, SecureConversation, encodage binaire), prévue en phase ultérieure (voir docs/PROTOCOLES.md). Lecture seule définitive : ni Write ni Call ne seront implémentés.",
    {
    { "endpoint", "Point de terminaison", "text", "opc.tcp://192.168.0.10:4840", true, "URL du serveur OPC UA, forme opc.tcp://hôte:port/chemin. Le chemin est facultatif et dépend du serveur.", "" },
    { "securityPolicy", "Politique de sécurité", "enum", "None", false, "Politique annoncée par le serveur pour le canal sécurisé. « Aucune » ne convient qu’à un réseau de confiance ; les autres exigent un certificat client.", "None|Basic256Sha256|Aes128Sha256RsaOaep|Aes256Sha256RsaPss" },
    { "securityMode", "Mode de sécurité", "enum", "None", false, "Aucun (en clair), signature seule, ou signature et chiffrement du canal.", "None|Sign|SignAndEncrypt" },
    { "auth", "Authentification", "enum", "anonymous", false, "Jeton d’identité présenté à l’ouverture de session.", "anonymous|username|certificate" },
    { "username", "Nom d’utilisateur", "text", "", false, "Identifiant de session. Le mot de passe n’est JAMAIS enregistré ici : la configuration des liens est lisible par tout poste connecté et s’exporte en clair. Le secret est repris du magasin de secrets du contrôleur.", "" },
    { "secretRef", "Référence du secret", "text", "", false, "Nom sous lequel le mot de passe ou la clé privée du certificat est rangé dans le magasin de secrets du contrôleur — une désignation, jamais le secret lui-même.", "" },
    { "mode", "Mode de lecture", "enum", "subscribe", false, "Abonnement = le serveur OPC UA notifie les changements (économe, recommandé). Interrogation cyclique = service Read répété, utile face à un serveur qui refuse les abonnements.", "subscribe|poll" },
    { "publishMs", "Intervalle de publication (ms)", "int", "500", false, "Cadence à laquelle le serveur OPC UA regroupe et renvoie les changements.", "" },
    { "sessionTimeoutS", "Expiration de session (s)", "int", "60", false, "Durée au-delà de laquelle le serveur ferme une session restée sans échange.", "" },
    },
    {
    { "nodeId", "NodeId", "text", "ns=2;s=", true, "Identifiant du nœud à lire, forme ns=<espace>;<type>=<valeur> — par exemple ns=2;s=Machine/Pression pour une chaîne, ns=2;i=1234 pour un entier.", "" },
    { "attr", "Attribut", "enum", "Value", false, "Attribut du nœud à lire. « Valeur » convient à toutes les variables ; les autres servent au diagnostic du serveur lui-même.", "Value|StatusCode|SourceTimestamp" },
    { "samplingMs", "Échantillonnage (ms)", "int", "200", false, "Cadence à laquelle le serveur OPC UA échantillonne le nœud, quand le lien est en mode abonnement ; 0 laisse le serveur choisir. Ne peut pas être plus rapide que la source de la donnée.", "" },
    { "deadband", "Bande morte (%)", "float", "0", false, "Variation minimale, en pourcentage de l’étendue, avant notification d’un changement (mode abonnement) ; 0 pour tout notifier.", "" },
    { "gain", "Gain", "float", "1", false, "Facteur appliqué à la valeur brute : valeur = brut × gain + décalage.", "" },
    { "offset", "Décalage", "float", "0", false, "Constante ajoutée après le gain (unité physique).", "" },
    } },
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
    o += "{\"id\":\"" + jesc(p.id) + "\",\"label\":\"" + jesc(p.label) +
         "\",\"transport\":\"" + jesc(p.transport) + "\",\"state\":\"" + jesc(p.state) +
         "\",\"help\":\"" + jesc(p.help) + "\"}";
  }
  return o + "]";
}

}  // namespace diagweb
