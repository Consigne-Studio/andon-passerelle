// Source « dossier CSV » : chaque fichier déposé (export MES, ERP, automate) est envoyé puis archivé.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class SourceCsv {
  constructor(c, { expediteur, journal }) {
    this.c = c;
    this.nom = c.nom;
    this.expediteur = expediteur;
    this.journal = journal;
    this.etatCourant = { etat: 'ok', detail: c.dossier };
    this.extension = (c.extension ?? '.csv').toLowerCase();
  }

  signaux() {
    return [];
  }

  etat() {
    return { nom: this.nom, ...this.etatCourant };
  }

  deplacer(fichier, sousDossier) {
    const cible = join(this.c.dossier, sousDossier);
    mkdirSync(cible, { recursive: true });
    const horodate = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(join(this.c.dossier, fichier), join(cible, `${horodate}_${fichier}`));
  }

  async scanner() {
    let fichiers;
    try {
      fichiers = readdirSync(this.c.dossier).filter((f) => f.toLowerCase().endsWith(this.extension)).sort();
    } catch (e) {
      this.etatCourant = { etat: 'erreur', detail: `dossier illisible : ${e.code ?? e.message}` };
      return;
    }
    for (const f of fichiers) {
      const chemin = join(this.c.dossier, f);
      const st = statSync(chemin);
      if (!st.isFile() || Date.now() - st.mtimeMs < 3000) continue; // fichier encore en cours d'écriture
      if (st.size > 2_000_000) {
        this.journal('alerte', `${this.nom} : ${f} dépasse 2 Mo, déplacé dans erreurs/`);
        this.deplacer(f, 'erreurs');
        continue;
      }
      let texte = readFileSync(chemin);
      // Excel enregistre souvent en Windows-1252 : on le détecte quand l'UTF-8 est invalide.
      let chaine = new TextDecoder('utf-8', { fatal: false }).decode(texte);
      if (chaine.includes('�')) chaine = new TextDecoder('windows-1252').decode(texte);
      let res;
      try {
        res = await this.expediteur.envoyerCsv(chaine, this.c.mode);
      } catch (e) {
        this.etatCourant = { etat: 'erreur', detail: `envoi impossible : ${e.cause?.code ?? e.message}` };
        return; // nouvel essai au prochain passage
      }
      if (res.statut === 401 || res.statut === 429 || res.statut >= 500) {
        this.etatCourant = { etat: 'erreur', detail: `service : HTTP ${res.statut}` };
        return;
      }
      const erreurs = res.erreurs?.length ?? 0;
      if (res.statut === 200) {
        this.journal('info', `${this.nom} : ${f} importé (${res.acceptes ?? 0} lignes${erreurs ? `, ${erreurs} refusées` : ''})`);
        for (const er of (res.erreurs ?? []).slice(0, 3)) this.journal('alerte', `${this.nom} : ${f} ligne ${er.index + 2} : ${er.erreur}`);
        this.deplacer(f, 'traites');
      } else {
        this.journal('alerte', `${this.nom} : ${f} refusé (${res.erreur ?? res.erreurs?.[0]?.erreur ?? 'HTTP ' + res.statut}), déplacé dans erreurs/`);
        this.deplacer(f, 'erreurs');
      }
      this.etatCourant = { etat: 'ok', detail: this.c.dossier };
    }
  }

  demarrer() {
    const boucle = async () => {
      if (this.arrete) return;
      await this.scanner().catch((e) => this.journal('alerte', `${this.nom} : ${e.message}`));
      this.minuterie = setTimeout(boucle, this.c.periode_ms ?? 5000);
    };
    boucle();
  }

  arreter() {
    this.arrete = true;
    clearTimeout(this.minuterie);
  }
}
