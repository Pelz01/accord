import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extract, sampleDocument } from '../server/extraction.ts';
import { create, empty } from '../server/ledger.ts';
import { DEFAULT_NEAR_AI_MODEL } from '../shared/inference.ts';

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
        orderId: '',
        reference: '',
        lineId: '',
        quantity: 0,
        token: '',
        amountBaseUnits: '',
      }),
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

test('recorded real provider output passes through the same strict live adapter', async () => {
  const fixture = JSON.parse(readFileSync('fixtures/near-ai-extraction.json', 'utf8'));
  const oldFetch = globalThis.fetch,
    key = process.env.NEAR_AI_API_KEY,
    model = process.env.NEAR_AI_MODEL;
  process.env.NEAR_AI_API_KEY = 'test-only-not-a-real-secret';
  process.env.NEAR_AI_MODEL = DEFAULT_NEAR_AI_MODEL;
  const o = order();
  o.id = fixture.order.id;
  o.lineId = fixture.order.lineId;
  o.unitPrice = fixture.order.unitPrice;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, fixture.provider.endpoint);
    const request = JSON.parse(options!.body as string);
    assert.equal(request.model, DEFAULT_NEAR_AI_MODEL);
    assert.equal(request.max_tokens, 512);
    assert.equal(request.response_format.type, 'json_object');
    assert.match(request.messages[0].content, /untrusted/);
    assert.equal(JSON.parse(request.messages[1].content).document, fixture.input.text);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(fixture.invoice) } }] }),
      { headers: { 'x-request-id': fixture.provider.requestId } },
    );
  };
  try {
    const result = await extract(o, fixture.input.text, 'live');
    assert.equal(calls, 1);
    assert.deepEqual(result.invoice, fixture.invoice);
    assert.equal(result.documentHash, fixture.input.sha256);
    assert.equal(result.providerRequestId, fixture.provider.requestId);
    assert.equal(result.mode, 'live');
    assert.ok(!JSON.stringify(result).includes(process.env.NEAR_AI_API_KEY!));
  } finally {
    globalThis.fetch = oldFetch;
    if (key) process.env.NEAR_AI_API_KEY = key;
    else delete process.env.NEAR_AI_API_KEY;
    if (model) process.env.NEAR_AI_MODEL = model;
    else delete process.env.NEAR_AI_MODEL;
  }
});

test('recorded provider fixture has input provenance without a real customer invoice', () => {
  const fixture = JSON.parse(readFileSync('fixtures/near-ai-extraction.json', 'utf8'));
  assert.equal(fixture.kind, 'recorded-live-near-ai-extraction');
  assert.equal(fixture.input.synthetic, true);
  assert.equal(createHash('sha256').update(fixture.input.text).digest('hex'), fixture.input.sha256);
  assert.equal(fixture.provider.model, DEFAULT_NEAR_AI_MODEL);
  assert.ok(fixture.provider.requestId);
  assert.ok(Number.isFinite(Date.parse(fixture.provider.recordedAt)));
});

test('upstream HTTP, invalid envelope and transport failures remain errors without fallback', async () => {
  const oldFetch = globalThis.fetch,
    key = process.env.NEAR_AI_API_KEY;
  process.env.NEAR_AI_API_KEY = 'test-only-not-a-real-secret';
  try {
    globalThis.fetch = async () => new Response('', { status: 401 });
    await assert.rejects(extract(order(), 'Invoice', 'live'), /HTTP 401/);
    globalThis.fetch = async () => new Response('not a response envelope');
    await assert.rejects(extract(order(), 'Invoice', 'live'), /invalid JSON/);
    globalThis.fetch = async () => {
      throw new Error('transport failure');
    };
    await assert.rejects(extract(order(), 'Invoice', 'live'), /No fallback/);
  } finally {
    globalThis.fetch = oldFetch;
    if (key) process.env.NEAR_AI_API_KEY = key;
    else delete process.env.NEAR_AI_API_KEY;
  }
});
