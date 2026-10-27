# Passerelle Andon Atelier

La passerelle relie vos automates à Andon Atelier sans ouvrir aucun port entrant. Elle tourne sur un PC ou un petit serveur de l'atelier, lit vos automates et pousse les compteurs, les états et les appels vers le service. Elle n'utilise que du HTTPS sortant.

Sources prises en charge :

| Source | Usage typique |
|---|---|
| **OPC UA** | Siemens S7-1200/1500, Beckhoff, B&R, Codesys, Kepware, serveurs SCADA |
| **Modbus TCP** | Schneider M221/M241/M251, Wago, Unitronics, compteurs et modules d'E/S |
| **MQTT** | Node-RED, capteurs IoT, Shelly, passerelles du marché |
| **Dossier CSV** | Export périodique d'un MES ou d'un ERP, ou d'un automate qui écrit des fichiers |

Licence MIT : vous pouvez lire, modifier et auditer tout le code.

## Installation (10 minutes)

1. Installez Node.js 20 ou plus récent (https://nodejs.org, version « LTS »).
2. Décompressez `andon-passerelle.zip`, ouvrez un terminal dans le dossier et lancez `npm ci --omit=dev`.
3. Dans Andon Atelier, onglet **Connecteurs**, créez une **clé d'API**. Copiez-la : elle ne sera plus affichée.
4. Copiez `passerelle.exemple.json` en `passerelle.json` et gardez seulement vos sources (voir plus bas).
5. Placez la clé dans la variable d'environnement `ANDON_CLE`, jamais dans le fichier :
   - Windows (invite administrateur) : `setx ANDON_CLE "ak_…" /M`, puis rouvrez le terminal.
   - Linux : `export ANDON_CLE=ak_…`, ou bien `Environment=` dans le service systemd.
6. Vérifiez la configuration : `node src/index.js passerelle.json --verifier`. Cette commande contrôle la clé et la présence des codes de ligne.
7. Lancez : `node src/index.js passerelle.json`.

Dans **Connecteurs**, la passerelle apparaît « en ligne » avec l'état de chaque source. Le battement est envoyé toutes les 60 s.

### Démarrage automatique

- **Windows** : utilisez le Planificateur de tâches. Créez une tâche « Au démarrage du système » qui lance `demarrer-windows.cmd` et cochez « Exécuter même si l'utilisateur n'est pas connecté ».
- **Linux** : servez-vous du fichier `andon-passerelle.service`. Les instructions sont en tête du fichier.
- **Docker** : `docker build -t andon-passerelle .` puis
  `docker run -d --restart=always --network=host -e ANDON_CLE=ak_… -v /chemin/vers/dossier:/donnees andon-passerelle`.
  Le dossier monté contient `passerelle.json` et le tampon.

## Configuration

```json
{
  "serveur": "https://andon.exemple.fr",
  "sources": [ … ]
}
```

| Clé | Rôle | Défaut |
|---|---|---|
| `serveur` | Adresse de votre service Andon Atelier, en https | obligatoire |
| `cle_variable` | Nom de la variable d'environnement qui contient la clé | `ANDON_CLE` |
| `tampon` | Fichier où sont gardés les événements quand le service est injoignable | `tampon.jsonl` |
| `rappel_s` | Période de renvoi des états et totaux courants (resynchronisation) | `60` |

### Signaux

Chaque source déclare des **signaux**. Un signal relie une valeur de l'automate à une ligne (son code, par exemple `PR3`) et à une **mesure** :

| Mesure | Valeur lue | Effet dans Andon |
|---|---|---|
| `bons_total` | Compteur totalisateur de pièces bonnes | Ajoute la différence depuis la lecture précédente. Une remise à zéro de l'automate est gérée. |
| `rebuts_total` | Compteur totalisateur de rebuts | Pareil, pour les rebuts. |
| `bons_increment` / `rebuts_increment` | Nombre de pièces à ajouter (message MQTT par lot) | Ajoute la valeur. |
| `marche` | Booléen : en marche ou non | Marche, ou arrêt. Ajoutez `"inverse": true` si l'automate donne « en défaut ». |
| `etat` | Code d'état | Converti par `correspondance`, par exemple `{"1":"marche","2":"arret","3":"reglage","0":"hors"}`. `motifs` associe un motif d'arrêt à un code. |
| `motif` | Code de défaut | Converti par `motifs`. Sert de motif au prochain arrêt de la ligne. |
| `appel` | Booléen (bouton, voyant) | Front montant : ouvre l'appel `appel` (maintenance, qualite, logistique, chef, securite). Front descendant : le clôt. |

`facteur` (optionnel) multiplie la valeur. Il sert par exemple quand un automate compte des cycles de 4 pièces.

### OPC UA

```json
{ "type": "opcua", "nom": "Presse PR3", "url": "opc.tcp://192.168.10.21:4840",
  "securite": "aucun", "periode_ms": 1000,
  "signaux": [ { "ligne": "PR3", "mesure": "bons_total", "noeud": "ns=3;s=\"DB_Andon\".\"PiecesBonnes\"" } ] }
```

- `securite` vaut `aucun`, `signe` ou `chiffre` (Basic256Sha256). Avec `signe` ou `chiffre`, acceptez le certificat de la passerelle côté automate. Le certificat est créé au premier lancement.
- Pour une connexion par identifiant, renseignez `utilisateur_env` et `mdp_env` : ce sont les **noms** des variables d'environnement qui contiennent l'identifiant et le mot de passe.
- Siemens S7-1200/1500 : activez le serveur OPC UA dans TIA Portal et rendez le bloc de données « Accessible depuis OPC UA ». L'identifiant de nœud est de la forme `ns=3;s="DB"."Variable"`. UaExpert (gratuit) permet de le copier.

### Modbus TCP

```json
{ "type": "modbus", "nom": "Usinage", "hote": "192.168.10.30", "port": 502, "unite": 1, "periode_ms": 1000,
  "signaux": [ { "ligne": "US1", "mesure": "bons_total", "registre": 100, "format": "uint32", "ordre": "abcd" } ] }
```

- `zone` : `holding` (registres de maintien, par défaut), `input`, `coil` ou `discrete`.
- `registre` : adresse **à partir de 0**. Le registre 40101 de la documentation de l'automate correspond à `100`.
- `format` : `uint16` (défaut), `int16`, `uint32`, `int32`, `float32` ou `bool`. Pour lire un seul bit d'un registre, ajoutez `bit` (0 à 15).
- `ordre` : `abcd` (mot fort en premier, défaut) ou `cdab`. Si un compteur 32 bits affiche des valeurs absurdes, essayez `cdab`.

### MQTT

```json
{ "type": "mqtt", "nom": "Courtier", "url": "mqtt://192.168.10.5:1883",
  "signaux": [ { "ligne": "ASM", "mesure": "bons_increment", "sujet": "atelier/asm/pieces", "champ": "quantite" } ] }
```

- `sujet` accepte les jokers `+` et `#`.
- `champ` lit une valeur dans une charge JSON, avec des points pour descendre (par exemple `data.count`). Sans `champ`, la charge brute est utilisée (`1`, `true`, `42`…).
- Utilisez `mqtts://` pour le TLS. `verifier_certificat: false` accepte un certificat auto-signé.

### Dossier CSV

```json
{ "type": "csv", "nom": "Export MES", "dossier": "C:/Andon/depot", "mode": "increment" }
```

Chaque fichier `.csv` déposé est envoyé dès qu'il n'a pas bougé depuis 3 s. Il part ensuite dans `traites/`, ou dans `erreurs/` s'il est refusé. Le format est celui de l'import CSV d'Andon Atelier :

```
ligne;bons;rebuts;horodatage
PR3;120;2;24/10/2026 08:00
```

`mode: "total"` indique des colonnes en totaux de compteur au lieu d'incréments. Les encodages UTF-8 et Windows-1252 (Excel) sont reconnus.

## Fiabilité

- **Coupure réseau ou service indisponible** : les événements sont horodatés à la lecture, gardés dans `tampon.jsonl` (jusqu'à 50 000) puis rejoués dans l'ordre au retour de la liaison. La production est rangée dans le bon quart d'heure. Le service accepte 24 h de retard au plus.
- **Redémarrage du PC** : le tampon est relu au démarrage.
- **Automate injoignable** : la passerelle retente toutes les 5 s (Modbus) ou 30 s (OPC UA). L'erreur s'affiche dans **Connecteurs**.
- Toutes les 60 s, la passerelle renvoie l'état et le total courants. Les écrans se resynchronisent ainsi même après une coupure longue.

## Sécurité

- Aucun port entrant à ouvrir. La passerelle n'accepte aucune connexion.
- **Lecture seule** : la passerelle n'écrit jamais dans un automate. Le code client Modbus n'implémente même pas les fonctions d'écriture.
- La clé d'API est révocable à tout moment dans **Connecteurs**. Elle ne donne accès qu'à votre atelier.
- Placez de préférence le PC passerelle dans une zone réseau qui voit les automates et peut sortir en HTTPS vers le service, et rien d'autre.

## Dépannage

| Message | Cause probable |
|---|---|
| `Variable d'environnement ANDON_CLE absente` | Clé non définie dans la session qui lance la passerelle (après `setx`, rouvrez le terminal). |
| `clé d'API refusée` | Clé révoquée ou mal copiée : créez-en une nouvelle dans Connecteurs. |
| `Ligne « XXX » introuvable` | Le code `ligne` du signal ne correspond à aucune ligne : vérifiez l'onglet Lignes (majuscules comprises). |
| `délai de connexion dépassé` (Modbus) | Mauvaise IP, port 502 filtré, ou automate qui limite le nombre de clients. |
| `exception Modbus 2 : adresse invalide` | Registre hors plage : rappelez-vous que l'adresse commence à 0. |
| `BadIdentityTokenRejected` (OPC UA) | Accès anonyme désactivé : renseignez `utilisateur_env` et `mdp_env`. |
| `BadSecurityChecksFailed` (OPC UA) | Certificat de la passerelle à approuver côté automate, ou `securite` à aligner. |

Journal : la passerelle écrit sur la sortie standard. Sous systemd : `journalctl -u andon-passerelle -f`. Sous Docker : `docker logs -f`.

## Tests

`npm install`, puis `npm test`. Les tests lancent un vrai serveur OPC UA, un courtier MQTT et un automate Modbus simulé.
