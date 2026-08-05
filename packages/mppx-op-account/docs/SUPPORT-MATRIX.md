# Support matrix — what this engine enforces, and exactly how

Same contract discipline as `@observer-protocol/ows-op-verify`: **nothing is claimed
that a conformance fixture or the live-fire harness does not prove; nothing a reader would
discover on their own is hidden.** Where enforcement is partial or inherited, it says so.

## Enforcement events
| Event (viem seam) | What it is | Enforcement |
|---|---|---|
| `signTransaction` → escrow **`open`** | `open(payee, token, deposit, salt, authorizedSigner)` on the TempoStreamChannel contract | **Chokepoint for the structured `{to, data}` shape ONLY. A real escrow open is not currently recognised.** mppx emits an open as a batched `calls[]` transaction with no top-level `to`, which this engine does not decode: it classifies as non-escrow, resolves as a 0-value native transfer, passes any ceiling, and is **not** counted into velocity. Measured at zero, not theorized. Fix tracked. For the structured shape the following all apply: full vendored mandate: per-tx ceiling / `maxNotionalPerOrder`, counterparty (payee), temporal, velocity. `deposit` counted into the daily velocity counter. The channel id is **derived** (`computeChannelId`) and linked, so vouchers and top-ups bind to it. Credential fully verified (issuer pin, schema allowlist, eddsa-jcs-2022 proof, assertionMethod, revocation). |
| `signTransaction` → escrow **`topUp`** | `topUp(channelId, additionalDeposit)` | `additionalDeposit` mandate-checked (ceiling/velocity) and counted into velocity; the channel cap accumulates. **Counterparty inherited from the linked channel's payee** — so a counterparty mandate is enforced on top-ups too. (A top-up on a channel with no locally-known open — e.g. a cold process with no shared audit log — fails closed under a counterparty mandate.) |
| `signTransaction` → escrow **`close` / `settle`** | `close/settle(channelId, cumulativeAmount, sig)` | Benign (no new spend) **and trues up velocity**: refund = counted deposit − final cumulative, returned to the day's counter so unused escrow headroom is freed. |
| `signTransaction` → **`requestClose` / `withdraw`** | finalize / withdraw | Benign — no new spend, no cumulative. Allowed (credential still verified). |
| `signTransaction` → **non-escrow** | any other Tempo tx | Decoded by the core resolver and mandate-enforced like any transfer (native value / ERC-20 / EIP-3009), counted into velocity. **Caveat: a real batched `calls[]` transaction lands in this row and is measured at zero**, because the resolver reads only top-level `to`/`data`/`value`. Enforcement here is therefore vacuous for the shape mppx actually emits. |
| `signTypedData` → **`Voucher`** | EIP-712 `Voucher{channelId, cumulativeAmount}` | Fresh credential **+ revocation re-check** (halts in-flight sessions on revocation); cumulative **monotonicity**; cumulative **≤ the linked escrow cap**. Defense-in-depth above the on-chain escrow bound. |
| `signTypedData` → non-voucher | any other typed data | **Allowed unconditionally on the default config, with no mandate evaluation.** The claim that it cannot move escrowed funds is true and beside the point: an EIP-3009 `TransferWithAuthorization` moves the wallet's token balance directly, and mppx's own x402 client emits exactly that shape. Treat this surface as ungated. Fix tracked. |
| `signMessage` | raw message | **Denied by default** (opaque content could authorize a payment). Opt in with `allowSignMessage` only for non-payment flows. |

## Channel-id derivation (shipped)
The `open` call does not carry the `channelId` in calldata; it is computed on-chain via
`computeChannelId(payer, payee, token, salt, authorizedSigner, escrowContract, chainId)`.
The adapter **derives the same id offline** at `signTransaction` (all inputs are in the
`open` calldata + config + signer address), using the identical
`keccak256(abi.encode(...))` path the SDK uses. This links each `open` to its channel, so
the voucher cap guard and top-up counterparty binding hold without any on-chain read.

## The velocity counter (Option A)
- **Scope:** `(subject-DID, UTC-day)`, in raw token units, per asset.
- **Counts:** escrow `open` + `topUp` deposits; **trues up** on `close`/`settle` (refund of
  unused deposit), so the counter tracks real committed spend, not just gross deposits.
- **Recovery:** rebuilt at startup by **replaying the shared append-only JSONL audit log**
  for the subject DID (opens add, settles refund). Cheap, bounded by events/day.
- **Soundness condition:** complete recovery requires **all processes for the key to share
  one audit-log path**. If the path is process-private, recovery is **process-local**.
- **Fail-closed:** if the counter cannot be established (audit log unreadable), a mandate
  carrying any velocity cap is **denied** — never silently allowed.
- **Monthly caps** are enforced deny-side as a lower bound using the daily figure (vendored
  core behavior); allow-side monthly accounting needs a stateful evaluator.

## Per-voucher amount bound
A voucher's `cumulativeAmount` is bounded on-chain by the escrow `deposit` (the contract
rejects a voucher above the channel deposit and pays only the registered payee), and the
adapter additionally enforces `cumulative ≤ linked escrow cap`, monotonicity, and a
fresh revocation check on every voucher. The escrow `open` that set the deposit is fully
mandate-enforced. For MPP sessions the mandate `per_transaction_ceiling` /
`maxNotionalPerOrder` bounds the **session escrow** (the max the whole session can spend),
matching MPP's model where the escrow is the funding commitment.

## Provenance / confirmation
Escrow contract addresses, selectors, ABI offsets, the `computeChannelId` formula, and
voucher field names are **confirmed against `mppx@0.7.0`** (`dist/tempo/legacy/session/`
`escrow.abi.js`, `Channel.js`, `Voucher.js`, `internal/defaults`) and exercised by
`harness/live-fire.mjs` using the real ABI + derived channel id + a real viem signer. The
vendored enforcement core is byte-identical to `ows-op-verify` (`npm run check:core-sync`).
28 conformance cases + 8 live-fire checks pass.
