import { Worker } from 'near-workspaces';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareRuntime } from './runtime.mjs';
await prepareRuntime();
const wasm = (name) => fileURLToPath(new URL(`../.data/wasm/${name}.wasm`, import.meta.url));
const approval = (actor, contract, method, args) =>
  actor.call(contract, method, args, { attachedDeposit: '1' });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const worker = await Worker.init();
const proof = {
  at: new Date().toISOString(),
  environment: 'local-near-sandbox',
  runtime: 'nearcore 2.14.0',
  wasmSha256: {
    vault: hash(await readFile(wasm('vault'))),
    previous: hash(await readFile(wasm('vault-v2-invoices'))),
    starved: hash(await readFile(wasm('vault-starved'))),
  },
  checks: [],
  receipts: [],
};
function record(name) {
  proof.checks.push({ name, status: 'PASS' });
  console.log('PASS ' + name);
}
try {
  const root = worker.rootAccount;
  const buyer = await root.createSubAccount('buyer');
  const supplier = await root.createSubAccount('supplier');
  const receiver = await root.createSubAccount('receiver');
  const operator = await root.createSubAccount('operator');
  const unregistered = await root.createSubAccount('unregistered');
  const token = await root.devDeploy(wasm('token'));
  const vault = await root.devDeploy(wasm('vault-v2-invoices'));
  const starved = await root.devDeploy(wasm('vault-starved'));
  await token.call(token, 'new', { owner_id: buyer.accountId, total_supply: '100000000000' });
  for (const contract of [vault, starved])
    await contract.call(contract, 'new', { token: token.accountId, network: 'sandbox' });
  async function register(account) {
    await buyer.call(
      token,
      'storage_deposit',
      { account_id: account.accountId, registration_only: true },
      { attachedDeposit: '100000000000000000000000' },
    );
  }
  for (const account of [vault, starved, supplier]) await register(account);
  const terms = {
    supplier: supplier.accountId,
    receiver: receiver.accountId,
    operator: operator.accountId,
    payout: supplier.accountId,
    line_id: 'cartons',
    description: 'Coffee cartons',
    unit: 'carton',
    ordered: '10',
    unit_price: '10000000',
    expires_at: '18446744073709551615',
  };
  async function create(contract, id, extra = {}, automatic = true) {
    await buyer.call(
      contract,
      automatic ? 'create_automatic_order' : 'create_order',
      { order_id: id, terms: { ...terms, receiver: buyer.accountId, ...extra } },
      { attachedDeposit: '1000000000000000000000000' },
    );
    const order = await contract.view('get_order', { order_id: id });
    await supplier.call(
      contract,
      'accept_order',
      { order_id: id, terms_hash: order.terms_hash },
      { attachedDeposit: automatic ? '1' : '0' },
    );
    await buyer.call(
      token,
      'ft_transfer_call',
      { receiver_id: contract.accountId, amount: '100000000', msg: id },
      { attachedDeposit: '1', gas: '150000000000000' },
    );
    return order;
  }
  // A funded 2.2.0 order keeps its exact terms, balances and manual payment policy.
  await buyer.call(
    vault,
    'create_order',
    { order_id: 'legacy', terms },
    { attachedDeposit: '1000000000000000000000000' },
  );
  const legacy = await vault.view('get_order', { order_id: 'legacy' });
  await supplier.call(vault, 'accept_order', { order_id: 'legacy', terms_hash: legacy.terms_hash });
  await buyer.call(
    token,
    'ft_transfer_call',
    { receiver_id: vault.accountId, amount: '100000000', msg: 'legacy' },
    { attachedDeposit: '1', gas: '150000000000000' },
  );
  const before = await vault.view('get_order', { order_id: 'legacy' });
  const balance = await token.view('ft_balance_of', { account_id: vault.accountId });
  await vault.deploy(wasm('vault'));
  assert.equal(await vault.view('get_version', {}), '2.3.1-security');
  assert.deepEqual(await vault.view('get_order', { order_id: 'legacy' }), before);
  assert.equal(await token.view('ft_balance_of', { account_id: vault.accountId }), balance);
  assert.equal((await vault.view('get_payment_policy', { order_id: 'legacy' })).mode, 'manual');
  record('upgrade preserves funded 2.2.0 order, token balance and manual execution policy');
  const o = await create(vault, 'automatic');
  assert.equal(o.terms.receiver, buyer.accountId);
  assert.equal((await vault.view('get_payment_policy', { order_id: o.id })).mode, 'automatic');
  await approval(buyer, vault, 'confirm_delivery', {
    order_id: o.id,
    sequence: '1',
    cumulative_quantity: '4',
    receipt_hash: 'a'.repeat(64),
  });
  record('buyer creates, funds and confirms delivery using the same account');
  async function invoice(contract, order, quantity, reference) {
    const payload = {
      order_id: order.id,
      terms_version: 1,
      terms_hash: order.terms_hash,
      document_hash: hash(reference),
      reference,
      line_id: 'cartons',
      quantity,
      token: token.accountId,
      amount: (BigInt(quantity) * 10000000n).toString(),
    };
    await approval(supplier, contract, 'confirm_invoice', { order_id: order.id, invoice: payload });
    return payload;
  }
  async function payment(contract, order, payload, id, quantity, caller = operator) {
    const result = await caller.callRaw(
      contract,
      'request_payment',
      {
        order_id: order.id,
        request_id: id,
        quantity,
        invoice: payload,
        audit_hash: payload.document_hash,
      },
      { gas: '150000000000000' },
    );
    proof.receipts.push({
      method: 'request_payment',
      requestId: id,
      transactionHash: result.transactionReceipt.hash,
      outcomes: result.result.receipts_outcome.map((x) => ({
        receiptId: x.id,
        executor: x.outcome.executor_id,
        status: x.outcome.status,
        logs: x.outcome.logs,
      })),
    });
    return result;
  }
  const i = await invoice(vault, o, '4', 'INV-AUTO-4');
  assert.equal((await payment(vault, o, i, 'buyer-cannot-dispatch', '4', buyer)).failed, true);
  assert.equal((await payment(vault, o, i, 'service-dispatch', '4')).failed, false);
  assert.equal((await vault.view('get_order', { order_id: o.id })).paid, '4');
  assert.equal(await token.view('ft_balance_of', { account_id: supplier.accountId }), '40000000');
  record(
    'restricted payment responsibility stays separate while the fixed supplier receives 40 aUSD',
  );
  await approval(buyer, vault, 'confirm_delivery', {
    order_id: o.id,
    sequence: '2',
    cumulative_quantity: '6',
    receipt_hash: 'c'.repeat(64),
  });
  assert.equal((await payment(vault, o, i, 'cannot-reuse-invoice', '2')).failed, true);
  assert.equal(
    (await vault.view('get_payment_policy', { order_id: o.id })).invoices[0].available,
    '0',
  );
  const next = await invoice(vault, o, '2', 'INV-AUTO-2');
  assert.equal((await payment(vault, o, next, 'second-invoice', '2')).failed, false);
  assert.deepEqual(
    [
      (await vault.view('get_order', { order_id: o.id })).paid,
      (await vault.view('get_order', { order_id: o.id })).pending,
    ],
    ['6', '0'],
  );
  record(
    'a paid invoice cannot pay a later delivery; a fresh confirmed invoice pays only the new quantity',
  );
  const delegated = await create(vault, 'delegated', { receiver: receiver.accountId });
  const delivery = {
    order_id: delegated.id,
    sequence: '1',
    cumulative_quantity: '4',
    receipt_hash: 'd'.repeat(64),
  };
  assert.equal(
    (await buyer.callRaw(vault, 'confirm_delivery', delivery, { attachedDeposit: '1' })).failed,
    true,
  );
  await approval(receiver, vault, 'confirm_delivery', delivery);
  record('optional delegated receiving authorizes only the appointed warehouse account');
  const failed = await create(vault, 'failed', { payout: unregistered.accountId });
  await approval(buyer, vault, 'confirm_delivery', { ...delivery, order_id: failed.id });
  const failedInvoice = await invoice(vault, failed, '4', 'INV-RETRY');
  await payment(vault, failed, failedInvoice, 'unregistered-recipient', '4');
  assert.equal(
    (await vault.view('get_attempt', { request_id: 'unregistered-recipient' })).status,
    'TransferFailed',
  );
  assert.equal(
    (await vault.view('get_payment_policy', { order_id: failed.id })).invoices[0].available,
    '4',
  );
  await register(unregistered);
  await payment(vault, failed, failedInvoice, 'repaired-recipient', '4');
  assert.equal((await vault.view('get_order', { order_id: failed.id })).paid, '4');
  record('definitive token failure releases invoice capacity; repaired transfer settles once');
  const uncertain = await create(starved, 'uncertain');
  await approval(buyer, starved, 'confirm_delivery', { ...delivery, order_id: uncertain.id });
  const uncertainInvoice = await invoice(starved, uncertain, '4', 'INV-UNCERTAIN');
  await payment(starved, uncertain, uncertainInvoice, 'starved-result', '4');
  assert.equal((await starved.view('get_order', { order_id: uncertain.id })).pending, '4');
  assert.equal(
    (await starved.view('get_payment_policy', { order_id: uncertain.id })).invoices[0].available,
    '0',
  );
  record('successful transfer with a failed callback retains both order and invoice reservations');
  await approval(supplier, starved, 'acknowledge_payment', { request_id: 'starved-result' });
  assert.equal((await starved.view('get_order', { order_id: uncertain.id })).paid, '4');
  assert.equal(
    (await starved.view('get_payment_policy', { order_id: uncertain.id })).invoices[0].available,
    '0',
  );
  record('recipient acknowledgment finalizes payment without making the invoice spendable again');
} finally {
  await writeFile(
    new URL('../.data/automatic-sandbox-evidence.json', import.meta.url),
    JSON.stringify(proof, null, 2) + '\n',
  );
  await worker.tearDown();
}
