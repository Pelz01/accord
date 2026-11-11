import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fundingActions, fundingRequest, validateFundingQuote } from '../shared/intents.ts';

test('Intents funding binds the exact source, native USDC destination, buyer, refund and quote lifetime', () => {
  const now = Date.now(),
    request = fundingRequest('buyer.near', '0.01', new Date(now + 300000).toISOString());
  const raw = {
    quoteRequest: request,
    quote: {
      amountIn: request.amount,
      amountOut: '30000',
      minAmountOut: '29700',
      depositAddress: 'deposit.near',
    },
  };
  assert.equal(validateFundingQuote(raw, request, now).account, 'buyer.near');
  for (const change of [
    { recipient: 'attacker.near' },
    { refundTo: 'attacker.near' },
    { destinationAsset: 'nep141:fake.near' },
    { originAsset: 'nep141:fake.near' },
    { amount: '1' },
    { depositType: 'INTENTS' },
    { recipientType: 'INTENTS' },
    { dry: true },
    { slippageTolerance: 500 },
  ])
    assert.throws(() =>
      validateFundingQuote({ ...raw, quoteRequest: { ...request, ...change } }, request, now),
    );
  for (const change of [
    { amountIn: '1' },
    { minAmountOut: '1' },
    { minAmountOut: '30001' },
    { depositAddress: 'buyer.near' },
  ])
    assert.throws(() =>
      validateFundingQuote({ ...raw, quote: { ...raw.quote, ...change } }, request, now),
    );
  assert.throws(() => validateFundingQuote(raw, request, now + 300000));
  for (const amount of ['0', '0.011', '1e-2', '-0.01'])
    assert.throws(() => fundingRequest('buyer.near', amount, request.deadline));
});
test('funding batches wrap and transfer the approved amount atomically to the quote address', () => {
  const request = fundingRequest('buyer.near', '0.01', new Date(Date.now() + 300000).toISOString());
  const q = validateFundingQuote(
    {
      quoteRequest: request,
      quote: {
        amountIn: request.amount,
        amountOut: '30000',
        minAmountOut: '29700',
        depositAddress: 'deposit.near',
      },
    },
    request,
  );
  const actions = fundingActions(q, [
    { account: q.depositAddress, deposit: '1250000000000000000000' },
  ]);
  assert.equal(actions.length, 3);
  assert.equal(actions[1].params.methodName, 'near_deposit');
  assert.equal(actions[1].params.deposit, request.amount);
  assert.deepEqual(actions[2].params.args, { receiver_id: 'deposit.near', amount: request.amount });
  assert.equal(actions[2].params.deposit, '1');
  assert.throws(() => fundingActions(q, [{ account: 'attacker.near', deposit: '1' }]));
  assert.throws(() =>
    fundingActions(q, [{ account: q.account, deposit: '1000000000000000000000000' }]),
  );
});
