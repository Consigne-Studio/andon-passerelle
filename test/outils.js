// Faux service Andon pour les tests : enregistre les événements reçus.
import http from 'node:http';

export async function fauxService({ cle = 'ak_test', panne = false } = {}) {
  const recus = { evenements: [], battements: [], csv: [] };
  const etat = { panne };
  const serveur = http.createServer(async (req, res) => {
    let corps = '';
    for await (const m of req) corps += m;
    const json = (s, o) => {
      res.writeHead(s, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (etat.panne) return json(503, { erreur: 'maintenance' });
    if (req.headers.authorization !== `Bearer ${cle}`) return json(401, { erreur: 'clé' });
    if (req.url === '/api/v1/evenements') {
      const evts = JSON.parse(corps).evenements;
      const erreurs = [];
      evts.forEach((e, index) => (e.ligne === 'INCONNUE' ? erreurs.push({ index, erreur: 'Ligne inconnue : INCONNUE' }) : recus.evenements.push(e)));
      return json(200, { acceptes: evts.length - erreurs.length, erreurs });
    }
    if (req.url === '/api/v1/battement') {
      recus.battements.push(JSON.parse(corps));
      return json(200, { ok: true });
    }
    if (req.url.startsWith('/api/v1/import.csv')) {
      if (!corps.startsWith('ligne')) return json(400, { erreur: 'Colonne « ligne » absente' });
      recus.csv.push(corps);
      return json(200, { acceptes: corps.trim().split('\n').length - 1, erreurs: [] });
    }
    if (req.url === '/api/v1/lignes') return json(200, [{ code: 'PR3' }]);
    json(404, {});
  });
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${serveur.address().port}`, recus, etat, fermer: () => new Promise((r) => serveur.close(r)) };
}

export async function attendre(cond, ms = 8000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('délai dépassé');
}

export const silence = () => {};
