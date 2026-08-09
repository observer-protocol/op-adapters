# @observer-protocol/mppx-op-account

> **SUPPORT TIER — REFERENCE IMPLEMENTATION.** Not under active maintenance, and no production
> consumer. Read it, run it, copy from it; do not assume support.
>
> **What backs it.** Exercised by our own conformance harness: `op-exclusivity-harness` imports
> `createObserverAccount` in `attacks/mppx/attacks.mjs`. No consumer outside our harnesses was found
> in the Observer Protocol estate or on the production host.
>
> **Versions.** Published `0.3.1`.
>
> **Provenance.** Versions `0.1.0` and `0.3.1` resolve in
> [`observer-protocol/mppx-op-account`](https://github.com/observer-protocol/mppx-op-account) on
> `main`. `0.2.0`, `0.2.1` and `0.3.0` were published from a private build repository and resolve
> there too, on the unmerged `provenance/pre-monorepo` branch pushed 2026-08-08 — a divergent lineage,
> not an ancestor of that repository's `main`. The next release onward resolves here.
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
> `@observer-protocol/mppx-op-account`, republished as a single snapshot each time the package is
> published. It makes no promise to track anything between releases: the tree either is the
> published version's source, or the package has not been published since it was written.
> Development history lives in a private build repository and is deliberately not published here.
>
> **Current: `0.3.1`.** Do not take that on trust. The package ships **built output**, not this
> source tree, so a directory diff against the tarball will not match. Check it like this:
>
> ```sh
> npm pack @observer-protocol/mppx-op-account@0.3.1 && tar xzf observer-protocol-mppx-op-account-0.3.1.tgz
> npm ci && npm run build
> diff -r package/dist dist
> ```
>
> **`gitHead` resolves here from `0.3.1` onward.** Verified against the published packument, not
> assumed: `0.3.1` records `gitHead` `29caa5b0be3ac9f8fe01a94bce33c365a9bed1d7`, which is a commit
> in this repository and identical to `main`. It does not exist in the private build repo. That is
> the first release published from here.
>
> **It does not resolve for `0.2.0` through `0.3.0`.** Those were published from the
> private build repo, so the `gitHead` recorded in each of those tarballs names a commit that
> exists there and not here, while `repository.url` names this repository. Of the versions
> published before `0.3.1`, only `0.1.0` resolves against this history. The `npm pack` diff above
> is the check that works for them.
>
> The publish guard now refuses to run where the push upstream is not the repository
> `repository.url` names, which is the check that would have prevented that gap in the first place.
>
> *Previously this repository described itself as a "mirror" while sitting at `0.1.0`,
> two releases behind, with a vendored enforcement core whose verdict on
> `actionScope.allowed_counterparty_types` was the opposite of the shipped package's. The
> word "mirror" promised a relationship that never existed. That divergence was closed by the
> `0.2.1` snapshot, and it recurred anyway: this tree sat at `0.2.1` while `0.3.0` was the
> published version. The record of both is in this repository's history, not removed from it.*

Enforce a **signed Observer Protocol delegation credential** against every MPP / Tempo
session escrow and voucher — **at the signer boundary, fail-closed, before signing.**

A custom [viem](https://viem.sh) account that wraps your base account and verifies each
transaction the way `@observer-protocol/ows-op-verify` does for the Open Wallet Standard:
issuer-pinned, schema-allowlisted, `eddsa-jcs-2022`-verified credential → mandate
enforcement (per-rail ceilings, counterparty, temporal, velocity) → **the key signs only
if the action is within the authority its principal signed.** Pass it to mppx as `account`.

> Second enforcement engine in the Observer Protocol family. Same credential, same mandate
> vocabulary, same fail-closed discipline as the OWS verifier — different signer seam.

## Install
```sh
npm install @observer-protocol/mppx-op-account
# peer: viem (already present via mppx)
```

## Use
```ts
import { privateKeyToAccount } from 'viem/accounts';
import { createObserverAccount, tempoEscrowConfig, tempoRail, TEMPO_VOUCHER_CONFIG } from '@observer-protocol/mppx-op-account';

const base = privateKeyToAccount(process.env.AGENT_KEY);
const { caip2, rail } = tempoRail('mainnet');

const account = createObserverAccount(base, {
  policy: {
    credentialPath: '~/.op/agent-delegation.json',     // the signed ObserverDelegationCredential
    issuerDid: 'did:web:observerprotocol.org',          // pinned trusted issuer
    schemaAllowlist: [
      'https://observerprotocol.org/schemas/delegation/v2.1.json',
      'https://observerprotocol.org/schemas/delegation/v2.4.json',
    ],
    agentDid: 'did:web:observerprotocol.org:agents:my-agent',
    revocation: { maxStalenessHours: 24, onUnreachable: 'cache-then-deny', fetchTimeoutMs: 1500 },
    rails: { [caip2]: rail },
    auditLog: '~/.op/decisions.jsonl',                  // shared append-only log (velocity recovery)
  },
  tempo: { chainId: caip2, escrow: tempoEscrowConfig('mainnet'), voucher: TEMPO_VOUCHER_CONFIG },
});

// Hand the wrapped account to mppx — every escrow + voucher is now OP-enforced.
const session = tempo.session.manager({ account, maxDeposit: '50' });
```

On a denied action the call throws `ObserverDenyError` (with `.reason` and `.notes`) and
the underlying key is **never** invoked.

## What it enforces
Escrow `open` is the enforcement chokepoint (full mandate, incl. velocity); `topUp`
deposits are mandate-checked and velocity-counted; vouchers get a revocation re-check and
monotonicity, with their amount bounded by the on-chain escrow. Exact behavior, the
velocity-counter scope, recovery semantics, and v1 limitations are stated plainly in
[`docs/SUPPORT-MATRIX.md`](docs/SUPPORT-MATRIX.md). Scope and non-goals:
[`docs/SCOPE.md`](docs/SCOPE.md).

## Security model
- **Fail-closed:** any constraint that cannot be established from the payload, and any
  internal error, denies. The key never signs on a deny.
- **Enforcement locus:** the signer boundary, from the actual transaction/voucher the
  wallet is about to sign — not an API or platform layer. The same signed mandate is
  portable across OWS, mppx, and WDK.
- **Confirmed against `mppx@0.7.0`** (real escrow ABI + voucher types) and exercised by
  `harness/live-fire.mjs` with the real ABI and a real viem signer.

## Develop
```sh
npm run typecheck && npm test     # typecheck + 24 conformance cases
npm run livefire                  # real mppx ABI + real viem signer
npm run check:core-sync           # vendored core must match ows-op-verify byte-for-byte
```

MIT.
