# Scope & non-goals

## In scope (v1)
- A custom **viem account** wrapping a base account, enforcing a signed Observer Protocol
  **ObserverDelegationCredential** (schema v2.1) at `signTransaction` / `signTypedData` /
  `signMessage`, fail-closed.
- **Credential verification** (reused verbatim from `@observer-protocol/ows-op-verify`):
  issuer pin, schema allowlist, `eddsa-jcs-2022` Data Integrity proof, `assertionMethod`
  key resolution via `did:web`, Bitstring status-list revocation.
- **Tempo transaction-plane decode:** escrow `open` / `topUp` (TempoStreamChannel) and
  cooperative close/settle/withdraw; non-escrow EVM transfers via the core resolver.
- **Mandate enforcement:** per-transaction ceiling, `maxNotionalPerOrder`, counterparty
  allow/block, temporal windows, and a **cross-session velocity** counter (in-process,
  audit-log-recoverable).
- **MPP voucher** handling: revocation re-check + cumulative monotonicity; amount bound
  inherited from the on-chain escrow.

## Out of scope (v1) — stated, not hidden
- **Not a payment rail, identity registry, or custodian.** It is the enforcement step
  between "agent decides to pay" and "key signs."
- **No on-chain reads.** Channel state (`getChannel`) and `computeChannelId` are not
  consulted in v1; channel↔voucher cap-linking and `topUp` counterparty binding are limited
  accordingly (see SUPPORT-MATRIX → "Channel linking").
- **No allow-side monthly velocity** (deny-side lower bound only; needs a stateful
  evaluator), and **no close-time true-up** of the velocity counter (v1.1).
- **Order-plane constraints** (`allowedVenues`, `allowedInstruments`, `dailyDrawdownCap`)
  are surfaced as NOT-ENFORCED notes — they need order context, not a wallet payload.
- **TIP-1011 access-key permissions** are an orthogonal, chain-level mechanism; this engine
  enforces at the signer for the MPP session/escrow model.

## Relationship to the OWS engine
The chain-agnostic enforcement core is **vendored byte-identical** from
`@observer-protocol/ows-op-verify` and drift-guarded (`npm run check:core-sync`). The
long-term plan is to extract a shared `@observer-protocol/op-verify-core` consumed by both
engines; vendoring is the deliberate v1 choice to ship the second engine without
restructuring the already-published OWS package.
