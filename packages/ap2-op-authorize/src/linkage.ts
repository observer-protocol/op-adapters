// The anchor-model-B linkage: OP's AP2 signing key is a dedicated P-256 JWK
// published at a JWKS endpoint, NOT a key in the DID document — and this
// credential is the cryptographic binding back to the DID. Issued by the DID
// controller, signed eddsa-jcs-2022 with a key in the DID document's
// assertionMethod, subject = the exact P-256 public JWK. A verifier that
// trusts did:web:observerprotocol.org can therefore trust the AP2 issuer key
// without AP2 ever resolving a DID: resolve the DID document once, verify
// this credential, pin the JWK. Callback-free, offline-verifiable.
//
// Composition only — every primitive (JCS, sha-256, eddsa verify, DID
// resolution, assertionMethod lookup, base58) is the policy engine's own
// exported machinery.

import { createHash, sign as nodeSign, type KeyObject } from 'node:crypto';
import {
  base58Encode,
  decodeEd25519Multibase,
  findAssertionMethodKey,
  jcsBytes,
  resolveDidDocument,
  resolveDidKeyDocument,
  verifyEddsaJcs2022,
} from '@observer-protocol/policy-engine';
import type { EcJwk } from '@observer-protocol/sd-jwt-substrate';

const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();

export interface Ap2KeyLinkageCredential {
  '@context': string[];
  id: string;
  type: string[];
  issuer: string;
  validFrom: string;
  validUntil: string;
  credentialSubject: {
    /** The DID this AP2 key belongs to (same as issuer — self-binding). */
    id: string;
    /** The AP2 `iss` value verifiers will see in SD-JWT mandates. */
    ap2Issuer: string;
    /** The exact public P-256 JWK (kty/crv/x/y[/kid]) being anointed. */
    jwk: EcJwk;
  };
  proof: Record<string, unknown>;
}

export interface IssueLinkageInput {
  /** The controller DID (issuer AND subject), e.g. did:web:observerprotocol.org. */
  did: string;
  /** verificationMethod id of the Ed25519 signing key — MUST be listed in the
   * DID document's assertionMethod (the emitter references the key explicitly;
   * never a hardcoded default). */
  verificationMethod: string;
  /** The Ed25519 private key matching that verificationMethod. */
  signingKey: KeyObject;
  /** The AP2 iss URL the JWKS will live under. */
  ap2Issuer: string;
  /** The P-256 public JWK to bind (public fields only — a `d` here is refused). */
  ap2PublicJwk: EcJwk;
  id?: string;
  validFrom?: string;
  validUntil?: string;
  nowMs?: number;
}

/** Issue the linkage credential. eddsa-jcs-2022 over the JCS-canonical
 * document, exactly the shape the policy engine's verifier accepts. */
export function issueAp2KeyLinkage(input: IssueLinkageInput): Ap2KeyLinkageCredential {
  if (input.ap2PublicJwk.d !== undefined) {
    throw new Error('ap2PublicJwk carries a private component (d) — linkage credentials bind PUBLIC keys only');
  }
  const nowMs = input.nowMs ?? Date.now();
  const validFrom = input.validFrom ?? new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const validUntil = input.validUntil ?? new Date(nowMs + 365 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const doc: Omit<Ap2KeyLinkageCredential, 'proof'> = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: input.id ?? `urn:op:ap2-key-linkage:${input.ap2PublicJwk.kid ?? 'unkeyed'}`,
    type: ['VerifiableCredential', 'Ap2KeyLinkageCredential'],
    issuer: input.did,
    validFrom,
    validUntil,
    credentialSubject: {
      id: input.did,
      ap2Issuer: input.ap2Issuer,
      jwk: input.ap2PublicJwk,
    },
  };
  const proofOptions: Record<string, unknown> = {
    '@context': doc['@context'],
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: validFrom,
    verificationMethod: input.verificationMethod,
    proofPurpose: 'assertionMethod',
  };
  const hashData = Buffer.concat([sha256(jcsBytes(proofOptions)), sha256(jcsBytes(doc as unknown as Record<string, unknown>))]);
  const sig = nodeSign(null, hashData, input.signingKey);
  return { ...doc, proof: { ...proofOptions, proofValue: 'z' + base58Encode(sig) } };
}

export type LinkageVerifyResult =
  | { ok: true; jwk: EcJwk; ap2Issuer: string }
  | { ok: false; reason: string };

export interface VerifyLinkageInput {
  credential: Ap2KeyLinkageCredential;
  /** The DID the verifier trusts (its own decision, pinned). */
  expectedDid: string;
  /** Offline DID-document override (air-gapped/test); did:key resolves in-memory. */
  offlineDidDocumentPath?: string;
  cacheDir?: string;
  nowMs?: number;
}

/** Verify the linkage: issuer is the expected DID, the signing key is in that
 * DID document's assertionMethod, the eddsa-jcs-2022 proof verifies, the
 * validity window holds, and the subject binds a public P-256 JWK. On success
 * the returned JWK is the trust root for AP2 mandate verification. */
export async function verifyAp2KeyLinkage(input: VerifyLinkageInput): Promise<LinkageVerifyResult> {
  try {
    const cred = input.credential;
    const nowMs = input.nowMs ?? Date.now();
    if (cred.issuer !== input.expectedDid) return { ok: false, reason: `linkage issuer ${cred.issuer} is not the expected DID ${input.expectedDid}` };
    if (cred.credentialSubject?.id !== input.expectedDid) return { ok: false, reason: 'linkage subject.id does not self-bind to the issuer DID' };
    if (!Array.isArray(cred.type) || !cred.type.includes('Ap2KeyLinkageCredential')) return { ok: false, reason: 'not an Ap2KeyLinkageCredential' };
    const jwk = cred.credentialSubject?.jwk;
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
      return { ok: false, reason: 'linkage subject.jwk is not a public P-256 JWK' };
    }
    if (jwk.d !== undefined) return { ok: false, reason: 'linkage subject.jwk carries a private component — refused' };
    if (typeof cred.credentialSubject.ap2Issuer !== 'string') return { ok: false, reason: 'linkage carries no ap2Issuer' };

    if (Date.parse(cred.validFrom) > nowMs) return { ok: false, reason: 'linkage not yet valid' };
    if (Date.parse(cred.validUntil) <= nowMs) return { ok: false, reason: 'linkage expired' };

    const vm = (cred.proof as { verificationMethod?: unknown })?.verificationMethod;
    if (typeof vm !== 'string') return { ok: false, reason: 'linkage proof carries no verificationMethod' };

    const didDoc = cred.issuer.startsWith('did:key:')
      ? resolveDidKeyDocument(cred.issuer)
      : (
          await resolveDidDocument(cred.issuer, {
            cacheDir: input.cacheDir ?? '',
            timeoutMs: 5000,
            maxStalenessHours: 24,
            ...(input.offlineDidDocumentPath ? { offlinePath: input.offlineDidDocumentPath } : {}),
          })
        ).doc;
    // findAssertionMethodKey / decodeEd25519Multibase THROW on rejection —
    // caught below, surfaced as {ok:false}. assertionMethod strictness is the
    // engine's own (a verificationMethod-only key is refused).
    const { entry } = findAssertionMethodKey(didDoc, vm);
    if (!entry.publicKeyMultibase) return { ok: false, reason: `linkage signing key ${vm} carries no publicKeyMultibase` };
    const { key: raw } = decodeEd25519Multibase(entry.publicKeyMultibase);
    const proofCheck = verifyEddsaJcs2022(cred as unknown as Record<string, unknown>, raw);
    if (!proofCheck.ok) return { ok: false, reason: `linkage proof failed: ${proofCheck.reason}` };

    return { ok: true, jwk, ap2Issuer: cred.credentialSubject.ap2Issuer };
  } catch (err) {
    return { ok: false, reason: `linkage verification failed: ${(err as Error).message}` };
  }
}
