// @observer-protocol/fireblocks-op-authorize
//
// Observer Protocol as the authorization gate at the Fireblocks API Co-Signer
// callback boundary. The co-signer consults this handler before signing; an OP
// REJECT (or no response) means the transaction is never signed. Fireblocks
// holds the key; this handler holds none. Enforcement without custody.
//
// Same shared @observer-protocol/policy-engine core as the x402, l402, OWS, and
// mppx/Tempo instances — one signed mandate, one rolling cross-rail budget, one
// shared ledger. Only the ingest adapter (Fireblocks callback JWT -> proposal)
// is new.

export { createFireblocksHandler } from './handler.js';
export type { FireblocksHandler, CallbackResult } from './handler.js';

export { authorizeFireblocksTransaction } from './authorize.js';
export type { FireblocksAuthInput } from './authorize.js';

export { resolvedFromFireblocks, decimalToRaw, DEFAULT_FIREBLOCKS_ASSETS } from './fireblocks.js';

export { ObserverDenyError } from './adapter-types.js';
export type {
  FireblocksTxRequest,
  CallbackAction,
  FireblocksAssetDef,
  FireblocksCallbackConfig,
} from './adapter-types.js';
