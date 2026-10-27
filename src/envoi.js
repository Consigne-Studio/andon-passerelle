// Envoi vers Andon Atelier en HTTPS sortant, avec tampon sur disque quand le réseau ou le service est indisponible.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const LOT = 500;
const MAX_TAMPON = 50000;
const AGE_MAX = 23 * 3600 * 1000; // le serveur refuse au-delà de 24 h

export class Expediteur {
  /**
   * @param {{ serveur: string, cle: string, tampon?: string | null, journal?: (niveau: string, texte: string) => void, fetch?: typeof fetch }} o
   */
  constructor(o) {
    this.serveur = o.serveur.replace(/\/+$/, '');
    this.cle = o.cle;
    this.fichier = o.tampon ?? null;
    this.journal = o.journal ?? (() => {});
    this.fetch = o.fetch ?? globalThis.fetch;
    /** @type {object[]} */
    this.file = [];
    this.enCours = false;
    this.horsLigneDepuis = null;
    this.derniereErreur = null;
    this.envoyes = 0;
    this.rejetes = 0;
    if (this.fichier && existsSync(this.fichier)) {
      for (const l of readFileSync(this.fichier, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        try {
          this.file.push(JSON.parse(l));
        } catch {
          /* ligne tronquée par une coupure de courant : ignorée */
        }
      }
      if (this.file.length) this.journal('info', `${this.file.length} événements repris du tampon`);
    }
  }

  entetes(type = 'application/json') {
    return { Authorization: `Bearer ${this.cle}`, 'Content-Type': type, 'User-Agent': 'andon-passerelle/1.0' };
  }

  /** Ajoute des événements à la file (horodatés pour être rejoués correctement). */
  ajouter(evts) {
    if (!evts.length) return;
    const t = Date.now();
    for (const e of evts) if (e.type !== 'appel' && e.type !== 'message' && e.ts === undefined) e.ts = t;
    this.file.push(...evts);
    if (this.file.length > MAX_TAMPON) {
      const trop = this.file.length - MAX_TAMPON;
      this.file.splice(0, trop);
      this.journal('alerte', `Tampon plein : ${trop} événements les plus anciens abandonnés`);
    }
    if (this.fichier) appendFileSync(this.fichier, evts.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  persister() {
    if (!this.fichier) return;
    const tmp = this.fichier + '.tmp';
    writeFileSync(tmp, this.file.map((e) => JSON.stringify(e)).join('\n') + (this.file.length ? '\n' : ''));
    renameSync(tmp, this.fichier);
  }

  /** Envoie la file par lots. Renvoie true si tout est parti. */
  async vider() {
    if (this.enCours) return false;
    this.enCours = true;
    try {
      const limite = Date.now() - AGE_MAX;
      const avant = this.file.length;
      this.file = this.file.filter((e) => typeof e.ts !== 'number' || e.ts > limite);
      if (this.file.length < avant) this.journal('alerte', `${avant - this.file.length} événements de plus de 23 h abandonnés`);
      while (this.file.length) {
        const lot = this.file.slice(0, LOT);
        let rep;
        try {
          rep = await this.fetch(`${this.serveur}/api/v1/evenements`, { method: 'POST', headers: this.entetes(), body: JSON.stringify({ evenements: lot }), signal: AbortSignal.timeout(15000) });
        } catch (e) {
          this.horsLigne(`réseau : ${e.cause?.code ?? e.message}`);
          return false;
        }
        if (rep.status === 401) {
          this.horsLigne("clé d'API refusée (révoquée ?)");
          return false;
        }
        if (rep.status === 429 || rep.status >= 500) {
          this.horsLigne(`service indisponible (HTTP ${rep.status})`);
          return false;
        }
        const corps = await rep.json().catch(() => null);
        // Seule une réponse du serveur Andon (200 ou 422 avec son bilan) vaut traitement du lot. Toute autre réponse
        // (proxy d'entreprise 403/407, mauvaise adresse 404, 413…) garde le lot en tampon.
        if ((rep.status !== 200 && rep.status !== 422) || typeof corps?.acceptes !== 'number') {
          this.horsLigne(`réponse inattendue (HTTP ${rep.status}) : vérifiez l'adresse du serveur et le proxy`);
          return false;
        }
        // Les événements refusés le sont définitivement (code de ligne inconnu…).
        this.file.splice(0, lot.length);
        this.envoyes += corps.acceptes ?? 0;
        if (Array.isArray(corps.erreurs) && corps.erreurs.length) {
          this.rejetes += corps.erreurs.length;
          for (const er of corps.erreurs.slice(0, 5)) this.journal('alerte', `Événement refusé : ${er.erreur ?? JSON.stringify(er)}`);
        }
        this.persister();
      }
      if (this.horsLigneDepuis) this.journal('info', `Liaison rétablie après ${Math.round((Date.now() - this.horsLigneDepuis) / 1000)} s`);
      this.horsLigneDepuis = null;
      this.derniereErreur = null;
      return true;
    } finally {
      this.enCours = false;
    }
  }

  horsLigne(raison) {
    if (!this.horsLigneDepuis) {
      this.horsLigneDepuis = Date.now();
      this.journal('alerte', `Envoi impossible, mise en tampon (${raison})`);
    }
    this.derniereErreur = raison;
  }

  /** Signale la passerelle au service (affiché dans Connecteurs). */
  async battement(version, sources) {
    try {
      const rep = await this.fetch(`${this.serveur}/api/v1/battement`, { method: 'POST', headers: this.entetes(), body: JSON.stringify({ version, sources }), signal: AbortSignal.timeout(15000) });
      if (!rep.ok) return null;
      return await rep.json();
    } catch {
      return null;
    }
  }

  /** Envoie un fichier CSV tel quel (import serveur). */
  async envoyerCsv(texte, mode) {
    const rep = await this.fetch(`${this.serveur}/api/v1/import.csv?mode=${mode === 'total' ? 'total' : 'increment'}`, { method: 'POST', headers: this.entetes('text/csv; charset=utf-8'), body: texte, signal: AbortSignal.timeout(60000) });
    const corps = await rep.json().catch(() => ({}));
    return { statut: rep.status, ...corps };
  }

  async lignes() {
    const rep = await this.fetch(`${this.serveur}/api/v1/lignes`, { headers: this.entetes(), signal: AbortSignal.timeout(15000) });
    if (!rep.ok) throw new Error(rep.status === 401 ? "Clé d'API refusée" : `HTTP ${rep.status}`);
    return rep.json();
  }
}
