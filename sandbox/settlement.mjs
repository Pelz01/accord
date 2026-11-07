import { Worker } from 'near-workspaces';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareRuntime } from './runtime.mjs';

// Runs a real local NEAR node, independent of the web preview's simulation.
const wasm = (name) => fileURLToPath(new URL(`../.data/wasm/${name}.wasm`, import.meta.url));
await prepareRuntime();
const worker = await Worker.init();
const evidence = {
  environment: 'local-near-sandbox',
  runtime: 'nearcore 2.14.0',
  at: new Date().toISOString(),
  wasmSha256: Object.fromEntries(
    await Promise.all(
      ['vault', 'token', 'vault-starved'].map(async (name) => [
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
const record = (name, detail = {}) => {
  evidence.checks.push({ name, status: 'PASS', ...detail });
  console.log(`PASS ${name}`);
};
try {
  const root = worker.rootAccount;
  const buyer = await root.createSubAccount('buyer'),
    supplier = await root.createSubAccount('supplier'),
    receiver = await root.createSubAccount('receiver'),
    operator = await root.createSubAccount('operator'),
    unregistered = await root.createSubAccount('unregistered');
  const token = await root.devDeploy(wasm('token'));
  const vault = await root.devDeploy(wasm('vault'));
  const starved = await root.devDeploy(wasm('vault-starved'));
  await token.call(token, 'new', { owner_id: buyer.accountId, total_supply: '100000000000' });
  for (const contract of [vault, starved])
    await contract.call(contract, 'new', { token: token.accountId, network: 'sandbox' });
  for (const account of [vault, starved, supplier])
    await buyer.call(
      token,
      'storage_deposit',
      { account_id: account.accountId, registration_only: true },
      { attachedDeposit: '100000000000000000000000' },
    );
  const base = {
    supplier: supplier.accountId,
    receiver: receiver.accountId,
    operator: operator.accountId,
    payout: supplier.accountId,
    line_id: 'cartons',
    description: 'Fictitious packing cartons',
    unit: 'carton',
    ordered: '100',
    unit_price: '10000000',
    expires_at: '18446744073709551615',
  };
  async function makeOrder(contract, id, changes = {}) {
    await buyer.call(
      contract,
      'create_order',
      { order_id: id, terms: { ...base, ...changes } },
      { attachedDeposit: '1000000000000000000000000' },
    );
    const order = await contract.view('get_order', { order_id: id });
    await supplier.call(contract, 'accept_order', { order_id: id, terms_hash: order.terms_hash });
    return order;
  }
  async function fund(contract, id, amount = '1000000000') {
    return buyer.callRaw(
      token,
      'ft_transfer_call',
      { receiver_id: contract.accountId, amount, msg: id },
      { attachedDeposit: '1', gas: '150000000000000' },
    );
  }
  async function receive(contract, id, total = '40', seq = '1') {
    await receiver.call(contract, 'confirm_delivery', {
      order_id: id,
      sequence: seq,
      cumulative_quantity: total,
      receipt_hash: 'a'.repeat(64),
    });
  }
  async function pay(contract, id, requestId, quantity = '40') {
    const result = await operator.callRaw(
      contract,
      'request_payment',
      { order_id: id, request_id: requestId, quantity, audit_hash: 'b'.repeat(64) },
      { gas: '150000000000000' },
    );
    evidence.receipts.push({
      label: requestId,
      transactionHash: result.transactionReceipt.hash,
      totalGasBurnt: result.gas_burnt,
      outcomes: result.result.receipts_outcome.map((receipt) => ({
        receiptId: receipt.id,
        executor: receipt.outcome.executor_id,
        gasBurnt: String(receipt.outcome.gas_burnt),
        status: receipt.outcome.status,
        logs: receipt.outcome.logs,
      })),
      receiptFailures: result.receiptFailures,
    });
    return result;
  }
  const balance = (account) => token.view('ft_balance_of', { account_id: account.accountId });
  const read = (contract, id) => contract.view('get_order', { order_id: id });
  await makeOrder(vault, 'partial');
  const before = await balance(buyer);
  await fund(vault, 'partial', '1000000001');
  assert.equal(await balance(buyer), before);
  assert.equal((await read(vault, 'partial')).funded, '0');
  record('excess funding returned through standard resolver');
  await fund(vault, 'partial');
  await receive(vault, 'partial');
  await pay(vault, 'partial', 'partial-1');
  assert.equal(await balance(supplier), '400000000');
  let order = await read(vault, 'partial');
  assert.deepEqual([order.paid, order.pending], ['40', '0']);
  record('real standard-token partial transfer and callback', {
    supplierBalance: await balance(supplier),
  });
  const replay = await pay(vault, 'partial', 'partial-1', '1');
  assert.equal(replay.failed, true);
  record('request replay blocked');
  const external = await buyer.callRaw(vault, 'on_payment_result', { request_id: 'partial-1' });
  assert.equal(external.failed, true);
  record('external callback invocation blocked');
  const invalid = await operator.callRaw(vault, 'confirm_delivery', {
    order_id: 'partial',
    sequence: '2',
    cumulative_quantity: '70',
    receipt_hash: 'a'.repeat(64),
  });
  assert.equal(invalid.failed, true);
  record('operator cannot authorize delivery');
  await receive(vault, 'partial', '70', '2');
  await pay(vault, 'partial', 'partial-2', '30');
  assert.equal(await balance(supplier), '700000000');
  record('second delivery unlocks only incremental 30 cartons');
  await makeOrder(vault, 'failed', { payout: unregistered.accountId });
  await fund(vault, 'failed');
  await receive(vault, 'failed');
  await pay(vault, 'failed', 'transfer-fails');
  order = await read(vault, 'failed');
  assert.deepEqual([order.paid, order.pending], ['0', '0']);
  assert.equal(
    (await vault.view('get_attempt', { request_id: 'transfer-fails' })).status,
    'TransferFailed',
  );
  record('external standard-token panic reaches callback and releases reservation');
  await makeOrder(starved, 'starved');
  await fund(starved, 'starved');
  await receive(starved, 'starved');
  const supplierBefore = BigInt(await balance(supplier));
  const result = await pay(starved, 'starved', 'callback-starved');
  assert.equal(BigInt(await balance(supplier)) - supplierBefore, 400000000n);
  assert.ok(result.receiptFailures.length > 0);
  order = await read(starved, 'starved');
  assert.deepEqual([order.paid, order.pending], ['0', '40']);
  const overlap = await pay(starved, 'starved', 'overlap', '1');
  assert.equal(overlap.failed, true);
  record('real transfer succeeds, starved callback fails, reservation remains locked', {
    supplierIncrement: '400000000',
    paid: order.paid,
    pending: order.pending,
  });
  const unaffected = await read(vault, 'partial');
  assert.deepEqual([unaffected.paid, unaffected.pending], ['70', '0']);
  record('cross-order counters remain isolated');
} finally {
  await mkdir(new URL('../.data/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../.data/sandbox-evidence.json', import.meta.url),
    JSON.stringify(evidence, null, 2),
  );
  await worker.tearDown();
}
