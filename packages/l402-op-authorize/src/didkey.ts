// did:key resolution for the L402 engine. Per SCOPE §5, this engine's
// authorization credentials use did:key (NOT did:web — that stays the Sovereign
// service offering). A did:key DID document is derived deterministically from the
// key itself: no network, no fetch, no registry. This file lives OUTSIDE
// src/core/ so the vendored core (did:web resolver, byte-identical across engines)
// stays untouched and drift-guarded.
//
// Only Ed25519 did:key is supported (multicodec 0xed01), matching the engine's
// eddsa-jcs-2022 proof suite. Any other key type is rejected.

import { decodeEd25519Multibase } from '@observer-protocol/policy-engine';

export interface DidKeyDocument {
  id: string;
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase: string;
  }>;
  assertionMethod: string[];
  authentication: string[];
}

/** True if `did` is a did:key DID (the method this engine uses). */
export function isDidKey(did: string): boolean {
  return typeof did === 'string' && did.startsWith('did:key:z');
}

/**
 * Resolve a did:key (Ed25519) to a synthetic DID document. The verification
 * method id follows the did:key spec convention `${did}#${multibaseValue}`, and
 * the key is the multibase value itself. Throws on any non-Ed25519 or malformed
 * did:key — fail closed, never return a partial document.
 */
export function resolveDidKey(did: string): DidKeyDocument {
  if (!isDidKey(did)) throw new Error(`not an Ed25519 did:key DID: ${did}`);
  const multibase = did.slice('did:key:'.length); // e.g. z6Mk...
  // Validate the multibase decodes to a 32-byte Ed25519 key (decodeEd25519Multibase
  // strips the 0xed01 multicodec prefix). A non-32-byte result means it is not a
  // conformant Ed25519 did:key.
  const { key } = decodeEd25519Multibase(multibase);
  if (!key || key.length !== 32) {
    throw new Error(`did:key is not a valid 32-byte Ed25519 key: ${did}`);
  }
  const vmId = `${did}#${multibase}`;
  return {
    id: did,
    verificationMethod: [
      { id: vmId, type: 'Ed25519VerificationKey2020', controller: did, publicKeyMultibase: multibase },
    ],
    assertionMethod: [vmId],
    authentication: [vmId],
  };
}
