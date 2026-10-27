# Journal des versions

## 1.0.0 — 2026-10-24

Première version publique de la passerelle sur site d'Andon Atelier.

* Sources : OPC UA (abonnement aux nœuds), Modbus TCP (fonctions 1 à 4, lecture seule), MQTT (sujets à jokers, charges JSON), dossier CSV.
* Mesures : compteurs totalisateurs ou incrémentaux, marche, état codé, motif d'arrêt, appels sur front montant.
* Tampon sur disque : 50 000 événements, 23 h au plus, rejoués dans l'ordre au retour de la liaison, y compris après un redémarrage.
* Connexion sortante en HTTPS uniquement, clé d'API lue dans une variable d'environnement.
* Lancement sous Windows, Linux (service systemd) ou Docker.
