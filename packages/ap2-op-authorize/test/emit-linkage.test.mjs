import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
// L4 acceptance: Emit (OP mandate -> AP2, never broader) and the anchor-model-B
// linkage credential (P-256 AP2 key bound to the DID by an eddsa-jcs-2022
// signature over the exact JWK). The full-chain test is the money shot:
// linkage -> trusted JWK -> an emitted mandate authorizes through the same
// engine that verifies inbound AP2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateES256KeyPair } from '@observer-protocol/sd-jwt-substrate';
import { emitAp2Mandate, issueAp2KeyLinkage, verifyAp2KeyLinkage, authorizeAp2Payment } from '../dist/index.js';

// Every allow path now requires a cross-rail ledger path: this engine will not
// authorize a spend it cannot record (see authorize.ts step 5). A fresh path
// per call keeps tests independent of each other's recorded spend.
const withLedger = (cfg) => ({ ...cfg, crossRailLedgerPath: join(mkdtempSync(join(tmpdir(), 'ap2-t-')), 'ledger.jsonl') });


// did:key dev identity for the DID side (test-only signer recipe, same as the
// policy-engine fixtures).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => {
  let x = 0n;
  for (const b of buf) x = x * 256n + BigInt(b);
  let o = '';
  while (x > 0n) { o = B58[Number(x % 58n)] + o; x /= 58n; }
  for (const b of buf) { if (b === 0) o = '1' + o; else break; }
  return o;
};
function makeDidKey() {
  const kp = generateKeyPairSync('ed25519');
  const pub = Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const did = 'did:key:z' + b58(Buffer.concat([Buffer.from([0xed, 0x01]), pub]));
  return { did, privateKey: kp.privateKey, vm: did + '#' + did.slice('did:key:'.length) };
}

const OP_MANDATE = {
  actionScope: { per_transaction_ceiling: { amount: '50', currency: 'USD' } },
  tradingMandate: { counterparty: { allowList: ['merchant-1'] } },
  validUntil: '2030-01-01T00:00:00Z',
};

test('emit -> our own L2 enforcement: full circle allow/deny', async () => {
  const ap2Key = await generateES256KeyPair();
  const agent = await generateES256KeyPair();
  const emitted = await emitAp2Mandate({
    op: OP_MANDATE,
    ap2SigningJwk: ap2Key.privateJwk,
    kid: ap2Key.kid,
    agentCnfJwk: agent.publicJwk,
  });
  assert.equal(emitted.ok, true, emitted.ok ? '' : emitted.reason);

  const cfg = withLedger({ issuerPublicJwk: ap2Key.publicJwk });
  const allow = await authorizeAp2Payment(cfg, { token: emitted.token, proposal: { payeeId: 'merchant-1', amountMinor: 2000, currency: 'USD' } });
  assert.equal(allow.allow, true, allow.reason);
  const overCap = await authorizeAp2Payment(cfg, { token: emitted.token, proposal: { payeeId: 'merchant-1', amountMinor: 6000, currency: 'USD' } });
  assert.equal(overCap.allow, false);
  assert.match(overCap.reason, /ceiling/);
  const wrongPayee = await authorizeAp2Payment(cfg, { token: emitted.token, proposal: { payeeId: 'mallory', amountMinor: 2000, currency: 'USD' } });
  assert.equal(wrongPayee.allow, false);
});

test('emit refuses to broaden: velocity, temporal, blockList, lossy amounts', async () => {
  const ap2Key = await generateES256KeyPair();
  const agent = await generateES256KeyPair();
  const base = { ap2SigningJwk: ap2Key.privateJwk, agentCnfJwk: agent.publicJwk };

  const vel = await emitAp2Mandate({ ...base, op: { ...OP_MANDATE, tradingMandate: { ...OP_MANDATE.tradingMandate, velocity: { dailyVolumeCap: 100 } } } });
  assert.equal(vel.ok, false);
  assert.match(vel.reason, /velocity/);

  const temp = await emitAp2Mandate({ ...base, op: { ...OP_MANDATE, tradingMandate: { ...OP_MANDATE.tradingMandate, temporal: { allowedTimeWindows: [] } } } });
  assert.equal(temp.ok, false);
  assert.match(temp.reason, /temporal/);

  const block = await emitAp2Mandate({ ...base, op: { ...OP_MANDATE, tradingMandate: { counterparty: { blockList: ['bad'] } } } });
  assert.equal(block.ok, false);
  assert.match(block.reason, /allow-lists only/);

  const lossy = await emitAp2Mandate({ ...base, op: { actionScope: { per_transaction_ceiling: { amount: '50.001', currency: 'USD' } } } });
  assert.equal(lossy.ok, false);
  assert.match(lossy.reason, /not exactly representable/);
});

test('linkage: issue -> verify, and every fail side', async () => {
  const opDid = makeDidKey();
  const ap2Key = await generateES256KeyPair();
  const cred = issueAp2KeyLinkage({
    did: opDid.did,
    verificationMethod: opDid.vm,
    signingKey: opDid.privateKey,
    ap2Issuer: 'https://observerprotocol.org',
    ap2PublicJwk: ap2Key.publicJwk,
  });
  const ok = await verifyAp2KeyLinkage({ credential: cred, expectedDid: opDid.did });
  assert.equal(ok.ok, true, ok.ok ? '' : ok.reason);
  assert.deepEqual(ok.jwk, ap2Key.publicJwk);

  // wrong expected DID
  const other = makeDidKey();
  const wrongDid = await verifyAp2KeyLinkage({ credential: cred, expectedDid: other.did });
  assert.equal(wrongDid.ok, false);

  // tampered JWK (swap in another key after signing)
  const mallory = await generateES256KeyPair();
  const tampered = JSON.parse(JSON.stringify(cred));
  tampered.credentialSubject.jwk = mallory.publicJwk;
  const t = await verifyAp2KeyLinkage({ credential: tampered, expectedDid: opDid.did });
  assert.equal(t.ok, false);
  assert.match(t.reason, /proof failed/);

  // signed by a key NOT in the DID's assertionMethod (a different did:key's key)
  const forged = issueAp2KeyLinkage({
    did: opDid.did,
    verificationMethod: other.vm,
    signingKey: other.privateKey,
    ap2Issuer: 'https://observerprotocol.org',
    ap2PublicJwk: ap2Key.publicJwk,
  });
  const f = await verifyAp2KeyLinkage({ credential: forged, expectedDid: opDid.did });
  assert.equal(f.ok, false);

  // expired
  const expired = issueAp2KeyLinkage({
    did: opDid.did,
    verificationMethod: opDid.vm,
    signingKey: opDid.privateKey,
    ap2Issuer: 'https://observerprotocol.org',
    ap2PublicJwk: ap2Key.publicJwk,
    validFrom: '2020-01-01T00:00:00Z',
    validUntil: '2021-01-01T00:00:00Z',
  });
  const e = await verifyAp2KeyLinkage({ credential: expired, expectedDid: opDid.did });
  assert.equal(e.ok, false);
  assert.match(e.reason, /expired/);

  // a linkage that tries to bind a PRIVATE key is refused at issue time
  assert.throws(() => issueAp2KeyLinkage({
    did: opDid.did,
    verificationMethod: opDid.vm,
    signingKey: opDid.privateKey,
    ap2Issuer: 'https://observerprotocol.org',
    ap2PublicJwk: ap2Key.privateJwk,
  }), /PUBLIC keys only/);
});

test('FULL CHAIN: DID -> linkage -> trusted JWK -> emitted mandate authorizes', async () => {
  const opDid = makeDidKey();
  const ap2Key = await generateES256KeyPair();
  const agent = await generateES256KeyPair();

  // 1. OP binds its AP2 key to its DID.
  const linkage = issueAp2KeyLinkage({
    did: opDid.did,
    verificationMethod: opDid.vm,
    signingKey: opDid.privateKey,
    ap2Issuer: 'https://observerprotocol.org',
    ap2PublicJwk: ap2Key.publicJwk,
  });
  // 2. A relying party that trusts the DID derives the AP2 trust root.
  const trust = await verifyAp2KeyLinkage({ credential: linkage, expectedDid: opDid.did });
  assert.equal(trust.ok, true, trust.ok ? '' : trust.reason);
  // 3. OP emits its mandate as AP2, signed by the linked key.
  const emitted = await emitAp2Mandate({ op: OP_MANDATE, ap2SigningJwk: ap2Key.privateJwk, kid: ap2Key.kid, agentCnfJwk: agent.publicJwk });
  assert.equal(emitted.ok, true, emitted.ok ? '' : emitted.reason);
  // 4. The relying party enforces against it using ONLY the linkage-derived key.
  const verdict = await authorizeAp2Payment(withLedger({ issuerPublicJwk: trust.jwk }), { token: emitted.token, proposal: { payeeId: 'merchant-1', amountMinor: 2500, currency: 'USD' } });
  assert.equal(verdict.allow, true, verdict.reason);
  // ...and a key NOT anointed by the linkage does not verify the token.
  const stranger = await generateES256KeyPair();
  const distrust = await authorizeAp2Payment({ issuerPublicJwk: stranger.publicJwk }, { token: emitted.token, proposal: { payeeId: 'merchant-1', amountMinor: 2500, currency: 'USD' } });
  assert.equal(distrust.allow, false);
});

// ---- Oracle gate: OUR emitted mandate verifies in the AP2 reference SDK ----
const AP2_PY = process.env.AP2_PY;
const AP2_SDK_PATH = process.env.AP2_SDK_PATH;
const helper = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'op-policy-engine', 'packages', 'sd-jwt-substrate', 'test', 'rt_helper.py');

test('interop: an EMITTED mandate verifies in the Python reference SDK', { skip: !(AP2_PY && AP2_SDK_PATH) && 'AP2_PY/AP2_SDK_PATH not set — interop gate not run' }, async () => {
  const ap2Key = await generateES256KeyPair();
  const agent = await generateES256KeyPair();
  const emitted = await emitAp2Mandate({ op: OP_MANDATE, ap2SigningJwk: ap2Key.privateJwk, kid: ap2Key.kid, agentCnfJwk: agent.publicJwk });
  assert.equal(emitted.ok, true, emitted.ok ? '' : emitted.reason);
  const { d: _d, ...issuerPub } = ap2Key.privateJwk;
  const res = spawnSync(AP2_PY, [helper], {
    input: JSON.stringify({ mode: 'verify', token: emitted.token, issuer_public_jwk: issuerPub }),
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: AP2_SDK_PATH },
    timeout: 60_000,
  });
  const r = JSON.parse(res.stdout.trim().split('\n').at(-1));
  assert.equal(r.ok, true, `AP2 SDK rejected our emitted mandate: ${r.error}`);
  const flat = JSON.stringify(r.payloads);
  assert.match(flat, /payment\.amount_range/);
  assert.match(flat, /merchant-1/);
});
