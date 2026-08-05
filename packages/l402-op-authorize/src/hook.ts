// Vendor-neutral pre-payment hook for lnget (SCOPE §6, §2 no-merge composition).
// lnget POSTs the proposed L402 payment to a PRE_PAYMENT_HOOK_URL before paying;
// this handler decodes it, evaluates the agent's did:key delegation, and returns
// allow/deny. Fail-closed: any error denies. Zero changes to the Lightning Labs
// repo — it composes via the existing hook env var.
//
// This module is framework-agnostic (no HTTP server baked in) so it drops into
// any handler. See examples/hook-server.mjs for a minimal node http wrapper.

import type { VerifierConfig } from '@observer-protocol/policy-engine';
import { CrossRailLedger } from '@observer-protocol/policy-engine';
import { decodeL402 } from './l402.js';
import { authorizeL402Payment } from './buyer.js';

export interface HookRequest {
  /** The L402 service origin being paid (the counterparty). */
  origin: string;
  /** The BOLT11 invoice (sats), if known. */
  invoice?: string;
  /** A raw 402 challenge header, as an alternative to `invoice`. */
  challenge?: string;
  /** Taproot-Asset USDT amount from the lnget/tapd quote (raw, unit, decimals). */
  asset?: { amount: string; unit: string; decimals: number };
  /** Raw amount already spent today in the payment asset, for the velocity cap. */
  dailyTotalRaw?: string;
  /** Path to the shared cross-rail spend ledger (the same file the x402 engine
   * writes). When set, it feeds the velocity + cross-rail counters, and an
   * ALLOWED payment is recorded into it immediately — conservative semantics:
   * the budget is consumed at allow-time even if the Lightning payment later
   * fails (lnget has no post-payment callback to commit/release against). */
  crossRailLedgerPath?: string;
}

export interface HookResponse {
  decision: 'allow' | 'deny';
  reason: string;
  notes: string[];
}

/** Evaluate a proposed L402 payment. Returns allow/deny; never throws (any
 * internal error becomes a fail-closed deny). */
export async function handleL402PaymentHook(config: VerifierConfig, body: HookRequest): Promise<HookResponse> {
  try {
    if (!body || typeof body.origin !== 'string' || !body.origin) {
      return { decision: 'deny', reason: '[hook] fail-closed: missing payment origin', notes: [] };
    }
    const decoded = decodeL402({
      origin: body.origin,
      ...(body.invoice ? { invoice: body.invoice } : {}),
      ...(body.challenge ? { challenge: body.challenge } : {}),
      ...(body.asset ? { asset: body.asset } : {}),
    });
    const ledger = body.crossRailLedgerPath ? new CrossRailLedger(body.crossRailLedgerPath) : undefined;
    const verdict = await authorizeL402Payment(config, {
      decoded,
      ...(body.dailyTotalRaw !== undefined ? { dailyTotalRaw: BigInt(body.dailyTotalRaw) } : {}),
      ...(ledger ? { ledger } : {}),
    });
    if (verdict.allow && ledger) {
      // Count the spend at allow-time (see crossRailLedgerPath doc above).
      if (decoded.assetAmount !== undefined && decoded.assetUnit && decoded.assetDecimals !== undefined) {
        ledger.record({ rail: 'lightning', asset: decoded.assetUnit, amountRaw: decoded.assetAmount, decimals: decoded.assetDecimals });
      } else if (decoded.amountSats !== null) {
        ledger.record({ rail: 'lightning', asset: 'sat', amountRaw: String(decoded.amountSats), decimals: 0 });
      }
    }
    return { decision: verdict.allow ? 'allow' : 'deny', reason: verdict.reason, notes: verdict.notes };
  } catch (e) {
    return { decision: 'deny', reason: `[hook] fail-closed: ${(e as Error).message}`, notes: [] };
  }
}
