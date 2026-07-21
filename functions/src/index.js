const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2/options');
const admin = require('firebase-admin');
const cheerio = require('cheerio');

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: 'europe-west1', memory: '512MiB', timeoutSeconds: 120, maxInstances: 2 });

const SOURCES = [
  { store: 'Hofer', url: 'https://www.hofer.si/aktualni-letaki-in-brosure' },
  { store: 'Lidl', url: 'https://www.lidl.si/c/spletni-katalog/s10019133' },
  { store: 'Spar', url: 'https://www.spar.si/letak' }
];
const UA = 'Mozilla/5.0 (compatible; MojaTrgovinaPriceBot/1.0; +https://mojatrgovina-35fd1.web.app)';

function clean(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function parsePrice(v) {
  const m = clean(v).replace(/\./g, '').replace(',', '.').match(/(?:^|\s)(\d{1,4}(?:\.\d{1,2})?)\s*€/);
  return m ? Number(m[1]) : null;
}
function slug(v) { return clean(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 140); }
function quantity(name) {
  const m = clean(name).match(/(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml|cl|kos)/i);
  if (!m) return {};
  return { amount: Number(m[1].replace(',', '.')), unit: m[2].toLowerCase() };
}
function unitPrice(price, amount, unit) {
  if (!amount || !unit) return null;
  if (unit === 'g') return +(price / (amount / 1000)).toFixed(2);
  if (unit === 'ml') return +(price / (amount / 1000)).toFixed(2);
  if (unit === 'cl') return +(price / (amount / 100)).toFixed(2);
  if (unit === 'kg' || unit === 'l') return +(price / amount).toFixed(2);
  return null;
}
function addProduct(out, p) {
  const name = clean(p.name); const price = Number(p.price);
  if (name.length < 3 || !Number.isFinite(price) || price <= 0 || price > 10000) return;
  const q = quantity(name);
  const key = `${slug(name)}-${slug(p.store)}`;
  if (!key || out.has(key)) return;
  out.set(key, { id: key, name, store: p.store, price, currency: 'EUR', amount: q.amount || null, unit: q.unit || null,
    unitPrice: unitPrice(price, q.amount, q.unit), sourceUrl: p.sourceUrl, imageUrl: p.imageUrl || null,
    validFrom: p.validFrom || null, validUntil: p.validUntil || null, collectedAt: new Date().toISOString() });
}
function walkJsonLd(node, store, url, out) {
  if (!node) return;
  if (Array.isArray(node)) return node.forEach(x => walkJsonLd(x, store, url, out));
  if (typeof node !== 'object') return;
  const type = String(node['@type'] || '').toLowerCase();
  if (type.includes('product') || node.offers) {
    const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    const price = offer && Number(String(offer.price || offer.lowPrice || '').replace(',', '.'));
    addProduct(out, { name: node.name, price, store, sourceUrl: url, imageUrl: Array.isArray(node.image) ? node.image[0] : node.image });
  }
  Object.values(node).forEach(v => walkJsonLd(v, store, url, out));
}
async function scrapeSource(source) {
  const response = await fetch(source.url, { headers: { 'user-agent': UA, 'accept-language': 'sl-SI,sl;q=0.9,en;q=0.5' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`${source.store}: HTTP ${response.status}`);
  const html = await response.text(); const $ = cheerio.load(html); const out = new Map();
  $('script[type="application/ld+json"]').each((_, el) => { try { walkJsonLd(JSON.parse($(el).text()), source.store, source.url, out); } catch (_) {} });
  $('[class*="product"], [class*="offer"], article').each((_, el) => {
    const text = clean($(el).text()); const price = parsePrice(text);
    if (!price) return;
    const name = clean($(el).find('h1,h2,h3,h4,[class*="title"],[class*="name"]').first().text()) || text.split(/\s{2,}|\d+[,.]\d+\s*€/)[0];
    const img = $(el).find('img').first().attr('src') || $(el).find('img').first().attr('data-src');
    addProduct(out, { name, price, store: source.store, sourceUrl: source.url, imageUrl: img });
  });
  return [...out.values()];
}
async function collectAll(trigger) {
  const results = []; const status = [];
  for (const source of SOURCES) {
    try { const items = await scrapeSource(source); results.push(...items); status.push({ store: source.store, ok: true, count: items.length }); }
    catch (e) { status.push({ store: source.store, ok: false, count: 0, error: String(e.message || e) }); }
  }
  const batchSize = 400;
  for (let i = 0; i < results.length; i += batchSize) {
    const batch = db.batch();
    results.slice(i, i + batchSize).forEach(p => {
      const ref = db.collection('publicPrices').doc(p.id);
      batch.set(ref, { ...p, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      const hist = ref.collection('history').doc(new Date().toISOString().slice(0, 10));
      batch.set(hist, { price: p.price, unitPrice: p.unitPrice, collectedAt: p.collectedAt, sourceUrl: p.sourceUrl }, { merge: true });
    });
    await batch.commit();
  }
  await db.collection('priceCollector').doc('status').set({ trigger, total: results.length, sources: status, completedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { total: results.length, sources: status };
}
async function isAuthenticated(req) {
  const h = req.headers.authorization || ''; if (!h.startsWith('Bearer ')) return false;
  try { await admin.auth().verifyIdToken(h.slice(7)); return true; } catch (_) { return false; }
}
function cors(res) { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.set('Cache-Control', 'no-store'); }
exports.getPrices = onRequest(async (req, res) => {
  cors(res); if (req.method === 'OPTIONS') return res.status(204).send('');
  try {
    const snap = await db.collection('publicPrices').orderBy('collectedAt', 'desc').limit(10000).get();
    const products = snap.docs.map(d => d.data()); const s = await db.collection('priceCollector').doc('status').get();
    res.json({ source: 'Firebase strežniški zbiralnik', updatedAt: s.exists && s.data().completedAt ? s.data().completedAt.toDate().toISOString().slice(0,10) : null, products, collector: s.exists ? s.data() : null });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
exports.refreshPrices = onRequest(async (req, res) => {
  cors(res); if (req.method === 'OPTIONS') return res.status(204).send('');
  if (!(await isAuthenticated(req))) return res.status(401).json({ error: 'Za ročno osvežitev se prijavi z Googlom.' });
  try { res.json(await collectAll('manual')); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
exports.scheduledPriceCollector = onSchedule({ schedule: 'every day 03:15', timeZone: 'Europe/Ljubljana' }, async () => collectAll('schedule'));
