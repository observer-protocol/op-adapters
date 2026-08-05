// mppx-side adapter types — the viem custom-account seam and Tempo/MPP config.
//
// Runtime is dependency-free; `viem` is a TYPES-ONLY peer dependency. We model
// the slice of the viem account interface mppx actually calls, structurally, so
// the package imports nothing at runtime and a wrapped viem LocalAccount
// satisfies BaseAccount by shape.

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

/** The structural slice of a viem account that mppx invokes. A real
 * LocalAccount is assignable to this. We delegate to these after enforcement. */
export interface BaseAccount {
  address: Address;
  type?: string;
  source?: string;
  publicKey?: Hex;
  signMessage: (args: { message: unknown }) => Promise<Hex>;
  signTransaction: (transaction: TransactionLike, options?: unknown) => Promise<Hex>;
  signTypedData: (typedData: TypedDataLike) => Promise<Hex>;
  sign?: (args: { hash: Hex }) => Promise<Hex>;
}

/** A viem transaction request as handed to account.signTransaction. mppx builds
 * the escrow-open and settlement transactions; we read to/value/data/chainId.
 * `serialized` is the fallback when only a raw signed/unsigned hex is present. */
export interface TransactionLike {
  to?: Address | null;
  value?: bigint | string;
  data?: Hex;
  input?: Hex;
  chainId?: number;
  type?: string | number;
  serialized?: Hex;
  [k: string]: unknown;
}

/** EIP-712 typed data as handed to account.signTypedData. MPP vouchers arrive
 * here — the cumulative amount, channel id, and payee are FIELDS of `message`,
 * already structured, so no ABI/byte decode is needed for vouchers. */
export interface TypedDataLike {
  domain?: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: Address;
    [k: string]: unknown;
  };
  types?: Record<string, Array<{ name: string; type: string }>>;
  primaryType?: string;
  message?: Record<string, unknown>;
}

/** A spend-INCREASING escrow call (a deposit). The Tempo TempoStreamChannel
 * contract has two: open(payee,token,deposit,salt,authorizedSigner) and
 * topUp(channelId,additionalDeposit). Each has its own calldata layout; word
 * indexes are 32-byte ABI words after the 4-byte selector. */
export interface DepositCall {
  /** 4-byte selector (no 0x). */
  selector: string;
  /** informational: which call this is. */
  kind?: 'open' | 'topUp';
  /** word index of the deposit amount (raw token units). */
  amountWordIndex: number;
  /** word index of the payee address, or undefined if this call has none
   * (e.g. topUp adds to an existing channel — its payee was bound at open). */
  payeeWordIndex?: number;
  /** word index of the TIP-20 token contract address, or undefined. */
  tokenWordIndex?: number;
  /** word index of the channel id (bytes32), or undefined. Present on `topUp`
   * (the channel id is in calldata). For `open` the channel id is DERIVED (see
   * saltWordIndex/authorizedSignerWordIndex) since it is not in calldata. */
  channelIdWordIndex?: number;
  /** word index of the bytes32 salt — present on `open`, enabling channel-id
   * derivation (computeChannelId). */
  saltWordIndex?: number;
  /** word index of the authorizedSigner address — present on `open`, for
   * channel-id derivation. */
  authorizedSignerWordIndex?: number;
}

/** A settle/close call that finalizes a channel at a cumulative amount. Used to
 * true up the velocity counter (refund = counted deposit − final cumulative). */
export interface SettleCall {
  selector: string;
  channelIdWordIndex: number;
  cumulativeWordIndex: number;
}

/** How to read Tempo escrow (TempoStreamChannel) transactions. Confirmed by
 * live-fire against the real mppx escrow ABI; any calldata that does not match
 * a configured deposit/benign selector FAILS CLOSED — we never guess an amount. */
export interface EscrowDecodeConfig {
  /** Escrow contract address (chain-specific TempoStreamChannel). */
  contract: Address;
  /** Spend-increasing calls (open + topUp). */
  deposits: DepositCall[];
  /** Settle/close calls that finalize a channel at a cumulative amount — used to
   * true up the velocity counter (refund unused deposit). */
  settles?: SettleCall[];
  /** Asset symbol the escrow is denominated in (e.g. "USDC"). */
  assetSymbol: string;
  /** Decimals of that asset (e.g. 6 for USDC). */
  assetDecimals: number;
  /** Selectors (no 0x) for escrow calls that neither increase spend nor finalize
   * a cumulative (requestClose/withdraw). Allowed without amount enforcement.
   * Anything else to the contract FAILS CLOSED. */
  benignSelectors?: string[];
}

/** How to read an MPP voucher out of the EIP-712 message. Confirmed by
 * live-fire against a real mppx voucher; mismatches FAIL CLOSED. */
export interface VoucherDecodeConfig {
  /** EIP-712 primaryType naming a voucher (e.g. "Voucher"). */
  primaryType: string;
  /** message field holding the cumulative authorized amount (raw token units,
   * decimal string or bigint). */
  cumulativeField: string;
  /** message field holding the channel id. */
  channelIdField: string;
  /** message field holding the payee, or undefined. */
  payeeField?: string;
}

export interface TempoConfig {
  /** CAIP-2 chain id of the Tempo chain this account signs for (must match a
   * rail in the OP verifier config). */
  chainId: string;
  escrow: EscrowDecodeConfig;
  voucher: VoucherDecodeConfig;
}

export interface ObserverAccountConfig {
  /** The OP verifier policy object — identical vocabulary to the OWS engine's
   * policy `config` (parsed by the vendored core parseConfig): credentialPath,
   * issuerDid, schemaAllowlist, rails, evmTokens, revocation, auditLog, etc. */
  policy: Record<string, unknown>;
  tempo: TempoConfig;
  /** Deny raw (non-typed) signMessage by default — its content is opaque and
   * could authorize a payment. Set true only if your flow uses signMessage for
   * non-payment purposes (e.g. SIWE) and you accept it is NOT gated. */
  allowSignMessage?: boolean;
}

export class ObserverDenyError extends Error {
  readonly code = 'OBSERVER_POLICY_DENY';
  readonly reason: string;
  readonly notes: string[];
  constructor(reason: string, notes: string[]) {
    super(reason);
    this.name = 'ObserverDenyError';
    this.reason = reason;
    this.notes = notes;
  }
}
