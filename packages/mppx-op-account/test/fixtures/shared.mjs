// Shared constants, REAL escrow/voucher builders, and the test policy config —
// used by both the fixture generator and the imperative runner. Builders use the
// real mppx@0.7.0 escrow ABI + viem encoding + the real computeChannelId, so
// conformance exercises the same decode/derivation path as production. A mock
// base account (run.mjs) avoids needing a real key for allow-path assertions.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, pad } from 'viem';
import { computeChannelId, tempoEscrowConfig, tempoRail, TEMPO_TOKENS, TEMPO_ESCROW_CONTRACT, TEMPO_VOUCHER_CONFIG } from '../../dist/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = join(HERE, 'out');
const { escrowAbi } = await import(join(HERE, '..', '..', 'node_modules', 'mppx', 'dist', 'tempo', 'legacy', 'session', 'escrow.abi.js'));

export const ISSUER = 'did:web:issuer.example';
export const AGENT = 'did:web:issuer.example:agents:tempo-agent';
export const SCHEMA_URL = 'https://observerprotocol.org/schemas/delegation/v2.1.json';
export const SCHEMA_URL_V24 = 'https://observerprotocol.org/schemas/delegation/v2.4.json';

// lowercased so viem accepts them as args (non-checksummed test addresses); the
// adapter compares counterparties case-insensitively.
export const AGENT_ADDR = '0x000000000000000000000000000000000000a6e7'; // = mock base address (40 hex)
export const MERCHANT_ADDR = '0xa11ce00000000000000000000000000000000001'; // allowlisted payee
export const OTHER_ADDR = '0xb0b0000000000000000000000000000000000002';

const NET = 'mainnet';
const { caip2, rail } = tempoRail(NET);
export const CHAIN_NUM = Number(caip2.split(':')[1]);
const CONTRACT = TEMPO_ESCROW_CONTRACT[NET];
const USDC_TOKEN = TEMPO_TOKENS.usdc;
export const USDC = (whole) => BigInt(Math.round(whole * 1e6));
export const salt = (seed = '01') => pad(`0x${seed}`, { size: 32 });

const evmGas = { type: 'eip1559', chainId: CHAIN_NUM, nonce: 0, gas: 200000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

export function openTx(payee, deposit, s = salt()) {
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'open', args: [payee, USDC_TOKEN, deposit, s, AGENT_ADDR] });
  return { to: CONTRACT, value: 0n, ...evmGas, data };
}
/** The channel id the adapter will derive for an openTx with the same args. */
export function channelFor(payee, s = salt()) {
  return computeChannelId({ payer: AGENT_ADDR, payee, token: USDC_TOKEN, salt: s, authorizedSigner: AGENT_ADDR, escrowContract: CONTRACT, chainId: CHAIN_NUM });
}
export function topUpTx(channelId, add) {
  return { to: CONTRACT, value: 0n, ...evmGas, data: encodeFunctionData({ abi: escrowAbi, functionName: 'topUp', args: [channelId, add] }) };
}
export function closeTx(channelId, cumulative) {
  return { to: CONTRACT, value: 0n, ...evmGas, data: encodeFunctionData({ abi: escrowAbi, functionName: 'close', args: [channelId, cumulative, '0x'] }) };
}
export function requestCloseTx(channelId) {
  return { to: CONTRACT, value: 0n, ...evmGas, data: encodeFunctionData({ abi: escrowAbi, functionName: 'requestClose', args: [channelId] }) };
}
export function unknownEscrowTx() {
  return { to: CONTRACT, value: 0n, ...evmGas, data: '0xdeadbeef' };
}
export function voucher(channelId, cumulativeRaw) {
  return {
    domain: { name: 'Tempo Stream Channel', version: '1', chainId: CHAIN_NUM, verifyingContract: CONTRACT },
    types: { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint128' }] },
    primaryType: 'Voucher',
    message: { channelId, cumulativeAmount: BigInt(cumulativeRaw).toString() },
  };
}
export function nonVoucherTypedData() {
  return { domain: { name: 'Login', version: '1' }, types: { Login: [{ name: 'nonce', type: 'string' }] }, primaryType: 'Login', message: { nonce: 'abc' } };
}

export function makeConfig(credName, { auditLog, statusList = 'status-clean.json', allowSignMessage } = {}) {
  return {
    policy: {
      credentialPath: join(OUT, `cred-${credName}.json`),
      issuerDid: ISSUER, schemaAllowlist: [SCHEMA_URL, SCHEMA_URL_V24], agentDid: AGENT,
      revocation: { maxStalenessHours: 24, onUnreachable: 'cache-then-deny', fetchTimeoutMs: 1500 },
      didCache: { maxStalenessHours: 24 }, cacheDir: join(OUT, 'cache'),
      auditLog: auditLog ?? join(OUT, 'decisions.jsonl'),
      rails: { [caip2]: rail },
      offline: { didDocumentPath: join(OUT, 'issuer-did.json'), statusListPath: join(OUT, statusList) },
    },
    tempo: { chainId: caip2, escrow: tempoEscrowConfig(NET), voucher: TEMPO_VOUCHER_CONFIG },
    allowSignMessage,
  };
}
