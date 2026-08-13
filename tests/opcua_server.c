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
#include <stdlib.h>
#include <stdio.h>

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
    const UA_StatusCode st = UA_Server_runUntilInterrupt(server);
    UA_Server_delete(server);
    return st == UA_STATUSCODE_GOOD ? 0 : 1;
}
