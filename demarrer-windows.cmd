@echo off
rem Lance la passerelle sous Windows. Pour un démarrage automatique : Planificateur de tâches,
rem « Au démarrage du système », action = ce fichier, option « Exécuter même si l'utilisateur n'est pas connecté ».
rem La clé d'API se met une fois pour toutes avec :  setx ANDON_CLE "ak_..." /M
cd /d "%~dp0"
:boucle
node src\index.js passerelle.json
echo Passerelle arrêtée, redémarrage dans 10 secondes...
timeout /t 10 /nobreak >nul
goto boucle
