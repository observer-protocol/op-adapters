// L2 acceptance: an inbound AP2 Open Payment Mandate drives the SAME policy
// core as every other rail, fail-closed, and allowed spends debit the shared
// cross-rail ledger. Includes an oracle-gated interop case: a mandate created
// by the AP2 reference SDK (Python) authorizes here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateES256KeyPair, issueAp2MandateToken } from '@observer-protocol/sd-jwt-substrate';
import { CrossRailLedger } from '@observer-protocol/policy-engine';
import { authorizeAp2Payment, normalizeAp2Constraints } from '../dist/index.js';

// Every allow path now requires a cross-rail ledger path: this engine will not
// authorize a spend it cannot record (see authorize.ts step 5). A fresh path
// per call keeps tests independent of each other's recorded spend.
const withLedger = (cfg) => ({ ...cfg, crossRailLedgerPath: join(mkdtempSync(join(tmpdir(), 'ap2-t-')), 'ledger.jsonl') });


const OCC = 'occ-digest-123';
const MANDATE = {
  vct: 'mandate.payment.open.1',
  constraints: [
    { type: 'payment.amount_range', currency: 'USD', max: 5000, min: 100 }, // 1.00..50.00 USD
    { type: 'payment.allowed_payees', allowed: [{ id: 'merchant-1', name: 'Coffee' }, { id: 'merchant-2', name: 'Books' }] },
    { type: 'payment.reference', conditional_transaction_id: OCC },
  ],
  cnf: { jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } },
};

async function setup(extra = {}) {
  const issuer = await generateES256KeyPair();
  const token = await issueAp2MandateToken({ mandate: { ...MANDATE, ...extra }, issuerPrivateJwk: issuer.privateJwk });
  const { d: _d, ...issuerPub } = issuer.privateJwk;
  return { token, issuerPub, issuer };
}

const proposal = (amountMinor, payeeId = 'merchant-1') => ({ payeeId, amountMinor, currency: 'USD' });

test('allow: within range, allowed payee, chain link matches', async () => {
  const { token, issuerPub } = await setup();
  const v = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token, proposal: proposal(2000), expectedConditionalTransactionId: OCC });
  assert.equal(v.allow, true, v.reason);
});

test('deny: over per-transaction ceiling / under min / wrong payee', async () => {
  const { token, issuerPub } = await setup();
  const over = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token, proposal: proposal(6000), expectedConditionalTransactionId: OCC });
  assert.equal(over.allow, false);
  assert.match(over.reason, /ceiling/);
  const under = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token, proposal: proposal(50), expectedConditionalTransactionId: OCC });
  assert.equal(under.allow, false);
  assert.match(under.reason, /below amount_range\.min/);
  const wrongPayee = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token, proposal: proposal(2000, 'mallory'), expectedConditionalTransactionId: OCC });
  assert.equal(wrongPayee.allow, false);
  assert.match(wrongPayee.reason, /counterparty|allowList|allow list/i);
});

test('deny: reference link — missing caller digest, and mismatched digest', async () => {
  const { token, issuerPub } = await setup();
  const missing = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token, proposal: proposal(2000) });
  assert.equal(missing.allow, false);
  assert.match(missing.reason, /no checkout digest/);
  const wrong = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token, proposal: proposal(2000), expectedConditionalTransactionId: 'other' });
  assert.equal(wrong.allow, false);
  assert.match(wrong.reason, /chain mismatch/);
});

test('deny: budget constraint (deliberate v1), unknown constraint, wrong vct, wrong issuer key', async () => {
  const { issuerPub, issuer } = await setup();
  const budgetTok = await issueAp2MandateToken({ mandate: { ...MANDATE, constraints: [...MANDATE.constraints, { type: 'payment.budget', max: 100, currency: 'USD' }] }, issuerPrivateJwk: issuer.privateJwk });
  const b = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token: budgetTok, proposal: proposal(2000), expectedConditionalTransactionId: OCC });
  assert.equal(b.allow, false);
  assert.match(b.reason, /LIFETIME cap.*under-enforce/);

  const unknownTok = await issueAp2MandateToken({ mandate: { ...MANDATE, constraints: [{ type: 'payment.hologram', x: 1 }] }, issuerPrivateJwk: issuer.privateJwk });
  const u = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token: unknownTok, proposal: proposal(2000) });
  assert.equal(u.allow, false);
  assert.match(u.reason, /unknown constraint type "payment\.hologram"/);

  const closedTok = await issueAp2MandateToken({ mandate: { vct: 'mandate.payment.1', transaction_id: 't', payee: { id: 'm', name: 'M' }, payment_amount: { amount: 1, currency: 'USD' }, payment_instrument: { id: 'p', type: 'card' } }, issuerPrivateJwk: issuer.privateJwk });
  const c = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token: closedTok, proposal: proposal(2000) });
  assert.equal(c.allow, false);
  assert.match(c.reason, /not an Open Payment Mandate/);

  const stranger = await generateES256KeyPair();
  const { token } = await setup();
  const s = await authorizeAp2Payment(withLedger({ issuerPublicJwk: stranger.publicJwk }), { token, proposal: proposal(2000), expectedConditionalTransactionId: OCC });
  assert.equal(s.allow, false);
  assert.match(s.reason, /\[ap2-verify\]/);
});

test('shared ledger: AP2-leg allows debit the same cross-rail budget other rails read', async () => {
  const { token, issuerPub } = await setup();
  const dir = mkdtempSync(join(tmpdir(), 'ap2-ledger-'));
  const ledgerPath = join(dir, 'cross-rail.jsonl');
  const cfg = { issuerPublicJwk: issuerPub, crossRailLedgerPath: ledgerPath };
  const a1 = await authorizeAp2Payment(cfg, { token, proposal: proposal(2000), expectedConditionalTransactionId: OCC });
  const a2 = await authorizeAp2Payment(cfg, { token, proposal: proposal(1500), expectedConditionalTransactionId: OCC });
  assert.equal(a1.allow, true, a1.reason);
  assert.equal(a2.allow, true, a2.reason);
  // Read the ledger exactly the way the other engines do for a crossRailBudget
  // denominated in USD with principal-attested rate USD:1.
  const ledger = new CrossRailLedger(ledgerPath);
  const sum = ledger.sumWindowConverted({ USD: '1' });
  assert.equal(sum.ok, true);
  // 20.00 + 15.00 USD at CROSS_RAIL_SCALE (1e6/unit) = 35_000_000
  assert.equal(sum.total, 35000000n, `expected 35 USD scaled, got ${sum.total}`);
});

// ---- The mandate floor: no enforceable amount bound, no authorization ----
// Closes AP2-D6. `constraints: []` normalized to an empty scope, the core had
// nothing to enforce, and an unbounded payment to an arbitrary payee was
// allowed. The bar is on the normalized OUTPUT, not the input count: a single
// entry that restricts nothing, or a payee list with no ceiling, is the same
// fall-open one constraint deeper.

const UNBOUNDED = { payeeId: 'mallory', amountMinor: 999999999, currency: 'USD' };

test('deny: a mandate carrying no enforceable amount bound does not authorize', async () => {
  const noBound = [
    ['empty constraint list', []],
    ['every entry restricts nothing', [{ type: 'payment.agent_recurrence', frequency: 'ON_DEMAND' }]],
    ['payee bound but no amount bound', [{ type: 'payment.allowed_payees', allowed: [{ id: 'mallory', name: 'M' }] }]],
  ];
  for (const [label, constraints] of noBound) {
    const { token, issuerPub } = await setup({ constraints });
    const v = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token, proposal: UNBOUNDED });
    assert.equal(v.allow, false, `${label}: authorized an unbounded payment — ${v.reason}`);
    assert.match(v.reason, /no enforceable amount bound/, label);
  }

  // The asymmetry AP2-D6 named is now closed in the correct direction: the
  // malformed input and the empty one both deny, and they deny distinctly.
  const { token, issuerPub } = await setup({ constraints: undefined });
  const absent = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token, proposal: UNBOUNDED });
  assert.equal(absent.allow, false);
  assert.match(absent.reason, /constraints is not an array/);
});

test('allow (control): the SAME unbounded proposal authorizes once an amount bound is present', async () => {
  // Isolates the variable. Same payee, same 9,999,999.99 USD, same everything
  // except one `payment.amount_range` — so the deny above is caused by the
  // missing bound, not by the amount or the payee.
  const { token, issuerPub } = await setup({ constraints: [{ type: 'payment.amount_range', currency: 'USD', max: 1000000000 }] });
  const v = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token, proposal: UNBOUNDED });
  assert.equal(v.allow, true, v.reason);

  // And the bound it supplied is live, not decorative.
  const over = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token, proposal: { ...UNBOUNDED, amountMinor: 1000000001 } });
  assert.equal(over.allow, false);
  assert.match(over.reason, /ceiling/);
});

test('normalize: the floor is applied to the normalized output, both sides', () => {
  const p = { payeeId: 'merchant-1', amountMinor: 4000, currency: 'USD' };
  const denies = normalizeAp2Constraints([], p, { nowMs: Date.now() });
  assert.equal(denies.ok, false);
  assert.match(denies.reason, /no enforceable amount bound/);

  const allows = normalizeAp2Constraints([{ type: 'payment.amount_range', currency: 'USD', max: 5000 }], p, { nowMs: Date.now() });
  assert.equal(allows.ok, true, allows.reason);
  assert.deepEqual(allows.value.actionScope.per_transaction_ceiling, { amount: '50.00', currency: 'USD' });
});

// ---- Interop gate (oracle): a mandate the AP2 reference SDK created ----
const AP2_PY = process.env.AP2_PY;
const AP2_SDK_PATH = process.env.AP2_SDK_PATH;
const helper = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'op-policy-engine', 'packages', 'sd-jwt-substrate', 'test', 'rt_helper.py');

test('interop: a Python-SDK-created mandate authorizes and denies here', { skip: !(AP2_PY && AP2_SDK_PATH) && 'AP2_PY/AP2_SDK_PATH not set — interop gate not run' }, async () => {
  const issuer = await generateES256KeyPair();
  const agent = await generateES256KeyPair();
  const { d: _d1, ...agentPub } = agent.privateJwk;
  const res = spawnSync(AP2_PY, [helper], {
    input: JSON.stringify({
      mode: 'create',
      issuer_private_jwk: issuer.privateJwk,
      agent_public_jwk: agentPub,
      constraints: [
        { type: 'payment.amount_range', currency: 'USD', max: 5000 },
        { type: 'payment.allowed_payees', allowed: [{ id: 'merchant-1', name: 'Coffee' }] },
      ],
    }),
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: AP2_SDK_PATH },
    timeout: 60_000,
  });
  const created = JSON.parse(res.stdout.trim().split('\n').at(-1));
  assert.equal(created.ok, true, `AP2 SDK create failed: ${created.error}`);

  const { d: _d2, ...issuerPub } = issuer.privateJwk;
  const allow = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token: created.token, proposal: proposal(2000) });
  assert.equal(allow.allow, true, allow.reason);
  const deny = await authorizeAp2Payment(withLedger({ issuerPublicJwk: issuerPub }), { token: created.token, proposal: proposal(9999) });
  assert.equal(deny.allow, false);
  assert.match(deny.reason, /ceiling/);
});

test('AP2-P1: a missing crossRailLedgerPath DENIES, and the same call allows once supplied', async () => {
  // The engine will not authorize a spend it cannot record. This is not about
  // AP2's own enforcement: an allowed-but-unrecorded leg under-counts the
  // shared budget that the x402/WDK gates price against, so THEY over-spend.
  const { token, issuerPub } = await setup({});

  const noLedger = await authorizeAp2Payment(
    { issuerPublicJwk: issuerPub },
    { token, proposal: proposal(2000), expectedConditionalTransactionId: OCC },
  );
  assert.equal(noLedger.allow, false, `absent ledger path authorized: ${noLedger.reason}`);
  assert.match(noLedger.reason, /no crossRailLedgerPath configured/);

  // Control: identical call, one field added. Isolates the variable, so the
  // deny above is the missing path and not the mandate, payee or amount.
  const withPath = await authorizeAp2Payment(
    withLedger({ issuerPublicJwk: issuerPub }),
    { token, proposal: proposal(2000), expectedConditionalTransactionId: OCC },
  );
  assert.equal(withPath.allow, true, withPath.reason);
  assert.ok(
    withPath.notes.some((n) => /recorded .* into the shared cross-rail ledger/.test(n)),
    'allowed leg must record into the shared ledger',
  );
});
