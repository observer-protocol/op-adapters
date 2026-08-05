// The Fireblocks API Co-Signer callback boundary. The co-signer POSTs a
// co-signer-signed JWT describing a proposed transaction BEFORE signing it;
// this handler verifies that JWT, evaluates the transaction against the OP
// mandate, and returns a signed JWT with APPROVE or REJECT.
//
// FAIL-CLOSED, two layers:
//   1. Our own response is REJECT on any internal error once the inbound JWT is
//      verified (we hold a trusted requestId to answer with).
//   2. If the inbound JWT does not verify, we do NOT fabricate a signed answer
//      over untrusted data — we return `no-response`, and the platform's own
//      guarantee takes over: "If the Callback Handler does not respond within 30
//      seconds, the transaction is not signed and is canceled." There is no
//      toggle that makes a timeout auto-approve. So a crash, a bad signature,
//      or a slow evaluation all resolve to: no signature.
//
// This handler holds NO Fireblocks key share. Fireblocks holds the key; an OP
// REJECT (or no response) means the signature is never produced.

import { parseConfig, appendAudit, CrossRailLedger } from '@observer-protocol/policy-engine';
import type { VerifierConfig } from '@observer-protocol/policy-engine';
import { importSPKI, importPKCS8, jwtVerify, SignJWT } from 'jose';
import type { CallbackAction, FireblocksAssetDef, FireblocksCallbackConfig, FireblocksTxRequest } from './adapter-types.js';
import { DEFAULT_FIREBLOCKS_ASSETS, decimalToRaw, resolvedFromFireblocks } from './fireblocks.js';
import { authorizeFireblocksTransaction } from './authorize.js';

export type CallbackResult =
  | { kind: 'signed'; action: CallbackAction; jwt: string; requestId: string; reason: string }
  /** Inbound JWT unverifiable: return a non-2xx / no valid body so the
   * co-signer's 30s-timeout cancels the transaction (fail-closed by platform). */
  | { kind: 'no-response'; httpStatus: number; reason: string };

/** A prepared handler: parses the OP policy and imports keys once, then
 * evaluates each inbound co-signer JWT. */
export interface FireblocksHandler {
  handle(inboundJwt: string): Promise<CallbackResult>;
}

export async function createFireblocksHandler(cfg: FireblocksCallbackConfig): Promise<FireblocksHandler> {
  const config: VerifierConfig = parseConfig(cfg.policy);
  const ledger = cfg.crossRailLedgerPath ? new CrossRailLedger(cfg.crossRailLedgerPath) : undefined;
  const railId = cfg.railId ?? 'fireblocks';
  const assetMap: Record<string, FireblocksAssetDef> = { ...DEFAULT_FIREBLOCKS_ASSETS, ...(cfg.assetMap ?? {}) };

  const cosignerKey = await importSPKI(cfg.cosignerPublicKeyPem, 'RS256');
  const handlerKey = await importPKCS8(cfg.handlerPrivateKeyPem, 'RS256');

  const audit = (decision: 'allow' | 'deny', reason: string, notes: string[], req?: FireblocksTxRequest): void => {
    appendAudit(config.auditLog, {
      ts: new Date().toISOString(),
      kind: 'fireblocks-callback',
      decision,
      reason,
      notes,
      wallet_id: String(req?.sourceId ?? railId),
      api_key_id: 'fireblocks',
      txId: req?.txId,
      asset: req?.asset,
      amount: req?.amountStr ?? (req?.amount !== undefined ? String(req.amount) : undefined),
      recipient: req?.destAddress,
    } as Record<string, unknown> as never);
  };

  const sign = async (requestId: string, action: CallbackAction, rejectionReason?: string): Promise<string> => {
    const payload: Record<string, unknown> = { action, requestId };
    if (rejectionReason) payload.rejectionReason = rejectionReason.slice(0, 256);
    return new SignJWT(payload).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().sign(handlerKey);
  };

  return {
    async handle(inboundJwt: string): Promise<CallbackResult> {
      // Layer 2: verify the inbound co-signer JWT. On failure, do not answer.
      let req: FireblocksTxRequest;
      try {
        const { payload } = await jwtVerify(inboundJwt, cosignerKey, { algorithms: ['RS256'] });
        req = payload as unknown as FireblocksTxRequest;
        if (!req || typeof req.requestId !== 'string') {
          return { kind: 'no-response', httpStatus: 400, reason: `verified JWT carries no requestId — likely a claim-nesting mismatch. Top-level claims: [${Object.keys((payload ?? {}) as object).join(', ')}]` };
        }
      } catch (err) {
        return { kind: 'no-response', httpStatus: 401, reason: `inbound co-signer JWT did not verify (RS256): ${(err as Error).message}` };
      }

      // Layer 1: evaluate. Any error past verification is a trusted-requestId
      // REJECT, never a silent approve.
      try {
        const resolved = resolvedFromFireblocks(req, assetMap);
        const verdict = await authorizeFireblocksTransaction(config, { req, assetMap, railId, resolved, ...(ledger ? { ledger } : {}) });
        if (!verdict.allow) {
          // Make a decode/nesting mismatch name itself. The first thing a live
          // Testnet integration trips on is an asset id or a JWT claim path that
          // differs from what we inferred from docs. A silent universal deny is
          // fail-closed but reads as "working as designed" — so when the
          // resolution itself is unenforceable, surface the exact field.
          let loud = verdict.reason ?? 'denied';
          if (resolved.unenforceable) {
            const looksEmpty =
              req.asset === undefined && req.operation === undefined && req.amount === undefined && req.amountStr === undefined;
            loud = looksEmpty
              ? `[claim-nesting?] ${resolved.unenforceable}. Top-level JWT claims: [${Object.keys(req).join(', ')}]`
              : `[decode-mismatch] ${resolved.unenforceable}`;
          }
          audit('deny', loud, verdict.notes, req);
          return { kind: 'signed', action: 'REJECT', jwt: await sign(req.requestId, 'REJECT', loud), requestId: req.requestId, reason: loud };
        }
        // Count the spend BEFORE approving: once signed, we treat it as spent
        // (the signature is the spend commitment; settlement timing is
        // Fireblocks'). A crossRailBudget mandate with no ledger already failed
        // closed inside authorize, so `ledger` is present whenever counted.
        if (ledger && verdict.cred) {
          const tm = verdict.cred.credentialSubject.tradingMandate;
          const def = req.asset ? assetMap[req.asset] : undefined;
          if (def && (tm?.crossRailBudget || tm?.velocity)) {
            const amtStr = req.amountStr ?? (req.amount !== undefined ? String(req.amount) : undefined);
            const amountRaw = amtStr !== undefined ? decimalToRaw(amtStr, def.decimals) : null;
            if (amountRaw !== null) {
              ledger.record({ rail: `${railId}:${req.asset}`, asset: def.symbol, amountRaw: amountRaw.toString(), decimals: def.decimals });
            }
          }
        }
        audit('allow', verdict.reason ?? 'within scope', verdict.notes, req);
        return { kind: 'signed', action: 'APPROVE', jwt: await sign(req.requestId, 'APPROVE'), requestId: req.requestId, reason: verdict.reason ?? 'within scope' };
      } catch (err) {
        const reason = `internal error evaluating transaction, failing closed: ${(err as Error).message}`;
        audit('deny', reason, [], req);
        return { kind: 'signed', action: 'REJECT', jwt: await sign(req.requestId, 'REJECT', reason), requestId: req.requestId, reason };
      }
    },
  };
}
