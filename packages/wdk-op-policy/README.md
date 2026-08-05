# @observer-protocol/wdk-op-policy

> **SUPPORT TIER — REFERENCE IMPLEMENTATION.** Not under active maintenance, and no production
> consumer. Read it, run it, copy from it; do not assume support.
>
> **What backs it.** Exercised by our own conformance harness: `op-exclusivity-harness` imports
> `buildObserverPolicies` in `cross-rail/cross-rail.mjs`.
>
> **Two declared dependents that do not survive contact**, stated because a reader who finds them
> would otherwise count them as adoption. `wdk-protocol-trust` declares
> `">=0.1.0,<0.3"`, a range that **excludes** the published `0.4.x`. `at-reference-wallet` declares
> `">=0.1.0"` but its demo injects a **stand-in registrar** and does not run the PR #55 engine at
> all; its own README says so. Declared, not consumed.
>
> **Versions.** Published `0.4.1`.
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

> **Provenance.** This repository is the source of the currently published version of
> `@observer-protocol/wdk-op-policy`, republished as a single snapshot each time the package is
> published. It makes no promise to track anything between releases: the tree either is the
> published version's source, or the package has not been published since it was written.
> Development history lives in a private build repository and is deliberately not published here.
>
> **Current: `0.4.1`.** Do not take that on trust. The package ships **built output**, not this
> source tree, so a directory diff against the tarball will not match. Check it like this:
>
> ```sh
> npm pack @observer-protocol/wdk-op-policy@0.4.1 && tar xzf observer-protocol-wdk-op-policy-0.4.1.tgz
> npm ci && npm run build
> diff -r package/dist dist
> ```
>
> **`gitHead` resolves here from `0.4.1` onward.** Verified against the published packument, not
> assumed: `0.4.1` records `gitHead` `1f508aeb8e3b5e59c13d92a5d4cc217771b0e444`, which is a commit
> in this repository and identical to `main`. It does not exist in the private build repo. That is
> the first release published from here.
>
> **It does not resolve for `0.2.0` through `0.4.0`.** Those were published from the
> private build repo, so the `gitHead` recorded in each of those tarballs names a commit that
> exists there and not here, while `repository.url` names this repository. Of the versions
> published before `0.4.1`, only `0.1.0` resolves against this history. The `npm pack` diff above
> is the check that works for them.
>
> Two related notes. `0.2.0` through `0.4.0` also each carry 13 stale `.d.ts` files under
> `dist/core/` describing a vendored core removed on 2026-06-25: the build did not clean `dist/`,
> so output from before that removal was republished. Nothing imports them, and `0.4.1` does not
> carry them. And the publish guard now refuses to run where the push upstream is not the
> repository `repository.url` names, which is the check that would have prevented the `gitHead`
> gap in the first place.

**The Tether-WDK instance of [OP Crossrail](https://observerprotocol.org)** — one signed mandate, one rolling cross-rail budget, one shared spend ledger, enforced on every rail an agent pays on. This engine enforces it inside the WDK transaction policy engine.

> **Co-location contract (read before relying on the cross-rail budget):** the cross-rail ledger is a local append-only file with no cross-process locking. Every adapter sharing a budget MUST be handed the SAME path IN THE SAME PROCESS. Different paths give each rail its own budget (the budget multiplies); a shared path across processes races and under-counts. Neither of these fails closed — verify co-location in your deployment. A missing path fails closed (that rail denies).

Enforce a **signed Observer Protocol delegation credential** on a Tether **WDK** account —
at the signer boundary, fail-closed — via the WDK transaction policy engine
([tetherto/wdk #55](https://github.com/tetherto/wdk/pull/55)).

The third Observer Protocol enforcement engine. Same credential, same mandate vocabulary,
same vendored core as the OWS verifier and the mppx account — here as a pair of WDK
policy rules. **The API always registers an ALLOW + DENY pair together**: the DENY
companion is the mandatory fail-closed backbone (DENY-wins + fail-closed-on-throw), so it
holds regardless of what else the consumer registered.

## Install
```sh
npm install @observer-protocol/wdk-op-policy @tetherto/wdk
```
Requires `@tetherto/wdk >= 1.0.0-beta.11` — the first published release carrying the
transaction policy engine (PR #55). Verified against `1.0.0-beta.11` (see
[`docs/CONFORMANCE.md`](docs/CONFORMANCE.md)).

## Use
```ts
import { registerObserverPolicy } from '@observer-protocol/wdk-op-policy';

registerObserverPolicy(wdk, {
  policy: {
    credentialPath: '~/.op/agent-delegation.json',     // the signed ObserverDelegationCredential
    issuerDid: 'did:web:observerprotocol.org',
    schemaAllowlist: [
      'https://observerprotocol.org/schemas/delegation/v2.1.json',
      'https://observerprotocol.org/schemas/delegation/v2.4.json',
    ],
    agentDid: 'did:web:observerprotocol.org:agents:my-agent',
    revocation: { maxStalenessHours: 24, onUnreachable: 'cache-then-deny', fetchTimeoutMs: 1500 },
    auditLog: '~/.op/decisions.jsonl',
    // evmTokens / rails as needed; defaults cover mainnet USDC/USDT
  },
  wallets: { ethereum: 'eip155:1' },                   // wallet label -> CAIP-2 (MUST resolve to a rail)
}, { wallet: 'ethereum' });

// Every write op on the governed account now verifies the mandate before signing.
// Out-of-mandate / unverifiable -> PolicyViolationError; the key never signs.
```

`registerObserverPolicy` emits two rules — an **ALLOW** (in-mandate) and a **DENY**
(violation/uncertainty). Do **not** hand-author a lone ALLOW, and **never** pair OP with a
broad permissive wildcard `ALLOW` on the same operations without the DENY — that reopens a
fail-open hole (proven; see SUPPORT-MATRIX).

## What it enforces
Gates `sendTransaction`, `signTransaction`, `transfer`, `approve`, `signTypedData` against
per-rail ceiling, counterparty, temporal window, and cross-tx velocity. Exact decode per
operation, the fail-closed construction, rail resolution, and limitations are in
[`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md); scope/non-goals in
[`docs/SCOPE.md`](docs/SCOPE.md).

## Security model
- **Fail-closed:** uncertainty (DID/status outage, thrown verification, timeout) blocks —
  the DENY condition never resolves uncertainty to a silent allow.
- **Default-deny aware:** OP relies on the engine's default-deny on governed accounts, and
  the DENY backbone holds even alongside a permissive baseline.
- **Enforcement locus:** the signer boundary, from the actual operation params — portable
  across OWS, mppx, and WDK. *The binding layer is contested; the enforcement locus is not.*
- Validated against the **published engine** (`@tetherto/wdk@1.0.0-beta.11`), 26 conformance cases.

## Develop
```sh
npm test                  # typecheck + build + fixtures + 26 conformance cases (real engine)
npm run check:core-sync   # vendored core must match ows-op-verify byte-for-byte
```
MIT.
