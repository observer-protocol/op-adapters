// Decode a Fireblocks callback request into the single asset/amount/recipient
// view the OP mandate enforces against (ResolvedTransfer). The rule mirrors the
// x402 decoder: anything we cannot positively identify (unknown asset, a
// non-transfer operation, a multi-destination transfer, an unparseable amount)
// resolves as `unparsed`/`unenforceable`, and the mandate turns that into a
// deny. There is no permissive fallthrough.

import type { ResolvedTransfer } from '@observer-protocol/policy-engine';
import type { FireblocksAssetDef, FireblocksTxRequest } from './adapter-types.js';

/** Built-in Fireblocks TESTNET asset ids. Deliberately small; extend via
 * FireblocksCallbackConfig.assetMap. CONFIRM the exact ids against the live
 * Testnet workspace (asset ids differ by network, e.g. ETH_TEST5 vs ETH_TEST6). */
export const DEFAULT_FIREBLOCKS_ASSETS: Record<string, FireblocksAssetDef> = {
  ETH_TEST5: { symbol: 'ETH', decimals: 18, kind: 'native' },
  ETH_TEST6: { symbol: 'ETH', decimals: 18, kind: 'native' },
  USDC_ETH_TEST5: { symbol: 'USDC', decimals: 6, kind: 'evm-token' },
};

/** Parse a decimal amount string into raw integer units of an asset with
 * `decimals` places. Returns null on anything malformed or with more fractional
 * digits than the asset supports (fail closed rather than silently truncate). */
export function decimalToRaw(value: string, decimals: number): bigint | null {
  const v = value.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const [intPart = '0', fracPart = ''] = v.split('.');
  if (fracPart.length > decimals) return null;
  const fracPadded = fracPart.padEnd(decimals, '0');
  try {
    return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
  } catch {
    return null;
  }
}

const unenforceable = (reason: string): ResolvedTransfer => ({
  kind: 'unparsed',
  recipientKind: 'none',
  notes: [],
  unenforceable: reason,
});

/** Build the ResolvedTransfer from a Fireblocks request against the asset map. */
export function resolvedFromFireblocks(
  req: FireblocksTxRequest,
  assetMap: Record<string, FireblocksAssetDef>,
): ResolvedTransfer {
  const op = (req.operation ?? 'TRANSFER').toUpperCase();
  if (op !== 'TRANSFER') {
    // CONTRACT_CALL / RAW / TYPED_MESSAGE carry authority this gate does not
    // decode into a bounded amount+counterparty. Fail closed.
    return unenforceable(`Fireblocks operation ${op} is not a plain value transfer this engine can bound against the mandate`);
  }
  if (req.destinations && req.destinations.length > 1) {
    return unenforceable(`multi-destination transfer (${req.destinations.length} outputs) cannot be resolved to a single enforced transfer`);
  }
  if (!req.asset) return unenforceable('Fireblocks request carries no asset id');

  const def = assetMap[req.asset];
  if (!def) {
    return unenforceable(`unrecognized Fireblocks asset id ${req.asset} — asset cannot be identified, so amounts cannot be scaled against the mandate`);
  }

  const amountStr = req.amountStr ?? (req.amount !== undefined ? String(req.amount) : undefined);
  if (amountStr === undefined) return unenforceable(`no amount on ${req.asset} transfer`);
  const amount = decimalToRaw(amountStr, def.decimals);
  if (amount === null) {
    return unenforceable(`amount "${amountStr}" is not representable in ${def.decimals} decimals of ${def.symbol}`);
  }

  const recipient = req.destAddress ?? req.destinations?.[0]?.destination?.oneTimeAddress?.address;
  if (!recipient) return unenforceable(`no destination address on ${def.symbol} transfer`);

  return {
    kind: def.kind,
    assetSymbol: def.symbol,
    amount,
    decimals: def.decimals,
    recipient,
    recipientKind: 'wallet',
    notes: [`Fireblocks ${op} of ${amountStr} ${def.symbol} (asset id ${req.asset}) to ${recipient}`],
  };
}
