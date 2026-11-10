import { Worker } from 'near-workspaces';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareRuntime } from './runtime.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Disposable node only. This file never connects to a funded public account.
await prepareRuntime();
const worker = await Worker.init();
const wasm = (name) => fileURLToPath(new URL(`../.data/wasm/${name}.wasm`, import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const vaultBytes = await readFile(wasm('vault'));
assert.equal(hash(vaultBytes), '2eb011ff5989660c2ce6939ad8bd616e77ca9d7df3fd10d87e0aa9980ac74f04');
const NEAR = 10n ** 24n;
const options = { gas: '150000000000000' };
const approval = { ...options, attachedDeposit: '1' };
const report = {
  at: new Date().toISOString(),
  environment: 'disposable-near-sandbox',
  runtime: 'nearcore 2.14.0',
  artifact: { bytes: vaultBytes.length, sha256: hash(vaultBytes) },
  completed: false,
  measurements: [],
  transactions: [],
  checks: [],
  limitations: [
    'Sandbox measurements are not mainnet transaction quotes or an exhaustive state-space proof.',
    'Outcome tokens_burnt is reported separately from deposits and contract gas rewards.',
    'A 25% comparison margin is an analysis assumption, not a newly approved order deposit.',
    'The retirement guard is an offchain test helper. The deployed vault has no atomic pause, customer cleanup or native-deposit refund API.',
    'Disposable full-access-key teardown does not establish a safe production shutdown or depositor allocation policy.',
  ],
};
const pass = (name) => {
  report.checks.push({ name, status: 'PASS' });
  console.log('PASS ' + name);
};
const native = (amount) => {
  const value = BigInt(amount),
    fraction = (value % NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return (value / NEAR).toString() + (fraction ? '.' + fraction : '');
};
let rate;
async function view(account) {
  return worker.provider.viewAccount(account.accountId, { finality: 'final' });
}
async function state(account) {
  const target = (await worker.provider.block({ finality: 'optimistic' })).header.height;
  const started = Date.now();
  while ((await worker.provider.block({ finality: 'final' })).header.height < target) {
    assert(
      Date.now() - started < 20000,
      'Sandbox finality did not catch the completed transaction',
    );
    await delay(200);
  }
  const s = await view(account);
  return { storageBytes: s.storage_usage, amountYocto: s.amount, codeHash: s.code_hash };
}
function fees(label, result) {
  const outcomes = result.outcomesWithId;
  const burned = outcomes.reduce((sum, o) => sum + BigInt(o.outcome.tokens_burnt), 0n);
  const gas = outcomes.reduce((sum, o) => sum + BigInt(o.outcome.gas_burnt), 0n);
  report.transactions.push({
    label,
    hash: result.transactionReceipt.hash,
    gasBurnt: gas.toString(),
    outcomeTokensBurntYocto: burned.toString(),
    outcomeTokensBurntNear: native(burned),
    succeeded: result.succeeded,
    receiptFailures: result.receiptFailureMessages,
  });
}
async function call(
  actor,
  target,
  method,
  args,
  opts = options,
  { expectReceiptFailure = false } = {},
) {
  const r = await actor.callRaw(target, method, args, opts);
  fees(method, r);
  if (!expectReceiptFailure) {
    assert(r.succeeded, method + ': ' + JSON.stringify(r.status));
    assert.equal(r.receiptFailures.length, 0, method + ': failed receipt');
  } else {
    assert(r.receiptFailures.length > 0, method + ': expected a deliberate receipt failure');
  }
  return r;
}
async function measure(label, account, action) {
  const before = await state(account);
  const result = await action();
  const after = await state(account);
  const delta = after.storageBytes - before.storageBytes;
  report.measurements.push({
    label,
    before,
    after,
    storageDeltaBytes: delta,
    backingDeltaYocto: (BigInt(delta) * rate).toString(),
    backingDeltaNear: native(BigInt(Math.abs(delta)) * rate) + (delta < 0 ? ' released' : ''),
  });
  return result;
}
async function register(buyer, token, account) {
  return call(
    buyer,
    token,
    'storage_deposit',
    { account_id: account.accountId, registration_only: true },
    { ...options, attachedDeposit: '1250000000000000000000' },
  );
}
const tokenBalance = (token, account) =>
  token.view('ft_balance_of', { account_id: account.accountId });
async function invoiceFor(vault, token, id, quantity, reference) {
  const order = await vault.view('get_order', { order_id: id });
  return {
    order_id: id,
    terms_version: 1,
    terms_hash: order.terms_hash,
    document_hash: 'b'.repeat(64),
    reference,
    line_id: order.terms.line_id,
    quantity: String(quantity),
    token: token.accountId,
    amount: (BigInt(quantity) * BigInt(order.terms.unit_price)).toString(),
  };
}
async function accept(supplier, vault, id) {
  const order = await vault.view('get_order', { order_id: id });
  return call(
    supplier,
    vault,
    'accept_order',
    { order_id: id, terms_hash: order.terms_hash },
    approval,
  );
}
const fund = (buyer, token, vault, id, amount) =>
  call(
    buyer,
    token,
    'ft_transfer_call',
    { receiver_id: vault.accountId, amount: String(amount), msg: id },
    approval,
  );
const deliver = (buyer, vault, id, quantity, sequence) =>
  call(
    buyer,
    vault,
    'confirm_delivery',
    {
      order_id: id,
      sequence: String(sequence),
      cumulative_quantity: String(quantity),
      receipt_hash: 'a'.repeat(64),
    },
    approval,
  );
const confirm = (supplier, vault, invoice) =>
  call(supplier, vault, 'confirm_invoice', { order_id: invoice.order_id, invoice }, approval);
const pay = (operator, vault, invoice, request_id, quantity, expectReceiptFailure = false) =>
  call(
    operator,
    vault,
    'request_payment',
    {
      order_id: invoice.order_id,
      request_id,
      quantity: String(quantity),
      audit_hash: invoice.document_hash,
      invoice,
    },
    options,
    { expectReceiptFailure },
  );
async function close(buyer, supplier, vault, id, expectReceiptFailure = false) {
  await call(buyer, vault, 'propose_close', { order_id: id }, approval);
  const r = await vault.view('get_recovery', { order_id: id });
  return call(
    supplier,
    vault,
    'accept_close',
    { order_id: id, proposal_hash: r.proposal.hash },
    approval,
    { expectReceiptFailure },
  );
}
async function assertRetirable(vault, token) {
  const orders = [];
  for (let start = 0; ; start += 50) {
    const page = await vault.view('list_orders', { from_index: start, limit: 50 });
    orders.push(...page);
    if (page.length < 50) break;
  }
  for (const order of orders) {
    const r = await vault.view('get_recovery', { order_id: order.id });
    assert.equal(order.pending, '0', 'Unresolved payment');
    assert.equal(r.refund_pending, '0', 'Unresolved refund');
    assert.equal(order.paid, order.accepted, 'Unpaid accepted goods');
    assert.equal(r.phase, 'Closed', 'Order still open');
    assert.equal(
      BigInt(order.funded),
      BigInt(order.paid) * BigInt(order.terms.unit_price) + BigInt(r.refunded),
      'Unreturned order funding',
    );
  }
  assert.equal(await tokenBalance(token, vault), '0', 'Supplier tokens still held');
}
try {
  const protocol = await worker.provider.sendJsonRpc('EXPERIMENTAL_protocol_config', {
    finality: 'final',
  });
  rate = BigInt(protocol.runtime_config.storage_amount_per_byte);
  assert.equal(rate, 10n ** 19n);
  report.storageAmountPerByteYocto = rate.toString();
  const root = worker.rootAccount;
  const buyer = await root.createSubAccount('buyer'),
    supplier = await root.createSubAccount('supplier'),
    operator = await root.createSubAccount('operator'),
    beneficiary = await root.createSubAccount('beneficiary');
  const token = await root.devDeploy(wasm('token'));
  const vault = await root.devCreateAccount();
  await measure('deploy_code', vault, async () => {
    const r = await vault.deploy(vaultBytes);
    fees('deploy_code', r);
    assert(r.succeeded);
  });
  await measure('initialize_vault', vault, () =>
    call(vault, vault, 'new', { token: token.accountId, network: 'sandbox' }),
  );
  await call(token, token, 'new', { owner_id: buyer.accountId, total_supply: '1000000000000' });
  for (const account of [vault, supplier]) await register(buyer, token, account);
  const base = {
    supplier: supplier.accountId,
    receiver: buyer.accountId,
    operator: operator.accountId,
    payout: supplier.accountId,
    line_id: 'cartons',
    description: 'Coffee cartons',
    unit: 'carton',
    ordered: '10',
    unit_price: '1000000',
    expires_at: '18446744073709551615',
  };
  const id = 'COST-STANDARD';
  const standardStart = await state(vault);
  await measure('standard_create_order', vault, () =>
    call(
      buyer,
      vault,
      'create_automatic_order',
      { order_id: id, terms: base },
      { ...options, attachedDeposit: NEAR.toString() },
    ),
  );
  await measure('standard_supplier_acceptance', vault, () => accept(supplier, vault, id));
  await measure('standard_funding', vault, () => fund(buyer, token, vault, id, 10000000));
  await assert.rejects(() => assertRetirable(vault, token), /Order still open/);
  await measure('standard_first_delivery', vault, () => deliver(buyer, vault, id, 4, 1));
  const inv1 = await invoiceFor(vault, token, id, 4, 'COST-INV-1');
  await measure('standard_first_invoice', vault, () => confirm(supplier, vault, inv1));
  await measure('standard_first_payment', vault, () =>
    pay(operator, vault, inv1, 'cost-payment-1', 4),
  );
  await measure('standard_second_delivery', vault, () => deliver(buyer, vault, id, 6, 2));
  const inv2 = await invoiceFor(vault, token, id, 2, 'COST-INV-2');
  await measure('standard_second_invoice', vault, () => confirm(supplier, vault, inv2));
  await measure('standard_second_payment', vault, () =>
    pay(operator, vault, inv2, 'cost-payment-2', 2),
  );
  const buyerTokensBefore = BigInt(await tokenBalance(token, buyer));
  const buyerNativeBefore = BigInt((await state(buyer)).amountYocto);
  await measure('standard_mutual_close', vault, () => close(buyer, supplier, vault, id));
  assert.equal(BigInt(await tokenBalance(token, buyer)) - buyerTokensBefore, 4000000n);
  assert(
    BigInt((await state(buyer)).amountYocto) < buyerNativeBefore,
    'Closure must not refund the native order deposit',
  );
  const standardEnd = await state(vault);
  report.standard = {
    incrementalStorageBytes: standardEnd.storageBytes - standardStart.storageBytes,
    backingNear: native(BigInt(standardEnd.storageBytes - standardStart.storageBytes) * rate),
    buyerNativeDepositYocto: NEAR.toString(),
    refundedSettlementTokenUnits: '4000000',
    nativeDepositRefunded: false,
  };
  assert(standardEnd.storageBytes > standardStart.storageBytes);
  assert(
    report.measurements
      .filter((row) => row.label.startsWith('standard_') && row.label.endsWith('_delivery'))
      .every((row) => row.storageDeltaBytes === 0),
    'Delivery updates unexpectedly grew stored history',
  );
  pass(
    'Delivery updates do not create history records; invoices, attempts and recovery increase storage.',
  );
  pass(
    'Closing returns four settlement tokens but retains order state and does not refund the native deposit.',
  );

  const extra = 'COST-EXCESS';
  const beforeExtra = await state(vault),
    buyerBeforeExtra = BigInt((await state(buyer)).amountYocto);
  await measure('excess_deposit_create', vault, () =>
    call(
      buyer,
      vault,
      'create_automatic_order',
      { order_id: extra, terms: base },
      { ...options, attachedDeposit: ((NEAR * 5n) / 4n).toString() },
    ),
  );
  const afterExtra = await state(vault);
  assert(BigInt(afterExtra.amountYocto) - BigInt(beforeExtra.amountYocto) >= (NEAR * 5n) / 4n);
  assert(buyerBeforeExtra - BigInt((await state(buyer)).amountYocto) >= (NEAR * 5n) / 4n);
  await accept(supplier, vault, extra);
  await fund(buyer, token, vault, extra, 10000000);
  await close(buyer, supplier, vault, extra);
  report.excessDeposit = {
    attachedNear: '1.25',
    minimumNear: '1',
    excessNear: '0.25',
    excessReturned: false,
    nativeRetainedIncreaseYocto: (
      BigInt(afterExtra.amountYocto) - BigInt(beforeExtra.amountYocto)
    ).toString(),
    note: 'Vault increase includes a small gas reward; no native depositor ledger exists.',
  };
  pass('A 1.25-NEAR creation deposit keeps the extra 0.25 NEAR instead of returning it.');

  const longAccount = (name) => root.createSubAccount(name.padEnd(63 - root.accountId.length, 'x'));
  const lb = await longAccount('buyer'),
    ls = await longAccount('supplier'),
    lo = await longAccount('operator'),
    lt = await longAccount('token'),
    lv = await longAccount('vault');
  for (const a of [lb, ls, lo, lt, lv]) assert.equal(a.accountId.length, 64);
  await lt.deploy(wasm('token'));
  await lv.deploy(vaultBytes);
  await call(lt, lt, 'new', { owner_id: lb.accountId, total_supply: '1000000000000' });
  await call(lv, lv, 'new', { token: lt.accountId, network: 'sandbox' });
  for (const a of [lv, ls]) await register(lb, lt, a);
  const maxId = 'M'.repeat(64);
  const maxStart = await state(lv);
  await measure('max_fields_create', lv, () =>
    call(
      lb,
      lv,
      'create_automatic_order',
      {
        order_id: maxId,
        terms: {
          ...base,
          supplier: ls.accountId,
          receiver: lb.accountId,
          operator: lo.accountId,
          payout: ls.accountId,
          line_id: 'l'.repeat(64),
          description: 'd'.repeat(160),
          unit: 'u'.repeat(32),
          ordered: '65',
        },
      },
      { ...options, attachedDeposit: NEAR.toString() },
    ),
  );
  await accept(ls, lv, maxId);
  await fund(lb, lt, lv, maxId, 65000000);
  await measure('max_fields_delivery', lv, () => deliver(lb, lv, maxId, 64, 1));
  const invoices = [];
  await measure('max_fields_32_invoices', lv, async () => {
    for (let i = 0; i < 32; i++) {
      const invoice = await invoiceFor(lv, lt, maxId, 2, ('INV-' + i + '-').padEnd(80, 'r'));
      await confirm(ls, lv, invoice);
      invoices.push(invoice);
    }
  });
  await measure('max_fields_64_payments', lv, async () => {
    for (let i = 0; i < 64; i++) {
      await pay(lo, lv, invoices[Math.floor(i / 2)], ('payment-' + i + '-').padEnd(64, 'p'), 1);
      if (i % 16 === 15) console.log(`Measured ${i + 1}/64 payment attempts`);
    }
  });
  assert.equal((await lv.view('get_order', { order_id: maxId })).paid, '64');
  // Force seven further definite refund failures, then restore registration and settle.
  const remainder = await tokenBalance(lt, lb);
  await call(lb, lt, 'ft_transfer', { receiver_id: ls.accountId, amount: remainder }, approval);
  await call(lb, lt, 'storage_unregister', { force: false }, approval);
  await measure('max_fields_eight_failed_refunds', lv, async () => {
    await close(lb, ls, lv, maxId, true);
    for (let i = 0; i < 7; i++)
      await call(lb, lv, 'retry_refund', { order_id: maxId }, approval, {
        expectReceiptFailure: true,
      });
  });
  assert.equal((await lv.view('get_recovery', { order_id: maxId })).refunds.length, 8);
  await register(ls, lt, lb);
  await measure('max_fields_ninth_refund_settles', lv, () =>
    call(lb, lv, 'retry_refund', { order_id: maxId }, approval),
  );
  const maxRecovery = await lv.view('get_recovery', { order_id: maxId });
  assert.equal(maxRecovery.refunds.length, 8);
  assert.equal(maxRecovery.phase, 'Closed');
  assert.equal(await tokenBalance(lt, lv), '0');
  const maxEnd = await state(lv),
    maxDelta = maxEnd.storageBytes - maxStart.storageBytes;
  const lifetime = BigInt(maxDelta) * rate;
  const margin = (lifetime + 3n) / 4n;
  report.maxObserved = {
    incrementalStorageBytes: maxDelta,
    backingNear: native(lifetime),
    assumedSafetyMarginPercent: 25,
    assumedSafetyMarginNear: native(margin),
    backingPlusMarginNear: native(lifetime + margin),
    headroomWithinOneNear: native(NEAR - lifetime - margin),
    fields:
      '64-byte accounts/order/line/request IDs; 160-byte description; 32-byte unit; 80-byte references',
    invoices: 32,
    paymentAttempts: 64,
    retainedRefundAttempts: 8,
    refundAttemptsExecuted: 9,
    note: 'Observed bound exercise, not an exhaustive proof of all failure interleavings or a new deposit policy.',
  };
  assert(
    lifetime + margin < NEAR,
    'Measured storage plus comparison margin exceeds the existing deposit',
  );
  pass(
    'Maximum-sized fields, 32 invoices, 64 payment records and eight retained refund records fit within the current deposit with a 25% comparison margin.',
  );

  const starved = await root.devDeploy(wasm('vault-starved'));
  await call(starved, starved, 'new', { token: token.accountId, network: 'sandbox' });
  await register(buyer, token, starved);
  await call(
    buyer,
    starved,
    'create_automatic_order',
    { order_id: 'UNCERTAIN', terms: base },
    { ...options, attachedDeposit: NEAR.toString() },
  );
  await accept(supplier, starved, 'UNCERTAIN');
  await fund(buyer, token, starved, 'UNCERTAIN', 10000000);
  await deliver(buyer, starved, 'UNCERTAIN', 4, 1);
  const uncertainInvoice = await invoiceFor(starved, token, 'UNCERTAIN', 4, 'UNCERTAIN-INV');
  await confirm(supplier, starved, uncertainInvoice);
  await pay(operator, starved, uncertainInvoice, 'uncertain-payment', 4, true);
  assert.equal((await starved.view('get_order', { order_id: 'UNCERTAIN' })).pending, '4');
  await assert.rejects(() => assertRetirable(starved, token), /Unresolved payment/);
  pass('Retirement test guard rejects an open order and a real transfer with a failed callback.');

  await assertRetirable(vault, token);
  const beforeRemoval = await state(vault);
  await measure('disposable_remove_code', vault, async () => {
    const r = await vault.deploy(Buffer.alloc(0));
    fees('disposable_remove_code', r);
    assert(r.succeeded);
  });
  const afterRemoval = await state(vault);
  assert.equal(beforeRemoval.storageBytes - afterRemoval.storageBytes, vaultBytes.length);
  assert.notEqual(afterRemoval.codeHash, beforeRemoval.codeHash);
  assert.equal((await vault.viewCode()).length, 0);
  // Code is now absent, so all new customer calls are blocked on this isolated account.
  const blocked = await buyer.callRaw(
    vault,
    'create_automatic_order',
    { order_id: 'AFTER-RETIRE', terms: base },
    { ...options, attachedDeposit: NEAR.toString() },
  );
  fees('retired_create_rejected', blocked);
  assert(blocked.failed);
  const beneficiaryBefore = BigInt((await state(beneficiary)).amountYocto);
  const beforeDelete = await state(vault);
  const deletion = await vault.delete(beneficiary.accountId);
  fees('disposable_delete_account', deletion);
  assert(deletion.succeeded);
  await worker.provider.fastForward(3);
  assert.equal(await vault.exists(), false);
  const received = BigInt((await state(beneficiary)).amountYocto) - beneficiaryBefore;
  assert(received > BigInt(beforeDelete.amountYocto) - NEAR / 100n);
  assert(received <= BigInt(beforeDelete.amountYocto));
  report.disposableRetirement = {
    conditions:
      'All orders Closed, accepted goods paid, pending/refund-pending zero, token funding reconciled and vault token balance zero; all actors controlled by this isolated harness.',
    storageBytesReleasedByCodeRemoval: beforeRemoval.storageBytes - afterRemoval.storageBytes,
    codeBackingReleasedNear: native(BigInt(vaultBytes.length) * rate),
    remainingStateBytesBeforeDeletion: beforeDelete.storageBytes,
    nativeBalanceBeforeDeletionNear: native(beforeDelete.amountYocto),
    beneficiaryReceivedNear: native(received),
    accountDeleted: true,
    beneficiary: 'Explicit test beneficiary, not an automatic distribution to original depositors.',
    productionShutdownImplemented: false,
  };
  pass(
    'Disposable full-access owner removed code, blocked new calls and deleted the settled account; the explicit beneficiary received the remaining native balance.',
  );
  report.totalOutcomeTokensBurntNear = native(
    report.transactions.reduce((sum, row) => sum + BigInt(row.outcomeTokensBurntYocto), 0n),
  );
  report.completed = true;
  await writeFile(
    new URL('../.data/storage-cost-evidence.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        standard: report.standard,
        maxObserved: report.maxObserved,
        disposableRetirement: report.disposableRetirement,
      },
      null,
      2,
    ),
  );
} finally {
  if (!report.completed) {
    await writeFile(
      new URL('../.data/storage-cost-incomplete.json', import.meta.url),
      JSON.stringify(report, null, 2) + '\n',
    );
  }
  await worker.tearDown();
}
