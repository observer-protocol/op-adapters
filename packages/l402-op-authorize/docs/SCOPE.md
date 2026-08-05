# L402 / Lightning Authorization Engine — Implementation Scope

**For:** Claude Code (repo-level implementation)
**Status:** Ready to build, with one spike to run first (§8)
**Last updated:** June 15, 2026

---

## 1. Objective

Add Observer Protocol's fourth enforcement engine: an L402 / Lightning adapter that lets OP's existing identity, delegation, and attestation primitives operate over the lnget (buyer) and Aperture (seller) seam of Lightning Labs' L402 stack.

This is an **adapter, not a new subsystem**. The design after technical review collapsed to: *"only the decoder changed."* We are not building a reputation model, a personhood system, or a trust-list. We are teaching the existing engine pattern (see `OWS` for x402/EVM and `mppx` for MPP/Tempo) to speak L402 / Lightning, including USDT-on-Lightning via Taproot Assets.

The credential framing is **authorization**, not personhood: *"X authorized this agent to do Y, valid until Z,"* where X may be a human, an organization, or a Sovereign certification — all expressed with primitives OP already has.

---

## 2. Design principles (non-negotiable)

- **Reuse, don't rebuild.** Adapt existing OP primitives (DID, the authorization credential, hierarchical delegation via Sovereign, `PolicyEvaluationCredential`, AT-ARS ingestion). No net-new crypto, no new credential model.
- **No-merge composition.** Compose via a vendor-neutral environment hook. Zero required changes to the Lightning Labs repo. Do not design anything that depends on upstream accepting a PR.
- **Fail closed.** If a delegation can't be verified or the proposed action falls outside its scope, deny.
- **Authorization framing.** Credentials assert "X authorized agent to do Y until Z." Do not introduce "proof of human / personhood" anywhere in v1.
- **Privacy-by-default.** Pseudonymous `did:key` by default; no public registry; holder controls which credentials to present.
- **MIT-licensed**, consistent with the OP base layer.

---

## 3. What to build

A new `l402` engine following the existing engine pattern, with two sides plus a demo:

1. **Decoder/adapter** — parse L402 challenges and BOLT11 / Taproot-Asset (USDT-on-Lightning) invoices into the engine's common evaluation input (amount + unit, counterparty, etc.).
2. **Buyer-side enforcement** on the lnget payment path (§6).
3. **Seller-side inspection** on the Aperture side (§7) — this is the novel capability and the demo headline.
4. **One-curl L402 demo** exercising both sides end to end.

---

## 4. In scope (v1)

- L402 / BOLT11 / Taproot-Asset-USDT decoder feeding the existing evaluation input.
- Authorization credential (VAC) adapted to the L402 context (§5): `did:key` subject/issuer, `eddsa-jcs-2022` proofs, `BitstringStatusListEntry` revocation — all existing primitives.
- Buyer-side: evaluate the agent's signed, revocable delegation against the proposed payment (amount in sats or Taproot-Asset USDT, L402 origin/service as counterparty, velocity); fail closed; emit a signed `PolicyEvaluationCredential`; ingest the payment preimage into AT-ARS.
- Seller-side: an Aperture-side check that verifies a presented authorization credential (and optionally an AT-ARS standing attestation) before serving.
- Vendor-neutral env hook; no LL repo changes.
- One-curl L402 demo.
- **Spike first** (§8): confirm holder binding is implicit in the flow.

---

## 5. The authorization credential (VAC)

Adapt the existing OP authorization-credential shape (same family as the `maxi-0001` trading mandate) to the L402 context. Conceptually:

| Field | Value |
|---|---|
| Issuer (X) | `did:key` of the authorizing principal — human, org, or a Sovereign certification |
| Subject | `did:key` of the agent |
| Action (Y) | Scoped to L402: permitted origin(s)/service(s) as counterparty |
| Instrument | sats and/or Taproot-Asset USDT |
| Limits | per-payment cap, total/velocity caps |
| Expiry (Z) | `validUntil` timestamp |
| Revocation | `BitstringStatusListEntry` |
| Proof | `eddsa-jcs-2022` |

- Use `did:key` as the default DID method for this capability. **Do not** use `did:web` here (that remains the Sovereign service offering), and do not introduce `did:peer` or `did:dht`.
- No selective disclosure. The agent holds its credentials and chooses which to present; verification is the standard issuer-signature chain.

---

## 6. Buyer-side flow (lnget path)

1. Agent hits an L402-gated endpoint and receives a 402 + invoice (sats or Taproot-Asset USDT).
2. Engine decodes the invoice and constructs the evaluation input (amount, unit, origin as counterparty).
3. Engine evaluates the agent's authorization credential: counterparty in scope? amount within per-payment + velocity limits? not expired? not revoked? → **fail closed** on any miss.
4. On pass: allow payment, emit a signed `PolicyEvaluationCredential` (the portable decision record), and ingest the resulting preimage into AT-ARS.

---

## 7. Seller-side flow (Aperture) — the wedge

- An Aperture-hosted endpoint can require a presented authorization credential before serving, and optionally inspect an AT-ARS standing attestation.
- Verify the issuer-signature chain and the credential scope/expiry/revocation. This is the capability macaroons structurally cannot provide and is the headline of the demo.
- This is **opt-in and seller-elective** — the permissionless default path is untouched.

---

## 8. Resolve first — holder-binding spike

Before implementing presentation/verification, run a short spike and report back:

- **Question:** Does the lnget / L402 flow already require the presenting agent to sign with its subject `did:key` (i.e., is holder binding implicit in normal operation)?
- **If yes:** no explicit DID-auth / proof-of-possession step is needed (this matches the reviewer's position). Proceed.
- **If no** — i.e., an authorization credential can be presented and accepted with no point in the flow demonstrating control of the subject key — **stop and flag to Boyd.** That would make the credential a stealable bearer token (anyone with a copy could replay it).
- **Do not** build a separate DID-auth / PoP layer without explicit sign-off. Default assumption is that binding is implicit; the spike is to confirm, not to pre-build.

---

## 9. Deliverables

- `l402` engine (decoder + buyer-side enforcement + seller-side inspection) in the existing engine layout.
- The authorization-credential adaptation for the L402 context.
- One-curl L402 demo (buyer pays a gated endpoint under a scoped delegation; seller serves only on a valid presented credential).
- A short written finding from the §8 spike.
- README/usage for the env-hook composition (how to drop it in front of lnget / Aperture with no upstream changes).

---

## 10. Out of scope / deferred (do not build)

- **Personhood / proof-of-personhood** of any kind. No World ID, no biometric or proof-of-personhood networks.
- **Third-party credential verifier / consuming external KYC or personhood attestations.** Deferred to an optional, seller-elective escalation only if a future high-assurance counterparty requires it — not in v1.
- **Trust-list governance** — collapses out with the above; not needed.
- **New reputation model.** v1 only *feeds* preimages into existing AT-ARS; it does not build reputation logic.
- **Selective disclosure** — no SD-JWT, no BBS+.
- **Sybil-resistance / uniqueness** (accepted non-goal for v1).
- **OP-as-issuer of personhood.**
- **`did:web` (here), `did:peer`, `did:dht`.**
- **Explicit DID-auth / PoP layer** unless the §8 spike shows it is required.
- **Anything requiring Lightning Labs to merge code.**

---

## 11. Acceptance criteria (definition of done)

- An agent operating under a scoped authorization credential can pay an L402-gated endpoint (sats and Taproot-Asset USDT) via the buyer-side hook, with out-of-scope/over-limit/expired/revoked attempts failing closed.
- Each allowed payment produces a signed `PolicyEvaluationCredential` and an AT-ARS preimage ingestion.
- An Aperture-side endpoint serves only when a valid authorization credential is presented, and refuses otherwise.
- The whole loop runs from a single curl-driven demo.
- Nothing in the integration requires changes to the Lightning Labs repo.
- The §8 spike finding is documented; no PoP layer was added without sign-off.
- All credentials use `did:key` + `eddsa-jcs-2022` + `BitstringStatusListEntry`; no new crypto introduced.

---

## 12. References

- Lightning Labs — L402 for agents: https://lightning.engineering/posts/2026-03-11-L402-for-agents/
- Lightning agent tools repo: https://github.com/lightninglabs/lightning-agent-tools
- L402 docs: https://docs.lightning.engineering/the-lightning-network/l402
- Tether — USDt on Lightning (Taproot Assets): https://tether.io/news/tether-brings-usdt-to-bitcoins-lightning-network-ushering-in-a-new-era-of-unstoppable-technology/
- Internal: existing `OWS` (x402/EVM) and `mppx` (MPP/Tempo) engines — follow this pattern.
- Internal: `maxi-0001` authorization credential — the VAC shape to adapt.
