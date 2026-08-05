// W3C Verifiable Presentation with holder binding (SCOPE §7, Option 1 — the
// approved resolution to the §8 finding that L402 has no implicit binding).
//
// A bare credential is a bearer token: anyone with a copy could replay it. The
// holder proves control of its subject did:key by signing a server-issued
// challenge inside a Verifiable Presentation. The signature is the SAME
// eddsa-jcs-2022 construction the vendored core verifies for credentials — built
// here from the core primitives (jcsBytes / sha256 / ed25519Verify / base58 /
// decodeEd25519Multibase). No net-new crypto; the only difference from the core's
// VC verifier is proofPurpose `authentication` (a presentation), not
// `assertionMethod` (a credential).

import { sign as nodeSign, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { jcsBytes, sha256, decodeEd25519Multibase, base58Decode, base58Encode } from '@observer-protocol/policy-engine';
import type { ObserverDelegationCredential } from '@observer-protocol/policy-engine';
import { isDidKey, resolveDidKey } from './didkey.js';

// SPKI DER prefix for a raw Ed25519 public key (RFC 8410). Required to wrap
// the raw 32-byte key material into a format node:crypto's verify() accepts.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519Verify(rawPublicKey: Buffer, data: Buffer, signature: Buffer): boolean {
  if (rawPublicKey.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  const keyObject = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
    format: 'der',
    type: 'spki',
  });
  return cryptoVerify(null, data, keyObject, signature);
}

const VP_CONTEXT = ['https://www.w3.org/ns/credentials/v2'];

export interface VerifiablePresentation {
  '@context': string[];
  type: string[];
  holder: string;
  verifiableCredential: ObserverDelegationCredential[];
  proof: Record<string, unknown>;
}

export interface PresentationResult {
  ok: boolean;
  reason: string;
  holderDid?: string;
  credential?: ObserverDelegationCredential;
}

// hashData = SHA256(JCS(proofConfig)) || SHA256(JCS(document)), with the spec's
// context binding (the document's @context for hashing becomes proof.@context).
// Identical to the core verifier's construction.
function eddsaJcsHashData(proofConfig: Record<string, unknown>, documentNoProof: Record<string, unknown>): Buffer {
  const doc: Record<string, unknown> = { ...documentNoProof };
  if ('@context' in proofConfig) doc['@context'] = proofConfig['@context'];
  return Buffer.concat([sha256(jcsBytes(proofConfig)), sha256(jcsBytes(doc))]);
}

function holderVmId(holderDid: string): string {
  return `${holderDid}#${holderDid.slice('did:key:'.length)}`;
}

/** Holder side: build a VP that presents `credential` and proves control of the
 * holder's subject did:key by signing the server `challenge`. `holderPrivateKey`
 * is the agent's Ed25519 private key (a node KeyObject). */
export function signPresentation(opts: {
  credential: ObserverDelegationCredential;
  holderDid: string;
  holderPrivateKey: KeyObject;
  challenge: string;
  domain?: string;
  created?: string;
}): VerifiablePresentation {
  if (!isDidKey(opts.holderDid)) throw new Error('holderDid must be an Ed25519 did:key');
  const vp = {
    '@context': VP_CONTEXT,
    type: ['VerifiablePresentation'],
    holder: opts.holderDid,
    verifiableCredential: [opts.credential],
  };
  const proofConfig: Record<string, unknown> = {
    '@context': VP_CONTEXT,
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: opts.created ?? new Date().toISOString(),
    verificationMethod: holderVmId(opts.holderDid),
    proofPurpose: 'authentication',
    challenge: opts.challenge,
    ...(opts.domain ? { domain: opts.domain } : {}),
  };
  const sig = nodeSign(null, eddsaJcsHashData(proofConfig, vp), opts.holderPrivateKey);
  return { ...vp, proof: { ...proofConfig, proofValue: 'z' + base58Encode(Buffer.from(sig)) } };
}

/** Seller side: verify the holder binding. Confirms the VP is signed by the
 * subject did:key over the issued challenge, and that the embedded credential's
 * subject IS that holder. Does NOT verify the credential's issuer chain — that is
 * the caller's next step (verifyCredentialObject). Fail-closed on every miss; a
 * VP with no holder proof is rejected as a bearer token. */
export function verifyPresentation(vp: VerifiablePresentation, opts: { challenge: string; domain?: string }): PresentationResult {
  if (!vp || typeof vp !== 'object') return { ok: false, reason: '[vp] not an object' };
  if (!Array.isArray(vp.type) || !vp.type.includes('VerifiablePresentation')) {
    return { ok: false, reason: '[vp] type must include VerifiablePresentation' };
  }
  if (!isDidKey(vp.holder)) return { ok: false, reason: '[vp] holder must be an Ed25519 did:key' };
  const vc = vp.verifiableCredential?.[0];
  if (!vc) return { ok: false, reason: '[vp] no verifiableCredential present' };

  const proof = vp.proof as Record<string, unknown> | undefined;
  if (!proof || typeof proof !== 'object') {
    return { ok: false, reason: '[vp] no holder proof — a bare credential is a bearer token and is refused' };
  }
  if (proof['type'] !== 'DataIntegrityProof' || proof['cryptosuite'] !== 'eddsa-jcs-2022') {
    return { ok: false, reason: '[vp] holder proof must be DataIntegrityProof / eddsa-jcs-2022' };
  }
  if (proof['proofPurpose'] !== 'authentication') {
    return { ok: false, reason: `[vp] holder proof.proofPurpose must be authentication (got ${JSON.stringify(proof['proofPurpose'])})` };
  }
  if (proof['challenge'] !== opts.challenge) {
    return { ok: false, reason: '[vp] holder proof.challenge does not match the issued challenge (replay or forgery)' };
  }
  if (opts.domain && proof['domain'] !== opts.domain) {
    return { ok: false, reason: '[vp] holder proof.domain does not match' };
  }
  const vmId = proof['verificationMethod'];
  if (typeof vmId !== 'string' || !vmId.startsWith(vp.holder + '#')) {
    return { ok: false, reason: '[vp] holder proof.verificationMethod is not a key of the holder' };
  }
  const proofValue = proof['proofValue'];
  if (typeof proofValue !== 'string' || !proofValue.startsWith('z')) {
    return { ok: false, reason: "[vp] holder proof.proofValue must be multibase base58btc (prefix 'z')" };
  }

  let key: Buffer;
  try {
    const vm = resolveDidKey(vp.holder).verificationMethod[0]!;
    key = decodeEd25519Multibase(vm.publicKeyMultibase).key;
  } catch (e) {
    return { ok: false, reason: `[vp] holder key unresolvable: ${(e as Error).message}` };
  }
  let sig: Buffer;
  try {
    sig = base58Decode(proofValue.slice(1));
  } catch (e) {
    return { ok: false, reason: `[vp] proofValue decode failed: ${(e as Error).message}` };
  }
  if (sig.length !== 64) return { ok: false, reason: `[vp] holder signature must be 64 bytes (got ${sig.length})` };

  const proofConfig: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(proof)) if (k !== 'proofValue') proofConfig[k] = v;
  const vpNoProof: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vp)) if (k !== 'proof') vpNoProof[k] = v;

  let valid: boolean;
  try {
    valid = ed25519Verify(key, eddsaJcsHashData(proofConfig, vpNoProof), sig);
  } catch (e) {
    return { ok: false, reason: `[vp] holder signature verification errored: ${(e as Error).message}` };
  }
  if (!valid) return { ok: false, reason: '[vp] holder proof does not verify — presenter does not control the subject key' };

  // Bind: the credential being presented must be ABOUT the holder that just
  // proved key control (otherwise a valid VP could front someone else's cred).
  if (vc.credentialSubject?.id !== vp.holder) {
    return { ok: false, reason: `[vp] credential subject ${vc.credentialSubject?.id} is not the presenting holder ${vp.holder}` };
  }
  return { ok: true, reason: 'holder-bound presentation verified', holderDid: vp.holder, credential: vc };
}
