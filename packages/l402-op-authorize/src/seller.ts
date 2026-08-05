// Seller-side inspection on the Aperture side (SCOPE §7 — the wedge). An
// Aperture-hosted endpoint can require a presented, HOLDER-BOUND authorization
// credential before serving: it issues a challenge, then serves only if the agent
// returns a Verifiable Presentation signed by the credential's subject did:key
// over that challenge AND the credential itself verifies (issuer chain, validity,
// revocation). This is the capability macaroons structurally cannot provide.
//
// Opt-in and seller-elective: the permissionless default L402 path is untouched.

import { randomBytes } from 'node:crypto';
import type { VerifierConfig } from '@observer-protocol/policy-engine';
import { verifyPresentation, type VerifiablePresentation } from './presentation.js';
import { verifyCredentialObject } from './verify.js';

export interface Challenge {
  challenge: string;
  domain?: string;
}

/** Issue a fresh, unguessable challenge. The seller MUST track issued challenges
 * and reject reuse (single-use) to make replay impossible. */
export function issueChallenge(domain?: string): Challenge {
  return { challenge: randomBytes(24).toString('hex'), ...(domain ? { domain } : {}) };
}

export interface ServeDecision {
  serve: boolean;
  reason: string;
  notes: string[];
  holderDid?: string;
}

/**
 * Decide whether to serve an Aperture-gated request. Serves only when BOTH hold:
 *   1. the presentation is holder-bound (VP signed by the subject did:key over
 *      our challenge, subject == holder) — closes the bearer-token replay hole;
 *   2. the embedded credential verifies (did:key issuer chain, eddsa-jcs-2022
 *      proof, validity window, revocation).
 * Anything less — a bare credential, a replayed/forged VP, a subject != holder,
 * an expired/revoked/mis-issued credential — is refused. Fail closed.
 */
export async function verifyPresentationForServing(
  config: VerifierConfig,
  vp: VerifiablePresentation,
  opts: { challenge: string; domain?: string; nowMs?: number },
): Promise<ServeDecision> {
  const nowMs = opts.nowMs ?? Date.now();
  const pres = verifyPresentation(vp, { challenge: opts.challenge, ...(opts.domain ? { domain: opts.domain } : {}) });
  if (!pres.ok || !pres.credential) {
    return { serve: false, reason: pres.reason, notes: [] };
  }
  const credVerdict = await verifyCredentialObject(pres.credential, config, nowMs);
  if (!credVerdict.allow) {
    return { serve: false, reason: credVerdict.reason, notes: credVerdict.notes, ...(pres.holderDid ? { holderDid: pres.holderDid } : {}) };
  }
  return { serve: true, reason: 'holder-bound credential verified', notes: credVerdict.notes, ...(pres.holderDid ? { holderDid: pres.holderDid } : {}) };
}
