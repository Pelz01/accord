import { Worker } from 'near-workspaces';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareRuntime } from './runtime.mjs';
import { setTimeout as delay } from 'node:timers/promises';
await prepareRuntime();
const worker = await Worker.init();
const wasm = (name) => fileURLToPath(new URL(`../.data/wasm/${name}.wasm`, import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const NEAR = 10n ** 24n;
const gas = { gas: '150000000000000' },
  approval = { ...gas, attachedDeposit: '1' };
const proof = {
  at: new Date().toISOString(),
  environment: 'disposable-near-sandbox',
  wasmSha256: {},
  checks: [],
  transactions: [],
  snapshots: {},
  completed: false,
};
for (const name of [
  'vault',
  'vault-starved',
  'vault-native-failed',
  'vault-before-native-deposits',
])
  proof.wasmSha256[name] = sha(await readFile(wasm(name)));
assert.equal(
  proof.wasmSha256['vault-before-native-deposits'],
  '2eb011ff5989660c2ce6939ad8bd616e77ca9d7df3fd10d87e0aa9980ac74f04',
);
async function call(actor, target, method, args, options = gas, failure = false) {
  const r = await actor.callRaw(target, method, args, options);
  proof.transactions.push({
    method,
    hash: r.transactionReceipt.hash,
    succeeded: r.succeeded,
    tokensBurntYocto: r.outcomesWithId
      .reduce((n, o) => n + BigInt(o.outcome.tokens_burnt), 0n)
      .toString(),
  });
  if (!failure) {
    assert(r.succeeded, method + ': ' + JSON.stringify(r.status));
    assert.equal(r.receiptFailures.length, 0, method);
  } else assert(r.failed || r.receiptFailures.length > 0, method + ' must fail');
  return r;
}
const pass = (name) => {
  proof.checks.push({ name, status: 'PASS' });
  console.log('PASS ' + name);
};
const credit = (v, id) => v.view('get_native_deposit', { order_id: id });
async function stableNativeBalance(account) {
  const target = (await worker.provider.block({ finality: 'optimistic' })).header.height + 2;
  const started = Date.now();
  while ((await worker.provider.block({ finality: 'final' })).header.height < target) {
    assert(Date.now() - started < 20000, 'Finalized balance unavailable');
    await delay(200);
  }
  return BigInt(
    (await worker.provider.viewAccount(account.accountId, { finality: 'final' })).amount,
  );
}
const balance = (t, a) => t.view('ft_balance_of', { account_id: a.accountId });
async function register(b, t, a) {
  await call(
    b,
    t,
    'storage_deposit',
    { account_id: a.accountId, registration_only: true },
    { ...gas, attachedDeposit: '1250000000000000000000' },
  );
}
async function create(b, v, id, terms, deposit = NEAR) {
  await call(
    b,
    v,
    'create_automatic_order',
    { order_id: id, terms },
    { ...gas, attachedDeposit: deposit.toString() },
  );
}
async function accept(s, v, id) {
  const o = await v.view('get_order', { order_id: id });
  await call(s, v, 'accept_order', { order_id: id, terms_hash: o.terms_hash }, approval);
}
const fund = (b, t, v, id, n) =>
  call(
    b,
    t,
    'ft_transfer_call',
    { receiver_id: v.accountId, amount: String(n), msg: id },
    approval,
  );
const deliver = (b, v, id, n) =>
  call(
    b,
    v,
    'confirm_delivery',
    { order_id: id, sequence: '1', cumulative_quantity: String(n), receipt_hash: 'a'.repeat(64) },
    approval,
  );
async function invoice(s, v, t, id, qty, reference) {
  const o = await v.view('get_order', { order_id: id });
  const i = {
    order_id: id,
    terms_version: 1,
    terms_hash: o.terms_hash,
    document_hash: 'b'.repeat(64),
    reference,
    line_id: o.terms.line_id,
    quantity: String(qty),
    token: t.accountId,
    amount: (BigInt(qty) * BigInt(o.terms.unit_price)).toString(),
  };
  await call(s, v, 'confirm_invoice', { order_id: id, invoice: i }, approval);
  return i;
}
const pay = (op, v, i, request_id, qty, failure = false) =>
  call(
    op,
    v,
    'request_payment',
    {
      order_id: i.order_id,
      request_id,
      quantity: String(qty),
      audit_hash: i.document_hash,
      invoice: i,
    },
    gas,
    failure,
  );
async function close(b, s, v, id, failure = false) {
  await call(b, v, 'propose_close', { order_id: id }, approval);
  const r = await v.view('get_recovery', { order_id: id });
  await call(
    s,
    v,
    'accept_close',
    { order_id: id, proposal_hash: r.proposal.hash },
    approval,
    failure,
  );
}
try {
  const root = worker.rootAccount,
    b = await root.createSubAccount('buyer'),
    b2 = await root.createSubAccount('buyer2'),
    s = await root.createSubAccount('supplier'),
    op = await root.createSubAccount('operator');
  const token = await root.devDeploy(wasm('token'));
  await call(token, token, 'new', { owner_id: b.accountId, total_supply: '1000000000000' });
  const vault = await root.devDeploy(wasm('vault-before-native-deposits'));
  await call(vault, vault, 'new', { token: token.accountId, network: 'sandbox' });
  const terms = {
    supplier: s.accountId,
    receiver: b.accountId,
    operator: op.accountId,
    payout: s.accountId,
    line_id: 'cartons',
    description: 'Coffee cartons',
    unit: 'carton',
    ordered: '10',
    unit_price: '1000000',
    expires_at: '18446744073709551615',
  };
  await create(b, vault, 'HISTORICAL', terms, (NEAR * 5n) / 4n);
  const historic = await vault.view('get_order', { order_id: 'HISTORICAL' });
  await vault.deploy(wasm('vault'));
  assert.equal(await vault.view('get_version', {}), '2.4.0-native-deposits');
  assert.deepEqual(await vault.view('get_order', { order_id: 'HISTORICAL' }), historic);
  assert.equal((await credit(vault, 'HISTORICAL')).tracked, false);
  await call(b, vault, 'claim_native_excess', { order_id: 'HISTORICAL' }, approval, true);
  pass(
    'Upgrade preserves an old order and does not invent native credit for its unrecorded deposit.',
  );

  await create(b, vault, 'EXCESS', terms, (NEAR * 5n) / 4n);
  await create(b2, vault, 'OTHER', { ...terms, receiver: b2.accountId });
  const otherBefore = await credit(vault, 'OTHER');
  assert.equal((await credit(vault, 'EXCESS')).claimable, (NEAR / 4n).toString());
  await call(s, vault, 'claim_native_excess', { order_id: 'EXCESS' }, approval, true);
  await call(b, vault, 'claim_native_excess', { order_id: 'EXCESS' }, gas, true);
  const buyerBefore = await stableNativeBalance(b);
  await call(b, vault, 'claim_native_excess', { order_id: 'EXCESS' }, approval);
  const buyerAfter = await stableNativeBalance(b);
  proof.snapshots.buyerNativeTransfer = {
    before: buyerBefore.toString(),
    after: buyerAfter.toString(),
    difference: (buyerAfter - buyerBefore).toString(),
  };
  assert(buyerAfter - buyerBefore > (NEAR * 24n) / 100n && buyerAfter - buyerBefore < NEAR / 4n);
  let c = await credit(vault, 'EXCESS');
  assert.equal(c.deposit.refunded, (NEAR / 4n).toString());
  assert.equal(c.deposit.pending, '0');
  assert.equal(c.claimable, '0');
  assert.deepEqual(await credit(vault, 'OTHER'), otherBefore);
  await call(b, vault, 'claim_native_excess', { order_id: 'EXCESS' }, approval, true);
  proof.snapshots.openAfterExcessClaim = c;
  pass(
    'Only the buyer can return excess above open-order capacity; the transfer arrives once and the second customer is unchanged.',
  );

  await call(b, vault, 'cancel_unfunded_order', { order_id: 'EXCESS' }, approval);
  const cancelled = await credit(vault, 'EXCESS');
  assert(BigInt(cancelled.claimable) > (NEAR * 9n) / 10n);
  assert(BigInt(cancelled.retained_required) >= BigInt(cancelled.storage_backing));
  await call(b, vault, 'claim_native_excess', { order_id: 'EXCESS' }, approval);
  c = await credit(vault, 'EXCESS');
  assert.equal(c.claimable, '0');
  assert.equal(
    BigInt(c.deposit.deposited) -
      BigInt(c.deposit.refunded) -
      BigInt(c.deposit.call_deposits_spent),
    BigInt(c.retained_required),
  );
  await call(
    s,
    vault,
    'accept_order',
    {
      order_id: 'EXCESS',
      terms_hash: (await vault.view('get_order', { order_id: 'EXCESS' })).terms_hash,
    },
    approval,
    true,
  );
  await call(
    b,
    vault,
    'top_up_order_storage',
    { order_id: 'EXCESS' },
    { ...gas, attachedDeposit: (NEAR / 10n).toString() },
  );
  assert.equal((await credit(vault, 'EXCESS')).claimable, (NEAR / 10n).toString());
  await call(b, vault, 'claim_native_excess', { order_id: 'EXCESS' }, approval);
  proof.snapshots.cancelled = await credit(vault, 'EXCESS');
  pass(
    'An unfunded order can close without buying tokens; retained records keep their backing and explicit top-ups stay owned by that buyer.',
  );

  for (const a of [vault, s]) await register(b, token, a);
  await create(b, vault, 'SETTLED', terms);
  await accept(s, vault, 'SETTLED');
  await fund(b, token, vault, 'SETTLED', 10000000);
  await deliver(b, vault, 'SETTLED', 4);
  const i = await invoice(s, vault, token, 'SETTLED', 4, 'INV-SETTLED');
  await pay(op, vault, i, 'settled-4', 4);
  await close(b, s, vault, 'SETTLED');
  c = await credit(vault, 'SETTLED');
  assert.equal(c.deposit.call_deposits_spent, '2');
  assert(BigInt(c.claimable) > (NEAR * 9n) / 10n);
  const supplierTokens = await balance(token, s);
  await call(b, vault, 'claim_native_excess', { order_id: 'SETTLED' }, approval);
  assert.equal(await balance(token, s), supplierTokens);
  assert.equal((await vault.view('get_attempt', { request_id: 'settled-4' })).status, 'Settled');
  assert.equal((await credit(vault, 'SETTLED')).claimable, '0');
  proof.snapshots.settled = await credit(vault, 'SETTLED');
  pass(
    'Settlement-token refunds and native-credit claims remain separate; closure returns unused allowance while retaining invoice and payment replay records.',
  );

  const failed = await root.devDeploy(wasm('vault-native-failed'));
  await call(failed, failed, 'new', { token: token.accountId, network: 'sandbox' });
  await create(b, failed, 'FAILED', terms, (NEAR * 5n) / 4n);
  await create(b2, failed, 'FAILED-OTHER', { ...terms, receiver: b2.accountId });
  const failedOther = await credit(failed, 'FAILED-OTHER');
  for (let n = 1; n <= 2; n++) {
    await call(b, failed, 'claim_native_excess', { order_id: 'FAILED' }, approval, true);
    c = await credit(failed, 'FAILED');
    assert.equal(c.deposit.claim_status, 'Failed');
    assert.equal(c.deposit.pending, '0');
    assert.equal(c.deposit.refunded, '0');
    assert.equal(c.claimable, (NEAR / 4n).toString());
    assert.equal(c.deposit.claim_sequence, String(n));
  }
  assert.deepEqual(await credit(failed, 'FAILED-OTHER'), failedOther);
  pass(
    'Real failed native transfers restore only that order credit; retries use new sequences and leave the other buyer unchanged.',
  );

  const starved = await root.devDeploy(wasm('vault-starved'));
  await call(starved, starved, 'new', { token: token.accountId, network: 'sandbox' });
  await create(b, starved, 'UNCERTAIN-NATIVE', terms, (NEAR * 5n) / 4n);
  await call(b, starved, 'claim_native_excess', { order_id: 'UNCERTAIN-NATIVE' }, approval, true);
  c = await credit(starved, 'UNCERTAIN-NATIVE');
  assert.equal(c.deposit.pending, (NEAR / 4n).toString());
  assert.equal(c.claimable, '0');
  await call(b, starved, 'claim_native_excess', { order_id: 'UNCERTAIN-NATIVE' }, approval, true);
  await call(
    s,
    starved,
    'acknowledge_native_refund',
    { order_id: 'UNCERTAIN-NATIVE', sequence: '1' },
    approval,
    true,
  );
  await call(
    b,
    starved,
    'acknowledge_native_refund',
    { order_id: 'UNCERTAIN-NATIVE', sequence: '1' },
    approval,
  );
  c = await credit(starved, 'UNCERTAIN-NATIVE');
  assert.equal(c.deposit.refunded, (NEAR / 4n).toString());
  assert.equal(c.deposit.pending, '0');
  assert.equal(c.claimable, '0');
  await call(
    b,
    starved,
    'acknowledge_native_refund',
    { order_id: 'UNCERTAIN-NATIVE', sequence: '1' },
    approval,
  );
  assert.equal(
    (await credit(starved, 'UNCERTAIN-NATIVE')).deposit.refunded,
    (NEAR / 4n).toString(),
  );
  pass(
    'A real successful transfer with a starved callback stays reserved; only its recipient can acknowledge it and acknowledgment never enables duplicate spending.',
  );

  await create(b, vault, 'PROTECTED', terms, (NEAR * 5n) / 4n);
  const beforeDrain = await vault.accountView();
  const keep = BigInt(beforeDrain.storage_usage) * 10n ** 19n + (NEAR * 26n) / 100n;
  const drained = BigInt(beforeDrain.amount) - keep;
  await vault.transfer(root.accountId, drained);
  await call(b, vault, 'claim_native_excess', { order_id: 'PROTECTED' }, approval, true);
  assert.equal((await credit(vault, 'PROTECTED')).deposit.pending, '0');
  assert.deepEqual(await credit(vault, 'OTHER'), otherBefore);
  await root.transfer(vault.accountId, drained);
  pass(
    'Even a protocol-spendable balance cannot pay a claim when doing so would leave other tracked credits or platform storage underfunded.',
  );

  const longAccount = (name) => root.createSubAccount(name.padEnd(63 - root.accountId.length, 'x'));
  const lb = await longAccount('budgetbuyer'),
    ls = await longAccount('budgetsupplier'),
    lo = await longAccount('budgetoperator'),
    lt = await longAccount('budgettoken'),
    lv = await longAccount('budgetvault');
  for (const a of [lb, ls, lo, lt, lv]) assert.equal(a.accountId.length, 64);
  await lt.deploy(wasm('token'));
  await lv.deploy(wasm('vault'));
  await call(lt, lt, 'new', { owner_id: lb.accountId, total_supply: '1000000000000' });
  await call(lv, lv, 'new', { token: lt.accountId, network: 'sandbox' });
  for (const a of [lv, ls]) await register(lb, lt, a);
  const maxId = 'N'.repeat(64);
  const maxBefore = await lv.accountView();
  await create(lb, lv, maxId, {
    ...terms,
    supplier: ls.accountId,
    receiver: lb.accountId,
    operator: lo.accountId,
    payout: ls.accountId,
    line_id: 'l'.repeat(64),
    description: 'd'.repeat(160),
    unit: 'u'.repeat(32),
    ordered: '65',
  });
  await accept(ls, lv, maxId);
  await fund(lb, lt, lv, maxId, 65000000);
  await deliver(lb, lv, maxId, 64);
  const invoices = [];
  for (let n = 0; n < 32; n++)
    invoices.push(await invoice(ls, lv, lt, maxId, 2, ('MAX-' + n + '-').padEnd(80, 'r')));
  for (let n = 0; n < 64; n++) {
    await pay(lo, lv, invoices[Math.floor(n / 2)], ('budget-' + n + '-').padEnd(64, 'p'), 1);
    if (n % 16 === 15) console.log(`Verified native budget for ${n + 1}/64 payments`);
  }
  await call(
    ls,
    lv,
    'confirm_invoice',
    { order_id: maxId, invoice: { ...invoices[0], reference: 'ONE-TOO-MANY' } },
    approval,
    true,
  );
  await pay(lo, lv, invoices[0], 'ONE-TOO-MANY', 1, true);
  await call(
    lb,
    lt,
    'ft_transfer',
    { receiver_id: ls.accountId, amount: await balance(lt, lb) },
    approval,
  );
  await call(lb, lt, 'storage_unregister', { force: false }, approval);
  await close(lb, ls, lv, maxId, true);
  for (let n = 0; n < 7; n++)
    await call(lb, lv, 'retry_refund', { order_id: maxId }, approval, true);
  await register(ls, lt, lb);
  await call(lb, lv, 'retry_refund', { order_id: maxId }, approval);
  const maxAfter = await lv.accountView(),
    maxCredit = await credit(lv, maxId);
  assert.equal(maxCredit.deposit.call_deposits_spent, '73');
  assert(BigInt(maxCredit.retained_required) < NEAR);
  assert(BigInt(maxCredit.claimable) > 0n);
  const totalDelta = maxAfter.storage_usage - maxBefore.storage_usage;
  const attributed = Number(maxCredit.deposit.storage_bytes);
  assert(
    totalDelta >= attributed && totalDelta - attributed < 256,
    'Only fixed platform-pool metadata may be outside the order ledger',
  );
  await call(lb, lv, 'claim_native_excess', { order_id: maxId }, approval);
  assert.equal((await credit(lv, maxId)).claimable, '0');
  assert.equal((await lv.view('get_recovery', { order_id: maxId })).refunds.length, 8);
  assert.equal((await lv.view('get_order', { order_id: maxId })).paid, '64');
  proof.snapshots.maximumCapacity = {
    actualStorageDeltaBytes: totalDelta,
    platformPoolBytes: totalDelta - attributed,
    beforeClaim: maxCredit,
    afterClaim: await credit(lv, maxId),
  };
  pass(
    'Enforced 32-invoice/64-payment caps and eight retained refunds fit the metered one-NEAR allowance with its 25% margin; only actual remaining excess is returned.',
  );

  proof.completed = true;
  await writeFile(
    new URL('../.data/native-deposit-sandbox-evidence.json', import.meta.url),
    JSON.stringify(proof, null, 2) + '\n',
  );
} finally {
  if (!proof.completed)
    await writeFile(
      new URL('../.data/native-deposit-incomplete.json', import.meta.url),
      JSON.stringify(proof, null, 2) + '\n',
    );
  await worker.tearDown();
}
