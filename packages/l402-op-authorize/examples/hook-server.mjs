// Minimal node http wrapper for the vendor-neutral L402 pre-payment hook.
// Run it next to lnget and point lnget's PRE_PAYMENT_HOOK_URL at it — no
// Lightning Labs code changes. It loads a VerifierConfig (here, the generated
// test fixture) and returns allow (200) / deny (402) for each proposed payment.
//
//   node examples/hook-server.mjs            # then POST proposals to /hook
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleL402PaymentHook } from '../dist/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.OP_CONFIG ?? join(here, '..', 'test', 'fixtures', 'out', 'verifier-config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const port = Number(process.env.PORT ?? 8787);

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/hook') { res.writeHead(404); return res.end(); }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    let resp;
    try { resp = await handleL402PaymentHook(config, JSON.parse(body || '{}')); }
    catch (e) { resp = { decision: 'deny', reason: `[hook] fail-closed: ${e.message}`, notes: [] }; }
    res.writeHead(resp.decision === 'allow' ? 200 : 402, { 'content-type': 'application/json' });
    res.end(JSON.stringify(resp));
  });
}).listen(port, () => console.error(`OP L402 pre-payment hook listening on http://127.0.0.1:${port}/hook`));
