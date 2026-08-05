// @observer-protocol/ap2-op-authorize
//
// The AP2 instance of OP Crossrail: an agent arriving with an AP2 Open
// Payment Mandate resolves against the same shared policy core (and the same
// shared cross-rail spend ledger) as the x402, L402/Lightning, Tether-WDK and
// Fireblocks instances. Verify the SD-JWT mandate, normalize its constraints
// fail-closed, enforce, and debit the shared budget at authorize time.

export { authorizeAp2Payment } from './authorize.js';
export type { Ap2AuthorizeConfig, Ap2AuthorizeInput, Ap2Verdict } from './authorize.js';

export { normalizeAp2Constraints, minorToDecimal, ISO4217_EXPONENT } from './normalize.js';
export type { Ap2Proposal, NormalizedAp2, NormalizeResult } from './normalize.js';

export { emitAp2Mandate } from './emit.js';
export type { OpMandateView, EmitAp2Input, EmitResult } from './emit.js';

export { issueAp2KeyLinkage, verifyAp2KeyLinkage } from './linkage.js';
export type { Ap2KeyLinkageCredential, IssueLinkageInput, VerifyLinkageInput, LinkageVerifyResult } from './linkage.js';
