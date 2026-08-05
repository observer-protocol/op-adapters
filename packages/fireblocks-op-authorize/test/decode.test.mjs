import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimalToRaw, resolvedFromFireblocks, DEFAULT_FIREBLOCKS_ASSETS } from '../dist/index.js';

const MAP = DEFAULT_FIREBLOCKS_ASSETS;

test('decimalToRaw: whole and fractional', () => {
  assert.equal(decimalToRaw('1', 6), 1000000n);
  assert.equal(decimalToRaw('1.5', 18), 1500000000000000000n);
  assert.equal(decimalToRaw('0.000001', 6), 1n);
  assert.equal(decimalToRaw('250', 6), 250000000n);
});

test('decimalToRaw: fails closed on malformed / over-precise', () => {
  assert.equal(decimalToRaw('1.2345678', 6), null); // more fraction digits than decimals
  assert.equal(decimalToRaw('abc', 6), null);
  assert.equal(decimalToRaw('-1', 6), null);
  assert.equal(decimalToRaw('', 6), null);
});

test('resolvedFromFireblocks: valid USDC transfer resolves and is enforceable', () => {
  const r = resolvedFromFireblocks(
    { txId: 't1', requestId: 'r1', operation: 'TRANSFER', asset: 'USDC_ETH_TEST5', amountStr: '250', destAddress: '0xabc' },
    MAP,
  );
  assert.equal(r.unenforceable, undefined);
  assert.equal(r.kind, 'evm-token');
  assert.equal(r.assetSymbol, 'USDC');
  assert.equal(r.amount, 250000000n);
  assert.equal(r.decimals, 6);
  assert.equal(r.recipient, '0xabc');
});

test('resolvedFromFireblocks: unknown asset fails closed', () => {
  const r = resolvedFromFireblocks(
    { txId: 't', requestId: 'r', operation: 'TRANSFER', asset: 'MYSTERY_COIN', amountStr: '1', destAddress: '0xabc' },
    MAP,
  );
  assert.match(r.unenforceable ?? '', /unrecognized Fireblocks asset id MYSTERY_COIN/);
  assert.equal(r.kind, 'unparsed');
});

test('resolvedFromFireblocks: non-transfer operation fails closed', () => {
  const r = resolvedFromFireblocks(
    { txId: 't', requestId: 'r', operation: 'CONTRACT_CALL', asset: 'ETH_TEST5', amountStr: '1', destAddress: '0xabc' },
    MAP,
  );
  assert.match(r.unenforceable ?? '', /CONTRACT_CALL is not a plain value transfer/);
});

test('resolvedFromFireblocks: multi-destination fails closed', () => {
  const r = resolvedFromFireblocks(
    {
      txId: 't', requestId: 'r', operation: 'TRANSFER', asset: 'ETH_TEST5',
      destinations: [
        { amount: '1', destination: { oneTimeAddress: { address: '0xa' } } },
        { amount: '2', destination: { oneTimeAddress: { address: '0xb' } } },
      ],
    },
    MAP,
  );
  assert.match(r.unenforceable ?? '', /multi-destination/);
});

test('resolvedFromFireblocks: over-precise amount for the asset fails closed', () => {
  const r = resolvedFromFireblocks(
    { txId: 't', requestId: 'r', operation: 'TRANSFER', asset: 'USDC_ETH_TEST5', amountStr: '1.9999999', destAddress: '0xabc' },
    MAP,
  );
  assert.match(r.unenforceable ?? '', /not representable in 6 decimals/);
});
