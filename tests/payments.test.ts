import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentRows } from '../shared/payments.ts';
import type { ChainOrder, ChainAttempt, ChainJob } from '../shared/chain.ts';

const order = {
  id: 'PO-1',
  buyer: 'buyer.testnet',
  token: 'token.testnet',
  terms: {
    supplier: 'supplier.testnet',
    receiver: 'receiver.testnet',
    operator: 'operator.testnet',
    payout: 'payout.testnet',
    unit_price: '10000000',
    unit: 'carton',
  },
} as ChainOrder;
const job = (status: ChainJob['status'], id = 'request-1'): ChainJob => ({
  id,
  orderId: order.id,
  quantity: '40',
  auditHash: 'a'.repeat(64),
  status,
  transactionHash: 'actual-transaction-hash',
  error: null,
  createdAt: '2026-11-07T10:00:00.000Z',
});
const attempt = (status: ChainAttempt['status']): ChainAttempt => ({
  request_id: 'request-1',
  order_id: order.id,
  quantity: '40',
  amount: '400000000',
  recipient: 'payout.testnet',
  audit_hash: 'a'.repeat(64),
  status,
});

test('payment history merges a request once and contract settlement wins over stale worker state', () => {
  const rows = paymentRows([order], [attempt('Settled')], [job('unresolved')], order.buyer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'Paid');
  assert.equal(rows[0].transactionHash, 'actual-transaction-hash');
  assert.equal(rows[0].amount, '400000000');
});

test('worker acknowledgement does not declare payment success without a contract result', () => {
  assert.equal(paymentRows([order], [], [job('settled')], order.buyer)[0].status, 'Checking');
  assert.equal(
    paymentRows([order], [attempt('Reserved')], [job('settled')], order.buyer)[0].status,
    'Pending',
  );
  assert.equal(
    paymentRows([order], [attempt('Reserved')], [job('unresolved')], order.buyer)[0].status,
    'Needs review',
  );
  assert.equal(
    paymentRows([order], [attempt('TransferFailed')], [job('settled')], order.buyer)[0].status,
    'Failed',
  );
});

test('recipient confirmation finalizes history while retaining its distinct source', () => {
  const rows = paymentRows(
    [order],
    [attempt('ReceiptAcknowledged')],
    [job('unresolved')],
    order.buyer,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'Paid');
  assert.equal(rows[0].receiptAcknowledged, true);
  assert.equal(rows[0].transactionHash, 'actual-transaction-hash');
  assert.equal(
    paymentRows([order], [attempt('Settled')], [], order.buyer)[0].receiptAcknowledged,
    false,
  );
});

test('history cannot reveal unrelated wallet rows and does not require a saved worker job', () => {
  assert.deepEqual(paymentRows([order], [attempt('Settled')], [job('settled')], null), []);
  assert.deepEqual(
    paymentRows([order], [attempt('Settled')], [job('settled')], 'stranger.testnet'),
    [],
  );
  const rows = paymentRows([order], [attempt('Settled')], [], 'supplier.testnet');
  assert.equal(rows[0].status, 'Paid');
  assert.equal(rows[0].transactionHash, null);
});

test('queued amounts remain exact beyond JavaScript number precision', () => {
  const large = { ...job('queued'), quantity: '9007199254740993' };
  assert.equal(paymentRows([order], [], [large], order.buyer)[0].amount, '90071992547409930000000');
});
