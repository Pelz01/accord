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
  at: new Date().toISOString(),
  environment: 'local-near-sandbox',
  runtime: 'nearcore 2.14.0',
  wasmSha256: {
    vault: createHash('sha256')
      .update(await readFile(wasm('vault')))
      .digest('hex'),
  },
  checks: [],
  receipts: [],
};
function record(name) {
  proof.checks.push({ name, status: 'PASS' });
  console.log('PASS ' + name);
}
try {
  const root = worker.rootAccount,
    buyer = await root.createSubAccount('buyer'),
    supplier = await root.createSubAccount('supplier'),
    receiver = await root.createSubAccount('receiver'),
    operator = await root.createSubAccount('operator');
  const token = await root.devDeploy(wasm('token')),
    vault = await root.devDeploy(wasm('vault'));
  await token.call(token, 'new', { owner_id: buyer.accountId, total_supply: '100000000000' });
  await vault.call(vault, 'new', { token: token.accountId, network: 'sandbox' });
  for (const a of [vault, supplier])
    await buyer.call(
      token,
      'storage_deposit',
      { account_id: a.accountId, registration_only: true },
      { attachedDeposit: '100000000000000000000000' },
    );
  const id = 'invoice-order',
    terms = {
      supplier: supplier.accountId,
      receiver: receiver.accountId,
      operator: operator.accountId,
      payout: supplier.accountId,
      line_id: 'cartons',
      description: 'Supplier-confirmed cartons',
      unit: 'carton',
      ordered: '100',
      unit_price: '10000000',
      expires_at: '18446744073709551615',
    };
  await buyer.call(
    vault,
    'create_order',
    { order_id: id, terms },
    { attachedDeposit: '1000000000000000000000000' },
  );
  const order = await vault.view('get_order', { order_id: id });
  await supplier.call(vault, 'accept_order', { order_id: id, terms_hash: order.terms_hash });
  await buyer.call(
    token,
    'ft_transfer_call',
    { receiver_id: vault.accountId, amount: '1000000000', msg: id },
    { gas: '150000000000000', attachedDeposit: '1' },
  );
  await receiver.call(vault, 'confirm_delivery', {
    order_id: id,
    sequence: '1',
    cumulative_quantity: '40',
    receipt_hash: 'a'.repeat(64),
  });
  const invoice = {
    order_id: id,
    terms_version: 1,
    terms_hash: order.terms_hash,
    document_hash: 'b'.repeat(64),
    reference: 'INV-SBX-001',
    line_id: 'cartons',
    quantity: '100',
    token: token.accountId,
    amount: '1000000000',
  };
  async function raw(caller, method, args) {
    const r = await caller.callRaw(vault, method, args, { gas: '150000000000000' });
    proof.receipts.push({
      method,
      transactionHash: r.transactionReceipt.hash,
      outcomes: r.result.receipts_outcome.map((x) => ({
        receiptId: x.id,
        executor: x.outcome.executor_id,
        status: x.outcome.status,
        logs: x.outcome.logs,
        gasBurnt: String(x.outcome.gas_burnt),
      })),
    });
    return r;
  }
  const payment = (request_id, payload, quantity = '1') =>
    raw(operator, 'request_payment', {
      order_id: id,
      request_id,
      quantity,
      audit_hash: payload?.document_hash ?? invoice.document_hash,
      invoice: payload,
    });
  assert.equal((await payment('legacy-bypass', null)).failed, true);
  record('payment without supplier confirmation is rejected');
  assert.equal((await raw(operator, 'confirm_invoice', { order_id: id, invoice })).failed, true);
  record('operator cannot confirm supplier invoices');
  await raw(supplier, 'confirm_invoice', { order_id: id, invoice });
  const [confirmation] = await vault.view('list_invoices', { order_id: id });
  const canonical = JSON.stringify([
    'accord-invoice-v1',
    'sandbox',
    vault.accountId,
    id,
    1,
    invoice.terms_hash,
    invoice.document_hash,
    invoice.reference,
    invoice.line_id,
    invoice.quantity,
    invoice.token,
    invoice.amount,
  ]);
  assert.equal(confirmation.commitment, createHash('sha256').update(canonical).digest('hex'));
  record('real contract commitment matches canonical TypeScript encoding');
  await raw(supplier, 'confirm_invoice', { order_id: id, invoice });
  assert.equal((await vault.view('list_invoices', { order_id: id })).length, 1);
  record('repeat supplier confirmation is idempotent');
  assert.equal(
    (await payment('tampered-reference', { ...invoice, reference: 'renamed' })).failed,
    true,
  );
  assert.equal(
    (await payment('tampered-document', { ...invoice, document_hash: 'c'.repeat(64) })).failed,
    true,
  );
  assert.equal(
    (await payment('tampered-order', { ...invoice, order_id: 'other-order' })).failed,
    true,
  );
  record('reference, document and order tampering cannot reuse a confirmation');
  const small = { ...invoice, reference: 'INV-SBX-SMALL', quantity: '20', amount: '200000000' };
  await raw(supplier, 'confirm_invoice', { order_id: id, invoice: small });
  assert.equal((await payment('excess-invoice', small, '30')).failed, true);
  record('payment quantity cannot exceed confirmed invoice quantity');
  await payment('confirmed-partial', invoice, '40');
  let state = await vault.view('get_order', { order_id: id });
  assert.deepEqual([state.paid, state.pending], ['40', '0']);
  assert.equal(await token.view('ft_balance_of', { account_id: supplier.accountId }), '400000000');
  record('supplier-confirmed invoice settles a real 400 aUSD partial payment');
  await receiver.call(vault, 'confirm_delivery', {
    order_id: id,
    sequence: '2',
    cumulative_quantity: '70',
    receipt_hash: 'd'.repeat(64),
  });
  await payment('confirmed-second', invoice, '30');
  state = await vault.view('get_order', { order_id: id });
  assert.deepEqual([state.paid, state.pending], ['70', '0']);
  record('confirmed invoice retains order-level incremental delivery limits');
  await buyer.call(vault, 'propose_close', { order_id: id });
  const r = await vault.view('get_recovery', { order_id: id });
  await raw(supplier, 'accept_close', { order_id: id, proposal_hash: r.proposal.hash });
  assert.equal(
    (
      await raw(supplier, 'confirm_invoice', {
        order_id: id,
        invoice: { ...invoice, reference: 'after-close' },
      })
    ).failed,
    true,
  );
  assert.equal((await payment('after-close', invoice)).failed, true);
  record('closed remainder disables confirmations and payments while preserving audit records');
} finally {
  await writeFile(
    new URL('../.data/invoice-sandbox-evidence.json', import.meta.url),
    JSON.stringify(proof, null, 2) + '\n',
  );
  await worker.tearDown();
}
