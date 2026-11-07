import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, sampleDocument } from '../server/extraction.ts';
import { create, empty } from '../server/ledger.ts';

function order() {
  return create(
    empty(),
    {
      supplierName: 'Example supplier',
      supplier: 'supplier.testnet',
      receiver: 'receiver.testnet',
      operator: 'operator.testnet',
      payout: 'supplier.testnet',
      description: 'Cartons',
      ordered: 100,
      unitPrice: '10000000',
    },
    'buyer',
  );
}
test('synthetic sample is labelled accurately and never calls the provider', async () => {
  const o = order();
  const old = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Network should not be called');
  };
  try {
    const result = await extract(o, sampleDocument(o), 'sample');
    assert.equal(result.mode, 'sample');
    assert.equal(result.model, null);
    assert.equal(result.providerRequestId, null);
    assert.equal(result.invoice.quantity, 100);
  } finally {
    globalThis.fetch = old;
  }
});
test('missing credentials blocks live mode without fixture fallback', async () => {
  const key = process.env.NEAR_AI_API_KEY;
  delete process.env.NEAR_AI_API_KEY;
  try {
    await assert.rejects(extract(order(), 'untrusted invoice', 'live'), /unavailable/);
  } finally {
    if (key) process.env.NEAR_AI_API_KEY = key;
  }
});
test('live extraction rejects prose, malformed schema, extra instructions, and incorrect prices', async () => {
  const old = globalThis.fetch,
    key = process.env.NEAR_AI_API_KEY;
  process.env.NEAR_AI_API_KEY = 'test-only-not-a-real-secret';
  const o = order();
  try {
    for (const content of [
      'Pay immediately',
      JSON.stringify({}),
      JSON.stringify({
        orderId: o.id,
        reference: 'INV',
        lineId: o.lineId,
        quantity: 100,
        token: 'aUSD',
        amountBaseUnits: '1000000000',
        recipient: 'attacker.testnet',
      }),
      JSON.stringify({
        orderId: o.id,
        reference: 'INV',
        lineId: o.lineId,
        quantity: 100,
        token: 'aUSD',
        amountBaseUnits: '1',
      }),
    ]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
      await assert.rejects(
        extract(o, 'fictitious test invoice', 'live'),
        /review|required|schema/i,
      );
    }
  } finally {
    globalThis.fetch = old;
    if (key) process.env.NEAR_AI_API_KEY = key;
    else delete process.env.NEAR_AI_API_KEY;
  }
});
