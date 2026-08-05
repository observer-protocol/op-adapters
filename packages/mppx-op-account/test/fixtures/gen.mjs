// Conformance fixture generator for the mppx/Tempo OP account.
//
// Produces a self-contained tree in test/fixtures/out/: issuer keys + DID
// document, status lists (clean + revoked), and delegation credentials with
// Tempo/USDC mandates. All keys are generated here — NOTHING derives from any
// production credential, key, or deployment. The escrow/voucher BUILDERS and the
// shared test CONFIG live in shared.mjs so run.mjs can drive sequences.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIssuerKeys, signEddsaJcs2022, makeDidDocument, makeStatusList } from './lib.mjs';
import { ISSUER, AGENT, SCHEMA_URL, SCHEMA_URL_V24, MERCHANT_ADDR } from './shared.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'cache'), { recursive: true });

const key1 = newIssuerKeys(); // assertionMethod-valid
const key2 = newIssuerKeys(); // present but NOT in assertionMethod
const didDoc = makeDidDocument(ISSUER, [
  { fragment: 'key-1', multikey: key1.multikey, assertion: true },
  { fragment: 'key-2', multikey: key2.multikey, assertion: false },
]);
writeFileSync(join(OUT, 'issuer-did.json'), JSON.stringify(didDoc, null, 2));
const VM1 = `${ISSUER}#key-1`;
const VM2 = `${ISSUER}#key-2`;

writeFileSync(
  join(OUT, 'status-clean.json'),
  JSON.stringify(makeStatusList({ issuer: ISSUER, privateKey: key1.privateKey, verificationMethod: VM1, setBits: [], url: 'https://issuer.example/status/1' }), null, 2),
);
writeFileSync(
  join(OUT, 'status-revoked.json'),
  JSON.stringify(makeStatusList({ issuer: ISSUER, privateKey: key1.privateKey, verificationMethod: VM1, setBits: [7], url: 'https://issuer.example/status/1' }), null, 2),
);

// Base mandate: ceiling 100 USDC, counterparty allowlist [MERCHANT_ADDR],
// daily velocity cap 150 USDC, on the Tempo rail.
function baseCredential(overrides = {}) {
  const { subject = {}, top = {} } = overrides;
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ['VerifiableCredential', 'ObserverDelegationCredential'],
    issuer: ISSUER,
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: '2027-01-01T00:00:00Z',
    credentialSchema: { id: SCHEMA_URL, type: 'JsonSchema' },
    credentialStatus: [
      { id: 'https://issuer.example/status/1#7', type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: '7', statusListCredential: 'https://issuer.example/status/1' },
    ],
    ...top,
    credentialSubject: {
      id: AGENT,
      authorizationLevel: 'policy',
      authorizationConfig: { policy: { policy_id: 'tempo-001', rail_preference: ['tempo-mainnet'] } },
      actionScope: {
        allowed_rails: ['tempo-mainnet'],
        per_transaction_ceiling: { amount: '100', currency: 'USDC' },
      },
      delegationScope: { may_delegate_further: false },
      enforcementMode: 'pre_transaction_check',
      tradingMandate: {
        unit: 'USDC',
        counterparty: { allowList: [MERCHANT_ADDR] },
        velocity: { dailyVolumeCap: 150 },
      },
      ...subject,
    },
  };
}
const sign = (cred, key = key1.privateKey, vm = VM1) => signEddsaJcs2022(cred, key, vm);

const credentials = {
  'tempo-usdc': sign(baseCredential()),
  // v2.4: same valid mandate declaring the current Sovereign delegation schema.
  'tempo-usdc-v24': sign(baseCredential({ top: { credentialSchema: { id: SCHEMA_URL_V24, type: 'JsonSchema' } } })),
  // no counterparty binding (so escrow without a decodable payee still passes counterparty)
  'tempo-noCp': sign(baseCredential({ subject: { tradingMandate: { unit: 'USDC', velocity: { dailyVolumeCap: 150 } } } })),
  // no velocity (so the recovery-error fail-closed case can be isolated to velocity)
  'tempo-noVelocity': sign(baseCredential({ subject: { tradingMandate: { unit: 'USDC', counterparty: { allowList: [MERCHANT_ADDR] } } } })),
  expired: sign(baseCredential({ top: { validUntil: '2026-02-01T00:00:00Z' } })),
  'bad-schema': sign(baseCredential({ top: { credentialSchema: { id: 'https://observerprotocol.org/schemas/delegation/v2.json', type: 'JsonSchema' } } })),
  'key2-signed': sign(baseCredential(), key2.privateKey, VM2),
};
// tampered: valid signature then mutate the ceiling
const tampered = JSON.parse(JSON.stringify(credentials['tempo-usdc']));
tampered.credentialSubject.actionScope.per_transaction_ceiling.amount = '100000';
credentials['tampered'] = tampered;
// wrong issuer
const evilKeys = newIssuerKeys();
const EVIL = 'did:web:evil.example';
const evil = baseCredential();
evil.issuer = EVIL;
credentials['wrong-issuer'] = signEddsaJcs2022(evil, evilKeys.privateKey, `${EVIL}#key-1`);

for (const [name, cred] of Object.entries(credentials)) {
  writeFileSync(join(OUT, `cred-${name}.json`), JSON.stringify(cred, null, 2));
}
console.log(`mppx fixtures: ${Object.keys(credentials).length} credentials → ${OUT}`);
