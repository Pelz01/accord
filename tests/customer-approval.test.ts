import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerApprovalDeposit, customerApprovalMethods } from '../shared/customer-approval.ts';
import type { Deployment } from '../shared/chain.ts';

test('wallet calls attach one yocto only for guarded customer actions on automatic orders', () => {
  const d = { features: ['automatic-v1', 'customer-approval-v1'] } as Deployment;
  for (const method of customerApprovalMethods) {
    assert.equal(customerApprovalDeposit(d, method, { mode: 'automatic', invoices: [] }), '1');
    assert.equal(customerApprovalDeposit(d, method, { mode: 'manual', invoices: [] }), '0');
    assert.throws(() => customerApprovalDeposit(d, method), /Refresh this order/);
  }
  for (const method of ['request_payment', 'create_automatic_order', 'create_order'])
    assert.equal(customerApprovalDeposit(d, method), '0');
  assert.equal(
    customerApprovalDeposit({ features: ['automatic-v1'] } as Deployment, 'confirm_delivery'),
    '0',
  );
});

test('native money approvals always require one yocto, including tracked manual orders', () => {
  const d = { features: ['native-deposits-v1'] } as Deployment;
  for (const method of [
    'claim_native_excess',
    'acknowledge_native_refund',
    'cancel_unfunded_order',
  ]) {
    assert.equal(customerApprovalDeposit(d, method), '1');
    assert.equal(customerApprovalDeposit(d, method, { mode: 'manual', invoices: [] }), '1');
  }
  assert.equal(customerApprovalDeposit(d, 'top_up_order_storage'), '0');
  assert.equal(
    customerApprovalDeposit({ features: [] } as unknown as Deployment, 'claim_native_excess'),
    '0',
  );
});
