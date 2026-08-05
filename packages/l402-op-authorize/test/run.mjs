// Conformance matrix for @observer-protocol/l402-op-authorize.
// Buyer side (lnget path) + seller side (Aperture holder-bound presentation),
// against the built dist with real did:key VACs (eddsa-jcs-2022). No network.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAgent, issueVac, verifierConfig } from './fixtures/gen.mjs';
import {
  authorizeL402Payment, decodeL402,
  signPresentation, verifyPresentationForServing, issueChallenge,
} from '../dist/index.mjs';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 'l402-conformance-'));
const principal = makeAgent();
const agent = makeAgent();
const attacker = makeAgent();

let pass = 0, total = 0;
function assert(name, ok, detail = '') {
  total++; if (ok) pass++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  <<< ' + detail));
}

// ---- BUYER SIDE (lnget path) ----
function writeVac(opts) {
  const vac = issueVac({ issuerDid: principal.did, issuerPriv: principal.privateKey, issuerVm: principal.vm, subjectDid: agent.did, ...opts });
  const path = join(dir, 'cred-' + Math.abs([...JSON.stringify(opts)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) + '.json');
  writeFileSync(path, JSON.stringify(vac));
  return path;
}
async function buyer(name, vacOpts, decodeArgs, expectAllow) {
  const cfg = verifierConfig(principal.did, dir, writeVac(vacOpts));
  const v = await authorizeL402Payment(cfg, { decoded: decodeL402(decodeArgs), nowMs: NOW });
  assert(`buyer: ${name}`, v.allow === expectAllow, `got ${v.allow ? 'ALLOW' : 'DENY'} (${v.reason})`);
}
console.log('— buyer side (lnget) —');
await buyer('50k sats to allowlisted merchant → ALLOW', {}, { origin: 'https://api.example.com/x', invoice: 'lnbc500u1x' }, true);
// v2.4: a credential declaring the current Sovereign delegation schema is accepted end-to-end.
await buyer('v2.4 credentialSchema accepted → ALLOW', { schemaId: 'https://observerprotocol.org/schemas/delegation/v2.4.json' }, { origin: 'https://api.example.com/x', invoice: 'lnbc500u1x' }, true);
await buyer('150k sats over the 100k ceiling → DENY', {}, { origin: 'https://api.example.com/x', invoice: 'lnbc1500u1x' }, false);
await buyer('non-allowlisted origin → DENY', {}, { origin: 'https://evil.example.net/x', invoice: 'lnbc500u1x' }, false);
await buyer('amountless invoice under a ceiling → DENY (fail-closed)', {}, { origin: 'https://api.example.com/x', invoice: 'lnbc1x' }, false);
await buyer('expired credential → DENY', { validUntil: '2026-06-10T00:00:00Z' }, { origin: 'https://api.example.com/x', invoice: 'lnbc500u1x' }, false);
await buyer('Taproot-Asset USDT 5 (≤100k unit cap) → ALLOW', { ceilingSats: 100, allowList: ['api.example.com'] },
  { origin: 'https://api.example.com/x', asset: { amount: '5000000', unit: 'sat', decimals: 6 } }, true); // unit 'sat' so it scales against the sat ceiling; amount 5 (5e6 raw @6) ≤ 100

// ---- BUYER SIDE: cross-rail budget (shared ledger with the x402 engine) ----
console.log('— buyer side (cross-rail budget) —');
{
  const { CrossRailLedger } = await import('@observer-protocol/policy-engine');
  const { handleL402PaymentHook } = await import('../dist/index.mjs');
  const crOpts = {
    actionScope: { allowed_rails: ['lightning', 'eip155:84532'] },
    tradingMandate: { crossRailBudget: { amount: '5', currency: 'USD', window: 'P1D', rates: { sat: '0.0005', USDC: '1' } } },
    schemaId: 'https://observerprotocol.org/schemas/delegation/v2.3.json',
  };
  const cfg = verifierConfig(principal.did, dir, writeVac(crOpts));

  // The x402 engine already spent 3 USDC in the window (same file, other rail).
  const ledgerPath = join(dir, 'cross-rail-ledger.jsonl');
  const ledger = new CrossRailLedger(ledgerPath);
  ledger.record({ rail: 'x402:eip155:84532', asset: 'USDC', amountRaw: '3000000', decimals: 6 });

  const v1 = await authorizeL402Payment(cfg, { decoded: decodeL402({ origin: 'https://api.example.com/x', invoice: 'lnbc30u1x' }), nowMs: NOW, ledger });
  assert('cross-rail: 3000 sats (1.5 USD) after 3 USD x402 spend (4.5/5) → ALLOW', v1.allow === true, v1.reason);
  const v2 = await authorizeL402Payment(cfg, { decoded: decodeL402({ origin: 'https://api.example.com/x', invoice: 'lnbc50u1x' }), nowMs: NOW, ledger });
  assert('cross-rail: 5000 sats (2.5 USD) after 3 USD x402 spend (5.5/5) → DENY', v2.allow === false && v2.reason.includes('[cross-rail]'), v2.reason);
  const v3 = await authorizeL402Payment(cfg, { decoded: decodeL402({ origin: 'https://api.example.com/x', invoice: 'lnbc30u1x' }), nowMs: NOW });
  assert('cross-rail: budget mandate with no counter → DENY (fail-closed)', v3.allow === false && v3.reason.includes('no cross-rail counter'), v3.reason);

  // Hook path: an ALLOWED payment is recorded into the shared ledger.
  const h = await handleL402PaymentHook(cfg, { origin: 'https://api.example.com/x', invoice: 'lnbc20u1x', crossRailLedgerPath: ledgerPath });
  const after = ledger.sumWindowConverted({ sat: '0.0005', USDC: '1' });
  assert('cross-rail: hook allow records the sats spend into the shared ledger (3 USD + 1 USD)',
    h.decision === 'allow' && after.ok && after.total === 4_000_000n, `decision=${h.decision} total=${after.ok ? after.total : after.reason}`);
}

// ---- SELLER SIDE (Aperture, holder-bound presentation) ----
const cfgSeller = verifierConfig(principal.did, dir, '(unused-seller-side)');
async function seller(name, vp, challenge, expectServe) {
  const d = await verifyPresentationForServing(cfgSeller, vp, { challenge, nowMs: NOW });
  assert(`seller: ${name}`, d.serve === expectServe, `got ${d.serve ? 'SERVE' : 'REFUSE'} (${d.reason})`);
}
const vac = issueVac({ issuerDid: principal.did, issuerPriv: principal.privateKey, issuerVm: principal.vm, subjectDid: agent.did });
console.log('— seller side (Aperture) —');
const ch = issueChallenge('api.example.com');
const goodVp = signPresentation({ credential: vac, holderDid: agent.did, holderPrivateKey: agent.privateKey, challenge: ch.challenge, domain: ch.domain });
await seller('valid holder-bound presentation → SERVE', goodVp, ch.challenge, true);
await seller('replay against a different challenge → REFUSE', goodVp, issueChallenge().challenge, false);
const bare = { ...goodVp }; delete bare.proof;
await seller('bare credential, no holder proof → REFUSE (bearer token)', bare, ch.challenge, false);
const ch2 = issueChallenge();
const stolen = signPresentation({ credential: vac, holderDid: attacker.did, holderPrivateKey: attacker.privateKey, challenge: ch2.challenge });
await seller('stolen credential (subject != holder) → REFUSE', stolen, ch2.challenge, false);
const ch3 = issueChallenge();
const tampered = signPresentation({ credential: vac, holderDid: agent.did, holderPrivateKey: agent.privateKey, challenge: ch3.challenge });
tampered.verifiableCredential[0].credentialSubject.tradingMandate.maxNotionalPerOrder = 999999999;
await seller('tampered presentation → REFUSE', tampered, ch3.challenge, false);
const ch4 = issueChallenge();
const expiredVac = issueVac({ issuerDid: principal.did, issuerPriv: principal.privateKey, issuerVm: principal.vm, subjectDid: agent.did, validUntil: '2026-06-10T00:00:00Z' });
const expVp = signPresentation({ credential: expiredVac, holderDid: agent.did, holderPrivateKey: agent.privateKey, challenge: ch4.challenge });
await seller('expired credential in a valid VP → REFUSE', expVp, ch4.challenge, false);

console.log(`\n${pass}/${total} conformance cases passed`);
process.exit(pass === total ? 0 : 1);
