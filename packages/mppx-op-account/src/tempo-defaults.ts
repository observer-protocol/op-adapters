import type { Address, EscrowDecodeConfig } from './adapter-types.js';
import type { RailDef } from '@observer-protocol/policy-engine';

// Real Tempo / mppx defaults, confirmed against mppx@0.7.0
// (dist/tempo/legacy/session/escrow.abi.js + Voucher.js + internal/defaults).
// Live-fire 2026-06-11. TIP-20 stablecoins on Tempo use 6 decimals.

export const TEMPO_CHAIN_ID = { mainnet: 4217, testnet: 42431 } as const;

export const TEMPO_ESCROW_CONTRACT = {
  mainnet: '0x33b901018174DDabE4841042ab76ba85D4e24f25' as Address,
  testnet: '0xe1c4d3dce17bc111181ddf716f75bae49e61a336' as Address,
};

export const TEMPO_TOKENS = {
  usdc: '0x20C000000000000000000000b9537d11c60E8b50' as Address,
  pathUsd: '0x20c0000000000000000000000000000000000000' as Address,
};

// Selectors computed from the escrow ABI (toFunctionSelector):
//   open(address,address,uint128,bytes32,address) = 0xc79ea485
//   topUp(bytes32,uint256)                         = 0xb67644b9
//   close/settle/requestClose/withdraw             = benign (no new spend)
export const ESCROW_SELECTORS = {
  open: 'c79ea485',
  topUp: 'b67644b9',
  close: '0d65c51d',
  settle: '516d3b88',
  requestClose: '6bf5fe6f',
  withdraw: '8e19899e',
} as const;

/** Build the escrow-decode config for a Tempo network. assetSymbol/Decimals
 * default to USDC/6. */
export function tempoEscrowConfig(
  network: 'mainnet' | 'testnet',
  opts: { assetSymbol?: string; assetDecimals?: number } = {},
): EscrowDecodeConfig {
  return {
    contract: TEMPO_ESCROW_CONTRACT[network],
    deposits: [
      // open(payee[0], token[1], deposit[2], salt[3], authorizedSigner[4]) — the
      // channel id is DERIVED (computeChannelId) from salt + authorizedSigner.
      { selector: ESCROW_SELECTORS.open, kind: 'open', payeeWordIndex: 0, tokenWordIndex: 1, amountWordIndex: 2, saltWordIndex: 3, authorizedSignerWordIndex: 4 },
      // topUp(channelId[0], additionalDeposit[1])
      { selector: ESCROW_SELECTORS.topUp, kind: 'topUp', channelIdWordIndex: 0, amountWordIndex: 1 },
    ],
    // close(channelId[0], cumulativeAmount[1], sig) / settle(channelId[0],
    // cumulativeAmount[1], sig) — finalize at a cumulative → true up velocity.
    settles: [
      { selector: ESCROW_SELECTORS.close, channelIdWordIndex: 0, cumulativeWordIndex: 1 },
      { selector: ESCROW_SELECTORS.settle, channelIdWordIndex: 0, cumulativeWordIndex: 1 },
    ],
    assetSymbol: opts.assetSymbol ?? 'USDC',
    assetDecimals: opts.assetDecimals ?? 6,
    // requestClose(channelId) / withdraw(channelId) — no new spend, no cumulative.
    benignSelectors: [ESCROW_SELECTORS.requestClose, ESCROW_SELECTORS.withdraw],
  };
}

/** EIP-712 voucher field names (confirmed: Voucher{channelId, cumulativeAmount};
 * vouchers carry NO payee — the payee is bound on the channel at open). */
export const TEMPO_VOUCHER_CONFIG = {
  primaryType: 'Voucher',
  cumulativeField: 'cumulativeAmount',
  channelIdField: 'channelId',
} as const;

/** A default RailDef for a Tempo chain (USDC-denominated, EVM family). */
export function tempoRail(network: 'mainnet' | 'testnet'): { caip2: string; rail: RailDef } {
  return {
    caip2: `eip155:${TEMPO_CHAIN_ID[network]}`,
    rail: { rail: `tempo-${network}`, currency: 'USDC', decimals: 6, family: 'evm' },
  };
}
