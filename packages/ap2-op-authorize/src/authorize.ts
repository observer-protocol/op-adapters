// Authorize (or deny) a proposed payment against an inbound AP2 Open Payment
// Mandate. The pipeline: substrate-verify the SD-JWT mandate token (signature
// against the caller-trusted issuer key, RFC 9901 integrity) -> normalize its
// constraints into the internal mandate shape (fail-closed on anything not
// faithfully enforceable) -> run the SAME enforceMandate the x402/l402/wdk/
// Fireblocks engines run -> on allow, record the spend into the shared
// CrossRailLedger so an AP2-leg payment consumes the same rolling budget as
// every other rail.
//
// Trust boundary: WHO may issue mandates is the caller's decision, expressed
// through `issuerPublicJwk` / a resolver — this engine never fetches keys.
// v1 scope: root tokens (the AP2 SDK's ~~-joined delegation chains are
// rejected by the substrate, not half-verified).

import { enforceMandate, CrossRailLedger } from '@observer-protocol/policy-engine';
import type { ObserverDelegationCredential, PolicyContext, ResolvedTransfer, VerifierConfig } from '@observer-protocol/policy-engine';
import { verifyAp2MandateToken, AP2_VCT, type EcJwk } from '@observer-protocol/sd-jwt-substrate';
import { ISO4217_EXPONENT, normalizeAp2Constraints, type Ap2Proposal } from './normalize.js';

export interface Ap2AuthorizeConfig {
  /** The issuer key this deployment trusts for inbound AP2 mandates. */
  issuerPublicJwk: EcJwk;
  /** Path to the shared cross-rail ledger. When set, allowed payments are
   * recorded (rail `${railId}:${currency}`) and count against any OP
   * crossRailBudget evaluated by the other engines. */
  crossRailLedgerPath?: string;
  /** Rail id for ctx/ledger entries. Default "ap2". */
  railId?: string;
  /** Core VerifierConfig fields used by enforceMandate (rails table etc).
   * Minimal default is derived when omitted. */
  coreConfig?: Partial<VerifierConfig>;
}

export interface Ap2AuthorizeInput {
  /** The inbound AP2 mandate token (root SD-JWT, reference-SDK envelope). */
  token: string;
  proposal: Ap2Proposal;
  /** Digest of the Open Checkout Mandate, when the flow has one (required to
   * satisfy a payment.reference constraint). */
  expectedConditionalTransactionId?: string;
  nowMs?: number;
}

export interface Ap2Verdict {
  allow: boolean;
  reason: string;
  notes: string[];
}

export async function authorizeAp2Payment(cfg: Ap2AuthorizeConfig, input: Ap2AuthorizeInput): Promise<Ap2Verdict> {
  const nowMs = input.nowMs ?? Date.now();
  const railId = cfg.railId ?? 'ap2';

  // 1. Cryptographic verification of the mandate token, fail-closed.
  const verified = await verifyAp2MandateToken(input.token, cfg.issuerPublicJwk);
  if (!verified.ok) return { allow: false, reason: `[ap2-verify] ${verified.reason}`, notes: [] };
  const mandate = verified.mandate;

  if (mandate.vct !== AP2_VCT.paymentOpen) {
    return { allow: false, reason: `[ap2] vct "${String(mandate.vct)}" is not an Open Payment Mandate — this engine authorizes payments only against ${AP2_VCT.paymentOpen}`, notes: [] };
  }
  if (typeof mandate.exp === 'number' && mandate.exp <= Math.floor(nowMs / 1000)) {
    return { allow: false, reason: `[ap2] mandate expired at ${mandate.exp}`, notes: [] };
  }

  // 2. Normalize constraints; local exact pre-checks run inside.
  const normalized = normalizeAp2Constraints(mandate.constraints, input.proposal, {
    nowMs,
    ...(input.expectedConditionalTransactionId !== undefined ? { expectedConditionalTransactionId: input.expectedConditionalTransactionId } : {}),
  });
  if (!normalized.ok) return { allow: false, reason: normalized.reason, notes: [] };

  // 3. Scale the proposal into the resolved-transfer view the core enforces.
  const exp = ISO4217_EXPONENT[input.proposal.currency];
  if (exp === undefined) {
    return { allow: false, reason: `[ap2] proposal currency ${input.proposal.currency} has no known minor-unit exponent (fail closed)`, notes: [] };
  }
  if (!Number.isInteger(input.proposal.amountMinor) || input.proposal.amountMinor < 0) {
    return { allow: false, reason: '[ap2] proposal amountMinor must be a non-negative integer of minor units', notes: [] };
  }
  const resolved: ResolvedTransfer = {
    kind: 'native',
    assetSymbol: input.proposal.currency,
    amount: BigInt(input.proposal.amountMinor),
    decimals: exp,
    recipient: input.proposal.payeeId,
    recipientKind: 'wallet',
    notes: [`AP2 payment of ${input.proposal.amountMinor} minor ${input.proposal.currency} to ${input.proposal.payeeId}`],
  };

  // 4. Synthetic internal credential carrying ONLY the normalized mandate —
  //    the trust work was done in step 1; this object exists so the SAME core
  //    rules (ceiling, counterparty, temporal) evaluate AP2 exactly as they
  //    evaluate every other rail's mandates.
  const cred = {
    credentialSubject: {
      id: 'ap2:inbound',
      actionScope: normalized.value.actionScope,
      delegationScope: { may_delegate_further: false },
      enforcementMode: 'pre_transaction_check',
      tradingMandate: normalized.value.tradingMandate,
    },
  } as unknown as ObserverDelegationCredential;

  const config = {
    rails: { [railId]: { rail: railId, currency: input.proposal.currency, decimals: exp, family: 'other' } },
    allowContractCalls: false,
    ...cfg.coreConfig,
  } as VerifierConfig;

  const ctx: PolicyContext = {
    chain_id: railId,
    wallet_id: 'ap2:agent',
    api_key_id: 'ap2',
    transaction: { to: input.proposal.payeeId },
    timestamp: new Date(nowMs).toISOString(),
  };

  const verdict = enforceMandate(ctx, cred, config, resolved);
  const notes = [...normalized.value.notes, ...verdict.notes];
  if (!verdict.allow) return { allow: false, reason: verdict.reason ?? 'denied', notes };

  // 5. Count the spend at authorize time — the shared-ledger wiring that makes
  //    an AP2 leg consume the same rolling budget as USDT/sats/x402 legs.
  //
  //    A missing path DENIES. This is not a config nicety: an allowed-but-
  //    unrecorded AP2 leg corrupts a DIFFERENT engine's enforcement inputs.
  //    The sibling x402/WDK gates read this ledger to price their own
  //    crossRailBudget, so a silent omission here lets them under-count and
  //    over-spend a budget the principal set. Allowing without recording would
  //    be a fail-open in another package, which is exactly the failure this
  //    engine cannot detect and the operator cannot see.
  if (!cfg.crossRailLedgerPath) {
    return {
      allow: false,
      reason:
        '[cross-rail] no crossRailLedgerPath configured — this engine will not authorize a spend it cannot record. ' +
        'An unrecorded AP2 leg silently under-counts the shared rolling budget that the x402/WDK gates enforce against, ' +
        'so they would allow more than the principal authorized. Supply the SAME ledger path IN THE SAME PROCESS as ' +
        'every other adapter sharing the budget (see the co-location contract in the README).',
      notes,
    };
  }
  const ledger = new CrossRailLedger(cfg.crossRailLedgerPath);
  ledger.record({
    rail: `${railId}:${input.proposal.currency}`,
    asset: input.proposal.currency,
    amountRaw: String(input.proposal.amountMinor),
    decimals: exp,
  });
  notes.push(`recorded ${input.proposal.amountMinor} minor ${input.proposal.currency} into the shared cross-rail ledger`);
  return { allow: true, reason: verdict.reason ?? 'within mandate scope', notes };
}
