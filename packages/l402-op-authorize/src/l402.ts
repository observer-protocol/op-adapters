// L402 decoder: parse an L402 challenge and the invoice it carries into the
// engine's common evaluation input (amount + unit, counterparty). This is the
// "only the decoder changed" layer — the verification + mandate enforcement below
// it is the vendored OP core, identical to ows-op-verify and mppx-op-account.
//
// L402 (formerly LSAT) challenge, per Lightning Labs:
//   HTTP 402 + WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"
// The client pays the invoice (sats, or a Taproot-Asset USDT invoice) and then
// presents `Authorization: L402 <macaroon>:<preimage>`. The macaroon is a bearer
// token (see SCOPE §8 / SPIKE-FINDING); OP binding is layered on top, not here.

import { bolt11AmountSats } from './bolt11.js';

export interface L402Challenge {
  macaroon: string;
  invoice: string;
}

export interface DecodedPayment {
  /** Lightning amount in sats from the BOLT11 invoice, or null if amountless. */
  amountSats: number | null;
  /** Taproot-Asset (USDT-on-Lightning) amount + unit, when paying an asset
   * invoice. The asset amount is NOT carried in the BOLT11 HRP; it comes from the
   * lnget/tapd RFQ quote and is supplied by the caller. On-wire Taproot-Asset
   * invoice parsing is a documented v1 boundary (see SUPPORT-MATRIX). */
  assetAmount?: string;
  assetUnit?: string;
  /** Decimals of the Taproot-Asset unit (e.g. 6 for USDT), from the quote. */
  assetDecimals?: number;
  /** Counterparty for mandate evaluation: the L402 service origin (host). */
  counterparty: string;
  invoice?: string;
}

/**
 * Parse an L402 / legacy-LSAT challenge header into its macaroon + invoice.
 * Tolerates both `L402` and `LSAT` auth schemes and quoted or unquoted values.
 */
export function parseL402Challenge(header: string): L402Challenge {
  const trimmed = header.trim();
  const scheme = /^(l402|lsat)\b/i;
  if (!scheme.test(trimmed)) {
    throw new Error('not an L402/LSAT challenge header');
  }
  const macaroon = matchParam(trimmed, 'macaroon');
  const invoice = matchParam(trimmed, 'invoice');
  if (!macaroon || !invoice) {
    throw new Error('L402 challenge missing macaroon or invoice');
  }
  return { macaroon, invoice };
}

function matchParam(header: string, name: string): string | null {
  // name="value"  or  name=value
  const quoted = header.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  if (quoted) return quoted[1]!;
  const bare = header.match(new RegExp(`${name}\\s*=\\s*([^,\\s]+)`, 'i'));
  return bare ? bare[1]! : null;
}

/** Normalize an origin to a bare host (scheme/path/port stripped) for stable
 * counterparty matching against an allowlist. */
export function originHost(origin: string): string {
  try {
    return new URL(origin.includes('://') ? origin : `https://${origin}`).host.toLowerCase();
  } catch {
    return origin.trim().toLowerCase();
  }
}

/**
 * Decode an L402 payment into the engine's common evaluation input. Provide
 * either a raw `challenge` header or an `invoice` directly; `origin` is the L402
 * service being paid (the counterparty). For Taproot-Asset USDT, pass `asset`
 * (amount + unit) from the lnget/tapd quote.
 */
export function decodeL402(input: {
  origin: string;
  invoice?: string;
  challenge?: string;
  asset?: { amount: string; unit: string; decimals: number };
}): DecodedPayment {
  let invoice = input.invoice;
  if (!invoice && input.challenge) {
    invoice = parseL402Challenge(input.challenge).invoice;
  }
  const decoded: DecodedPayment = {
    amountSats: invoice ? bolt11AmountSats(invoice) : null,
    counterparty: originHost(input.origin),
  };
  if (invoice) decoded.invoice = invoice;
  if (input.asset) {
    decoded.assetAmount = input.asset.amount;
    decoded.assetUnit = input.asset.unit;
    decoded.assetDecimals = input.asset.decimals;
  }
  return decoded;
}
