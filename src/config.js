// Lecture et vérification de passerelle.json. La clé d'API n'est jamais dans le fichier : variable d'environnement ANDON_CLE.
import { readFileSync } from 'node:fs';
import { verifierSignal } from './signaux.js';

const TYPES = ['opcua', 'modbus', 'mqtt', 'csv'];

export function lireConfig(chemin, env = process.env) {
  let brut;
  try {
    brut = JSON.parse(readFileSync(chemin, 'utf8'));
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? `Fichier de configuration introuvable : ${chemin}` : `${chemin} : JSON invalide (${e.message})`, { cause: e });
  }
  return verifierConfig(brut, env);
}

export function verifierConfig(c, env = process.env) {
  if (!c || typeof c !== 'object') throw new Error('Configuration vide');
  const serveur = String(c.serveur ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(serveur)) throw new Error('« serveur » : adresse du service attendue, ex. https://andon.exemple.fr');
  if (serveur.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(serveur)) throw new Error('« serveur » doit être en https:// (http:// seulement pour localhost)');
  const nomVar = c.cle_variable ?? 'ANDON_CLE';
  const cle = env[nomVar];
  if (!cle || !cle.startsWith('ak_')) throw new Error(`Variable d'environnement ${nomVar} absente : collez-y la clé d'API (ak_…) créée dans Connecteurs`);
  if (!Array.isArray(c.sources) || !c.sources.length) throw new Error('« sources » : au moins une source attendue');
  const noms = new Set();
  c.sources.forEach((s, i) => {
    const ou = `sources[${i}]`;
    if (!TYPES.includes(s?.type)) throw new Error(`${ou} : « type » doit valoir ${TYPES.join(', ')}`);
    s.nom = String(s.nom ?? `${s.type}-${i + 1}`);
    if (noms.has(s.nom)) throw new Error(`${ou} : nom « ${s.nom} » en double`);
    noms.add(s.nom);
    if (s.type === 'opcua' && !/^opc\.tcp:\/\//.test(String(s.url))) throw new Error(`${ou} : « url » opc.tcp://hôte:4840 attendue`);
    if (s.type === 'mqtt' && !/^(mqtts?|wss?|tcp|ssl):\/\//.test(String(s.url))) throw new Error(`${ou} : « url » mqtt://hôte:1883 attendue`);
    if (s.type === 'modbus' && !s.hote) throw new Error(`${ou} : « hote » (adresse IP de l'automate) attendu`);
    if (s.type === 'csv') {
      if (!s.dossier) throw new Error(`${ou} : « dossier » attendu`);
      return;
    }
    if (!Array.isArray(s.signaux) || !s.signaux.length) throw new Error(`${ou} : « signaux » attendus`);
    s.signaux.forEach((sig, j) => {
      const o = `${ou}.signaux[${j}]`;
      verifierSignal(sig, o);
      if (s.type === 'opcua' && !sig.noeud) throw new Error(`${o} : « noeud » (ex. ns=3;s=Compteur) attendu`);
      if (s.type === 'mqtt' && !sig.sujet) throw new Error(`${o} : « sujet » attendu`);
      if (s.type === 'modbus' && !Number.isInteger(sig.registre)) throw new Error(`${o} : « registre » (adresse, à partir de 0) attendu`);
    });
  });
  return { ...c, serveur, cle, tampon: c.tampon ?? 'tampon.jsonl', rappel_s: c.rappel_s ?? 60 };
}
