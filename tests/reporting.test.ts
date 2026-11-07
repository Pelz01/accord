import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderPositions, positionTotals } from '../shared/payables.ts';
import { paymentRows } from '../shared/payments.ts';
import {
  advicePath,
  csv,
  exactAmount,
  hasAdvice,
  orderCSV,
  paymentCSV,
  refundCSV,
} from '../shared/reports.ts';
import type { ChainAttempt, ChainJob, ChainOrder, ChainState } from '../shared/chain.ts';
import type { InvoicePayload } from '../shared/invoices.ts';

const order: ChainOrder = {
  id: 'PO-REPORT-1',
  buyer: 'buyer.testnet',
  token: 'token.testnet',
  terms: {
    supplier: 'supplier.testnet',
    receiver: 'receiver.testnet',
    operator: 'operator.testnet',
    payout: 'payout.testnet',
    line_id: 'cartons',
    description: 'Coffee cartons',
    unit: 'carton',
    ordered: '100',
    unit_price: '10000000',
    expires_at: '1900000000000000000',
  },
  terms_hash: 'a'.repeat(64),
  accepted_terms: true,
  funded: '1000000000',
  accepted: '60',
  paid: '20',
  pending: '10',
  sequence: '1',
  attempts: 2,
};
const invoice: InvoicePayload = {
  order_id: order.id,
  terms_version: 1,
  terms_hash: order.terms_hash,
  document_hash: 'b'.repeat(64),
  reference: 'INV-東京-001',
  line_id: 'cartons',
  quantity: '100',
  token: order.token,
  amount: '1000000000',
};
const job = (id: string, quantity: string, status: ChainJob['status'] = 'queued'): ChainJob => ({
  id,
  orderId: order.id,
  quantity,
  auditHash: invoice.document_hash,
  status,
  transactionHash: 'tx-' + id,
  error: null,
  createdAt: '2026-11-07T10:00:00.000Z',
  network: 'testnet',
  vault: 'vault.testnet',
  invoice,
});
const attempt = (id: string, quantity: string, status: ChainAttempt['status']): ChainAttempt => ({
  request_id: id,
  order_id: order.id,
  quantity,
  amount: (BigInt(quantity) * 10000000n).toString(),
  recipient: order.terms.payout,
  audit_hash: invoice.document_hash,
  status,
});
function state(): ChainState {
  return {
    configured: true,
    authRequired: true,
    operatorReady: true,
    liveAiAvailable: true,
    deployment: {
      network: 'testnet',
      rpcUrl: '',
      vault: 'vault.testnet',
      token: order.token,
      operator: order.terms.operator,
      accounts: {},
      wasmSha256: {},
      features: ['invoice-v1', 'recovery-v1'],
    },
    orders: [structuredClone(order)],
    attempts: [attempt('paid', '20', 'Settled'), attempt('pending', '10', 'Reserved')],
    confirmations: {
      [order.id]: [
        {
          supplier: order.terms.supplier,
          commitment: 'c'.repeat(64),
          invoice: structuredClone(invoice),
        },
      ],
    },
  };
}

test('payables conserve the order balance and count a worker reservation once', () => {
  const s = state();
  const jobs = [
    job('paid', '20', 'settled'),
    job('pending', '10', 'submitting'),
    job('queue', '5'),
  ];
  const [p] = orderPositions(s, jobs, order.buyer);
  assert.deepEqual(
    [p.paid, p.committed, p.ready, p.processing, p.awaitingDispatch, p.awaitingDelivery],
    ['200000000', '800000000', '250000000', '150000000', '50000000', '400000000'],
  );
  assert.equal(
    BigInt(p.ready) +
      BigInt(p.invoiceReview) +
      BigInt(p.processing) +
      BigInt(p.awaitingDelivery) +
      BigInt(p.refundHeld),
    BigInt(p.committed),
  );
  assert.equal(p.status, 'Ready to review');
});

test('funding and exact supplier confirmation gate readiness; confirmations are never added as invoice balances', () => {
  const s = state();
  s.attempts = [];
  s.orders[0].pending = '0';
  s.confirmations = {};
  assert.deepEqual(
    orderPositions(s, [], order.buyer).map((p) => [p.ready, p.invoiceReview]),
    [['0', '400000000']],
  );
  const invalid = [
    { ...invoice, terms_hash: 'f'.repeat(64) },
    { ...invoice, amount: '1' },
    { ...invoice, token: 'other-token.testnet' },
  ];
  s.confirmations[order.id] = invalid.map((i) => ({
    supplier: order.terms.supplier,
    commitment: 'c'.repeat(64),
    invoice: i,
  }));
  assert.equal(orderPositions(s, [], order.buyer)[0].ready, '0');
  s.confirmations[order.id] = ['2', '3'].map((q) => ({
    supplier: order.terms.supplier,
    commitment: 'c'.repeat(64),
    invoice: { ...invoice, quantity: q, amount: (BigInt(q) * 10000000n).toString() },
  }));
  assert.deepEqual(
    orderPositions(s, [], order.buyer).map((p) => [p.ready, p.invoiceReview]),
    [['30000000', '370000000']],
  );
  s.orders[0].funded = '0';
  assert.deepEqual(
    orderPositions(s, [], order.buyer).map((p) => [p.ready, p.processing, p.committed]),
    [['0', '0', '0']],
  );
});

test('queued and unknown submissions hold available capacity without inventing another contract reservation', () => {
  const s = state();
  const jobs = [job('pending', '10', 'unresolved'), job('unknown', '100', 'unresolved')];
  const p = orderPositions(s, jobs, order.buyer)[0];
  assert.equal(p.ready, '0');
  assert.equal(p.processing, '400000000');
  assert.equal(p.needsReview, true);
  assert.equal(p.reviewHeld, p.processing);
  assert.equal(p.status, 'Needs review');
});

test('closed refunds leave committed totals and pending or failed refunds never become new payable capacity', () => {
  for (const phase of ['Closed', 'RefundPending', 'RefundFailed'] as const) {
    const s = state();
    s.orders[0] = { ...s.orders[0], accepted: '20', paid: '20', pending: '0' };
    s.recoveries = {
      [order.id]: {
        phase,
        proposal: null,
        refunded: phase === 'Closed' ? '800000000' : '0',
        refund_pending: phase === 'RefundPending' ? '800000000' : '0',
        refunds: [],
      },
    };
    const p = orderPositions(s, [], order.buyer)[0];
    assert.equal(p.ready, '0');
    assert.equal(p.awaitingDelivery, '0');
    assert.equal(p.committed, phase === 'Closed' ? '0' : '800000000');
    assert.equal(p.refundHeld, p.committed);
  }
});

test('buyer and supplier reports have separate ownership scopes and never combine another token', () => {
  const s = state();
  const selling: ChainOrder = {
    ...structuredClone(order),
    id: 'PO-SELL',
    buyer: 'another-buyer.testnet',
    terms: { ...order.terms, supplier: order.buyer, payout: order.buyer },
  };
  s.orders.push(selling, {
    ...structuredClone(order),
    id: 'PO-FOREIGN-TOKEN',
    token: 'foreign.testnet',
  });
  assert.deepEqual(
    orderPositions(s, [], order.buyer, 'buyer').map((p) => p.order.id),
    [order.id],
  );
  assert.deepEqual(
    orderPositions(s, [], order.buyer, 'supplier').map((p) => p.order.id),
    ['PO-SELL'],
  );
  assert.deepEqual(orderPositions(s, [], 'stranger.testnet'), []);
  assert.deepEqual(orderPositions(s, [], null), []);
});

test('advice requires authoritative confirmation and mismatched worker metadata cannot supply an invoice or receipt', () => {
  const s = state();
  const queued = paymentRows(
    s.orders,
    [],
    [job('x', '5', 'settled')],
    order.buyer,
    s.deployment,
  )[0];
  assert.equal(queued.status, 'Checking');
  assert.equal(hasAdvice(queued), false);
  for (const status of ['Reserved', 'TransferFailed'] as const) {
    assert.equal(
      hasAdvice(
        paymentRows(
          s.orders,
          [attempt('paid', '20', status)],
          [job('paid', '20')],
          order.buyer,
          s.deployment,
        )[0],
      ),
      false,
    );
  }
  const row = paymentRows(
    s.orders,
    [attempt('paid', '20', 'Settled')],
    [job('paid', '20', 'settled')],
    order.buyer,
    s.deployment,
  )[0];
  assert.equal(hasAdvice(row), true);
  assert.equal(row.invoice?.reference, invoice.reference);
  const wrong = { ...job('paid', '20', 'settled'), auditHash: 'e'.repeat(64) };
  const unbound = paymentRows(
    s.orders,
    [attempt('paid', '20', 'Settled')],
    [wrong],
    order.buyer,
    s.deployment,
  )[0];
  assert.equal(unbound.invoice, null);
  assert.equal(unbound.transactionHash, null);
  assert.equal(unbound.createdAt, null);
  const acknowledged = paymentRows(
    s.orders,
    [attempt('paid', '20', 'ReceiptAcknowledged')],
    [],
    order.buyer,
    s.deployment,
  )[0];
  assert.equal(hasAdvice(acknowledged), true);
  assert.equal(acknowledged.settlement, 'recipient');
});

test('cross-deployment jobs are excluded, legacy attempts retain blank invoice and date fields', () => {
  const s = state();
  const foreign = { ...job('paid', '20', 'settled'), vault: 'other-vault.testnet' };
  const rows = paymentRows(
    s.orders,
    [attempt('paid', '20', 'Settled')],
    [foreign],
    order.buyer,
    s.deployment,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoice, null);
  assert.equal(rows[0].createdAt, null);
  const result = paymentCSV(rows, s.deployment!, '2026-11-07T10:30:00.000Z');
  assert.ok(result.includes('"Contract settlement"'));
  assert.ok(!result.includes('INV-東京'));
  assert.ok(!result.includes('tx-paid'));
});

test('CSV protects spreadsheet formulas, preserves Unicode, quotes and newlines, and exports exact amounts', () => {
  const output = csv([['=SUM(1,1)', ' \t@x', '+cmd', '-cmd', 'normal "quote"', '東京\nline']]);
  assert.equal(
    output,
    '\uFEFF"\'=SUM(1,1)","\' \t@x","\'+cmd","\'-cmd","normal ""quote""","東京\nline"\r\n',
  );
  assert.equal(exactAmount('9007199254740993123456'), '9007199254740993.123456');
  assert.equal(exactAmount('1'), '0.000001');
  assert.equal(exactAmount('1000000'), '1');
  const s = state();
  s.orders[0].terms.description = '=HYPERLINK("https://example.invalid")';
  const positions = orderPositions(s, [], order.buyer);
  const result = orderCSV(positions, s.deployment!, '2026-11-07T10:30:00.000Z');
  assert.ok(result.includes('"\'=HYPERLINK(""https://example.invalid"")"'));
  assert.ok(result.includes('"800"'));
  assert.equal(positionTotals(positions).committed, '800000000');
  s.recoveries = {
    [order.id]: {
      phase: 'Closed',
      proposal: null,
      refund_pending: '0',
      refunded: '800000000',
      refunds: [
        { id: 1, amount: '800000000', recipient: order.buyer, status: 'ReceiptAcknowledged' },
      ],
    },
  };
  assert.ok(
    refundCSV(
      orderPositions(s, [], order.buyer),
      s.deployment!,
      '2026-11-07T10:30:00.000Z',
    ).includes('"Recipient acknowledgment"'),
  );
  assert.equal(advicePath('a/b?c'), '/workspace?view=payments&payment=a%2Fb%3Fc');
});
