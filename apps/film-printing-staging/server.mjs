import http from 'node:http';
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { quoteSynthetic } from './shared/rates.js';
import { SPECS, propertiesFor } from './shared/jobs.js';

mkdirSync(new URL('./runtime/', import.meta.url), { recursive: true });
const events = new URL('./runtime/callbacks.jsonl', import.meta.url);
const modeFile = new URL('./runtime/rate-mode.json', import.meta.url);
let sequence = 0;
const safeValues = new Set(Object.keys(SPECS).flatMap(spec => Object.values(propertiesFor(spec, 'f02-A'))));
function safeProperties(properties) {
  if (properties == null) return null;
  const pairs = Array.isArray(properties) ? properties.map(p => [p.name, p.value]) : Object.entries(properties);
  return Object.fromEntries(pairs.map(([key, value]) => [key,
    safeValues.has(value) || /^f02-[a-zA-Z0-9-]{1,60}$/.test(String(value)) || /^\d{1,12}$/.test(String(value))
      ? value : '[redacted]']));
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"scope":"F02 synthetic staging","ok":true}'); return;
  }
  if (req.method !== 'POST' || req.url !== '/rates') { res.writeHead(404); res.end(); return; }
  let raw = '';
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 65536) { res.writeHead(413); res.end(); return; }
    }
    const body = JSON.parse(raw);
    let mode = 'normal';
    try { mode = JSON.parse(readFileSync(modeFile, 'utf8')).mode; } catch {}
    const response = mode === 'empty' ? { rates: [] } : quoteSynthetic(body);
    // Synthetic item payloads only. Drop all address/contact/token/header values.
    const safeItems = (body.rate?.items ?? []).map(item => ({
      variant_id: item.variant_id, product_id: item.product_id, quantity: item.quantity,
      grams: item.grams, price: item.price, requires_shipping: item.requires_shipping,
      itemKeys: Object.keys(item), properties: safeProperties(item.properties),
    }));
    appendFileSync(events, JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(),
      mode, headerNames: Object.keys(req.headers), requestKeys: Object.keys(body.rate ?? {}),
      origin: { country: body.rate?.origin?.country, postal_code: body.rate?.origin?.postal_code },
      destination: { country: body.rate?.destination?.country, province: body.rate?.destination?.province },
      items: safeItems, currency: body.rate?.currency, response }) + '\n');
    if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 12000));
    res.writeHead(mode === 'error' ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  } catch { res.writeHead(400); res.end('{"rates":[]}'); }
});
server.listen(6070, '127.0.0.1', () => console.log('F02 synthetic callback on 127.0.0.1:6070; only /rates and /health exposed'));
