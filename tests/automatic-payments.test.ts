import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticPaymentJob } from '../server/automatic-payments.ts';
import { invoiceCommitment, type InvoiceConfirmation } from '../shared/invoices.ts';
import type { ChainOrder, ChainPaymentPolicy, ChainRecovery, Deployment } from '../shared/chain.ts';
import { orderPositions } from '../shared/payables.ts';

async function fixture() {
  const d: Deployment = {
    network: 'testnet',
    rpcUrl: '',
    vault: 'vault.testnet',
    token: 'token.testnet',
    operator: 'operator.testnet',
    accounts: {},
    wasmSha256: {},
    features: ['automatic-v1'],
  };
  const o: ChainOrder = {
    id: 'PO-AUTO',
    buyer: 'buyer.testnet',
    token: d.token,
    terms: {
      supplier: 'supplier.testnet',
      receiver: 'buyer.testnet',
      operator: d.operator,
      payout: 'supplier.testnet',
      line_id: 'cartons',
      description: 'Coffee cartons',
      unit: 'carton',
      ordered: '10',
      unit_price: '10000000',
      expires_at: '1900000000000000000',
    },
    terms_hash: 'a'.repeat(64),
    accepted_terms: true,
    funded: '100000000',
    accepted: '6',
    paid: '0',
    pending: '0',
    sequence: '1',
    attempts: 0,
  };
  const invoice = {
    order_id: o.id,
    terms_version: 1 as const,
    terms_hash: o.terms_hash,
    document_hash: 'b'.repeat(64),
    reference: 'INV-4',
    line_id: o.terms.line_id,
    quantity: '4',
    token: d.token,
    amount: '40000000',
  };
  const confirmation: InvoiceConfirmation = {
    commitment: await invoiceCommitment(d.network, d.vault, invoice),
    supplier: o.terms.supplier,
    invoice,
  };
  const policy: ChainPaymentPolicy = {
    mode: 'automatic',
    invoices: [{ commitment: confirmation.commitment, available: '4' }],
  };
  const recovery: ChainRecovery = {
    phase: 'Open',
    proposal: null,
    refund_pending: '0',
    refunded: '0',
    refunds: [],
  };
  const build = (jobs: Parameters<typeof automaticPaymentJob>[5] = []) =>
    automaticPaymentJob(d, o, policy, recovery, [confirmation], jobs);
  return { d, o, confirmation, policy, recovery, build };
}

test('automatic dispatch uses a stable ID and caps payment to confirmed remaining invoice quantity', async () => {
  const f = await fixture();
  const first = (await f.build())!;
  assert.equal(first.quantity, '4');
  assert.equal(first.authorization, 'automatic');
  assert.equal(first.invoice?.reference, 'INV-4');
  assert.equal(first.id, (await f.build())!.id);
  f.policy.invoices[0].available = '2';
  assert.equal((await f.build())!.quantity, '2');
  f.policy.invoices[0].available = '0';
  assert.equal(await f.build(), null);
});

test('manual orders, missing acceptance, insufficient funding and another deployment never produce automatic jobs', async () => {
  for (const change of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.policy.mode = 'manual';
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.d.features = [];
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.o.accepted_terms = false;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.o.funded = '0';
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.o.terms.operator = 'other.testnet';
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.o.token = 'other-token.testnet';
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.recovery.phase = 'Closed';
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.confirmation.commitment = 'c'.repeat(64);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.o.pending = '1';
    },
  ]) {
    const f = await fixture();
    change(f);
    assert.equal(await f.build(), null);
  }
});

test('queued, failed and uncertain requests pause dispatch; a restart cannot create a second job', async () => {
  const f = await fixture();
  const job = (await f.build())!;
  for (const status of ['queued', 'submitting', 'unresolved', 'failed'] as const) {
    assert.equal(await f.build([{ ...job, status }]), null);
  }
  assert.equal((await f.build([{ ...job, vault: 'other-vault.testnet' }]))!.id, job.id);
});

test('automatic payables use the on-chain remaining invoice amount after previous settlement', async () => {
  const f = await fixture();
  f.o.paid = '4';
  f.policy.invoices[0].available = '0';
  const [position] = orderPositions(
    {
      configured: true,
      orders: [f.o],
      attempts: [],
      deployment: f.d,
      operatorReady: true,
      liveAiAvailable: true,
      confirmations: { [f.o.id]: [f.confirmation] },
      paymentPolicies: { [f.o.id]: f.policy },
    },
    [],
    f.o.buyer,
  );
  assert.equal(position.ready, '0');
  assert.equal(position.invoiceReview, '20000000');
  assert.equal(position.committed, '60000000');
  const confirmations = [f.confirmation];
  for (const reference of ['INV-NEW-1', 'INV-NEW-2']) {
    const invoice = { ...f.confirmation.invoice, reference, quantity: '1', amount: '10000000' };
    const commitment = await invoiceCommitment(f.d.network, f.d.vault, invoice);
    confirmations.push({ supplier: f.o.terms.supplier, commitment, invoice });
    f.policy.invoices.push({ commitment, available: '1' });
  }
  const [next] = orderPositions(
    {
      configured: true,
      orders: [f.o],
      attempts: [],
      deployment: f.d,
      operatorReady: true,
      liveAiAvailable: true,
      confirmations: { [f.o.id]: confirmations },
      paymentPolicies: { [f.o.id]: f.policy },
    },
    [],
    f.o.buyer,
  );
  assert.equal(next.ready, '20000000');
  assert.equal(next.status, 'Payment scheduled');
});
