import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ordersForAccount, type ChainOrder } from '../shared/chain.ts';

test('wallet lists contain only orders associated with the connected account', () => {
  const own = {
    id: 'own',
    buyer: 'buyer.testnet',
    terms: {
      supplier: 'supplier.testnet',
      receiver: 'receiver.testnet',
      operator: 'operator.testnet',
      payout: 'payout.testnet',
    },
  } as ChainOrder;
  const unrelated = { ...own, id: 'other', buyer: 'other.testnet' };
  assert.deepEqual(ordersForAccount([own, unrelated], null), []);
  assert.deepEqual(ordersForAccount([own, unrelated], 'stranger.testnet'), []);
  assert.deepEqual(ordersForAccount([own, unrelated], 'buyer.testnet'), [own]);
  for (const account of Object.values(own.terms))
    assert.deepEqual(ordersForAccount([own], account), [own]);
});
