// @observer-protocol/mppx-op-account — public API.
//
// Wrap a viem account so every MPP/Tempo session escrow and voucher is verified
// against a signed Observer Protocol delegation credential at the signer
// boundary, fail-closed, before signing. Pass the result to mppx as `account`.
//
//   import { createObserverAccount } from '@observer-protocol/mppx-op-account';
//   const opAccount = createObserverAccount(baseViemAccount, {
//     policy: { credentialPath, issuerDid, schemaAllowlist, rails, evmTokens, auditLog },
//     tempo: { chainId, escrow: { precompile, depositSelector, amountWordIndex, assetSymbol, assetDecimals }, voucher: { primaryType, cumulativeField, channelIdField } },
//   });
//   tempo.session.manager({ account: opAccount, maxDeposit: '1' });

export { createObserverAccount } from './account.js';
export type { ObserverAccount } from './account.js';
export { ObserverDenyError } from './adapter-types.js';
export type {
  ObserverAccountConfig,
  TempoConfig,
  EscrowDecodeConfig,
  DepositCall,
  SettleCall,
  VoucherDecodeConfig,
  BaseAccount,
  TransactionLike,
  TypedDataLike,
  Address,
  Hex,
} from './adapter-types.js';
export { computeChannelId } from './channel-id.js';
export {
  TEMPO_CHAIN_ID,
  TEMPO_ESCROW_CONTRACT,
  TEMPO_TOKENS,
  ESCROW_SELECTORS,
  tempoEscrowConfig,
  TEMPO_VOUCHER_CONFIG,
  tempoRail,
} from './tempo-defaults.js';
