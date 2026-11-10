import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deploymentBudget,
  nativeAmount,
  nativeDisplay,
  verifySettlementAsset,
  MAINNET_USDC,
  MAINNET_USDC_ASSET,
  VERIFIED_USDC_CODE_HASH,
} from '../shared/mainnet-readiness.ts';

test('mainnet budget refuses the current artifact under a two-NEAR ceiling using exact units', () => {
  const b = deploymentBudget(232955, 10n ** 19n, nativeAmount('2'));
  assert.equal(nativeDisplay(b.codeStorage), '2.32955');
  assert.equal(nativeDisplay(b.minimumRequired), '3.32955');
  assert.equal(b.exceedsCap, true);
  assert.equal(deploymentBudget(100000, 10n ** 19n, nativeAmount('2')).exceedsCap, false);
  assert.equal(
    nativeDisplay(nativeAmount('0.000000000000000000000001')),
    '0.000000000000000000000001',
  );
  for (const value of ['1e2', '-1', '2junk', '0.0000000000000000000000001'])
    assert.throws(() => nativeAmount(value));
});

test('native USDC selection rejects a same-symbol bridged token, wrong decimals or changed code', () => {
  const meta = { symbol: 'USDC', decimals: 6 };
  const asset = {
    assetId: MAINNET_USDC_ASSET,
    contractAddress: MAINNET_USDC,
    blockchain: 'near',
    decimals: 6,
  };
  assert.equal(verifySettlementAsset(meta, VERIFIED_USDC_CODE_HASH, [asset]), MAINNET_USDC_ASSET);
  assert.throws(() => verifySettlementAsset(meta, 'changed', [asset]));
  assert.throws(() =>
    verifySettlementAsset({ ...meta, decimals: 18 }, VERIFIED_USDC_CODE_HASH, [asset]),
  );
  for (const change of [
    { contractAddress: 'bridged.near' },
    { assetId: 'nep141:bridged.near' },
    { blockchain: 'base' },
    { decimals: 18 },
  ])
    assert.throws(() =>
      verifySettlementAsset(meta, VERIFIED_USDC_CODE_HASH, [{ ...asset, ...change }]),
    );
});
