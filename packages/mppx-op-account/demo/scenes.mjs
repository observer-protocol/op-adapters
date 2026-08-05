// Demo scene driver — drives the REAL wrapped account through one beat and
// prints a clean, colored result. Used by demo.sh; staged (not inlined) so the
// quoting stays sane. Uses the real mppx escrow ABI + a real viem signer, same
// as the live-fire harness.
//   node demo/scenes.mjs over|under|voucher
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { encodeFunctionData, pad } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createObserverAccount, ObserverDenyError, computeChannelId, tempoEscrowConfig, tempoRail, TEMPO_TOKENS, TEMPO_VOUCHER_CONFIG, TEMPO_ESCROW_CONTRACT } from '../dist/index.mjs';
import { OUT, ISSUER, AGENT, SCHEMA_URL, MERCHANT_ADDR } from '../test/fixtures/shared.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { escrowAbi } = await import(join(HERE, '..', 'node_modules', 'mppx', 'dist', 'tempo', 'legacy', 'session', 'escrow.abi.js'));

const green = '\x1b[1;32m', red = '\x1b[1;31m', dim = '\x1b[2m', rst = '\x1b[0m';
const USDC = (whole) => BigInt(Math.round(whole * 1e6));
const CONTRACT = TEMPO_ESCROW_CONTRACT.mainnet;
const base = privateKeyToAccount(generatePrivateKey());
const { caip2, rail } = tempoRail('mainnet');
const gas = { type: 'eip1559', chainId: 4217, nonce: 0, gas: 200000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

function cfg() {
  return {
    policy: {
      credentialPath: join(OUT, 'cred-tempo-usdc.json'),
      issuerDid: ISSUER, schemaAllowlist: [SCHEMA_URL], agentDid: AGENT,
      revocation: { maxStalenessHours: 24, onUnreachable: 'cache-then-deny', fetchTimeoutMs: 1500 },
      didCache: { maxStalenessHours: 24 }, cacheDir: join(OUT, 'cache'),
      auditLog: join(mkdtempSync(join(tmpdir(), 'mppx-demo-')), 'decisions.jsonl'),
      rails: { [caip2]: rail },
      offline: { didDocumentPath: join(OUT, 'issuer-did.json'), statusListPath: join(OUT, 'status-clean.json') },
    },
    tempo: { chainId: caip2, escrow: tempoEscrowConfig('mainnet'), voucher: TEMPO_VOUCHER_CONFIG },
  };
}
const salt = pad('0x01', { size: 32 });
const channelId = computeChannelId({ payer: base.address, payee: MERCHANT_ADDR, token: TEMPO_TOKENS.usdc, salt, authorizedSigner: base.address, escrowContract: CONTRACT, chainId: 4217 });
const openTx = (deposit) => ({ to: CONTRACT, value: 0n, ...gas, data: encodeFunctionData({ abi: escrowAbi, functionName: 'open', args: [MERCHANT_ADDR.toLowerCase(), TEMPO_TOKENS.usdc, deposit, salt, base.address] }) });
const voucherTD = (cum) => ({ domain: { name: 'Tempo Stream Channel', version: '1', chainId: 4217, verifyingContract: CONTRACT }, types: { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint128' }] }, primaryType: 'Voucher', message: { channelId, cumulativeAmount: cum.toString() } });

const scene = process.argv[2];
const acct = createObserverAccount(base, cfg());

try {
  if (scene === 'over') {
    await acct.signTransaction(openTx(USDC(150)));
    console.log(`${red}UNEXPECTED: signed${rst}`);
  } else if (scene === 'under') {
    const sig = await acct.signTransaction(openTx(USDC(50)));
    console.log(`${green}allowed — real signature: ${sig.slice(0, 42)}…${rst}`);
  } else if (scene === 'voucher') {
    await acct.signTypedData(voucherTD(USDC(70)));
    console.log(`${dim}voucher #1: cumulative 70 USDC — accepted, monotonic${rst}`);
    await acct.signTypedData(voucherTD(USDC(50)));
    console.log(`${red}UNEXPECTED: rollback voucher signed${rst}`);
  }
} catch (e) {
  if (e instanceof ObserverDenyError) console.log(`${red}DENIED — ${e.reason}${rst}`);
  else console.log(`${red}ERROR ${e.message}${rst}`);
}
