import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demarrer } from '../src/index.js';
import { Expediteur } from '../src/envoi.js';
import { fauxService, attendre, silence } from './outils.js';

/** Petit automate Modbus TCP simulé : registres de maintien modifiables. */
async function automateModbus(registres) {
  const s = net.createServer((sock) => {
    sock.on('data', (d) => {
      const id = d.readUInt16BE(0);
      const f = d[7];
      const adr = d.readUInt16BE(8);
      const n = d.readUInt16BE(10);
      if (f !== 3) {
        const r = Buffer.from([0, 0, 0, 0, 0, 3, d[6], f | 0x80, 1]);
        r.writeUInt16BE(id, 0);
        return sock.write(r);
      }
      const r = Buffer.alloc(9 + n * 2);
      r.writeUInt16BE(id, 0);
      r.writeUInt16BE(3 + n * 2, 4);
      r[6] = d[6];
      r[7] = 3;
      r[8] = n * 2;
      for (let i = 0; i < n; i++) r.writeUInt16BE(registres[adr + i] ?? 0, 9 + i * 2);
      sock.write(r);
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, fermer: () => new Promise((r) => s.close(r)) };
}

test('Modbus TCP : compteur 32 bits et marche', async () => {
  const svc = await fauxService();
  const regs = { 100: 0, 101: 500, 110: 1 };
  const plc = await automateModbus(regs);
  const p = await demarrer(
    {
      serveur: svc.url, cle: 'ak_test', tampon: null, rappel_s: 60,
      sources: [{ type: 'modbus', nom: 'API presse', hote: '127.0.0.1', port: plc.port, periode_ms: 100, signaux: [
        { ligne: 'PR3', mesure: 'bons_total', registre: 100, format: 'uint32' },
        { ligne: 'PR3', mesure: 'marche', registre: 110 },
      ] }],
    },
    { log: silence },
  );
  await attendre(() => svc.recus.evenements.some((e) => e.bons === 500));
  regs[101] = 512;
  regs[110] = 0;
  await attendre(() => svc.recus.evenements.some((e) => e.bons === 512) && svc.recus.evenements.some((e) => e.etat === 'arret'));
  await attendre(() => svc.recus.battements.length > 0);
  assert.equal(svc.recus.battements[0].version, '1.0.0');
  await p.arreter();
  await plc.fermer();
  await svc.fermer();
});

test('MQTT : charge JSON et sujet à joker', async () => {
  const { Aedes } = await import('aedes');
  const courtier = await Aedes.createBroker();
  const srv = net.createServer(courtier.handle);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const svc = await fauxService();
  const p = await demarrer(
    {
      serveur: svc.url, cle: 'ak_test', tampon: null, rappel_s: 60,
      sources: [{ type: 'mqtt', nom: 'Courtier', url: `mqtt://127.0.0.1:${srv.address().port}`, signaux: [
        { ligne: 'ASM', mesure: 'bons_increment', sujet: 'usine/+/pieces', champ: 'n' },
        { ligne: 'ASM', mesure: 'appel', appel: 'qualite', sujet: 'usine/asm/appel' },
      ] }],
    },
    { log: silence },
  );
  await attendre(() => p.sources[0].etat().etat === 'ok');
  await new Promise((r) => setTimeout(r, 200));
  const publier = (topic, payload) => new Promise((r) => courtier.publish({ topic, payload: Buffer.from(payload), qos: 0, retain: false, cmd: 'publish', dup: false }, r));
  await publier('usine/asm/pieces', JSON.stringify({ n: 3 }));
  await publier('usine/asm/appel', '1');
  await attendre(() => svc.recus.evenements.some((e) => e.bons === 3) && svc.recus.evenements.some((e) => e.type === 'appel' && e.action === 'ouvrir'));
  await p.arreter();
  await new Promise((r) => courtier.close(r));
  srv.close();
  await svc.fermer();
});

test('OPC UA : abonnement à un compteur', { timeout: 60000 }, async () => {
  const { OPCUAServer } = await import('node-opcua-server');
  const { Variant, DataType } = await import('node-opcua-client');
  const serveur = new OPCUAServer({ port: 26543, resourcePath: '/UA/Test', allowAnonymous: true });
  await serveur.initialize();
  const ns = serveur.engine.addressSpace.getOwnNamespace();
  let compteur = 41;
  const presse = ns.addObject({ organizedBy: serveur.engine.addressSpace.rootFolder.objects, browseName: 'Presse' });
  ns.addVariable({ componentOf: presse, browseName: 'Compteur', nodeId: 's=Presse.Compteur', dataType: 'UInt32', value: { get: () => new Variant({ dataType: DataType.UInt32, value: compteur }) } });
  await serveur.start();
  const svc = await fauxService();
  const ns1 = serveur.engine.addressSpace.getNamespaceIndex(ns.namespaceUri);
  const p = await demarrer(
    {
      serveur: svc.url, cle: 'ak_test', tampon: null, rappel_s: 60,
      sources: [{ type: 'opcua', nom: 'Presse', url: 'opc.tcp://127.0.0.1:26543/UA/Test', periode_ms: 200, signaux: [{ ligne: 'PR3', mesure: 'bons_total', noeud: `ns=${ns1};s=Presse.Compteur` }] }],
    },
    { log: silence },
  );
  await attendre(() => svc.recus.evenements.some((e) => e.bons === 41), 30000);
  compteur = 45;
  await attendre(() => svc.recus.evenements.some((e) => e.bons === 45), 15000);
  await p.arreter();
  await serveur.shutdown();
  await svc.fermer();
});

test('dossier CSV : import puis archivage, fichier invalide mis de côté', async () => {
  const svc = await fauxService();
  const dossier = mkdtempSync(join(tmpdir(), 'andon-csv-'));
  writeFileSync(join(dossier, 'prod.csv'), 'ligne;bons\nPR3;12\n');
  writeFileSync(join(dossier, 'mauvais.csv'), 'machin;truc\n1;2\n');
  const vieux = new Date(Date.now() - 10000);
  utimesSync(join(dossier, 'prod.csv'), vieux, vieux);
  utimesSync(join(dossier, 'mauvais.csv'), vieux, vieux);
  const p = await demarrer({ serveur: svc.url, cle: 'ak_test', tampon: null, rappel_s: 60, sources: [{ type: 'csv', nom: 'Export MES', dossier, periode_ms: 100 }] }, { log: silence });
  await attendre(() => existsSync(join(dossier, 'traites')) && existsSync(join(dossier, 'erreurs')));
  assert.equal(svc.recus.csv.length, 1);
  assert.equal(readdirSync(join(dossier, 'traites')).length, 1);
  assert.equal(readdirSync(join(dossier, 'erreurs')).length, 1);
  await p.arreter();
  await svc.fermer();
});

test('tampon : service indisponible puis rétabli, rien n’est perdu, reprise après redémarrage', async () => {
  const svc = await fauxService({ panne: true });
  const dossier = mkdtempSync(join(tmpdir(), 'andon-tampon-'));
  const fichier = join(dossier, 'tampon.jsonl');
  const ex = new Expediteur({ serveur: svc.url, cle: 'ak_test', tampon: fichier });
  ex.ajouter([{ type: 'compteur', ligne: 'PR3', bons: 1 }, { type: 'compteur', ligne: 'PR3', bons: 2 }]);
  assert.equal(await ex.vider(), false);
  assert.ok(ex.horsLigneDepuis);
  // Redémarrage de la passerelle : le tampon est relu.
  const ex2 = new Expediteur({ serveur: svc.url, cle: 'ak_test', tampon: fichier });
  assert.equal(ex2.file.length, 2);
  svc.etat.panne = false;
  ex2.ajouter([{ type: 'compteur', ligne: 'INCONNUE', bons: 1 }]);
  assert.equal(await ex2.vider(), true);
  assert.equal(svc.recus.evenements.length, 2);
  assert.equal(ex2.rejetes, 1);
  assert.equal(readFileSync(fichier, 'utf8'), '');
  await svc.fermer();
});

test('tampon : réseau coupé (connexion refusée)', async () => {
  const ex = new Expediteur({ serveur: 'http://127.0.0.1:9', cle: 'ak_test', tampon: null });
  ex.ajouter([{ type: 'etat', ligne: 'A', etat: 'marche' }]);
  assert.equal(await ex.vider(), false);
  assert.match(ex.derniereErreur, /réseau/);
  assert.equal(ex.file.length, 1);
});

test('tampon : réponse d’un proxy (403 sans bilan) : le lot reste en tampon', async () => {
  const proxy = createServer((req, res) => {
    req.resume();
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<h1>Accès refusé par le proxy</h1>');
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const ex = new Expediteur({ serveur: `http://127.0.0.1:${proxy.address().port}`, cle: 'ak_test', tampon: null });
  ex.ajouter([{ type: 'compteur', ligne: 'PR3', bons: 1 }]);
  assert.equal(await ex.vider(), false);
  assert.equal(ex.file.length, 1);
  assert.match(ex.derniereErreur, /HTTP 403/);
  await new Promise((r) => proxy.close(r));
});
