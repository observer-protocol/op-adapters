// End-to-end acceptance test, self-contained (no network, no live Fireblocks).
// Drives the FULL handler path — a co-signer-signed JWT in, a signed APPROVE/
// REJECT out — through verifyCredential + enforceMandate + the shared
// CrossRailLedger, exactly as a real co-signer would. The acceptance criterion
// is allow / allow / deny-over-cap under ONE signed mandate.
//
// The eddsa-jcs-2022 credential signer below is the sanctioned test approach
// (lifted from l402-op-authorize/test/fixtures/gen.mjs): the package ships no
// credential signer, only verify primitives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as edSign, createHash } from 'node:crypto';
import { importPKCS8, SignJWT, jwtVerify, importSPKI } from 'jose';
import { createFireblocksHandler } from '../dist/index.js';

// ---- test-only eddsa-jcs-2022 signer (did:key) ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => {
  let x = 0n;
  for (const b of buf) x = x * 256n + BigInt(b);
  let o = '';
  while (x > 0n) { o = B58[Number(x % 58n)] + o; x /= 58n; }
  for (const b of buf) { if (b === 0) o = '1' + o; else break; }
  return o;
};
const sortKeys = (o) =>
  Array.isArray(o) ? o.map(sortKeys) : (o && typeof o === 'object' ? Object.keys(o).sort().reduce((a, k) => { a[k] = sortKeys(o[k]); return a; }, {}) : o);
const jcs = (o) => Buffer.from(JSON.stringify(sortKeys(o)), 'utf8');
const sha = (b) => createHash('sha256').update(b).digest();
function makeAgent() {
  const kp = generateKeyPairSync('ed25519');
  const pub = Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const did = 'did:key:z' + b58(Buffer.concat([Buffer.from([0xed, 0x01]), pub]));
  return { did, privateKey: kp.privateKey, vm: did + '#' + did.slice('did:key:'.length) };
}
function signCred(doc, priv, vm) {
  const po = { '@context': doc['@context'], type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: '2026-06-15T00:00:00Z', verificationMethod: vm, proofPurpose: 'assertionMethod' };
  const hashData = Buffer.concat([sha(jcs(po)), sha(jcs(doc))]);
  return { ...doc, proof: { ...po, proofValue: 'z' + b58(edSign(null, hashData, priv)) } };
}

const rsaPem = () =>
  generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fb-op-e2e-'));
  const principal = makeAgent();
  const agent = makeAgent();
  const SCHEMA = 'https://observerprotocol.org/schemas/delegation/v2.3.json';

  const cred = signCred({
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: 'urn:uuid:fb-e2e-1',
    type: ['VerifiableCredential', 'ObserverDelegationCredential'],
    issuer: principal.did,
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: '2027-01-01T00:00:00Z',
    credentialSchema: { id: SCHEMA, type: 'JsonSchema' },
    credentialSubject: {
      id: agent.did,
      authorizationLevel: 'policy',
      authorizationConfig: { policy: { policy_id: 'fb-test', rail_preference: ['fireblocks'] } },
      actionScope: { allowed_rails: ['fireblocks'] },
      delegationScope: { may_delegate_further: false },
      enforcementMode: 'pre_transaction_check',
      // Cap 5 USD; USDC priced 1:1. Amounts of 2 USDC each: 2, 4, then 6 > 5.
      tradingMandate: { crossRailBudget: { amount: '5', currency: 'USD', window: 'P1D', rates: { USDC: '1' } } },
    },
  }, principal.privateKey, principal.vm);

  const credPath = join(dir, 'cred.json');
  writeFileSync(credPath, JSON.stringify(cred));

  const policy = {
    credentialPath: credPath,
    issuerDid: principal.did,
    schemaAllowlist: [SCHEMA],
    revocation: { maxStalenessHours: 24, onUnreachable: 'cache-then-deny', fetchTimeoutMs: 1500 },
    cacheDir: join(dir, 'cache'),
    auditLog: join(dir, 'audit.jsonl'),
    rails: { fireblocks: { rail: 'fireblocks', currency: 'USDC', decimals: 6, family: 'evm' } },
    allowContractCalls: false,
  };

  const cosigner = rsaPem();
  const handlerKp = rsaPem();
  const handler = await createFireblocksHandler({
    policy,
    cosignerPublicKeyPem: cosigner.publicKey,
    handlerPrivateKeyPem: handlerKp.privateKey,
    crossRailLedgerPath: join(dir, 'cross-rail-ledger.jsonl'),
    railId: 'fireblocks',
  });

  const cosignerPriv = await importPKCS8(cosigner.privateKey, 'RS256');
  const handlerPub = await importSPKI(handlerKp.publicKey, 'RS256');
  // Sign an inbound co-signer request JWT with the given claims.
  const inbound = (claims, signerKey = cosignerPriv) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().sign(signerKey);

  return { handler, inbound, handlerPub, badCosignerPriv: async () => importPKCS8(rsaPem().privateKey, 'RS256') };
}

let n = 0;
const transfer = (amountStr) => ({ txId: `tx-${++n}`, requestId: `req-${n}`, operation: 'TRANSFER', asset: 'USDC_ETH_TEST5', amountStr, destAddress: '0xMerchant', sourceId: 'vault-0' });

test('acceptance: allow, allow, deny-over-cap under one mandate (full handler path)', async () => {
  const { handler, inbound, handlerPub } = await setup();

  // call 1: 2/5 USD -> APPROVE
  const r1 = await handler.handle(await inbound(transfer('2')));
  assert.equal(r1.kind, 'signed');
  assert.equal(r1.action, 'APPROVE', `call 1 expected APPROVE, got ${r1.action}: ${r1.reason}`);

  // call 2: 4/5 USD -> APPROVE
  const r2 = await handler.handle(await inbound(transfer('2')));
  assert.equal(r2.action, 'APPROVE', `call 2 expected APPROVE, got ${r2.action}: ${r2.reason}`);

  // call 3: 6/5 USD -> REJECT for cross-rail cap
  const r3 = await handler.handle(await inbound(transfer('2')));
  assert.equal(r3.action, 'REJECT', `call 3 expected REJECT, got ${r3.action}: ${r3.reason}`);
  assert.match(r3.reason, /\[cross-rail\]/, `deny reason should cite cross-rail, got: ${r3.reason}`);

  // the APPROVE response is a real JWT the co-signer can verify with our pubkey
  const { payload } = await jwtVerify(r1.jwt, handlerPub, { algorithms: ['RS256'] });
  assert.equal(payload.action, 'APPROVE');
  assert.equal(payload.requestId, 'req-1');
});

test('loud failure: unknown asset id denies and names itself (decode-mismatch)', async () => {
  const { handler, inbound } = await setup();
  const r = await handler.handle(await inbound({ txId: 't', requestId: 'r-x', operation: 'TRANSFER', asset: 'MYSTERY_TESTX', amountStr: '1', destAddress: '0xabc', sourceId: 'v' }));
  assert.equal(r.action, 'REJECT');
  assert.match(r.reason, /\[decode-mismatch\] unrecognized Fireblocks asset id MYSTERY_TESTX/);
});

test('fail-closed: an inbound JWT signed by a non-co-signer key gets no signed answer', async () => {
  const { handler, inbound, badCosignerPriv } = await setup();
  const forged = await inbound(transfer('2'), await badCosignerPriv());
  const r = await handler.handle(forged);
  assert.equal(r.kind, 'no-response');
  assert.equal(r.httpStatus, 401);
});
