# @observer-protocol/l402-op-authorize

> **SUPPORT TIER — PROVEN AGAINST A LIVE SYSTEM, NOT YET DEPLOYABLE.** The strongest evidence of
> the seven Observer Protocol adapters, and still not something to put in front of production
> traffic.
>
> **What backs it.** `op-lnd-interceptor/op-lnd-middleware.mjs` imports `authorizeL402Payment` and
> evaluates the verdict **in-process**. The mainnet existence proof (lnd v0.20.1-beta, one node,
> ours) refused 200,000 sat against a 100,000 sat ceiling with a live channel and 481,500 sat of
> local balance; allowed and settled 10 sat with a real preimage; and had a hand-rolled gRPC client,
> running as a separate uid and presenting the sanctioned macaroon, refused by the node.
>
> **What is missing.** The interceptor has no install path yet (systemd unit or container), and its
> binding constraint is real issuance: the proof used a demo `did:key` generated on the box, and the
> production issuer is offline. **Proven is not deployed.**
>
> **Versions.** Published `0.4.0`; its consumer declares `^0.3.2`.
>
> **Provenance.** Versions `0.1.0` through `0.4.0` resolve in
> [`observer-protocol/l402-op-authorize`](https://github.com/observer-protocol/l402-op-authorize)
> (archived, read-only). The next release onward resolves here.
> The Observer Protocol API's rail registry no longer carries a pin. **Ruled 2026-08-05:** the
> field was named `version` and read as "these versions are known to work together", while
> nothing enforced or checked it — the running server never reads it. It is now
> `published_version_recorded` with a required `recorded_on` date: what was published when
> someone last looked. It does not track publication and is not automated to. **It is not a
> statement that these versions have been verified together** — no such verification exists,
> and a real compatibility matrix would be a separate artifact.
>
> Tiers for all seven Observer Protocol adapters are listed together in
> [`op-policy-engine`](https://github.com/observer-protocol/op-policy-engine#adapter-support-tiers).

**The L402/Lightning instance of [OP Crossrail](https://observerprotocol.org)** — one signed mandate, one rolling cross-rail budget, one shared spend ledger, enforced on every rail an agent pays on. This engine evaluates it at the Lightning pre-payment hook.

> **Decision layer, not a chokepoint.** `handleL402PaymentHook` returns `allow` or `deny` and never throws. The engine holds no key, produces no signature and pays nothing, so a denied payment is prevented only if the calling client honors the verdict. No wiring from `lnget` to this hook is evidenced in this repo. Treat the deny as advice your client must act on, and verify that path in your own deployment.

> **Co-location contract (read before relying on the cross-rail budget):** the cross-rail ledger is a local append-only file with no cross-process locking. Every adapter sharing a budget MUST be handed the SAME path IN THE SAME PROCESS. Different paths give each rail its own budget (the budget multiplies); a shared path across processes races and under-counts. Neither of these fails closed — verify co-location in your deployment. A missing path fails closed (that rail denies).

Observer Protocol's fourth enforcement engine: **authorization for L402 / Lightning agentic
commerce**, over the `lnget` (buyer) and Aperture (seller) seam of Lightning Labs' L402 stack.
Composes via a vendor-neutral env hook, with **no changes to any Lightning Labs repo**.

Same vendored verification core as [`ows-op-verify`](https://github.com/observer-protocol/ows-op-policy)
(x402/EVM, Solana) and [`mppx-op-account`](https://github.com/observer-protocol/mppx-op-account)
(MPP/Tempo). Only the decoder changed: here it speaks L402 / BOLT11 / Taproot-Asset USDT.

## What it does
- **Buyer side (`lnget`):** before paying an L402 invoice, verify the agent's signed, revocable
  `did:key` delegation against the proposed payment (amount in sats or Taproot-Asset USDT, the
  L402 origin as counterparty, per-payment + velocity limits), **fail closed**, then emit a
  signed `PolicyEvaluationCredential` and ingest the preimage into AT-ARS.
- **Seller side (Aperture), the wedge:** verify a **holder-bound** authorization credential — a
  W3C Verifiable Presentation signed by the subject `did:key` over a server challenge — before
  serving. Macaroons alone structurally cannot provide this type of binding.

## Authorization, not personhood
Credentials assert *"X authorized this agent to do Y, valid until Z"* (X = a human, org, or
Sovereign certification). `did:key` subject/issuer, `eddsa-jcs-2022` proofs,
`BitstringStatusListEntry` revocation. No personhood, no trust-list, no new crypto.

## Install
```sh
npm install @observer-protocol/l402-op-authorize
```
Zero runtime dependencies. Node >= 18.

## Buyer side — drop in front of lnget (no Lightning Labs code changes)
Run the OP hook next to lnget and point lnget's `PRE_PAYMENT_HOOK_URL` at it:
```sh
node examples/hook-server.mjs            # serves POST /hook
```
```sh
curl -s -X POST http://127.0.0.1:8787/hook -H 'content-type: application/json' \
  -d '{"origin":"https://api.example.com/paid","invoice":"lnbc500u1..."}'
# → {"decision":"allow"|"deny","reason":"..."}   (HTTP 200 allow, 402 deny)
```
Or embed the handler directly:
```ts
import { handleL402PaymentHook } from '@observer-protocol/l402-op-authorize';
const { decision, reason } = await handleL402PaymentHook(config, {
  origin: 'https://api.example.com/paid', invoice: 'lnbc500u1...',
  // Taproot-Asset USDT: asset: { amount: '5000000', unit: 'USDT', decimals: 6 }
});
```
`config` is a `VerifierConfig` pinned to the principal's `did:key` (`issuerDid`), with the agent's
signed delegation at `credentialPath`, `schemaAllowlist`, and `rails: { lightning: { currency:'sat', decimals:0 } }`.
Out-of-mandate, over-limit, expired, revoked, or unestablishable amounts **deny**. The deny is a returned verdict, not a refusal to sign: see the decision-layer note above. Whether `lnget` pays is a property of the client that calls the hook.

## Seller side — Aperture, holder-bound (the wedge)
```ts
import { issueChallenge, verifyPresentationForServing } from '@observer-protocol/l402-op-authorize';
const ch = issueChallenge('api.example.com');                 // give to the requester
// agent returns a Verifiable Presentation signed by its subject did:key over ch.challenge
const d = await verifyPresentationForServing(config, vp, { challenge: ch.challenge, domain: ch.domain });
if (d.serve) serve(); else refuse(d.reason);
```
The agent builds the VP with `signPresentation({ credential, holderDid, holderPrivateKey, challenge })`.
A bare credential (no holder proof), a replayed challenge, a credential whose subject is not the
presenter, or an expired/revoked credential are all **refused**. This is the binding macaroons cannot give.

## Why holder binding
L402 tokens are bearer instruments and the agent never signs with its `did:key` in the native flow, so
a presented credential with no proof-of-possession would be replayable. The seller side requires a
holder-signed Verifiable Presentation over a challenge — standard W3C, no new crypto. Details:
[`docs/SPIKE-FINDING.md`](docs/SPIKE-FINDING.md). Scope + boundaries: [`docs/SCOPE.md`](docs/SCOPE.md),
[`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md).

## Develop
```sh
npm test                  # typecheck + build + 12 conformance cases (6 buyer, 6 seller)
npm run check:core-sync   # vendored core must be byte-identical to ows-op-verify
node demo/scenes.mjs      # the self-narrating buyer→seller demo
```
