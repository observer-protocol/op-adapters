# Support matrix — what this engine enforces, and exactly how

Same contract discipline as `ows-op-verify` and `mppx-op-account`: nothing is claimed that a
conformance case or the demo does not exercise; where enforcement is partial or caller-supplied,
it says so. `npm test` runs the 12 cases below against the built package.

## Buyer side — lnget pre-payment hook
| Event | What it is | Enforcement |
|---|---|---|
| L402 payment (BOLT11, sats) | lnget about to pay an L402 invoice | **Decision layer** (the hook returns a verdict; the calling client must honor it). Decode the invoice amount (sats), evaluate the agent's did:key delegation against it: per-payment ceiling (`per_transaction_ceiling` / `maxNotionalPerOrder`), counterparty (the L402 origin host vs `tradingMandate.counterparty.allowList`), temporal window, velocity. Credential fully verified (did:key issuer, schema allowlist, eddsa-jcs-2022 proof, assertionMethod, revocation). **Fail-closed.** |
| L402 payment (Taproot-Asset USDT) | USDT-on-Lightning invoice | Same mandate enforcement, on the asset amount + unit **supplied by the lnget/tapd quote** (`asset: { amount, unit, decimals }`). The asset amount is not in the BOLT11 HRP, so it comes from the quote. An asset amount supplied **without decimals fails closed** (cannot scale against the mandate). On-wire Taproot-Asset invoice parsing is a documented v1 boundary. |
| Amountless invoice | BOLT11 with no amount | **Fail-closed** under any per-payment / velocity cap — the amount cannot be established, so it is treated as unenforceable and denied. |

## Seller side — Aperture presentation (the wedge)
| Check | Enforcement |
|---|---|
| Holder binding | The agent presents a W3C **Verifiable Presentation** signed by its subject `did:key` over a server-issued **challenge** (`proofPurpose: authentication`). The seller verifies the eddsa-jcs-2022 holder proof. A **bare credential with no holder proof is refused as a bearer token** — the binding macaroons structurally cannot provide. |
| Replay | `proof.challenge` must equal the issued challenge (single-use; the seller must track issued challenges). Mismatch → refuse. |
| Subject = holder | The presented credential's `credentialSubject.id` must equal the VP holder that proved key control. A credential fronted by a non-holder is refused. |
| Credential validity | The embedded VC is fully verified (did:key issuer chain, eddsa-jcs-2022 proof, validity window, revocation) via the same vendored core. Expired / revoked / mis-issued → refuse. |

## did:key only
This engine accepts **`did:key` (Ed25519) issuers and subjects only** (SCOPE §5). `did:web` is
rejected here (it remains the Sovereign service offering); `did:peer` / `did:dht` are out of scope.
The DID document is derived from the key — no network, no registry.

## The velocity counter
Caller-supplied: pass `dailyTotalRaw` (raw units already spent today in the payment asset). If a
mandate carries a velocity cap and no counter is supplied, it **fails closed**. v1 does not persist
or recover a counter (no shared audit-log replay yet — that is the buyer host's responsibility if a
velocity cap is used).

## Out of scope (SCOPE §10)
No personhood / proof-of-personhood, no trust-list, no new reputation model (v1 only feeds preimages
into existing AT-ARS via the OP adapter), no selective disclosure, no Sybil-resistance, no separate
DID-auth layer beyond the standard VP holder proof, and **nothing requiring Lightning Labs to merge code**.

## Provenance / confirmation
L402 mechanics (bearer macaroon + preimage, "no identity requirements") confirmed against the L402
docs and `lightninglabs/lightning-agent-tools` (the §8 holder-binding finding, `docs/SPIKE-FINDING.md`).
The vendored verification core is **byte-identical** to `ows-op-verify` (`npm run check:core-sync`).
**12 conformance cases pass** (`npm test`): 6 buyer, 6 seller.
