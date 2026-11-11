import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletResultHash, WalletReceiptUnavailable } from '../shared/wallet-result.ts';

const hash = 'A'.repeat(43);
test('wallet receipts accept RPC outcomes, envelopes, and hash-only responses', () => {
  for (const value of [
    { status: { SuccessValue: '' }, transaction: { hash } },
    { status: { SuccessValue: '' }, transaction_outcome: { id: hash } },
    { final_execution_outcome: { transaction: { hash } } },
    { result: { outcomes: [{ transaction: { hash } }] } },
    { transactionHash: hash },
    hash,
  ])
    assert.equal(walletResultHash(value), hash);
});
test('failed, ambiguous and incomplete wallet receipts never become successful submissions', () => {
  assert.throws(
    () => walletResultHash({ result: { status: { Failure: {} }, transaction: { hash } } }),
    /rejected/,
  );
  for (const value of [
    undefined,
    {},
    { status: { SuccessValue: '' } },
    [hash, hash],
    'ed25519:secret',
  ])
    assert.throws(() => walletResultHash(value), WalletReceiptUnavailable);
});
