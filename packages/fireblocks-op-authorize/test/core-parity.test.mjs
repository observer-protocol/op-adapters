// PERMANENT parity guard for this engine against the shared policy core.
//
// This engine EXTERNALIZES @observer-protocol/policy-engine (tsup default; a regular
// dependency imported at runtime), so — unlike the engines that BUNDLE — the guard is
// NOT a dist grep and NOT a version string (the package's exports block reading its
// package.json anyway). The resolved core's runtime BEHAVIOR is the contract: a
// downgrade to a pre-0.3.0 fail-OPEN core silently forks. This asserts the resolved
// core denies the exact shapes 0.2.0 allowed. If this fails, the engine resolved a
// fail-open core — bump @observer-protocol/policy-engine to >= 0.3.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceMandate } from '@observer-protocol/policy-engine';

test('resolved policy core DENIES the fail-open shapes (0.2.0 allowed these; 0.3.0 fail-closed)', () => {
  const cfg = { rails: { 'test:1': { rail: 'test-rail' } } };
  const ctx = { chain_id: 'test:1', timestamp: '2026-06-25T12:00:00Z', spending: { daily_total: '0', date: '2026-06-25' }, transaction: { to: 'addr', value: '0' } };
  const resolved = (amount = 50n) => ({ kind: 'transfer', recipient: 'addr', amount, assetSymbol: 'TUNIT', decimals: 0, notes: [] });
  const subj = (delegation) => ({ credentialSubject: { id: 'did:key:z6Mkx', actionScope: {}, delegationScope: { may_delegate_further: false }, enforcementMode: 'pre_transaction_check', delegation } });
  const cases = [
    ['unrecognized delegation container', subj({ scope: { something_unrecognized: {} } }), resolved()],
    ['per_asset cap present', subj({ scope: { spending_limits: { per_rail: { 'test:1': { per_transaction: { max_amount: '1000', currency: 'TUNIT' }, per_asset: { x: {} } } } } } }), resolved()],
    ['no per_rail for this rail', subj({ scope: { spending_limits: { per_rail: { 'other:99': { per_transaction: { max_amount: '1000', currency: 'TUNIT' } } } } } }), resolved()],
    ['over-cap per_rail (999999 > 100)', subj({ scope: { spending_limits: { per_rail: { 'test:1': { per_transaction: { max_amount: '100', currency: 'TUNIT' } } } } } }), resolved(999999n)],
  ];
  for (const [name, cred, res] of cases) {
    const v = enforceMandate(ctx, cred, cfg, res);
    assert.equal(v.allow, false, `${name}: resolved core ALLOWED a fail-open shape — core is pre-0.3.0. Bump policy-engine. ${v.reason ?? ''}`);
  }
});
