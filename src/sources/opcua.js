// Source OPC UA : abonnement (monitored items) aux nœuds déclarés.
import { AttributeIds, ClientSubscription, MessageSecurityMode, OPCUAClient, SecurityPolicy, TimestampsToReturn, UserTokenType } from 'node-opcua-client';

const MODES = {
  aucun: [MessageSecurityMode.None, SecurityPolicy.None],
  signe: [MessageSecurityMode.Sign, SecurityPolicy.Basic256Sha256],
  chiffre: [MessageSecurityMode.SignAndEncrypt, SecurityPolicy.Basic256Sha256],
};

export class SourceOpcua {
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

  async connecter() {
    const c = this.c;
    const [securityMode, securityPolicy] = MODES[c.securite ?? 'aucun'] ?? MODES.aucun;
    this.client = OPCUAClient.create({
      applicationName: 'Andon Atelier passerelle',
      securityMode,
      securityPolicy,
      endpointMustExist: false,
      keepSessionAlive: true,
      connectionStrategy: { initialDelay: 1000, maxDelay: 30000, maxRetry: 1e9 },
    });
    this.client.on('connection_lost', () => {
      this.etatCourant = { etat: 'erreur', detail: 'liaison perdue, reconnexion…' };
      this.journal('alerte', `${this.nom} : liaison perdue`);
    });
    this.client.on('connection_reestablished', () => {
      this.etatCourant = { etat: 'ok', detail: c.url };
      this.journal('info', `${this.nom} : liaison rétablie`);
    });
    await this.client.connect(c.url);
    const identite = c.utilisateur_env
      ? { type: UserTokenType.UserName, userName: process.env[c.utilisateur_env] ?? '', password: process.env[c.mdp_env] ?? '' }
      : { type: UserTokenType.Anonymous };
    this.session = await this.client.createSession(identite);
    this.abonnement = ClientSubscription.create(this.session, {
      requestedPublishingInterval: c.periode_ms ?? 1000,
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 1000,
      publishingEnabled: true,
      priority: 10,
    });
    for (const { cle, s } of this.liste) {
      const item = await this.abonnement.monitor(
        { nodeId: s.noeud, attributeId: AttributeIds.Value },
        { samplingInterval: c.periode_ms ?? 1000, discardOldest: true, queueSize: 10 },
        TimestampsToReturn.Both,
      );
      item.on('changed', (dv) => {
        if (!dv.statusCode.isGood()) return;
        const v = dv.value.value;
        this.emettre(this.traducteur.valeur(cle, s, typeof v === 'bigint' ? Number(v) : Array.isArray(v) ? v[0] : v));
      });
      item.on('err', (m) => this.journal('alerte', `${this.nom} : nœud ${s.noeud} : ${m}`));
    }
    this.etatCourant = { etat: 'ok', detail: c.url };
    this.journal('info', `${this.nom} : connecté à ${c.url} (${this.liste.length} nœuds)`);
  }

  demarrer() {
    const essayer = () =>
      this.connecter().catch(async (e) => {
        this.etatCourant = { etat: 'erreur', detail: e.message };
        this.journal('alerte', `${this.nom} : ${e.message} (nouvel essai dans 30 s)`);
        await this.fermer();
        if (!this.arrete) this.minuterie = setTimeout(essayer, 30000);
      });
    essayer();
  }

  async fermer() {
    try {
      await this.abonnement?.terminate();
      await this.session?.close();
      await this.client?.disconnect();
    } catch {
      /* déjà fermé */
    }
  }

  async arreter() {
    this.arrete = true;
    clearTimeout(this.minuterie);
    await this.fermer();
  }
}
