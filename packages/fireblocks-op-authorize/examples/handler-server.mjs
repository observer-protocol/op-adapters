// Minimal reference callback-handler server for a Fireblocks API Co-Signer.
//
// The co-signer POSTs a signed JWT (the request body) to this endpoint before
// signing a transaction. We evaluate it against the OP mandate and answer with
// a signed JWT: 200 + body = APPROVE/REJECT. On an unverifiable inbound JWT we
// answer non-2xx with no signed body, so the co-signer's 30-second timeout
// cancels the transaction (fail-closed by the platform, not by us).
//
// Keys are read from managed file paths given by env, NEVER inlined. Point the
// co-signer's callback URL at this server.
//
//   FB_COSIGNER_PUBKEY_PEM   path to the co-signer's RS256 public key (SPKI PEM)
//   FB_HANDLER_PRIVKEY_PEM   path to this handler's RS256 private key (PKCS8 PEM)
//   OP_POLICY_JSON           path to the OP verifier policy JSON
//   OP_CROSSRAIL_LEDGER      path to the shared CrossRailLedger JSONL
//   PORT                     listen port (default 8080)

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createFireblocksHandler } from '@observer-protocol/fireblocks-op-authorize';

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing required env ${k}`);
  return v;
};

const handler = await createFireblocksHandler({
  policy: JSON.parse(readFileSync(env('OP_POLICY_JSON'), 'utf8')),
  cosignerPublicKeyPem: readFileSync(env('FB_COSIGNER_PUBKEY_PEM'), 'utf8'),
  handlerPrivateKeyPem: readFileSync(env('FB_HANDLER_PRIVKEY_PEM'), 'utf8'),
  crossRailLedgerPath: process.env.OP_CROSSRAIL_LEDGER,
});

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data.trim()));
    req.on('error', reject);
  });

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end('POST only');
    return;
  }
  const inboundJwt = await readBody(req);
  const result = await handler.handle(inboundJwt);
  if (result.kind === 'signed') {
    // 200 + the signed response JWT as the body.
    res.writeHead(200, { 'content-type': 'application/jwt' }).end(result.jwt);
    console.log(`[${result.action}] ${result.requestId}: ${result.reason}`);
  } else {
    // No valid signed answer: the co-signer will time out and CANCEL.
    res.writeHead(result.httpStatus).end(result.reason);
    console.warn(`[NO-RESPONSE ${result.httpStatus}] ${result.reason} (co-signer will cancel on 30s timeout)`);
  }
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`fireblocks-op-authorize handler listening on :${port}`));
