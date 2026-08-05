import type { Address, EscrowDecodeConfig, Hex, TransactionLike } from './adapter-types.js';
import { parseEvmRawTx } from './core/evmtx.js';
import { computeChannelId } from './channel-id.js';

// Tempo / MPP transaction-plane decode.
//
// Confirmed against the real mppx escrow ABI (TempoStreamChannel, live-fire
// 2026-06-11). Spend-increasing calls are:
//   open(address payee, address token, uint128 deposit, bytes32 salt, address authorizedSigner)
//   topUp(bytes32 channelId, uint256 additionalDeposit)
// Per-payment draws are off-chain EIP-712 vouchers (see voucher.ts). Cooperative
// close/settle/requestClose/withdraw do not increase spend (benign). Any
// calldata to the escrow contract that matches no configured selector FAILS
// CLOSED — we never guess an amount.

export type Family = 'evm';

export interface EscrowCall {
  kind: 'escrow-deposit' | 'escrow-settle' | 'escrow-benign' | 'not-escrow';
  /** raw token units of the deposit (escrow ceiling), for kind=escrow-deposit. */
  amount?: bigint;
  payee?: Address;
  tokenContract?: Address;
  channelId?: string;
  /** final cumulative at settle/close (raw units), for kind=escrow-settle. */
  finalCumulative?: bigint;
  selector: string;
  notes: string[];
}

/** Context the open-channel-id derivation needs beyond the calldata. */
export interface EscrowContext {
  payer: Address;
  chainId: number;
}

const strip0x = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h);

/** Read the 32-byte ABI word at `wordIndex` (after the 4-byte selector). */
function abiWord(calldata: Buffer, wordIndex: number): Buffer {
  const start = 4 + wordIndex * 32;
  if (start + 32 > calldata.length) {
    throw new Error(`calldata too short for ABI word ${wordIndex} (need ${start + 32} bytes, have ${calldata.length})`);
  }
  return calldata.subarray(start, start + 32);
}
const wordToBigInt = (w: Buffer): bigint => BigInt('0x' + w.toString('hex'));
const wordToAddress = (w: Buffer): Address => ('0x' + w.subarray(12).toString('hex')) as Address;

/** Normalise the transaction's `to` and calldata, decoding from a serialized
 * raw tx when structured fields are absent. */
export function normalizeTx(tx: TransactionLike): { to?: Address; value: bigint; data: string } {
  let to = tx.to ?? undefined;
  let data = (tx.data ?? tx.input) as string | undefined;
  let value: bigint =
    typeof tx.value === 'bigint' ? tx.value : typeof tx.value === 'string' ? BigInt(tx.value) : 0n;

  if ((to === undefined || data === undefined) && typeof tx.serialized === 'string') {
    const parsed = parseEvmRawTx(tx.serialized);
    to = (parsed.to as Address | undefined) ?? to ?? undefined;
    value = parsed.value;
    data = parsed.data;
  }
  return { to: to ?? undefined, value, data: data ?? '0x' };
}

/** Classify a transaction relative to the configured escrow contract and decode
 * the spend-relevant fields. For `open`, derives the channel id (computeChannelId)
 * so the channel can be linked. Throws on calldata that matches no configured
 * selector (fail closed). */
export function classifyEscrowCall(tx: TransactionLike, cfg: EscrowDecodeConfig, ctx: EscrowContext): EscrowCall {
  const { to, data } = normalizeTx(tx);
  const notes: string[] = [];

  if (!to || to.toLowerCase() !== cfg.contract.toLowerCase()) {
    return { kind: 'not-escrow', selector: '', notes };
  }

  const hex = strip0x(data);
  if (hex.length < 8) {
    throw new Error('escrow-contract call has no 4-byte selector');
  }
  const selector = hex.slice(0, 8).toLowerCase();
  const calldata = Buffer.from(hex, 'hex');

  const deposit = cfg.deposits.find((d) => d.selector.toLowerCase() === selector);
  if (deposit) {
    const amount = wordToBigInt(abiWord(calldata, deposit.amountWordIndex));
    const payee = deposit.payeeWordIndex !== undefined ? wordToAddress(abiWord(calldata, deposit.payeeWordIndex)) : undefined;
    const tokenContract =
      deposit.tokenWordIndex !== undefined ? wordToAddress(abiWord(calldata, deposit.tokenWordIndex)) : undefined;

    // Channel id: read directly (topUp) or derive it (open carries salt +
    // authorizedSigner but not the id).
    let channelId: string | undefined;
    if (deposit.channelIdWordIndex !== undefined) {
      channelId = '0x' + abiWord(calldata, deposit.channelIdWordIndex).toString('hex');
    } else if (
      deposit.saltWordIndex !== undefined &&
      deposit.authorizedSignerWordIndex !== undefined &&
      payee !== undefined &&
      tokenContract !== undefined
    ) {
      const salt = ('0x' + abiWord(calldata, deposit.saltWordIndex).toString('hex')) as Hex;
      const authorizedSigner = wordToAddress(abiWord(calldata, deposit.authorizedSignerWordIndex));
      channelId = computeChannelId({
        payer: ctx.payer,
        payee,
        token: tokenContract,
        salt,
        authorizedSigner,
        escrowContract: cfg.contract,
        chainId: ctx.chainId,
      });
    }
    return { kind: 'escrow-deposit', amount, payee, tokenContract, channelId, selector, notes };
  }

  const settle = cfg.settles?.find((s) => s.selector.toLowerCase() === selector);
  if (settle) {
    const channelId = '0x' + abiWord(calldata, settle.channelIdWordIndex).toString('hex');
    const finalCumulative = wordToBigInt(abiWord(calldata, settle.cumulativeWordIndex));
    return { kind: 'escrow-settle', channelId, finalCumulative, selector, notes };
  }

  if (cfg.benignSelectors?.map((s) => s.toLowerCase()).includes(selector)) {
    notes.push(`non-deposit escrow call (selector ${selector}) treated as benign (requestClose/withdraw) — no new spend authorized`);
    return { kind: 'escrow-benign', selector, notes };
  }

  // Unknown escrow-contract selector: could move value. Fail closed.
  throw new Error(
    `unrecognised escrow selector ${selector} — not a configured deposit/settle and not in escrow.benignSelectors; fails closed`,
  );
}
