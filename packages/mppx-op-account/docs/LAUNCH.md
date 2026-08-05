# Launch prep — mppx-op-account (second-engine artifact)

**No key ceremony required.** Unlike the keystate work, this launch touches no signing
keys: `#key-5` runtime issuance and the verify endpoints are already live. This is a
client-side library — it consumes credentials, it does not issue them.

## Launch gate (all must be green)
- [x] **Conformance:** `npm test` → 24/24 (typecheck + fixtures + cases).
- [x] **Live-fire:** `npm run livefire` → 8/8 against the **real `mppx@0.7.0` escrow ABI**
      + a real viem signer (decode + seam + fail-closed proven).
- [x] **Core drift guard:** `npm run check:core-sync` → vendored core byte-identical to
      `ows-op-verify`.
- [ ] **Secrets scan** before first push (no keys, tokens, or prod endpoints in the tree).
- [ ] **Boyd's day:** repo create + `npm publish` + Loom + launch post — Boyd-gated, same
      cadence as the OWS launch.

## ⚠ Pre-publish Boyd action — npm granular access token
So the publish flow never fights interactive 2FA again, mint a **granular access token
scoped to `@observer-protocol`** before publishing (from the hardening list). This is a
Boyd action (needs your npm account + 2FA). When you're at a terminal:

- npmjs.com → Access Tokens → Generate New Token → **Granular Access Token**
- Packages and scopes: **Read and write**, scope **`@observer-protocol`**
- Expiration: your call (90d typical); Org/2FA: leave required
- Save it to the publish environment (e.g. `NPM_TOKEN` in CI or `~/.npmrc`
  `//registry.npmjs.org/:_authToken=...`, mode 600)

Then `npm publish` (the package is already `publishConfig.access: public`).
`prepublishOnly` runs `check:core-sync && typecheck && test` automatically.

## Full guard in v1 (v1.1 folded in pre-launch)
The original v1.1 items now ship in v1:
- **Channel-id derivation** (`computeChannelId`) links every `open` to its channel →
  voucher cap guard and `topUp` counterparty binding are enforced.
- **Close-time velocity true-up** refunds unused escrow headroom on `close`/`settle`.

## Honest carry-forwards (in SUPPORT-MATRIX, not buried)
- Velocity counter is `(subject-DID, UTC-day)` scoped, recovered by **shared-path** audit-
  log replay; process-local if the log path is not shared.
- A `topUp` on a channel with no locally-known open (cold process, no shared log) fails
  closed under a counterparty mandate — fail-safe direction.
- Monthly velocity is deny-side lower-bound only (vendored-core behavior); allow-side
  monthly accounting needs a stateful evaluator.

## Positioning (for the launch post / MoonPay thread)
This is the **second engine** proving OP's enforcement is portable across signer seams
(OWS executable → mppx viem account → WDK), from the raw payload, fail-closed — *"the
binding layer is contested; the enforcement locus is not."* The engine stands on its own
as a citable MPP-ecosystem artifact, independent of any collaborator.

**Lightspark: decoupled from this launch.** Not in the launch sequence, and not referenced
in the launch posts (drafts A/B/C carry no Lightspark angle). It is a separate, post-launch,
complementary / portable-trust touch (not an enforcement pitch on their turf; conditional
framing, no ask), handled by Boyd separately.
