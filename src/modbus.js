// Client Modbus TCP minimal (fonctions 1, 2, 3 et 4), sans dépendance.
import net from 'node:net';

const FONCTIONS = { coil: 1, discrete: 2, holding: 3, input: 4 };
const EXCEPTIONS = { 1: 'fonction non supportée', 2: 'adresse invalide', 3: 'valeur invalide', 4: "défaut de l'esclave", 6: 'esclave occupé', 10: 'passerelle : chemin indisponible', 11: 'passerelle : pas de réponse' };

export class ClientModbus {
  /** @param {{ hote: string, port?: number, unite?: number, delai_ms?: number }} o */
  constructor(o) {
    this.hote = o.hote;
    this.port = o.port ?? 502;
    this.unite = o.unite ?? 1;
    this.delai = o.delai_ms ?? 3000;
    this.socket = null;
    this.transaction = 0;
    /** @type {Map<number, { resoudre: (b: Buffer) => void, rejeter: (e: Error) => void, minuterie: NodeJS.Timeout }>} */
    this.attente = new Map();
    this.tampon = Buffer.alloc(0);
  }

  connecter() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    return new Promise((resoudre, rejeter) => {
      const s = net.createConnection({ host: this.hote, port: this.port });
      const echec = (e) => {
        s.destroy();
        rejeter(e);
      };
      s.setTimeout(this.delai, () => echec(new Error(`délai de connexion dépassé (${this.hote}:${this.port})`)));
      s.once('error', echec);
      s.once('connect', () => {
        s.setTimeout(0);
        s.off('error', echec);
        s.setNoDelay(true);
        s.on('data', (d) => this.recevoir(d));
        s.on('error', () => {});
        s.on('close', () => this.echouerTout(new Error('connexion fermée')));
        this.socket = s;
        resoudre();
      });
    });
  }

  recevoir(d) {
    this.tampon = Buffer.concat([this.tampon, d]);
    while (this.tampon.length >= 7) {
      const longueur = this.tampon.readUInt16BE(4);
      if (this.tampon.length < 6 + longueur) return;
      const trame = this.tampon.subarray(0, 6 + longueur);
      this.tampon = this.tampon.subarray(6 + longueur);
      const id = trame.readUInt16BE(0);
      const a = this.attente.get(id);
      if (!a) continue;
      this.attente.delete(id);
      clearTimeout(a.minuterie);
      const fonction = trame[7];
      if (fonction & 0x80) a.rejeter(new Error(`exception Modbus ${trame[8]} : ${EXCEPTIONS[trame[8]] ?? 'inconnue'}`));
      else a.resoudre(trame.subarray(8));
    }
  }

  echouerTout(e) {
    for (const [, a] of this.attente) {
      clearTimeout(a.minuterie);
      a.rejeter(e);
    }
    this.attente.clear();
    this.socket = null;
    this.tampon = Buffer.alloc(0);
  }

  /** @param {'coil'|'discrete'|'holding'|'input'} zone @param {number} adresse @param {number} nombre @returns {Promise<number[]>} */
  async lire(zone, adresse, nombre) {
    const fonction = FONCTIONS[zone];
    if (!fonction) throw new Error(`zone Modbus inconnue : ${zone}`);
    await this.connecter();
    const id = (this.transaction = (this.transaction + 1) & 0xffff);
    const req = Buffer.alloc(12);
    req.writeUInt16BE(id, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(6, 4);
    req[6] = this.unite;
    req[7] = fonction;
    req.writeUInt16BE(adresse, 8);
    req.writeUInt16BE(nombre, 10);
    const rep = await new Promise((resoudre, rejeter) => {
      const minuterie = setTimeout(() => {
        this.attente.delete(id);
        rejeter(new Error('pas de réponse de l’automate'));
        this.socket?.destroy();
      }, this.delai);
      this.attente.set(id, { resoudre, rejeter, minuterie });
      this.socket.write(req);
    });
    const octets = rep[0];
    const donnees = rep.subarray(1, 1 + octets);
    if (fonction <= 2) return Array.from({ length: nombre }, (_, i) => (donnees[i >> 3] >> (i & 7)) & 1);
    return Array.from({ length: nombre }, (_, i) => donnees.readUInt16BE(i * 2));
  }

  fermer() {
    this.socket?.destroy();
    this.socket = null;
  }
}

/** Nombre de registres de 16 bits pour un format. */
export function tailleFormat(format = 'uint16') {
  return ['uint32', 'int32', 'float32'].includes(format) ? 2 : 1;
}

/**
 * Décode des registres selon le format. `ordre` : « abcd » (mot fort en premier, défaut) ou « cdab » (mots inversés, fréquent sur Schneider et Siemens selon les réglages).
 * @param {number[]} regs @param {string} [format] @param {string} [ordre]
 */
export function decoder(regs, format = 'uint16', ordre = 'abcd') {
  if (format === 'uint16') return regs[0];
  if (format === 'int16') return regs[0] > 0x7fff ? regs[0] - 0x10000 : regs[0];
  if (format === 'bool') return regs[0] !== 0;
  const [h, l] = ordre === 'cdab' ? [regs[1], regs[0]] : [regs[0], regs[1]];
  const b = Buffer.alloc(4);
  b.writeUInt16BE(h, 0);
  b.writeUInt16BE(l, 2);
  if (format === 'uint32') return b.readUInt32BE(0);
  if (format === 'int32') return b.readInt32BE(0);
  if (format === 'float32') return b.readFloatBE(0);
  throw new Error(`format inconnu : ${format}`);
}
