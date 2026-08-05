# Changelog

All notable changes to `@observer-protocol/mppx-op-account`.

## 0.3.1

### Provenance

- First release published from
  [`observer-protocol/mppx-op-account`](https://github.com/observer-protocol/mppx-op-account), the
  repository `repository.url` has always named. Earlier releases were published from a private
  build repository, so their `gitHead` named a commit that could not be fetched from the
  repository the package pointed at.

- The publish guard now refuses when the push upstream is not the repository `repository.url`
  names. Every earlier publish passed that guard while its stated purpose, that someone other
  than the publisher can fetch the source, did not hold.

No runtime behaviour changes in this release.

## 0.3.0

### Security

- Rebuilt against `@observer-protocol/policy-engine` 0.4.0, which closes a
  credential-controlled URL dereference. `credentialStatus[].statusListCredential` is chosen
  by whoever signs the credential and was fetched with `redirect: 'follow'` and no validation:
  no scheme check, no address-class check, no per-hop redirect check. The issuer check that
  catches a hostile status list reads the response body, so it could reject what came back and
  could not prevent the request.

  **This package bundles the engine at build time, so the fix does not reach you through an
  engine version bump. It arrives only in this release.**

  Now: a status-list URL is dereferenced only when same-origin with a `did:web` issuer or
  listed in `config.statusListOriginAllowlist` (empty by default); every outbound dereference
  is scheme-checked and address-class-checked as literals and as DNS answers, redirects are
  followed manually and re-validated per hop, and https-to-http downgrade refuses. `did:web`
  resolution is https-only; the plain-http loopback affordance is gone.

  Known residual, stated rather than omitted: DNS rebinding is not closed. The guard resolves
  and validates, then `fetch` resolves again. Closing it needs a connection-pinned dispatcher
  and therefore a runtime dependency the engine deliberately does not have.

### Changed, behaviour

- **Denial tags: a property the published schemas accept but no engine enforces now denies as
  `[unenforceable]` rather than `[unknown-rule]`.** Same verdict as before, different stated
  cause. **If you parse denial reason strings, this changes what you see** for
  `actionScope.allowed_counterparty_types` and `spending_limits.per_asset`. Everything else is
  unchanged. The distinction exists because reporting a schema-valid field as unrecognized told
  an issuer nothing about why their credential was refused.

## 0.2.1

No change to enforcement behaviour. This release changes how the package is built and
published.

### Changed — the bundled core is resolved from the registry

- `@observer-protocol/policy-engine` is now pinned to **exactly `0.3.3`** and resolved
  from the npm registry with an integrity hash. Previously `package.json` declared a
  `^0.3.0` range while the committed lockfile overrode it with a link to a local
  directory outside this repository.
- The core is bundled into `dist/` at build time, so that link meant published artifacts
  contained code identified by no version, commit or checksum.

  **This is a build-configuration change, not a behaviour change.** Verified against the
  published `0.2.0` artifact: the built output has an identical function set (56 in both).
  The only additions are three module-level constants — `PROCESS_INSTANCE`,
  `PROCESS_START_MS` and `CORE_VERSION` — each appearing once at its declaration and
  never referenced. No evaluation, verdict or credential path differs.

### Added — publish guard

- `npm publish` now refuses, before the tarball is built, when any of the following hold:
  - the working tree has uncommitted changes, including untracked files
  - `HEAD` has not been pushed, so the commit npm records as `gitHead` exists only locally
  - a runtime dependency resolves through a lockfile link to a local directory

  npm enforces none of these, and each one produces a published artifact that cannot be
  traced to a source anyone else can fetch.

## 0.2.0

### Changed — inherits fail-closed core (behavior narrowing)

- Bundles `@observer-protocol/policy-engine` 0.3.0, which is **fail-closed by default**:
  a delegation credential with an unrecognized mandate shape is now **denied** where
  earlier versions allowed it. This narrowing is inherited via the embedded core. **If
  you relied on the prior fail-open behavior, you were relying on a bug.**

### Added

- `https://observerprotocol.org/schemas/delegation/v2.4.json` added to the documented
  example `schemaAllowlist` — the current Sovereign-issued delegation schema — with a
  conformance case proving a v2.4 credential is verified and enforced end-to-end.
