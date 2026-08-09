# fireblocks-op-authorize

> **Provenance.** `0.1.0`, the first and only published version, was published from here and resolves
> in `observer-protocol/op-adapters`. The archived
> [`observer-protocol/fireblocks-op-authorize`](https://github.com/observer-protocol/fireblocks-op-authorize)
> holds pre-publication history only; no published version resolves there.


> **SUPPORT TIER — REFERENCE IMPLEMENTATION, NO CONSUMER FOUND.** Not under active maintenance.
> Read it, run it, copy from it; do not assume support.
>
> **What backs the tier, stated as an absence with its scope.** The only import of this package
> found anywhere is its own `examples/handler-server.mjs`. Unlike four of the other adapters, it is
> not exercised by our conformance harness. That search covered the Observer Protocol estate and the
> production host; an external adopter would be invisible to us.
>
> **There is no npm artifact.** `@observer-protocol/fireblocks-op-authorize` is unpublished (the
> registry returns 404). Install from source.
>
> Tiers for all seven Observer Protocol adapters are listed together in
> [`op-policy-engine`](https://github.com/observer-protocol/op-policy-engine#adapter-support-tiers).

Observer Protocol as the authorization gate inside Fireblocks. OP evaluates a proposed transaction against a signed delegation mandate and returns a verdict at the Fireblocks API Co-Signer's callback boundary. **Fireblocks holds the key. OP holds none. When the co-signer honors an OP deny, the signature never exists.**

That last sentence is the whole point of this demo, and it is worth reading twice: enforcement does not require custody. The signing key lives in Fireblocks' MPC infrastructure; this handler never sees a key share; and an OP `REJECT` still means the transaction is never signed.

## What this demonstrates, and what it does not (read this first)

This handler is **customer-deployed**. In the Fireblocks architecture the callback handler runs alongside the API Co-Signer, configured by the workspace owner. So what this demonstrates is **OP-operated authorization logic enrolled in the org as the workspace's callback handler** — not an anonymous third party reaching in to gate someone else's Fireblocks account. The distinction matters and it is easy to lose in retelling: the claim is "the workspace's own policy gate is Observer Protocol, and OP holds no key," not "OP can veto arbitrary Fireblocks transactions from outside."

With that scope stated plainly, here is the honest claim: OP's Fireblocks callback handler returns fail-closed APPROVE/REJECT verdicts in the documented co-signer JWT protocol, demonstrated end-to-end against a synthetic co-signer; it has not yet exchanged a single artifact with live Fireblocks infrastructure, and the deny is enforced by Fireblocks honoring the verdict, not by OP holding the key.

## The fail-closed guarantee is Fireblocks', not ours

We do not ask you to trust that this handler is reliable. The fail-closed property is the Fireblocks platform's documented behavior:

> If the Callback Handler does not respond within 30 seconds, the transaction is not signed and is canceled.
> — Fireblocks docs, https://developers.fireblocks.com/docs/integrating-third-party-aml-providers

There is no toggle that makes a timeout auto-approve. The only way to avoid a cancel when the handler needs more time is to actively return `RETRY` within the window. **Fail-open is not available.** So a crash, a network partition, or a slow OP evaluation all resolve the same way the platform resolves an explicit `REJECT`: no signature. The guarantee is carried by the co-signer, not by our uptime.

## How it fits

Fireblocks signs via an API Co-Signer that holds the MPC key share. The Co-Signer POSTs each proposed transaction (as a co-signer-signed JWT) to this handler before signing. This handler:

1. Verifies the inbound JWT against the Co-Signer's public key (RS256; certificate-pinning is the documented alternative).
2. Normalizes the Fireblocks transaction payload (`asset`, `amount`, `destAddress`, `operation`, ...) into an Observer Protocol proposal.
3. Evaluates it against the delegation mandate governing the vault, using the shipped `@observer-protocol/policy-engine` core (`evaluateMandate` + `CrossRailLedger`), unchanged.
4. Emits a signed `PolicyEvaluationCredential` as the portable proof of the decision.
5. Returns a co-signer-verifiable JWT with the action.

The policy core is reused verbatim from the x402 / l402 engines. Only the ingest adapter (JWT + Fireblocks payload → proposal) is new.

## Handler state machine

The response `action` is one of:

| Action | Meaning | Co-Signer effect |
|---|---|---|
| `APPROVE` | Within mandate scope | Co-Signer signs |
| `REJECT` | Out of scope (over cap, disallowed counterparty, etc.) | **Terminal: not signed, transaction canceled, no human escalation** |
| `RETRY` | Handler needs more than the 30s window | Co-Signer retries later |
| `IGNORE` | Take no action on this request (valid only for transaction-authorization or configuration-change requests). We never emit it — enforcement decisions are always an explicit `APPROVE` or `REJECT` so the gate is unambiguous. Documented here only to keep the state machine complete. | Request left un-acted |

Fail-closed default (no response in 30s) is Fireblocks' behavior, above — not an `action` we return.

## Demo scenario (acceptance criterion)

Under a delegation mandate with a rolling-24h `crossRailBudget`:

1. Agent initiates a payment within budget → OP `APPROVE` → Fireblocks signs → settles on Testnet.
2. A second within-budget payment → `APPROVE` → signs → settles. The `CrossRailLedger` now records both against the shared cap.
3. A third payment that pushes the 24h total over the shared cap → OP `REJECT` → **Fireblocks does not sign; no transaction exists.** The emitted `PolicyEvaluationCredential` records the denial.

The proof is the absence of the third signature, on custody infrastructure OP does not control, with OP holding no key.

## Setup (target: Testnet)

- A Fireblocks **Testnet** workspace with a **self-hosted API Co-Signer** (Testnet explicitly permits a self-hosted co-signer; Sandbox pairs only with the Fireblocks-provided communal co-signer).
- This handler deployed as the Co-Signer's callback handler (RS256 JWT keypair exchange).
- A delegation mandate whose `crossRailBudget.rates` includes the demo asset (an unlisted asset fails closed by design).

Callback handler use is a free, pre-production capability; no paid tier, sales conversation, or production KYB is a documented prerequisite.

## Live integration and diagnostics

Two things are inferred from Fireblocks docs and must be pinned against a live Testnet payload before this handler is trusted on a real co-signer: the exact Fireblocks asset ids, and the exact JWT claim nesting of the request. Both are the last places a documented-but-unverified assumption can hide, and either mismatch would make the handler deny every transaction. That is fail-closed and therefore safe, but a silent universal deny reads as "working as designed".

So both failure modes are made loud. On a deny caused by a resolution mismatch the reason names the field that failed to resolve:

- Unknown asset id: `[decode-mismatch] unrecognized Fireblocks asset id <X>`
- Claim-nesting mismatch: `[claim-nesting?] ... Top-level JWT claims: [<the actual claim keys>]`

The first Testnet mismatch names itself in one line rather than presenting as a mysterious universal denial.

## Status

Acceptance criterion demonstrated. The allow / allow / deny-over-cap scenario runs end to end through the handler (co-signer JWT in, signed APPROVE/REJECT out) against a real signed delegation credential, in `test/e2e.test.mjs`. Typecheck is clean, the package builds ESM/CJS/DTS against `@observer-protocol/policy-engine`, and the full unit + e2e suite is green.

Not yet demonstrated: live Fireblocks integration on a Testnet workspace. That is the next step and waits only on workspace provisioning.
