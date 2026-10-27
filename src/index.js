#!/usr/bin/env node
// Passerelle Andon Atelier : lit les automates du site et pousse les événements vers le service (HTTPS sortant uniquement).
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lireConfig } from './config.js';
import { Expediteur } from './envoi.js';
import { Traducteur } from './signaux.js';

export const VERSION = '1.0.0';

function journal(niveau, texte) {
  const ligne = `${new Date().toISOString()} ${niveau === 'alerte' ? 'ALERTE' : 'info  '} ${texte}`;
  (niveau === 'alerte' ? console.error : console.log)(ligne);
}

async function creerSource(c, outils) {
  switch (c.type) {
    case 'modbus':
      return new (await import('./sources/modbus.js')).SourceModbus(c, outils);
    case 'mqtt':
      return new (await import('./sources/mqtt.js')).SourceMqtt(c, outils);
    case 'opcua':
      return new (await import('./sources/opcua.js')).SourceOpcua(c, outils);
    case 'csv':
      return new (await import('./sources/csv.js')).SourceCsv(c, outils);
  }
}

/** Démarre la passerelle. Renvoie une fonction d'arrêt (utilisée par les tests). */
export async function demarrer(config, { log = journal, fetch } = {}) {
  const expediteur = new Expediteur({ serveur: config.serveur, cle: config.cle, tampon: config.tampon, journal: log, fetch });
  const traducteur = new Traducteur();
  let attente = null;
  const emettre = (evts) => {
    if (!evts.length) return;
    expediteur.ajouter(evts);
    attente ??= setTimeout(() => {
      attente = null;
      expediteur.vider();
    }, 300);
  };
  const outils = { traducteur, emettre, journal: log, expediteur };
  const sources = [];
  for (const c of config.sources) sources.push(await creerSource(c, outils));
  for (const s of sources) s.demarrer();

  const battre = () => expediteur.battement(VERSION, sources.map((s) => s.etat()));
  const periodique = setInterval(() => {
    emettre(traducteur.rappel(sources.flatMap((s) => s.signaux())));
    battre();
  }, config.rappel_s * 1000);
  const relance = setInterval(() => expediteur.file.length && expediteur.vider(), 10000);
  battre();
  log('info', `Passerelle ${VERSION} démarrée : ${sources.length} source(s) vers ${config.serveur}`);
  return {
    expediteur,
    sources,
    async arreter() {
      clearInterval(periodique);
      clearInterval(relance);
      clearTimeout(attente);
      for (const s of sources) await s.arreter();
      await expediteur.vider();
      expediteur.persister();
    },
  };
}

async function principal() {
  const args = process.argv.slice(2);
  if (args.includes('--aide') || args.includes('-h') || args.includes('--help')) {
    console.log(`andon-passerelle ${VERSION}

Usage : ANDON_CLE=ak_… node src/index.js [passerelle.json] [--verifier]

  --verifier   vérifie la configuration et la clé, liste les lignes du service, puis quitte.

Documentation : README.md`);
    return;
  }
  const chemin = resolve(args.find((a) => !a.startsWith('--')) ?? 'passerelle.json');
  let config;
  try {
    config = lireConfig(chemin);
  } catch (e) {
    journal('alerte', e.message);
    process.exit(2);
  }
  if (args.includes('--verifier')) {
    const ex = new Expediteur({ serveur: config.serveur, cle: config.cle, tampon: null });
    try {
      const lignes = await ex.lignes();
      const codes = new Set(lignes.map((l) => l.code));
      console.log(`Clé acceptée par ${config.serveur}. Lignes : ${lignes.map((l) => l.code).join(', ') || 'aucune'}`);
      const inconnus = [...new Set(config.sources.flatMap((s) => (s.signaux ?? []).map((x) => x.ligne)).filter((c) => !codes.has(c)))];
      if (inconnus.length) {
        console.error(`Codes de ligne inconnus du service : ${inconnus.join(', ')}`);
        process.exit(1);
      }
      console.log('Configuration correcte.');
      return;
    } catch (e) {
      console.error(`Échec : ${e.message}`);
      process.exit(1);
    }
  }
  const p = await demarrer(config);
  const fin = async () => {
    journal('info', 'Arrêt demandé, vidage du tampon…');
    await p.arreter();
    process.exit(0);
  };
  process.on('SIGINT', fin);
  process.on('SIGTERM', fin);
}

const lance = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (lance) principal();
