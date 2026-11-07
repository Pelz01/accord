import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalInvoice, invoiceCommitment, invoicePayloadSchema } from '../shared/invoices.ts';

test('invoice commitment matches the pinned Rust unicode vector and binds every field', async () => {
  const vector = JSON.parse(readFileSync('fixtures/invoice-canonical.json', 'utf8'));
  assert.equal(canonicalInvoice(vector.network, vector.vault, vector.payload), vector.canonical);
  assert.equal(
    await invoiceCommitment(vector.network, vector.vault, vector.payload),
    vector.sha256,
  );
  for (const [key, value] of Object.entries({
    order_id: 'OTHER',
    terms_hash: 'c'.repeat(64),
    document_hash: 'd'.repeat(64),
    reference: 'renamed',
    line_id: 'other',
    quantity: '99',
    token: 'other.testnet',
    amount: '999',
  })) {
    assert.notEqual(
      await invoiceCommitment(vector.network, vector.vault, { ...vector.payload, [key]: value }),
      vector.sha256,
    );
  }
  assert.notEqual(await invoiceCommitment('mainnet', vector.vault, vector.payload), vector.sha256);
  assert.notEqual(
    await invoiceCommitment(vector.network, 'other.testnet', vector.payload),
    vector.sha256,
  );
  assert.equal(
    invoicePayloadSchema.safeParse({ ...vector.payload, terms_version: 2 }).success,
    false,
  );
  assert.equal(
    invoicePayloadSchema.safeParse({ ...vector.payload, quantity: '01' }).success,
    false,
  );
});
