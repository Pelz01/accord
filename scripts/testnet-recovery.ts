import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, actions, type KeyPairString } from 'near-api-js';
import type { ChainAttempt, ChainOrder, ChainRecovery, Deployment } from '../shared/chain.ts';

// Explicit testnet upgrade and refund, never part of ordinary unit checks.
const d = JSON.parse(await readFile('.data/deployment.json', 'utf8')) as Deployment;
assert.equal(d.network, 'testnet');
assert.equal(d.rpcUrl, 'https://test.rpc.fastnear.com');
const provider = new JsonRpcProvider({ url: d.rpcUrl });
const credentials = JSON.parse(await readFile('.data/testnet-credentials.json', 'utf8')) as {
  accounts: Record<string, { accountId: string; secretKey: KeyPairString }>;
};
const accounts = Object.fromEntries(
  Object.entries(credentials.accounts).map(([name, key]) => [
    name,
    new Account(key.accountId, provider, key.secretKey),
  ]),
);
const { vault, buyer, supplier, operator } = accounts;
assert.equal(vault.accountId, d.vault);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile('.data/wasm/vault.wasm');
const expected = sha(bytes);
const sandbox = JSON.parse(await readFile('.data/recovery-sandbox-evidence.json', 'utf8'));
const payments = JSON.parse(await readFile('.data/sandbox-evidence.json', 'utf8'));
assert.equal(sandbox.wasmSha256.vault, expected);
assert.equal(payments.wasmSha256.vault, expected);
assert.ok(
  sandbox.checks.length >= 11 &&
    sandbox.checks.every((c: { status: string }) => c.status === 'PASS'),
);
assert.equal(payments.checks.length, 9);
type Proof = {
  network: 'testnet';
  at: string;
  vault: string;
  wasmSha256: string;
  checks: string[];
  transactions: { label: string; hash: string }[];
  refund?: { orderId: string; buyer: string; amount: string; state: ChainRecovery };
};
let proof: Proof;
try {
  proof = JSON.parse(await readFile('.data/recovery-testnet-evidence.json', 'utf8'));
  assert.equal(proof.wasmSha256, expected);
} catch {
  proof = {
    network: 'testnet',
    at: new Date().toISOString(),
    vault: d.vault,
    wasmSha256: expected,
    checks: [],
    transactions: [],
  };
}
async function persist() {
  await writeFile('.data/recovery-testnet-evidence.json', JSON.stringify(proof, null, 2) + '\n');
}
function check(value: string) {
  if (!proof.checks.includes(value)) proof.checks.push(value);
}
async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const value = await provider.callFunction({ contractId: d.vault, method, args });
  assert.notEqual(value, undefined, `${method} returned no value.`);
  return value as T;
}
async function call(account: Account, method: string, args: Record<string, unknown>) {
  const result = await account.callFunctionRaw({
    contractId: d.vault,
    methodName: method,
    args,
    gas: 150_000_000_000_000n,
    deposit: 0n,
    waitUntil: 'FINAL',
  });
  assert.ok(
    typeof result.status === 'object' && 'SuccessValue' in result.status,
    method + ' did not finish successfully. Read the receipt before retrying.',
  );
  proof.transactions.push({ label: method, hash: result.transaction.hash });
  await persist();
  console.log(method + ': ' + result.transaction.hash);
}
async function rejects(account: Account, method: string, args: Record<string, unknown>) {
  const result = await account.signAndSendTransaction({
    receiverId: d.vault,
    actions: [actions.functionCall(method, args, 100_000_000_000_000n, 0n)],
    waitUntil: 'FINAL',
    throwOnFailure: false,
  });
  assert.ok(
    typeof result.status === 'object' && 'Failure' in result.status,
    method + ' unexpectedly succeeded.',
  );
  const expected =
    method === 'accept_close'
      ? 'Other commercial party'
      : method === 'retry_refund'
        ? 'no definitive failure'
        : 'private';
  assert.ok(
    JSON.stringify(result.status).includes(expected),
    'Unexpected rejection reason for ' + method,
  );
  proof.transactions.push({ label: 'rejected_' + method, hash: result.transaction.hash });
  await persist();
}
async function main() {
  let deployed = await provider.viewContractCode({ contractId: d.vault });
  if (sha(deployed.code) !== expected) {
    assert.equal(
      sha(deployed.code),
      d.wasmSha256.vault,
      'Unexpected deployed code. Inspect before upgrading.',
    );
    const orders = await view<ChainOrder[]>('list_orders', { limit: 50 });
    assert.ok(
      orders.every((o) => o.pending === '0' && o.buyer === buyer.accountId),
      'Upgrade needs quiet generated test orders.',
    );
    const attempts = await Promise.all(
      (d.trackedRequestIds ?? []).map((request_id) =>
        view<ChainAttempt>('get_attempt', { request_id }),
      ),
    );
    const tokenBalance = await provider.callFunction<string>({
      contractId: d.token,
      method: 'ft_balance_of',
      args: { account_id: d.vault },
    });
    await writeFile('.data/wasm/vault-before-recovery.wasm', deployed.code);
    await writeFile(
      '.data/recovery-upgrade-snapshot.json',
      JSON.stringify(
        { orders, attempts, tokenBalance, oldWasmSha256: sha(deployed.code) },
        null,
        2,
      ),
    );
    const upgrade = await vault.signAndSendTransaction({
      receiverId: d.vault,
      actions: [
        actions.deployContract(bytes),
        actions.functionCall('get_version', {}, 30_000_000_000_000n, 0n),
      ],
      waitUntil: 'FINAL',
    });
    assert.ok(typeof upgrade.status === 'object' && 'SuccessValue' in upgrade.status);
    proof.transactions.push({
      label: 'atomic_code_upgrade_and_state_check',
      hash: upgrade.transaction.hash,
    });
    await persist();
    assert.deepEqual(await view<ChainOrder[]>('list_orders', { limit: 50 }), orders);
    assert.deepEqual(
      await Promise.all(
        (d.trackedRequestIds ?? []).map((request_id) =>
          view<ChainAttempt>('get_attempt', { request_id }),
        ),
      ),
      attempts,
    );
    assert.equal(
      await provider.callFunction<string>({
        contractId: d.token,
        method: 'ft_balance_of',
        args: { account_id: d.vault },
      }),
      tokenBalance,
    );
    check(
      'testnet upgrade preserved every existing order, tracked attempt and vault token balance',
    );
  }
  deployed = await provider.viewContractCode({ contractId: d.vault });
  assert.equal(sha(deployed.code), expected);
  assert.equal(await view('get_version'), '2.3.0-automatic');
  d.wasmSha256.vault = expected;
  d.features = ['recovery-v1', 'invoice-v1', 'documents-v1', 'automatic-v1'];
  await writeFile('.data/deployment.json', JSON.stringify(d, null, 2) + '\n');
  await writeFile('fixtures/testnet-deployment.json', JSON.stringify(d, null, 2) + '\n');
  check('only the normal artifact verified by both sandbox suites was deployed');
  await persist();
  const orderId = 'PO-TESTNET-001';
  const order = await view<ChainOrder>('get_order', { order_id: orderId });
  assert.equal(order.buyer, buyer.accountId);
  assert.equal(order.terms.supplier, supplier.accountId);
  assert.deepEqual([order.accepted, order.paid, order.pending], ['70', '70', '0']);
  let r = await view<ChainRecovery>('get_recovery', { order_id: orderId });
  if (r.phase === 'Open') {
    await call(buyer, 'propose_close', { order_id: orderId });
    r = await view('get_recovery', { order_id: orderId });
    assert.ok(r.proposal);
    assert.equal(r.proposal.refund_amount, '300000000');
    await rejects(buyer, 'accept_close', { order_id: orderId, proposal_hash: r.proposal.hash });
    await rejects(operator, 'accept_close', { order_id: orderId, proposal_hash: r.proposal.hash });
    check('buyer cannot self-approve closure and operator cannot approve it');
    const before = BigInt(
      (await provider.callFunction<string>({
        contractId: d.token,
        method: 'ft_balance_of',
        args: { account_id: buyer.accountId },
      }))!,
    );
    await call(supplier, 'accept_close', { order_id: orderId, proposal_hash: r.proposal.hash });
    const after = BigInt(
      (await provider.callFunction<string>({
        contractId: d.token,
        method: 'ft_balance_of',
        args: { account_id: buyer.accountId },
      }))!,
    );
    assert.equal(after - before, 300_000_000n);
    check('real 300 aUSD refund reached the original buyer after both approvals');
  }
  r = await view('get_recovery', { order_id: orderId });
  assert.equal(r.phase, 'Closed');
  assert.equal(r.refunded, '300000000');
  assert.equal(r.refund_pending, '0');
  assert.equal(r.refunds.at(-1)?.recipient, buyer.accountId);
  assert.equal(r.refunds.at(-1)?.status, 'Settled');
  await rejects(buyer, 'retry_refund', { order_id: orderId });
  await rejects(buyer, 'on_refund_result', { order_id: orderId, refund_id: 1 });
  check('completed refund cannot be replayed and its callback cannot be called publicly');
  const workerOrder = await view<ChainOrder>('get_order', { order_id: 'PO-WORKER-001' });
  assert.deepEqual([workerOrder.paid, workerOrder.pending], ['70', '0']);
  assert.equal(
    (await view<ChainRecovery>('get_recovery', { order_id: workerOrder.id })).phase,
    'Open',
  );
  check('other purchase order remains open with its original settled quantities');
  proof.refund = { orderId, buyer: buyer.accountId, amount: '300000000', state: r };
  await persist();
  console.log(
    JSON.stringify({
      status: 'PASS',
      vault: d.vault,
      refunded: '300 aUSD',
      checks: proof.checks,
      transactions: proof.transactions,
    }),
  );
}
main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : 'Testnet recovery verification failed.';
  for (const key of Object.values(credentials.accounts))
    message = message.replaceAll(key.secretKey, '[REDACTED]');
  console.error(message);
  process.exitCode = 1;
});
