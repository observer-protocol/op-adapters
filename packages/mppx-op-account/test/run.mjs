// Conformance runner — drives the BUILT bundle through escrow opens, top-ups,
// vouchers, settles, and credential-integrity cases against a mock base account.
// Builders use the real escrow ABI + derived channel ids (shared.mjs).
// Discipline: ALLOW asserts the base WAS asked to sign; DENY asserts an
// ObserverDenyError was thrown and the base was NOT asked to sign.
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createObserverAccount, ObserverDenyError } from '../dist/index.mjs';
import {
  makeConfig, openTx, topUpTx, closeTx, requestCloseTx, unknownEscrowTx, voucher, nonVoucherTypedData,
  channelFor, salt, USDC, AGENT_ADDR, MERCHANT_ADDR, OTHER_ADDR, AGENT,
} from './fixtures/shared.mjs';

let pass = 0, fail = 0;
const failures = [];

function mockBase() {
  const calls = { signTransaction: 0, signTypedData: 0, signMessage: 0 };
  return { calls, account: {
    address: AGENT_ADDR, type: 'local', source: 'mock',
    signTransaction: async () => { calls.signTransaction++; return '0xSIGNED_TX'; },
    signTypedData: async () => { calls.signTypedData++; return '0xSIGNED_TD'; },
    signMessage: async () => { calls.signMessage++; return '0xSIGNED_MSG'; },
  } };
}
const freshLog = () => join(mkdtempSync(join(tmpdir(), 'mppx-op-')), 'decisions.jsonl');
const acct = (cred, opts) => createObserverAccount(mockBase().account, makeConfig(cred, { auditLog: freshLog(), ...opts }));

async function expectAllow(name, fn) {
  try { const r = await fn(); if (typeof r === 'string' && r.startsWith('0xSIGNED')) pass++; else { fail++; failures.push(`${name}: expected signed, got ${JSON.stringify(r)}`); } }
  catch (e) { fail++; failures.push(`${name}: expected ALLOW but threw: ${e.message}`); }
}
async function expectDeny(name, sub, fn) {
  try { await fn(); fail++; failures.push(`${name}: expected DENY but allowed`); }
  catch (e) {
    if (!(e instanceof ObserverDenyError)) { fail++; failures.push(`${name}: non-deny error: ${e.message}`); return; }
    if (sub && !e.reason.includes(sub)) { fail++; failures.push(`${name}: reason ${JSON.stringify(e.reason)} lacked ${JSON.stringify(sub)}`); }
    else pass++;
  }
}

// ── escrow open: amount / counterparty / velocity ──
await expectAllow('open under ceiling + velocity', () => acct('tempo-usdc').signTransaction(openTx(MERCHANT_ADDR, USDC(50))));
await expectAllow('v2.4 credentialSchema accepted: open under ceiling', () => acct('tempo-usdc-v24').signTransaction(openTx(MERCHANT_ADDR, USDC(50))));
await expectDeny('open over per-tx ceiling', 'per_transaction_ceiling', () => acct('tempo-usdc').signTransaction(openTx(MERCHANT_ADDR, USDC(150))));
await expectDeny('open payee not allowlisted', 'allowList', () => acct('tempo-usdc').signTransaction(openTx(OTHER_ADDR, USDC(50))));
await (async () => {
  const a = acct('tempo-usdc');
  await expectAllow('open #1 (80) under velocity', () => a.signTransaction(openTx(MERCHANT_ADDR, USDC(80), salt('a1'))));
  await expectDeny('open #2 (80) trips daily velocity', 'dailyVolumeCap', () => a.signTransaction(openTx(MERCHANT_ADDR, USDC(80), salt('a2'))));
})();

// ── velocity counter recovery via audit-log replay ──
await (async () => {
  const log = freshLog(); const today = new Date().toISOString().slice(0, 10);
  mkdirSync(join(log, '..'), { recursive: true });
  appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), decision: 'allow', reason: 'seed', notes: [], kind: 'escrow-open', subject_did: AGENT, asset: 'USDC', amount: USDC(100).toString(), utc_day: today }) + '\n');
  const a = createObserverAccount(mockBase().account, makeConfig('tempo-usdc', { auditLog: log }));
  await expectDeny('velocity recovered from audit-log replay', 'dailyVolumeCap', () => a.signTransaction(openTx(MERCHANT_ADDR, USDC(60), salt('b1'))));
})();
await expectDeny('velocity fails closed when counter unestablished', 'spending.daily_total', () => {
  const dirAsLog = mkdtempSync(join(tmpdir(), 'mppx-op-dirlog-'));
  return createObserverAccount(mockBase().account, makeConfig('tempo-usdc', { auditLog: dirAsLog })).signTransaction(openTx(MERCHANT_ADDR, USDC(10)));
});

// ── escrow call classification ──
await expectAllow('requestClose (benign)', () => acct('tempo-usdc').signTransaction(requestCloseTx(channelFor(MERCHANT_ADDR))));
await expectDeny('unknown escrow selector fails closed', 'unrecognised', () => acct('tempo-usdc').signTransaction(unknownEscrowTx()));

// ── vouchers: cap (now linked), monotonicity, revocation ──
await (async () => {
  const a = acct('tempo-usdc'); const s = salt('c1'); const ch = channelFor(MERCHANT_ADDR, s);
  await a.signTransaction(openTx(MERCHANT_ADDR, USDC(100), s)); // links channel ch, cap 100
  await expectAllow('voucher within linked escrow cap', () => a.signTypedData(voucher(ch, USDC(40))));
  await expectAllow('voucher monotonic increase', () => a.signTypedData(voucher(ch, USDC(70))));
  await expectDeny('voucher rollback below last', 'rollback', () => a.signTypedData(voucher(ch, USDC(50))));
  await expectDeny('voucher over linked escrow cap', 'exceeds the escrow cap', () => a.signTypedData(voucher(ch, USDC(120))));
})();
await expectDeny('voucher under REVOKED credential', 'revoked', () => acct('tempo-usdc', { statusList: 'status-revoked.json' }).signTypedData(voucher(channelFor(MERCHANT_ADDR), USDC(10))));
await expectDeny('undecodable voucher fails closed', 'undecodable', () => { const bad = voucher(channelFor(MERCHANT_ADDR), USDC(10)); delete bad.message.cumulativeAmount; return acct('tempo-usdc').signTypedData(bad); });
await expectAllow('non-voucher typed data', () => acct('tempo-usdc').signTypedData(nonVoucherTypedData()));

// ── v1.1: topUp counterparty inherited from linked channel ──
await (async () => {
  const a = acct('tempo-usdc'); const s = salt('d1'); const ch = channelFor(MERCHANT_ADDR, s);
  await a.signTransaction(openTx(MERCHANT_ADDR, USDC(50), s)); // channel payee = MERCHANT (allowlisted)
  await expectAllow('topUp inherits allowlisted channel payee', () => a.signTransaction(topUpTx(ch, USDC(10))));
})();
await expectDeny('topUp on unknown channel fails closed under counterparty mandate', 'recipient', () => acct('tempo-usdc').signTransaction(topUpTx(channelFor(OTHER_ADDR, salt('d9')), USDC(10))));

// ── v1.1: close-time true-up frees velocity headroom ──
await (async () => {
  const a = acct('tempo-usdc'); const s1 = salt('e1'); const ch1 = channelFor(MERCHANT_ADDR, s1);
  await a.signTransaction(openTx(MERCHANT_ADDR, USDC(100), s1));     // daily 100
  await a.signTransaction(closeTx(ch1, USDC(30)));                   // refund 70 → daily 30
  await expectAllow('open after close true-up (130<=150)', () => a.signTransaction(openTx(MERCHANT_ADDR, USDC(100), salt('e2'))));
})();
await (async () => { // control: without an intervening close, the 2nd open trips velocity
  const a = acct('tempo-usdc');
  await a.signTransaction(openTx(MERCHANT_ADDR, USDC(100), salt('f1')));
  await expectDeny('without true-up, 2nd open trips velocity', 'dailyVolumeCap', () => a.signTransaction(openTx(MERCHANT_ADDR, USDC(100), salt('f2'))));
})();

// ── signMessage default-deny / opt-in ──
await expectDeny('raw signMessage denied by default', 'denied by default', () => acct('tempo-usdc').signMessage({ message: 'hi' }));
await expectAllow('raw signMessage allowed when opted in', () => acct('tempo-usdc', { allowSignMessage: true }).signMessage({ message: 'hi' }));

// ── credential integrity (shared pipeline) ──
await expectDeny('expired credential', 'expired', () => acct('expired').signTransaction(openTx(MERCHANT_ADDR, USDC(10))));
await expectDeny('tampered credential', 'does not verify', () => acct('tampered').signTransaction(openTx(MERCHANT_ADDR, USDC(10))));
await expectDeny('wrong issuer', 'pinned trusted issuer', () => acct('wrong-issuer').signTransaction(openTx(MERCHANT_ADDR, USDC(10))));
await expectDeny('schema not in allowlist', 'allowlist', () => acct('bad-schema').signTransaction(openTx(MERCHANT_ADDR, USDC(10))));
await expectDeny('signing key not in assertionMethod', 'assertionMethod', () => acct('key2-signed').signTransaction(openTx(MERCHANT_ADDR, USDC(10))));

// ── fail-closed: base key NOT reached on deny ──
await (async () => {
  const m = mockBase();
  const a = createObserverAccount(m.account, makeConfig('tempo-usdc', { auditLog: freshLog() }));
  try { await a.signTransaction(openTx(MERCHANT_ADDR, USDC(150))); } catch { /* deny */ }
  if (m.calls.signTransaction === 0) pass++; else { fail++; failures.push('fail-closed: base.signTransaction MUST NOT run on a denied open'); }
})();

console.log(`\nmppx-op-account conformance: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('\nFAILURES:'); failures.forEach((f) => console.error('  ✗ ' + f)); process.exit(1); }
