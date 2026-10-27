// Traduction des valeurs lues sur les automates en événements Andon.
// Un « signal » relie une valeur (nœud OPC UA, registre Modbus, sujet MQTT) à une ligne et à une mesure.

/** @typedef {{ ligne: string, mesure: string, correspondance?: Record<string,string>, motifs?: Record<string,string>, motif?: string, appel?: string, inverse?: boolean, facteur?: number }} Signal */

export const MESURES = ['bons_total', 'rebuts_total', 'bons_increment', 'rebuts_increment', 'marche', 'etat', 'appel', 'motif'];
const ETATS = ['marche', 'arret', 'reglage', 'hors'];
const TYPES_APPEL = ['maintenance', 'qualite', 'logistique', 'chef', 'securite'];

/** @param {Signal} s @param {string} ou */
export function verifierSignal(s, ou) {
  if (!s || typeof s !== 'object') throw new Error(`${ou} : signal invalide`);
  if (!s.ligne || typeof s.ligne !== 'string') throw new Error(`${ou} : « ligne » (code de la ligne, ex. PR3) obligatoire`);
  if (!MESURES.includes(s.mesure)) throw new Error(`${ou} : « mesure » doit valoir ${MESURES.join(', ')}`);
  if (s.mesure === 'etat') {
    if (!s.correspondance || typeof s.correspondance !== 'object') throw new Error(`${ou} : « correspondance » obligatoire pour mesure etat (ex. {"1":"marche","2":"arret"})`);
    for (const [k, v] of Object.entries(s.correspondance)) if (!ETATS.includes(v)) throw new Error(`${ou} : correspondance ${k} → ${v} : état inconnu (${ETATS.join(', ')})`);
  }
  if (s.mesure === 'appel' && !TYPES_APPEL.includes(String(s.appel))) throw new Error(`${ou} : « appel » doit valoir ${TYPES_APPEL.join(', ')}`);
}

/** Vrai pour true, 1, "1", "true", "on", "marche"… */
export function booleen(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const t = String(v ?? '').trim().toLowerCase();
  return ['1', 'true', 'vrai', 'on', 'oui', 'marche', 'run', 'running'].includes(t);
}

function nombre(v) {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Suit l'état de chaque signal et produit les événements à envoyer quand la valeur change.
 * Les totaux sont renvoyés même sans changement par `rappel()` (le serveur ignore un total identique).
 */
export class Traducteur {
  constructor() {
    /** @type {Map<string, unknown>} */
    this.derniers = new Map();
    /** Motif courant par ligne (fourni par un signal « motif »). @type {Map<string, string>} */
    this.motifs = new Map();
  }

  /** @param {string} cle identifiant unique du signal @param {Signal} s @param {unknown} valeur @param {number} [ts] @returns {object[]} */
  valeur(cle, s, valeur, ts = Date.now()) {
    const avant = this.derniers.get(cle);
    const premier = !this.derniers.has(cle);
    const evts = [];
    const f = s.facteur ?? 1;
    switch (s.mesure) {
      case 'bons_total':
      case 'rebuts_total': {
        const n = nombre(valeur);
        if (n === null) return [];
        this.derniers.set(cle, n);
        if (!premier && n === avant) return [];
        const champ = s.mesure === 'bons_total' ? 'bons' : 'rebuts';
        evts.push({ type: 'compteur', ligne: s.ligne, mode: 'total', [champ]: n * f, ts });
        break;
      }
      case 'bons_increment':
      case 'rebuts_increment': {
        const n = nombre(valeur);
        if (n === null || n <= 0) return [];
        const champ = s.mesure === 'bons_increment' ? 'bons' : 'rebuts';
        evts.push({ type: 'compteur', ligne: s.ligne, [champ]: Math.round(n * f), ts });
        break;
      }
      case 'marche': {
        let b = booleen(valeur);
        if (s.inverse) b = !b;
        this.derniers.set(cle, b);
        if (!premier && b === avant) return [];
        evts.push(b ? { type: 'etat', ligne: s.ligne, etat: 'marche', ts } : { type: 'etat', ligne: s.ligne, etat: 'arret', motif: this.motifs.get(s.ligne) ?? s.motif, ts });
        break;
      }
      case 'etat': {
        const code = String(typeof valeur === 'number' ? Math.round(valeur) : valeur).trim();
        const etat = s.correspondance?.[code];
        if (!etat) return [];
        this.derniers.set(cle, code);
        if (!premier && code === avant) return [];
        const motif = s.motifs?.[code] ?? (etat === 'arret' ? this.motifs.get(s.ligne) ?? s.motif : undefined);
        evts.push({ type: 'etat', ligne: s.ligne, etat, ...(motif ? { motif } : {}), ts });
        break;
      }
      case 'motif': {
        const code = String(typeof valeur === 'number' ? Math.round(valeur) : valeur).trim();
        const texte = s.motifs?.[code] ?? (code && code !== '0' ? code : '');
        if (texte) this.motifs.set(s.ligne, texte.slice(0, 60));
        else this.motifs.delete(s.ligne);
        return [];
      }
      case 'appel': {
        let b = booleen(valeur);
        if (s.inverse) b = !b;
        this.derniers.set(cle, b);
        // Au démarrage, on n'ouvre que si le bouton est actif : on ne clôt pas un appel ouvert depuis la tablette.
        if (premier && !b) return [];
        if (!premier && b === avant) return [];
        evts.push({ type: 'appel', ligne: s.ligne, appel: s.appel, action: b ? 'ouvrir' : 'clore' });
        break;
      }
    }
    return evts;
  }

  /** Événements de rappel périodique (états et totaux courants), pour resynchroniser après une coupure. */
  rappel(signaux, ts = Date.now()) {
    const evts = [];
    for (const { cle, s } of signaux) {
      if (!this.derniers.has(cle)) continue;
      const v = this.derniers.get(cle);
      if (s.mesure === 'bons_total') evts.push({ type: 'compteur', ligne: s.ligne, mode: 'total', bons: v * (s.facteur ?? 1), ts });
      if (s.mesure === 'rebuts_total') evts.push({ type: 'compteur', ligne: s.ligne, mode: 'total', rebuts: v * (s.facteur ?? 1), ts });
      if (s.mesure === 'marche') evts.push(v ? { type: 'etat', ligne: s.ligne, etat: 'marche', ts } : { type: 'etat', ligne: s.ligne, etat: 'arret', motif: this.motifs.get(s.ligne) ?? s.motif, ts });
      if (s.mesure === 'etat') {
        const etat = s.correspondance?.[v];
        const motif = s.motifs?.[v] ?? (etat === 'arret' ? this.motifs.get(s.ligne) ?? s.motif : undefined);
        if (etat) evts.push({ type: 'etat', ligne: s.ligne, etat, ...(motif ? { motif } : {}), ts });
      }
    }
    return evts;
  }
}
