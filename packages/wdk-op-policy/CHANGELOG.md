# Changelog

All notable changes to `@observer-protocol/wdk-op-policy`.

## 0.4.1

### Fixed

- The published tarball no longer carries stale type declarations. `0.2.0` through `0.4.0` each
  shipped 13 `.d.ts` files under `dist/core/` describing the vendored core removed in June: the
  build did not clean `dist/`, so output from before that removal was republished. They declared
  modules the package does not contain. Nothing imported them, and no runtime behaviour changes
  in this release.

### Provenance

- This is the first release published from
  [`observer-protocol/wdk-op-policy`](https://github.com/observer-protocol/wdk-op-policy), the
  repository `repository.url` has always named. Earlier releases were published from a private
  build repository, so their `gitHead` named a commit that could not be fetched from the
  repository the package pointed at. From this version, `gitHead` resolves where the package
  says it should.

## 0.4.0

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

## 0.3.0

### Changed — inherits fail-closed core (behavior narrowing)

- Bundles `@observer-protocol/policy-engine` 0.3.0, which is **fail-closed by default**:
  a delegation credential with an unrecognized mandate shape is now **denied** where
  earlier versions allowed it. This narrowing is inherited via the embedded core. **If
  you relied on the prior fail-open behavior, you were relying on a bug.**

### Added

- `https://observerprotocol.org/schemas/delegation/v2.4.json` added to the documented
  example `schemaAllowlist` — the current Sovereign-issued delegation schema — with a
  conformance case proving a v2.4 credential is verified and enforced end-to-end.
