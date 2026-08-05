#!/usr/bin/env node
// Core is now the shared @observer-protocol/policy-engine package.
// Drift between engines is prevented structurally — both import from the same
// built artifact. This script is kept as a no-op so the prepublishOnly hook
// can be updated without removing the script reference.
console.log('[core-sync] core is the shared @observer-protocol/policy-engine package — no vendored copy to check');
