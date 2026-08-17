/* Diagweb — serveur OPC UA de test (open62541).
 *
 * Expose quelques variables de types différents, dont une qui bouge, pour que
 * tests/protocols.mjs vérifie la chaîne complète du pilote — connexion,
 * abonnement, interrogation cyclique, conversion des types — sans matériel.
 *
 *   ./diagweb-opcua-test-server [port]      (4840 par défaut)
 *
 * Cible CMake : diagweb-opcua-test-server (compilée uniquement si
 * DIAGWEB_WITH_OPCUA est actif).
 */
#include <open62541/server.h>
#include <open62541/server_config_default.h>
#include <open62541/plugin/log_stdout.h>

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static volatile UA_Boolean tourne = true;
static void arreter(int sig) { (void)sig; tourne = false; }

/* Ajoute une variable scalaire dans l'espace de noms 1, adressée par chaîne. */
static void ajouter(UA_Server *s, const char *nom, void *valeur, const UA_DataType *type) {
    UA_VariableAttributes attr = UA_VariableAttributes_default;
    UA_Variant_setScalar(&attr.value, valeur, type);
    attr.displayName = UA_LOCALIZEDTEXT("fr-FR", (char *)nom);
    attr.accessLevel = UA_ACCESSLEVELMASK_READ;
    attr.dataType = type->typeId;
    UA_Server_addVariableNode(
        s, UA_NODEID_STRING(1, (char *)nom),
        UA_NODEID_NUMERIC(0, UA_NS0ID_OBJECTSFOLDER),
        UA_NODEID_NUMERIC(0, UA_NS0ID_ORGANIZES),
        UA_QUALIFIEDNAME(1, (char *)nom), UA_NODEID_NUMERIC(0, UA_NS0ID_BASEDATAVARIABLETYPE),
        attr, NULL, NULL);
}

/* Fait varier la pression : sans changement, un abonnement ne notifie rien
 * après la valeur initiale, et le test ne prouverait pas grand-chose. */
static void battre(UA_Server *server, void *data) {
    (void)data;
    static UA_Double p = 2.5;
    p += 0.5;
    if (p > 6.0) p = 2.5;
    UA_Variant v;
    UA_Variant_setScalar(&v, &p, &UA_TYPES[UA_TYPES_DOUBLE]);
    UA_Server_writeValue(server, UA_NODEID_STRING(1, "pression"), v);
}

int main(int argc, char **argv) {
    signal(SIGINT, arreter);
    signal(SIGTERM, arreter);

    const int port = argc > 1 ? atoi(argv[1]) : 4840;
    UA_Server *server = UA_Server_new();
    UA_ServerConfig *config = UA_Server_getConfig(server);
    UA_ServerConfig_setMinimal(config, (UA_UInt16)port, NULL);

    /* Écoute confinée à la boucle locale, sauf demande explicite.
     *
     * setMinimal seul laisse serverUrls vide, et open62541 se rabat alors sur
     * « opc.tcp://:<port> » — hôte vide, donc 0.0.0.0 et ::. Le message
     * ci-dessous annonçait 127.0.0.1 sans que ce soit vrai. Tant que ce serveur
     * ne vivait que quelques secondes sur un port tiré au sort, la portée était
     * nulle ; le banc d'essai le fait vivre des heures sur un port fixe et
     * devinable, et une session anonyme sans chiffrement (securityPolicy None)
     * y serait ouverte par quiconque atteint la machine.
     *
     * L'allocation passe par UA_Array_new, et non par un pointeur vers la pile :
     * UA_Server_delete libère ce tableau, et lui donner une adresse de pile
     * échangerait une faille contre un plantage à l'arrêt. */
    /* DIAGWEB_BENCH_BIND ouvre l'écoute au réseau — c'est « tools/bench.mjs
     * --ouvert » qui la pose, pour brancher un client OPC UA tiers depuis une
     * autre machine. Hôte vide dans l'URL = toutes les interfaces, la forme
     * qu'attend open62541. Sans cette variable, rien ne change : boucle locale. */
    const char *bind_addr = getenv("DIAGWEB_BENCH_BIND");
    const int ouvert = bind_addr && (strcmp(bind_addr, "0.0.0.0") == 0 ||
                                     strcmp(bind_addr, "::") == 0);
    char url_texte[128];
    if (ouvert) {
        snprintf(url_texte, sizeof url_texte, "opc.tcp://:%d", port);
    } else if (bind_addr && *bind_addr) {
        snprintf(url_texte, sizeof url_texte, "opc.tcp://%s:%d", bind_addr, port);
    } else {
        snprintf(url_texte, sizeof url_texte, "opc.tcp://127.0.0.1:%d", port);
    }
    UA_Array_delete(config->serverUrls, config->serverUrlsSize,
                    &UA_TYPES[UA_TYPES_STRING]);
    config->serverUrls = (UA_String *)UA_Array_new(1, &UA_TYPES[UA_TYPES_STRING]);
    config->serverUrls[0] = UA_STRING_ALLOC(url_texte);
    config->serverUrlsSize = 1;

    config->logging->log = NULL;                      /* silence : la sortie sert aux tests */

    UA_Double pression = 2.5;
    UA_Int32 compteur = -42;
    UA_UInt32 regime = 1500;
    UA_Boolean marche = true;
    UA_String texte = UA_STRING("pas une mesure");    /* type non numérique : jamais publié */

    ajouter(server, "pression", &pression, &UA_TYPES[UA_TYPES_DOUBLE]);
    ajouter(server, "compteur", &compteur, &UA_TYPES[UA_TYPES_INT32]);
    ajouter(server, "regime", &regime, &UA_TYPES[UA_TYPES_UINT32]);
    ajouter(server, "marche", &marche, &UA_TYPES[UA_TYPES_BOOLEAN]);
    ajouter(server, "texte", &texte, &UA_TYPES[UA_TYPES_STRING]);

    UA_UInt64 tache = 0;
    UA_Server_addRepeatedCallback(server, battre, NULL, 100.0, &tache);

    fprintf(stderr, "serveur OPC UA de test sur opc.tcp://127.0.0.1:%d\n", port);
    fflush(stderr);
    /* UA_Server_run, et non UA_Server_runUntilInterrupt : celui-ci installe son
     * propre gestionnaire de SIGINT et ne regarde jamais `tourne` — les deux
     * signal() ci-dessus étaient donc du code mort, et un SIGTERM ne faisait
     * rien du tout. Sans conséquence tant que ce serveur ne vivait que le temps
     * d'un test ; le banc d'essai, lui, doit pouvoir l'arrêter, sans quoi il
     * garde son port fixe indéfiniment. */
    const UA_StatusCode st = UA_Server_run(server, &tourne);
    UA_Server_delete(server);
    return st == UA_STATUSCODE_GOOD ? 0 : 1;
}
