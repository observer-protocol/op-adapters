import type { Address, TypedDataLike, VoucherDecodeConfig } from './adapter-types.js';

// MPP voucher decode. Vouchers are off-chain EIP-712 typed messages
// (signTypedData) carrying a CUMULATIVE authorized amount — "I have now
// consumed up to X total" (verified 2026-06-11; mpp.dev tempo/session). Because
// signTypedData hands us the structured `message`, the cumulative amount,
// channel id, and payee are field reads — no byte decode.
//
// Anything that does not match the configured voucher shape returns
// isVoucher=false so the caller can fail closed (an un-decodable signTypedData
// under a payment account is denied unless explicitly the voucher type).

export interface DecodedVoucher {
  isVoucher: boolean;
  /** cumulative authorized amount in raw token units. */
  cumulative?: bigint;
  channelId?: string;
  payee?: Address;
  reason?: string;
}

function toBigIntLoose(v: unknown): bigint | undefined {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim());
    return undefined;
  } catch {
    return undefined;
  }
}

export function decodeVoucher(td: TypedDataLike, cfg: VoucherDecodeConfig): DecodedVoucher {
  if (!td || typeof td !== 'object') return { isVoucher: false, reason: 'typed data is not an object' };
  if (td.primaryType !== cfg.primaryType) {
    return { isVoucher: false, reason: `primaryType ${String(td.primaryType)} is not the configured voucher type ${cfg.primaryType}` };
  }
  const msg = td.message;
  if (!msg || typeof msg !== 'object') {
    return { isVoucher: true, reason: 'voucher message is missing' };
  }

  const cumulative = toBigIntLoose(msg[cfg.cumulativeField]);
  if (cumulative === undefined) {
    return { isVoucher: true, reason: `voucher field ${cfg.cumulativeField} is missing or not a non-negative integer` };
  }
  const channelRaw = msg[cfg.channelIdField];
  const channelId =
    typeof channelRaw === 'string' || typeof channelRaw === 'number' || typeof channelRaw === 'bigint'
      ? String(channelRaw)
      : undefined;
  if (channelId === undefined) {
    return { isVoucher: true, cumulative, reason: `voucher field ${cfg.channelIdField} (channel id) is missing` };
  }
  let payee: Address | undefined;
  if (cfg.payeeField) {
    const p = msg[cfg.payeeField];
    if (typeof p === 'string' && p.startsWith('0x')) payee = p as Address;
  }

  return { isVoucher: true, cumulative, channelId, payee };
}
