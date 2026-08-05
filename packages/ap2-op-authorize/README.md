# ap2-op-authorize

> **SUPPORT TIER — REFERENCE IMPLEMENTATION.** Not under active maintenance, and no production
> consumer. Read it, run it, copy from it; do not assume support.
>
> **What backs it.** Exercised by our own conformance harness: `op-exclusivity-harness` imports this
> package in `attacks/ap2/attacks.mjs` and `attacks/_lib/ap2-oracle.mjs`. The adapter is
> interop-proven against the AP2 reference SDK.
>
> **There is no npm artifact. `@observer-protocol/ap2-op-authorize` has never been published** —
> the registry returns a bare 404 with no unpublish record, so the name has never existed. Publication
> is structurally blocked: this package depends on `@observer-protocol/sd-jwt-substrate` through a
> `file:` path, that package is itself unpublished, and npm refuses to publish a package carrying a
> `file:` dependency. **It is the artifact that is missing, not the code.** Install from source.
>
> The Observer Protocol API's `rails.registry.json` records this rail as `UNPUBLISHED` and preserves
> the coordinate it once advertised, under `prior_fiction`, rather than deleting it.
>
> Tiers for all seven Observer Protocol adapters are listed together in
> [`op-policy-engine`](https://github.com/observer-protocol/op-policy-engine#adapter-support-tiers).

**The AP2 instance of [OP Crossrail](https://observerprotocol.org)** — an agent arriving with a Google AP2 (Agent Payments Protocol) Open Payment Mandate resolves against the same shared policy core, and the same shared cross-rail spend ledger, as the x402, L402/Lightning, Tether-WDK and Fireblocks instances. Verify the SD-JWT mandate, normalize its constraints fail-closed, enforce, and debit the shared budget at authorize time.

> **Co-location contract (read before relying on the cross-rail budget):** the cross-rail ledger is a local append-only file with no cross-process locking. Every adapter sharing a budget MUST be handed the SAME path IN THE SAME PROCESS. Different paths give each rail its own budget (the budget multiplies); a shared path across processes races and under-counts. Neither of these fails closed — verify co-location in your deployment. A missing path **does** fail closed: with no `crossRailLedgerPath` set, this engine denies rather than authorize a spend it cannot record. An allowed but unrecorded AP2 leg would under-count the shared budget that the x402 and WDK gates price against, so those rails would over-spend a budget the principal set. `crossRailLedgerPath` is therefore effectively required.

AP2 (v0.2.0, FIDO-governed) expresses what a user authorized an agent to buy. It is settlement-agnostic and does not itself enforce: the mandate is evidence that networks, issuers and processors consult downstream. This engine gives it a pre-execution enforcement point: a proposed payment is evaluated against the mandate's own constraints **before** anything moves, and an allowed AP2 leg consumes the same rolling budget as the agent's USDT, sats and x402 legs.

## Interop is proven, not assumed

The e2e suite includes an oracle-gated case driven by the AP2 reference SDK itself: a mandate created by Google's Python `MandateClient` authorizes here (and denies over-ceiling here). Verification of inbound tokens is handled by [`@observer-protocol/sd-jwt-substrate`](https://github.com/observer-protocol/op-policy-engine/tree/main/packages/sd-jwt-substrate), which round-trips against the same SDK in both directions.

## The constraint mapping (and its honest edges)

| AP2 constraint | Disposition |
|---|---|
| `payment.amount_range` | Enforced — `max` via the core per-transaction ceiling; `min` via a local exact pre-check |
| `payment.allowed_payees` | Enforced — core counterparty allow-list on the payee id |
| `payment.allowed_payment_instruments` | Enforced when the proposal declares its instrument; a proposal with no declared instrument **denies** |
| `payment.execution_date` | Enforced — local exact window check |
| `payment.reference` | Enforced — the caller supplies the checkout digest; missing or mismatched chain link **denies** |
| `payment.budget` | **Denies (deliberate).** It is a lifetime cap across occurrences; mapping it onto a rolling window would under-enforce, and wrongful acceptance is worse than wrongful rejection. Waits on lifetime accounting. |
| `payment.agent_recurrence` | **Denies (deliberate)** — occurrence counting is stateful and not built. Exception: `ON_DEMAND` with no `max_occurrences` restricts nothing and passes with a note. |
| `payment.allowed_pisps` | **Denies (deliberate)** — a self-declared PISP identity is not worth matching; waits on attested PISP identity. |
| anything else | **Denies** — AP2's own rule: any unknown constraint MUST be treated as failing. |

Nothing is silently ignored. A restriction this engine cannot faithfully enforce is a restriction the principal counted on, so it denies with a named reason.

There is also a floor. A mandate must bound value: if the normalized mandate carries no per-transaction ceiling, it denies. An empty constraint list, a list whose every entry restricts nothing, and a payee list with no amount bound all land there. An unconstrained mandate is not an unlimited mandate, so `payment.amount_range` with a `max` is required before this engine authorizes anything.

## Emit (L4): OP mandates expressed as AP2, never broader

`emitAp2Mandate` expresses an OP delegation's mandate as an AP2 Open Payment Mandate (ES256 SD-JWT, agent `cnf` bound). The emit discipline mirrors the verify-side normalize discipline: every OP restriction either maps onto an AP2 constraint with identical-or-stricter semantics, or the emit **refuses** with a named reason — velocity caps, temporal windows, geographic restrictions, block-lists and lossy amounts all refuse rather than silently drop. Dropping a restriction on emit would hand the agent more authority than the principal signed. One deliberate stricter-direction mapping: OP's rolling-24h `crossRailBudget` emits as AP2's lifetime `payment.budget` — a verifier honoring it authorizes less than the OP mandate would, never more.

## The key linkage (anchor model B)

OP's AP2 signing key is a dedicated P-256 JWK published at a JWKS endpoint — deliberately **not** a key in the DID document. `issueAp2KeyLinkage` / `verifyAp2KeyLinkage` implement the binding: an `Ap2KeyLinkageCredential` issued by the DID controller, signed `eddsa-jcs-2022` with a key in the DID document's `assertionMethod`, whose subject is the exact public JWK. A relying party that trusts `did:web:observerprotocol.org` resolves the DID document once, verifies the linkage, and pins the JWK as its AP2 trust root — callback-free, offline-verifiable, and AP2 itself never has to resolve a DID. Binding a private key is refused at issue time; a linkage signed by a non-`assertionMethod` key is refused at verify time.

The full chain is a test, not a diagram: DID → linkage → trusted JWK → an emitted mandate authorizes through the same engine that enforces inbound AP2 (and a stranger's key does not).

## Trust boundary

Who may issue mandates is the deployment's decision: the engine takes the trusted issuer's public JWK (or resolver) from config and never fetches keys itself. v1 verifies root tokens; the AP2 SDK's `~~`-joined delegation chains are rejected explicitly rather than half-verified.

## Cross-rail accounting

On allow, the payment is recorded into the shared `CrossRailLedger` (rail `ap2:<currency>`, minor units) at authorize time. Any OP `crossRailBudget` evaluated by the other engines then prices that AP2 spend against the mandate's principal-attested rates — one budget, every rail, including this one.

## Install note (pre-publish)

`@observer-protocol/sd-jwt-substrate` is not yet on npm; the dependency is a `file:` link to a sibling checkout of [`op-policy-engine`](https://github.com/observer-protocol/op-policy-engine). Clone both under one parent directory. The npm publish of both packages is a pending launch decision.

## Run the tests

```
npm install && npm test
```

Five hermetic tests run everywhere. The sixth (reference-SDK interop) needs the oracle env — see the substrate README for the two-line setup — and skips loudly without it.
