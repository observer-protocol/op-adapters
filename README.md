# Observer Protocol rail adapters

Seven per-rail integrations over one shared core. An agent presents a signed delegation credential;
the adapter decodes the rail's own transaction shape, evaluates it against the mandate, and refuses
before a key signs. Same credential, same mandate vocabulary, same
[`@observer-protocol/policy-engine`](https://github.com/observer-protocol/op-policy-engine) in every
one of them. Only the decoder changes.

## They are not equally supported, and the difference is stated

An unlabelled reference integration that someone picks up expecting production support is worse than
no listing at all. Every package carries its tier at the top of its own README, and this is the same
information in one place.

| package | rail | tier |
|---|---|---|
| [`l402-op-authorize`](packages/l402-op-authorize) | Lightning / L402 | **Proven against a live system, not yet deployable** |
| [`x402-op-authorize`](packages/x402-op-authorize) | x402 | Reference implementation |
| [`mppx-op-account`](packages/mppx-op-account) | MPP / Tempo | Reference implementation |
| [`wdk-op-policy`](packages/wdk-op-policy) | Tether WDK | Reference implementation |
| [`ows-op-verify`](packages/ows-op-verify) | Open Wallet Standard / Solana | Reference, **no consumer found** |
| [`ap2-op-authorize`](packages/ap2-op-authorize) | Google AP2 | Reference, **no published package** |
| [`fireblocks-op-authorize`](packages/fireblocks-op-authorize) | Fireblocks co-signer | Reference, **no consumer found** |

**`l402` is the only one with a live consumer**, and it is still not deployed: the Lightning
interceptor that calls it has no install path yet, and its binding constraint is issuance against a
production issuer that is offline. Proven is not deployed.

**`ows-op-verify` and `fireblocks` have no consumer we could find** — searched across this
organisation's estate and the production host. An external adopter would be invisible to us, and
both target someone else's stack, so that is a live possibility rather than a technicality. This
says we found no consumer; it does not say nobody uses one.

**`ap2` has no npm artifact.** It depends on `@observer-protocol/sd-jwt-substrate` through a `file:`
path, that package is unpublished, and npm refuses to publish a package carrying a `file:`
dependency. It is the artifact that is missing, not the code. Install from source.

## Why one repository

These were seven repositories until 2026-08-05. Seven near-identical names on an organisation page
is what makes an organisation page unreadable, and the reader cost is paid by every visitor.

**Directory names follow the PACKAGE, not the old repository.** `ows-op-policy` published
`@observer-protocol/ows-op-verify`, so it lives at `packages/ows-op-verify`. npm is immutable and the
package name is baked into every published tarball; a repository name is the cheap side.

**The originals are archived, not deleted, and stay public.** A published package's `repository`
link must keep resolving and a tarball you already installed must keep verifying, whether or not the
work continued. Versions published before this move name their original repository, and following
that link lands on an archived repository that still clones and whose `gitHead` still resolves.
Their full history lives there.

## One publish guard, not seven

`scripts/refuse-dirty-publish.sh` is shared by every package through `prepublishOnly`. Before this
move there were **three different versions of it across six packages and none at all in the
seventh** — the seventh being the one with no published artifact, so the package with the least
scrutiny had the least protection.

The guard refuses to publish when the working tree is dirty, when HEAD is unpushed, when a
dependency resolves outside the registry, when the bundled core is behind the floor the package
declares, and when **the push upstream is not the repository `repository.url` names**. That last
check exists because eight published versions across two packages carried a `gitHead` resolvable
only in a private build repository while `repository.url` named a public one. Every one of those
publishes passed a guard whose stated purpose was that someone other than the publisher can fetch
the source.

## Layout

```
packages/<package-name>/    one per rail, named for the npm package
scripts/                    the shared publish guard
```
