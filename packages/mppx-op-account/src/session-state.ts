import { readFileSync, existsSync } from 'node:fs';
import type { AuditEntry } from '@observer-protocol/policy-engine';

// Option A (signed off 2026-06-11): stateful in-process counter for the only
// constraint that needs one — the cross-session daily/monthly VELOCITY cap.
// Everything else (escrow ceiling, per-session voucher cumulative, counterparty,
// temporal) is established per-call from the payload and needs no state.
//
// Recovery rider: the daily counter is rebuilt at startup by replaying the
// shared append-only JSONL audit log (the same log the engine writes), summing
// today's ESCROW-OPEN deposits for this subject DID. Conservative by design —
// we count escrow `maxDeposit` (an upper bound on what the session can spend),
// so the cap trips early, never late. Close-time true-up is v1.1.
//
// Soundness: complete recovery requires all processes for this key to share ONE
// audit-log path keyed implicitly by the subject DID. If the path is
// process-private, recovery is process-local. Stated plainly in SUPPORT-MATRIX.

export interface SessionAuditEntry extends AuditEntry {
  kind: 'escrow-open' | 'voucher' | 'settle' | 'tx';
  subject_did?: string;
  channel_id?: string;
  asset?: string;
  amount?: string; // raw token units: maxDeposit (escrow-open) or cumulative (voucher)
  payee?: string;
  utc_day?: string; // YYYY-MM-DD (UTC)
}

export interface ChannelRecord {
  cap?: bigint; // total deposit counted into velocity for this channel (open + topUps)
  payee?: string;
  asset?: string;
  lastCumulative: bigint; // highest voucher cumulative seen (monotonicity)
  day?: string; // UTC day the deposit was counted (for true-up to the right bucket)
  settled?: boolean; // a true-up has been applied — no double refund
}

/** Calendar day (UTC) for a timestamp, as YYYY-MM-DD. */
export function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export class SessionState {
  private readonly auditLog: string;
  private readonly subjectDid: string;
  private dailyRaw = new Map<string, bigint>(); // `${asset}|${day}` -> raw total
  private channels = new Map<string, ChannelRecord>();
  private recovered = false;
  /** set when recovery could not be performed (missing/unreadable log) — the
   * counter is then known-incomplete and the caller fails closed on any
   * velocity-bearing mandate. */
  recoveryError?: string;

  constructor(auditLog: string, subjectDid: string) {
    this.auditLog = auditLog;
    this.subjectDid = subjectDid;
  }

  private key(asset: string, day: string): string {
    return `${asset}|${day}`;
  }

  /** Replay today's audit log to rebuild the daily counter and channel registry
   * for this subject. Idempotent. */
  recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    if (!existsSync(this.auditLog)) {
      // No prior log = no prior spend today. Not an error: a fresh deployment
      // legitimately starts at zero.
      return;
    }
    let lines: string[];
    try {
      lines = readFileSync(this.auditLog, 'utf8').split('\n');
    } catch (e) {
      this.recoveryError = `audit-log replay failed (counter incomplete): ${(e as Error).message}`;
      return;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let e: SessionAuditEntry;
      try {
        e = JSON.parse(line) as SessionAuditEntry;
      } catch {
        continue; // a corrupt line never silently lowers the counter
      }
      if (e.subject_did !== this.subjectDid) continue;
      if (e.decision !== 'allow') continue;
      if (!e.asset || !e.amount || !e.utc_day) continue;
      let amt: bigint;
      try {
        amt = BigInt(e.amount);
      } catch {
        continue;
      }
      if (e.kind === 'escrow-open') {
        this.addDaily(e.asset, e.utc_day, amt);
        if (e.channel_id) {
          const prev = this.channels.get(e.channel_id);
          this.channels.set(e.channel_id, {
            cap: (prev?.cap ?? 0n) + amt, // open + any prior topUps
            payee: e.payee ?? prev?.payee,
            asset: e.asset,
            lastCumulative: prev?.lastCumulative ?? 0n,
            day: prev?.day ?? e.utc_day,
          });
        }
      } else if (e.kind === 'voucher' && e.channel_id) {
        const ch = this.channels.get(e.channel_id);
        if (ch && amt > ch.lastCumulative) ch.lastCumulative = amt;
      } else if (e.kind === 'settle' && e.channel_id) {
        this.applyTrueUp(e.channel_id, amt);
      }
    }
  }

  private addDaily(asset: string, day: string, amount: bigint): void {
    const k = this.key(asset, day);
    this.dailyRaw.set(k, (this.dailyRaw.get(k) ?? 0n) + amount);
  }

  /** Current daily total (raw units) for an asset, BEFORE this transaction. */
  dailyTotal(asset: string, day: string): bigint {
    this.recover();
    return this.dailyRaw.get(this.key(asset, day)) ?? 0n;
  }

  /** Register an approved deposit (open or topUp): bumps the daily counter and
   * accumulates the channel cap. Call only AFTER the mandate allowed it. */
  registerEscrow(channelId: string | undefined, amount: bigint, payee: string | undefined, asset: string, day: string): void {
    this.recover();
    this.addDaily(asset, day, amount);
    if (channelId) {
      const prev = this.channels.get(channelId);
      this.channels.set(channelId, {
        cap: (prev?.cap ?? 0n) + amount, // open + topUps accumulate
        payee: payee ?? prev?.payee, // open sets payee; topUp inherits it
        asset,
        lastCumulative: prev?.lastCumulative ?? 0n,
        day: prev?.day ?? day,
        settled: prev?.settled,
      });
    }
  }

  /** True up the velocity counter when a channel settles below its deposit:
   * refund = counted deposit − final cumulative, subtracted from the day the
   * deposit was counted. Idempotent (a channel trues up once). Returns the
   * applied refund + bucket for the caller to record. */
  applyTrueUp(channelId: string, finalCumulative: bigint): { refund: bigint; asset?: string; day?: string } {
    const ch = this.channels.get(channelId);
    if (!ch || ch.cap === undefined || ch.settled) return { refund: 0n };
    const refund = ch.cap > finalCumulative ? ch.cap - finalCumulative : 0n;
    if (refund > 0n && ch.asset && ch.day) {
      const k = this.key(ch.asset, ch.day);
      const cur = this.dailyRaw.get(k) ?? 0n;
      this.dailyRaw.set(k, cur > refund ? cur - refund : 0n);
    }
    ch.settled = true;
    return { refund, asset: ch.asset, day: ch.day };
  }

  /** Live-path true-up: recover first, then apply. */
  trueUp(channelId: string, finalCumulative: bigint): { refund: bigint; asset?: string; day?: string } {
    this.recover();
    return this.applyTrueUp(channelId, finalCumulative);
  }

  getChannel(channelId: string): ChannelRecord | undefined {
    this.recover();
    return this.channels.get(channelId);
  }

  /** Validate and record an approved voucher: enforce monotonicity (no rollback
   * below the last accepted cumulative) and, when the escrow cap is known, that
   * the cumulative does not exceed it. Creates the channel record on first
   * sight so monotonicity is tracked even without a linked escrow open. The
   * record is updated ONLY when the voucher passes. */
  checkVoucher(channelId: string, cumulative: bigint): { ok: boolean; reason?: string; linked: boolean } {
    this.recover();
    const ch = this.channels.get(channelId) ?? { lastCumulative: 0n };
    const linked = ch.cap !== undefined;
    if (cumulative < ch.lastCumulative) {
      return { ok: false, linked, reason: `cumulative ${cumulative} is below the last accepted ${ch.lastCumulative} for channel ${channelId} (rollback)` };
    }
    if (ch.cap !== undefined && cumulative > ch.cap) {
      return { ok: false, linked, reason: `cumulative ${cumulative} exceeds the escrow cap ${ch.cap} for channel ${channelId}` };
    }
    this.channels.set(channelId, { ...ch, lastCumulative: cumulative });
    return { ok: true, linked };
  }
}
