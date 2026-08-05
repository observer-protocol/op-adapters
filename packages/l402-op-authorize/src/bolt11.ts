// Minimal, dependency-free BOLT11 amount decoder. Reads only the amount from the
// invoice's human-readable prefix (HRP). It does NOT bech32-decode the data part
// and makes no network call. Returns the amount in sats, or null when the invoice
// is amountless or cannot be confidently parsed. Callers treat null as "amount
// unknown" and MUST fail closed under any per-payment cap.
//
// Reused from the Observer Protocol Lightning Faucet hook (lightning-wallet-mcp).

// msat per 1 unit of each BOLT11 multiplier (1 BTC = 1e11 msat):
//   m = milli (1e-3 BTC) → 1e8 msat   u = micro (1e-6 BTC) → 1e5 msat
//   n = nano  (1e-9 BTC) → 1e2 msat   p = pico  (1e-12 BTC) → 1e-1 msat
const MSAT_PER_MULTIPLIER: Record<string, number> = { m: 1e8, u: 1e5, n: 1e2, p: 1e-1 };

export function bolt11AmountSats(invoice: string): number | null {
  try {
    const lower = invoice.toLowerCase().trim();
    // The bech32 separator is the LAST '1' (the data part's charset excludes '1';
    // the HRP, including the amount digits, may contain '1').
    const sep = lower.lastIndexOf('1');
    if (sep <= 0) return null;
    const hrp = lower.slice(0, sep);
    // hrp = 'ln' + currency prefix (bc | tb | bcrt | sb) + <digits><multiplier?>.
    // Amountless invoices have no digits → no per-payment amount to enforce.
    const match = hrp.match(/^ln(?:bcrt|bc|tb|sb)(\d+)([munp])?$/);
    if (!match) return null;
    const digits = match[1]!;
    const multiplier = match[2];
    let msat: number;
    if (multiplier) {
      msat = Number(digits) * MSAT_PER_MULTIPLIER[multiplier]!;
    } else {
      msat = Number(digits) * 1e11; // whole BTC
    }
    if (!Number.isFinite(msat) || msat < 0) return null;
    return Math.round(msat / 1000);
  } catch {
    return null;
  }
}
