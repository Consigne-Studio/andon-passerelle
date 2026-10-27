// Source MQTT : abonnement aux sujets déclarés (charge utile brute ou champ JSON).
import mqtt from 'mqtt';

/** Lit un champ « a.b.c » dans un objet JSON. */
export function lireChamp(obj, chemin) {
  return chemin.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Correspondance de sujet MQTT avec jokers + et #. */
export function sujetCorrespond(filtre, sujet) {
  const f = filtre.split('/');
  const s = sujet.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (f[i] !== '+' && f[i] !== s[i]) return false;
  }
  return f.length === s.length;
}

export class SourceMqtt {
  constructor(c, { traducteur, emettre, journal }) {
    this.c = c;
    this.nom = c.nom;
    this.traducteur = traducteur;
    this.emettre = emettre;
    this.journal = journal;
    this.etatCourant = { etat: 'connexion', detail: c.url };
    this.liste = c.signaux.map((s, i) => ({ cle: `${c.nom}#${i}`, s }));
  }

  signaux() {
    return this.liste;
  }

  etat() {
    return { nom: this.nom, ...this.etatCourant };
  }

  demarrer() {
    const c = this.c;
    this.client = mqtt.connect(c.url, {
      username: c.utilisateur_env ? process.env[c.utilisateur_env] : undefined,
      password: c.mdp_env ? process.env[c.mdp_env] : undefined,
      clientId: c.client_id ?? `andon-passerelle-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      rejectUnauthorized: c.verifier_certificat !== false,
    });
    this.client.on('connect', () => {
      this.etatCourant = { etat: 'ok', detail: c.url };
      this.journal('info', `${this.nom} : connecté à ${c.url}`);
      const sujets = [...new Set(this.liste.map((x) => x.s.sujet))];
      this.client.subscribe(sujets, { qos: c.qos ?? 1 }, (err) => err && this.journal('alerte', `${this.nom} : abonnement refusé (${err.message})`));
    });
    this.client.on('error', (e) => {
      if (this.etatCourant.detail !== e.message) this.journal('alerte', `${this.nom} : ${e.message}`);
      this.etatCourant = { etat: 'erreur', detail: e.message };
    });
    this.client.on('offline', () => {
      if (this.etatCourant.etat === 'ok') this.journal('alerte', `${this.nom} : courtier injoignable`);
      this.etatCourant = { etat: 'erreur', detail: 'courtier injoignable' };
    });
    this.client.on('message', (sujet, charge) => {
      const texte = charge.toString('utf8');
      let json;
      for (const { cle, s } of this.liste) {
        if (!sujetCorrespond(s.sujet, sujet)) continue;
        let v = texte;
        if (s.champ) {
          if (json === undefined) {
            try {
              json = JSON.parse(texte);
            } catch {
              json = null;
            }
          }
          if (json === null) continue;
          v = lireChamp(json, s.champ);
          if (v === undefined) continue;
        }
        const n = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
        this.emettre(this.traducteur.valeur(cle, s, n));
      }
    });
  }

  arreter() {
    this.client?.end(true);
  }
}
