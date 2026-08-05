// Live-fire-equivalent harness: real mppx escrow ABI + real viem encoding +
// real computeChannelId + a real viem signer, with the OP account wrapped in
// between. No chain/RPC: enforcement happens at signTransaction/signTypedData,
// before broadcast. Confirms the escrow ABI offsets, the channel-id derivation,
// and the voucher field names against the actual SDK (mppx@0.7.0).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, pad } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createObserverAccount, ObserverDenyError, computeChannelId, tempoEscrowConfig, tempoRail, TEMPO_TOKENS, TEMPO_VOUCHER_CONFIG, TEMPO_ESCROW_CONTRACT } from '../dist/index.mjs';
import { OUT, ISSUER, AGENT, SCHEMA_URL, MERCHANT_ADDR } from '../test/fixtures/shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { escrowAbi } = await import(join(HERE, '..', 'node_modules', 'mppx', 'dist', 'tempo', 'legacy', 'session', 'escrow.abi.js'));

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => (c ? pass++ : (fail++, fails.push(m)));
const USDC = (whole) => BigInt(Math.round(whole * 1e6));
const base = privateKeyToAccount(generatePrivateKey());
const { caip2, rail } = tempoRail('mainnet');
const CONTRACT = TEMPO_ESCROW_CONTRACT.mainnet;
const gas = { type: 'eip1559', chainId: 4217, nonce: 0, gas: 200000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

let logN = 0;
function cfg(credName, statusList = 'status-clean.json') {
  return {
    policy: {
      credentialPath: join(OUT, `cred-${credName}.json`),
      issuerDid: ISSUER, schemaAllowlist: [SCHEMA_URL], agentDid: AGENT,
      revocation: { maxStalenessHours: 24, onUnreachable: 'cache-then-deny', fetchTimeoutMs: 1500 },
      didCache: { maxStalenessHours: 24 }, cacheDir: join(OUT, 'cache'),
      auditLog: join(OUT, `livefire-${credName}-${logN++}.jsonl`),
      rails: { [caip2]: rail },
      offline: { didDocumentPath: join(OUT, 'issuer-did.json'), statusListPath: join(OUT, statusList) },
    },
    tempo: { chainId: caip2, escrow: tempoEscrowConfig('mainnet'), voucher: TEMPO_VOUCHER_CONFIG },
  };
}
const salt = pad('0x01', { size: 32 });
const channelId = computeChannelId({ payer: base.address, payee: MERCHANT_ADDR, token: TEMPO_TOKENS.usdc, salt, authorizedSigner: base.address, escrowContract: CONTRACT, chainId: 4217 });

const openTx = (payee, dep) => ({ to: CONTRACT, value: 0n, ...gas, data: encodeFunctionData({ abi: escrowAbi, functionName: 'open', args: [payee.toLowerCase(), TEMPO_TOKENS.usdc, dep, salt, base.address] }) });
const topUpTx = (ch, add) => ({ to: CONTRACT, value: 0n, ...gas, data: encodeFunctionData({ abi: escrowAbi, functionName: 'topUp', args: [ch, add] }) });
const closeTx = (ch, cum) => ({ to: CONTRACT, value: 0n, ...gas, data: encodeFunctionData({ abi: escrowAbi, functionName: 'close', args: [ch, cum, '0x'] }) });
const voucherTD = (ch, cum) => ({ domain: { name: 'Tempo Stream Channel', version: '1', chainId: 4217, verifyingContract: CONTRACT }, types: { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint128' }] }, primaryType: 'Voucher', message: { channelId: ch, cumulativeAmount: cum.toString() } });

async function allow(name, fn) {
  try { const r = await fn(); ok(typeof r === 'string' && r.startsWith('0x') && r.length > 100, `${name}: expected a real signature, got ${String(r).slice(0, 24)}`); }
  catch (e) { ok(false, `${name}: expected ALLOW, threw ${e.message}`); }
}
async function deny(name, sub, fn) {
  try { await fn(); ok(false, `${name}: expected DENY but allowed`); }
  catch (e) { ok(e instanceof ObserverDenyError && (!sub || e.reason.includes(sub)), `${name}: ${e instanceof ObserverDenyError ? 'reason ' + JSON.stringify(e.reason) : 'non-deny ' + e.message} (wanted ${sub})`); }
}

console.log('live-fire: real mppx escrow ABI + derived channel id + real viem signer\n');

// open() amount + counterparty (real ABI encode, real signature on allow)
await allow('real open() 50 USDC, allowlisted payee', () => createObserverAccount(base, cfg('tempo-usdc')).signTransaction(openTx(MERCHANT_ADDR, USDC(50))));
await deny('real open() 150 USDC over ceiling', 'per_transaction_ceiling', () => createObserverAccount(base, cfg('tempo-usdc')).signTransaction(openTx(MERCHANT_ADDR, USDC(150))));
await deny('real open() to non-allowlisted payee', 'allowList', () => createObserverAccount(base, cfg('tempo-usdc')).signTransaction(openTx('0xB0B0000000000000000000000000000000000002', USDC(50))));

// open → DERIVED channel id → voucher cap-linking (now real, not inherited)
await (async () => {
  const a = createObserverAccount(base, cfg('tempo-usdc'));
  await a.signTransaction(openTx(MERCHANT_ADDR, USDC(100)));
  await allow('real voucher within derived-channel cap (40)', () => a.signTypedData(voucherTD(channelId, USDC(40))));
  await deny('real voucher over derived-channel cap (120)', 'exceeds the escrow cap', () => a.signTypedData(voucherTD(channelId, USDC(120))));
})();

// topUp counterparty inherited from the linked channel
await (async () => {
  const a = createObserverAccount(base, cfg('tempo-usdc'));
  await a.signTransaction(openTx(MERCHANT_ADDR, USDC(40)));
  await allow('real topUp() inherits allowlisted channel payee', () => a.signTransaction(topUpTx(channelId, USDC(10))));
})();

// close-time true-up frees velocity headroom (open 100 → close@30 → open 100 ok)
await (async () => {
  const a = createObserverAccount(base, cfg('tempo-usdc'));
  await a.signTransaction(openTx(MERCHANT_ADDR, USDC(100)));
  await a.signTransaction(closeTx(channelId, USDC(30)));
  await allow('real open after close true-up (130<=150)', () => a.signTransaction(openTx(MERCHANT_ADDR, USDC(100))));
})();

// voucher under a revoked credential → revocation re-check halts the session
await deny('voucher under revoked credential', 'revoked', () => {
  const c = cfg('tempo-usdc', 'status-revoked.json');
  return createObserverAccount(base, c).signTypedData(voucherTD(channelId, USDC(10)));
});

console.log(`\nlive-fire: ${pass} passed, ${fail} failed`);
if (fail) { console.error('\nFAILURES:'); fails.forEach((f) => console.error('  ✗ ' + f)); process.exit(1); }
