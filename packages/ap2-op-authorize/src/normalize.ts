// Normalize AP2 Open Payment Mandate constraints into the internal mandate
// shape the shared policy core enforces, fail-closed on anything this engine
// cannot faithfully enforce.
//
// The mapping discipline: a constraint either (a) maps onto an existing core
// rule with IDENTICAL-or-stricter semantics, (b) is enforced by a local
// pre-check in this engine when that is trivially exact (min, execution_date,
// instrument membership), or (c) DENIES with a named reason. Nothing is
// silently ignored: an authorization restriction we cannot enforce is a
// restriction the principal counted on. AP2's own rule agrees: "any unknown
// constraint MUST be treated as failing."
//
// Deliberate v1 denials (documented, not gaps):
// - payment.budget: a LIFETIME cap across occurrences. Mapping it onto the
//   rolling-24h cross-rail window would UNDER-enforce (the window forgets
//   old spend), and wrongful acceptance is categorically worse than wrongful
//   rejection. Denied until lifetime accounting exists.
// - payment.agent_recurrence: occurrence counting is stateful; not built.
//   Exception: frequency ON_DEMAND with no max_occurrences restricts nothing
//   and passes with a note.
// - payment.allowed_pisps: the proposal's PISP identity would be
//   self-declared here, not attested; matching it would be theater.

import type { ActionScope, TradingMandate } from '@observer-protocol/policy-engine';

/** ISO-4217 minor-unit exponents for currencies this engine can scale.
 * Fail-closed: an unlisted currency cannot be scaled and denies. */
export const ISO4217_EXPONENT: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, MXN: 2, BRL: 2, SGD: 2, HKD: 2,
  JPY: 0, KRW: 0,
  BHD: 3, KWD: 3,
};

/** Render minor units as the decimal string the core's ceiling parser expects. */
export function minorToDecimal(minor: number, exponent: number): string {
  const s = String(minor).padStart(exponent + 1, '0');
  return exponent === 0 ? s : `${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
}

export interface Ap2Proposal {
  /** Merchant/payee id the payment goes to (matched against allowed_payees). */
  payeeId: string;
  /** ISO-4217 minor units. */
  amountMinor: number;
  /** ISO-4217 alpha-3, e.g. "USD". */
  currency: string;
  /** Payment instrument id, when the flow knows it. */
  instrumentId?: string;
}

export interface NormalizedAp2 {
  actionScope: ActionScope;
  tradingMandate: TradingMandate;
  notes: string[];
}

export type NormalizeResult = { ok: true; value: NormalizedAp2 } | { ok: false; reason: string };

interface Constraint {
  type?: unknown;
  [k: string]: unknown;
}

/** Normalize constraints + run the local exact pre-checks that do not map
 * onto a core rule. `expectedConditionalTransactionId` is the digest of the
 * Open Checkout Mandate this payment chain hangs off — the caller supplies it
 * from the checkout side; a payment.reference constraint without it denies. */
export function normalizeAp2Constraints(
  constraints: unknown,
  proposal: Ap2Proposal,
  opts: { nowMs: number; expectedConditionalTransactionId?: string },
): NormalizeResult {
  if (!Array.isArray(constraints)) return { ok: false, reason: '[ap2] constraints is not an array' };
  const notes: string[] = [];
  const actionScope: ActionScope = {};
  const tm: TradingMandate = {};

  for (const raw of constraints as Constraint[]) {
    const type = typeof raw?.type === 'string' ? raw.type : undefined;
    switch (type) {
      case 'payment.amount_range': {
        const currency = raw.currency;
        const max = raw.max;
        if (typeof currency !== 'string' || typeof max !== 'number') {
          return { ok: false, reason: '[ap2] amount_range missing currency/max' };
        }
        const exp = ISO4217_EXPONENT[currency];
        if (exp === undefined) return { ok: false, reason: `[ap2] currency ${currency} has no known minor-unit exponent — amount cannot be scaled (fail closed)` };
        actionScope.per_transaction_ceiling = { amount: minorToDecimal(max, exp), currency };
        const min = raw.min;
        if (typeof min === 'number' && proposal.amountMinor < min) {
          return { ok: false, reason: `[ap2] amount ${proposal.amountMinor} below amount_range.min ${min} (minor units, ${currency})` };
        }
        break;
      }
      case 'payment.allowed_payees': {
        const allowed = raw.allowed;
        if (!Array.isArray(allowed) || allowed.length === 0) return { ok: false, reason: '[ap2] allowed_payees carries no payees' };
        const ids = allowed.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string');
        if (ids.length !== allowed.length) return { ok: false, reason: '[ap2] allowed_payees entry without an id' };
        tm.counterparty = { ...(tm.counterparty ?? {}), allowList: ids };
        break;
      }
      case 'payment.allowed_payment_instruments': {
        const allowed = raw.allowed;
        if (!Array.isArray(allowed)) return { ok: false, reason: '[ap2] allowed_payment_instruments malformed' };
        if (proposal.instrumentId === undefined) {
          return { ok: false, reason: '[ap2] mandate restricts payment instruments but the proposal declares none — cannot establish the instrument (fail closed)' };
        }
        const ids = allowed.map((m) => (m as { id?: unknown })?.id);
        if (!ids.includes(proposal.instrumentId)) {
          return { ok: false, reason: `[ap2] instrument ${proposal.instrumentId} is not in allowed_payment_instruments` };
        }
        notes.push(`instrument ${proposal.instrumentId} allowed`);
        break;
      }
      case 'payment.execution_date': {
        const now = opts.nowMs;
        const nb = raw.not_before;
        const na = raw.not_after;
        if (typeof nb === 'string' && now < Date.parse(nb)) return { ok: false, reason: `[ap2] execution before not_before ${nb}` };
        if (typeof na === 'string' && now > Date.parse(na)) return { ok: false, reason: `[ap2] execution after not_after ${na}` };
        notes.push('execution_date window satisfied');
        break;
      }
      case 'payment.reference': {
        const want = raw.conditional_transaction_id;
        if (typeof want !== 'string') return { ok: false, reason: '[ap2] payment.reference missing conditional_transaction_id' };
        if (opts.expectedConditionalTransactionId === undefined) {
          return { ok: false, reason: '[ap2] mandate carries a payment.reference chain link but the caller supplied no checkout digest to check it against (fail closed)' };
        }
        if (want !== opts.expectedConditionalTransactionId) {
          return { ok: false, reason: '[ap2] payment.reference conditional_transaction_id does not match the checkout digest — chain mismatch' };
        }
        notes.push('payment.reference chain link matches');
        break;
      }
      case 'payment.budget':
        return { ok: false, reason: '[ap2] payment.budget is a LIFETIME cap across occurrences; mapping it to a rolling window would under-enforce, so it denies until lifetime accounting exists (deliberate v1)' };
      case 'payment.agent_recurrence': {
        if (raw.frequency === 'ON_DEMAND' && raw.max_occurrences === undefined) {
          notes.push('agent_recurrence ON_DEMAND with no max_occurrences restricts nothing');
          break;
        }
        return { ok: false, reason: '[ap2] payment.agent_recurrence requires stateful occurrence counting this engine does not have (deliberate v1 deny)' };
      }
      case 'payment.allowed_pisps':
        return { ok: false, reason: '[ap2] allowed_pisps cannot be enforced against a self-declared PISP identity — denied until PISP identity is attested (deliberate v1)' };
      default:
        return { ok: false, reason: `[ap2] unknown constraint type "${String(type)}" — AP2: any unknown constraint MUST be treated as failing` };
    }
  }
  // FLOOR. An Open Payment Mandate must bound the VALUE of the payment it
  // authorizes. Three inputs reach this line with nothing enforceable: an
  // empty `constraints` array (the loop above never runs), a list whose every
  // entry restricts nothing (agent_recurrence ON_DEMAND), and a list that
  // bounds only the payee. All three normalize to a scope the core has nothing
  // to enforce, so enforceMandate returns "mandate satisfied" for any amount to
  // any payee the list permits. An unconstrained mandate is not an unlimited
  // mandate, and the asymmetry it created was the wrong way round: omitting
  // `constraints` denied at line 73 while an EMPTY one allowed.
  //
  // The bar is on the normalized OUTPUT, not on the input count. Counting
  // constraints would pass a single restricts-nothing entry, which is the same
  // fall-open one constraint deeper.
  if (actionScope.per_transaction_ceiling === undefined) {
    return {
      ok: false,
      reason:
        '[ap2] mandate carries no enforceable amount bound — an Open Payment Mandate must include a ' +
        'payment.amount_range with a max before this engine will authorize against it (an unconstrained ' +
        'mandate is not an unlimited mandate)',
    };
  }
  return { ok: true, value: { actionScope, tradingMandate: tm, notes } };
}
