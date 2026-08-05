// Types for the Fireblocks API Co-Signer callback boundary. Runtime is
// dependency-light; the only crypto dependency is `jose` (RS256 JWT verify/sign
// for the co-signer handshake). We model the slice of the Fireblocks callback
// request our gate reads, structurally, so we do not couple to a Fireblocks SDK.

/** The transaction-signing request the API Co-Signer POSTs to the callback
 * handler, as the CLAIMS of a co-signer-signed JWT. Fields below are the ones
 * the OP gate reads; the co-signer sends more. CONFIRM the exact field names
 * and any nesting against a live Testnet payload sample before production —
 * the canonical reference page was not machine-readable at build time, so this
 * shape is drawn from Fireblocks' basic-code-example and callback-handler repos. */
export interface FireblocksTxRequest {
  /** Fireblocks transaction id. */
  txId: string;
  /** Idempotency id the co-signer expects echoed back in the response. */
  requestId: string;
  /** e.g. "TRANSFER", "CONTRACT_CALL", "TYPED_MESSAGE", "RAW". Only value
   * transfers are enforced against amount/counterparty; everything else is a
   * category this gate does not decode and therefore fails closed. */
  operation?: string;
  /** Fireblocks asset id, e.g. "ETH_TEST5", "USDC_ETH_TEST5", "BTC_TEST". */
  asset?: string;
  /** Human/decimal amount in the asset's main unit, e.g. "1.5". */
  amount?: string | number;
  amountStr?: string;
  /** Destination address (single-destination transfers). */
  destAddress?: string;
  destType?: string;
  destId?: string;
  /** Multi-destination transfers. If present with >1 entry we fail closed
   * (this gate resolves a single asset/amount/recipient view). */
  destinations?: Array<{ amount?: string | number; destination?: { oneTimeAddress?: { address?: string } } }>;
  /** Raw unsigned tx bytes, when present. */
  rawTx?: unknown;
  players?: unknown;
  [k: string]: unknown;
}

/** The callback response action. See README "Handler state machine". */
export type CallbackAction = 'APPROVE' | 'REJECT' | 'IGNORE' | 'RETRY';

/** How a Fireblocks asset id maps to the mandate's asset vocabulary. `kind`
 * selects the ResolvedTransfer family the policy core enforces against. */
export interface FireblocksAssetDef {
  symbol: string; // must match the mandate's crossRailBudget.rates key, e.g. "USDC"
  decimals: number;
  kind: 'native' | 'evm-token' | 'trc20-token';
}

export interface FireblocksCallbackConfig {
  /** The OP verifier policy object — identical vocabulary to every other OP
   * engine (parsed by the shared parseConfig): credentialPath, issuerDid,
   * schemaAllowlist, rails, revocation, auditLog, etc. */
  policy: Record<string, unknown>;
  /** PEM (SPKI) public key of the Fireblocks API Co-Signer, used to verify the
   * inbound request JWT (RS256). Certificate pinning is Fireblocks' documented
   * alternative; this engine implements the JWT-keypair mode. */
  cosignerPublicKeyPem: string;
  /** PEM (PKCS8) private key this handler signs its response JWT with (RS256).
   * MUST be loaded from a managed secret path, never inlined in code. */
  handlerPrivateKeyPem: string;
  /** Path to the shared cross-rail spend ledger (CrossRailLedger JSONL). The
   * handler reads rolling-24h totals before every decision and records every
   * APPROVE. REQUIRED for mandates carrying crossRailBudget/velocity — such a
   * mandate with no ledger fails closed (no counter can be established). */
  crossRailLedgerPath?: string;
  /** CAIP-2-style chain id written into PolicyContext.chain_id and used as the
   * ledger rail prefix. Default "fireblocks". The mandate's allowed_rails, if
   * set, must include this. */
  railId?: string;
  /** Fireblocks asset id -> asset definition. Merged over the built-in testnet
   * defaults. An asset absent from the merged map is unenforceable and fails
   * closed (its amount cannot be scaled against the mandate). */
  assetMap?: Record<string, FireblocksAssetDef>;
}

/** Thrown internally on a fail-closed condition; the handler maps it to REJECT. */
export class ObserverDenyError extends Error {
  readonly code = 'OBSERVER_POLICY_DENY';
  readonly reason: string;
  readonly notes: string[];
  constructor(reason: string, notes: string[] = []) {
    super(reason);
    this.name = 'ObserverDenyError';
    this.reason = reason;
    this.notes = notes;
  }
}
