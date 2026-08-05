// @observer-protocol/l402-op-authorize — Observer Protocol's fourth enforcement
// engine: authorization for L402 / Lightning agentic commerce.
//
// Two sides over the lnget (buyer) + Aperture (seller) seam of Lightning Labs'
// L402 stack, composed via a vendor-neutral env hook (no changes to any
// Lightning Labs repo):
//   - Buyer side: before paying an L402 invoice, verify the agent's signed,
//     revocable did:key delegation against the proposed payment (amount in sats
//     or Taproot-Asset USDT, the L402 origin as counterparty, velocity),
//     fail-closed, then emit a signed PolicyEvaluationCredential and ingest the
//     preimage into AT-ARS.
//   - Seller side (the wedge): an Aperture-side check that verifies a presented,
//     HOLDER-BOUND authorization credential (a Verifiable Presentation signed by
//     the subject did:key over a server challenge) before serving — the binding
//     macaroons structurally cannot provide.
//
// Same vendored core (DID/proof/mandate/revocation) as ows-op-verify and
// mppx-op-account, drift-guarded byte-identical. Only the decoder changed.

// Decoder (L402 / BOLT11 / Taproot-Asset)
export { decodeL402, parseL402Challenge, originHost } from './l402.js';
export type { DecodedPayment, L402Challenge } from './l402.js';
export { bolt11AmountSats } from './bolt11.js';

// did:key resolution (Ed25519)
export { resolveDidKey, isDidKey } from './didkey.js';
export type { DidKeyDocument } from './didkey.js';

// Buyer-side enforcement (lnget path, SCOPE §6)
export { authorizeL402Payment, lightningRail, LIGHTNING_CHAIN_ID } from './buyer.js';
export type { L402AuthInput } from './buyer.js';
export { verifyCredential, verifyCredentialObject, enforceMandate } from './verify.js';
export type { Verdict } from './verify.js';

// Seller-side inspection (Aperture, SCOPE §7) — the holder-bound wedge
export { issueChallenge, verifyPresentationForServing } from './seller.js';
export type { Challenge, ServeDecision } from './seller.js';
export { signPresentation, verifyPresentation } from './presentation.js';
export type { VerifiablePresentation, PresentationResult } from './presentation.js';

// Vendor-neutral pre-payment hook (lnget composition, no LL repo change)
export { handleL402PaymentHook } from './hook.js';
export type { HookRequest, HookResponse } from './hook.js';
