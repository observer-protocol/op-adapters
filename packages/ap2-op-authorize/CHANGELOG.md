# Changelog

## 0.1.0 — unreleased

This package has never been published to npm. The entries below describe defects present in
every prior state of the source, not in any released version.

### Fixed

- **Fail-open: an absent `crossRailLedgerPath` allowed a payment and silently skipped
  recording it.** Every prior state of this package behaved this way. With no ledger path
  configured, an in-scope payment returned `allow: true`, wrote nothing to the shared
  cross-rail ledger, and emitted no throw, no warning and no note. The README stated the
  opposite ("A missing path fails closed"), so the documented contract and the code
  disagreed.

  The impact was not local to AP2. The `x402` and `wdk` engines read that same ledger to
  price their own `crossRailBudget`. An unrecorded AP2 leg made them read a low total and
  allow more than the principal authorized. Measured: 80 USD moved against a budget set at
  50, with the over-spend attributable solely to the omitted field.

  An absent `crossRailLedgerPath` now denies, naming the co-location contract, and an
  allowed payment is recorded unconditionally.

  **If you ran this package without `crossRailLedgerPath` alongside x402 or WDK, your
  cross-rail budget was under-counted for every AP2 leg.** Reconcile against your audit log
  rather than the ledger.

- **Fail-open: a mandate carrying no enforceable amount bound authorized an unbounded
  payment.** An Open Payment Mandate with `constraints: []` authorized any amount to any
  payee, because the normalize loop never ran and the resulting credential carried no
  ceiling, no allow-list and no temporal bound.

  The asymmetry was the defect: *omitting* `constraints` denied, while an *empty array*
  allowed, so the more suspicious of the two inputs was the one that passed. A mandate must
  now bound value: `payment.amount_range` with a `max` is required before this engine
  authorizes anything. An unconstrained mandate is not an unlimited mandate.

### Known limitations, not fixed in this release

- Unrecognised **sub-fields** inside a recognised constraint are still silently dropped
  (`max_total`, `only_on_or_after` and similar are discarded with no note). Enforcement is
  closed at type granularity but not at field granularity.
- **Repeated constraints of the same type resolve last-wins rather than intersecting**, so a
  second `allowed_payees` list replaces the first rather than narrowing it.
- **This engine has no signer boundary.** It returns a verdict; it holds no key and produces
  no signature. A denied payment is prevented only if the calling client honors the verdict.

### Exposure at the time of this fix

Recorded because a reader may reasonably ask who was affected.

This package was never published to npm: the registry returns a bare 404 with no unpublish
record, so the name has never existed. Publication was also structurally blocked, since its
`@observer-protocol/sd-jwt-substrate` dependency is likewise unpublished and declared as a
`file:` path. The repository is public but carries no stars, forks, dependents, issues or
pull requests, and no third-party dependency on it exists anywhere we can observe.

One signal we could not resolve: GitHub reports 25 clones from 15 unique cloners in the
trailing 14 days against 1 page view. Clones far exceeding views, with no referrer and no
other social signal, is consistent with automated traffic such as CI, mirrors and security
scanners. **GitHub does not expose cloner identity, so we cannot attribute these and do not
claim they were all internal.**
