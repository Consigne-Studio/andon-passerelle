// Source Modbus TCP : lecture périodique des registres déclarés.
import { ClientModbus, decoder, tailleFormat } from '../modbus.js';

export class SourceModbus {
  constructor(c, { traducteur, emettre, journal }) {
    this.c = c;
    this.nom = c.nom;
    this.traducteur = traducteur;
    this.emettre = emettre;
    this.journal = journal;
    this.client = new ClientModbus({ hote: c.hote, port: c.port, unite: c.unite, delai_ms: c.delai_ms });
    this.etatCourant = { etat: 'connexion', detail: `${c.hote}:${c.port ?? 502}` };
    this.liste = c.signaux.map((s, i) => ({ cle: `${c.nom}#${i}`, s }));
  }

  signaux() {
    return this.liste;
  }

  etat() {
    return { nom: this.nom, ...this.etatCourant };
  }

  async lireUneFois() {
    for (const { cle, s } of this.liste) {
      const zone = s.zone ?? 'holding';
      const n = zone === 'coil' || zone === 'discrete' ? 1 : tailleFormat(s.format);
      const regs = await this.client.lire(zone, s.registre, n);
      const v = zone === 'coil' || zone === 'discrete' ? regs[0] === 1 : s.bit !== undefined ? ((regs[0] >> s.bit) & 1) === 1 : decoder(regs, s.format, s.ordre);
      this.emettre(this.traducteur.valeur(cle, s, v));
    }
  }

  demarrer() {
    const boucle = async () => {
      if (this.arrete) return;
      try {
        await this.lireUneFois();
        if (this.etatCourant.etat !== 'ok') this.journal('info', `${this.nom} : lecture OK`);
        this.etatCourant = { etat: 'ok', detail: `${this.c.hote}:${this.c.port ?? 502}` };
      } catch (e) {
        if (this.etatCourant.detail !== e.message) this.journal('alerte', `${this.nom} : ${e.message}`);
        this.etatCourant = { etat: 'erreur', detail: e.message };
        this.client.fermer();
      }
      this.minuterie = setTimeout(boucle, this.etatCourant.etat === 'ok' ? this.c.periode_ms ?? 1000 : 5000);
    };
    boucle();
  }

  arreter() {
    this.arrete = true;
    clearTimeout(this.minuterie);
    this.client.fermer();
  }
}
