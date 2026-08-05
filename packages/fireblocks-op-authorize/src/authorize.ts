// Authorize (or deny) a proposed Fireblocks transaction against the agent's
// signed, revocable delegation. Same core the x402/l402 engines run: full
// credential verification (pinned issuer, eddsa-jcs-2022 proof, revocation,
// signer-boundary) then mandate enforcement (per-payment ceiling, counterparty
// = the destination address, velocity, cross-rail budget), fail-closed on any
// miss. Only the ingest adapter differs; the verdict logic is identical.

import { verifyCredential, enforceMandate, formatBudgetUnits } from '@observer-protocol/policy-engine';
import type {
  CrossRailLedger,
  PolicyContext,
  ResolvedTransfer,
  Verdict,
  VerifierConfig,
} from '@observer-protocol/policy-engine';
import type { FireblocksAssetDef, FireblocksTxRequest } from './adapter-types.js';
import { resolvedFromFireblocks } from './fireblocks.js';

export interface FireblocksAuthInput {
  req: FireblocksTxRequest;
  /** Merged Fireblocks-asset-id -> asset def map. */
  assetMap: Record<string, FireblocksAssetDef>;
  /** chain_id / ledger rail prefix. */
  railId: string;
  /** Evaluation time (ms). Defaults to now. */
  nowMs?: number;
  /** Shared cross-rail ledger; source of both counters when set. */
  ledger?: CrossRailLedger;
  /** Explicit same-asset rolling total (raw units) — overrides the ledger. */
  dailyTotalRaw?: bigint;
  /** Explicit cross-rail total — overrides the ledger. */
  crossRailTotal?: { total: bigint; currency: string };
  /** Pre-decoded transfer view. When the caller (the handler) already decoded
   * the request, pass it so the loud-deny diagnostics and the enforced view are
   * the same object; otherwise this decodes from req.assetMap. */
  resolved?: ResolvedTransfer;
}

export async function authorizeFireblocksTransaction(
  config: VerifierConfig,
  input: FireblocksAuthInput,
): Promise<Verdict> {
  const nowMs = input.nowMs ?? Date.now();
  const notes: string[] = [];

  const resolved = input.resolved ?? resolvedFromFireblocks(input.req, input.assetMap);

  const credVerdict = await verifyCredential(config, nowMs);
  if (!credVerdict.allow || !credVerdict.cred) return credVerdict;
  const cred = credVerdict.cred;

  let ctx: PolicyContext = {
    chain_id: input.railId,
    wallet_id: String(input.req.sourceId ?? input.railId),
    api_key_id: 'fireblocks',
    transaction: { to: resolved.recipient ?? '' },
    timestamp: new Date(nowMs).toISOString(),
  };

  // Same-asset velocity counter (explicit override > ledger > absent).
  const tm = cred.credentialSubject.tradingMandate;
  let dailyTotalRaw = input.dailyTotalRaw;
  if (dailyTotalRaw === undefined && input.ledger && resolved.assetSymbol) {
    dailyTotalRaw = input.ledger.sumWindowRaw(resolved.assetSymbol, nowMs);
  }
  if (dailyTotalRaw !== undefined) {
    ctx = { ...ctx, spending: { daily_total: dailyTotalRaw.toString(), date: ctx.timestamp.slice(0, 10) } };
  }

  // Cross-rail budget total, converted at the mandate's principal-attested
  // rates. A ledger sum that cannot be established (an unpriceable in-window
  // spend) denies here rather than silently under-counting the shared cap.
  const crb = tm?.crossRailBudget;
  if (input.crossRailTotal) {
    ctx = { ...ctx, cross_rail: { total: input.crossRailTotal.total.toString(), currency: input.crossRailTotal.currency } };
  } else if (crb && input.ledger && crb.rates && typeof crb.rates === 'object') {
    const sum = input.ledger.sumWindowConverted(crb.rates, nowMs);
    if (!sum.ok) {
      return { allow: false, reason: `[cross-rail] ${sum.reason}`, notes: [...credVerdict.notes] };
    }
    ctx = { ...ctx, cross_rail: { total: sum.total.toString(), currency: crb.currency } };
    notes.push(`cross-rail ledger total before this transaction: ${formatBudgetUnits(sum.total)} ${crb.currency}`);
  }

  const verdict = enforceMandate(ctx, cred, config, resolved);
  return {
    allow: verdict.allow,
    reason: verdict.reason,
    notes: [...credVerdict.notes, ...notes, ...verdict.notes],
    cred,
  };
}
