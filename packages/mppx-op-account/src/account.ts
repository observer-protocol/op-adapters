import { parseConfig, appendAudit } from '@observer-protocol/policy-engine';
import type { ObserverDelegationCredential, ResolvedTransfer, VerifierConfig } from '@observer-protocol/policy-engine';
import type {
  BaseAccount,
  Hex,
  ObserverAccountConfig,
  TransactionLike,
  TypedDataLike,
} from './adapter-types.js';
import { ObserverDenyError } from './adapter-types.js';
import { classifyEscrowCall, normalizeTx } from './tempo.js';
import { decodeVoucher } from './voucher.js';
import { SessionState, utcDay, type SessionAuditEntry } from './session-state.js';
import { verifyCredential, enforceMandate, type Verdict } from './verify.js';

// The viem custom-account seam. Wraps a base account and enforces the signed OP
// mandate at the signer boundary, fail-closed, before delegating to the base
// account's real signing. Pass the result to mppx as `account`.
//
// Enforcement model (see SUPPORT-MATRIX):
//   signTransaction → escrow OPEN is the chokepoint: full vendored mandate
//     (ceiling/counterparty/temporal/velocity), maxDeposit counted into the
//     daily velocity counter. Non-escrow Tempo payments are mandate-enforced
//     like any transfer. Escrow settle/close are benign (no new spend).
//   signTypedData → MPP voucher: the voucher's amount is bounded on-chain by the
//     already-mandate-checked escrow, so the adapter adds (a) a fresh credential
//     + REVOCATION re-check (halts in-flight sessions if the mandate is revoked)
//     and (b) cumulative monotonicity. It does not re-run the amount mandate
//     per voucher — that bound is inherited from the escrow.

export interface ObserverAccount extends BaseAccount {
  /** The wrapped base account. */
  readonly base: BaseAccount;
}

export function createObserverAccount(base: BaseAccount, cfg: ObserverAccountConfig): ObserverAccount {
  const config: VerifierConfig = parseConfig(cfg.policy);
  const chainId = cfg.tempo.chainId;
  if (!config.rails[chainId]) {
    throw new Error(
      `createObserverAccount: tempo.chainId ${chainId} has no rail mapping in policy.rails — add it so the mandate's same-currency comparisons are defined on this chain`,
    );
  }
  const railDef = config.rails[chainId]!;
  // numeric chain id for computeChannelId (CAIP-2 "eip155:N" → N).
  const numericChainId = Number(chainId.split(':')[1] ?? '0');

  let sessionState: SessionState | undefined;
  let currentSubject: string | undefined;
  const stateFor = (cred: ObserverDelegationCredential): SessionState => {
    const subject = cred.credentialSubject.id;
    currentSubject = subject;
    if (!sessionState) sessionState = new SessionState(config.auditLog, subject);
    return sessionState;
  };

  const audit = (entry: Partial<SessionAuditEntry> & Pick<SessionAuditEntry, 'kind' | 'decision' | 'reason'>): void => {
    const full: SessionAuditEntry = {
      ts: new Date().toISOString(),
      notes: entry.notes ?? [],
      chain_id: chainId,
      wallet_id: base.address,
      subject_did: currentSubject,
      ...entry,
    };
    appendAudit(config.auditLog, full);
  };

  const denyThrow = (reason: string, notes: string[]): never => {
    throw new ObserverDenyError(reason, notes);
  };

  async function signTransaction(transaction: TransactionLike, options?: unknown): Promise<Hex> {
    const nowIso = new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    const credVerdict = await verifyCredential(config, nowMs);
    if (!credVerdict.allow || !credVerdict.cred) {
      audit({ kind: 'tx', decision: 'deny', reason: credVerdict.reason, notes: credVerdict.notes });
      return denyThrow(credVerdict.reason, credVerdict.notes);
    }
    const cred = credVerdict.cred;
    const state = stateFor(cred);

    let escrow;
    try {
      escrow = classifyEscrowCall(transaction, cfg.tempo.escrow, { payer: base.address, chainId: numericChainId });
    } catch (e) {
      const reason = `[escrow] ${(e as Error).message}`;
      audit({ kind: 'tx', decision: 'deny', reason, notes: credVerdict.notes });
      return denyThrow(reason, credVerdict.notes);
    }

    if (escrow.kind === 'escrow-benign') {
      const notes = [...credVerdict.notes, ...escrow.notes];
      audit({ kind: 'tx', decision: 'allow', reason: 'escrow requestClose/withdraw — no new spend', notes });
      return base.signTransaction(transaction, options);
    }

    if (escrow.kind === 'escrow-settle') {
      // Cooperative close/settle finalizes the channel below its deposit:
      // refund the unused headroom to the velocity counter. No new spend.
      const t = escrow.channelId !== undefined && escrow.finalCumulative !== undefined
        ? state.trueUp(escrow.channelId, escrow.finalCumulative)
        : { refund: 0n };
      const notes = [...credVerdict.notes, ...escrow.notes, `settle: trued up ${t.refund} ${t.asset ?? ''} of unused deposit`];
      audit({ kind: 'settle', decision: 'allow', reason: 'channel settle — velocity trued up', notes, channel_id: escrow.channelId, amount: (escrow.finalCumulative ?? 0n).toString(), asset: t.asset, utc_day: t.day });
      return base.signTransaction(transaction, options);
    }

    const ctx = {
      chain_id: chainId,
      wallet_id: base.address,
      api_key_id: 'mppx',
      transaction: { ...normalizeTx(transaction), value: String(normalizeTx(transaction).value) },
      timestamp: nowIso,
    } as Parameters<typeof enforceMandate>[0];

    let resolvedOverride: ResolvedTransfer | undefined;
    let asset: string;
    let amount: bigint;
    if (escrow.kind === 'escrow-deposit') {
      asset = cfg.tempo.escrow.assetSymbol;
      amount = escrow.amount ?? 0n;
      // open carries the payee directly; topUp does not — inherit it from the
      // linked channel so the counterparty mandate is enforced on top-ups too.
      let recipient = escrow.payee as string | undefined;
      const extraNotes = [...escrow.notes];
      if (recipient === undefined && escrow.channelId) {
        const ch = state.getChannel(escrow.channelId);
        if (ch?.payee) {
          recipient = ch.payee;
          extraNotes.push(`topUp counterparty inherited from linked channel payee ${recipient}`);
        } else {
          extraNotes.push('topUp for a channel with no locally-known payee — counterparty cannot be established (fails closed under a counterparty mandate)');
        }
      }
      resolvedOverride = {
        kind: 'evm-token',
        assetSymbol: asset,
        amount,
        decimals: cfg.tempo.escrow.assetDecimals,
        recipient,
        recipientKind: recipient ? 'wallet' : 'none',
        notes: extraNotes,
      };
    } else {
      // Non-escrow Tempo payment: let the core resolver decode the transfer.
      asset = railDef.currency;
      amount = 0n; // computed by resolver; daily counted from resolved below
    }

    const day = utcDay(nowIso);
    state.recover(); // force replay so recoveryError is known before we trust the counter
    const dailyTotalRaw = state.recoveryError ? undefined : state.dailyTotal(asset, day);
    const recoveryNote = state.recoveryError ? [state.recoveryError] : [];

    const verdict: Verdict = enforceMandate(ctx, cred, config, { resolvedOverride, dailyTotalRaw });
    const notes = [...credVerdict.notes, ...recoveryNote, ...verdict.notes];

    if (!verdict.allow) {
      audit({ kind: escrow.kind === 'escrow-deposit' ? 'escrow-open' : 'tx', decision: 'deny', reason: verdict.reason, notes, asset, amount: amount.toString(), utc_day: day });
      return denyThrow(verdict.reason, notes);
    }

    // Allowed: count the spend into the daily velocity counter.
    if (escrow.kind === 'escrow-deposit') {
      state.registerEscrow(escrow.channelId, amount, escrow.payee, asset, day);
      audit({ kind: 'escrow-open', decision: 'allow', reason: verdict.reason, notes, asset, amount: amount.toString(), payee: escrow.payee, channel_id: escrow.channelId, utc_day: day });
    } else {
      audit({ kind: 'tx', decision: 'allow', reason: verdict.reason, notes, asset, utc_day: day });
    }
    return base.signTransaction(transaction, options);
  }

  async function signTypedData(typedData: TypedDataLike): Promise<Hex> {
    const nowIso = new Date().toISOString();
    const v = decodeVoucher(typedData, cfg.tempo.voucher);

    if (!v.isVoucher) {
      // Not an MPP payment voucher — cannot move escrowed funds (only a valid
      // voucher of the configured type, server-verified, can). Allowed, noted.
      audit({ kind: 'tx', decision: 'allow', reason: `non-voucher typed data signed (${v.reason ?? 'primaryType mismatch'}) — not a payment voucher, not gated`, notes: [] });
      return base.signTypedData(typedData);
    }
    if (v.cumulative === undefined || v.channelId === undefined) {
      const reason = `[voucher] undecodable voucher (${v.reason ?? 'missing fields'}) — fails closed`;
      audit({ kind: 'voucher', decision: 'deny', reason, notes: [] });
      return denyThrow(reason, []);
    }

    // Fresh credential + revocation re-check on every voucher (cache-backed):
    // a mid-session revocation must halt further draws.
    const credVerdict = await verifyCredential(config, Date.parse(nowIso));
    if (!credVerdict.allow || !credVerdict.cred) {
      audit({ kind: 'voucher', decision: 'deny', reason: credVerdict.reason, notes: credVerdict.notes, channel_id: v.channelId });
      return denyThrow(credVerdict.reason, credVerdict.notes);
    }
    const state = stateFor(credVerdict.cred);

    // Monotonicity + (when the channel cap is known) escrow-cap guard.
    const check = state.checkVoucher(v.channelId, v.cumulative);
    if (!check.ok) {
      const reason = `[voucher] ${check.reason} — fails closed`;
      audit({ kind: 'voucher', decision: 'deny', reason, notes: credVerdict.notes, channel_id: v.channelId, amount: v.cumulative.toString() });
      return denyThrow(reason, credVerdict.notes);
    }

    const notes = [
      ...credVerdict.notes,
      check.linked
        ? 'voucher within known escrow cap; monotonic'
        : 'voucher channel not linked to a locally-recorded escrow open — amount bound is inherited from the on-chain escrow (protocol-enforced); monotonicity tracked from this point',
    ];
    audit({ kind: 'voucher', decision: 'allow', reason: 'voucher accepted', notes, channel_id: v.channelId, amount: v.cumulative.toString(), utc_day: utcDay(nowIso) });
    return base.signTypedData(typedData);
  }

  async function signMessage(args: { message: unknown }): Promise<Hex> {
    if (!cfg.allowSignMessage) {
      const reason = '[signMessage] raw message signing is denied by default (opaque content could authorize a payment). Set allowSignMessage=true if this flow uses signMessage for non-payment purposes only.';
      audit({ kind: 'tx', decision: 'deny', reason, notes: [] });
      return denyThrow(reason, []);
    }
    audit({ kind: 'tx', decision: 'allow', reason: 'raw signMessage allowed by config (NOT gated)', notes: [] });
    return base.signMessage(args);
  }

  return {
    base,
    address: base.address,
    type: base.type,
    source: base.source,
    publicKey: base.publicKey,
    signMessage,
    signTransaction,
    signTypedData,
    sign: base.sign ? (args: { hash: Hex }) => base.sign!(args) : undefined,
  };
}
