import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Ledger,
  create,
  accept,
  fund,
  deliver,
  reserve,
  finalize,
  hash,
} from '../server/ledger.ts';
import { available } from '../shared/schema.ts';
const input = {
  supplierName: 'Meridian Supply Co.',
  supplier: 'supplier.testnet',
  payout: 'supplier.testnet',
  receiver: 'receiver.testnet',
  operator: 'operator.testnet',
  description: 'Packing cartons',
  ordered: 100,
  unitPrice: '10000000',
};
function setup() {
  const l = new Ledger(':memory:');
  l.write((s) => {
    const o = create(s, input, 'buyer');
    accept(s, o.id, 'supplier', o.termsHash);
    fund(s, o.id, 'buyer', '1000000000');
    deliver(s, o.id, 'receiver', 1, 40);
  });
  return l;
}
test('partial settlement is incremental, fixed-price and fixed-recipient', () => {
  const l = setup();
  l.write((s) => reserve(s, 'PO-0001', 'operator', 'r1', 40, hash('invoice')));
  assert.equal(l.read().orders[0].pending, 40);
  l.write((s) => finalize(s, 'r1', 'success'));
  l.write((s) => deliver(s, 'PO-0001', 'receiver', 2, 70));
  assert.equal(available(l.read().orders[0]), 30);
  const a = l.write((s) => reserve(s, 'PO-0001', 'operator', 'r2', 30, hash('renamed')));
  assert.equal(a.amount, '300000000');
  assert.equal(a.recipient, 'supplier.testnet');
  l.write((s) => finalize(s, 'r2', 'success'));
  assert.equal(l.read().simulatedSupplierBalances['supplier.testnet'], '700000000');
  l.close();
});
test('overlapping requests cannot spend reservations', () => {
  const l = setup();
  l.write((s) => reserve(s, 'PO-0001', 'operator', 'r1', 30, hash('one')));
  assert.throws(
    () => l.write((s) => reserve(s, 'PO-0001', 'operator', 'r2', 11, hash('two'))),
    /exceeds/,
  );
  assert.equal(l.read().orders[0].pending, 30);
  l.close();
});
test('failed transfer releases capacity but its ID remains consumed', () => {
  const l = setup();
  l.write((s) => reserve(s, 'PO-0001', 'operator', 'r1', 40, hash('one')));
  l.write((s) => finalize(s, 'r1', 'failure'));
  assert.equal(available(l.read().orders[0]), 40);
  assert.throws(
    () => l.write((s) => reserve(s, 'PO-0001', 'operator', 'r1', 1, hash('one'))),
    /already exists/,
  );
  l.close();
});
test('starved callback preserves reservation even after simulated transfer', () => {
  const l = setup();
  l.write((s) => reserve(s, 'PO-0001', 'operator', 'starved', 40, hash('one')));
  l.write((s) => finalize(s, 'starved', 'starved'));
  const s = l.read();
  assert.equal(s.orders[0].pending, 40);
  assert.equal(s.orders[0].paid, 0);
  assert.equal(s.simulatedSupplierBalances['supplier.testnet'], '400000000');
  assert.equal(s.attempts[0].status, 'unresolved');
  assert.throws(
    () => l.write((s) => reserve(s, 'PO-0001', 'operator', 'new', 1, hash('one'))),
    /exceeds/,
  );
  l.close();
});
test('repeated finalization has no effect', () => {
  const l = setup();
  l.write((s) => reserve(s, 'PO-0001', 'operator', 'r', 40, hash('one')));
  l.write((s) => finalize(s, 'r', 'success'));
  l.write((s) => finalize(s, 'r', 'success'));
  assert.equal(l.read().orders[0].paid, 40);
  assert.equal(l.read().simulatedSupplierBalances['supplier.testnet'], '400000000');
  l.close();
});
test('stale, skipped, equal, decreasing and excess delivery updates leave state unchanged', () => {
  const l = setup();
  for (const [sequence, total] of [
    [1, 50],
    [3, 50],
    [2, 40],
    [2, 30],
    [2, 101],
  ])
    assert.throws(() => l.write((s) => deliver(s, 'PO-0001', 'receiver', sequence, total)));
  assert.deepEqual([l.read().orders[0].sequence, l.read().orders[0].accepted], [1, 40]);
  l.close();
});
test('unauthorized role cannot approve deliveries or request payments', () => {
  const l = setup();
  assert.throws(() => l.write((s) => deliver(s, 'PO-0001', 'operator', 2, 50)), /receiver/);
  assert.throws(
    () => l.write((s) => reserve(s, 'PO-0001', 'buyer', 'r', 1, hash('one'))),
    /operator/,
  );
  l.close();
});
test('wrong funding amount and duplicate funding cannot alter budget', () => {
  const l = setup();
  assert.throws(() => l.write((s) => fund(s, 'PO-0001', 'buyer', '999')));
  assert.equal(l.read().orders[0].funded, '1000000000');
  l.close();
});
test('one order cannot consume another order funding', () => {
  const l = setup();
  l.write((s) => {
    const o = create(s, input, 'buyer');
    accept(s, o.id, 'supplier', o.termsHash);
    fund(s, o.id, 'buyer', '1000000000');
  });
  assert.throws(() => l.write((s) => reserve(s, 'PO-0002', 'operator', 'r', 1, hash('one'))));
  assert.equal(l.read().orders.find((o) => o.id === 'PO-0001')?.accepted, 40);
  l.close();
});
test('durable reservation survives process restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accord-'));
  try {
    let l = new Ledger(join(dir, 'ledger.db'));
    l.write((s) => {
      const o = create(s, input, 'buyer');
      accept(s, o.id, 'supplier', o.termsHash);
      fund(s, o.id, 'buyer', '1000000000');
      deliver(s, o.id, 'receiver', 1, 40);
      reserve(s, o.id, 'operator', 'durable', 40, hash('one'));
    });
    l.close();
    l = new Ledger(join(dir, 'ledger.db'));
    assert.equal(l.read().orders[0].pending, 40);
    assert.equal(l.read().attempts[0].id, 'durable');
    l.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
