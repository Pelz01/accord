import { Worker } from 'near-workspaces';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareRuntime } from './runtime.mjs';

await prepareRuntime();
const wasm = (name) => fileURLToPath(new URL(`../.data/wasm/${name}.wasm`, import.meta.url));
const worker = await Worker.init();
const proof = {
  environment: 'local-near-sandbox',
  runtime: 'nearcore 2.14.0',
  at: new Date().toISOString(),
  legacySourceCommit: '763e771',
  wasmSha256: Object.fromEntries(
    await Promise.all(
      ['vault', 'token', 'vault-starved', 'vault-v1'].map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(wasm(name)))
          .digest('hex'),
      ]),
    ),
  ),
  checks: [],
  receipts: [],
};
function record(name) {
  proof.checks.push({ name, status: 'PASS' });
  console.log('PASS ' + name);
}
const gas = { gas: '150000000000000' };
try {
  const root = worker.rootAccount;
  const buyer = await root.createSubAccount('buyer'),
    supplier = await root.createSubAccount('supplier'),
    receiver = await root.createSubAccount('receiver'),
    operator = await root.createSubAccount('operator');
  const token = await root.devDeploy(wasm('token')),
    vault = await root.devDeploy(wasm('vault')),
    starved = await root.devDeploy(wasm('vault-starved')),
    legacy = await root.devDeploy(wasm('vault-v1'));
  await token.call(token, 'new', { owner_id: buyer.accountId, total_supply: '100000000000' });
  for (const v of [vault, starved, legacy])
    await v.call(v, 'new', { token: token.accountId, network: 'sandbox' });
  for (const a of [vault, starved, legacy, supplier])
    await buyer.call(
      token,
      'storage_deposit',
      { account_id: a.accountId, registration_only: true },
      { attachedDeposit: '100000000000000000000000' },
    );
  const terms = {
    supplier: supplier.accountId,
    receiver: receiver.accountId,
    operator: operator.accountId,
    payout: supplier.accountId,
    line_id: 'cartons',
    description: 'Refund verification cartons',
    unit: 'carton',
    ordered: '100',
    unit_price: '10000000',
    expires_at: '18446744073709551615',
  };
  const read = (v, id) => v.view('get_order', { order_id: id });
  const recovery = (v, id) => v.view('get_recovery', { order_id: id });
  const balance = (a) => token.view('ft_balance_of', { account_id: a.accountId });
  async function raw(caller, target, method, args, options = gas) {
    const result = await caller.callRaw(target, method, args, options);
    proof.receipts.push({
      method,
      transactionHash: result.transactionReceipt.hash,
      outcomes: result.result.receipts_outcome.map((r) => ({
        receiptId: r.id,
        executor: r.outcome.executor_id,
        status: r.outcome.status,
        gasBurnt: String(r.outcome.gas_burnt),
        logs: r.outcome.logs,
      })),
    });
    return result;
  }
  async function make(v, id, b = buyer) {
    await b.call(
      v,
      'create_order',
      { order_id: id, terms },
      { attachedDeposit: '1000000000000000000000000' },
    );
    await supplier.call(v, 'accept_order', {
      order_id: id,
      terms_hash: (await read(v, id)).terms_hash,
    });
    await b.call(
      token,
      'ft_transfer_call',
      { receiver_id: v.accountId, amount: '1000000000', msg: id },
      { ...gas, attachedDeposit: '1' },
    );
  }
  async function delivery(v, id, quantity = '40', sequence = '1') {
    await receiver.call(v, 'confirm_delivery', {
      order_id: id,
      sequence,
      cumulative_quantity: quantity,
      receipt_hash: 'a'.repeat(64),
    });
  }
  const pay = async (v, id, request_id, quantity = '40') => {
    const o = await read(v, id);
    const invoice = {
      order_id: id,
      terms_version: 1,
      terms_hash: o.terms_hash,
      document_hash: 'b'.repeat(64),
      reference: 'INV-' + id,
      line_id: o.terms.line_id,
      quantity: o.terms.ordered,
      token: token.accountId,
      amount: (BigInt(o.terms.ordered) * BigInt(o.terms.unit_price)).toString(),
    };
    if (v !== legacy) await supplier.call(v, 'confirm_invoice', { order_id: id, invoice });
    return raw(operator, v, 'request_payment', {
      order_id: id,
      request_id,
      quantity,
      audit_hash: 'b'.repeat(64),
      invoice,
    });
  };
  async function proposal(v, id, b = buyer) {
    await b.call(v, 'propose_close', { order_id: id });
    return (await recovery(v, id)).proposal;
  }
  async function approve(v, id, p) {
    return raw(supplier, v, 'accept_close', { order_id: id, proposal_hash: p.hash });
  }
  async function rejects(caller, v, method, args) {
    assert.equal((await caller.callRaw(v, method, args, gas)).failed, true, method + ' must fail');
  }

  await make(vault, 'partial');
  await delivery(vault, 'partial');
  await rejects(buyer, vault, 'propose_close', { order_id: 'partial' });
  record('closure rejects unpaid accepted deliveries');
  await pay(vault, 'partial', 'paid-40');
  let p = await proposal(vault, 'partial');
  await rejects(buyer, vault, 'accept_close', { order_id: 'partial', proposal_hash: p.hash });
  await rejects(operator, vault, 'accept_close', { order_id: 'partial', proposal_hash: p.hash });
  record('closure needs distinct buyer and supplier approvals');
  await delivery(vault, 'partial', '70', '2');
  await pay(vault, 'partial', 'paid-30', '30');
  await rejects(supplier, vault, 'accept_close', { order_id: 'partial', proposal_hash: p.hash });
  record('intervening delivery and payment invalidate closure snapshot');
  const buyerBefore = BigInt(await balance(buyer));
  const vaultBefore = BigInt(await balance(vault));
  p = await proposal(vault, 'partial');
  await approve(vault, 'partial', p);
  assert.equal(BigInt(await balance(buyer)) - buyerBefore, 300000000n);
  assert.equal(vaultBefore - BigInt(await balance(vault)), 300000000n);
  assert.equal((await recovery(vault, 'partial')).phase, 'Closed');
  assert.equal((await recovery(vault, 'partial')).refunded, '300000000');
  record('real partial-order refund returns exactly 300 aUSD to original buyer');
  await rejects(receiver, vault, 'confirm_delivery', {
    order_id: 'partial',
    sequence: '3',
    cumulative_quantity: '80',
    receipt_hash: 'a'.repeat(64),
  });
  await rejects(operator, vault, 'request_payment', {
    order_id: 'partial',
    request_id: 'after-close',
    quantity: '1',
    audit_hash: 'b'.repeat(64),
  });
  await rejects(buyer, vault, 'retry_refund', { order_id: 'partial' });
  await rejects(buyer, vault, 'on_refund_result', { order_id: 'partial', refund_id: 1 });
  await rejects(buyer, vault, 'accept_close', { order_id: 'partial', proposal_hash: p.hash });
  record('closed order blocks deliveries, payments, refund replay and public callback spoofing');

  const emptyBuyer = await root.createSubAccount('refundbuyer');
  await buyer.call(
    token,
    'storage_deposit',
    { account_id: emptyBuyer.accountId, registration_only: true },
    { attachedDeposit: '100000000000000000000000' },
  );
  await buyer.call(
    token,
    'ft_transfer',
    { receiver_id: emptyBuyer.accountId, amount: '1000000000' },
    { attachedDeposit: '1' },
  );
  await make(vault, 'failure', emptyBuyer);
  await emptyBuyer.call(token, 'storage_unregister', { force: false }, { attachedDeposit: '1' });
  p = await proposal(vault, 'failure', emptyBuyer);
  await approve(vault, 'failure', p);
  let r = await recovery(vault, 'failure');
  assert.equal(r.phase, 'RefundFailed');
  assert.equal(r.refund_pending, '0');
  assert.equal(r.refunded, '0');
  await rejects(operator, vault, 'retry_refund', { order_id: 'failure' });
  await rejects(receiver, vault, 'confirm_delivery', {
    order_id: 'failure',
    sequence: '1',
    cumulative_quantity: '1',
    receipt_hash: 'a'.repeat(64),
  });
  record('definite refund failure preserves obligation and freezes the order');
  await emptyBuyer.call(
    token,
    'storage_deposit',
    { account_id: emptyBuyer.accountId, registration_only: true },
    { attachedDeposit: '100000000000000000000000' },
  );
  await raw(emptyBuyer, vault, 'retry_refund', { order_id: 'failure' });
  assert.equal(await balance(emptyBuyer), '1000000000');
  r = await recovery(vault, 'failure');
  assert.equal(r.phase, 'Closed');
  assert.equal(r.refunds.length, 2);
  assert.equal(r.refunds[0].status, 'TransferFailed');
  assert.equal(r.refunds[1].status, 'Settled');
  record('buyer retries a definitively failed refund once recipient registration is repaired');

  await make(starved, 'uncertain');
  await delivery(starved, 'uncertain');
  const supplierBefore = BigInt(await balance(supplier));
  await pay(starved, 'uncertain', 'uncertain-payment');
  assert.equal(BigInt(await balance(supplier)) - supplierBefore, 400000000n);
  assert.equal((await read(starved, 'uncertain')).pending, '40');
  await rejects(buyer, starved, 'propose_close', { order_id: 'uncertain' });
  await rejects(operator, starved, 'acknowledge_payment', { request_id: 'uncertain-payment' });
  await raw(supplier, starved, 'acknowledge_payment', { request_id: 'uncertain-payment' });
  assert.deepEqual(
    [(await read(starved, 'uncertain')).paid, (await read(starved, 'uncertain')).pending],
    ['40', '0'],
  );
  assert.equal(
    (await starved.view('get_attempt', { request_id: 'uncertain-payment' })).status,
    'ReceiptAcknowledged',
  );
  await rejects(supplier, starved, 'acknowledge_payment', { request_id: 'uncertain-payment' });
  record(
    'payout recipient recovers a real successful payment with failed callback without sending tokens again',
  );
  const refundBefore = BigInt(await balance(buyer));
  p = await proposal(starved, 'uncertain');
  await approve(starved, 'uncertain', p);
  assert.equal(BigInt(await balance(buyer)) - refundBefore, 600000000n);
  r = await recovery(starved, 'uncertain');
  assert.equal(r.phase, 'RefundPending');
  assert.equal(r.refund_pending, '600000000');
  await rejects(buyer, starved, 'retry_refund', { order_id: 'uncertain' });
  await rejects(supplier, starved, 'acknowledge_refund', { order_id: 'uncertain', refund_id: 1 });
  await raw(buyer, starved, 'acknowledge_refund', { order_id: 'uncertain', refund_id: 1 });
  assert.equal((await recovery(starved, 'uncertain')).phase, 'Closed');
  assert.equal((await recovery(starved, 'uncertain')).refunds[0].status, 'ReceiptAcknowledged');
  await rejects(buyer, starved, 'acknowledge_refund', { order_id: 'uncertain', refund_id: 1 });
  record('real successful refund with starved callback stays reserved until buyer acknowledgment');

  await make(legacy, 'upgrade');
  await delivery(legacy, 'upgrade');
  await pay(legacy, 'upgrade', 'legacy-payment');
  const oldOrder = await read(legacy, 'upgrade');
  const oldAttempt = await legacy.view('get_attempt', { request_id: 'legacy-payment' });
  const oldBalance = await balance(legacy);
  await legacy.deploy(wasm('vault'));
  assert.deepEqual(await read(legacy, 'upgrade'), oldOrder);
  assert.deepEqual(await legacy.view('get_attempt', { request_id: 'legacy-payment' }), oldAttempt);
  assert.equal(await balance(legacy), oldBalance);
  assert.equal(await legacy.view('get_version', {}), '2.2.0-invoices');
  p = await proposal(legacy, 'upgrade');
  await approve(legacy, 'upgrade', p);
  assert.equal((await recovery(legacy, 'upgrade')).refunded, '600000000');
  record(
    'upgrade from initial deployed schema preserves funded orders and attempts and enables refunds',
  );
  assert.equal((await recovery(vault, 'partial')).refunded, '300000000');
  assert.equal((await read(vault, 'partial')).paid, '70');
  assert.equal((await recovery(vault, 'failure')).refunded, '1000000000');
  record('refund and recovery accounting remains isolated across orders and vaults');
} finally {
  await writeFile(
    new URL('../.data/recovery-sandbox-evidence.json', import.meta.url),
    JSON.stringify(proof, null, 2) + '\n',
  );
  await worker.tearDown();
}
