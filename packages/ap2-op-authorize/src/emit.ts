// Emit: express an OP delegation's mandate as an AP2 Open Payment Mandate,
// signed ES256 by OP's dedicated AP2 key (anchor model B — the key lives at a
// JWKS endpoint and is bound to the DID by the Ap2KeyLinkageCredential, never
// inside the DID document).
//
// The emit discipline is the mirror of the verify-side normalize discipline:
// NEVER emit an AP2 mandate BROADER than the OP mandate it expresses. Every
// OP restriction either maps onto an AP2 constraint with identical-or-
// stricter semantics, or the emit REFUSES with a named reason. Dropping a
// restriction on emit would hand the agent more authority than the principal
// signed — the emit-side equivalent of wrongful acceptance.

import { issueAp2MandateToken, type EcJwk } from '@observer-protocol/sd-jwt-substrate';
import { ISO4217_EXPONENT } from './normalize.js';

/** The slice of an OP mandate this emitter expresses. Matches the internal
 * vocabulary (actionScope / tradingMandate) the engines enforce. */
export interface OpMandateView {
  actionScope?: {
    per_transaction_ceiling?: { amount: string; currency: string };
    allowed_transaction_categories?: string[];
    cumulative_budget?: { amount: string; currency: string; window: string };
  };
  tradingMandate?: {
    maxNotionalPerOrder?: number;
    unit?: string;
    counterparty?: { allowList?: string[]; blockList?: string[]; requireIssuerClassIn?: string[] };
    temporal?: unknown;
    geographic?: unknown;
    velocity?: { dailyVolumeCap?: number; monthlyVolumeCap?: number };
    crossRailBudget?: { amount: string; currency: string; window: string; rates: Record<string, string> };
  };
  validUntil?: string;
}

export interface EmitAp2Input {
  op: OpMandateView;
  /** OP's AP2 signing key (P-256 private JWK, anchor model B). Loaded from a
   * managed path — never inline. */
  ap2SigningJwk: EcJwk;
  /** kid stamped into the header — verifiers resolve it in OP's JWKS. */
  kid?: string;
  /** The agent's PoP key, bound as cnf per AP2. */
  agentCnfJwk: Record<string, unknown>;
  /** Digest of the Open Checkout Mandate this payment mandate chains to. */
  checkoutDigest?: string;
  expSec?: number;
}

export type EmitResult = { ok: true; token: string; constraints: unknown[] } | { ok: false; reason: string };

/** Parse a decimal amount string into ISO minor units, exactly. */
function decimalToMinor(amount: string, exponent: number): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > exponent) return null; // would truncate — refuse upstream
  const minor = Number(`${m[1]}${frac.padEnd(exponent, '0')}`);
  return Number.isSafeInteger(minor) ? minor : null;
}

export async function emitAp2Mandate(input: EmitAp2Input): Promise<EmitResult> {
  const { op } = input;
  const constraints: unknown[] = [];
  const scope = op.actionScope ?? {};
  const tm = op.tradingMandate ?? {};

  // Refusals first: OP restrictions AP2 cannot carry. Emitting without them
  // would broaden the delegation.
  if (tm.velocity?.dailyVolumeCap !== undefined || tm.velocity?.monthlyVolumeCap !== undefined) {
    return { ok: false, reason: '[emit] OP velocity caps have no faithful AP2 constraint (agent_recurrence counts occurrences, not volume) — refusing to emit a broader mandate' };
  }
  if (tm.temporal !== undefined) {
    return { ok: false, reason: '[emit] OP temporal windows (recurring intra-day/timezone) do not map onto payment.execution_date without loss — refusing to emit a broader mandate' };
  }
  if (tm.geographic !== undefined) {
    return { ok: false, reason: '[emit] OP geographic restrictions have no AP2 constraint — refusing to emit a broader mandate' };
  }
  if ((tm.counterparty?.blockList?.length ?? 0) > 0 || (tm.counterparty?.requireIssuerClassIn?.length ?? 0) > 0) {
    return { ok: false, reason: '[emit] AP2 has allow-lists only; blockList/requireIssuerClassIn cannot be expressed — refusing to emit a broader mandate' };
  }
  if (scope.allowed_transaction_categories !== undefined || scope.cumulative_budget !== undefined) {
    return { ok: false, reason: '[emit] allowed_transaction_categories / cumulative_budget have no faithful AP2 constraint — refusing to emit a broader mandate' };
  }

  // Ceiling(s) -> payment.amount_range. When both per_transaction_ceiling and
  // maxNotionalPerOrder exist, the TIGHTER one is emitted.
  let ceiling: { amount: string; currency: string } | undefined = scope.per_transaction_ceiling;
  if (tm.maxNotionalPerOrder !== undefined) {
    if (tm.unit === undefined) return { ok: false, reason: '[emit] maxNotionalPerOrder without unit cannot be denominated' };
    const asNotional = { amount: String(tm.maxNotionalPerOrder), currency: tm.unit };
    if (!ceiling) ceiling = asNotional;
    else if (ceiling.currency === asNotional.currency && Number(asNotional.amount) < Number(ceiling.amount)) ceiling = asNotional;
    else if (ceiling.currency !== asNotional.currency) {
      return { ok: false, reason: `[emit] per_transaction_ceiling (${ceiling.currency}) and maxNotionalPerOrder (${asNotional.currency}) disagree on currency — cannot emit one amount_range` };
    }
  }
  if (ceiling) {
    const exp = ISO4217_EXPONENT[ceiling.currency];
    if (exp === undefined) return { ok: false, reason: `[emit] currency ${ceiling.currency} has no known minor-unit exponent — AP2 amounts are ISO-4217 minor units` };
    const max = decimalToMinor(ceiling.amount, exp);
    if (max === null) return { ok: false, reason: `[emit] ceiling ${ceiling.amount} ${ceiling.currency} is not exactly representable in minor units — refusing lossy emit` };
    constraints.push({ type: 'payment.amount_range', currency: ceiling.currency, max });
  }

  // allowList -> payment.allowed_payees. Entries pass through as merchant ids
  // (DID entries stay DIDs — the AP2 verifier matches what its flow uses).
  if ((tm.counterparty?.allowList?.length ?? 0) > 0) {
    constraints.push({
      type: 'payment.allowed_payees',
      allowed: tm.counterparty!.allowList!.map((id) => ({ id, name: id })),
    });
  }

  // crossRailBudget -> payment.budget. STRICTER by construction: OP's cap is
  // rolling-24h (refills); AP2's budget is a lifetime cap across occurrences.
  // A verifier honoring the lifetime reading authorizes LESS than the OP
  // mandate would — never more. The reverse direction (verify-side) stays a
  // deny for exactly the same reason.
  if (tm.crossRailBudget) {
    const b = tm.crossRailBudget;
    const exp = ISO4217_EXPONENT[b.currency];
    if (exp === undefined) return { ok: false, reason: `[emit] crossRailBudget currency ${b.currency} has no known minor-unit exponent` };
    const max = decimalToMinor(b.amount, exp);
    if (max === null) return { ok: false, reason: `[emit] crossRailBudget ${b.amount} ${b.currency} not exactly representable in minor units` };
    constraints.push({ type: 'payment.budget', max, currency: b.currency });
  }

  if (input.checkoutDigest) {
    constraints.push({ type: 'payment.reference', conditional_transaction_id: input.checkoutDigest });
  }

  const mandate: Record<string, unknown> = {
    vct: 'mandate.payment.open.1',
    constraints,
    cnf: { jwk: input.agentCnfJwk },
    iat: Math.floor(Date.now() / 1000),
  };
  const exp = input.expSec ?? (op.validUntil ? Math.floor(Date.parse(op.validUntil) / 1000) : undefined);
  if (exp !== undefined) mandate.exp = exp;

  const token = await issueAp2MandateToken({
    mandate,
    issuerPrivateJwk: input.ap2SigningJwk,
    ...(input.kid ? { kid: input.kid } : {}),
  });
  return { ok: true, token, constraints };
}
