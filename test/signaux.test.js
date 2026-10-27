import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Traducteur, booleen, verifierSignal } from '../src/signaux.js';
import { verifierConfig } from '../src/config.js';
import { decoder } from '../src/modbus.js';
import { sujetCorrespond, lireChamp } from '../src/sources/mqtt.js';

test('total : envoyé au premier relevé puis seulement sur changement', () => {
  const t = new Traducteur();
  const s = { ligne: 'PR3', mesure: 'bons_total' };
  assert.equal(t.valeur('a', s, 100, 1).length, 1);
  assert.equal(t.valeur('a', s, 100, 2).length, 0);
  assert.deepEqual(t.valeur('a', s, 103, 3), [{ type: 'compteur', ligne: 'PR3', mode: 'total', bons: 103, ts: 3 }]);
});

test('marche / arrêt avec motif fourni par un signal motif', () => {
  const t = new Traducteur();
  const m = { ligne: 'US1', mesure: 'marche' };
  const motif = { ligne: 'US1', mesure: 'motif', motifs: { 12: 'Panne broche' } };
  assert.equal(t.valeur('m', m, true, 1)[0].etat, 'marche');
  t.valeur('mo', motif, 12);
  assert.deepEqual(t.valeur('m', m, 0, 2), [{ type: 'etat', ligne: 'US1', etat: 'arret', motif: 'Panne broche', ts: 2 }]);
  assert.equal(t.valeur('m', m, false, 3).length, 0);
});

test('état codé par correspondance', () => {
  const t = new Traducteur();
  const s = { ligne: 'A', mesure: 'etat', correspondance: { 1: 'marche', 2: 'arret', 3: 'reglage' }, motifs: { 2: 'Défaut' } };
  assert.equal(t.valeur('e', s, 1, 1)[0].etat, 'marche');
  assert.deepEqual(t.valeur('e', s, 2, 2), [{ type: 'etat', ligne: 'A', etat: 'arret', motif: 'Défaut', ts: 2 }]);
  assert.equal(t.valeur('e', s, 9, 3).length, 0, 'code inconnu ignoré');
});

test('appel : front montant ouvre, front descendant clôt, pas de clôture au démarrage', () => {
  const t = new Traducteur();
  const s = { ligne: 'A', mesure: 'appel', appel: 'maintenance' };
  assert.equal(t.valeur('b', s, false).length, 0);
  assert.equal(t.valeur('b', s, true)[0].action, 'ouvrir');
  assert.equal(t.valeur('b', s, false)[0].action, 'clore');
});

test('rappel : renvoie états et totaux connus', () => {
  const t = new Traducteur();
  const sig = [
    { cle: 'a', s: { ligne: 'A', mesure: 'bons_total' } },
    { cle: 'b', s: { ligne: 'A', mesure: 'marche' } },
    { cle: 'c', s: { ligne: 'B', mesure: 'marche' } },
  ];
  t.valeur('a', sig[0].s, 50);
  t.valeur('b', sig[1].s, 1);
  assert.equal(t.rappel(sig, 9).length, 2);
});

test('booléens et décodage Modbus', () => {
  assert.equal(booleen('RUN'), true);
  assert.equal(booleen('0'), false);
  assert.equal(decoder([0x0001, 0x86a0], 'uint32'), 100000);
  assert.equal(decoder([0x86a0, 0x0001], 'uint32', 'cdab'), 100000);
  assert.equal(decoder([0xffff], 'int16'), -1);
  assert.ok(Math.abs(decoder([0x4049, 0x0fdb], 'float32') - 3.14159) < 1e-4);
});

test('sujets MQTT et champs JSON', () => {
  assert.ok(sujetCorrespond('usine/+/compteur', 'usine/pr3/compteur'));
  assert.ok(sujetCorrespond('usine/#', 'usine/pr3/etat'));
  assert.ok(!sujetCorrespond('usine/+/compteur', 'usine/pr3/etat'));
  assert.equal(lireChamp({ a: { b: 4 } }, 'a.b'), 4);
});

test('configuration : erreurs explicites', () => {
  const env = { ANDON_CLE: 'ak_x' };
  assert.throws(() => verifierConfig({ serveur: 'http://andon.fr', sources: [] }, env), /https/);
  assert.throws(() => verifierConfig({ serveur: 'https://a.fr', sources: [{ type: 'modbus', hote: 'x' }] }, {}), /ANDON_CLE/);
  assert.throws(() => verifierConfig({ serveur: 'https://a.fr', sources: [{ type: 'modbus', hote: '1.2.3.4', signaux: [{ ligne: 'A', mesure: 'marche' }] }] }, env), /registre/);
  assert.throws(() => verifierSignal({ ligne: 'A', mesure: 'appel', appel: 'pompier' }, 'x'), /appel/);
  const c = verifierConfig({ serveur: 'https://a.fr/', sources: [{ type: 'csv', dossier: '/tmp' }] }, env);
  assert.equal(c.serveur, 'https://a.fr');
  assert.equal(c.cle, 'ak_x');
});
