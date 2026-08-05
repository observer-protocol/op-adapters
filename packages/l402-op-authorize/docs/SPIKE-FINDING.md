# §8 holder-binding spike — finding

**Run before implementing presentation/verification, per SCOPE §8. Outcome drove a Boyd decision.**

## Question
Does the lnget / L402 / Aperture flow already require the presenting agent to sign with its
subject `did:key` (is holder binding implicit in normal operation)?

## Finding: NO — holder binding is NOT implicit.
Evidence, from Lightning Labs' own sources:

- **L402 tokens are explicitly bearer instruments.** The L402 docs state: *"As the token is a
  bearer instrument, it can be passed on by the client, for example to other agents and
  wallets."* Authentication is `macaroon : preimage` — proof of *payment*, not of *identity*.
  There is no step where the client signs a challenge with an identity keypair.
- **The Lightning agent-tools repo states "no identity requirements."** Its key material is
  Lightning-node keys on a remote signer plus scoped *macaroons* (pay-only / read-only / …),
  all orthogonal to an OP subject `did:key`. The subject key is never exercised in the flow.

Sources: https://docs.lightning.engineering/the-lightning-network/l402 ·
https://github.com/lightninglabs/lightning-agent-tools

## Where it bites
- **Buyer side (SCOPE §6): safe.** The engine evaluates the agent's *own* credential locally
  (self-enforcement, like ows-op-verify / mppx-op-account). Nothing is presented to a third
  party, so there is no bearer-token exposure and no holder binding is needed.
- **Seller side (SCOPE §7, the wedge): real gap.** A credential *presented* to Aperture with no
  proof-of-possession of the subject `did:key` is a **stealable bearer token** — anyone with a
  copy could replay it. L402 provides nothing to prevent this. This is the §8 failure condition.

## Resolution (Boyd-approved — Option 1)
Present the credential as a proper **W3C Verifiable Presentation with a seller-issued
challenge/nonce**: the agent signs the nonce with its subject `did:key` (using the existing
`eddsa-jcs-2022` suite) alongside the VC. This binds the holder, closes the replay hole, adds
no new crypto, and is the standard way to do credential *presentation* correctly (a bare VC is
not a presentation; a holder-signed VP with a challenge is). The seller verifies (a) the VC
issuer-signature chain + scope/expiry/revocation, (b) the VP holder proof over the challenge
against the subject `did:key`, and (c) that `credentialSubject.id` equals the VP signer.

No separate/standalone DID-auth or PoP subsystem was built beyond this standard VP step.
