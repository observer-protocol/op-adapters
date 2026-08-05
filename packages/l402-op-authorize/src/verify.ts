// Credential verification + mandate enforcement for the L402 engine. Steps 1–5
// (load, structure, validity, DID-resolve + eddsa-jcs-2022 proof, revocation)
// are the SAME vendored-core flow ows-op-verify and mppx-op-account run — reused
// unchanged. The ONLY difference: this engine resolves the issuer as a did:key
// (SCOPE §5), not did:web. No net-new crypto.

import { readFileSync } from 'node:fs';
import {
  validateStructure,
  checkValidityWindow,
  findAssertionMethodKey,
  verifyEddsaJcs2022,
  decodeEd25519Multibase,
  checkStatusEntry,
  evaluateMandate,
} from '@observer-protocol/policy-engine';
import type {
  ObserverDelegationCredential,
  PolicyContext,
  ResolvedTransfer,
  VerifierConfig,
} from '@observer-protocol/policy-engine';
import { isDidKey, resolveDidKey } from './didkey.js';

export interface Verdict {
  allow: boolean;
  reason: string;
  notes: string[];
  cred?: ObserverDelegationCredential;
}

/** Steps 1–5: load (from config.credentialPath) + verify the did:key delegation. */
export async function verifyCredential(config: VerifierConfig, nowMs: number): Promise<Verdict> {
  let cred: ObserverDelegationCredential;
  try {
    cred = JSON.parse(readFileSync(config.credentialPath, 'utf8')) as ObserverDelegationCredential;
  } catch (e) {
    return { allow: false, reason: `[credential] cannot read ${config.credentialPath}: ${(e as Error).message}`, notes: [] };
  }
  return verifyCredentialObject(cred, config, nowMs);
}

/** Steps 1–5 on an in-memory credential (the seller side receives the VC from a
 * presentation, not a file). */
export async function verifyCredentialObject(
  cred: ObserverDelegationCredential,
  config: VerifierConfig,
  nowMs: number,
): Promise<Verdict> {
  const notes: string[] = [];

  const structure = validateStructure(cred, config);
  if (!structure.ok) return { allow: false, reason: `[schema] ${structure.reason}`, notes };

  const window = checkValidityWindow(cred, nowMs);
  if (!window.ok) return { allow: false, reason: window.reason ?? '[validity] credential not currently valid', notes };

  try {
    // SCOPE §5: this engine accepts did:key issuers only. Resolve the DID document
    // from the key itself — no network, no registry. did:web stays the Sovereign
    // service offering and is rejected here.
    if (!isDidKey(cred.issuer)) {
      return { allow: false, reason: `[did] issuer must be a did:key for this engine (got ${cred.issuer})`, notes };
    }
    const doc = resolveDidKey(cred.issuer);
    const vmId = cred.proof?.verificationMethod;
    if (!vmId) return { allow: false, reason: '[proof] proof.verificationMethod missing', notes };
    if (!vmId.startsWith(cred.issuer + '#')) {
      return { allow: false, reason: `[proof] verificationMethod ${vmId} is not a key of the issuer ${cred.issuer}`, notes };
    }
    const { entry } = findAssertionMethodKey(doc, vmId);
    if (!entry.publicKeyMultibase) {
      return { allow: false, reason: `[did] verification method ${entry.id} has no publicKeyMultibase`, notes };
    }
    const { key, note: keyNote } = decodeEd25519Multibase(entry.publicKeyMultibase);
    if (keyNote) notes.push(keyNote);
    const proofResult = verifyEddsaJcs2022(cred as unknown as Record<string, unknown>, key);
    notes.push(...proofResult.notes);
    if (!proofResult.ok) return { allow: false, reason: `[proof] ${proofResult.reason}`, notes };
  } catch (e) {
    return { allow: false, reason: `[proof] ${(e as Error).message}`, notes };
  }

  if (cred.credentialStatus && cred.credentialStatus.length > 0) {
    for (const entry of cred.credentialStatus) {
      try {
        const outcome = await checkStatusEntry(entry, config);
        notes.push(...outcome.notes);
        if (outcome.revoked) return { allow: false, reason: `[revocation] ${outcome.detail}`, notes };
      } catch (e) {
        return { allow: false, reason: `[revocation] status could not be established: ${(e as Error).message}`, notes };
      }
    }
  } else {
    notes.push('credential carries no credentialStatus entry — revocation not checkable for this credential');
  }

  return { allow: true, reason: 'credential verified', notes, cred };
}

/** Step 6–7: enforce the mandate against the resolved L402 payment. The L402
 * engine always supplies the resolved transfer (built from the decoded invoice),
 * so the vendored resolver/decoders (and their viem dependency) are never pulled
 * in. `dailyTotalRaw` is injected as ctx.spending so the velocity check runs
 * unchanged. */
export function enforceMandate(
  ctx: PolicyContext,
  cred: ObserverDelegationCredential,
  config: VerifierConfig,
  opts: { resolvedOverride: ResolvedTransfer; dailyTotalRaw?: bigint },
): Verdict {
  const railDef = config.rails[ctx.chain_id];
  if (!railDef) {
    return { allow: false, reason: `[rails] chain ${ctx.chain_id} has no rail mapping in config.rails`, notes: [] };
  }
  if (opts.dailyTotalRaw !== undefined) {
    ctx = { ...ctx, spending: { daily_total: opts.dailyTotalRaw.toString(), date: ctx.timestamp.slice(0, 10) } };
  }
  const mandate = evaluateMandate(ctx, cred, config, opts.resolvedOverride);
  if (!mandate.ok) return { allow: false, reason: mandate.reason, notes: mandate.notes };
  return { allow: true, reason: mandate.reason, notes: mandate.notes };
}
